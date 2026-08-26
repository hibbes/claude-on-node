#!/usr/bin/env node
// Unit suite for extract-modulegraph.py.  Run with `npm test`.
//
// The extractor parses a binary table whose format Anthropic never documented;
// this suite pins the layout it was reverse-engineered against (2.1.245) with
// synthetic sections built here, so a change in the parser's offset arithmetic
// fails on a 300-byte fixture instead of on the next 300 MB release. Every
// negative case is a format violation the real dump could develop overnight
// (see update.sh: the nightly dies on exit 2 and keeps the live release).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'extract-modulegraph.py');
const TRAILER = Buffer.from('\n---- Bun! ----\n');
const ENTRY_SIZE = 52;

let pass = 0;
const failures = [];
const check = (name, cond) => { if (cond === true) pass++; else failures.push(name); };

// Build a .bun section: 8-byte header, payload (names + bodies), module table,
// 64 trailer words, trailer string. All pointers relative to byte 8.
function buildSection(modules, { entryIndex = 0, mutate } = {}) {
  const payload = [];
  let off = 0;
  const put = (buf) => { const at = off; payload.push(buf); off += buf.length; return at; };
  const entries = modules.map((m) => {
    const name = Buffer.from(m.name, 'utf8');
    const body = Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body, 'utf8');
    return { nOff: put(name), nLen: name.length, cOff: put(body), cLen: body.length,
             flags: m.flags !== undefined ? m.flags : 0x10101 };
  });
  const table = Buffer.alloc(entries.length * ENTRY_SIZE);
  entries.forEach((e, i) => {
    const b = i * ENTRY_SIZE;
    table.writeUInt32LE(e.nOff, b); table.writeUInt32LE(e.nLen, b + 4);
    table.writeUInt32LE(e.cOff, b + 8); table.writeUInt32LE(e.cLen, b + 12);
    table.writeUInt32LE(e.flags, b + 48);       // word [12]: loader in byte 1
  });
  const tableOff = put(table);
  const words = Buffer.alloc(64);
  words.writeUInt32LE(tableOff, 40);      // [10] table offset
  words.writeUInt32LE(table.length, 44);  // [11] table byte length
  words.writeUInt32LE(entryIndex, 48);    // [12] entry point index
  put(words);
  put(TRAILER);
  const header = Buffer.alloc(8);
  header.writeBigUInt64LE(BigInt(off));
  let section = Buffer.concat([header, ...payload]);
  if (mutate) section = mutate(section, { tableOff: 8 + tableOff, tableLen: table.length, entries });
  return section;
}

const run = (section, extra = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-test-'));
  const bun = path.join(dir, 'claude.bun');
  fs.writeFileSync(bun, section);
  const out = path.join(dir, 'modules');
  const concat = path.join(dir, 'audit.js');
  const r = spawnSync('python3', [SCRIPT, bun, '--out', out, '--audit-concat', concat, ...extra],
    { encoding: 'utf8', timeout: 20000 });
  return { r, dir, out, concat, index: path.join(out, '_index.json') };
};

const JS = (rest) => `// @bun @bytecode\n// header\n${rest}`;
const GOOD = [
  { name: '/$bunfs/root/cli', body: JS('import "/$bunfs/root/chunk-a.js";') },
  { name: '/$bunfs/root/chunk-a.js', body: JS('export const a=1;') },
  { name: '/$bunfs/root/x.asset', body: '<!doctype html>', flags: 0x1000500 },
  { name: '/$bunfs/root/sub/dir.js', body: JS('export const d=2;') },
  { name: '/$bunfs/root/nat.node', body: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]), flags: 0x1000a00 },
  { name: '/$bunfs/root/prompt.md', body: '# Autonomous loop check', flags: 0x1000d01 },
  { name: '/$bunfs/root/odd.bin', body: 'x', flags: 0x1006300 },
];

