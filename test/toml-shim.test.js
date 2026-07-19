#!/usr/bin/env node
// Unit suite for the Bun.TOML shim in launcher.js.  Run with `npm test`.
//
// The suite extracts the shim block from launcher.js by its BEGIN/END markers
// and evals it, so the code under test IS the shipped code and cannot drift
// from a copy. A shim block that gets renamed or removed fails loudly here
// rather than silently testing nothing.
//
// Calibration targets (real Bun cannot run on the hardware this project exists
// for: it SIGILLs, so no shim is ever verifiable against the real runtime):
//   - bun.com/docs/runtime/toml: canonical example, plus "Date/times: returned
//     as strings of their source text"
//   - TOML v1.0.0 spec examples
//   - the actual Codex config shapes the 2.1.214+ bundle feeds to zod

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.TOML shim';
const END = '// --- end Bun.TOML shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.TOML shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
const block = launcherSrc.slice(b, e);

// The block resolves its npm dep through the bundle's require, exactly as
// launcher.js does. bundle.js is gitignored and absent in a fresh clone, which
// is fine: createRequire only anchors module resolution, it never reads the
// file, so deps still resolve from <repo>/node_modules.
const bundleRequire = Module.createRequire(path.join(REPO, 'bundle.js'));
const TOML = eval(`${block}\n_bunShim_TOML;`);

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
const eq = (a, b_) => JSON.stringify(a) === JSON.stringify(b_);
const throws = (fn) => {
  try { fn(); return false; } catch (_) { return true; }
};

// --- 1. Bun's own documented example ----------------------------------------
check('bun docs example', () => eq(
  TOML.parse(`name = "my-app"
version = "1.0.0"
debug = true

[database]
host = "localhost"
port = 5432

[features]
tags = ["web", "api"]
`),
  { name: 'my-app', version: '1.0.0', debug: true,
    database: { host: 'localhost', port: 5432 },
    features: { tags: ['web', 'api'] } },
));

// --- 2. strings --------------------------------------------------------------
check('basic string + escapes', () =>
  TOML.parse('s = "a\\tb\\nc\\"d"').s === 'a\tb\nc"d');
check('literal string keeps backslashes', () =>
  TOML.parse("s = 'C:\\Users\\n'").s === 'C:\\Users\\n');
check('multiline basic string', () =>
  TOML.parse('s = """\nline1\nline2"""').s === 'line1\nline2');
check('multiline literal string', () =>
  TOML.parse("s = '''\nraw\\nnot-escaped'''").s === 'raw\\nnot-escaped');
check('unicode escape', () => TOML.parse('s = "\\u00e4"').s === 'ä');
check('empty string', () => TOML.parse('s = ""').s === '');

// --- 3. integers -------------------------------------------------------------
check('decimal int is a number', () => {
  const v = TOML.parse('n = 42').n;
  return v === 42 && typeof v === 'number';
});
check('negative int', () => TOML.parse('n = -17').n === -17);
check('underscores in int', () => TOML.parse('n = 1_000_000').n === 1000000);
check('hex int', () => TOML.parse('n = 0xDEADBEEF').n === 0xdeadbeef);
check('octal int', () => TOML.parse('n = 0o755').n === 493);
check('binary int', () => TOML.parse('n = 0b1101').n === 13);
// Regression guard: smol-toml's DEFAULT throws "integer value cannot be
// represented losslessly" on 64-bit ints, which are valid TOML 1.0. The shim
// must pass integersAsBigInt:"asNeeded" so valid documents never fail to parse.
check('64-bit int does not throw (asNeeded)', () => {
  const v = TOML.parse('n = 9223372036854775807').n;
  return typeof v === 'bigint' && v === 9223372036854775807n;
});
check('safe-range int stays a number, not BigInt', () =>
  typeof TOML.parse('n = 9007199254740991').n === 'number');

// --- 4. floats + booleans ----------------------------------------------------
check('float', () => TOML.parse('f = 3.1415').f === 3.1415);
check('exponent float', () => TOML.parse('f = 5e+22').f === 5e22);
check('inf / -inf', () => {
  const r = TOML.parse('a = inf\nb = -inf');
  return r.a === Infinity && r.b === -Infinity;
});
check('nan', () => Number.isNaN(TOML.parse('f = nan').f));
check('booleans', () => {
  const r = TOML.parse('t = true\nf = false');
  return r.t === true && r.f === false;
});

// --- 5. arrays / tables ------------------------------------------------------
check('array', () => eq(TOML.parse('a = [1, 2, 3]').a, [1, 2, 3]));
check('nested + heterogeneous array', () =>
  eq(TOML.parse('a = [[1, 2], ["x"], [true]]').a, [[1, 2], ['x'], [true]]));
check('multiline array with trailing comma', () =>
  eq(TOML.parse('a = [\n  1,\n  2,\n]').a, [1, 2]));
check('inline table', () =>
  eq(TOML.parse('t = { x = 1, y = "z" }').t, { x: 1, y: 'z' }));
check('nested tables', () =>
  eq(TOML.parse('[a.b.c]\nk = 1'), { a: { b: { c: { k: 1 } } } }));
