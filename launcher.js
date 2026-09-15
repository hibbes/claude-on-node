#!/usr/bin/env node
// Run Claude Code 2.1.258's module graph under Node (no Bun needed).
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
//     Bun.sliceAnsi                 -> hand-rolled column slicer (widths via the stringWidth shim)
//     Bun.sleepSync                 -> Atomics.wait
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

// --- Bun.sleepSync shim (Atomics.wait on a private SharedArrayBuffer cell) ----
// 2.1.271's only call site pauses 2 ms per round of a bounded loop that drains
// pending terminal replies from /dev/tty. Without a real pause that loop spins
// through its read budget at once and gives up before slow replies arrive.
// Atomics.wait on a cell nobody ever notifies is a blocking sleep, and Node
// allows it on the main thread. Validation follows Bun (its docs, its
// sleepSync.test.ts and its source): the argument must be a number (a missing
// one is undefined, so that throws too), extra arguments are ignored, and the
// value is converted like Bun's coerce::<i32>, not like `| 0`: NaN becomes 0,
// fractions truncate toward zero, and out-of-range values saturate at the
// int32 limits instead of wrapping. Hence -Infinity throws as negative, and
// NaN never reaches Atomics.wait, which would read it as "wait forever".
const _bunShim_sleepCell = new Int32Array(new SharedArrayBuffer(4));
function _bunShim_sleepSync(ms) {
  if (typeof ms !== 'number') {
    throw new TypeError(`Bun.sleepSync: "milliseconds" must be a number, got ${typeof ms}`);
  }
  const n = ms !== ms ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(ms)));
  if (n < 0) throw new TypeError(`argument to sleepSync must not be negative, got ${n}`);
  Atomics.wait(_bunShim_sleepCell, 0, 0, n);
}
// --- end Bun.sleepSync shim ---------------------------------------------------

// --- Bun.sliceAnsi shim (column slicing, SGR/OSC 8 aware, grapheme clusters) --
// 2.1.271 replaced its bundled JS slicing helper with the native Bun.sliceAnsi,
// and all five call sites sit on the interactive render path: the
// truncate-with-ellipsis helper for Ink text, the renderer's horizontal clip,
// and the collapsed-output wrapper. A stub would crash the UI, so this is a
// full implementation of the documented contract (bun.com/reference/bun/
// sliceAnsi and SliceAnsiOptions, Bun v1.3.11 release notes):
//   - indices are terminal columns, `end` exclusive, negative ones count from
//     the end, clamped like String.prototype.slice;
//   - grapheme clusters are never split: a cluster goes in whole when its
//     START column lies in [start, end), so a wide one may overhang `end` by a
//     column (the call sites shrink `end` until the measured width fits);
//   - SGR styles active at the cut are re-opened (one sequence per attribute)
//     and closed at the end, OSC 8 hyperlinks likewise, other control
//     sequences are invisible, and escapes past the end pass only when they
//     close something that is open without opening anything;
//   - an ellipsis (4th argument string, or {ellipsis}) marks a cut edge, counts
//     against the width budget, and sits inside active SGR but outside an
//     active hyperlink.
// The edge cases (zero-width clusters at either boundary, the speculative zone
// that decides whether an end ellipsis is needed, the bare ellipsis for a
// degenerate range) follow Bun's own suite test/js/bun/util/sliceAnsi.test.ts,
// which test/sliceansi-shim.test.js ports.
//
// Widths: every cluster is measured with the Bun.stringWidth shim above
// (string-width@4), NOT with Bun's tables. The call sites measure with
// Bun.stringWidth and then slice, so the two have to agree cluster by cluster,
// or the shrink-to-fit loops and the chunked wrapper drift. Where string-width@4
// and Bun disagree (U+200B, a lone regional indicator) or where Bun has a mode
// the delegate lacks (ambiguousIsNarrow:false), this shim follows the delegate;
// the suite's KNOWN LIMIT cases pin that.
//
// Work is bounded by the slice, not the input: tokenizing and grapheme
// segmentation run lazily over growing windows, so cutting 80 columns off the
// front of a multi-MB tool-output line touches a few hundred characters. That
// is the input class that once froze Ink rendering through stringWidth.
// Negative indices and an open end need the whole input, as they do in Bun.
const _SA_TEXT = 0;
const _SA_SGR = 1;
const _SA_LINK = 2;
const _SA_CTRL = 3;

const _sa_isIntroducer = (c) => c === 0x1b || c === 0x9b || c === 0x9d || c === 0x90
  || c === 0x98 || c === 0x9e || c === 0x9f || c === 0x9c;

