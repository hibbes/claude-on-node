#!/usr/bin/env node
// Unit suite for the Bun.stringWidth shim in launcher.js.  Run with `npm test`.
//
// The suite extracts the shim block from launcher.js by its BEGIN/END markers
// and evals it, so the code under test IS the shipped code and cannot drift
// from a copy. A shim block that gets renamed or removed fails loudly here
// rather than silently testing nothing.
//
// Calibration targets (real Bun cannot run on the hardware this project exists
// for: it SIGILLs, so no shim is ever verifiable against the real runtime):
//   - bun.com/docs/api/utils#bun-stringwidth: terminal column width, options
//     countAnsiEscapeCodes and ambiguousIsNarrow, both no-ops on printable
//     ASCII (no ESC, no ambiguous code points in [\x20-\x7E])
//   - string-width@4 (the pinned delegate) as the behavioral baseline: every
//     fast-path result must equal what the delegate would have returned
//   - the bundle's single call site: Nt(e){return Bun.stringWidth(e,CXh)}
//     with CXh={ambiguousIsNarrow:!0}, i.e. options are ALWAYS passed, which
//     is why the cache deliberately keys on the string alone (see the pin
//     tests below)

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const BEGIN = '// --- Bun.stringWidth shim';
const END = '// --- end Bun.stringWidth shim';

const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');
const b = launcherSrc.indexOf(BEGIN);
const e = launcherSrc.indexOf(END);
if (b === -1 || e === -1 || e < b) {
  console.error(`FATAL: Bun.stringWidth shim block not found in ${LAUNCHER}`);
  console.error(`  looked for ${JSON.stringify(BEGIN)} … ${JSON.stringify(END)}`);
  process.exit(1);
}
const block = launcherSrc.slice(b, e);

// Same resolution contract as launcher.js and the other suites: bundle.js is
// gitignored and absent in a fresh clone; createRequire only anchors module
// resolution, so deps resolve from <repo>/node_modules.
const bundleRequire = Module.createRequire(path.join(REPO, 'bundle.js'));
const realStringWidth = bundleRequire('string-width');
const [makeStringWidth, wiredStringWidth] =
  eval(`${block}\n[_bunShim_makeStringWidth, _bunShim_stringWidth];`);

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

// A delegate spy that counts calls and optionally forbids being called at all.
const spy = (impl) => {
  const f = (s, opts) => { f.calls++; if (f.forbidden) { throw new Error('delegate must not be called'); } return impl(s, opts); };
  f.calls = 0;
  f.forbidden = false;
  return f;
};

// --- 1. fast-path parity with the real delegate ------------------------------
// Every input, ASCII or not, must produce exactly what string-width@4 says,
// with and without the call site's options object.
const PARITY_CORPUS = [
  '', ' ', 'hello', 'hello world!', '~`!@#$%^&*()_+-={}[]|\\:;"\'<>,.?/',
  'A'.repeat(10000),
  'iVBORw0KGgoAAAANSUhEUgAABXgAAAcICAIAAAAJ1D6I',   // base64 prefix (ASCII)
  'ä', 'Größe', 'héllo', 'naïve',
  '漢字', 'こんにちは', '한국',
  '👍', '👩‍👩‍👦', '🇩🇪',
  '○ ambiguous circle', '§10 Abs. 2',
  '[31mred[39m', ']8;;https://xlink]8;;',
  'tab\there', 'nl\nthere', 'del\x7fchar', 'mixed ä + ascii tail ' + 'x'.repeat(500),
];
check('parity with string-width@4 (no opts)', () => {
  const sw = makeStringWidth(realStringWidth);
  return PARITY_CORPUS.every((s) => sw(s) === realStringWidth(s));
});
check('parity with string-width@4 (call-site opts {ambiguousIsNarrow:true})', () => {
  const sw = makeStringWidth(realStringWidth);
  return PARITY_CORPUS.every((s) => sw(s, { ambiguousIsNarrow: true }) === realStringWidth(s));
});