check('dotted keys', () =>
  eq(TOML.parse('a.b = 1\na.c = 2'), { a: { b: 1, c: 2 } }));
check('array of tables', () =>
  eq(TOML.parse('[[p]]\nn = "a"\n\n[[p]]\nn = "b"'), { p: [{ n: 'a' }, { n: 'b' }] }));
check('empty document', () => eq(TOML.parse(''), {}));
check('comments ignored', () =>
  eq(TOML.parse('# lead\nk = 1 # trailing\n'), { k: 1 }));

// --- 6. date/times: Bun returns "strings of their source text" ---------------
// smol-toml hands back TomlDate objects; the shim normalizes them so the value
// shape matches Bun's documented contract.
check('offset date-time is source-text string', () => {
  const v = TOML.parse('d = 1979-05-27T07:32:00Z').d;
  return typeof v === 'string' && v === '1979-05-27T07:32:00Z';
});
check('offset date-time with numeric offset', () => {
  const v = TOML.parse('d = 1979-05-27T00:32:00-07:00').d;
  return typeof v === 'string' && v === '1979-05-27T00:32:00-07:00';
});
check('local date-time is source-text string', () => {
  const v = TOML.parse('d = 1979-05-27T07:32:00').d;
  return typeof v === 'string' && v === '1979-05-27T07:32:00';
});
check('local date is source-text string', () => {
  const v = TOML.parse('d = 1979-05-27').d;
  return typeof v === 'string' && v === '1979-05-27';
});
check('local time is source-text string', () => {
  const v = TOML.parse('d = 07:32:00').d;
  return typeof v === 'string' && v === '07:32:00';
});
check('dates nested in tables and arrays are normalized too', () => {
  const r = TOML.parse('[t]\nd = 1979-05-27\narr = [1979-05-27, 1980-01-01]\n[[aot]]\nd = 1979-05-27');
  return typeof r.t.d === 'string' && r.t.arr.every((x) => typeof x === 'string')
      && typeof r.aot[0].d === 'string';
});
check('no Date object survives anywhere', () => {
  const r = TOML.parse('a = 1979-05-27\n[b]\nc = [{ d = 1979-05-27T07:32:00Z }]');
  const seen = [];
  (function walk(v) {
    if (v instanceof Date) seen.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(r);
  return seen.length === 0;
});

// --- 7. object shape / safety ------------------------------------------------
check('plain Object.prototype (zod + `in` + hasOwnProperty safe)', () => {
  const r = TOML.parse('[t]\nk = 1');
  return Object.getPrototypeOf(r) === Object.prototype
      && Object.getPrototypeOf(r.t) === Object.prototype
      && typeof r.hasOwnProperty === 'function';
});
check('no prototype pollution via __proto__ key', () => {
  const before = Object.prototype.polluted;
  let r;
  try { r = TOML.parse('[__proto__]\npolluted = "yes"'); } catch (_) { return before === undefined; }
  return Object.prototype.polluted === undefined && ({}).polluted === undefined && r !== null;
});

// --- 8. errors ---------------------------------------------------------------
check('invalid TOML throws an Error', () => {
  try { TOML.parse('this is [not = toml'); return false; }
  catch (err) { return err instanceof Error; }
});
check('duplicate key throws', () => throws(() => TOML.parse('k = 1\nk = 2')));
check('non-string input throws', () => throws(() => TOML.parse(42)));

// --- 9. real Codex fixtures the 2.1.214 bundle actually parses ---------------
// config.toml → zod: { approval_policy, mcp_servers, skills, features, … }.loose()
check('codex config.toml fixture', () => {
  const r = TOML.parse(`model = "gpt-5"
approval_policy = "on-request"
web_search = true
project_doc_max_bytes = 32768

[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
env = { NODE_ENV = "production" }

[mcp_servers.remote]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_TOKEN"
http_headers = { X-Custom = "v" }

[[skills.config]]
path = "./skills/foo"

[features]
some_flag = true
`);
  return r.approval_policy === 'on-request'
      && r.web_search === true
      && r.project_doc_max_bytes === 32768
      && r.mcp_servers.filesystem.command === 'npx'
      && eq(r.mcp_servers.filesystem.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
      && r.mcp_servers.filesystem.env.NODE_ENV === 'production'
      && r.mcp_servers.remote.url === 'https://example.com/mcp'
      && r.mcp_servers.remote.http_headers['X-Custom'] === 'v'
      && Array.isArray(r.skills.config) && r.skills.config[0].path === './skills/foo'
      && r.features.some_flag === true;
});
// ~/.codex/prompts/*.toml → zod: { prompt: string, description?: string }
check('codex prompt .toml fixture', () => {
  const r = TOML.parse(`description = "Review a diff"
prompt = """
Review the following diff.
Be terse.
"""
`);
  return r.description === 'Review a diff'
      && r.prompt === 'Review the following diff.\nBe terse.\n';
});

// --- 10. stringify (not in Bun's API today; free from smol-toml) -------------
check('stringify roundtrips', () => {
  const obj = { a: 1, b: 'x', c: [1, 2], d: { e: true } };
  return eq(TOML.parse(TOML.stringify(obj)), obj);
});

// --- report ------------------------------------------------------------------
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} Bun.TOML shim tests passed`);
