#!/usr/bin/env node
// Unit suite for the Bun.file shim in launcher.js.  Run with `npm test`.
//
// Extracts the shim block from launcher.js by its BEGIN/END markers and evals
// it, so the code under test IS the shipped code and cannot drift from a copy.
//
// Calibration target is Bun's own documentation (bun.com/docs/api/file-io and
// bun.com/reference/bun/BunFile). Real Bun cannot run on the hardware this
// project exists for, so no shim here is ever verifiable against the real
// runtime; documented behaviour plus these cases is the whole safety net.
//
// This suite replaces an earlier 26-case version that only ever lived in a
// scratch directory and was lost. Two divergences from Bun's documented
// behaviour survived in the shim until it was rewritten (default MIME type,
// exists() on a directory), which is the argument for keeping tests in-repo.

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.file shim';
const END = '// --- end Bun.file shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.file shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
// The block closes over launcher.js's module-level `fs` and `path`, which are
// in scope here under the same names.
const BunFile = eval(`${launcherSrc.slice(b, e)}\n_bunShim_file;`);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bunfile-shim-test-'));
const p = (name) => path.join(TMP, name);
const write = (name, content) => { const f = p(name); fs.writeFileSync(f, content); return f; };

let pass = 0;
const failures = [];
const tests = [];
const check = (name, fn) => tests.push([name, fn]);
const eq = (a, c) => JSON.stringify(a) === JSON.stringify(c);
const rejects = async (fn) => { try { await fn(); return false; } catch (_) { return true; } };

// --- construction is lazy, and the Blob contract holds -----------------------
check('constructing for a missing path does not throw', () => {
  BunFile(p('nope.txt'));
  return true;
});
check('construction issues no read syscall (lazy)', () => {
  // Bun: "a BunFile represents a lazily-loaded file; initializing it does not
  // read the file from disk". Asserting only that size is uncached would NOT
  // catch an eager slurp, so intercept the read paths instead. This matters:
  // the sole production call site is Bun.file(<ptySock>.err), and an eager
  // read on a socket-adjacent path could block or throw at construction.
  const realRead = [fs.readFileSync, fs.readSync, fs.createReadStream];
  let reads = 0;
  fs.readFileSync = (...a) => { reads++; return realRead[0](...a); };
  fs.readSync = (...a) => { reads++; return realRead[1](...a); };
  fs.createReadStream = (...a) => { reads++; return realRead[2](...a); };
  try {
    BunFile(write('lazy.txt', 'first'));
    return reads === 0;
  } finally {
    [fs.readFileSync, fs.readSync, fs.createReadStream] = realRead;
  }
});
check('size is re-stat\'d, not cached at construction', () => {
  const f = write('lazy2.txt', 'first');
  const bf = BunFile(f);
  fs.writeFileSync(f, 'second-longer');   // changed AFTER construction
  return bf.size === 'second-longer'.length;
});
check('is a Blob', () => BunFile(p('x.txt')) instanceof Blob);
check('name is the path', () => BunFile(p('named.txt')).name === p('named.txt'));
check('name is absent for an fd', () => {
  const fd = fs.openSync(write('fd-name.txt', 'x'), 'r');
  try { return BunFile(fd).name === undefined; } finally { fs.closeSync(fd); }
});

// --- accepted input forms ----------------------------------------------------
check('string path', async () => await BunFile(write('s.txt', 'hello')).text() === 'hello');
check('file:// string', async () => {
  const f = write('u1.txt', 'via-string-url');
  return await BunFile(`file://${f}`).text() === 'via-string-url';
});
check('URL object', async () => {
  const f = write('u2.txt', 'via-url-object');
  return await BunFile(new URL(`file://${f}`)).text() === 'via-url-object';
});
check('Uint8Array holding a path', async () => {
  const f = write('u3.txt', 'via-bytes-path');
  return await BunFile(new TextEncoder().encode(f)).text() === 'via-bytes-path';
});
check('ArrayBuffer holding a path', async () => {
  const f = write('u4.txt', 'via-ab-path');
  const u8 = new TextEncoder().encode(f);
  return await BunFile(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)).text() === 'via-ab-path';
});
check('file descriptor', async () => {
  const fd = fs.openSync(write('fd1.txt', 'from-fd'), 'r');
  try { return await BunFile(fd).text() === 'from-fd'; } finally { fs.closeSync(fd); }
});