// OSC 8 hyperlink: ESC ] 8 ; params ; URI, then BEL, ESC \ or C1 ST; also with
// the C1 OSC introducer. An empty URI is a close. ESC (other than in ESC \),
// CAN or SUB inside aborts it; the generic control-string parser takes over.
function _sa_parseLink(s, i) {
  const n = s.length;
  const esc = s.charCodeAt(i) === 0x1b;
  let p;
  if (esc) {
    if (s.charCodeAt(i + 1) !== 0x5d || s.charCodeAt(i + 2) !== 0x38 || s.charCodeAt(i + 3) !== 0x3b) return null;
    p = i + 4;
  } else {
    if (s.charCodeAt(i + 1) !== 0x38 || s.charCodeAt(i + 2) !== 0x3b) return null;
    p = i + 3;
  }
  for (; p < n; p++) {
    const d = s.charCodeAt(p);
    if (d === 0x3b) break;
    if (d === 0x07 || d === 0x9c || d === 0x1b || d === 0x18 || d === 0x1a) return null;
  }
  if (p >= n) return null;
  const uri = p + 1;
  for (let q = uri; q < n; q++) {
    const d = s.charCodeAt(q);
    let b = -1;
    let term = '';
    if (d === 0x07) { b = q + 1; term = '\x07'; }
    else if (d === 0x1b && s.charCodeAt(q + 1) === 0x5c) { b = q + 2; term = '\x1b\\'; }
    else if (d === 0x9c) { b = q + 1; term = '\x9c'; }
    else if (d === 0x1b || d === 0x18 || d === 0x1a) return null;
    if (b !== -1) {
      return { t: _SA_LINK, a: i, b, open: q > uri, closePrefix: esc ? '\x1b]8;;' : '\x9d8;;', term };
    }
  }
  return null;
}

// Control strings: OSC (ESC ] or C1, BEL or ST terminated), DCS/SOS/PM/APC (ST
// terminated) and a standalone ST. An unterminated one is not consumed: its
// introducer then counts as an invisible character and the text after it stays
// visible. Returns the end index, or -1.
function _sa_parseControlString(s, i) {
  const n = s.length;
  const c = s.charCodeAt(i);
  let p;
  let bel = false;
  if (c === 0x1b) {
    const d = s.charCodeAt(i + 1);
    if (d === 0x5d) { p = i + 2; bel = true; }
    else if (d === 0x50 || d === 0x58 || d === 0x5e || d === 0x5f) p = i + 2;
    else if (d === 0x5c) return i + 2;
    else return -1;
  } else if (c === 0x9d) { p = i + 1; bel = true; }
  else if (c === 0x90 || c === 0x98 || c === 0x9e || c === 0x9f) p = i + 1;
  else if (c === 0x9c) return i + 1;
  else return -1;
  for (; p < n; p++) {
    const d = s.charCodeAt(p);
    if (bel && d === 0x07) return p + 1;
    if (d === 0x1b) return s.charCodeAt(p + 1) === 0x5c ? p + 2 : p; // ST, or ESC aborts (kept)
    if (d === 0x18 || d === 0x1a || d === 0x9c) return p + 1;
  }
  return -1;
}

// CSI: ESC [ or C1 0x9b, parameter bytes 0x30-0x3f, intermediates 0x20-0x2f,
// final byte 0x40-0x7e. Only an `m` with digit/;/: parameters is SGR; anything
// else is an invisible control. CAN, SUB and C1 ST abort it (consumed), ESC
// aborts it (left for the next token), other bytes are payload, and an
// unterminated CSI runs to the end of the input.
function _sa_parseCsi(s, i) {
  const n = s.length;
  let p;
  if (s.charCodeAt(i) === 0x1b) {
    if (s.charCodeAt(i + 1) !== 0x5b) return null;
    p = i + 2;
  } else {
    p = i + 1;
  }
  let canonical = true;
  for (; p < n; p++) {
    const d = s.charCodeAt(p);
    if (d >= 0x40 && d <= 0x7e) return { t: d === 0x6d && canonical ? _SA_SGR : _SA_CTRL, a: i, b: p + 1 };
    if (d >= 0x30 && d <= 0x3f) { if (d >= 0x3c) canonical = false; continue; }
    if (d >= 0x20 && d <= 0x2f) { canonical = false; continue; }
    if (d === 0x18 || d === 0x1a || d === 0x9c) return { t: _SA_CTRL, a: i, b: p + 1 };
    if (d === 0x1b) return { t: _SA_CTRL, a: i, b: p };
    canonical = false;
  }
  return { t: _SA_CTRL, a: i, b: n };
}

