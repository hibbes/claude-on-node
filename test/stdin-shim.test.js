#!/usr/bin/env node
// Unit suite for the Bun.stdin shim (globalThis.__bunShimStdin) in launcher.js.
// Run with `npm test`.
//
// Like the other suites, this extracts the shim block from launcher.js by its
// BEGIN/END markers and evals it, so the code under test IS the shipped code
// and cannot drift from a copy. A renamed/removed block fails loudly here.
//
// Calibration (real Bun cannot run on this hardware; it SIGILLs):
//   - bun.com/docs/api/utils#bun-stdin: Bun.stdin is a BunFile over the
//     process's stdin; .stream() yields a web ReadableStream<Uint8Array>.
//   - the only executable call site rewritten to this shim (v2.1.269):
//       async function Fn(C){let v=[],O=0,P=Bun.stdin.stream().getReader();...}
//     i.e. .stream().getReader() then a bounded read loop, so .stream() must
//     return a real web ReadableStream whose reader yields the stdin bytes.

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.stdin shim';
const END = '// --- end Bun.stdin shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.stdin shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
const block = launcherSrc.slice(b, e);

// Eval the block with an injected require/process so .stream() reads a fake
// stdin instead of the test runner's real one. globalThis is real; the block
// assigns globalThis.__bunShimStdin, which we then return.
const fakeProcess = { stdin: null };
const factory = new Function('require', 'process', block + '\nreturn globalThis.__bunShimStdin;');
const shim = factory(require, fakeProcess);

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const r = fn();
    if (r === true) { pass++; return; }
    failures.push(`${name}: expected true, got ${JSON.stringify(r)}`);
  } catch (err) {
    failures.push(`${name}: threw ${err && err.message}`);
  }
};

async function readAll(webStream) {
  const reader = webStream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

(async () => {
  check('shim exposes a stream() method', () => typeof shim.stream === 'function');

  // 1. .stream() returns a web ReadableStream (has getReader), not a Node stream.
  fakeProcess.stdin = Readable.from([Buffer.from('hello '), Buffer.from('stdin')]);
  const s1 = shim.stream();
  check('stream() returns a web ReadableStream', () =>
    !!s1 && typeof s1.getReader === 'function');

  // 2. reader yields exactly the stdin bytes (the getReader() call-site contract).
  const text1 = await readAll(s1);
  check('getReader() reads the injected stdin bytes', () => text1 === 'hello stdin');

  // 3. it reads the CURRENT process.stdin each call (guards the process.stdin
  //    reference: a shim hard-wired to the wrong source would ignore this).
  fakeProcess.stdin = Readable.from([Buffer.from('XYZ')]);
  const text2 = await readAll(shim.stream());
  check('re-reads current process.stdin on each call', () => text2 === 'XYZ');

  const total = pass + failures.length;
  if (failures.length) {
    console.error(`\n${failures.length}/${total} FAILED:`);
    for (const f of failures) console.error('  ✗ ' + f);
    process.exit(1);
  }
  console.log(`✓ ${pass}/${total} Bun.stdin shim tests passed`);
})();
