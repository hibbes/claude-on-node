#!/usr/bin/env node
// Unit suite for the Bun.sliceAnsi shim in launcher.js.  Run with `npm test`.
//
// Like the other suites, this extracts shim blocks from launcher.js by their
// BEGIN/END markers and evals them, so the code under test IS the shipped code.
// The sliceAnsi block measures clusters with the Bun.stringWidth shim, so both
// blocks are evaluated together, exactly as they sit in launcher.js.
//
// Calibration (real Bun cannot run on the hardware this project exists for:
// it SIGILLs, so no shim is ever verifiable against the real runtime):
//   - bun.com/reference/bun/sliceAnsi and .../SliceAnsiOptions, plus the Bun
//     v1.3.11 release notes: slice by terminal column, `end` exclusive,
//     negative indices count from the end, ANSI (SGR, OSC 8 hyperlinks)
//     re-opened and closed at the cut, grapheme clusters never split,
//     `ellipsis` counted against the width budget and emitted inside active
//     SGR styles but outside an active hyperlink.
//   - Bun's own suite, test/js/bun/util/sliceAnsi.test.ts (MIT): its literal
//     expectations are ported below as the behavioral spec. Cases that hinge
//     on a width the delegate measures differently are left out or pinned in
//     the KNOWN LIMITS section instead.
//   - the 2.1.271 call sites, all three of which pass (input, start, end)
//     only: a truncate-with-ellipsis helper and the renderer's clip path
//     (both slice, then shrink `end` one column at a time until the measured
//     width fits), and the collapsed-output wrapper (cuts one long line into
//     fixed-width chunks).

const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO = path.join(__dirname, '..');
const LAUNCHER = path.join(REPO, 'launcher.js');
const launcherSrc = fs.readFileSync(LAUNCHER, 'utf8');

const extract = (name) => {
  const begin = `// --- ${name} shim`;
  const end = `// --- end ${name} shim`;
  const b = launcherSrc.indexOf(begin);
  const e = launcherSrc.indexOf(end);
  if (b === -1 || e === -1 || e < b) {
    console.error(`FATAL: ${name} shim block not found in ${LAUNCHER}`);
    console.error(`  looked for ${JSON.stringify(begin)} … ${JSON.stringify(end)}`);
    process.exit(1);
  }
  return launcherSrc.slice(b, e);
};
const widthBlock = extract('Bun.stringWidth');
const sliceBlock = extract('Bun.sliceAnsi');

// Same resolution contract as launcher.js: createRequire only anchors module
// resolution, the anchor file itself is never read.
const bundleRequire = Module.createRequire(path.join(REPO, 'bundle.js'));
const [sliceAnsi, stringWidth, JOINER] = new Function('bundleRequire',
  `${widthBlock}\n${sliceBlock}\nreturn [_bunShim_sliceAnsi, _bunShim_stringWidth, _SA_JOINER];`)(bundleRequire);

let pass = 0;
const failures = [];
const show = (v) => JSON.stringify(v);
const eq = (name, fn, want) => {
  try {
    const got = fn();
    if (got === want) { pass++; return; }
    failures.push(`${name}\n      want ${show(want)}\n      got  ${show(got)}`);
  } catch (err) {
    failures.push(`${name}: threw ${err && err.stack}`);
  }
};
const check = (name, fn) => {
  try {
    const r = fn();
    if (r === true) { pass++; return; }
    failures.push(`${name}: expected true, got ${show(r)}`);
  } catch (err) {
    failures.push(`${name}: threw ${err && err.stack}`);
  }
};
// Table form: [start, end, want] or [start, end, options, want].
const table = (label, input, rows) => {
  for (const row of rows) {
    const want = row[row.length - 1];
    const args = row.slice(0, -1);
    eq(`${label}: sliceAnsi(${show(input)}, ${args.map(show).join(', ')})`,
      () => sliceAnsi(input, ...args), want);
  }
};

const E = '…'; // …
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const BOLD = '\x1b[1m';
const FG_OFF = '\x1b[39m';
const BEL = '\x07';
const ST = '\x1b\\';
const C1_OSC = '\x9d';
const C1_ST = '\x9c';
const link = (text, url, term = BEL, closeTerm = term) => `\x1b]8;;${url}${term}${text}\x1b]8;;${closeTerm}`;

