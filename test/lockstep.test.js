#!/usr/bin/env node
// Mechanical invariants of the shim layer.  Run with `npm test`.
//
// A shimmed symbol has to appear in four places, and every pairing has a
// failure mode that is silent in production:
//
//   1. launcher.js source-replace regex  (Bun.X -> __bunShim.X)
//   2. launcher.js __bunShim object      (the implementation behind it)
//   3. update.sh SHIMMED_BUN             (what the release audit accepts)
//   4. README.md shim coverage tables    (what a reader is told is covered)
//
//   1 without 2  -> the bundle is rewritten to __bunShim.X, which is undefined:
//                   a TypeError at the first call, on whatever cold path that is.
//   1 without 3  -> the audit re-flags the symbol on the next release and blocks
//                   a deploy that would actually have been fine.
//   3 without 1  -> WORST: the audit stays silent about a symbol nothing
//                   rewrites, so bare Bun.X survives into the eval'd bundle and
//                   throws ReferenceError when reached.
//   missing 4    -> documentation drift. Not a runtime bug, but it happened for
//                   real: the README sat at 15 symbols across four releases
//                   while the code had 19.
//
// Plus a fifth invariant that is not about symbols at all: every npm package
// the loader wires in must actually resolve. See the backer section below for
// why neither the release audit nor the smoke test can catch that one.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const launcher = fs.readFileSync(path.join(REPO, 'launcher.js'), 'utf8');
const update = fs.readFileSync(path.join(REPO, 'update.sh'), 'utf8');
const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');

const fail = (msg) => { console.error(`FAIL: ${msg}`); process.exitCode = 1; };
const fmt = (s) => (s.size ? [...s].sort().join(', ') : '(none)');
const die = (msg) => { console.error(`FATAL: ${msg}`); process.exit(1); };

// --- 1. the source-replace alternation ---------------------------------------
const reMatch = launcher.match(/Bun\\\.\(([A-Za-z0-9_|]+)\)/);
if (!reMatch) die('source-replace regex not found in launcher.js');
const regexSyms = new Set(reMatch[1].split('|'));

