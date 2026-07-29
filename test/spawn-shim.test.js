#!/usr/bin/env node
// Unit suite for the non-PTY Bun.spawn shim in launcher.js.  Run with `npm test`.
//
// The suite extracts the shim block from launcher.js by its BEGIN/END markers
// and evals it, so the code under test IS the shipped code and cannot drift
// from a copy. The Bun.file block is eval'd alongside it, because a spawn
// stdio target can be a BunFile and that integration is exactly what the
// bg-pty-host call site uses (stderr breadcrumb file).
//
// Calibration targets (real Bun cannot run on the hardware this project exists
// for: it SIGILLs, so no shim is ever verifiable against the real runtime):
//   - bun.com/docs/api/spawn (Subprocess surface, per-fd stdio defaults)
//   - the five call sites in the 2.1.220 bundle: rg version probe
//     (stdout.text() + exited), bg terminal (PTY branch, untouched here),
//     bg-pty-host spawner x2 (detached, unref, pid, BunFile/fd stderr,
//     synchronous errno throw for the breadcrumb open), spare-pool warmup
//     (fd stderr, argv0, detached).
//
// POSIX-only: cases spawn /bin/sh and read /proc/self/cmdline. The project
// targets Linux x64 extraction hosts, same as update.sh.

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');

const extract = (begin, end) => {
  const b = launcherSrc.indexOf(begin);
  const e = launcherSrc.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    console.error(`FATAL: shim block not found in ${LAUNCHER}`);
    console.error(`  looked for ${JSON.stringify(begin)} … ${JSON.stringify(end)}`);
    process.exit(1);
  }
  return launcherSrc.slice(b, e);
};

const fileBlock = extract('// --- Bun.file shim', '// --- end Bun.file shim');
const spawnBlock = extract('// --- Bun.spawn non-PTY shim', '// --- end Bun.spawn non-PTY shim');

// Both blocks in one scope: the spawn block recognizes BunFile stdio targets.
const [bunFile, spawnNormalize, spawnNonPty] = eval(
  `${fileBlock}\n${spawnBlock}\n[_bunShim_file, _bunShim_spawnNormalize, _bunShim_spawnNonPty];`,
);

