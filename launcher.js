#!/usr/bin/env node
// Run Claude Code 2.1.250's module graph under Node (no Bun needed).
// Since v2.1.242/243 a release is a Bun standalone module graph (~1400 ESM
// modules addressed as /$bunfs/root/<name>), which extract-modulegraph.py
// unpacks into modules/ and modulegraph-loader.js serves to Node's ESM loader
// through module.registerHooks(). Everything up to the __bunShim object below
// is the Bun API shim layer; plugin-shim.js evals exactly that prefix.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const os = require('os');
const zlib = require('zlib');

// Force system /usr/bin/rg — the bundle's default path resolution ends up at
// a build-time-baked /home/runner/work/... path that doesn't exist here.
// USE_BUILTIN_RIPGREP uses explicit-disable semantics: "0" / "false" / "no" / "off"
// triggers the system-rg lookup via `which`.
if (process.env.USE_BUILTIN_RIPGREP === undefined) process.env.USE_BUILTIN_RIPGREP = '0';

// Disable Claude Code's internal auto-updater. It migrates to a *native*
// binary that needs SSE4.2/POPCNT; on the pre-POPCNT CPUs this project exists
// for, that binary crashes with SIGILL and can clobber this workaround dir.
// Updates come from redeploying the bundle (update.sh), not from the CLI.
// See anthropics/claude-code#85571. An explicit env value still wins.
if (process.env.DISABLE_AUTOUPDATER === undefined) process.env.DISABLE_AUTOUPDATER = '1';

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

// The release lives in modules/ (extract-modulegraph.py output), a symlink to
// modules-<version>/ so update.sh can switch releases atomically. Resolve the
// link once, up front: chunks are imported lazily, so a session must keep
// reading the release it started with even after the nightly re-pointed the
// link. On a fresh clone there is no modules/ yet; the loader below reports
// that with the path, and plugin-shim.js (which evals only the prefix up to
// __bunShim) never needs it.
let modulesDir = path.join(__dirname, 'modules');
try { modulesDir = fs.realpathSync(modulesDir); } catch (_) { /* reported by the loader */ }
// createRequire() wants a file path to resolve from; lookups walk up from
// modules/ into this directory's node_modules, where the bundle's externals
// (react, zod, ws, @anthropic-ai/sdk, ...) and the shim backers live.
const bundlePath = path.join(modulesDir, '_index.json');

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
//     Bun.spawn (non-PTY)           -> child_process (bg workers, rg probe)
//     Bun.stringWidth               -> string-width@4 (ASCII fast path + memo cache)
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
//
//   Anthropic-private native namespace (Proxy: known members throw on call,
//   unknown member READS throw too; see the Bun.ant shim block):
//     Bun.ant.{getPeerUid,getPeerPid,setDumpable,memoryPressureLevel}  (SO_PEERCRED / prctl / macOS mem-pressure)
const bundleRequire = Module.createRequire(bundlePath);
const yamlMod = bundleRequire('yaml');
const semverMod = bundleRequire('semver');
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