// --- reads -------------------------------------------------------------------
check('text()', async () => await BunFile(write('r1.txt', 'plain text')).text() === 'plain text');
check('json()', async () => {
  const o = await BunFile(write('r2.json', '{"a":1,"b":[2,3]}')).json();
  return eq(o, { a: 1, b: [2, 3] });
});
check('json() rejects on invalid JSON', async () =>
  await rejects(() => BunFile(write('r3.json', 'not json')).json()));
check('bytes() returns a Uint8Array with the right content', async () => {
  const bytes = await BunFile(write('r4.bin', Buffer.from([0, 1, 255, 128]))).bytes();
  return bytes instanceof Uint8Array && eq([...bytes], [0, 1, 255, 128]);
});
check('arrayBuffer()', async () => {
  const ab = await BunFile(write('r5.bin', Buffer.from([9, 8, 7]))).arrayBuffer();
  return ab instanceof ArrayBuffer && eq([...new Uint8Array(ab)], [9, 8, 7]);
});
check('multibyte UTF-8 survives text() and counts as bytes in bytes()', async () => {
  const f = BunFile(write('r6.txt', 'Grüße, Straße'));
  const [t, bytes] = [await f.text(), await f.bytes()];
  return t === 'Grüße, Straße' && bytes.length === Buffer.byteLength('Grüße, Straße', 'utf8')
      && bytes.length > t.length;
});
check('empty file reads as empty, size 0', async () => {
  const f = BunFile(write('empty.txt', ''));
  return f.size === 0 && await f.text() === '';
});
check('bytes() does not expose Node\'s shared Buffer pool', async () => {
  // Bun: bytes() is "the same as new Uint8Array(await blob.arrayBuffer())",
  // which means byteOffset 0 and buffer.byteLength === size. fs.readFileSync
  // serves sub-4-KiB files out of an 8 KiB shared pool, so a bare view over
  // the read buffer would hand callers 8192 bytes of unrelated memory via
  // .buffer (DataView, Buffer.from(u8.buffer), crypto.subtle.digest,
  // structuredClone transfer). Prime the pool first so a regression shows up
  // as real foreign content, not just a length mismatch.
  await BunFile(write('r7-prime.bin', Buffer.from('NEIGHBOURING-FILE-CONTENT'))).bytes();
  const bytes = await BunFile(write('r7.bin', Buffer.from([1, 2, 3]))).bytes();
  const exposed = Buffer.from(bytes.buffer).toString('latin1');
  return bytes.length === 3
      && bytes.byteOffset === 0
      && bytes.buffer.byteLength === 3
      && !exposed.includes('NEIGHBOURING');
});

// --- fd reads are positioned (the readFileSync(fd) offset trap) --------------
check('fd read starts at offset 0', async () => {
  const fd = fs.openSync(write('fd2.txt', 'positioned'), 'r');
  try {
    fs.readSync(fd, Buffer.alloc(4), 0, 4, null); // advance the fd offset first
    return await BunFile(fd).text() === 'positioned';
  } finally { fs.closeSync(fd); }
});
check('reading the same fd twice returns the same content', async () => {
  // fs.readFileSync(fd) consumes the fd offset, so a second read would come
  // back empty. This is the regression the positioned read exists for.
  const fd = fs.openSync(write('fd3.txt', 'twice-please'), 'r');
  try {
    const f = BunFile(fd);
    return await f.text() === 'twice-please' && await f.text() === 'twice-please';
  } finally { fs.closeSync(fd); }
});
check('bytes() after text() on the same fd is still complete', async () => {
  const fd = fs.openSync(write('fd4.txt', 'abc'), 'r');
  try {
    const f = BunFile(fd);
    await f.text();
    return eq([...await f.bytes()], [97, 98, 99]);
  } finally { fs.closeSync(fd); }
});