// Test-side visible text: drop OSC 8 hyperlink sequences (ESC or C1 introducer,
// BEL / ESC\ / C1 ST terminator), then CSI sequences. Inputs here are
// well-formed, so this simple stripper is exact for them.
const visible = (s) => s
  .replace(/(?:\x1b\]|\x9d)8;[^;\x07\x1b\x9c]*;[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g, '')
  .replace(/(?:\x1b\[|\x9b)[0-9;:?]*[ -\/]*[@-~]/g, '');

// ============================================================================
// 1. Plain strings (Bun suite "plain strings")
// ============================================================================
table('plain', 'hello world', [[0, 5, 'hello'], [6, 11, 'world'], [0, 11, 'hello world']]);
table('plain', 'hello', [
  [0, 0, ''], [3, 1, ''], [100, 200, ''], [3, undefined, 'lo'], [3, 100, 'lo'],
  [-2, undefined, 'lo'], [-5, undefined, 'hello'], [-100, undefined, 'hello'],
  [0, -1, 'hell'], [0, -4, 'h'], [1, -1, 'ell'], [-3, -1, 'll'],
  [0, 1, 'h'], [4, 5, 'o'], [undefined, undefined, 'hello'], [undefined, 3, 'hel'],
]);
eq('plain: no start/end returns the input', () => sliceAnsi('hello'), 'hello');
eq('plain: start 0 alone returns the input', () => sliceAnsi('hello', 0), 'hello');
eq('plain: empty input', () => sliceAnsi('', 0, 5), '');
eq('plain: empty input, no range', () => sliceAnsi(''), '');
// Negative start keeps what sits at or after the resolved column, zero-width
// and ANSI included; open styles found there are closed at the end.
table('negative start, trailing zero-width/ANSI', 'ab\t', [[-1, undefined, 'b\t'], [-1, 1000, 'b\t'], [0, -1, 'a']]);
table('negative start, trailing zero-width/ANSI', 'ab\x1b[31m', [[-1, undefined, 'b\x1b[31m\x1b[39m'], [0, -1, 'a']]);
table('negative start, trailing zero-width/ANSI', 'abc\x1b[1m\x1b[31m', [[-1, undefined, 'c\x1b[1m\x1b[31m\x1b[39m\x1b[22m']]);
table('negative start, trailing zero-width/ANSI', 'ab\x1b[0m', [[-1, undefined, 'b\x1b[0m']]);
table('negative start, trailing zero-width/ANSI', '\x1b[31mab\x1b[39m\t', [[-1, undefined, '\x1b[31mb\x1b[39m\t'], [1, undefined, '\x1b[31mb\x1b[39m\t']]);
// Index coercion follows String.prototype.slice (ToIntegerOrInfinity).
table('index coercion', 'hello', [[1.9, 3.2, 'el'], [NaN, 2, 'he'], ['1', '3', 'el'], [-Infinity, Infinity, 'hello']]);
// Same through the escape-driven walk, where String.prototype.slice cannot
// paper over an untruncated index.
table('index coercion (walk)', '\x1b[0mhello', [[1.9, 3.2, 'el'], [-2.5, undefined, 'lo']]);
eq('input coercion: number', () => sliceAnsi(123, 0, 2), '12');
eq('input coercion: boolean', () => sliceAnsi(true, 0, 2), 'tr');

// ============================================================================
// 2. SGR styles (Bun suite "ANSI color codes", "SGR style handling")
// ============================================================================
table('sgr', '\x1b[31mhello\x1b[39m', [
  [0, 5, '\x1b[31mhello\x1b[39m'], [0, 3, '\x1b[31mhel\x1b[39m'], [2, 5, '\x1b[31mllo\x1b[39m'],
]);
table('sgr', '\x1b[31mhello world\x1b[39m', [[6, 11, '\x1b[31mworld\x1b[39m']]);
table('sgr', '\x1b[1m\x1b[31mbold red\x1b[39m\x1b[22m', [
  [0, 4, '\x1b[1m\x1b[31mbold\x1b[39m\x1b[22m'], [5, 8, '\x1b[1m\x1b[31mred\x1b[39m\x1b[22m'],
]);
table('sgr', 'he\x1b[31mll\x1b[39mo', [[0, 5, 'he\x1b[31mll\x1b[39mo'], [1, 4, 'e\x1b[31mll\x1b[39m']]);
table('sgr reset', '\x1b[31mred\x1b[0mnormal', [[3, 9, 'normal'], [0, 9, '\x1b[31mred\x1b[0mnormal'], [0, 3, '\x1b[31mred\x1b[0m']]);
table('sgr nested', '\x1b[1mbold \x1b[31mred\x1b[39m text\x1b[22m', [[5, 8, '\x1b[1m\x1b[31mred\x1b[39m\x1b[22m']]);
table('sgr', '\x1b[31municorn\x1b[39m', [[0, 3, '\x1b[31muni\x1b[39m']]);
table('sgr', 'a\x1b[31mb\x1b[39m', [[0, 1, 'a']]);
table('sgr', '\x1b[31ma\x1b[39mb', [[1, 2, 'b']]);
table('sgr bg+fg', '\x1b[42m\x1b[30mtest\x1b[39m\x1b[49m', [[0, 1, '\x1b[42m\x1b[30mt\x1b[39m\x1b[49m']]);
table('sgr modifier', '\x1b[4mtest\x1b[24m', [[0, 1, '\x1b[4mt\x1b[24m']]);
table('sgr unknown code closes with a full reset', '\x1b[199mTEST\x1b[49m', [[0, 4, '\x1b[199mTEST\x1b[0m']]);
table('sgr unknown code closes with a full reset', '\x1b[1001mTEST\x1b[49m', [[0, 3, '\x1b[1001mTES\x1b[0m'], [0, 2, '\x1b[1001mTE\x1b[0m']]);
table('sgr truecolor', '\x1b[1m\x1b[48;2;255;255;255m\x1b[38;2;255;0;0municorn\x1b[39m\x1b[49m\x1b[22m', [
  [0, 3, '\x1b[1m\x1b[48;2;255;255;255m\x1b[38;2;255;0;0muni\x1b[39m\x1b[49m\x1b[22m'],
]);
table('sgr colon truecolor stays opaque', '\x1b[38:2:255:0:0mred\x1b[39m', [[0, 1, '\x1b[38:2:255:0:0mr\x1b[39m']]);
{
  const runs = '\x1b[43m\x1b[30m RUNS \x1b[39m\x1b[49m';
  const out = `${runs}  \x1b[32mtest\x1b[39m`;
  table('sgr no extra escapes', out, [[0, 7, `${runs} `], [0, 8, `${runs}  `]]);
  // Same-slot replacement moves the style to the end of the open list, so the
  // re-synthesized opens come out as background, then the newer foreground.
  table('sgr same slot replaces', `\x1b[31m${out}`, [[0, 4, '\x1b[43m\x1b[30m RUN\x1b[39m\x1b[49m']]);
}
table('sgr multi-parameter open is decomposed', '\x1b[1;31mX', [[0, 1, '\x1b[1m\x1b[31mX\x1b[39m\x1b[22m']]);
table('sgr multi-parameter', '\x1b[31;42mX\x1b[39m\x1b[49m', [[0, 1, '\x1b[31m\x1b[42mX\x1b[39m\x1b[49m']]);
table('sgr multi-parameter', '\x1b[31;42mX\x1b[39mY\x1b[49m', [[1, 2, '\x1b[42mY\x1b[49m']]);
table('sgr override', '\x1b[31mA\x1b[32mB', [[0, 2, '\x1b[31mA\x1b[32mB\x1b[39m'], [1, 2, '\x1b[32mB\x1b[39m']]);
table('sgr reset mixed with start', '\x1b[32mA\x1b[0;31mB\x1b[39m', [[1, 2, '\x1b[31mB\x1b[39m'], [0, 1, '\x1b[32mA\x1b[39m']]);
table('sgr styles starting after end are dropped', 'a\x1b[31mb\x1b[39m', [[0, 1, 'a']]);
// At EOF with the end bound reached, trailing escapes are close-only too.
table('sgr trailing open at EOF with the bound reached is dropped', 'ab\x1b[31m', [[0, 2, 'ab']]);
table('sgr bold+dim share close 22', '\x1b[1m\x1b[2mLoading dependencies...\x1b[22m', [
  [0, 10, '\x1b[1m\x1b[2mLoading de\x1b[22m'], [8, 15, '\x1b[1m\x1b[2mdepende\x1b[22m'],
]);
table('sgr bold+dim share close 22', '\x1b[1m\x1b[2mLoading de\x1b[22m', [[0, 5, '\x1b[1m\x1b[2mLoadi\x1b[22m']]);
table('sgr bold+dim share close 22', '\x1b[1;2mLoading dependencies...\x1b[22m', [[0, 10, '\x1b[1m\x1b[2mLoading de\x1b[22m']]);
table('sgr bold+dim share close 22', '\x1b[2m\x1b[1mtext\x1b[22m', [[1, 3, '\x1b[2m\x1b[1mex\x1b[22m']]);
table('sgr bold+dim share close 22', '\x1b[1m\x1b[2mAB\x1b[22mCD', [[1, 4, '\x1b[1m\x1b[2mB\x1b[22mCD']]);
table('sgr underline color 58/59', '\x1b[4m\x1b[58;5;196mERROR: file not found\x1b[59m\x1b[24m', [[7, 21, '\x1b[4m\x1b[58;5;196mfile not found\x1b[59m\x1b[24m']]);
table('sgr underline color 58/59', '\x1b[4m\x1b[58;2;255;128;0mwarning text here\x1b[59m\x1b[24m', [[0, 7, '\x1b[4m\x1b[58;2;255;128;0mwarning\x1b[59m\x1b[24m']]);
table('sgr underline color 58/59', '\x1b[58:5:196mERROR text\x1b[59m', [[0, 5, '\x1b[58:5:196mERROR\x1b[59m']]);
table('sgr underline color 58/59', '\x1b[4m\x1b[58:2::255:128:0mwarning text\x1b[59m\x1b[24m', [[0, 7, '\x1b[4m\x1b[58:2::255:128:0mwarning\x1b[59m\x1b[24m']]);
table('sgr 59 alone is a close', '\x1b[59mtext', [[1, 3, 'ex']]);
table('sgr underline color', '\x1b[58;5;196munder\x1b[59mplain', [[5, 10, 'plain'], [0, 5, '\x1b[58;5;196munder\x1b[59m']]);
table('sgr underline color', '\x1b[58;5;196munder\x1b[59m', [[0, 2, '\x1b[58;5;196mun\x1b[59m']]);
table('sgr underline color', '\x1b[31m\x1b[58;2;1;2;3mAB\x1b[59m\x1b[39m', [[1, 2, '\x1b[31m\x1b[58;2;1;2;3mB\x1b[59m\x1b[39m']]);
table('sgr double underline', '\x1b[21mdouble\x1b[24m normal', [[7, 13, 'normal'], [0, 6, '\x1b[21mdouble\x1b[24m']]);
table('sgr double underline', '\x1b[4m\x1b[21mtext\x1b[24m', [[1, 3, '\x1b[4m\x1b[21mex\x1b[24m']]);
table('sgr double underline', '\x1b[21m\x1b[4mtext\x1b[24m', [[1, 3, '\x1b[21m\x1b[4mex\x1b[24m']]);
table('sgr double underline', '\x1b[4m\x1b[21mAB\x1b[24mCD', [[1, 4, '\x1b[4m\x1b[21mB\x1b[24mCD']]);
table('sgr fraktur', '\x1b[20mfraktur\x1b[23m text', [[8, 12, 'text']]);
table('sgr fraktur', '\x1b[3m\x1b[20mtext\x1b[23m', [[0, 2, '\x1b[3m\x1b[20mte\x1b[23m']]);
table('sgr framed/encircled', '\x1b[51mframed\x1b[54m rest', [[0, 3, '\x1b[51mfra\x1b[54m']]);
table('sgr framed/encircled', '\x1b[52mcircled\x1b[54m', [[1, 4, '\x1b[52mirc\x1b[54m']]);
table('sgr framed/encircled', '\x1b[51m\x1b[52mtext\x1b[54m', [[1, 3, '\x1b[51m\x1b[52mex\x1b[54m']]);
table('sgr super/subscript', 'x\x1b[73m2\x1b[75m + y', [[0, 2, 'x\x1b[73m2\x1b[75m']]);
table('sgr super/subscript', '\x1b[74msub\x1b[75m text', [[4, 8, 'text']]);
table('sgr empty params default to 0', '\x1b[31;mabc', [[1, 3, 'bc'], [0, 3, 'abc']]);
table('sgr empty params default to 0', '\x9b31;mabc', [[1, 3, 'bc']]);
table('sgr empty params default to 0', '\x1b[;31mabc', [[1, 3, '\x1b[31mbc\x1b[39m']]);
table('sgr empty params default to 0', '\x1b[1;;31mabc', [[1, 3, '\x1b[31mbc\x1b[39m']]);
table('sgr empty params default to 0', '\x1b[31mred\x1b[mplain', [[3, 8, 'plain']]);
table('sgr C1 CSI re-opens with C1, closes with ESC form', '\x9b31mred\x9b39m', [[1, 2, '\x9b31me\x1b[39m']]);
check('sgr C1 CSI keeps visible text', () => visible(sliceAnsi('\x9b31mred\x9b39m', 0, 3)) === 'red');

// ============================================================================
// 3. Non-SGR control sequences are invisible (Bun suite "control sequences")
// ============================================================================
table('control', '\x1b[?25mA', [[0, 1, 'A']]);
table('control', '\x9b?25mA', [[0, 1, 'A']]);
table('control', '\x1b[2KA', [[0, 1, 'A']]);
table('control truncated CSI', '\x1b[31', [[0, 1, '']]);
table('control truncated CSI', '\x9b31', [[0, 1, '']]);
for (const input of ['\x1b[31\u0100A', '\x1b[\u0100A', '\x9b\u0100A']) {
  table('control non-ASCII is CSI payload', input, [[0, 5, '']]);
}
table('control non-ASCII is CSI payload', '\x1b[\u0100Axy', [[0, 5, 'xy']]);
table('control OSC', '\x1b]0;title\x07A', [[0, 1, 'A']]);
table('control DCS', '\x1bP1;2;3+x\x1b\\A', [[0, 1, 'A']]);
table('control C1 DCS', '\x90payload\x9cA', [[0, 1, 'A']]);
table('control SOS', '\x1bXpayload\x1b\\A', [[0, 1, 'A']]);
table('control PM', '\x1b^payload\x1b\\A', [[0, 1, 'A']]);
table('control C1 APC', '\x9fpayload\x9cA', [[0, 1, 'A']]);
table('control standalone ST', '\x1b\\A', [[0, 1, 'A']]);
table('control standalone ST', '\x9cA', [[0, 1, 'A']]);
table('control two-byte escapes', '\x1b7A', [[0, 1, 'A']]);
table('control two-byte escapes', '\x1bcA', [[0, 1, 'A']]);
table('control two-byte escapes', '\x1b=A', [[0, 1, 'A']]);
table('control nF escapes', '\x1b(BA', [[0, 1, 'A']]);
table('control nF escapes', '\x1b#8A', [[0, 1, 'A']]);
table('control ESC restarts a sequence', '\x1b\x1bcA', [[0, 1, 'A']]);
// An unterminated control string is not swallowed to the end of the input:
// its introducer counts as a zero-width character and the text after it stays
// visible (Bun keeps this deliberately different from stringWidth/stripANSI).
table('control unterminated string stays visible', '\x1b]0;title', [[0, 3, '\x1b]0;']]);
table('control unterminated string stays visible', '\x90payload', [[0, 3, '\x90pay']]);
table('control private CSI m keeps style state', '\x1b[31mA\x1b[?25mB\x1b[39m', [[0, 2, '\x1b[31mA\x1b[?25mB\x1b[39m'], [1, 2, '\x1b[31mB\x1b[39m']]);
table('control string before styled text', '\x1b]0;title\x07\x1b[31mAB\x1b[39m', [[0, 1, '\x1b[31mA\x1b[39m'], [1, 2, '\x1b[31mB\x1b[39m']]);
table('control string between characters', 'A\x1bP1;2;3+x\x1b\\B', [[0, 2, 'A\x1bP1;2;3+x\x1b\\B'], [1, 2, 'B']]);

// ============================================================================
// 4. OSC 8 hyperlinks (Bun suite "OSC 8 hyperlinks")
// ============================================================================
{
  const url = 'https://google.com';
  const g = link('Google', url);
  eq('hyperlink: whole link', () => sliceAnsi(g, 0, 6), g);
  eq('hyperlink: ST terminator', () => sliceAnsi(link('Google', url, ST), 0, 6), link('Google', url, ST));
  eq('hyperlink: mixed close terminator', () => sliceAnsi(link('Google', url, ST, BEL), 0, 6), link('Google', url, ST, BEL));
  const withId = `\x1b]8;id=abc;${url}${BEL}Google\x1b]8;;${BEL}`;
  table('hyperlink: params', withId, [[0, 6, withId], [1, 4, `\x1b]8;id=abc;${url}${BEL}oog\x1b]8;;${BEL}`]]);
  const withIdSt = `\x1b]8;id=abc;${url}${ST}Google\x1b]8;;${ST}`;
  table('hyperlink: params + ST', withIdSt, [[0, 6, withIdSt], [2, undefined, `\x1b]8;id=abc;${url}${ST}ogle\x1b]8;;${ST}`]]);
  const c1st = `\x1b]8;;${url}${C1_ST}Google\x1b]8;;${C1_ST}`;
  table('hyperlink: ESC OSC + C1 ST', c1st, [[0, 6, c1st], [1, 4, `\x1b]8;;${url}${C1_ST}oog\x1b]8;;${C1_ST}`]]);
  const c1bel = `${C1_OSC}8;;${url}${BEL}Google${C1_OSC}8;;${BEL}`;
  table('hyperlink: C1 OSC + BEL', c1bel, [[0, 6, c1bel], [1, 4, `${C1_OSC}8;;${url}${BEL}oog${C1_OSC}8;;${BEL}`]]);
  const c1c1 = `${C1_OSC}8;;${url}${C1_ST}Google${C1_OSC}8;;${C1_ST}`;
  table('hyperlink: C1 OSC + C1 ST', c1c1, [[0, 6, c1c1], [2, undefined, `${C1_OSC}8;;${url}${C1_ST}ogle${C1_OSC}8;;${C1_ST}`]]);
  const c1id = `${C1_OSC}8;id=abc;${url}${ST}Google${C1_OSC}8;;${ST}`;
  table('hyperlink: C1 OSC + params + ESC ST', c1id, [[0, 6, c1id], [1, 4, `${C1_OSC}8;id=abc;${url}${ST}oog${C1_OSC}8;;${ST}`]]);
  for (let i = 0; i < 6; i++) {
    eq(`hyperlink: single character ${i}`, () => sliceAnsi(g, i, i + 1), link('Google'.slice(i, i + 1), url));
  }
  eq('hyperlink: partial text', () => sliceAnsi(g, 1, 4), link('oog', url));
  eq('hyperlink: empty slice inside link text', () => sliceAnsi(g, 2, 2), '');
  eq('hyperlink: outer style kept after link text',
    () => sliceAnsi(`\x1b[31m${link('AB', 'https://example.com')}C\x1b[39m`, 2, 3), '\x1b[31mC\x1b[39m');
  const closeWithParams = `\x1b]8;id=abc;${url}${BEL}Google\x1b]8;id=abc;${BEL}`;
  table('hyperlink: close carrying params', closeWithParams, [[0, 6, closeWithParams], [0, 4, `\x1b]8;id=abc;${url}${BEL}Goog\x1b]8;;${BEL}`]]);
  eq('hyperlink: surrogate pair inside link', () => sliceAnsi(link('a\u{1F642}b', 'https://example.com'), 1, 3), link('\u{1F642}', 'https://example.com'));
  const fam = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  eq('hyperlink: grapheme cluster inside link', () => sliceAnsi(link(`A${fam}B`, 'https://example.com'), 1, 3), link(fam, 'https://example.com'));
  eq('hyperlink: mid-cluster slice is empty', () => sliceAnsi(link(`A${fam}B`, 'https://example.com'), 2, 3), '');
  table('hyperlink: across plain text', `A${g}B`, [[0, 2, `A${link('G', url)}`], [6, 8, `${link('e', url)}B`]]);
  eq('hyperlink: open to EOF gets a synthesized close', () => sliceAnsi(`\x1b]8;;${url}${BEL}Google`, 0, 6), g);
  eq('hyperlink: omitted end', () => sliceAnsi(g, 0), g);
  eq('hyperlink: from the middle, omitted end', () => sliceAnsi(g, 2), link('ogle', url));
  eq('hyperlink: start past the text', () => sliceAnsi(g, 100), '');
  table('hyperlink: slicing only outside linked text', `prefix ${g} suffix`, [[0, 3, 'pre'], [14, 19, 'suffi']]);
  // An open met right before the first column past the end opens nothing.
  table('hyperlink: open at the end boundary is dropped', `prefix ${g} suffix`, [[0, 7, 'prefix ']]);
  const fw = link('\u53E4\u53E4ab', 'https://example.com');
  check('hyperlink: fullwidth inside link [0,2)', () => visible(sliceAnsi(fw, 0, 2)) === '\u53E4');
  check('hyperlink: fullwidth inside link [2,4)', () => visible(sliceAnsi(fw, 2, 4)) === '\u53E4');
  check('hyperlink: fullwidth inside link [4,6)', () => visible(sliceAnsi(fw, 4, 6)) === 'ab');
  for (const input of [`\x1b]8;;https://example.comGoogle`, `\x1b]8;;https://example.com${BEL}Google\x1b]8;;`]) {
    check(`hyperlink: malformed input does not throw or leak null/undefined: ${show(input)}`, () => {
      const out = sliceAnsi(input, 0, 6);
      return typeof out === 'string' && !out.includes('null') && !out.includes('undefined');
    });
  }
  // Visible-text parity across link boundaries (Bun: assertVisibleSliceMatchesNative).
  const vis = (input, a, b) => check(`hyperlink visible parity ${show(input)} [${a},${b})`,
    () => visible(sliceAnsi(input, a, b)) === visible(input).slice(a, b));
  const nested = link('\x1b[31mR\x1b[39m\x1b[32mG\x1b[39m\x1b[34mB\x1b[39m', 'https://example.com');
  vis(nested, 0, 3); vis(nested, 1, 3); vis(nested, 1, 2);
  const styled = `\x1b[42m\x1b[30m${link('\x1b[31mtest\x1b[39m', 'https://example.com')}\x1b[39m\x1b[49m`;
  vis(styled, 0, 4); vis(styled, 1, 3);
  const two = `${link('one', 'https://one.test')}-${link('two', 'https://two.test')}`;
  vis(two, 0, 7); vis(two, 1, 6); vis(two, 3, 7);
  const b2b = `${link('A', 'https://a.test')}${link('B', 'https://b.test')}${link('C', 'https://c.test')}`;
  vis(b2b, 0, 3); vis(b2b, 1, 3); vis(b2b, 0, 2);
  const mixed = `${link('first', 'https://one.test', ST)} ${link('second', 'https://two.test', BEL, ST)}`;
  vis(mixed, 0, 8); vis(mixed, 2, 10); vis(mixed, 5, 11);
}

// ============================================================================
// 5. Widths and grapheme clusters (Bun suite "full-width", "emoji",
//    "grapheme clusters", "surrogate pairs", "multi-codepoint")
// ============================================================================
table('cjk', '\u4F60\u597D\u4E16\u754C', [[0, 2, '\u4F60'], [0, 4, '\u4F60\u597D'], [2, 6, '\u597D\u4E16'], [0, 8, '\u4F60\u597D\u4E16\u754C']]);
table('cjk mixed', 'a\u4F60b\u597Dc', [[0, 1, 'a'], [1, 3, '\u4F60'], [3, 4, 'b'], [4, 6, '\u597D'], [6, 7, 'c']]);
table('cjk colored', '\x1b[31m\u4F60\u597D\x1b[39m\u4E16\u754C', [
  [0, 4, '\x1b[31m\u4F60\u597D\x1b[39m'], [4, 8, '\u4E16\u754C'], [2, 6, '\x1b[31m\u597D\x1b[39m\u4E16'],
]);
table('japanese', '\u65E5\u672C\u8A9E\u30C6\u30B9\u30C8', [[0, 4, '\u65E5\u672C'], [4, 8, '\u8A9E\u30C6']]);
table('korean', '\uD55C\uAD6D\uC5B4', [[0, 2, '\uD55C'], [2, 4, '\uAD6D'], [4, 6, '\uC5B4']]);
table('korean', '\uC548\uB155\uD558\uC138', [[0, 4, '\uC548\uB155']]);
table('fullwidth not lost', '\u53E4\u53E4test', [[0, undefined, '\u53E4\u53E4test']]);
// A cluster whose START column lies inside [start, end) goes in whole, even
// when it extends past end (the call sites shrink end until the width fits);
// a cluster starting before `start` is dropped whole.
table('wide cluster straddling the end is kept', '\u4F60\u597D', [[0, 3, '\u4F60\u597D'], [1, 4, '\u597D']]);
table('emoji', '\u{1F44B}hello', [[0, 2, '\u{1F44B}'], [2, 7, 'hello']]);
table('emoji skin tone', '\u{1F44B}\u{1F3FD}hello', [[0, 2, '\u{1F44B}\u{1F3FD}'], [2, 7, 'hello']]);
table('emoji flag', '\u{1F1FA}\u{1F1F8}hello', [[0, 2, '\u{1F1FA}\u{1F1F8}'], [2, 7, 'hello']]);
{
  const fam = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  table('emoji ZWJ family', `${fam}hello`, [[0, 2, fam], [2, 7, 'hello']]);
  table('emoji ZWJ family', `A${fam}B`, [[1, 3, fam], [3, 4, 'B']]);
}
table('emoji several', '\u{1F44B}\u{1F389}\u{1F680}', [[0, 2, '\u{1F44B}'], [2, 4, '\u{1F389}'], [4, 6, '\u{1F680}']]);
table('emoji colored', '\x1b[31m\u{1F44B}\x1b[39mhello', [[0, 2, '\x1b[31m\u{1F44B}\x1b[39m'], [2, 7, 'hello']]);
table('surrogate pair', 'a\u{1F200}BC', [[0, 2, 'a\u{1F200}']]);
table('flag not split', 'A\u{1F1EE}\u{1F1F1}B', [[1, 2, '\u{1F1EE}\u{1F1F1}'], [2, 3, '']]);
table('styled flag not split', '\x1b[31m\u{1F1EE}\u{1F1F1}\x1b[39m', [[0, 1, '\x1b[31m\u{1F1EE}\u{1F1F1}\x1b[39m'], [1, 2, '']]);
table('emoji-presentation graphemes are wide', 'A\u263A\uFE0FB', [[1, 3, '\u263A\uFE0F']]);
table('emoji-presentation graphemes are wide', 'A1\uFE0F\u20E3B', [[1, 3, '1\uFE0F\u20E3']]);
table('text-presentation pictographs are narrow', 'A\u263AB', [[2, 3, 'B']]);
table('text-presentation pictographs are narrow', 'A\u2602B', [[2, 3, 'B']]);
check('no "null" leaks from a mixed emoji line', () => !sliceAnsi('\x1b[1mautotune.flipCoin("easy as") ? \u{1F382} : \u{1F370} \x1b[33m\u2605\x1b[39m\x1b[22m', 38).includes('null'));
table('combining mark stays with its base', 'Ae\u0301B', [[1, 2, 'e\u0301'], [2, 3, 'B']]);
table('CRLF is one zero-width cluster', 'A\r\nB', [[0, 1, 'A'], [1, 2, '\r\nB'], [0, 2, 'A\r\nB']]);
table('styled combining cluster', '\x1b[31me\u0301\x1b[39m', [[0, 1, '\x1b[31me\u0301\x1b[39m'], [1, 2, '']]);
check('style inside a combining sequence does not split it [0,1)', () => visible(sliceAnsi('\x1b[31me\x1b[39m\u0301B', 0, 1)) === 'e\u0301');
check('style inside a combining sequence does not split it [1,2)', () => visible(sliceAnsi('\x1b[31me\x1b[39m\u0301B', 1, 2)) === 'B');
eq('style opens inside a continuation past the end are kept', () => sliceAnsi('e\x1b[31m\u0301\x1b[39mB', 0, 1), 'e\x1b[31m\u0301\x1b[39m');
eq('hyperlink opens inside a continuation past the end are kept',
  () => sliceAnsi(`e\x1b]8;;https://example.com${BEL}\u0301\x1b]8;;${BEL}B`, 0, 1),
  `e\x1b]8;;https://example.com${BEL}\u0301\x1b]8;;${BEL}`);
{
  const zwjStyled = '\x1b[31m\u{1F468}\x1b[39m\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}B';
  check('style inside a ZWJ sequence [0,2)', () => visible(sliceAnsi(zwjStyled, 0, 2)) === '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}');
  check('style inside a ZWJ sequence [2,3)', () => visible(sliceAnsi(zwjStyled, 2, 3)) === 'B');
  const zwjStyled2 = '\u{1F468}\u200D\x1b[31m\u{1F469}\u200D\u{1F467}\u200D\u{1F466}\x1b[39mB';
  check('style between ZWJ and pictograph [0,2)', () => visible(sliceAnsi(zwjStyled2, 0, 2)) === '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}');
  check('style between ZWJ and pictograph [2,3)', () => visible(sliceAnsi(zwjStyled2, 2, 3)) === 'B');
}
// SGR or hyperlink tokens inserted at every internal scalar boundary of a
// cluster must not change which clusters a range selects (Bun's
// assertSlicesMatchPlainReference).
{
  const graphemes = ['e\u0301', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}', '\u{1F44D}\u{1F3FD}',
    '1\uFE0F\u20E3', '\u263A\uFE0F', '\u{1F1EE}\u{1F1F1}', '\uAC00', '\u{1F468}\u200D\u{1F469}'];
  const wrapAt = (g, idx, wrap) => [...g].map((sc, i) => (i === idx ? wrap(sc) : sc)).join('');
  for (const g of graphemes) {
    const plain = `A${g}B`;
    const n = [...g].length;
    for (let idx = 0; idx < n; idx++) {
      for (const [kind, wrap] of [['sgr', (sc) => `\x1b[31m${sc}\x1b[39m`], ['link', (sc) => link(sc, 'https://example.com')]]) {
        const styled = `A${wrapAt(g, idx, wrap)}B`;
        check(`cluster integrity (${kind}) ${show(g)} scalar ${idx}`, () => {
          for (let a = 0; a <= 6; a++) {
            for (let b = a; b <= 6; b++) {
              if (visible(sliceAnsi(styled, a, b)) !== visible(sliceAnsi(plain, a, b))) return `[${a},${b})`;
            }
          }
          return true;
        });
      }
    }
  }
}
table('surrogate pairs', 'a\u{1F600}b', [[0, 1, 'a'], [1, 3, '\u{1F600}'], [3, 4, 'b']]);
table('surrogate pairs', '\u{1F600}\u{1F601}\u{1F602}', [[0, 2, '\u{1F600}'], [2, 4, '\u{1F601}'], [4, 6, '\u{1F602}']]);
table('ZWJ sequence across boundaries', '\u{1F469}\u200D\u{1F4BB}xy', [[0, 4, '\u{1F469}\u200D\u{1F4BB}xy'], [2, 4, 'xy']]);
table('RI pair across boundaries', '\u{1F1FA}\u{1F1F8}xy', [[0, 4, '\u{1F1FA}\u{1F1F8}xy']]);
table('trailing modifier stays with its base', 'aaaaaaaa\u{1F44D}\u{1F3FF}', [[0, 10, 'aaaaaaaa\u{1F44D}\u{1F3FF}']]);
// This shim's choice, not a Bun parity claim: a lone surrogate is measured as
// U+FFFD (one column, its own cluster) and is never paired with a partner that
// sits on the other side of an escape sequence.
table('lone surrogates around an escape', 'a\uD83D\x1b[31m\uDE00b', [[1, 2, '\uD83D'], [2, 3, '\x1b[31m\uDE00\x1b[39m']]);