// --- Bun.spawn non-PTY shim (child_process-backed Subprocess subset) ---------
// Until 2026-07-29 the non-PTY branch of Bun.spawn was a throws-stub ("no such
// call site exists today", true when written in May). Site drift then did what
// the mapping analysis of 2026-07-14 predicted: 2.1.220 spawns its background
// workers (bg-pty-host, spare pool, bridge sessions) through non-PTY Bun.spawn,
// and once that subsystem activated, the stub crashed every worker spawn and
// eventually session startup itself ("worker crashed … respawning" loop). The
// audit cannot flag this class: Bun.spawn has been in SHIMMED_BUN since May,
// and new call sites of a shimmed symbol are deliberately accepted.
//
// So per the standing policy (stub throws in normal operation -> build the
// real shim), this is a child_process-backed implementation of the Subprocess
// surface the 2.1.220 sites consume, plus the documented core options
// (bun.com/docs/api/spawn):
//   - argv array or {cmd: [...]} object form (_bunShim_spawnNormalize)
//   - cwd/env/argv0/detached/windowsHide (map 1:1 to child_process)
//   - stdio array or per-fd stdin/stdout/stderr; specs: "pipe"/"ignore"/
//     "inherit", numeric fd (borrowed, left open), BunFile (opened HERE so an
//     open failure throws synchronously out of Bun.spawn with err.code, which
//     the bg-pty-host site catches as its breadcrumb-degradation path; our own
//     fds are closed after spawn, the child holds duplicates)
//   - per-fd defaults per the docs: stdin "ignore", stdout "pipe", stderr "inherit"
//   - Subprocess: pid, exited, exitCode, signalCode, killed, kill(), ref(),
//     unref(), stdout/stderr as REAL web ReadableStreams (toWeb) with Bun's
//     text()/json()/bytes()/arrayBuffer() readers attached, stdin as a
//     FileSink subset (write/flush/end), onExit callback, timeout+killSignal
//   - ipc/serialization throw loudly: half an IPC channel would be a landmine
// KNOWN LIMITS, pinned in test/spawn-shim.test.js: a missing executable
// resolves exited to -1 with a stderr warning instead of Bun's synchronous
// throw (child_process reports ENOENT async; an unhandled 'error' event would
// crash the host process, the very failure mode this shim removes), and a
// signal death resolves exited to 128+signum (Bun's value is undocumented and
// unverifiable here; callers only compare against 0).
const _bunShim_spawnNormalize = (argvOrOpts, opts) => {
  if (!Array.isArray(argvOrOpts) && argvOrOpts && Array.isArray(argvOrOpts.cmd)) {
    return [argvOrOpts.cmd, argvOrOpts];
  }
  return [argvOrOpts, opts || {}];
};

const _bunShim_spawnStdioToNode = (spec, ioDir, ownFds) => {
  if (spec === undefined || spec === null) return undefined; // caller applies per-fd default
  if (spec === 'pipe' || spec === 'ignore' || spec === 'inherit') return spec;
  if (typeof spec === 'number') return spec; // borrowed fd: child gets a dup, we leave it open
  if (spec instanceof Blob) {
    // BunFile target (the bg-pty-host stderr breadcrumb). Open synchronously so
    // errno failures throw out of Bun.spawn itself, as the call site expects.
    if (spec._fd !== undefined) return spec._fd; // fd-backed BunFile: borrowed
    const fd = fs.openSync(spec._path ?? spec.name, ioDir === 'in' ? 'r' : 'w');
    ownFds.push(fd);
    return fd;
  }
  throw new Error(`Bun.spawn stdio spec not supported under Node shim: ${Object.prototype.toString.call(spec)}`);
};

const _bunShim_spawnReadable = (nodeStream) => {
  if (!nodeStream) return undefined;
  const web = require('stream').Readable.toWeb(nodeStream);
  // Bun extends ReadableStream with convenience readers (the rg version probe
  // does `await proc.stdout.text()`). Attach them as own properties; the
  // object stays a real ReadableStream (getReader/tee/pipeTo keep working).
  web.text = () => new Response(web).text();
  web.json = () => new Response(web).json();
  web.arrayBuffer = () => new Response(web).arrayBuffer();
  web.bytes = () => new Response(web).arrayBuffer().then((b) => new Uint8Array(b));
  return web;
};