// Two-byte escapes (ESC 7, ESC c, ESC =) and nF sequences (ESC ( B, ESC # 8).
// Returns -1 when the ESC starts none of them; it is then a lone invisible char.
function _sa_parseEscape(s, i) {
  const n = s.length;
  let p = i + 1;
  if (p === n) return n;
  const c = s.charCodeAt(p);
  if (c === 0x1b) return p;
  if (c === 0x5b || c === 0x5d || c === 0x50 || c === 0x58 || c === 0x5e || c === 0x5f) return -1;
  if (c >= 0x20 && c <= 0x2f) {
    p++;
    if (p === n) return n;
    return s.charCodeAt(p) === 0x1b ? p : p + 1;
  }
  return c >= 0x30 && c <= 0x7e ? p + 1 : -1;
}

function _sa_parseAnsi(s, i) {
  const c = s.charCodeAt(i);
  if (c === 0x1b || c === 0x9d) {
    const link = _sa_parseLink(s, i);
    if (link) return link;
  }
  if (c !== 0x9b) {
    const b = _sa_parseControlString(s, i);
    if (b !== -1) return { t: _SA_CTRL, a: i, b };
  }
  if (c === 0x1b || c === 0x9b) {
    const csi = _sa_parseCsi(s, i);
    if (csi) return csi;
  }
  if (c === 0x1b) {
    const b = _sa_parseEscape(s, i);
    if (b !== -1) return { t: _SA_CTRL, a: i, b };
  }
  return null;
}

// SGR open code -> the code that closes it; 0 = unknown, closed by a full reset.
const _sa_sgrClose = (code) => {
  if (code === 1 || code === 2) return 22;
  if (code === 3 || code === 20) return 23;
  if (code === 4 || code === 21) return 24;
  if (code === 5 || code === 6) return 25;
  if (code === 7) return 27;
  if (code === 8) return 28;
  if (code === 9) return 29;
  if ((code >= 30 && code <= 38) || (code >= 90 && code <= 97)) return 39;
  if ((code >= 40 && code <= 48) || (code >= 100 && code <= 107)) return 49;
  if (code === 51 || code === 52) return 54;
  if (code === 53) return 55;
  if (code === 58) return 59;
  if (code === 73 || code === 74) return 75;
  return 0;
};
const _sa_isSgrClose = (code) => code === 0 || code === 22 || code === 23 || code === 24
  || code === 25 || code === 27 || code === 28 || code === 29 || code === 39 || code === 49
  || code === 54 || code === 55 || code === 59 || code === 75;
// Attribute slot: styles in the same slot replace each other, different slots
// stack. The slot is the close code, except where one close ends several
// independent attributes (22 bold+dim, 23 italic+fraktur, 24 single+double
// underline, 54 framed+encircled): those get one slot per open code.
const _sa_sgrSlot = (code) => {
  const close = _sa_sgrClose(code);
  return close === 22 || close === 23 || close === 24 || close === 54 ? code : close;
};

// SGR parameters; an empty one is 0 (ECMA-48), so ESC[m is [0]. Colon
// sub-parameters, or more than 32 parameters, make the sequence opaque: it is
// then kept and closed as a whole instead of being decomposed.
function _sa_sgrParams(s, tok) {
  const c1 = s.charCodeAt(tok.a) === 0x9b;
  const last = tok.b - 1; // the final `m`
  const list = [];
  let cur = 0;
  let opaque = false;
  for (let p = tok.a + (c1 ? 1 : 2); p < last; p++) {
    const d = s.charCodeAt(p);
    if (d >= 0x30 && d <= 0x39) {
      if (cur < 100000) cur = cur * 10 + (d - 0x30);
      continue;
    }
    if (d === 0x3a) opaque = true; // otherwise `;`: an SGR token holds nothing else
    if (list.length >= 32) return { c1, list, opaque: true };
    list.push(cur);
    cur = 0;
  }
  if (list.length >= 32) return { c1, list, opaque: true };
  list.push(cur);
  return { c1, list, opaque };
}

// Active styles: an ordered list of { slot, open, close }. A new style removes
// the entry in its slot and appends itself, so opens are re-emitted in the
// order they last took effect.
const _sa_startStyle = (styles, slot, open, close) => {
  for (let k = styles.length - 1; k >= 0; k--) if (styles[k].slot === slot) styles.splice(k, 1);
  styles.push({ slot, open, close });
};
const _sa_endStyle = (styles, close) => {
  for (let k = styles.length - 1; k >= 0; k--) if (styles[k].close === close) styles.splice(k, 1);
};