// ============================================================================
// 6. Edge cases, fast paths, stress (Bun suite "edge cases", "fast paths",
//    "stress tests", "real-world scenarios")
// ============================================================================
table('only ANSI', '\x1b[31m\x1b[39m', [[0, 0, ''], [0, 5, '']]);
table('ANSI at both ends', '\x1b[1m\x1b[31mhello\x1b[39m\x1b[22m', [[0, 5, '\x1b[1m\x1b[31mhello\x1b[39m\x1b[22m']]);
table('consecutive ANSI', '\x1b[1m\x1b[3m\x1b[31mhello\x1b[39m\x1b[23m\x1b[22m', [
  [0, 5, '\x1b[1m\x1b[3m\x1b[31mhello\x1b[39m\x1b[23m\x1b[22m'], [2, 5, '\x1b[1m\x1b[3m\x1b[31mllo\x1b[39m\x1b[23m\x1b[22m'],
]);
table('ASCII fast path', '0123456789', [[2, 5, '234'], [-3, undefined, '789'], [-3, -1, '78'], [0, 5, E, '0123' + E], [-5, undefined, E, E + '6789']]);
check('ASCII fast path agrees with the escape-driven walk', () => {
  const plain = 'abcdefghij';
  for (let a = 0; a <= 10; a++) {
    for (let b = a; b <= 10; b++) {
      if (sliceAnsi(plain, a, b) !== visible(sliceAnsi(`\x1b[0m${plain}`, a, b))) return `[${a},${b})`;
    }
  }
  return true;
});
check('stress: scattered ANSI keeps 10 visible chars', () => {
  let input = '';
  for (let i = 0; i < 100; i++) input += `\x1b[${31 + (i % 7)}m` + String.fromCharCode(65 + (i % 26));
  return visible(sliceAnsi(`${input}\x1b[0m`, 10, 20)).length === 10;
});
check('stress: 500 fullwidth chars, [100,200) is 50 chars of width 100', () => {
  const r = sliceAnsi('\u4F60'.repeat(500), 100, 200);
  return r.length === 50 && stringWidth(r) === 100;
});
check('stress: mixed content stays within 50 columns', () => stringWidth(sliceAnsi(`\x1b[31m${'hello \u4F60\u597D \u{1F44B} '.repeat(100)}\x1b[39m`, 0, 50)) <= 50);
check('upstream fixture: visible slice equals String.prototype.slice', () => {
  const fixture = '\x1b[31mthe \x1b[39m\x1b[32mquick \x1b[39m\x1b[34mbrown \x1b[39m\x1b[36mfox \x1b[39m\x1b[33mjumped \x1b[39m';
  const plain = visible(fixture);
  for (let a = 0; a < 20; a++) {
    for (let b = 19; b > a; b--) {
      if (visible(sliceAnsi(fixture, a, b)) !== plain.slice(a, b)) return `[${a},${b})`;
    }
  }
  return true;
});
check('real world: progress bar', () => visible(sliceAnsi('\x1b[32m\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\x1b[90m\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\x1b[39m 50%', 0, 8)) === '\u2588'.repeat(8));
check('real world: colored log line', () => visible(sliceAnsi('\x1b[90m[2024-01-01]\x1b[39m \x1b[31mERROR\x1b[39m: Something broke', 0, 12)) === '[2024-01-01]');
check('real world: table cell', () => {
  const t = sliceAnsi('\x1b[1m\x1b[36mLong column header\x1b[39m\x1b[22m', 0, 10);
  return stringWidth(t) <= 10 && visible(t) === 'Long colum';
});