let pass = 0;
const failures = [];
const checkAsync = async (name, fn) => {
  try {
    const r = await fn();
    if (r === true) { pass++; return; }
    failures.push(`${name}: expected true, got ${JSON.stringify(r)}`);
  } catch (err) {
    failures.push(`${name}: threw ${err && err.message}`);
  }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-shim-'));

// Guard against a silent early exit: an unref'd child (case 6) leaves nothing
// holding the event loop during `await exited`, and Node then exits 0 WITHOUT
// running the rest of the suite or printing the report. That is a false green
// (rc=0, zero output) and exactly the failure shape this repo's rules exist to
// prevent, so the suite fails loudly unless the report actually ran. (Found
// live: the first version of this suite exited silently at case 6.)
let reported = false;
process.on('exit', () => {
  if (!reported) {
    console.error('FATAL: suite exited before completing (event loop drained early?)');
    process.exitCode = 1;
  }
});

(async () => {
  // --- 1. the rg-version-probe shape (site 1) --------------------------------
  await checkAsync('stdout.text() + exited, argv0/cwd accepted (rg probe shape)', async () => {
    const p = spawnNonPty(['/bin/sh', '-c', 'echo ripgrep 15.1.0'], {
      argv0: 'rg-probe', cwd: process.cwd(), stderr: 'ignore', stdout: 'pipe', windowsHide: true,
    });
    const [out, code] = await Promise.all([p.stdout.text(), p.exited]);
    return out === 'ripgrep 15.1.0\n' && code === 0 && p.exitCode === 0 && p.signalCode === null;
  });

  await checkAsync('pid is a live number', async () => {
    const p = spawnNonPty(['/bin/sh', '-c', 'exit 0'], { stdout: 'ignore', stderr: 'ignore' });
    const pid = p.pid;
    await p.exited;
    return typeof pid === 'number' && pid > 0;
  });

  await checkAsync('non-zero exit code propagates', async () => {
    const p = spawnNonPty(['/bin/sh', '-c', 'exit 7'], { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 7 && p.exitCode === 7;
  });

  // --- 2. stdout is a real web ReadableStream with Bun's readers -------------
  await checkAsync('stdout instanceof ReadableStream (tee/getReader stay possible)', async () => {
    const p = spawnNonPty(['/bin/echo', 'x'], { stderr: 'ignore' });
    const ok = p.stdout instanceof ReadableStream;
    await Promise.all([p.stdout.text(), p.exited]);
    return ok;
  });

  await checkAsync('stdout.json() parses', async () => {
    const p = spawnNonPty(['/bin/sh', '-c', `echo '{"a":1}'`], { stderr: 'ignore' });
    const [v] = await Promise.all([p.stdout.json(), p.exited]);
    return v && v.a === 1;
  });

  await checkAsync('stdout.bytes() yields Uint8Array', async () => {
    const p = spawnNonPty(['/bin/echo', 'ab'], { stderr: 'ignore' });
    const [b] = await Promise.all([p.stdout.bytes(), p.exited]);
    return b instanceof Uint8Array && Buffer.from(b).toString() === 'ab\n';
  });

  // --- 3. per-fd defaults per bun.com/docs/api/spawn --------------------------
  // stdin "ignore", stdout "pipe", stderr "inherit". A cat with ignored stdin
  // reads EOF from /dev/null and exits 0; stdout must exist without asking.
  await checkAsync('defaults: stdin ignore, stdout pipe', async () => {
    const p = spawnNonPty(['/bin/cat']);
    const [out, code] = await Promise.all([p.stdout.text(), p.exited]);
    return out === '' && code === 0 && p.stdout !== undefined && p.stdin === undefined;
  });

  // --- 4. argv0 really reaches the child (site 3/4/5 set "claude bg-pty-host")
  await checkAsync('argv0 lands in the child argv[0]', async () => {
    const p = spawnNonPty(['/bin/cat', '/proc/self/cmdline'], { argv0: 'renamed-argv0', stderr: 'ignore' });
    const [out] = await Promise.all([p.stdout.text(), p.exited]);
    return out.split('\0')[0] === 'renamed-argv0';
  });

  // --- 5. stdio array with BunFile / fd targets (sites 3/4/5) ----------------
  await checkAsync('stdio BunFile stderr target lands in the file, own fd closed', async () => {
    const f = path.join(tmp, 'crumb.err');
    const p = spawnNonPty(['/bin/sh', '-c', 'echo oops >&2'],
      { stdio: ['ignore', 'ignore', bunFile(f)] });
    // The shim opens the BunFile itself and must close its fd inside the spawn
    // call (finally block), i.e. before it returns; a leak would burn one fd
    // per bg-worker respawn. Checked via /proc/self/fd SYMLINK TARGETS, not an
    // fd count: counts race against pipe fds of earlier cases closing
    // asynchronously in the background (observed flaky), while "no fd points
    // at the breadcrumb file anymore" is synchronous and exact.
    const leakedToFile = fs.readdirSync('/proc/self/fd').some((n) => {
      try { return fs.readlinkSync(`/proc/self/fd/${n}`) === f; } catch (_) { return false; }
    });
    await p.exited;
    return fs.readFileSync(f, 'utf8') === 'oops\n' && !leakedToFile;
  });

  await checkAsync('BunFile open error throws synchronously with errno code', async () => {
    // Site 3 catches Bt(l) === ENOENT/ENOSPC/EACCES/EROFS around Bun.spawn
    // itself, so the breadcrumb open failure must be a synchronous throw out
    // of the spawn call, carrying err.code. (Bun opens stdio files in spawn.)
    try {
      spawnNonPty(['/bin/sh', '-c', 'exit 0'],
        { stdio: ['ignore', 'ignore', bunFile(path.join(tmp, 'no-such-dir', 'x.err'))] });
      return false;
    } catch (err) { return err && err.code === 'ENOENT'; }
  });

  await checkAsync('stdio numeric fd target is used and stays open (borrowed)', async () => {
    const f = path.join(tmp, 'fd.err');
    const fd = fs.openSync(f, 'w');
    const p = spawnNonPty(['/bin/sh', '-c', 'echo viafd >&2'], { stdio: ['ignore', 'ignore', fd] });
    await p.exited;
    fs.writeSync(fd, 'parent-still-owns-fd\n'); // throws EBADF if the shim closed it
    fs.closeSync(fd);
    return fs.readFileSync(f, 'utf8') === 'viafd\nparent-still-owns-fd\n';
  });

  // --- 6. detached + unref + kill (bg-pty-host lifecycle) --------------------
  await checkAsync('detached spawn: unref(), kill(), signalCode + 128+n exited', async () => {
    const p = spawnNonPty(['/bin/sleep', '30'], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    p.unref();
    p.kill('SIGTERM');
    // unref() genuinely drops the child's event-loop reference (the bg-pty-host
    // contract), so a keep-alive timer must carry the loop across this await;
    // without it Node exits 0 right here, which the reported-guard above turns
    // into a loud failure instead of a silent green.
    const keepAlive = setInterval(() => {}, 200);
    const code = await p.exited;
    clearInterval(keepAlive);
    // KNOWN LIMIT: Bun's exited value for a signal death is not documented and
    // not verifiable here (Bun SIGILLs on this hardware). The shim resolves
    // with the POSIX-shell convention 128+signum, never 0; exitCode stays
    // null, matching Bun's documented "null until normal exit".
    return code === 143 && p.signalCode === 'SIGTERM' && p.exitCode === null;
  });

  // --- 7. missing executable degrades without an unhandled 'error' -----------
  // Bun throws synchronously for a missing binary; child_process reports it as
  // an async 'error' event, which unhandled would CRASH the whole process (the
  // exact failure mode this shim exists to avoid). The shim converts it to
  // exited === -1 plus a stderr warning; the rg probe then reads code !== 0.
  await checkAsync('ENOENT binary resolves exited -1, no crash', async () => {
    const p = spawnNonPty(['/no/such/binary-xyz'], { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === -1 && p.exitCode === -1;
  });

  // --- 8. stdin "pipe" gets a FileSink-shaped writer ---------------------------
  await checkAsync('stdin pipe: write/end FileSink subset', async () => {
    const p = spawnNonPty(['/bin/cat'], { stdin: 'pipe', stderr: 'ignore' });
    p.stdin.write('abc');
    p.stdin.end();
    const [out, code] = await Promise.all([p.stdout.text(), p.exited]);
    return out === 'abc' && code === 0;
  });

  // --- 9. timeout kills with killSignal ---------------------------------------
  await checkAsync('timeout enforces killSignal', async () => {
    const p = spawnNonPty(['/bin/sleep', '30'],
      { stdio: ['ignore', 'ignore', 'ignore'], timeout: 150, killSignal: 'SIGKILL' });
    const raced = await Promise.race([
      p.exited,
      new Promise((res) => setTimeout(() => res('mutation-hang'), 5000)),
    ]);
    return raced !== 'mutation-hang' && p.signalCode === 'SIGKILL';
  });

  // --- 10. ipc is refused loudly ----------------------------------------------
  await checkAsync('ipc option throws (half an IPC would be a landmine)', async () => {
    try {
      spawnNonPty(['/bin/sh', '-c', 'exit 0'], { ipc: () => {} });
      return false;
    } catch (err) { return String(err.message).includes('ipc'); }
  });

  // --- 11. object form normalization (Bun.spawn({cmd: [...]})) ----------------
  await checkAsync('normalize maps {cmd:[...]} to (argv, opts)', async () => {
    const [argv, opts] = spawnNormalize({ cmd: ['/bin/echo', 'hi'], argv0: 'z' }, undefined);
    return Array.isArray(argv) && argv[0] === '/bin/echo' && opts.argv0 === 'z';
  });

  await checkAsync('normalize passes array form through untouched', async () => {
    const o = { stdout: 'pipe' };
    const [argv, opts] = spawnNormalize(['/bin/echo'], o);
    return argv.length === 1 && opts === o;
  });

  // --- 12. onExit callback fires ----------------------------------------------
  await checkAsync('onExit callback receives (proc, exitCode, signalCode)', async () => {
    let got = null;
    const p = spawnNonPty(['/bin/sh', '-c', 'exit 3'], {
      stdout: 'ignore', stderr: 'ignore',
      onExit: (proc, code, sig) => { got = { code, sig, same: proc === undefined ? false : true }; },
    });
    await p.exited;
    await new Promise((res) => setImmediate(res));
    return got !== null && got.code === 3 && got.sig === null;
  });

  // --- 13. unsupported stdio spec is refused loudly ----------------------------
  await checkAsync('unknown stdio spec throws instead of silently ignoring', async () => {
    try {
      spawnNonPty(['/bin/sh', '-c', 'exit 0'], { stdio: ['ignore', { weird: true }, 'ignore'] });
      return false;
    } catch (err) { return String(err.message).includes('stdio'); }
  });

  // --- report -----------------------------------------------------------------
  reported = true;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failures.length) {
    console.error(`spawn-shim: ${pass} passed, ${failures.length} FAILED`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`✓ spawn-shim: all ${pass} cases passed`);
})().catch((err) => {
  console.error(`FATAL: suite crashed: ${err && err.stack}`);
  process.exit(1);
});
