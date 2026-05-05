#!/usr/bin/env node
// Run Claude Code 2.1.128's JS bundle under Node (no Bun needed).
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
// The bundle has unguarded Bun.* call sites that aren't inside `typeof Bun<"u"`
// branches. Defining globalThis.Bun is not viable: it would flip ~20 existing
// `typeof Bun<"u"` guards from false to true and break their Node fallbacks.
// Instead we source-replace just the four affected symbols and route them to
// Node-equivalent implementations:
//
//   Bun.YAML.{parse,stringify}    -> yaml package
//   Bun.semver.{order,satisfies}  -> semver package
//   Bun.Terminal + Bun.spawn(opts.terminal:T) -> node-pty
//
// Other Bun.spawn call sites in the bundle live inside typeof-Bun guards, so
// under Node those branches never execute and the rename is harmless.
const bundleRequire = Module.createRequire(bundlePath);
const yamlMod = bundleRequire('yaml');
const semverMod = bundleRequire('semver');

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
};

// Source-replace just the four targeted symbols. Lookbehind ensures we don't
// accidentally rewrite identifiers ending in "Bun" (none in the bundle today,
// but cheap insurance against future minifier collisions).
src = src.replace(
  /(?<![A-Za-z0-9_$])Bun\.(YAML|semver|Terminal|spawn)\b/g,
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