// ============================================================================
// 7. Consistency with the Bun.stringWidth shim (Bun suite "width consistency")
// ============================================================================
for (const input of ['hello world', '\x1b[31mhello\x1b[39m world', 'a\x1b[31mb\x1b[32mc\x1b[33md\x1b[0me']) {
  check(`width never exceeds the range: ${show(input)}`, () => {
    const total = stringWidth(input);
    for (let a = 0; a < total; a++) {
      for (let b = a; b <= total; b++) if (stringWidth(sliceAnsi(input, a, b)) > b - a) return `[${a},${b})`;
    }
    return true;
  });
}
for (const input of ['\u4F60\u597D\u4E16\u754C', '\u{1F44B}\u{1F389}\u{1F680}']) {
  check(`wide text, even bounds, width never exceeds the range: ${show(input)}`, () => {
    const total = stringWidth(input);
    for (let a = 0; a < total; a += 2) {
      for (let b = a + 2; b <= total; b += 2) if (stringWidth(sliceAnsi(input, a, b)) > b - a) return `[${a},${b})`;
    }
    return true;
  });
}
for (const input of ['hello world', '\u4F60\u597D\u4E16\u754Ctest', '\x1b[31mhello\x1b[39m \x1b[32mworld\x1b[39m']) {
  check(`halves cover the input: ${show(input)}`, () => {
    const total = stringWidth(input);
    const mid = Math.floor(total / 2);
    return visible(sliceAnsi(input, 0, mid)) + visible(sliceAnsi(input, mid, total)) === visible(input);
  });
}