function _sa_applySgr(styles, s, tok) {
  const { c1, list, opaque } = _sa_sgrParams(s, tok);
  if (opaque) {
    const close = _sa_sgrClose(list[0]);
    _sa_startStyle(styles, _sa_sgrSlot(list[0]), s.slice(tok.a, tok.b), close ? `\x1b[${close}m` : '\x1b[0m');
    return;
  }
  const pre = c1 ? '\x9b' : '\x1b[';
  for (let k = 0; k < list.length;) {
    const code = list[k];
    if (code === 0) {
      styles.length = 0;
      k++;
    } else if (code === 38 || code === 48 || code === 58) { // extended fg / bg / underline colour
      const close = `\x1b[${_sa_sgrClose(code)}m`;
      if (list[k + 1] === 5 && k + 2 < list.length) {
        _sa_startStyle(styles, _sa_sgrSlot(code), `${pre}${code};5;${list[k + 2]}m`, close);
        k += 3;
      } else if (list[k + 1] === 2 && k + 4 < list.length) {
        _sa_startStyle(styles, _sa_sgrSlot(code), `${pre}${code};2;${list[k + 2]};${list[k + 3]};${list[k + 4]}m`, close);
        k += 5;
      } else {
        _sa_startStyle(styles, _sa_sgrSlot(code), `${pre}${code}m`, close);
        k++;
      }
    } else if (_sa_isSgrClose(code)) {
      _sa_endStyle(styles, `\x1b[${code}m`);
      k++;
    } else {
      const close = _sa_sgrClose(code);
      _sa_startStyle(styles, _sa_sgrSlot(code), `${pre}${code}m`, close ? `\x1b[${close}m` : '\x1b[0m');
      k++;
    }
  }
}

// Past the end, an SGR sequence is kept only if it closes an open style and
// opens nothing (slice-ansi's behavior, which Bun keeps).
function _sa_closesOnly(styles, s, tok) {
  const { list, opaque } = _sa_sgrParams(s, tok);
  if (opaque) return false;
  let closes = false;
  for (let k = 0; k < list.length; k++) {
    const code = list[k];
    if (code === 0) {
      if (styles.length) closes = true;
    } else if (_sa_isSgrClose(code)) {
      const close = `\x1b[${code}m`;
      if (styles.some((st) => st.close === close)) closes = true;
    } else {
      return false;
    }
  }
  return closes;
}

// Cluster widths through the stringWidth shim (see above). Single code points,
// by far the common case, are cached per code point (a lazily allocated table
// holding width + 1), so even a long CJK line costs one delegate call per
// distinct character; longer clusters go through a bounded memo.
let _sa_cpWidths = null;
const _sa_codePointWidth = (cp) => {
  if (cp >= 0x20 && cp <= 0x7e) return 1;
  _sa_cpWidths ??= new Uint8Array(0x110000);
  let w = _sa_cpWidths[cp];
  if (w === 0) {
    w = _bunShim_stringWidth(String.fromCodePoint(cp)) + 1;
    _sa_cpWidths[cp] = w;
  }
  return w - 1;
};
const _sa_widthMemo = new Map();
const _sa_width = (str) => {
  let w = _sa_widthMemo.get(str);
  if (w === undefined) {
    w = _bunShim_stringWidth(str);
    if (str.length <= 32) {
      if (_sa_widthMemo.size >= 4096) _sa_widthMemo.clear();
      _sa_widthMemo.set(str, w);
    }
  }
  return w;
};
const _sa_clusterWidth = (v, a, b) => {
  const cp = v.codePointAt(a);
  return b - a === (cp > 0xffff ? 2 : 1) ? _sa_codePointWidth(cp) : _sa_width(v.slice(a, b));
};

let _sa_segmenter = null;
const _SA_REPLACEMENT = String.fromCharCode(0xfffd);
const _SA_LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// Characters that can join a neighbor into one grapheme cluster: CR (CR LF),
// ZWJ, Extend (Grapheme_Extend, emoji modifiers, tag characters), SpacingMark
// (Mc plus U+0E33/U+0EB3), Prepend, Hangul jamo, regional indicators. Visible
// text without any of them is one cluster per code point, so Intl.Segmenter,
// the dominant per-call cost on typical UI lines, can be skipped. JS regex has
// no Prepend property, hence the explicit list; test/sliceansi-shim.test.js
// checks the whole set against the running ICU over every assigned code point,
// so joiners added by a future Unicode (16 brought U+113D1) turn the suite red
// instead of splitting clusters.
const _SA_JOINER = /[\r\u{200d}\u{e33}\u{eb3}\u{1100}-\u{11ff}\u{a960}-\u{a97f}\u{d7b0}-\u{d7ff}\u{600}-\u{605}\u{6dd}\u{70f}\u{890}\u{891}\u{8e2}\u{d4e}\u{110bd}\u{110cd}\u{111c2}\u{111c3}\u{113d1}\u{1193f}\u{11941}\u{11a3a}\u{11a84}-\u{11a89}\u{11d46}\u{11f02}\u{e0020}-\u{e007f}\p{Grapheme_Extend}\p{Mc}\p{Emoji_Modifier}\p{Regional_Indicator}]/u;

