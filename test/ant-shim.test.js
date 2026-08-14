#!/usr/bin/env node
// Unit suite for the Bun.ant shim in launcher.js.  Run with `npm test`.
//
// The suite extracts the shim block from launcher.js by its BEGIN/END markers
// and evals it, so the code under test IS the shipped code and cannot drift
// from a copy. A shim block that gets renamed or removed fails loudly here
// rather than silently testing nothing.
//
// Calibration targets (real Bun cannot run on the hardware this project exists
// for: it SIGILLs, so no shim is ever verifiable against the real runtime).
// Bun.ant is not even public Bun: it is a namespace of Anthropic-private
// natives in their custom Bun build, undocumented anywhere. What IS observable
// is the bundle's own use of it, and every call site sits in try/catch with an
// explicit degradation path:
//   - Bun.ant.getPeerUid(fd): catch -> warn "peer uid lookup failed" + null
//   - Bun.ant.getPeerPid(fd): catch -> warn "peer pid lookup failed" + return
//   - Bun.ant.setDumpable(false): catch -> log "prctl unavailable" + continue
// getPeerUid and setDumpable migrated from bun:ffi paths (pre-2.1.219) whose
// require() throws under Node into those same catches; getPeerPid arrived later
// (2.1.226) with the identical degrade-on-throw contract. Throwing is therefore
// the behavior-preserving shim, and these tests pin exactly that contract.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.ant shim';
const END = '// --- end Bun.ant shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.ant shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
const block = launcherSrc.slice(b, e);
const ant = eval(`${block}\n_bunShim_ant;`);

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
const throwsWith = (fn, ...needles) => {
  try { fn(); return false; } catch (err) {
    const msg = String(err && err.message);
    return needles.every((n) => msg.includes(n));
  }
};

// --- 1. the known members throw, and say what and why ----------------------
// The message must name the member (so the log line a user reports is
// self-locating) and say "not supported under Node" (the phrasing every other
// stub in launcher.js uses).
check('getPeerUid throws with member name', () =>
  throwsWith(() => ant.getPeerUid(3), 'Bun.ant.getPeerUid', 'not supported under Node'));
check('setDumpable throws with member name', () =>
  throwsWith(() => ant.setDumpable(false), 'Bun.ant.setDumpable', 'not supported under Node'));
check('getPeerPid throws with member name', () =>
  throwsWith(() => ant.getPeerPid(3), 'Bun.ant.getPeerPid', 'not supported under Node'));
check('memoryPressureLevel throws with member name', () =>
  throwsWith(() => ant.memoryPressureLevel(), 'Bun.ant.memoryPressureLevel', 'not supported under Node'));

// --- 2. the bundle's own call-site contracts keep working --------------------
// sjb() (daemon peer-uid check): try { return Bun.ant.getPeerUid(t) } catch { warn; return null }
check('daemon call-site degradation: catch yields null', () => {
  let r;
  try { r = ant.getPeerUid(42); } catch (_) { r = null; }
  return r === null;
});
// fBa() (peer-cred pid check): try { r = Bun.ant.getPeerPid(t); if(r>0) return r;
// warn; return } catch { warn; return } — a throw must reach the catch, not escape.
check('peer-cred call-site degradation: throw reaches the catch', () => {
  let reached = false;
  try { ant.getPeerPid(42); } catch (_) { reached = true; }
  return reached;
});
// iSm() (dump hardening): try { if(!Bun.ant.setDumpable(!1)) log(...) } catch(t) { log("prctl unavailable: " + t.message) }
check('hardening call-site degradation: catch sees an Error', () => {
  try { ant.setDumpable(false); return false; } catch (t) {
    return t instanceof Error && t.message.length > 0;
  }
});
// m$S() (bg low-mem, macOS-only): try { e=Bun.ant.memoryPressureLevel(); return e===null?void 0:enm[e] }
// catch { warn "bg low-mem: memoryPressureLevel failed"; return } — a throw degrades to undefined.
check('bg low-mem call-site degradation: catch yields undefined', () => {
  let r = 'sentinel';
  try { r = ant.memoryPressureLevel(); } catch (_) { r = undefined; }
  return r === undefined;
});

// --- 3. unknown members throw on READ, not just on call ----------------------
// The namespace is the trap: the release audit's symbol regex sees only
// "Bun.ant", so once that is in SHIMMED_BUN, a future release's new member
// deploys unaudited (update.sh's ANT_MEMBERS audit catches the literal
// Bun.ant.<member> spelling, but not a minifier alias like `let a=Bun.ant`).
// A plain object would then turn a member READ into silent undefined: exactly
// the property-vs-function trap Bun.isStandaloneExecutable taught us. The
// Proxy makes any unknown read throw loudly, naming the member.
check('unknown member read throws with member name', () =>
  throwsWith(() => ant.futureNativeThing, 'Bun.ant.futureNativeThing', 'not shimmed'));
check('unknown member read throws even without a call', () => {
  try { const x = ant.getSeccompStatus; void x; return false; } catch (_) { return true; }
});

// --- 4. feature detection stays honest ---------------------------------------
// `in` goes through the has trap, which is deliberately NOT overridden: an
// `"x" in Bun.ant` probe must keep returning false for members we don't have,
// not throw, so a future guarded call site degrades instead of crashing.
check('"getPeerUid" in ant is true', () => 'getPeerUid' in ant);
check('"getPeerPid" in ant is true', () => 'getPeerPid' in ant);
check('"setDumpable" in ant is true', () => 'setDumpable' in ant);
check('"memoryPressureLevel" in ant is true', () => 'memoryPressureLevel' in ant);
check('unknown member is not `in` ant', () => !('futureNativeThing' in ant));
check('Object.keys lists exactly the known members', () => {
  const k = Object.keys(ant).sort().join(',');
  return k === 'getPeerPid,getPeerUid,memoryPressureLevel,setDumpable';
});

// --- 5. generic object protocols must NOT trip the smoke alarm ---------------
// These four are how an object flows through logging, awaiting, serializing
// and inspection. They are not Bun.ant API uses, and a throw here would crash
// far from any Bun.ant context (a template literal in some log line). Each is
// allowed through; everything else stays loud.
check('string interpolation does not throw', () => `${ant}`.length > 0);
check('typeof is object (no typeof-guard flip)', () => typeof ant === 'object');
check('then read yields undefined (the probe await/Promise.resolve relies on)', () => {
  // Promise.resolve(x) reads x.then inside its resolve function to decide if
  // x is a thenable; a throwing get would turn the result into a REJECTED
  // promise (an unhandled rejection far from any Bun.ant context). Testing
  // `Promise.resolve(ant) instanceof Promise` would be tautological (it holds
  // even when the get throws), so pin the get contract itself, synchronously.
  return ant.then === undefined;
});
check('JSON.stringify serializes without throwing', () => {
  // toJSON read is allowed through (undefined), then default serialization
  // walks own enumerable props; both members are functions, so "{}".
  return JSON.stringify(ant) === '{}';
});
check('symbol-keyed reads do not throw (inspect/toPrimitive)', () => {
  return ant[Symbol.toPrimitive] === undefined
      && ant[Symbol.iterator] === undefined;
});

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`ant-shim: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ ant-shim: all ${pass} cases passed`);