// ============================================================================
// 8. Ellipsis (Bun suite "ellipsis option")
// ============================================================================
table('ellipsis end', 'unicorn', [
  [0, 7, { ellipsis: E }, 'unicorn'], [0, 20, { ellipsis: E }, 'unicorn'], [0, 4, { ellipsis: E }, 'uni' + E],
  [0, 6, { ellipsis: E }, 'unico' + E], [0, 1, { ellipsis: E }, E],
  [-7, undefined, { ellipsis: E }, 'unicorn'], [-5, undefined, { ellipsis: E }, E + 'corn'], [-4, undefined, { ellipsis: E }, E + 'orn'],
  [0, 4, { ellipsis: '' }, 'unic'], [0, 4, E, 'uni' + E], [-4, undefined, E, E + 'orn'], [0, 4, '.', 'uni.'],
]);
table('ellipsis inherits SGR', `${RED}unicorns${FG_OFF}`, [
  [0, 5, { ellipsis: E }, `${RED}unic${E}${FG_OFF}`], [-5, undefined, { ellipsis: E }, `${RED}${E}orns${FG_OFF}`],
]);
table('ellipsis both edges', '0123456789', [[2, 8, { ellipsis: E }, `${E}3456${E}`]]);
eq('ellipsis sits outside the hyperlink but inside SGR',
  () => sliceAnsi(`${RED}\x1b]8;;https://example.com${BEL}link text\x1b]8;;${BEL}${FG_OFF}`, 0, 5, { ellipsis: E }),
  `${RED}\x1b]8;;https://example.com${BEL}link\x1b]8;;${BEL}${E}${FG_OFF}`);
