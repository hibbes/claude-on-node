#!/usr/bin/env node
// Unit suite for the Bun.sleepSync shim in launcher.js.  Run with `npm test`.
//
// Like the other suites, this extracts the shim block from launcher.js by its
// BEGIN/END markers and evals it, so the code under test IS the shipped code.
//
// Calibration (real Bun cannot run on this hardware; it SIGILLs):
//   - bun.com/docs/runtime/utils#bun-sleepsync: "A blocking synchronous
//     version of Bun.sleep", milliseconds, Bun.sleepSync(1000) blocks the
//     thread for one second.
//   - Bun's own suite, test/js/bun/util/sleepSync.test.ts (MIT): no argument
//     throws, non-numbers throw, a negative number throws, and
//     [1, 2, 3].map(sleepSync) works (extra arguments are ignored).
//   - the only 2.1.271 call site: a 2 ms pause inside a bounded loop that
//     drains pending terminal replies from /dev/tty, so the pause has to be
//     real (a no-op turns the loop into a busy spin that gives up early).

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.sleepSync shim';
const END = '// --- end Bun.sleepSync shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.sleepSync shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
const sleepSync = new Function(`${launcherSrc.slice(b, e)}\nreturn _bunShim_sleepSync;`)();

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try {
    const r = fn();
    if (r === true) { pass++; return; }
    failures.push(`${name}: expected true, got ${JSON.stringify(r)}`);
  } catch (err) {
    failures.push(`${name}: threw ${err && err.stack}`);
  }
};
const throwsTypeError = (fn) => {
  try { fn(); } catch (err) { return err instanceof TypeError || `threw ${err}`; }
  return 'did not throw';
};
const elapsed = (fn) => { const t0 = performance.now(); const r = fn(); return [performance.now() - t0, r]; };

// --- 1. it blocks, synchronously, for about the requested time --------------
check('sleepSync(40) blocks for at least ~40 ms and returns undefined', () => {
  const [dt, r] = elapsed(() => sleepSync(40));
  return (r === undefined && dt >= 35 && dt < 1000) || `dt=${dt.toFixed(1)} r=${r}`;
});
check('sleepSync(2), the call site value, still pauses', () => {
  const [dt] = elapsed(() => { for (let i = 0; i < 10; i++) sleepSync(2); });
  return (dt >= 15 && dt < 1000) || `10 x sleepSync(2) took ${dt.toFixed(1)} ms`;
});
check('sleepSync(0) returns promptly', () => {
  const [dt] = elapsed(() => sleepSync(0));
  return dt < 50 || `dt=${dt.toFixed(1)}`;
});

// --- 2. argument validation (Bun's suite) ------------------------------------
check('no argument throws a TypeError', () => throwsTypeError(() => sleepSync()));
for (const v of [true, false, 'hi', '10', {}, [], undefined, null, 10n]) {
  check(`non-number ${typeof v} ${String(v)} throws a TypeError`, () => throwsTypeError(() => sleepSync(v)));
}
check('a negative number throws', () => {
  try { sleepSync(-10); } catch (_) { return true; }
  return 'did not throw';
});
// Coercion as in Bun's coerce::<i32> (src/jsc/JSValue.rs): NaN -> 0, truncate
// toward zero, saturate at the int32 range. Not ECMAScript ToInt32 (`| 0`),
// which wraps modulo 2^32 instead of saturating.
check('NaN sleeps 0 ms instead of forever (Atomics.wait would read NaN as +Infinity)', () => {
  const [dt] = elapsed(() => sleepSync(NaN));
  return dt < 50 || `dt=${dt.toFixed(1)}`;
});
check('-0.5 truncates to 0 and does not throw', () => {
  const [dt] = elapsed(() => sleepSync(-0.5));
  return dt < 50 || `dt=${dt.toFixed(1)}`;
});
check('-Infinity saturates to the int32 minimum and throws', () => {
  try { sleepSync(-Infinity); } catch (_) { return true; }
  return 'did not throw';
});
check('-(2 ** 32) saturates (| 0 would wrap it to 0) and throws', () => {
  try { sleepSync(-(2 ** 32)); } catch (_) { return true; }
  return 'did not throw';
});
check('[1, 2, 3].map(sleepSync) works (extra arguments ignored)', () => {
  const [dt, r] = elapsed(() => [1, 2, 3].map(sleepSync));
  return (Array.isArray(r) && r.every((x) => x === undefined) && dt >= 5) || `dt=${dt.toFixed(1)}`;
});

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`sleepSync shim: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ sleepSync shim: ${pass} checks passed`);
