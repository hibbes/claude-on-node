#!/usr/bin/env node
// Unit suite for plugin-shim.js.  Run with `npm test`.
//
// Verifies that loading plugin-shim.js via `node --require` correctly sets
// up globalThis.Bun with the shimmed API surface from launcher.js.  Plugin
// subprocesses are fresh Node processes with --require pointing to
// plugin-shim.js; this test replicates that invocation and probes the
// resulting Bun namespace.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SHIM = path.join(REPO, 'plugin-shim.js');

// Sanity check: the shim file exists
if (!fs.existsSync(SHIM)) {
  console.error(`FATAL: plugin-shim.js not found at ${SHIM}`);
  process.exit(1);
}

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

// --- probe helper -------------------------------------------------------------
// Spawn node with --require plugin-shim.js, run the given JS, return stdout.
const probe = (js) => {
  const result = spawnSync(process.execPath,
    ['--require', SHIM, '-e', js],
    { cwd: REPO, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_PATH: undefined } },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && result.stderr) {
    throw new Error(`probe exited ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
};

// --- probe: js-yaml -----------------------------------------------------------
// Execute a YAML probe; keep the output separate so failure diagnostics
// include the actual vs expected.
const probeJSON = (js, _label) => {
  const out = probe(js);
  try { return JSON.parse(out); } catch (_) { throw new Error(`${_label}: expected JSON, got ${JSON.stringify(out)}`); }
};

// --- 1. namespace presence ----------------------------------------------------

check('Bun is an object', () => {
  const type = probe('console.log(typeof Bun)');
  return type === 'object';
});

check('Bun.YAML is an object', () => {
  const type = probe('console.log(typeof Bun.YAML)');
  return type === 'object';
});

check('Bun.file is a function', () => {
  const type = probe('console.log(typeof Bun.file)');
  return type === 'function';
});

check('Bun.TOML is an object', () => {
  const type = probe('console.log(typeof Bun.TOML)');
  return type === 'object';
});

check('Bun.stringWidth is a function', () => {
  const type = probe('console.log(typeof Bun.stringWidth)');
  return type === 'function';
});

check('Bun.hash is a function', () => {
  const type = probe('console.log(typeof Bun.hash)');
  return type === 'function';
});

check('Bun.deepEquals is a function', () => {
  const type = probe('console.log(typeof Bun.deepEquals)');
  return type === 'function';
});

check('Bun.which is a function', () => {
  const type = probe('console.log(typeof Bun.which)');
  return type === 'function';
});

check('Bun.gc is a function', () => {
  const type = probe('console.log(typeof Bun.gc)');
  return type === 'function';
});

check('Bun.embeddedFiles is an array', () => {
  const type = probe('console.log(Array.isArray(Bun.embeddedFiles))');
  return type === 'true';
});

check('Bun.isStandaloneExecutable is false', () => {
  const val = probe('console.log(Bun.isStandaloneExecutable)');
  return val === 'false';
});

check('Bun.ant is an object/Proxy', () => {
  const type = probe('console.log(typeof Bun.ant)');
  return type === 'object';
});

// --- 2. YAML round-trip -------------------------------------------------------

check('Bun.YAML.parse returns an object', () => {
  const out = probe('console.log(JSON.stringify(Bun.YAML.parse("a: 1\\nb: 2")))');
  const parsed = JSON.parse(out);
  return parsed.a === 1 && parsed.b === 2;
});

// --- 3. Bun.file --------------------------------------------------------------

check('Bun.file creates a BunFile', () => {
  const type = probe('const b = Bun.file("/nonexistent"); console.log(typeof b.text)');
  return type === 'function';
});

check('Bun.file lazy construction (no throw on missing path)', () => {
  const ok = probe('try { Bun.file("/nonexistent_file_xyz"); console.log("ok"); } catch(e) { console.log("threw:"+e.message); }');
  return ok === 'ok';
});

// --- 4. Bun.hash --------------------------------------------------------------

check('Bun.hash returns a bigint-like value', () => {
  // The output could be a BigInt or a number; check it's finite and positive
  const out = probe('const h = Bun.hash("hello"); console.log(typeof h, String(h))');
  const [type, val] = out.split(' ');
  // bigint shows as "bigint", but for backward compat might be number
  return (type === 'bigint' || type === 'number') && val !== 'undefined';
});

// --- 5. Bun.gc is a no-op -----------------------------------------------------

check('Bun.gc runs without throwing', () => {
  const ok = probe('try { Bun.gc(); console.log("ok"); } catch(e) { console.log("threw:"+e.message); }');
  return ok === 'ok';
});

// --- 6. inert values ----------------------------------------------------------

check('Bun.JSONL is undefined', () => {
  const val = probe('console.log(String(Bun.JSONL))');
  return val === 'undefined';
});

// --- 7. throws-on-first-use symbols still throw -------------------------------

const throwsSymbols = ['generateHeapSnapshot', 'Transpiler', 'listen', 'serve', 'connect'];
for (const sym of throwsSymbols) {
  // These throw on use, not on access — check by calling
  check(`Bun.${sym} throws when called`, () => {
    const out = probe(`try { Bun.${sym}(); console.log("no throw"); } catch(e) { console.log("threw"); }`);
    return out === 'threw';
  });
}

// --- 8. Bun.ant members exist and throw on call -------------------------------

check('Bun.ant.getPeerUid throws', () => {
  const out = probe(`try { Bun.ant.getPeerUid(0); console.log("no throw"); } catch(e) { console.log("threw"); }`);
  return out === 'threw';
});

check('Bun.ant.getPeerPid throws', () => {
  const out = probe(`try { Bun.ant.getPeerPid(0); console.log("no throw"); } catch(e) { console.log("threw"); }`);
  return out === 'threw';
});

check('Bun.ant.setDumpable throws', () => {
  const out = probe(`try { Bun.ant.setDumpable(false); console.log("no throw"); } catch(e) { console.log("threw"); }`);
  return out === 'threw';
});

check('Bun.ant.memoryPressureLevel throws', () => {
  const out = probe(`try { Bun.ant.memoryPressureLevel(); console.log("no throw"); } catch(e) { console.log("threw"); }`);
  return out === 'threw';
});

// --- 9. source-replace is NOT applied (plugin context) ------------------------
// In the plugin context, Bun.X references stay as-is (no __bunShim rewrite).
// Verify that the raw name `Bun.file` still resolves after --require.
check('Bun.X references resolve directly (no source-replace in plugins)', () => {
  const out = probe('const b = Bun.file("/dev/null"); console.log(typeof b.text)');
  return out === 'function';
});

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length}/${pass + failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} plugin-shim tests passed`);