table('ellipsis custom', 'unicorns', [[0, 5, { ellipsis: '.' }, 'unic.'], [0, 5, { ellipsis: '...' }, 'un...']]);
table('ellipsis wide', '\u5B89\u5B81\u54C8\u4E16\u754C', [[0, 3, { ellipsis: E }, '\u5B89' + E], [0, 5, { ellipsis: E }, '\u5B89\u5B81' + E]]);
table('ellipsis not when uncut', 'hi', [[0, 100, { ellipsis: E }, 'hi'], [-100, undefined, { ellipsis: E }, 'hi']]);
// Trailing zero-width clusters at the end boundary are not a cut.
for (const [input, a, b, ell, want] of [
  ['abcX', 0, 4, E, 'abcX'], ['abcX\n', 0, 4, E, 'abcX'], ['abcX\r\n', 0, 4, E, 'abcX'], ['abcX\t', 0, 4, E, 'abcX'],
  ['abcX\n\n\n', 0, 4, E, 'abcX'], ['\u0416\u0417\u0418\u041A\n', 0, 4, E, '\u0416\u0417\u0418\u041A'],
  ['\u0416\u0417\u0418\n', 0, 3, '>>', '\u0416\u0417\u0418'], ['ab\u6F22\n', 0, 4, E, 'ab\u6F22'], ['hi\n', 0, 2, '>>', 'hi'],
  ['\u0416\u0417\n', 0, 2, '>>', '\u0416\u0417'], ['h\n', 0, 1, E, 'h'], ['a\n', -1, undefined, '>>', 'a\n'],
  ['\x1b[0mabcX\n', 0, 4, E, 'abcX'],
  // Visible content after the zero-width tail IS a cut.
  ['abcX\nY', 0, 4, E, 'abc' + E], ['abcX\n\nY', 0, 4, E, 'abc' + E], ['\u0416\u0417\u0418\u041A\n\u041B', 0, 4, E, '\u0416\u0417\u0418' + E],
  ['\x1b[0mabcX\nY', 0, 4, E, 'abc' + E],
  // start > 0 with a zero-width tail: the speculative zone is kept.
  ['\u0416\u0417\u0418\u041A\u041B\n', 1, 5, E, E + '\u0418\u041A\u041B'], ['abcde\n', 1, 5, E, E + 'cde'],
  ['\x1b[0mabcde\n', 1, 5, E, E + 'cde'], ['\u0416\u0417\u0418\u041A\u041B\n\u041C', 1, 5, E, E + '\u0418\u041A' + E],
  ['\x1b[31m\u0416\u0417\u0418\u041A\x1b[0m', 0, 4, E, '\x1b[31m\u0416\u0417\u0418\u041A\x1b[0m'],
  ['\x1b[31m\u0416\u0417\u0418\u041A\n\x1b[0m', 0, 4, E, '\x1b[31m\u0416\u0417\u0418\u041A\x1b[0m'],
  ['\x1b[31m\u0416\u0417\u0418\u041A\x1b[39m\n', 0, 4, E, '\x1b[31m\u0416\u0417\u0418\u041A\x1b[39m'],
]) {
  eq(`ellipsis zero-width tail: sliceAnsi(${show(input)}, ${a}, ${b}, ${show(ell)})`, () => sliceAnsi(input, a, b, { ellipsis: ell }), want);
}
// A wide cluster overflowing the end at EOF is a cut (lazy path).
for (const [input, a, b, ell, want] of [
  ['ab\u6F22', 0, 3, E, 'ab' + E], ['abc\u6F22', 0, 4, E, 'abc' + E], ['\u6F22\u6F22', 0, 3, E, '\u6F22' + E],
  ['ab\u6F22\u6F22', 0, 5, E, 'ab\u6F22' + E], ['abcd\u6F22', 0, 5, '>>', 'abc>>'],
  [`${RED}ab\u6F22`, 0, 3, E, `${RED}ab${E}${FG_OFF}`], [`${RED}ab\u6F22${FG_OFF}`, 0, 3, E, `${RED}ab${E}${FG_OFF}`],
  [`${RED}ab\u6F22${FG_OFF}x`, 0, 3, E, `${RED}ab${E}${FG_OFF}`], [`${RED}ab\u6F22\x1b[0m`, 0, 3, E, `${RED}ab${E}${FG_OFF}`],
  [`${RED}ab\u6F22${FG_OFF}xy`, 0, 4, E, `${RED}ab\u6F22${FG_OFF}${E}`],
  ['xyab\u6F22', 2, 5, E, E + 'b' + E], ['xyab\u6F22', 2, 6, E, E + 'b\u6F22'],
  ['ab\u6F22', 0, 4, E, 'ab\u6F22'], ['a\u6F22', 0, 3, E, 'a\u6F22'], ['a\u6F22b', 0, 4, E, 'a\u6F22b'], ['abcd\u6F22', 0, 6, '>>', 'abcd\u6F22'],
]) {
  eq(`ellipsis wide overflow: sliceAnsi(${show(input)}, ${a}, ${b}, ${show(ell)})`, () => sliceAnsi(input, a, b, { ellipsis: ell }), want);
}
eq('ellipsis lazy == known path (negative end)', () => sliceAnsi('ab\u6F22', 0, -1, { ellipsis: E }), 'ab' + E);
eq('ellipsis lazy == known path (start cut)', () => sliceAnsi('xyab\u6F22', 2, -1, { ellipsis: E }), E + 'b' + E);
eq('ellipsis lazy == known path (styled)', () => sliceAnsi(`${RED}ab\u6F22${FG_OFF}x`, 0, -2, { ellipsis: E }), `${RED}ab${E}${FG_OFF}`);
// Degenerate ranges return the bare ellipsis.
for (const [input, a, b, ell, want] of [
  ['\u0416\u0417\u0418', 1, 4, null, '\u0417\u0418'], ['\u0416\u0417\u0418', 1, 4, '>>', '>>'], ['\u0416\u0417\u0418', 2, 5, '>>', '>>'],
  ['abc', 1, 4, '>>', '>>'], ['\u0416\u0417\u0418', -2, undefined, '>>', '>>'],
  ['\u0416\u0417\u0418', 3, 6, '>>', ''], ['\u0416', 1, 2, '>>', ''],
  ['abc', 0, 1, '>>', '>>'], ['\u0416\u0417\u0418', 0, 1, '>>', '>>'], ['abc', 0, 2, '>>', '>>'], ['\u0416\u0417\u0418', 0, 2, '>>', '>>'],
  ['\x1b[0mabc', 0, 1, '>>', '>>'],
  ['abc', 1, 3, '>>', '>>'], ['\u0416\u0417\u0418', 1, 3, '>>', '>>'], ['\u0416\u0417', 1, 2, '>>', '>>'], ['ab', 1, 2, '>>', '>>'],
  ['abc', 1, 2, '>>', '>>'], ['\u0416\u0417\u0418', 1, 2, '>>', '>>'], ['\u0416\u0417\n', 1, 2, '>>', '>>'],
  ['a\t', 1, 3, null, '\t'], ['a\t', 1, 3, E, E], ['a\x1b[31m\t', 1, 3, E, E], ['\u0416\t', 1, 3, E, E], ['a\n', 1, 3, E, E],
  ['ab\t', 2, 4, E, E], ['\u0416\u0417\t', 2, 4, E, E], ['a\t\t', 1, 3, E, E],
  ['\u0416\t', 1, 2, '>>', '>>'], ['a\t', 1, 2, '>>', '>>'], ['a\x1b[31m\t', 1, 3, '>>', '>>'], ['a\t\t', 1, 2, '>>', '>>'],
  ['\u0416', 1, 3, E, ''], ['\u0416\x1b[31m', 1, 3, E, ''], ['\u0416\x1b[31m', 1, 2, '>>', ''],
  ['\u0416', 0, 1, '>>', '\u0416'], ['\u0416\n', 0, 1, '>>', '\u0416'], ['\u0416\r\n', 0, 1, '>>', '\u0416'], ['a', 0, 1, '>>', 'a'],
  ['a\n', 0, 1, '>>', 'a'], ['\u0416\u0417', 0, 2, '>>', '\u0416\u0417'], ['\u0416\u0417\n', 0, 2, '>>', '\u0416\u0417'],
]) {
  eq(`ellipsis degenerate: sliceAnsi(${show(input)}, ${a}, ${b}, ${show(ell)})`,
    () => (ell === null ? sliceAnsi(input, a, b) : sliceAnsi(input, a, b, { ellipsis: ell })), want);
}
// Trailing ANSI after kept speculative-zone content keeps input order.
eq('zone kept, trailing close after it', () => sliceAnsi(`${RED}abcd${FG_OFF}`, 0, 4, { ellipsis: E }), `${RED}abcd${FG_OFF}`);
eq('zone kept, multi-column ellipsis', () => sliceAnsi(`${RED}abcd${FG_OFF}`, 0, 4, { ellipsis: '...' }), `${RED}abcd${FG_OFF}`);
eq('zone kept, SGR change inside the zone', () => sliceAnsi(`${RED}abcde${GREEN}fg${FG_OFF}`, 0, 7, { ellipsis: '...' }), `${RED}abcde${GREEN}fg${FG_OFF}`);
eq('zone kept, hyperlink close after it', () => sliceAnsi(link('abcd', 'http://x'), 0, 4, { ellipsis: E }), link('abcd', 'http://x'));
eq('zone kept, UTF-16 path', () => sliceAnsi(`\u5B89${RED}bcd${FG_OFF}`, 0, 5, { ellipsis: E }), `\u5B89${RED}bcd${FG_OFF}`);
// SGR and hyperlink state that only applied to discarded zone content is dropped.
{
  const text = `${RED}abcde${GREEN}fghijk${FG_OFF}`;
  eq('zone discarded: its SGR does not leak (lazy)', () => sliceAnsi(text, 0, 7, { ellipsis: '...' }), `${RED}abcd...${FG_OFF}`);
  eq('zone discarded: its SGR does not leak (known)', () => sliceAnsi(text, -11, -4, { ellipsis: '...' }), `${RED}abcd...${FG_OFF}`);
  const multi = `${RED}${BOLD}abcde\x1b[0mfghij`;
  eq('zone discarded: reset inside it restores every slot (lazy)', () => sliceAnsi(multi, 0, 7, { ellipsis: '...' }), `${RED}${BOLD}abcd...\x1b[22m${FG_OFF}`);
  eq('zone discarded: reset inside it restores every slot (known)', () => sliceAnsi(multi, -10, -3, { ellipsis: '...' }), `${RED}${BOLD}abcd...\x1b[22m${FG_OFF}`);
  eq('zone discarded: hyperlink opened inside it leaves nothing', () => sliceAnsi(`abcde${link('fghij', 'http://x')}`, 0, 7, { ellipsis: '...' }), 'abcd...');
  eq('zone discarded: hyperlink closed inside it is re-closed', () => sliceAnsi(`${link('abcde', 'http://x')}fghij`, 0, 7, { ellipsis: '...' }), `${link('abcd', 'http://x')}...`);
}