// Lazy tokenizer. toks holds tokens in input order; text tokens carry their
// offset into `vis`, the visible text seen so far (lone surrogates replaced by
// U+FFFD, so two halves separated by an escape never pair up there); bound[i]
// flags the start of a grapheme cluster in vis.
function _sa_produce(sc, want) {
  const { s } = sc;
  const n = s.length;
  const parts = [];
  let visLen = sc.vis.length;
  let p = sc.pos;
  while (p < n && visLen < want) {
    if (_sa_isIntroducer(s.charCodeAt(p))) {
      const tok = _sa_parseAnsi(s, p);
      if (tok) { sc.toks.push(tok); p = tok.b; continue; }
    }
    // Visible text up to the next introducer (an introducer that starts no
    // sequence is visible itself), capped at what is still wanted, never
    // splitting a surrogate pair.
    const cap = Math.min(n, p + (want - visLen));
    let q = p + 1;
    while (q < cap && !_sa_isIntroducer(s.charCodeAt(q))) q++;
    if (q < n && (s.charCodeAt(q - 1) & 0xfc00) === 0xd800 && (s.charCodeAt(q) & 0xfc00) === 0xdc00) q++;
    sc.toks.push({ t: _SA_TEXT, a: p, b: q, v: visLen });
    parts.push(s.slice(p, q).replace(_SA_LONE_SURROGATE, _SA_REPLACEMENT));
    visLen += q - p;
    p = q;
  }
  sc.pos = p;
  sc.done = p >= n;
  if (parts.length) sc.vis += parts.join('');
  // Cluster starts for everything seen so far. A boundary depends only on the
  // text before it and the character right after it (UAX #29 looks no further
  // ahead), so flags the walk already acted on cannot change when more text
  // arrives; recomputing from 0 keeps the code simple, and the doubling window
  // keeps the total linear.
  const v = sc.vis;
  sc.ascii = /^[\x20-\x7e]*$/.test(v);
  const bound = new Uint8Array(v.length);
  if (sc.ascii) {
    bound.fill(1);
  } else if (!_SA_JOINER.test(v)) {
    for (let i = 0; i < v.length; i++) { // one cluster per code point
      bound[i] = 1;
      if ((v.charCodeAt(i) & 0xfc00) === 0xd800) i++; // vis holds no lone surrogates
    }
  } else {
    _sa_segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const { index } of _sa_segmenter.segment(v)) bound[index] = 1;
  }
  sc.bound = bound;
}

const _sa_toInteger = (v) => {
  const x = +v; // ToNumber: throws on Symbol/BigInt, as Bun's index conversion does
  if (x !== x) return 0;
  if (x === Infinity || x === -Infinity) return x;
  return Math.trunc(x);
};

// String.prototype.slice-style resolution against a known total width.
// Returns null for an empty range, else [start, end, cutStart, cutEnd].
const _sa_bounds = (startD, endD, total) => {
  let from = startD < 0 ? total + startD : startD;
  let to = endD < 0 ? total + endD : endD;
  if (from < 0) from = 0;
  if (to > total) to = total;
  if (!(to > from)) return null;
  return [from, to, from > 0, to < total];
};