// --- 2. the __bunShim object's own top-level keys ----------------------------
// Brace-counted extraction rather than a '\n};' terminator search, so nested
// object/class values cannot truncate the scan. Key matching accepts `key:`,
// quoted keys and ES2015 shorthand methods `key(`, so writing an entry in any
// of those idiomatic forms does not make it invisible here.
const objStart = launcher.indexOf('globalThis.__bunShim = {');
if (objStart === -1) die('globalThis.__bunShim object not found in launcher.js');
let depth = 0;
let objEnd = -1;
for (let i = launcher.indexOf('{', objStart); i < launcher.length; i++) {
  const ch = launcher[i];
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth === 0) { objEnd = i; break; } }
}
if (objEnd === -1) die('could not find the end of the __bunShim object');
const objBody = launcher.slice(objStart, objEnd);
const shimSyms = new Set(
  [...objBody.matchAll(/^ {2}(?:['"])?([A-Za-z_][A-Za-z0-9_]*)(?:['"])?\s*[:(]/gm)].map((m) => m[1]),
);

// --- 3. SHIMMED_BUN in update.sh ---------------------------------------------
// Ask bash for the array rather than regex-parsing it. A regex cannot model
// bash word-splitting, quoting, or the fact that `#` only opens a comment at a
// word boundary: a token like `Bun.serve#gateway` is ONE array element to bash
// but reads as `Bun.serve` to a naive `#.*` strip, which would report the
// lockstep as holding while the audit array is genuinely broken.
const shMatch = update.match(/SHIMMED_BUN=\([\s\S]*?\n\)/);
if (!shMatch) die('SHIMMED_BUN array not found in update.sh');
let auditSyms;
try {
  const out = execFileSync('bash', ['-c', `${shMatch[0]}\nprintf '%s\\n' "\${SHIMMED_BUN[@]}"`],
    { encoding: 'utf8' });
  auditSyms = new Set(out.split('\n').filter(Boolean).map((t) => {
    if (!t.startsWith('Bun.')) fail(`SHIMMED_BUN holds a non-Bun.* element: ${JSON.stringify(t)}`);
    return t.slice(4);
  }));
} catch (err) {
  die(`could not evaluate SHIMMED_BUN with bash: ${err.message}`);
}

// --- 4. the README shim coverage section -------------------------------------
// Scoped to the coverage section proper: it ends where the AUDIT_INERT_BUN
// paragraph begins, because that paragraph names symbols which are deliberately
// NOT shimmed (Bun.stdin) and would otherwise look like drift.
const secStart = readme.indexOf('## Bun shim coverage');
const secEnd = readme.indexOf('A separate `AUDIT_INERT_BUN`');
if (secStart === -1 || secEnd === -1 || secEnd < secStart) {
  die('could not locate the README "Bun shim coverage" section');
}
// Only table rows and the throws-list sentence carry real symbol names; prose
// in the same section uses `Bun.X` as a placeholder for "any shimmed symbol".
const readmeSyms = new Set(
  readme.slice(secStart, secEnd)
    .split('\n')
    .filter((l) => l.startsWith('|') || l.includes('Throw on first use'))
    .flatMap((l) => [...l.matchAll(/`Bun\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])),
);

// --- compare ------------------------------------------------------------------
const diff = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const pairs = [
  ['launcher regex', regexSyms, '__bunShim object', shimSyms],
  ['launcher regex', regexSyms, 'update.sh SHIMMED_BUN', auditSyms],
  ['launcher regex', regexSyms, 'README coverage tables', readmeSyms],
];
for (const [aName, a, bName, b] of pairs) {
  const onlyA = diff(a, b);
  const onlyB = diff(b, a);
  if (onlyA.size) fail(`in ${aName} but not in ${bName}: ${fmt(onlyA)}`);
  if (onlyB.size) fail(`in ${bName} but not in ${aName}: ${fmt(onlyB)}`);
}

// --- 5. shim backers actually resolve ----------------------------------------
// Neither deploy gate covers this. update.sh's dep audit builds its list from
// require() targets inside bundle.js, so a launcher-side backer can never
// appear in it; and the smoke test (`--version`/`--help`) only exercises the
// EAGER requires at the top of launcher.js. A lazily required backer
// (smol-toml, node-pty) can therefore be absent from node_modules while every
// audit and both smoke probes pass, failing only when a user hits `claude
// import` or a background terminal. update.sh grew the same assertion before
// its smoke test; this is the copy that runs under `npm test`.
const backers = [...new Set(
  [...launcher.matchAll(/bundleRequire\('([^']+)'\)/g)].map((m) => m[1]),
)].sort();
if (backers.length === 0) fail('no bundleRequire() backers found in launcher.js, loader changed shape?');
const unresolvable = backers.filter((m) => {
  try { require.resolve(m, { paths: [REPO] }); return false; } catch (_) { return true; }
});
if (unresolvable.length) {
  fail(`shim backers not resolvable (run npm install): ${unresolvable.join(', ')}`);
}

// --- 6. README claims that a QA mutation pass proved unguarded ----------------
// A review of this gate showed it only reads column 1 of the coverage tables:
// mutating the prose symbol count, the documented Node version, or a backer's
// package name all passed green. These three checks close exactly those holes.
// Honest cost, stated up front: 6a and 6c couple to prose wording; rephrasing
// the sentence makes the gate fail loudly (like the die() anchors above), which
// is the acceptable failure direction, a loud false alarm beats silent drift.

// 6a. The prose count "All N symbols" must equal the regex alternation's size.
const proseCount = readme.match(/All (\d+) symbols below/);
if (!proseCount) {
  fail('README prose anchor "All N symbols below" not found (rephrased?) Update this test.');
} else if (Number(proseCount[1]) !== regexSyms.size) {
  fail(`README says "All ${proseCount[1]} symbols" but the launcher regex has ${regexSyms.size}`);
}

// 6b. Every bundleRequire() backer must appear as `name` in a coverage table
// row AND in package.json dependencies. (The reverse direction, classifying
// column 2 of the table, is not mechanizable: it mixes package names with
// prose like "64-bit FNV-1a (BigInt)".)
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const deps = new Set(Object.keys(pkg.dependencies || {}));
const tableRows = readme.split('\n').filter((l) => l.startsWith('|'));
for (const b of backers) {
  if (!deps.has(b)) fail(`backer ${b} is bundleRequire()d but missing from package.json dependencies`);
  if (!tableRows.some((l) => l.includes('`' + b + '`'))) {
    fail(`backer ${b} is bundleRequire()d but named in no README coverage-table row`);
  }
}

// 6c. The documented Node floor must match package.json engines.node.
const nodeClaim = readme.match(/\*\*Node (\d+)(?:\.\d+)*(?:\.\d+)* or newer\.\*\*/);
const engines = (pkg.engines && pkg.engines.node) || '';
const engMajor = engines.match(/(\d+)/);
if (!nodeClaim) {
  fail('README prose anchor "**Node N or newer.**" not found (rephrased?) Update this test.');
} else if (!engMajor) {
  fail(`package.json engines.node ("${engines}") has no parsable major version`);
} else if (Number(nodeClaim[1]) !== Number(engMajor[1])) {
  fail(`README documents Node ${nodeClaim[1]}+ but package.json engines.node is "${engines}"`);
}

// --- report -------------------------------------------------------------------
if (process.exitCode) {
  console.error(`\n  regex:       ${fmt(regexSyms)}`);
  console.error(`  __bunShim:   ${fmt(shimSyms)}`);
  console.error(`  SHIMMED_BUN: ${fmt(auditSyms)}`);
  console.error(`  README:      ${fmt(readmeSyms)}`);
  console.error(`  backers:     ${backers.join(', ')}`);
  process.exit(1);
}

console.log(`✓ shim lockstep holds across all four lists (${regexSyms.size} symbols), `
  + `${backers.length} backers resolvable`);