// ============================================================================
// 9. Options plumbing (Bun suite "ambiguousIsNarrow option", narrow half)
// ============================================================================
table('ambiguousIsNarrow true is the default', '\u03B1\u03B2\u03B3\u03B4\u03B5', [
  [0, 3, '\u03B1\u03B2\u03B3'], [0, 3, { ambiguousIsNarrow: true }, '\u03B1\u03B2\u03B3'], [0, 2, true, '\u03B1\u03B2'],
]);
eq('ambiguousIsNarrow as 5th arg next to a string ellipsis', () => sliceAnsi('\u03B1\u03B2\u03B3\u03B4\u03B5', 0, 4, E, true), '\u03B1\u03B2\u03B3' + E);
check('ambiguousIsNarrow: full narrow width returns the whole string', () => sliceAnsi('\u03B1\u03B2\u03B3', 0, stringWidth('\u03B1\u03B2\u03B3'), { ambiguousIsNarrow: true }) === '\u03B1\u03B2\u03B3');
check('ambiguousIsNarrow with ANSI', () => visible(sliceAnsi('\x1b[31m\u03B1\u03B2\u03B3\x1b[39m', 0, 2, { ambiguousIsNarrow: true })) === '\u03B1\u03B2');
eq('options: a non-string ellipsis is ignored', () => sliceAnsi('unicorn', 0, 4, { ellipsis: 42 }), 'unic');
// Bun reads both option keys, so a throwing getter propagates (Bun's fuzz suite).
check('options: a throwing ambiguousIsNarrow getter propagates', () => {
  try {
    sliceAnsi('hello', 0, 3, { get ambiguousIsNarrow() { throw new Error('boom'); } });
  } catch (err) {
    return err.message === 'boom' || err.message;
  }
  return 'did not throw';
});
eq('options: state is intact after a throwing getter', () => sliceAnsi('hello', 0, 3), 'hel');

// ============================================================================
// 10. The 2.1.271 call-site shapes
// ============================================================================
// (a) truncate helper and (b) clip path: slice [a, b), then shrink b one column
// at a time while the measured width exceeds b - a. With slicing and measuring
// agreeing on every cluster's width, that loop must end with a result that
// fits, and every style the slice opened must be closed again (no bleed into
// the next cell). Styles are tracked here by their close code, independently
// of the shim's own bookkeeping.
const fitSlice = (s, a, b) => {
  let out = sliceAnsi(s, a, b);
  while (b > a && stringWidth(out) > b - a) { b--; out = sliceAnsi(s, a, b); }
  return out;
};
const CLOSE_OF = (code) => {
  if (code === 1 || code === 2) return 22;
  if (code === 3) return 23;
  if (code === 4) return 24;
  if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) return 39;
  if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) return 49;
  return 0;
};
const styleBalanced = (s) => {
  const open = new Set();
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const params = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < params.length; i++) {
      const c = params[i];
      if (c === 0) open.clear();
      else if ([22, 23, 24, 39, 49].includes(c)) open.delete(c);
      else {
        if (c === 38 || c === 48) i += params[i + 1] === 5 ? 2 : params[i + 1] === 2 ? 4 : 0;
        open.add(CLOSE_OF(c));
      }
    }
  }
  return open.size === 0;
};
const SHAPES = [
  '\x1b[1m\x1b[36m\u250C\u2500 src/\u6F22\u5B57/\u30D5\u30A1\u30A4\u30EB.ts \u2500\u2510\x1b[39m\x1b[22m',
  '\x1b[32m✓\x1b[39m \u{1F44B} caf\u00E9 na\u0131\u0308ve \u4F60\u597D \x1b[2m(more below)\x1b[22m',
  `\x1b[31m${link('\u6F22\u5B57 link', 'https://example.com')} tail\x1b[39m`,
];
for (const s of SHAPES) {
  const total = stringWidth(s);
  check(`call site: shrink-to-fit fits and closes its styles: ${show(s)}`, () => {
    for (let a = 0; a <= total; a++) {
      for (let b = a; b <= total + 1; b++) {
        const out = fitSlice(s, a, b);
        if (stringWidth(out) > Math.max(0, b - a)) return `width [${a},${b}) = ${stringWidth(out)}`;
        if (!styleBalanced(out)) return `unbalanced styles for [${a},${b}): ${show(out)}`;
      }
    }
    return true;
  });
  // (c) collapsed-output wrapper: fixed-width chunks over one line must cover
  // it exactly, each cluster in the one chunk whose range holds its start
  // column: nothing lost at a wide-character boundary, nothing doubled.
  check(`call site: fixed-width chunks cover the line exactly: ${show(s)}`, () => {
    for (let w = 1; w <= 7; w++) {
      let joined = '';
      for (let a = 0; a < total; a += w) joined += visible(sliceAnsi(s, a, a + w));
      if (joined !== visible(s)) return `chunk width ${w}: ${show(joined)}`;
    }
    return true;
  });
}