// The column walk. `end` === Infinity means "to the end of the input".
// cutEndKnown/cutEndHint: whether it is already known that content lies past
// `end` (negative-index path); otherwise that is discovered on the way.
function _sa_walk(sc, start, end, ellipsis, ew, cutStartForEllipsis, cutEndKnown, cutEndHint) {
  const { s } = sc;
  const endUnbounded = end === Infinity;

  const out = [];
  let runA = -1;
  let runB = -1;
  const flushRun = () => { if (runA !== -1) { out.push(s.slice(runA, runB)); runA = -1; } };
  const emitSrc = (a, b) => {
    if (runA !== -1 && a === runB) runB = b;
    else { flushRun(); runA = a; runB = b; }
  };
  const emitStr = (str) => { if (str) { flushRun(); out.push(str); } };

  let styles = [];
  let link = { active: false, code: '', closePrefix: '', term: '' };
  const applyLink = (tok) => {
    link = tok.open
      ? { active: true, code: s.slice(tok.a, tok.b), closePrefix: tok.closePrefix, term: tok.term }
      : { ...link, active: false };
  };
  // Escapes met after the first included cluster wait here until the next
  // visible character shows whether they sit inside the slice (emit all) or
  // past its end (emit only what closes something open).
  let pending = [];
  const flushPending = (closeOnly) => {
    for (const tok of pending) {
      if (tok.t === _SA_SGR) {
        if (closeOnly && !_sa_closesOnly(styles, s, tok)) continue;
        _sa_applySgr(styles, s, tok);
        emitSrc(tok.a, tok.b);
      } else if (tok.t === _SA_LINK) {
        if (closeOnly && (tok.open || !link.active)) continue;
        applyLink(tok);
        emitSrc(tok.a, tok.b);
      } else if (!closeOnly) {
        emitSrc(tok.a, tok.b);
      }
    }
    pending = [];
  };

  // Ellipsis budget. With the end cut still unknown, budget for it anyway and
  // write the columns it would replace as a "speculative zone": if content
  // turns up past the zone, the zone is dropped for the ellipsis; if the input
  // ends first, the zone stays and no end ellipsis is added.
  let needStartEllipsis = false;
  let needEndEllipsis = false;
  let endBudget = 0;
  const startBeforeBudget = start;
  if (ew > 0) {
    if (cutStartForEllipsis && ew < end - start) { needStartEllipsis = true; start += ew; }
    if (cutEndKnown && cutEndHint && ew < end - start) {
      needEndEllipsis = true;
      end -= ew;
    } else if (!cutEndKnown && !endUnbounded && ew < end - start) {
      needEndEllipsis = true;
      endBudget = ew;
      end -= ew;
    }
    if (cutEndKnown && (cutStartForEllipsis || cutEndHint) && !needStartEllipsis && !needEndEllipsis) {
      return ellipsis; // a side is cut but the range cannot hold the ellipsis
    }
  }
  const specEnd = end + endBudget;
  let inZone = false;
  let zoneMark = 0;
  let zoneStyles = null;
  let zoneLink = null;
  const enterZone = () => {
    if (inZone) return;
    inZone = true;
    flushRun();
    zoneMark = out.length;
    zoneStyles = styles.slice();
    zoneLink = { ...link };
  };

  if (sc.toks.length === 0 && !sc.done) _sa_produce(sc, endUnbounded ? Infinity : 2 * specEnd + 64);
  const clusterWidth = (a, b) => (sc.ascii ? b - a : _sa_clusterWidth(sc.vis, a, b));

  let position = 0; // start column of the current cluster
  let clusterStart = 0; // its offset in vis
  let hasPrev = false;
  let include = false;
  let sawCutEnd = false;
  let pastSpecEnd = false; // only zero-width clusters seen at specEnd so far
  let stopped = false;
  let ti = 0;
  walk: for (;;) {
    if (ti === sc.toks.length) {
      if (sc.done) break;
      _sa_produce(sc, Math.max(64, sc.vis.length * 2));
      continue;
    }
    const tok = sc.toks[ti++];
    if (tok.t !== _SA_TEXT) {
      if (include) pending.push(tok);
      else if (tok.t === _SA_SGR) _sa_applySgr(styles, s, tok);
      else if (tok.t === _SA_LINK) applyLink(tok);
      continue;
    }
    for (let k = tok.a; k < tok.b;) {
      const len = (s.charCodeAt(k) & 0xfc00) === 0xd800 && k + 1 < tok.b
        && (s.charCodeAt(k + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
      const vi = tok.v + (k - tok.a);
      if (sc.bound[vi]) {
        if (hasPrev) position += clusterWidth(clusterStart, vi);
        if (!endUnbounded && position >= specEnd) {
          // A cut needs visible width at or past specEnd. A zero-width cluster
          // exactly at specEnd (LF, tab) is not one: keep scanning, emit
          // nothing. Without an ellipsis the difference is unobservable.
          if (ew === 0 || position > specEnd || _sa_codePointWidth(sc.vis.codePointAt(vi)) > 0) {
            sawCutEnd = true;
            flushPending(true);
            stopped = true;
            break walk;
          }
          pastSpecEnd = true;
        } else {
          if (!include && position >= start) {
            include = true;
            for (const st of styles) emitStr(st.open);
            if (needStartEllipsis) emitStr(ellipsis);
            if (link.active) emitStr(link.code);
          }
          if (include) {
            flushPending(false);
            if (!endUnbounded && position >= end && endBudget > 0) enterZone();
            emitSrc(k, k + len);
          }
        }
        clusterStart = vi;
      } else if (include && !pastSpecEnd) { // continuation of the current cluster
        flushPending(false);
        emitSrc(k, k + len);
      }
      hasPrev = true;
      k += len;
    }
  }

  const lastClusterCol = position;
  if (!stopped) {
    if (hasPrev) position += clusterWidth(clusterStart, sc.vis.length);
    // The last cluster may overhang specEnd (a wide one straddling it).
    if (!endUnbounded && position > specEnd) sawCutEnd = true;
  }
  // Degenerate: something was cut but no room for the ellipsis next to content.
  if (ew > 0 && (!include || (!needStartEllipsis && !needEndEllipsis))
      && (sawCutEnd || (cutStartForEllipsis
        && (position > startBeforeBudget || (hasPrev && lastClusterCol >= startBeforeBudget))))) {
    return ellipsis;
  }
  if (!include) return '';
  let discardedZone = false;
  if (endBudget > 0) {
    if (sawCutEnd) {
      if (inZone) { // the cut is real: drop the zone, restore the state at its start
        runA = -1;
        out.length = zoneMark;
        styles = zoneStyles;
        link = zoneLink;
        discardedZone = true;
      }
    } else {
      needEndEllipsis = false; // no cut after all: the zone content stays
    }
  }
  // Trailing escapes: close-only once the walk reached the end bound,
  // unfiltered when the whole remainder fit.
  if (!stopped && !discardedZone) flushPending(!endUnbounded && position >= specEnd);
  if (link.active) emitStr(link.closePrefix + link.term);
  if (needEndEllipsis) emitStr(ellipsis);
  for (let k = styles.length - 1; k >= 0; k--) { // reverse order; a close shared by
    const close = styles[k].close; //                several slots (22) goes out once
    let dup = false;
    for (let j = styles.length - 1; j > k; j--) if (styles[j].close === close) { dup = true; break; }
    if (!dup) emitStr(close);
  }
  flushRun();
  return out.join('');
}

function _bunShim_sliceAnsi(input, start, end, options, _ambiguousIsNarrow) {
  const s = typeof input === 'string' ? input : `${input}`;
  if (s.length === 0) return '';
  const startD = start === undefined ? 0 : _sa_toInteger(start);
  const endD = end === undefined ? Infinity : _sa_toInteger(end);
  let ellipsis = '';
  if (typeof options === 'string') {
    ellipsis = options;
  } else if (options !== null && (typeof options === 'object' || typeof options === 'function')) {
    const e = options.ellipsis;
    if (typeof e === 'string') ellipsis = e;
    void options.ambiguousIsNarrow; // read like Bun does, so a throwing getter propagates
  }
  // ambiguousIsNarrow (boolean 4th argument, options key, or 5th argument) is
  // accepted and has no effect: see the width note above (KNOWN LIMIT).
  const ew = ellipsis === '' ? 0 : _bunShim_stringWidth(ellipsis);

  // The whole input, no ellipsis: nothing to cut (Bun returns the input itself).
  if (startD === 0 && endD === Infinity && ew === 0) return s;

  // Printable-ASCII fast path: one column per code unit, no escapes. Taken for
  // an all-ASCII input, and for a non-negative range that ends inside the
  // input's printable-ASCII prefix (scanned only to two past `end`).
  const scanTo = startD >= 0 && endD >= 0 && endD !== Infinity ? Math.min(s.length, endD + 2) : s.length;
  let prefix = 0;
  while (prefix < scanTo) {
    const c = s.charCodeAt(prefix);
    if (c < 0x20 || c > 0x7e) break;
    prefix++;
  }
  const wholeAscii = scanTo === s.length && prefix === s.length;
  if (wholeAscii || (startD >= 0 && endD >= 0 && endD < prefix)) {
    const bounds = _sa_bounds(startD, endD, wholeAscii ? s.length : prefix);
    if (bounds === null) return '';
    let [st, en] = bounds;
    const cutStart = bounds[2];
    const cutEnd = wholeAscii ? bounds[3] : true;
    if (!cutStart && !cutEnd) return s;
    if (ew > 0) {
      const doStart = cutStart && ew < en - st;
      if (doStart) st += ew;
      const doEnd = cutEnd && ew < en - st;
      if (doEnd) en -= ew;
      if (!doStart && !doEnd) return ellipsis;
      return (doStart ? ellipsis : '') + s.slice(st, en) + (doEnd ? ellipsis : '');
    }
    return s.slice(st, en);
  }

  const sc = { s, toks: [], pos: 0, vis: '', bound: null, ascii: true, done: false };
  if (startD >= 0 && endD >= 0) {
    // Common case: no width pre-pass; whether `end` cuts anything is found on
    // the way. Anything past twice the length is past any possible width.
    if (startD === Infinity || startD > s.length * 2) return '';
    if (endD === Infinity || endD > s.length * 2) {
      return _sa_walk(sc, startD, Infinity, ellipsis, ew, startD > 0, true, false);
    }
    if (endD <= startD) return '';
    return _sa_walk(sc, startD, endD, ellipsis, ew, startD > 0, false, false);
  }
  // A negative index needs the total width first.
  _sa_produce(sc, Infinity);
  let total = 0;
  if (sc.ascii) {
    total = sc.vis.length;
  } else {
    for (let a = 0, k = 1; k <= sc.vis.length; k++) {
      if (k === sc.vis.length || sc.bound[k]) { total += _sa_clusterWidth(sc.vis, a, k); a = k; }
    }
  }
  const bounds = _sa_bounds(startD, endD, total);
  if (bounds === null) return '';
  // No end cut: walk to EOF, so trailing zero-width clusters and escapes stay.
  return _sa_walk(sc, bounds[0], bounds[3] ? bounds[1] : Infinity, ellipsis, ew, bounds[0] > 0, true, bounds[3]);
}
// --- end Bun.sliceAnsi shim ---------------------------------------------------

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
  sliceAnsi: _bunShim_sliceAnsi,
  sleepSync: _bunShim_sleepSync,
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
  // Bun's built-in image processor (v2.1.266), a sharp-compatible chaining API
  // (new Bun.Image(buf).resize().jpeg()/.png().toBuffer()/.metadata()). Sole
  // call site is the image-attach / clipboard-paste compression pipeline,
  // reached lazily via an async loader (h8() -> new Bun.Image); nothing at
  // startup or in non-image use touches it. A real shim would mean sharp, a
  // heavy native libvips dep that risks SIGILL on this pre-POPCNT CPU, so per
  // the stub-until-it-fires policy it throws for now; if image attachment is
  // wanted here, back it with sharp (its API already matches the call sites).
  Image: class {
    constructor() {
      throw new Error('Bun.Image not supported under Node (image attach/paste needs the native binary or a sharp-backed shim)');
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

// Bun.stdin is a BunFile over the process's own stdin. It is deliberately kept
// OFF globalThis.__bunShim (and out of BUN_SHIM_RE below), so the four-way
// lockstep that treats it as not-generically-shimmed stays intact: its .text()
// form appears inside an inert plugin-scaffolding template (and the VS-Code-only
// `claude edit-hook` path), which the alternation's blind text substitution
// would corrupt. Only the executable reader form Bun.stdin.stream().getReader()
// (v2.1.269's bounded stdin reader) is rewritten, via the dedicated BUN_STDIN_RE.
// --- Bun.stdin shim (dedicated: executable reader form only; see BUN_STDIN_RE) ---
globalThis.__bunShimStdin = {
  // Web ReadableStream<Uint8Array> over process stdin, matching Bun.stdin.stream().
  stream() { return require('stream').Readable.toWeb(process.stdin); },
};
// --- end Bun.stdin shim ---------------------------------------------------------

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
const BUN_SHIM_RE = /(?<!["'`])(?<![A-Za-z0-9_$])Bun\.(YAML|TOML|semver|Terminal|spawn|stringWidth|stripANSI|wrapAnsi|sliceAnsi|sleepSync|which|hash|deepEquals|file|gc|embeddedFiles|JSONL|isStandaloneExecutable|generateHeapSnapshot|Transpiler|listen|serve|connect|build|zstdDecompressSync|zstdDecompress|Image|ant)\b/g;

// Dedicated Bun.stdin rewrite (see the __bunShimStdin comment above). Scoped to
// the single executable form so the inert .text() template is emitted verbatim;
// the loader applies it after BUN_SHIM_RE. update.sh's audit counts this
// getReader form as handled (AUDIT_DEDICATED_BUN) beside the inert .text() form.
const BUN_STDIN_RE = /Bun\.stdin\.stream\(\)\.getReader\(\)/g;

// --- module graph loader -----------------------------------------------------
// Shape check before anything runs: a damaged or absent manifest fails here
// with the directory named, instead of deep inside a chunk with a message
// that names a minified identifier and nothing else (the single-bundle era's
// issue #1, same failure direction).
const { createModuleGraphLoader, installRequireCycleTolerance } = require('./modulegraph-loader.js');
// Bun-faithful require(esm) inside import cycles (see the function's comment
// in modulegraph-loader.js; 2.1.258 needs it for five tools) is only possible
// with Node's internal ESM loader in reach, i.e. under --expose-internals.
// NODE_OPTIONS rejects that flag, so when it is missing this process re-runs
// itself with it and mirrors the child's exit. The wrapper on PATH can pass
// the flag up front to skip the extra process (~1 s on the CPUs in question).
// Signals from the terminal reach the child directly (same process group);
// the parent only has to survive them until the child is done.
if (!installRequireCycleTolerance()) {
  if (process.env.CLAUDE_NODE_NO_REEXEC === '1') {
    console.error('claude-on-node: --expose-internals is not effective; continuing without require-cycle tolerance');
  } else {
    const { spawnSync } = require('child_process');
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(sig, () => {});
    const child = spawnSync(
      process.execPath,
      ['--expose-internals', ...process.execArgv, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, CLAUDE_NODE_NO_REEXEC: '1' } },
    );
    if (child.error) {
      console.error(`claude-on-node: re-exec with --expose-internals failed: ${child.error.message}`);
      process.exit(1);
    }
    if (child.signal) {
      process.removeAllListeners(child.signal);
      process.kill(process.pid, child.signal);
    }
    process.exit(child.status === null ? 1 : child.status);
  }
}
let graph;
try {
  graph = createModuleGraphLoader({ modulesDir, bunShimRegex: BUN_SHIM_RE, bunStdinRegex: BUN_STDIN_RE, bundleRequire });
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
