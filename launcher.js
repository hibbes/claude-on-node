#!/usr/bin/env node
// Run Claude Code 2.1.215's JS bundle under Node (no Bun needed).
// The bundle is a CJS IIFE expression: (function(exports,require,module,__filename,__dirname){...})
// Node doesn't auto-invoke it, so we read + eval + call with module context.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');

// Force system /usr/bin/rg — the bundle's default path resolution ends up at
// a build-time-baked /home/runner/work/... path that doesn't exist here.
// USE_BUILTIN_RIPGREP uses explicit-disable semantics: "0" / "false" / "no" / "off"
// triggers the system-rg lookup via `which`.
if (process.env.USE_BUILTIN_RIPGREP === undefined) process.env.USE_BUILTIN_RIPGREP = '0';

// The bundle contains `using` declarations (Explicit Resource Management).
// V8 only parses that form from Node 24 onwards, and it is not gated to any
// particular scope: on older Node the whole bundle fails, even though `using`
// sits inside the wrapper function. The eval below then reports the minified
// variable name of the first such declaration and nothing else, e.g.
// "SyntaxError: Unexpected identifier 'K'" (issue #1). Measured against
// bundle 2.1.212: 20.20.2, 22.23.1 and 23.11.1 all fail, 24.0.0 (V8 13.6.233.8)
// and later parse. Note that Anthropic's own package declares node >=22.0.0,
// which covers their native binary, not running the bundle under Node.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 24) {
  console.error(
    `claude-on-node requires Node 24 or newer, found ${process.version}.\n` +
    "The Claude Code bundle uses `using` declarations, which V8 does not parse\n" +
    'before Node 24. Running it here fails with a SyntaxError naming a minified\n' +
    'variable. Anthropic\'s own "node >=22" applies to their native binary, not\n' +
    'to running the bundle under Node.',
  );
  process.exit(1);
}

const bundlePath = path.join(__dirname, 'bundle.js');
let src = fs.readFileSync(bundlePath, 'utf8');

// --- Bun shim ---------------------------------------------------------------
// v128 inlined a wave of `function w8(H){return Bun.X(H,...)}` minifier-extracted
// thunks with NO `typeof Bun` guard. They throw ReferenceError under Node the
// moment any caller dereferences them. Earlier releases routed everything
// through guarded init expressions, so the v126-era allowlist wrongly assumed
// "any guarded site → safe to skip"; v128 broke that assumption.
//
// Defining globalThis.Bun is not viable: it would flip ~20 existing
// `typeof Bun<"u"` guards from false to true and break their Node fallbacks.
// Instead we source-replace every Bun.<symbol> we shim and route them to
// Node-equivalent implementations. Strategy by symbol:
//
//   Real impl (npm/built-in):
//     Bun.YAML.{parse,stringify}    -> yaml package
//     Bun.TOML.parse                -> smol-toml (lazy; dates -> source-text strings)
//     Bun.semver.{order,satisfies}  -> semver package
//     Bun.Terminal + Bun.spawn(opts.terminal:T) -> node-pty
//     Bun.stringWidth               -> string-width@4
//     Bun.stripANSI                 -> strip-ansi@6
//     Bun.wrapAnsi                  -> wrap-ansi@7
//     Bun.which                     -> which@3
//     Bun.hash                      -> 64-bit FNV-1a (BigInt; matches .toString() shape)
//     Bun.deepEquals                -> hand-rolled deep-equality (Bun expect().toEqual non-strict)
//     Bun.file                      -> lazy fs-backed BunFile subset (Blob subclass)
//
//   Inert / disabled (Node code path doesn't depend on these):
//     Bun.gc                        -> no-op
//     Bun.embeddedFiles             -> [] (mz() returns false → embedded mode off)
//     Bun.JSONL                     -> undefined (Bun.JSONL?.parseChunk → undefined)
//     Bun.isStandaloneExecutable    -> false (running under Node, not a compiled Bun SFE)
//
//   Throws on first use (rare paths: REPL, heap-dump, agent-proxy relay, gateway):
//     Bun.generateHeapSnapshot, Bun.Transpiler, Bun.listen, Bun.serve, Bun.connect
const bundleRequire = Module.createRequire(bundlePath);
const yamlMod = bundleRequire('yaml');
const semverMod = bundleRequire('semver');
const stringWidthMod = bundleRequire('string-width');
const stripAnsiMod = bundleRequire('strip-ansi');
const wrapAnsiMod = bundleRequire('wrap-ansi');
const whichMod = bundleRequire('which');