// ============================================================================
// 11. Bounded work: a slice near the start of a huge line must not segment or
//     measure the whole line. The renderer's clip path can see multi-MB lines
//     (tool output), and the same shape froze Ink rendering on this hardware
//     before the stringWidth fast path existed.
// ============================================================================
{
  const log = { widthCalls: 0, longestSegmented: 0 };
  const spyWidth = (s) => { log.widthCalls++; return stringWidth(s); };
  class SpySegmenter extends Intl.Segmenter {
    segment(str) { log.longestSegmented = Math.max(log.longestSegmented, str.length); return super.segment(str); }
  }
  const spiedSlice = new Function('_bunShim_stringWidth', 'Intl',
    `${sliceBlock}\nreturn _bunShim_sliceAnsi;`)(spyWidth, { Segmenter: SpySegmenter });
  // 400k distinct-ish CJK code points (more than any memo holds), colored so
  // neither ASCII fast path applies.
  let body = '';
  for (let i = 0; i < 400000; i++) body += String.fromCharCode(0x4E00 + (i % 20000));
  const huge = `\x1b[31m${body}\x1b[39m`;
  eq('bounded work: result', () => spiedSlice(huge, 0, 10), `\x1b[31m${body.slice(0, 5)}\x1b[39m`);
  check('bounded work: widths measured only near the slice', () => log.widthCalls <= 200 || log.widthCalls);
  // A joiner up front routes the same line through Intl.Segmenter, which may
  // then see only a window of it (and must have run at all).
  const joined = `\x1b[31me\u0301${body}\x1b[39m`;
  eq('bounded work: result (segmenter path)', () => spiedSlice(joined, 0, 10), `\x1b[31me\u0301${body.slice(0, 5)}\x1b[39m`);
  check('bounded work: segmenter saw only a window of the line',
    () => (log.longestSegmented > 0 && log.longestSegmented <= 4096) || log.longestSegmented);
}

// ============================================================================
// 12. The segmenter shortcut. Visible text without any character that can
//     join a neighbor into one cluster is cut per code point, without
//     Intl.Segmenter (the dominant per-call cost on typical UI lines). That is
//     only sound while _SA_JOINER covers every such character of the running
//     ICU, so the screen is verified here against Intl.Segmenter itself, over
//     every assigned code point: a Node upgrade that brings new Unicode joiners
//     (Unicode 16 added the Prepend U+113D1) turns this red instead of letting
//     clusters split silently.
// ============================================================================
{
  let segmentCalls = 0;
  class CountingSegmenter extends Intl.Segmenter {
    segment(str) { segmentCalls++; return super.segment(str); }
  }
  const countedSlice = new Function('_bunShim_stringWidth', 'Intl',
    `${sliceBlock}\nreturn _bunShim_sliceAnsi;`)(stringWidth, { Segmenter: CountingSegmenter });
  const simple = '\x1b[2m\u2502\x1b[22m \u4F60\u597D \u{1F44B} caf\u00E9 \u2500\u2500 \u00A7 …';
  eq('shortcut: simple text still slices by column', () => countedSlice(simple, 0, 9), '\x1b[2m\u2502\x1b[22m \u4F60\u597D \u{1F44B}');
  check('shortcut: no segmenter call for text without joiners', () => segmentCalls === 0 || segmentCalls);
  eq('shortcut: a combining mark still gets real clusters', () => countedSlice('\x1b[1mAe\u0301B', 1, 2), '\x1b[1me\u0301\x1b[22m');
  check('shortcut: text with a joiner goes through the segmenter', () => segmentCalls > 0 || segmentCalls);
}
check('shortcut: _SA_JOINER covers every joiner of this ICU (assigned code points)', () => {
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const assigned = /\p{Assigned}/u;
  const parts = [];
  for (let cp = 0x80; cp <= 0x10ffff; cp++) {
    if (cp === 0xd800) cp = 0xe000; // skip surrogates
    const ch = String.fromCodePoint(cp);
    if (assigned.test(ch) && !JOINER.test(ch)) parts.push('a', ch);
  }
  // Separated by 'a', each candidate must come out as a cluster of its own:
  // nothing joins it to the 'a' before it (Extend, SpacingMark, ...) or after
  // it (Prepend).
  const missed = [];
  for (const { segment } of seg.segment(parts.join(''))) {
    if (segment.length > 2 || (segment.length === 2 && segment.codePointAt(0) <= 0xffff)) {
      missed.push([...segment].map((c) => c.codePointAt(0).toString(16)).join('+'));
    }
  }
  return missed.length === 0 || `joins outside _SA_JOINER: ${missed.slice(0, 20).join(' ')}`;
});

// ============================================================================
// KNOWN LIMITS (deliberate deviations from real Bun, pinned so they stay
// visible instead of being rediscovered)
// ============================================================================
// 1. Cluster widths come from the Bun.stringWidth shim (string-width@4), not
//    from Bun's own tables, so slicing and measuring agree inside this
//    process, which is what the call sites' shrink-to-fit loops rely on. Where
//    string-width@4 disagrees with Bun, sliceAnsi follows string-width@4:
//    U+200B counts 1 column (Bun: 0), a lone regional indicator counts 2
//    (Bun: 1).
check('KNOWN LIMIT: stringWidth shim counts U+200B as 1', () => stringWidth('\u200B') === 1);
eq('KNOWN LIMIT: so a trailing U+200B is a column of its own (Bun: "b\\u200b")', () => sliceAnsi('ab\u200B', -1), '\u200B');
eq('KNOWN LIMIT: a lone regional indicator is 2 columns wide (Bun: "B")', () => sliceAnsi('A\u{1F1E6}B', 2, 3), '');
//    The delegate also counts ZWJ and variation selectors as a column each,
//    so a cluster can measure wider than 2 (R + VS15 + ZWJ = 3; Bun: 1). The
//    overhang at `end` can then exceed Bun's one column; the call sites'
//    shrink loops still converge, since they measure with the same widths.
check('KNOWN LIMIT: stringWidth shim counts R+VS15+ZWJ as 3', () => stringWidth('R\uFE0E\u200D') === 3);
eq('KNOWN LIMIT: so "c" starts at column 5 (Bun: "cd")', () => sliceAnsi('abR\uFE0E\u200Dcd', 3, 6), 'c');
eq('KNOWN LIMIT: and the overhang past end is 2 columns', () => stringWidth(sliceAnsi('abR\uFE0E\u200Dcd', 0, 3)), 5);
// 2. ambiguousIsNarrow:false is accepted but has no effect, for the same
//    reason: the stringWidth delegate has no ambiguous-wide mode, and the
//    bundle's sites pass ambiguousIsNarrow:true (or nothing) anyway.
eq('KNOWN LIMIT: ambiguousIsNarrow:false is ignored (Bun: "\\u03b1")', () => sliceAnsi('\u03B1\u03B2\u03B3\u03B4\u03B5', 0, 2, { ambiguousIsNarrow: false }), '\u03B1\u03B2');
eq('KNOWN LIMIT: boolean false 4th arg is ignored (Bun: "\\u03b1")', () => sliceAnsi('\u03B1\u03B2\u03B3', 0, 2, false), '\u03B1\u03B2');

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`sliceAnsi shim: ${failures.length} FAILED, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ sliceAnsi shim: ${pass} checks passed`);