const _bunShim_spawnNonPty = (argv, opts = {}) => {
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
    throw new Error('Bun.spawn shim: cmd must be a non-empty array of strings');
  }
  if (opts.ipc !== undefined || opts.serialization !== undefined) {
    throw new Error('Bun.spawn({ipc}) not supported under Node shim');
  }
  const cp = require('child_process');
  const ownFds = [];
  let child;
  try {
    const stdio = Array.isArray(opts.stdio)
      ? opts.stdio.map((s, i) =>
          _bunShim_spawnStdioToNode(s, i === 0 ? 'in' : 'out', ownFds) ?? 'ignore')
      : [
          _bunShim_spawnStdioToNode(opts.stdin, 'in', ownFds) ?? 'ignore',
          _bunShim_spawnStdioToNode(opts.stdout, 'out', ownFds) ?? 'pipe',
          _bunShim_spawnStdioToNode(opts.stderr, 'out', ownFds) ?? 'inherit',
        ];
    child = cp.spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      argv0: opts.argv0,
      detached: !!opts.detached,
      windowsHide: !!opts.windowsHide,
      stdio,
    });
  } finally {
    // child_process duplicates stdio fds during the synchronous spawn call, so
    // fds WE opened (BunFile targets) are closed here either way; borrowed
    // numeric fds are the caller's and stay open (site 5 closes its own).
    for (const fd of ownFds) { try { fs.closeSync(fd); } catch (_) {} }
  }

  let exitCode = null;
  let signalCode = null;
  let resolveExit;
  const exited = new Promise((res) => { resolveExit = res; });
  const subprocess = {
    get pid() { return child.pid; },
    exited,
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    get killed() { return child.killed; },
    kill(sig) { try { child.kill(sig || 'SIGTERM'); } catch (_) {} },
    ref() { child.ref(); },
    unref() { child.unref(); },
    stdout: _bunShim_spawnReadable(child.stdout),
    stderr: _bunShim_spawnReadable(child.stderr),
    stdin: child.stdin ? {
      write(chunk) {
        const buf = typeof chunk === 'string' ? chunk
          : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          : chunk instanceof ArrayBuffer ? Buffer.from(chunk)
          : String(chunk);
        child.stdin.write(buf);
        return buf.length;
      },
      flush() { return 0; }, // Node Writable has no explicit flush; write is queued
      end() { try { child.stdin.end(); } catch (_) {} return 0; },
    } : undefined,
  };

  const settle = (code, signal, err) => {
    signalCode = signal || null;
    if (err || (code === null && !signal)) exitCode = -1;
    else if (code !== null) exitCode = code;
    // exitCode stays null on a signal death, per Bun's documented "null until
    // the process exits normally"; exited still resolves non-zero (128+n).
    const sigNum = signal ? (os.constants.signals[signal] || 0) : 0;
    resolveExit(err ? -1 : (code !== null ? code : 128 + sigNum));
    if (typeof opts.onExit === 'function') {
      try { opts.onExit(subprocess, exitCode, signalCode, err || undefined); } catch (_) {}
    }
  };
  child.once('error', (err) => {
    // Bun throws synchronously for a missing executable; child_process emits
    // an async 'error' event, which unhandled would crash the WHOLE host
    // process. Degrade instead: warn once, resolve exited with -1 (callers
    // compare against 0 and treat the probe as failed).
    process.stderr.write(`[claude-on-node] Bun.spawn shim: ${err && err.message ? err.message : err}\n`);
    settle(null, null, err || new Error('spawn failed'));
  });
  child.once('exit', (code, signal) => settle(code, signal, null));

  if (typeof opts.timeout === 'number' && opts.timeout > 0) {
    const t = setTimeout(() => subprocess.kill(opts.killSignal || 'SIGTERM'), opts.timeout);
    t.unref();
    exited.finally(() => clearTimeout(t)); // exited never rejects; no unhandled here
  }
  return subprocess;
};
// --- end Bun.spawn non-PTY shim -------------------------------------------------

