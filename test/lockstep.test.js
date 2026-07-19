#!/usr/bin/env node
// Asserts the three-way lockstep the shim layer depends on.  Run with `npm test`.
//
// A shimmed symbol has to appear in three places, and every pairing has a
// silent failure mode if it drifts:
//
//   1. launcher.js source-replace regex  (Bun.X -> __bunShim.X)
//   2. launcher.js __bunShim object      (the implementation behind it)
//   3. update.sh SHIMMED_BUN             (what the release audit accepts)
//
//   1 without 2  -> the bundle is rewritten to __bunShim.X, which is undefined:
//                   a TypeError at the first call, on whatever cold path that is.
//   1 without 3  -> the audit re-flags the symbol on the next release and blocks
//                   a deploy that would actually have been fine.
//   3 without 1  -> WORST: the audit stays silent about a symbol nothing
//                   rewrites, so bare Bun.X survives into the eval'd bundle and
//                   throws ReferenceError when reached.
//
// update.sh's own comment says the two lists "must stay in lockstep"; this test
// is what makes that enforceable instead of aspirational.

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(REPO, 'launcher.js'), 'utf8');
const update = fs.readFileSync(path.join(REPO, 'update.sh'), 'utf8');

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const fmt = (s) => (s.size ? [...s].sort().join(', ') : '(none)');

// 1. the source-replace alternation
const reMatch = launcher.match(/Bun\\\.\(([A-Za-z0-9_|]+)\)/);
if (!reMatch) {
  console.error('FATAL: source-replace regex not found in launcher.js');
  process.exit(1);
}
const regexSyms = new Set(reMatch[1].split('|'));

// 2. the __bunShim object's own top-level keys
const objStart = launcher.indexOf('globalThis.__bunShim = {');
if (objStart === -1) {
  console.error('FATAL: globalThis.__bunShim object not found in launcher.js');
  process.exit(1);
}
const objEnd = launcher.indexOf('\n};', objStart);
const objBody = launcher.slice(objStart, objEnd);
const shimSyms = new Set(
  [...objBody.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]),
);

// 3. SHIMMED_BUN in update.sh, comments stripped
const shMatch = update.match(/SHIMMED_BUN=\(([\s\S]*?)\n\)/);
if (!shMatch) {
  console.error('FATAL: SHIMMED_BUN array not found in update.sh');
  process.exit(1);
}
const auditSyms = new Set(
  shMatch[1]
    .replace(/#.*/g, '')
    .split(/\s+/)
    .filter((t) => t.startsWith('Bun.'))
    .map((t) => t.slice(4)),
);

const diff = (a, b) => new Set([...a].filter((x) => !b.has(x)));

const pairs = [
  ['launcher regex', regexSyms, '__bunShim object', shimSyms],
  ['launcher regex', regexSyms, 'update.sh SHIMMED_BUN', auditSyms],
];
for (const [aName, a, bName, b] of pairs) {
  const onlyA = diff(a, b);
  const onlyB = diff(b, a);
  if (onlyA.size) fail(`in ${aName} but not in ${bName}: ${fmt(onlyA)}`);
  if (onlyB.size) fail(`in ${bName} but not in ${aName}: ${fmt(onlyB)}`);
}

if (process.exitCode) {
  console.error(`\n  regex:      ${fmt(regexSyms)}`);
  console.error(`  __bunShim:  ${fmt(shimSyms)}`);
  console.error(`  SHIMMED_BUN:${fmt(auditSyms)}`);
  process.exit(1);
}

console.log(`✓ shim lockstep holds across all three lists (${regexSyms.size} symbols)`);