// --- 2. delegate pin: string-width@4 ignores options --------------------------
// The cache keys on the string alone. That is only sound while the delegate's
// result cannot depend on the options argument. string-width@4 accepts no
// options; if the delegate is ever upgraded to a version that honors
// ambiguousIsNarrow or countAnsiEscapeCodes, this pin goes red and the cache
// key (and the fast path's option reasoning) must be revisited.
check('PIN: delegate result independent of options', () => {
  const optVariants = [undefined, {}, { ambiguousIsNarrow: true }, { ambiguousIsNarrow: false }, { countAnsiEscapeCodes: true }];
  return PARITY_CORPUS.every((s) => {
    const base = realStringWidth(s);
    return optVariants.every((o) => realStringWidth(s, o) === base);
  });
});

// --- 3. ASCII fast path bypasses the delegate ---------------------------------
check('printable ASCII never reaches the delegate', () => {
  const d = spy(() => 0);
  d.forbidden = true;
  const sw = makeStringWidth(d);
  return sw('plain ascii text!') === 17
      && sw('') === 0
      && sw('A'.repeat(100000)) === 100000
      && d.calls === 0;
});
check('non-fast-path inputs do reach the delegate', () => {
  const d = spy((s) => realStringWidth(s));
  const sw = makeStringWidth(d);
  const inputs = ['ä', '\tx', '[31mred[39m', 'nl\nx', 'del\x7f'];
  inputs.forEach((s) => sw(s));
  return d.calls === inputs.length;
});

// --- 4. memo cache ------------------------------------------------------------
check('giant non-ASCII string measured once, then served from cache', () => {
  const d = spy((s) => realStringWidth(s));
  const sw = makeStringWidth(d);
  const s = 'ä' + 'x'.repeat(4999);
  const w1 = sw(s), w2 = sw(s), w3 = sw(s, { ambiguousIsNarrow: true });
  return d.calls === 1 && w1 === w2 && w2 === w3 && w1 === realStringWidth(s);
});
check('cached giant ASCII string skips the repeat regex scan path consistently', () => {
  const d = spy(() => 0);
  d.forbidden = true;
  const sw = makeStringWidth(d);
  const s = 'b64/'.repeat(2000);           // 8000 chars, >= default floor
  return sw(s) === 8000 && sw(s) === 8000 && d.calls === 0;
});
check('below cacheFloor is not cached', () => {
  const d = spy((s) => realStringWidth(s));
  const sw = makeStringWidth(d, { cacheFloor: 8, cacheBudget: 100 });
  const s = 'äöü';                          // len 3 < floor 8
  sw(s); sw(s);
  return d.calls === 2;
});
check('budget eviction is oldest-first', () => {
  const d = spy((s) => s.length);           // fake widths, lengths are what matter
  const sw = makeStringWidth(d, { cacheFloor: 4, cacheBudget: 20 });
  const A = 'ä'.repeat(10), B = 'ö'.repeat(10), C = 'ü'.repeat(10);
  sw(A); sw(B);                             // cache: A,B (20/20 chars)
  sw(C);                                    // evicts A (oldest) to fit C
  sw(B); sw(C);                             // both still cached
  sw(A);                                    // A was evicted: delegate again
  return d.calls === 4;                     // A, B, C, A
});
check('string larger than the whole budget is never cached and evicts nothing', () => {
  const d = spy((s) => s.length);
  const sw = makeStringWidth(d, { cacheFloor: 4, cacheBudget: 20 });
  const B = 'ö'.repeat(10), huge = 'ä'.repeat(21);
  sw(B);                                    // cached
  sw(huge); sw(huge);                       // oversize: delegate both times
  sw(B);                                    // must still be cached
  return d.calls === 3;                     // B, huge, huge
});

// --- 5. input coercion (parity with the previous shim: String(s ?? '')) -------
check('null/undefined/number coerce like the previous shim', () => {
  const d = spy((s) => realStringWidth(s));
  const sw = makeStringWidth(d);
  return sw(null) === 0 && sw(undefined) === 0 && sw(123) === 3 && d.calls === 0;
});

// --- 6. wired instance --------------------------------------------------------
check('launcher wires a working instance', () =>
  typeof wiredStringWidth === 'function'
  && wiredStringWidth('abc') === 3
  && wiredStringWidth('Größe', { ambiguousIsNarrow: true }) === realStringWidth('Größe'));

// --- report ------------------------------------------------------------------
const total = pass + failures.length;
if (failures.length) {
  console.error(`\n${failures.length}/${total} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${total} Bun.stringWidth shim tests passed`);