const _bunShim_spawn = (argvOrOpts, optsIn = {}) => {
  const [argv, opts] = _bunShim_spawnNormalize(argvOrOpts, optsIn);
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
  return _bunShim_spawnNonPty(argv, opts);
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
// target in the bg-pty-host spawner (served since 2026-07-29 by the non-PTY
// Bun.spawn shim, which opens the file synchronously). Also a REAL fs-backed
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

// --- Bun.stringWidth shim (string-width@4 + ASCII fast path + memo cache) ----
// Bun.stringWidth is native and effectively free; string-width@4 walks the
// string in JS. The bundle's single call site (Ink layout) re-measures
// transcript lines on every render frame, so a session whose transcript
// carries multi-MB tool_results (a Read on a 5 MB screenshot PNG returns its
// base64 as one string) spends minutes per frame inside stringWidth on slow
// CPUs: the event loop starves and the session looks hard-frozen at 100% CPU.
// Observed 22.07.2026 on two sessions, Inspector stacks identical
// (processImmediate -> Ink render -> stringWidth), on both 2.1.215 and
// 2.1.217. Two layers remove the cost without changing delegate semantics:
//   1. Printable-ASCII fast path: width == length after one regex scan.
//      Correct by construction: [\x20-\x7E] contains no ESC (0x1B), hence no
//      ANSI sequences, and no combining, wide or ambiguous code points, so
//      both documented Bun.stringWidth options are no-ops on this subset.
//      Base64 payloads are pure ASCII and always resolve here.
//   2. Memo cache for strings >= cacheFloor chars, keyed by the string value
//      alone and consulted before the fast path so repeated giant strings
//      skip even the regex scan. Bounded by cacheBudget total chars; Map
//      insertion order gives oldest-first eviction. Short strings are cheap
//      to re-measure and would only churn the cache.
// The key deliberately ignores the options argument: the bundle always passes
// {ambiguousIsNarrow:true} and string-width@4 accepts no options at all, so
// results cannot depend on them. stringwidth-shim.test.js pins that delegate
// property; a future delegate upgrade that honors options trips the pin and
// forces this key to be revisited.
// limits is a test seam; production uses the defaults.
function _bunShim_makeStringWidth(delegate, limits) {
  const ASCII_PRINTABLE = /^[\x20-\x7E]*$/;
  const cacheFloor = (limits && limits.cacheFloor) || 256;
  const cacheBudget = (limits && limits.cacheBudget) || 96 * 1024 * 1024;
  const cache = new Map();
  let cachedChars = 0;
  return (input, opts) => {
    const s = String(input ?? '');
    const cacheable = s.length >= cacheFloor && s.length <= cacheBudget;
    if (cacheable) {
      const hit = cache.get(s);
      if (hit !== undefined) return hit;
    }
    const w = ASCII_PRINTABLE.test(s) ? s.length : delegate(s, opts);
    if (cacheable) {
      while (cachedChars + s.length > cacheBudget && cache.size > 0) {
        const oldest = cache.keys().next().value;
        cachedChars -= oldest.length;
        cache.delete(oldest);
      }
      cache.set(s, w);
      cachedChars += s.length;
    }
    return w;
  };
}
const _bunShim_stringWidth = _bunShim_makeStringWidth(bundleRequire('string-width'));
// --- end Bun.stringWidth shim -------------------------------------------------

// --- Bun.ant shim (Anthropic-private native namespace, throws per member) ----
// v2.1.219 introduced `Bun.ant`, a namespace of Anthropic-private natives in
// their custom Bun build. Every member sits at a call site that degrades
// in-bundle when the native throws:
//   - Bun.ant.getPeerUid(fd): SO_PEERCRED peer-uid lookup on the
//     com.anthropic.claude-daemon socket; the caller catches, warns
//     "[daemon] peer uid lookup failed" and returns null.
//   - Bun.ant.getPeerPid(fd): SO_PEERCRED peer-pid lookup on the same socket
//     (added v2.1.226); the caller catches, warns "[peer-cred] peer pid
//     lookup failed" and returns undefined.
//   - Bun.ant.setDumpable(false): prctl(PR_SET_DUMPABLE, 0) hardening; the
//     caller catches and logs "prctl unavailable".
//   - Bun.ant.memoryPressureLevel(): macOS libdispatch memory-pressure query
//     (added v2.1.232); the caller catches, warns "bg low-mem:
//     memoryPressureLevel failed" and returns undefined. macOS-only, on Linux
//     the bg low-mem check takes the os.freemem() branch and never calls it.
// Node core exposes none of these, and the SO_PEERCRED/prctl paths went through
// bun:ffi before 2.1.219 (require() throws under Node into those same catches).
// Throwing preserves that behavior exactly; a real implementation would need a
// native FFI dep (koffi, or macOS libdispatch) for paths that already degrade
// by design.
//
// The namespace shape is the real hazard: the release audit's symbol regex
// sees only `Bun.ant`, so with it in SHIMMED_BUN a future member
// (Bun.ant.newThing) would deploy unaudited. Two layers against that:
//   - update.sh audits the bundle's Bun.ant.<member> spellings against
//     ANT_MEMBERS and blocks a release that grows one (kept in lockstep with
//     the member keys below by test/lockstep.test.js).
//   - This Proxy throws on ANY unknown member READ, naming the member. A plain
//     object would return undefined: silent, and for a property read silently
//     wrong (the Bun.isStandaloneExecutable lesson). The read-throw also
//     covers minifier aliasing (`let a=Bun.ant; a.newThing`), which a
//     text-level audit cannot see.
// Allowed through quietly: symbol keys, `then` and `toJSON` (generic object
// protocols: logging, await, JSON.stringify and util.inspect must not crash
// far from any Bun.ant context). Every other unknown read throws.
const _bunShim_antMembers = {
  getPeerUid(_fd) {
    throw new Error('Bun.ant.getPeerUid (SO_PEERCRED) not supported under Node; '
      + 'the daemon peer-uid check degrades in-bundle (warn + null), as it did via bun:ffi before 2.1.219');
  },
  getPeerPid(_fd) {
    throw new Error('Bun.ant.getPeerPid (SO_PEERCRED) not supported under Node; '
      + 'the peer-cred pid check degrades in-bundle (warn + undefined), added 2.1.226');
  },
  setDumpable(_flag) {
    throw new Error('Bun.ant.setDumpable (prctl PR_SET_DUMPABLE) not supported under Node; '
      + 'the caller logs "prctl unavailable" and continues, as it did via bun:ffi before 2.1.219');
  },
  memoryPressureLevel() {
    throw new Error('Bun.ant.memoryPressureLevel (macOS libdispatch memory pressure) not supported under Node; '
      + 'the bg low-mem check is macOS-only (Linux takes the os.freemem() branch) and degrades in-bundle (warn + undefined), added 2.1.232');
  },
};
const _bunShim_ant = new Proxy(_bunShim_antMembers, {
  get(target, prop, receiver) {
    if (typeof prop === 'symbol' || prop in target
        || prop === 'then' || prop === 'toJSON') {
      return Reflect.get(target, prop, receiver);
    }
    throw new Error(`Bun.ant.${prop} is not shimmed under Node `
      + '(new member of the Anthropic-private native namespace? '
      + 'See the Bun.ant shim in launcher.js and ANT_MEMBERS in update.sh)');
  },
});
// --- end Bun.ant shim ---------------------------------------------------------

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

  stringWidth: _bunShim_stringWidth,
  stripANSI: (s) => stripAnsiMod(String(s ?? '')),
  wrapAnsi: (s, cols, opts) => wrapAnsiMod(String(s ?? ''), Number(cols) || 80, opts),
  which: (cmd, opts) => {
    // Bun.which options are {PATH, cwd}; npm which understands {path, pathExt}.
    // Passing PATH through unmapped is a silent landmine: which ignores the
    // unknown key and resolves against process.env.PATH instead of the
    // caller's filtered PATH (first real call site: v2.1.248's sandbox PATH
    // filtering). cwd only matters for relative PATH entries; npm which has
    // no equivalent, and the 2.1.248 sites pass absolute entries only.
    try {
      const o = { ...(opts || {}) };
      if (typeof o.PATH === 'string') { o.path = o.PATH; delete o.PATH; }
      delete o.cwd;
      return whichMod.sync(String(cmd), { nothrow: true, ...o });
    } catch (_) { return null; }
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

  // Embedded text assets ship zstd-compressed since v2.1.251 (magic-byte
  // check at the call site, passthrough otherwise; .toString("utf8") on the
  // result, so the Buffer node:zlib returns fits Bun's Uint8Array contract).
  // Real implementations, not stubs: cheap, well-defined, and node:zlib has
  // native zstd. The async form matches Bun's Promise<Uint8Array> shape.
  zstdDecompressSync: (data) => zlib.zstdDecompressSync(data),
  zstdDecompress: (data) => new Promise((resolve, reject) => {
    zlib.zstdDecompress(data, (err, out) => (err ? reject(err) : resolve(out)));
  }),

  build: () => {
    // Bun's bundler API (v2.1.247/248): bundles a plugin's hooks module
    // (hooks.ts) at runtime, feature itself rollout-gated. The only call site
    // catches and wraps into its own HooksError ("cannot bundle the hooks
    // module of <plugin>"), so under Node the feature degrades with its
    // designed error while the CLI keeps running. Not implementable here
    // without shipping a bundler; same policy as Bun.serve/listen/connect.
    throw new Error('Bun.build not supported under Node (plugin hooks modules need the native binary)');
  },

  // Anthropic-private native namespace (v2.1.219): a Proxy whose known members
  // throw on call and whose unknown member reads throw loudly. See the
  // Bun.ant shim block above for why a plain object would be a silent landmine.
  ant: _bunShim_ant,
};

// Source-replace every shimmed symbol. The lookbehind rules out two things:
//   - identifiers ending in "Bun" (none in the bundle today, but cheap
//     insurance against future minifier collisions), and
//   - an immediately preceding quote, i.e. a symbol at the start of a string
//     literal. This is a text substitution over ~36 MB of minified source, so
//     without that guard it also rewrites Bun.* mentions inside strings the
//     bundle shows to the user. 2.1.215 has exactly one, and it is precisely
//     the message describing our own situation:
//       detail:"Bun.Terminal unavailable (running under Node?)"
//     which would otherwise reach the user as "__bunShim.Terminal unavailable".
//     Same hazard AUDIT_INERT_BUN guards against in update.sh for non-shimmed
//     symbols; note that update.sh's audit cannot catch it for SHIMMED_BUN
//     ones, because membership short-circuits before any context inspection.
// The loader applies this per module at load time (modulegraph-loader.js);
// test/lockstep.test.js reads the alternation from this literal.
const BUN_SHIM_RE = /(?<!["'`])(?<![A-Za-z0-9_$])Bun\.(YAML|TOML|semver|Terminal|spawn|stringWidth|stripANSI|wrapAnsi|which|hash|deepEquals|file|gc|embeddedFiles|JSONL|isStandaloneExecutable|generateHeapSnapshot|Transpiler|listen|serve|connect|build|zstdDecompressSync|zstdDecompress|ant)\b/g;

// --- module graph loader -----------------------------------------------------
// Shape check before anything runs: a damaged or absent manifest fails here
// with the directory named, instead of deep inside a chunk with a message
// that names a minified identifier and nothing else (the single-bundle era's
// issue #1, same failure direction).
const { createModuleGraphLoader } = require('./modulegraph-loader.js');
let graph;
try {
  graph = createModuleGraphLoader({ modulesDir, bunShimRegex: BUN_SHIM_RE, bundleRequire });
} catch (err) {
  console.error(
    `modules/ is not an intact Claude Code module graph (${modulesDir}).\n` +
    `  ${err.message}\n` +
    'Re-extract it with claude-node-update.',
  );
  process.exit(1);
}
// The bundle's import.meta.require (Bun-only) is rewritten to this global; it
// is how the three N-API addons get loaded.
globalThis.__bunfsRequire = graph.bunfsRequire;
Module.registerHooks(graph.hooks);

// The entry is the /$bunfs/root/cli alias of src/entrypoints/cli.js, an ES
// module: a dynamic import from this CJS loader is the supported way in. A
// rejection here is a startup failure (a chunk that failed to link or throw
// at module init), not a user error: print it and exit non-zero, as the old
// eval path did on a throw.
import(graph.entryUrl).catch((err) => {
  console.error((err && err.stack) || err);
  process.exit(1);
});
