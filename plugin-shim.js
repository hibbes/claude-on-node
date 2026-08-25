#!/usr/bin/env node
// Plugin subprocess Bun API shim for claude-on-node.
//
// Loaded via `node --require <path-to-plugin-shim.js>` by the bun PATH
// dispatcher (bin/bun) when spawning plugin subprocesses.
//
// Reads launcher.js from the same directory, evals its preamble and all
// shim blocks (stopping before the module-graph loader is registered), then
// copies globalThis.__bunShim to globalThis.Bun so plugin code can use
// Bun.X directly without source-replacement.
//
// Because the shim comes from the same launcher.js the main CLI uses,
// any new Bun symbol shimmed in a future update is automatically
// available to plugins with no extra maintenance.

const fs = require('fs');
const path = require('path');

const LAUNCHER = path.join(__dirname, 'launcher.js');

// launcher.js's preamble resolves the module-graph directory but never reads
// it (the graph is loaded only past the point we stop at), so a fresh clone
// without a deployed release can still --require this shim.
let launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
// Strip the shebang — new Function('<script>' ) rejects #! as an invalid token.
if (launcherSrc.startsWith('#!')) launcherSrc = '// ' + launcherSrc.slice(2);

// Find the end of `globalThis.__bunShim = { ... }` using brace-depth
// counting, same as test/lockstep.test.js.
const MARKER = 'globalThis.__bunShim = {';
const objStart = launcherSrc.indexOf(MARKER);
if (objStart === -1) {
  console.error('FATAL [plugin-shim]: globalThis.__bunShim not found in launcher.js');
  process.exit(1);
}
let depth = 0;
let objEnd = -1;
for (let i = launcherSrc.indexOf('{', objStart); i < launcherSrc.length; i++) {
  const ch = launcherSrc[i];
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
}
if (objEnd === -1) {
  console.error('FATAL [plugin-shim]: could not find the end of __bunShim in launcher.js');
  process.exit(1);
}

// Eval everything from line 1 through the __bunShim assignment.
// This defines all preamble helpers and shim blocks in a private scope,
// then sets globalThis.__bunShim. We use new Function to avoid leaking
// const/let declarations into this module's scope.
//
// When this function executes:
//  - require() resolves normally (including lazy bundleRequire deps like
//    smol-toml and node-pty, which most plugins won't need)
//  - __dirname is this file's directory, so modules/ and node_modules
//    resolve exactly as they do for the main CLI
//  - The module graph never loads: we stop before the loader is registered
//
// After the function returns, closures in globalThis.__bunShim (arrow
// functions capturing yamlMod, semverMod, etc.) keep those Module-scoped
// variables alive in the function's closure chain.
const preamble = launcherSrc.slice(0, objEnd + 1);
new Function('require', 'module', '__dirname', '__filename', 'exports',
  preamble)(require, module, __dirname, __filename, exports);

// Copy to globalThis.Bun so plugin code can call Bun.X directly.
// Unlike the main launcher, plugin subprocesses are fresh Node processes
// that don't use source-replacement — they just need Bun to exist.
globalThis.Bun = globalThis.__bunShim;
