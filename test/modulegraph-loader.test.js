#!/usr/bin/env node
// Unit + end-to-end suite for modulegraph-loader.js.  Run with `npm test`.
//
// The unit half drives resolve()/load() directly with a recording fake
// bundleRequire, so every mapping rule is pinned in isolation. The e2e half
// registers the hooks in a child Node process against a tiny synthetic graph
// and imports its entry, because the only proof that module.registerHooks()
// accepts what we return (file: URLs that exist nowhere on disk, served with
// a source string) is Node itself doing so.

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const { createModuleGraphLoader, toSafe, BUNFS_URL } = require('../modulegraph-loader.js');

const REPO = path.join(__dirname, '..');
let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond === true) pass++; else failures.push(name); };
const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(String(e && e.message)); } };

const RE = /(?<!["'`])(?<![A-Za-z0-9_$])Bun\.(hash|file)\b/g;

function makeGraph(modules, entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-loader-'));
  const index = { format: 1, version: 't', entry, entry_index: 0, modules: [] };
  for (const m of modules) {
    const file = toSafe(m.path.slice('/$bunfs/root/'.length));
    fs.writeFileSync(path.join(dir, file), m.body);
    index.modules.push({ path: m.path, file, bytes: Buffer.byteLength(m.body), js: m.js !== false });
  }
  fs.writeFileSync(path.join(dir, '_index.json'), JSON.stringify(index));
  return dir;
}

// --- fake bundleRequire: records calls, resolves bare names under /fake ------
const calls = [];
const fakeRequire = (spec) => { calls.push(spec); return { spec }; };
fakeRequire.resolve = (spec) => `/fake/node_modules/${spec}/index.js`;

const dir = makeGraph([
  { path: '/$bunfs/root/cli', body:
    'import{a}from"/$bunfs/root/chunk-a.js";const t="/$bunfs/root/x.asset";' +
    'const n=import.meta.require("/$bunfs/root/nat.node");const msg="Bun.hash unavailable";' +
    'export const r=Bun.hash("x");export const f=Bun.file("/dev/null");' },
  { path: '/$bunfs/root/chunk-a.js', body: 'export const a=1;' },
  { path: '/$bunfs/root/x.asset', body: '<!doctype html>', js: false },
  { path: '/$bunfs/root/nat.node', body: 'ELF', js: false },
], '/$bunfs/root/cli');

// --- 1. construction ------------------------------------------------------------
check('rejects a non-global regex', throwsWith(
  () => createModuleGraphLoader({ modulesDir: dir, bunShimRegex: /Bun\.(hash)/, bundleRequire: fakeRequire }), /global RegExp/));
check('rejects a missing directory', throwsWith(
  () => createModuleGraphLoader({ modulesDir: '/nonexistent/mg', bunShimRegex: RE, bundleRequire: fakeRequire }), /_index\.json/));
{
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-bad-'));
  fs.writeFileSync(path.join(bad, '_index.json'), JSON.stringify({ format: 2, entry: '/$bunfs/root/cli', modules: [] }));
  check('rejects an unknown manifest format', throwsWith(
    () => createModuleGraphLoader({ modulesDir: bad, bunShimRegex: RE, bundleRequire: fakeRequire }), /format-1/));
  fs.writeFileSync(path.join(bad, '_index.json'), JSON.stringify({ format: 1, entry: '/$bunfs/root/cli', modules: [] }));
  check('rejects an entry absent from the manifest', throwsWith(
    () => createModuleGraphLoader({ modulesDir: bad, bunShimRegex: RE, bundleRequire: fakeRequire }), /not in the manifest/));
}
const g = createModuleGraphLoader({ modulesDir: dir, bunShimRegex: RE, bundleRequire: fakeRequire });
check('entryUrl is the file: form of the manifest entry', g.entryUrl === 'file:///$bunfs/root/cli');

// --- 2. resolve ----------------------------------------------------------------
const NEXT = { url: 'next:called' };
const nextResolve = () => NEXT;
const fromGraph = { parentURL: BUNFS_URL + 'cli' };
const fromDisk = { parentURL: 'file:///elsewhere/main.mjs' };
const res = (spec, ctx) => g.hooks.resolve(spec, ctx, nextResolve);

check('/$bunfs/root/X -> file:///$bunfs/root/X', (() => { const r = res('/$bunfs/root/chunk-a.js', fromGraph); return r.url === 'file:///$bunfs/root/chunk-a.js' && r.shortCircuit === true; })());
check('file:///$bunfs/root/X passes through', res('file:///$bunfs/root/chunk-a.js', fromDisk).url === 'file:///$bunfs/root/chunk-a.js');
check('bun:ffi throws ERR_MODULE_NOT_FOUND', (() => { try { res('bun:ffi', fromGraph); return false; } catch (e) { return e.code === 'ERR_MODULE_NOT_FOUND'; } })());
check('bun:jsc throws ERR_MODULE_NOT_FOUND', (() => { try { res('bun:jsc', fromGraph); return false; } catch (e) { return e.code === 'ERR_MODULE_NOT_FOUND'; } })());
check('builtin from a graph module gets the node: prefix', res('fs', fromGraph).url === 'node:fs');
check('node:-prefixed builtin from a graph module is kept', res('node:path', fromGraph).url === 'node:path');
check('bare specifier from a graph module resolves via bundleRequire.resolve', res('yaml', fromGraph).url === 'file:///fake/node_modules/yaml/index.js');
check('relative import from a graph module is an error', throwsWith(() => res('./rel.js', fromGraph), /relative import/));
check('anything from a non-graph parent goes to nextResolve', res('yaml', fromDisk) === NEXT);
check('anything without a parent goes to nextResolve', res('yaml', {}) === NEXT);

// --- 3. load -------------------------------------------------------------------
const NEXTL = { format: 'module', source: 'next' };
const nextLoad = () => NEXTL;
const load = (url) => g.hooks.load(url, {}, nextLoad);
{
  const r = load('file:///$bunfs/root/cli');
  const s = r.source;
  check('load serves format module, short-circuited', r.format === 'module' && r.shortCircuit === true);
  check('Bun.hash( call rewritten to __bunShim.hash(', s.includes('__bunShim.hash("x")'));
  check('Bun.file( call rewritten too', s.includes('__bunShim.file("/dev/null")'));
  check('"Bun.hash" inside a string literal is left alone', s.includes('"Bun.hash unavailable"'));
  check('import.meta.require rewritten to globalThis.__bunfsRequire', s.includes('globalThis.__bunfsRequire("/$bunfs/root/nat.node")') === false && s.includes('globalThis.__bunfsRequire('));
  check('asset literal rewritten to the extracted path', s.includes(`"${path.join(dir, 'x.asset')}"`) && !s.includes('"/$bunfs/root/x.asset"'));
  check('addon literal rewritten to the extracted path', s.includes(`("${path.join(dir, 'nat.node')}")`));
  check('module import specifier left untouched', s.includes('from"/$bunfs/root/chunk-a.js"'));
}
check('missing module names the path', throwsWith(() => load('file:///$bunfs/root/nope.js'), /nope\.js is not in the module graph/));
check('importing a .node as ESM is an error', throwsWith(() => load('file:///$bunfs/root/nat.node'), /native addon/));
check('non-graph URL goes to nextLoad', load('file:///elsewhere/x.js') === NEXTL);

// --- 4. bunfsRequire -------------------------------------------------------------
calls.length = 0;
g.bunfsRequire('/$bunfs/root/nat.node');
check('bunfsRequire maps a graph path to the extracted file', calls[0] === path.join(dir, 'nat.node'));
g.bunfsRequire('yaml');
check('bunfsRequire passes bare names through', calls[1] === 'yaml');
check('bunfsRequire rejects unknown graph paths', throwsWith(() => g.bunfsRequire('/$bunfs/root/nope.node'), /not in the module graph/));

// --- 5. end to end through module.registerHooks --------------------------------
const e2e = makeGraph([
  { path: '/$bunfs/root/cli', body:
    'import{a}from"/$bunfs/root/chunk-a.js";import{parse}from"yaml";import{fileURLToPath}from"url";' +
    'export const r=Bun.hash("x");export const p=fileURLToPath(import.meta.url);' +
    'export const y=parse("k: 1").k;export const a2=a;' +
    'export const j=await import("bun:jsc").then(()=>"loaded",(e)=>e.code);' },
  { path: '/$bunfs/root/chunk-a.js', body: 'export const a=1;' },
], '/$bunfs/root/cli');
const child = spawnSync(process.execPath, ['-e', `
  const Module = require('module');
  const { createModuleGraphLoader } = require(${JSON.stringify(path.join(REPO, 'modulegraph-loader.js'))});
  const bundleRequire = Module.createRequire(${JSON.stringify(path.join(REPO, 'package.json'))});
  const g = createModuleGraphLoader({ modulesDir: ${JSON.stringify(e2e)}, bunShimRegex: ${RE.toString()}, bundleRequire });
  globalThis.__bunShim = { hash: () => 42 };
  globalThis.__bunfsRequire = g.bunfsRequire;
  Module.registerHooks(g.hooks);
  import(g.entryUrl).then((m) => console.log(JSON.stringify({ r: m.r, p: m.p, y: m.y, a2: m.a2, j: m.j })))
    .catch((e) => { console.error(e); process.exit(1); });
`], { encoding: 'utf8', timeout: 20000 });
let got = null;
try { got = JSON.parse(child.stdout.trim()); } catch (_) { /* reported below */ }
check('e2e: child exited 0', child.status === 0);
check('e2e: shimmed Bun.hash reached __bunShim', got && got.r === 42);
check('e2e: import.meta.url is the virtual file: path', got && got.p === '/$bunfs/root/cli');
check('e2e: bare import resolved from this repo\'s node_modules', got && got.y === 1);
check('e2e: graph-internal import linked', got && got.a2 === 1);
check('e2e: dynamic import of bun:jsc rejects with ERR_MODULE_NOT_FOUND', got && got.j === 'ERR_MODULE_NOT_FOUND');
if (child.status !== 0) console.error(child.stderr);

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length}/${pass + failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} modulegraph-loader tests passed`);