const signalNumberToName = (n) => {
  if (n == null) return undefined;
  if (typeof n === 'string') return n.startsWith('SIG') ? n : `SIG${n}`;
  for (const [name, num] of Object.entries(os.constants.signals || {})) {
    if (num === n) return name;
  }
  return undefined;
};

class _BunTerminalShim {
  constructor({ cols, rows, data } = {}) {
    this.cols = Number(cols) || 80;
    this.rows = Number(rows) || 24;
    this._dataCb = typeof data === 'function' ? data : null;
    this._pty = null;
    this.__isBunTerminalShim = true;
  }
  resize(cols, rows) {
    this.cols = Number(cols) || this.cols;
    this.rows = Number(rows) || this.rows;
    if (this._pty) {
      try { this._pty.resize(this.cols, this.rows); } catch (_) {}
    }
  }
  write(chunk) {
    if (!this._pty) return;
    const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8')
            : (chunk instanceof Uint8Array) ? Buffer.from(chunk).toString('utf8')
            : String(chunk);
    try { this._pty.write(s); } catch (_) {}
  }
  close() {
    if (this._pty) {
      try { this._pty.kill(); } catch (_) {}
      this._pty = null;
    }
  }
  _attach(pty) {
    this._pty = pty;
    if (this._dataCb) {
      pty.onData((d) => {
        try { this._dataCb('stdout', Buffer.from(d, 'utf8')); } catch (_) {}
      });
    }
  }
}

const _bunShim_spawn = (argv, opts = {}) => {
  if (opts && opts.terminal && opts.terminal.__isBunTerminalShim) {
    const term = opts.terminal;
    const ptyMod = bundleRequire('node-pty');
    const [file, ...args] = argv;
    const pty = ptyMod.spawn(file, args, {
      name: (opts.env && opts.env.TERM) || 'xterm-256color',
      cols: term.cols,
      rows: term.rows,
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      handleFlowControl: false,
    });
    term._attach(pty);
    let resolveExit;
    const exited = new Promise((res) => { resolveExit = res; });
    let signalCode;
    pty.onExit(({ exitCode, signal }) => {
      signalCode = signalNumberToName(signal);
      resolveExit(typeof exitCode === 'number' ? exitCode : 0);
    });
    return {
      get pid() { return pty.pid; },
      exited,
      get signalCode() { return signalCode; },
      kill(sig) {
        try { pty.kill(typeof sig === 'string' ? sig : 'SIGTERM'); } catch (_) {}
      },
    };
  }
  throw new Error('Bun.spawn called under Node without PTY shim (unexpected non-PTY call site)');
};

// FNV-1a 64-bit. Matches Bun.hash's "numeric value with .toString()" surface
// used by the bundle for cache-key derivation. Stable + deterministic, that's all
// the bundle needs — exact algorithm parity with Wyhash isn't observable.
const _FNV_PRIME = 0x100000001b3n;
const _FNV_OFFSET = 0xcbf29ce484222325n;
const _bunShim_hash = (input, seed) => {
  let h;
  if (seed === undefined) h = _FNV_OFFSET;
  else if (typeof seed === 'bigint') h = BigInt.asUintN(64, seed);
  else h = BigInt.asUintN(64, BigInt(seed));
  let buf;
  if (typeof input === 'string') buf = Buffer.from(input, 'utf8');
  else if (Buffer.isBuffer(input)) buf = input;
  else if (input instanceof Uint8Array) buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  else buf = Buffer.from(String(input), 'utf8');
  for (let i = 0; i < buf.length; i++) {
    h = BigInt.asUintN(64, (h ^ BigInt(buf[i])) * _FNV_PRIME);
  }
  return h;
};