// --- stat-backed properties --------------------------------------------------
check('size matches byte length', () => BunFile(write('st1.txt', 'twelve bytes')).size === 12);
check('size is 0 for a missing file', () => BunFile(p('missing.txt')).size === 0);
check('lastModified tracks mtime, not atime or ctime', () => {
  // On a freshly written file mtime/atime/ctime are identical, so comparing
  // against a fresh stat would pass for any of the three fields. Force them
  // apart first, which is the only way this can catch a wrong-field regression.
  const f = write('st2.txt', 'x');
  const mtime = new Date(1e9);          // 2001
  const atime = new Date(2e9);          // 2033
  fs.utimesSync(f, atime, mtime);
  const st = fs.statSync(f);
  const got = BunFile(f).lastModified;
  return Math.abs(got - st.mtimeMs) < 1
      && Math.abs(got - st.atimeMs) > 1000
      && Math.abs(got - st.ctimeMs) > 1000;
});
check('lastModified is 0 for a missing file', () => BunFile(p('missing2.txt')).lastModified === 0);
check('exists() is true for a regular file', async () => await BunFile(write('st3.txt', 'x')).exists());
check('exists() is false for a missing file', async () => await BunFile(p('missing3.txt')).exists() === false);
check('exists() is false for a directory', async () => {
  // Documented Bun behaviour: "returns true for regular files and FIFOs. It
  // returns false for directories." A plain statSync succeeds on a directory,
  // so this needs an explicit isDirectory() check. Implemented as
  // !isDirectory() rather than isFile() so FIFOs keep returning true.
  const d = path.join(TMP, 'subdir');
  fs.mkdirSync(d, { recursive: true });
  return await BunFile(d).exists() === false;
});
check('size still works on a directory (only exists() special-cases it)', () => {
  // Assert the actual value, not just that a getter returns a number: the size
  // getter can only ever return st.size or 0, so a typeof check would hold for
  // every conceivable implementation and pin nothing. This encodes Bun's own
  // inconsistency (oven-sh/bun#21537): size/stat work on directories,
  // exists() alone reports false.
  const d = path.join(TMP, 'subdir');
  fs.mkdirSync(d, { recursive: true });
  return BunFile(d).size === fs.statSync(d).size && BunFile(d).size > 0;
});
check('exists() is true for a FIFO', () => {
  // The reason exists() is implemented as !isDirectory() rather than isFile():
  // Bun documents FIFOs as true. Without this case, "simplifying" it to
  // isFile() would pass the whole suite.
  const fifo = p('fifo');
  try { require('child_process').execFileSync('mkfifo', [fifo]); }
  catch (_) { return true; }            // no mkfifo available: skip, don't fail
  return BunFile(fifo).exists();
});

// --- MIME type ---------------------------------------------------------------
check('.json maps to application/json', () => BunFile(p('a.json')).type === 'application/json;charset=utf-8');
check('.png maps to image/png', () => BunFile(p('a.png')).type === 'image/png');
check('extension match is case-insensitive', () => BunFile(p('A.PNG')).type === 'image/png');
check('unknown extension falls back to Bun\'s documented default', () =>
  BunFile(p('a.wat')).type === 'text/plain;charset=utf-8');
check('no extension falls back to the same default', () =>
  BunFile(p('README')).type === 'text/plain;charset=utf-8');
check('explicit options.type wins over the extension', () =>
  BunFile(p('a.json'), { type: 'text/csv;charset=utf-8' }).type === 'text/csv;charset=utf-8');
check('explicit text-ish type gets a charset appended, as Bun documents', () =>
  // bun.com/docs/api/file-io shows the explicit type coming back charset-ed:
  //   Bun.file("notreal.json", { type: "application/json" })
  //     -> "application/json;charset=utf-8"
  BunFile(p('a.txt'), { type: 'application/json' }).type === 'application/json;charset=utf-8');
check('explicit binary type is left alone', () =>
  BunFile(p('a.txt'), { type: 'image/png' }).type === 'image/png');
check('an explicit charset is not doubled', () =>
  BunFile(p('a.txt'), { type: 'text/html;charset=iso-8859-1' }).type === 'text/html;charset=iso-8859-1');
check('fd input gets the default type', () => {
  const fd = fs.openSync(write('fd5.txt', 'x'), 'r');
  try { return BunFile(fd).type === 'text/plain;charset=utf-8'; } finally { fs.closeSync(fd); }
});