// --- 1. happy path -------------------------------------------------------------
{
  const { r, out, concat, index } = run(buildSection(GOOD), ['--version', '9.9.9']);
  check('exit 0 on a well-formed section', r.status === 0);
  check('summary names the entry', /entry \/\$bunfs\/root\/cli/.test(r.stdout));
  const idx = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : null;
  check('_index.json written', idx !== null);
  check('manifest format is 1', idx && idx.format === 1);
  check('manifest records --version', idx && idx.version === '9.9.9');
  check('manifest entry is the table entry point', idx && idx.entry === '/$bunfs/root/cli' && idx.entry_index === 0);
  check('manifest lists every module', idx && idx.modules.length === GOOD.length);
  // Every lookup below tolerates a missing manifest or entry: a broken
  // extractor must fail these checks by name, not crash the suite.
  const byPath = idx ? Object.fromEntries(idx.modules.map((m) => [m.path, m])) : {};
  const at = (p) => byPath[p] || {};
  check('JS modules flagged js', at('/$bunfs/root/cli').js === true && at('/$bunfs/root/chunk-a.js').js === true);
  check('asset and addon flagged non-js', at('/$bunfs/root/x.asset').js === false && at('/$bunfs/root/nat.node').js === false);
  check('slash in a name flattens to __', at('/$bunfs/root/sub/dir.js').file === 'sub__dir.js');
  check('bytes recorded per module', at('/$bunfs/root/x.asset').bytes === Buffer.byteLength('<!doctype html>'));
  check('loader byte decoded: js', at('/$bunfs/root/cli').loader === 'js' && at('/$bunfs/root/chunk-a.js').loader === 'js');
  check('loader byte decoded: file', at('/$bunfs/root/x.asset').loader === 'file');
  check('loader byte decoded: napi', at('/$bunfs/root/nat.node').loader === 'napi');
  check('loader byte decoded: text', at('/$bunfs/root/prompt.md').loader === 'text');
  check('unknown loader id recorded numerically', at('/$bunfs/root/odd.bin').loader === 0x63);
  for (const m of GOOD) {
    const f = at(m.name).file ? path.join(out, at(m.name).file) : null;
    const want = Buffer.isBuffer(m.body) ? m.body : Buffer.from(m.body);
    check(`content byte-exact: ${m.name}`, f !== null && fs.existsSync(f) && fs.readFileSync(f).equals(want));
  }
  const cat = fs.existsSync(concat) ? fs.readFileSync(concat, 'utf8') : '';
  check('audit concat holds JS sources in table order',
    cat.indexOf('import "/$bunfs/root/chunk-a.js"') < cat.indexOf('export const a=1') &&
    cat.indexOf('export const a=1') < cat.indexOf('export const d=2'));
  check('audit concat excludes assets', !cat.includes('<!doctype html>'));
}

// --- 2. entry index selects the entry --------------------------------------
{
  const { r, index } = run(buildSection(GOOD, { entryIndex: 3 }));
  const idx = r.status === 0 ? JSON.parse(fs.readFileSync(index, 'utf8')) : null;
  check('entry follows the trailer word, not position 0', idx && idx.entry === '/$bunfs/root/sub/dir.js' && idx.entry_index === 3);
}

// --- 3. format violations exit 2 and write no manifest ----------------------
const violation = (name, section) => {
  const { r, index } = run(section);
  check(`${name}: exit 2`, r.status === 2);
  check(`${name}: reason on stderr`, /extract-modulegraph:/.test(r.stderr));
  check(`${name}: no manifest`, !fs.existsSync(index));
};
violation('header byte count off by one', buildSection(GOOD, {
  mutate: (s) => { s.writeBigUInt64LE(s.readBigUInt64LE(0) + 1n, 0); return s; },
}));
violation('missing trailer', buildSection(GOOD, { mutate: (s) => s.subarray(0, s.length - 1) }));
violation('table length not a multiple of 52', buildSection(GOOD, {
  mutate: (s) => { s.writeUInt32LE(GOOD.length * ENTRY_SIZE - 4, s.length - TRAILER.length - 64 + 44); return s; },
}));
violation('entry index out of range', buildSection(GOOD, { entryIndex: GOOD.length }));
violation('module name outside /$bunfs/root/', buildSection(
  [{ name: '/tmp/evil.js', body: JS('') }, ...GOOD.slice(1)],
));
violation('entry point is not a JS module', buildSection(GOOD, { entryIndex: 2 }));
violation('string pointer past the trailer', buildSection(GOOD, {
  mutate: (s, { tableOff }) => { s.writeUInt32LE(0x7fffffff, tableOff + 8); return s; },
}));

// --- report -------------------------------------------------------------------
if (failures.length) {
  console.error(`\n${failures.length}/${pass + failures.length} FAILED:`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`✓ ${pass}/${pass} extract-modulegraph tests passed`);