// Bun.deepEquals(a, b, strict=false): recursive structural equality.
// The 2.1.167 bundle's lone call site is non-strict, 2-arg — i.e. the same
// semantics as expect().toEqual(): undefined props + trailing/undefined array
// elements are ignored, prototypes are NOT compared, NaN===NaN. strict mode
// (expect().toStrictEqual()) additionally requires matching prototypes, exact
// key/length sets (undefined counts), and array sparseness. No Node built-in
// matches non-strict mode (util.isDeepStrictEqual is strict + Object.is), so we
// implement it directly. Spec: https://bun.com/docs/api/utils#bun-deepequals
const _bunShim_ownKeys = (o, strict) => {
  const keys = Object.keys(o);
  for (const s of Object.getOwnPropertySymbols(o)) {
    if (Object.prototype.propertyIsEnumerable.call(o, s)) keys.push(s);
  }
  return strict ? keys : keys.filter((k) => o[k] !== undefined);
};

const _bunShim_deepEquals = (a, b, strict = false) => {
  if (a === b) return true; // identity / same primitive (+0===-0); NaN handled below

  const ta = typeof a, tb = typeof b;
  if (ta !== 'object' || tb !== 'object' || a === null || b === null) {
    // at least one primitive/null — the only remaining equal case is NaN===NaN
    if (ta === 'number' && tb === 'number') return a !== a && b !== b;
    return false;
  }

  const sa = Object.prototype.toString.call(a);
  const sb = Object.prototype.toString.call(b);
  if (sa !== sb) return false;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  switch (sa) {
    case '[object Date]': {
      const va = a.getTime(), vb = b.getTime();
      return va === vb || (va !== va && vb !== vb);
    }
    case '[object RegExp]':
      return a.source === b.source && a.flags === b.flags;
    case '[object Number]':
    case '[object String]':
    case '[object Boolean]': {
      const va = a.valueOf(), vb = b.valueOf();
      return va === vb || (typeof va === 'number' && va !== va && vb !== vb);
    }
    case '[object ArrayBuffer]': {
      if (a.byteLength !== b.byteLength) return false;
      const ua = new Uint8Array(a), ub = new Uint8Array(b);
      for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
      return true;
    }
    case '[object DataView]': {
      if (a.byteLength !== b.byteLength) return false;
      for (let i = 0; i < a.byteLength; i++) if (a.getUint8(i) !== b.getUint8(i)) return false;
      return true;
    }
    case '[object Map]': {
      if (a.size !== b.size) return false;
      const bEntries = [...b], used = new Array(bEntries.length).fill(false);
      for (const [ka, va] of a) {
        let found = false;
        for (let j = 0; j < bEntries.length; j++) {
          if (used[j]) continue;
          if (_bunShim_deepEquals(ka, bEntries[j][0], strict) &&
              _bunShim_deepEquals(va, bEntries[j][1], strict)) { used[j] = true; found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    }
    case '[object Set]': {
      if (a.size !== b.size) return false;
      const bVals = [...b], used = new Array(bVals.length).fill(false);
      for (const va of a) {
        let found = false;
        for (let j = 0; j < bVals.length; j++) {
          if (used[j]) continue;
          if (_bunShim_deepEquals(va, bVals[j], strict)) { used[j] = true; found = true; break; }
        }
        if (!found) return false;
      }
      return true;
    }
  }

  if (ArrayBuffer.isView(a)) { // typed arrays (DataView handled above)
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x !== y && !(typeof x === 'number' && x !== x && y !== y)) return false;
    }
    return true;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (strict && a.length !== b.length) return false;
    const len = a.length > b.length ? a.length : b.length;
    for (let i = 0; i < len; i++) {
      if (strict && (i in a) !== (i in b)) return false;
      if (!_bunShim_deepEquals(a[i], b[i], strict)) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  // plain objects / class instances
  const keysA = _bunShim_ownKeys(a, strict);
  const keysB = _bunShim_ownKeys(b, strict);
  if (keysA.length !== keysB.length) return false;
  const setB = new Set(keysB);
  for (const k of keysA) {
    if (!setB.has(k)) return false;
    if (!_bunShim_deepEquals(a[k], b[k], strict)) return false;
  }
  return true;
};

// --- Bun.file shim (lazy BunFile subset backed by Node fs) -------------------
// 2.1.201's sole call site is `Bun.file(<ptySock>.err)` as a spawn-stdio stderr
// target in the bg-pty-host spawner (a path our non-terminal Bun.spawn shim
// rejects anyway), so nothing consumes the object today. Still a REAL fs-backed
// implementation rather than a throws-stub: once a symbol is in SHIMMED_BUN the
// audit stops flagging its new call sites, and Bun.file is Bun's most central
// file API; future releases will grow more sites (.text()/.json()/.exists()
// reads), which should then just work under Node. Calibrated to the BunFile
// docs (bun.com/docs/api/file-io); unverifiable against real Bun on this box
// (Bun SIGILLs here, the reason this project exists). Unit suite:
// bunfile-shim.test.js extracts this block by its BEGIN/END markers and evals
// it, so the tested code is the shipped code.
const _bunShim_fileMime = {
  '.json': 'application/json;charset=utf-8',
  '.txt': 'text/plain;charset=utf-8',
  '.md': 'text/markdown;charset=utf-8',
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.mjs': 'text/javascript;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
};

// Bun echoes an explicitly passed type back WITH a charset appended:
//   Bun.file("notreal.json", { type: "application/json" }).type
//     -> "application/json;charset=utf-8"          (bun.com/docs/api/file-io)
// Only text-ish types get one, mirroring the extension map above (image/png
// carries no charset there either). The text-ish set is inferred from that
// map, since the docs only spell out the JSON case.
const _bunShim_fileCharset = (type) => {
  const t = String(type);
  if (/;\s*charset=/i.test(t)) return t;
  const base = t.split(';')[0].trim().toLowerCase();
  const textish = base.startsWith('text/')
    || /^application\/(json|javascript|xml|xhtml\+xml)$/.test(base)
    || base === 'image/svg+xml';
  return textish ? `${t};charset=utf-8` : t;
};

class _BunFileShim extends Blob {
  constructor(pathOrFd, options) {
    super([]);
    if (typeof pathOrFd === 'number') {
      this._fd = pathOrFd; // no name/path: reads go through the fd
    } else {
      let p = pathOrFd;
      if (p instanceof URL || (typeof p === 'string' && p.startsWith('file://'))) {
        p = require('url').fileURLToPath(p);
      } else if (p instanceof Uint8Array) {
        p = Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('utf8');
      } else if (p instanceof ArrayBuffer) {
        p = Buffer.from(p).toString('utf8');
      } else if (typeof p !== 'string') {
        p = String(p);
      }
      this._path = p;
      this.name = p;
    }
    this._type = (options && options.type)
      ? _bunShim_fileCharset(options.type)
      : _bunShim_fileMime[path.extname(this._path || '').toLowerCase()]
        // Bun's documented default for an unknown/absent extension, NOT
        // application/octet-stream (bun.com/docs/api/file-io).
        || 'text/plain;charset=utf-8';
  }
  get type() { return this._type; }
  _stat() {
    try { return this._fd !== undefined ? fs.fstatSync(this._fd) : fs.statSync(this._path); }
    catch (_) { return null; }
  }
  get size() { const st = this._stat(); return st ? st.size : 0; }
  get lastModified() { const st = this._stat(); return st ? st.mtimeMs : 0; }
  // "Returns true for regular files and FIFOs. It returns false for
  // directories" (bun.com/reference/bun/BunFile/exists). statSync succeeds on a
  // directory, so that case needs calling out explicitly; !isDirectory() rather
  // than isFile() keeps FIFOs true as documented. Note that size/lastModified
  // deliberately still work on a directory, matching Bun (oven-sh/bun#21537).
  async exists() { const st = this._stat(); return st !== null && !st.isDirectory(); }
  _read() {
    if (this._fd !== undefined) {
      // Positioned read from 0: fs.readFileSync(fd) would consume the fd's
      // current offset and make a second read return ''.
      const size = fs.fstatSync(this._fd).size;
      const buf = Buffer.alloc(size);
      fs.readSync(this._fd, buf, 0, size, 0);
      return buf;
    }
    return fs.readFileSync(this._path);
  }
  async text() { return this._read().toString('utf8'); }
  async json() { return JSON.parse(this._read().toString('utf8')); }
  // Bun documents bytes() as "the same as new Uint8Array(await
  // blob.arrayBuffer())", i.e. byteOffset 0 and buffer.byteLength === size.
  // A bare view over the read buffer would NOT satisfy that: fs.readFileSync
  // serves files under 4 KiB out of Node's shared 8 KiB Buffer pool, so the
  // view's .buffer is the whole pool at a non-zero offset and exposes
  // unrelated bytes (including previously-read files) to anything touching
  // .buffer directly: new DataView(u8.buffer), Buffer.from(u8.buffer),
  // crypto.subtle.digest, structuredClone/postMessage transfer.
  async bytes() { return new Uint8Array(await this.arrayBuffer()); }
  async arrayBuffer() { const b = this._read(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
  stream() {
    const rs = this._fd !== undefined
      ? fs.createReadStream(null, { fd: this._fd, start: 0, autoClose: false })
      : fs.createReadStream(this._path);
    return require('stream').Readable.toWeb(rs);
  }
  slice() {
    // Blob.prototype.slice would silently hand back an EMPTY blob (super([])
    // holds no data). Fail loudly; implement lazily if a bundle ever calls it.
    throw new Error('BunFile.slice not supported under Node shim');
  }
  writer() {
    const ownFd = this._fd === undefined;
    const fd = ownFd ? fs.openSync(this._path, 'w') : this._fd;
    let open = true;
    return {
      write: (chunk) => {
        if (!open) return 0;
        const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8')
          : Buffer.isBuffer(chunk) ? chunk
          : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk instanceof ArrayBuffer ? Buffer.from(chunk)
          : Buffer.from(String(chunk), 'utf8');
        return fs.writeSync(fd, buf);
      },
      flush: () => 0, // write() above is synchronous and unbuffered
      end: () => {
        if (open && ownFd) { try { fs.closeSync(fd); } catch (_) {} }
        open = false;
        return 0;
      },
    };
  }
  async delete() { await fs.promises.unlink(this._path); }
  unlink() { return this.delete(); }
}
const _bunShim_file = (pathOrFd, options) => new _BunFileShim(pathOrFd, options);
// --- end Bun.file shim --------------------------------------------------------

// --- Bun.TOML shim (smol-toml, normalized to Bun's documented value shapes) ---
// 2.1.214's sole call site is `function mwy(e){return Bun.TOML.parse(e)}`, fed
// by the `claude import` migration path (~/.codex/config.toml and
// ~/.codex/prompts/*.toml, behind the `tengu_import` flag, default off). Both
// callers wrap it in try/catch, so a throws-stub would merely have degraded to
// "Could not read or parse. Review it manually." — but Bun.TOML is a
// config-format API, and once a symbol sits in SHIMMED_BUN the audit stops
// flagging its NEW call sites (same reasoning as the Bun.file shim above), so
// a real parser now beats a silent landmine later.
//
// smol-toml: TOML 1.0/1.1, zero dependencies, ships CJS. Calibrated against
// bun.com/docs/runtime/toml; verifying against real Bun is impossible on this
// box (Bun SIGILLs here — the reason this project exists). Two deliberate
// deviations, both toward accepting MORE valid TOML than we otherwise would:
//
//   1. Date/times. The docs say they come back as "strings of their source
//      text", so _bunShim_tomlDates() flattens smol-toml's TomlDate objects
//      (Date subclasses) to that string form. NOTE: real Bun currently throws
//      on ANY datetime ("Expected key but found -", oven-sh/bun#28687); that
//      is an acknowledged parser bug, not a contract, so we follow the
//      documented behaviour instead of reproducing it.
//
//      "Source text" is approximated, NOT guaranteed, and the gap is a
//      property of TomlDate rather than of this code: it is a Date subclass,
//      so it retains neither the source spelling nor sub-millisecond digits.
//      What survives exactly: offset date-times (Z and numeric offsets), local
//      date-times, local dates, local times, and authored fractional seconds
//      up to 3 digits. What does NOT:
//        - the RFC 3339 space separator is normalized to "T"
//          ("1979-05-27 07:32:00Z" -> "1979-05-27T07:32:00Z")
//        - fractional seconds beyond milliseconds are truncated
//          ("07:32:00.999999" -> "07:32:00.999")
//      Both are pinned by tests so the limit stays visible instead of being
//      rediscovered. Callers get RFC 3339 either way, so nothing downstream
//      mis-parses; only byte-identity with the file is lost.
//   2. 64-bit integers. smol-toml's DEFAULT rejects integers outside the
//      53-bit safe range ("cannot be represented losslessly") even though TOML
//      1.0 mandates 64-bit support, which would fail valid documents. With
//      integersAsBigInt:"asNeeded" only wider values become BigInt — except
//      that smol-toml also hands back `-0` as BigInt, inside the safe range.
//      _bunShim_tomlDates() narrows safe-range BigInts back to `number`, so
//      "the safe range stays plain number" is true for every input, and an
//      ordinary config cannot become JSON.stringify-hostile (that throws on
//      BigInt) just for containing `-0`.
//
// Loaded lazily: require('smol-toml') costs ~7 ms on this hardware, and no
// normal session ever reaches the import path.
let _bunShim_tomlMod = null;
const _bunShim_tomlDates = (v) => {
  if (v instanceof Date) {
    // TomlDate.toJSON() yields RFC 3339 with milliseconds forced in; ".000" is
    // redundant precision the source text almost never spelled out. Both
    // terminators must be accepted: TOML 1.0 permits a lowercase "z", and
    // smol-toml preserves that case in its output (its Z fast path is a strict
    // compare), so a lookahead for uppercase-only would leak ".000z". Every
    // branch is end-anchored, which also removes the over-strip surface of a
    // bare "Z" alternative.
    // The trailing terminator is upcased for the same reason: toISOString has
    // already normalized a lowercase "t" separator to "T", so leaving "z"
    // alone would emit a half-normalized "…T07:32:00z". Canonical beats mixed.
    return v.toJSON().replace(/\.000(?=[Zz]?$|[+-]\d{2}:\d{2}$)/, '').replace(/z$/, 'Z');
  }
  // Safe-range BigInt (smol-toml returns `-0` that way) back to number.
  if (typeof v === 'bigint'
      && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  if (Array.isArray(v)) return v.map(_bunShim_tomlDates);
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) v[k] = _bunShim_tomlDates(v[k]);
  }
  return v;
};
const _bunShim_TOML = {
  parse: (input) => {
    // smol-toml silently returns {} for a number or a plain object (it only
    // throws for null/undefined/array), which would turn a caller bug into an
    // empty config instead of an error. Bun.TOML.parse takes a string; say so.
    if (typeof input !== 'string') {
      throw new TypeError(`Bun.TOML.parse expects a string, got ${typeof input}`);
    }
    return _bunShim_tomlDates(
      (_bunShim_tomlMod ??= bundleRequire('smol-toml'))
        .parse(input, { integersAsBigInt: 'asNeeded' }),
    );
  },
  // Not part of Bun.TOML today (oven-sh/bun#22219 asks for it). Free from
  // smol-toml and harmless: if Bun ever ships it, this side is already covered.
  stringify: (value) => (_bunShim_tomlMod ??= bundleRequire('smol-toml')).stringify(value),
};
// --- end Bun.TOML shim --------------------------------------------------------

globalThis.__bunShim = {
  YAML: {
    parse: (s) => yamlMod.parse(s),
    stringify: (v, _replacer, indent) => yamlMod.stringify(v, {
      indent: typeof indent === 'number' && indent > 0 ? indent : 2,
    }),
  },
  semver: {
    order: (a, b) => semverMod.compare(a, b),
    satisfies: (v, range) => semverMod.satisfies(v, range),
  },
  Terminal: _BunTerminalShim,
  spawn: _bunShim_spawn,

  stringWidth: (s, opts) => stringWidthMod(String(s ?? ''), opts),
  stripANSI: (s) => stripAnsiMod(String(s ?? '')),
  wrapAnsi: (s, cols, opts) => wrapAnsiMod(String(s ?? ''), Number(cols) || 80, opts),
  which: (cmd, opts) => {
    try { return whichMod.sync(String(cmd), { nothrow: true, ...(opts || {}) }); }
    catch (_) { return null; }
  },
  hash: _bunShim_hash,
  deepEquals: _bunShim_deepEquals,
  file: _bunShim_file,
  TOML: _bunShim_TOML,

  gc: () => {},
  embeddedFiles: [],
  JSONL: undefined,
  // Property read as `Bun.isStandaloneExecutable===!0`, NOT a function: the one
  // 2.1.198 call site is `function rf(){return Bun.isStandaloneExecutable===!0}`.
  // We run the extracted JS under Node, never a `bun build --compile` binary, so
  // this is false (same rationale as embeddedFiles:[], standalone/embedded off).
  isStandaloneExecutable: false,

  generateHeapSnapshot: () => {
    throw new Error('Bun.generateHeapSnapshot not supported under Node');
  },
  Transpiler: class {
    constructor() {
      throw new Error('Bun.Transpiler not supported under Node');
    }
  },
  listen: () => {
    throw new Error('Bun.listen not supported under Node');
  },
  serve: () => {
    // claude gateway HTTP server (Bun.serve, /v1/messages proxy). Native-binary
    // only: the same subsystem's Bun.SQL site is gated in-bundle behind a
    // `typeof Bun>"u" -> throw "claude gateway requires the native binary"`
    // check, so this path is never reached in normal CLI use.
    throw new Error('Bun.serve not supported under Node (claude gateway requires the native binary)');
  },
  connect: () => {
    // agent-proxy selective relay, direct-dial path (v2.1.217): the client
    // side of the same relay whose server is the Bun.listen site above. Its
    // only caller runs inside that relay's CONNECT handling, so under Node it
    // is unreachable by construction; the listen stub throws before the relay
    // could ever accept a request, let alone dial upstream.
    throw new Error('Bun.connect not supported under Node');
  },
};

// Source-replace every shimmed symbol. The lookbehind rules out two things:
//   - identifiers ending in "Bun" (none in the bundle today, but cheap
//     insurance against future minifier collisions), and
//   - an immediately preceding quote, i.e. a symbol at the start of a string
//     literal. This is a text substitution over 20 MB of minified source, so
//     without that guard it also rewrites Bun.* mentions inside strings the
//     bundle shows to the user. 2.1.215 has exactly one, and it is precisely
//     the message describing our own situation:
//       detail:"Bun.Terminal unavailable (running under Node?)"
//     which would otherwise reach the user as "__bunShim.Terminal unavailable".
//     Same hazard AUDIT_INERT_BUN guards against in update.sh for non-shimmed
//     symbols; note that update.sh's audit cannot catch it for SHIMMED_BUN
//     ones, because membership short-circuits before any context inspection.
src = src.replace(
  /(?<!["'`])(?<![A-Za-z0-9_$])Bun\.(YAML|TOML|semver|Terminal|spawn|stringWidth|stripANSI|wrapAnsi|which|hash|deepEquals|file|gc|embeddedFiles|JSONL|isStandaloneExecutable|generateHeapSnapshot|Transpiler|listen|serve|connect)\b/g,
  '__bunShim.$1',
);

// Shape check before eval. A damaged bundle fails deep inside 20 MB of
// minified source with a message that names a minified identifier and nothing
// else: the bundle carries ~35 `using` declarations, which are legal inside
// the wrapper function but a SyntaxError at Script top level. So a truncated
// or unwrapped bundle surfaces as "SyntaxError: Unexpected identifier 'K'"
// with a stack pointing at this line and no hint about the real cause
// (issue #1). Same head/trailer criteria update.sh applies after extraction,
// repeated here because bundle.js can also arrive by other means.
const head = src.slice(0, 200);
if (!head.includes('@bun') ||
    !/function\(exports,\s*require,\s*module/.test(head) ||
    !src.trimEnd().slice(-8).includes('})')) {
  throw new Error(
    `bundle.js is not an intact CJS bundle (${bundlePath}, ${src.length} bytes).\n` +
    `  expected head: "// @bun …" followed by "(function(exports, require, module, …) {"\n` +
    `  expected tail: "})"\n` +
    `  actual head:   ${JSON.stringify(src.slice(0, 90))}\n` +
    `  actual tail:   ${JSON.stringify(src.trimEnd().slice(-40))}\n` +
    'Re-extract it with claude-node-update.',
  );
}

// Eval the top-level IIFE expression to get the wrapper function.
const wrapper = (0, eval)(src);

// Build a Module-like scope so the bundle's internal require() can resolve
// both Node built-ins and the external deps we installed in this dir.
const bundleModule = new Module(bundlePath, module);
bundleModule.filename = bundlePath;
bundleModule.paths = Module._nodeModulePaths(__dirname);

wrapper(
  bundleModule.exports,
  bundleRequire,
  bundleModule,
  bundlePath,
  __dirname,
);