// --- writer() ----------------------------------------------------------------
check('writer() writes a string', () => {
  const f = p('w1.txt');
  const w = BunFile(f).writer();
  w.write('written');
  w.end();
  return fs.readFileSync(f, 'utf8') === 'written';
});
check('writer() accepts Buffer, Uint8Array and ArrayBuffer', () => {
  const f = p('w2.bin');
  const w = BunFile(f).writer();
  w.write(Buffer.from([1]));
  w.write(new Uint8Array([2]));
  w.write(new Uint8Array([3]).buffer);
  w.end();
  return eq([...fs.readFileSync(f)], [1, 2, 3]);
});
check('writer() returns the byte count written', () => {
  const w = BunFile(p('w3.txt')).writer();
  const n = w.write('äöü');            // 6 bytes in UTF-8, not 3
  w.end();
  return n === 6;
});
check('writer() truncates an existing file', () => {
  const f = write('w4.txt', 'long previous content');
  const w = BunFile(f).writer();
  w.write('short');
  w.end();
  return fs.readFileSync(f, 'utf8') === 'short';
});
check('writer() ignores writes after end()', () => {
  const f = p('w5.txt');
  const w = BunFile(f).writer();
  w.write('kept');
  w.end();
  return w.write('dropped') === 0 && fs.readFileSync(f, 'utf8') === 'kept';
});
check('writer().flush() returns 0 (writes are unbuffered)', () => {
  const w = BunFile(p('w6.txt')).writer();
  const r = w.flush();
  w.end();
  return r === 0;
});
check('writer() on an fd does not close the caller\'s fd', () => {
  const f = write('w7.txt', '');
  const fd = fs.openSync(f, 'w');
  try {
    const w = BunFile(fd).writer();
    w.write('via-fd');
    w.end();                            // must NOT close a borrowed fd
    fs.writeSync(fd, Buffer.from('!')); // would throw EBADF if end() closed it
    return true;
  } catch (_) {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
});

// --- stream() ----------------------------------------------------------------
check('stream() yields the file content', async () => {
  const rs = BunFile(write('str1.txt', 'streamed content')).stream();
  if (typeof rs.getReader !== 'function') return false;
  const chunks = [];
  for await (const c of rs) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8') === 'streamed content';
});
check('stream() on an fd starts at offset 0', async () => {
  const fd = fs.openSync(write('str2.txt', 'fd-streamed'), 'r');
  try {
    fs.readSync(fd, Buffer.alloc(3), 0, 3, null); // advance the offset
    const chunks = [];
    for await (const c of BunFile(fd).stream()) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8') === 'fd-streamed';
  } finally { try { fs.closeSync(fd); } catch (_) {} }
});

// --- delete / unlink ---------------------------------------------------------
check('delete() removes the file', async () => {
  const f = write('d1.txt', 'x');
  await BunFile(f).delete();
  return !fs.existsSync(f);
});
check('unlink() is an alias for delete()', async () => {
  const f = write('d2.txt', 'x');
  await BunFile(f).unlink();
  return !fs.existsSync(f);
});
check('delete() rejects for a missing file', async () =>
  await rejects(() => BunFile(p('missing4.txt')).delete()));

// --- deliberate loud failure -------------------------------------------------
check('slice() throws instead of returning an empty Blob', () => {
  // Inherited Blob.prototype.slice would silently return an EMPTY blob, since
  // super([]) holds no data. Silent wrong data is worse than a hard error.
  try { BunFile(p('a.txt')).slice(0, 1); return false; }
  catch (err) { return err instanceof Error && /slice/.test(err.message); }
});

// --- run ---------------------------------------------------------------------
(async () => {
  for (const [name, fn] of tests) {
    try {
      const r = await fn();
      if (r === true) pass++;
      else failures.push(`${name}: expected true, got ${JSON.stringify(r)}`);
    } catch (err) {
      failures.push(`${name}: threw ${err && err.message}`);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`\n${failures.length}/${total} FAILED:`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log(`✓ ${pass}/${total} Bun.file shim tests passed`);
})();
