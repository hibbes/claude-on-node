#!/usr/bin/env node
// Run Claude Code 2.1.129's JS bundle under Node (no Bun needed).
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
//     Bun.semver.{order,satisfies}  -> semver package
//     Bun.Terminal + Bun.spawn(opts.terminal:T) -> node-pty
//     Bun.stringWidth               -> string-width@4
//     Bun.stripANSI                 -> strip-ansi@6
//     Bun.wrapAnsi                  -> wrap-ansi@7
//     Bun.which                     -> which@3
//     Bun.hash                      -> 64-bit FNV-1a (BigInt; matches .toString() shape)
//
//   Inert / disabled (Node code path doesn't depend on these):
//     Bun.gc                        -> no-op
//     Bun.embeddedFiles             -> [] (mz() returns false → embedded mode off)
//     Bun.JSONL                     -> undefined (Bun.JSONL?.parseChunk → undefined)
//
//   Throws on first use (rare paths: REPL, heap-dump, bg-pty TCP host):
//     Bun.generateHeapSnapshot, Bun.Transpiler, Bun.listen
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

  gc: () => {},
  embeddedFiles: [],
  JSONL: undefined,

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
};

// Source-replace every shimmed symbol. Lookbehind ensures we don't accidentally
// rewrite identifiers ending in "Bun" (none in the bundle today, but cheap
// insurance against future minifier collisions).
src = src.replace(
  /(?<![A-Za-z0-9_$])Bun\.(YAML|semver|Terminal|spawn|stringWidth|stripANSI|wrapAnsi|which|hash|gc|embeddedFiles|JSONL|generateHeapSnapshot|Transpiler|listen)\b/g,
  '__bunShim.$1',
);

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
