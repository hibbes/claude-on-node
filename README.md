# claude-on-node

Run [Anthropic's Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) under plain Node.js on machines where the official Bun-compiled binary won't boot — typically older x86_64 CPUs without AVX2/POPCNT (Core2Duo, early Nehalem) where Bun crashes with `SIGILL` on startup.

## What it does

Anthropic ships `claude` as a Bun single-file executable. The actual logic is a JavaScript bundle embedded in a `.bun` ELF section. This repo:

1. **Extracts** the JS bundle from the Bun SFE (`objcopy --dump-section`, then anchors on the in-section `cli.js` path marker)
2. **Runs** it under Node via a thin loader (`launcher.js`)
3. **Shims** the Bun-only APIs the bundle uses (YAML, TOML, semver, PTY, ANSI text metrics, hashing, file I/O, …) with Node equivalents, by source-replacing each `Bun.<symbol>` before `eval`
4. **Audits** new releases before deploying — refuses updates that introduce unguarded `Bun.*` call sites without a known shim, or new `require()` targets that aren't declared in `package.json`

## Requirements

**Node 24.0.0 or newer.** The bundle contains `using` declarations (Explicit
Resource Management), a form V8 only parses from Node 24 on. Older Node fails to
parse the entire bundle and reports only the minified variable name of the first
such declaration, e.g. `SyntaxError: Unexpected identifier 'K'`, with a stack
pointing into `launcher.js` (see issue #1). Measured against bundle 2.1.212:

| Node | Result |
|------|--------|
| 20.20.2 | fails to parse |
| 22.23.1 | fails to parse |
| 23.11.1 | fails to parse |
| 24.0.0 (V8 13.6.233.8) | parses |
| 24.18.0 | parses |

Note that Anthropic's own package declares `node >=22.0.0`. That covers their
native binary and its npm wrapper, not running the extracted bundle under Node,
so it is not a usable floor here. `launcher.js` checks the running version and
exits with an explanatory message rather than letting the parse fail.

Also needed: `objcopy` (binutils) and `npm` for the updater.

## Layout

```
~/.claude-node/
  bundle.js              # extracted JS bundle (gitignored, fetched per release)
  bundle.js.v*.bak       # rollback backups (gitignored)
  launcher.js            # Node loader + Bun shim
  plugin-shim.js         # Bun API shim for plugin subprocesses (--require'd)
  update.sh              # updater (symlinked as claude-node-update in PATH)
  package.json           # deps: Bun-shim backers + the bundle's own require() targets
  package-lock.json      # pinned dependency tree
  bin/
    bun                  # bun PATH dispatcher for plugin subprocesses
  test/                  # shim + invariant tests, `npm test` (no framework, no dev deps)
  logs/                  # per-run updater logs (gitignored, last 20 + latest.log)
```

The recommended setup keeps the working tree at `~/.claude-node/` and a wrapper script `claude-node` (PATH) that does `node ~/.claude-node/launcher.js "$@"`.

## Plugin subprocess support

Claude Code plugins spawn subprocesses with `bun run --cwd <plugin-dir>`. On machines without a working Bun binary this fails. Two files provide a Bun-free path:

- **`bin/bun`** — A `bun` PATH dispatcher that intercepts `bun run --cwd <dir>` and runs the plugin entry point under `node` with `--require` pointing to the plugin shim. Symlink to a PATH directory:
  ```sh
  ln -s ~/.claude-node/bin/bun ~/.local/bin/bun
  ```
  Supports `bun run --cwd <dir>` (resolves `main`/`bin` from `package.json`), `bun run --cwd <dir> <file> [args...]`, `bun --version`, and `bun --help`.

- **`plugin-shim.js`** — Loaded via `node --require`, this reads `launcher.js` from the same directory, evals its preamble and all shim blocks (stopping before the source-replace + bundle eval), then defines `globalThis.Bun` so plugin code can call `Bun.X` directly. Because the shim code comes from the same `launcher.js` the main CLI uses, any new Bun symbol shimmed in a future update is automatically available to plugins — no extra maintenance.

  Unlike the main launcher's source-replace strategy (which keeps `typeof Bun<"u"` guards working by only rewriting specific symbols), plugin subprocesses are fresh Node processes that never see the bundle's `typeof Bun` guards. Defining the full `globalThis.Bun` object is correct here — plugins just need `Bun.file`, `Bun.YAML`, etc. to resolve.

## Bun shim coverage

All 22 symbols below are source-replaced in `launcher.js` (`Bun.X` → `__bunShim.X`) before the bundle is evaluated. The set must stay in lockstep with `SHIMMED_BUN` in `update.sh`, which the release audit checks against.

**Real Node-equivalent implementations:**

| Bun API | Mapped to | Notes |
|---|---|---|
| `Bun.YAML.parse` / `stringify` | `yaml` | skill/agent/output-style frontmatter |
| `Bun.TOML.parse` | `smol-toml` (lazy) | `claude import` reads Codex `config.toml` / `prompts/*.toml`. See the deviation note below |
| `Bun.semver.order` / `satisfies` | `semver` | version comparisons |
| `Bun.Terminal` + `Bun.spawn(opts.terminal)` | `node-pty` | background PTY sessions |
| `Bun.spawn` (non-PTY) | `child_process` | background workers (bg-pty-host, spare pool, bridge sessions) and the rg version probe. Subprocess subset per [Bun's docs](https://bun.com/docs/api/spawn): array or `{cmd}` form, per-fd defaults, `argv0`/`detached`/`timeout`/`killSignal`/`onExit`, stdio specs `pipe`/`ignore`/`inherit`/fd/`BunFile` (opened synchronously, so errno failures throw out of `Bun.spawn` as the breadcrumb call site expects; own fds closed after spawn), stdout/stderr as real web `ReadableStream`s with `text()`/`json()`/`bytes()` readers, stdin as a `FileSink` subset. `ipc` throws rather than shipping half a channel. A missing executable resolves `exited` to `-1` with a warning instead of Bun's synchronous throw (KNOWN LIMIT, pinned in the suite) |
| `Bun.stringWidth` | `string-width` | ANSI-aware width for help/UI layout; printable-ASCII fast path plus bounded memo cache so multi-MB tool_results (base64 screenshots) cannot stall Ink rendering on slow CPUs |
| `Bun.stripANSI` | `strip-ansi` | |
| `Bun.wrapAnsi` | `wrap-ansi` | |
| `Bun.which` | `which` | executable lookup |
| `Bun.hash` | 64-bit FNV-1a (BigInt) | cache-key derivation; only `.toString()` shape is observed, so exact Wyhash parity isn't needed |
| `Bun.deepEquals` | hand-rolled deep equality | matches `expect().toEqual()` (non-strict) and `toStrictEqual()` semantics |
| `Bun.file` | lazy `fs`-backed `BunFile` subset (`Blob` subclass) | `exists`/`text`/`json`/`bytes`/`arrayBuffer`/`stream`/`writer`/`delete`; `slice()` throws rather than silently returning an empty blob. Per Bun's docs: `exists()` is false for directories, the default MIME type is `text/plain;charset=utf-8`, an explicit text-ish `type` comes back charset-suffixed, and `bytes()` copies rather than viewing (a view would expose Node's shared `Buffer` pool through `.buffer`) |

`Bun.TOML` deviates from real Bun in two deliberate, documented ways, both toward accepting more valid TOML:

- **Date/times** come back as strings of their source text, per [Bun's docs](https://bun.com/docs/runtime/toml). `smol-toml` returns `TomlDate` objects, so the shim flattens them; since `TomlDate` doesn't retain the source spelling and always canonicalizes milliseconds in, a redundant `.000` is dropped. Real Bun currently *throws* on any datetime ([oven-sh/bun#28687](https://github.com/oven-sh/bun/issues/28687)), an acknowledged parser bug we don't reproduce.
- **64-bit integers** parse via `integersAsBigInt: "asNeeded"`. `smol-toml`'s default *rejects* integers outside the 53-bit safe range even though TOML 1.0 mandates 64-bit support; with `asNeeded` the safe range stays plain `number` and only wider values become `BigInt`.

**Inert under Node** (the Node code path doesn't depend on them):

| Bun API | Shimmed as |
|---|---|
| `Bun.gc` | no-op |
| `Bun.embeddedFiles` | `[]` (embedded-bundle mode stays off) |
| `Bun.JSONL` | `undefined` |
| `Bun.isStandaloneExecutable` | `false` (a *value*, not a function: the call site is `Bun.isStandaloneExecutable===!0`, and a function object would be truthy) |

**Throw on first use** (rare paths only: REPL, heap-dump, agent-proxy relay, `claude gateway`): `Bun.generateHeapSnapshot`, `Bun.Transpiler`, `Bun.listen`, `Bun.serve`, `Bun.connect`, and every member of the `Bun.ant` namespace (next paragraph).

`Bun.ant` (since v2.1.219) is not public Bun API but a namespace of Anthropic-private natives in their custom Bun build. Known members: `getPeerUid` (SO_PEERCRED peer-uid lookup on the local daemon socket), `getPeerPid` (SO_PEERCRED peer-pid lookup on the same socket, added v2.1.226) and `setDumpable` (prctl `PR_SET_DUMPABLE` core-dump hardening). Node core exposes neither syscall, and before v2.1.219 the same call sites went through `bun:ffi`, whose `require()` throws under Node into the same in-bundle try/catch fallbacks, so throwing is behavior-preserving. Because the release audit's symbol regex only ever sees the token `Bun.ant`, `update.sh` additionally audits the bundle's `Bun.ant.<member>` spellings against its `ANT_MEMBERS` list, and the shim is a Proxy that throws on any *unknown* member read: a plain object would return a silent `undefined`, which for a property read is silently wrong (the `Bun.isStandaloneExecutable` lesson). Generic object protocols (symbol keys, `then`, `toJSON`) pass through quietly so logging, `await` and `JSON.stringify` cannot crash far from any `Bun.ant` context.

Note that once a symbol is in `SHIMMED_BUN` the audit no longer flags *new* call sites for it. That is why symbols with a cheap, well-defined Node equivalent (`Bun.file`, `Bun.TOML`) get a real implementation even when today's only call site is cold: a throws-stub would become a silent landmine as soon as a future release grows a second, hotter site.

A separate `AUDIT_INERT_BUN` map in `update.sh` whitelists `Bun.*` symbols that appear **only** as inert string-literal content the bundle emits verbatim (e.g. `Bun.stdin` inside a scaffolded hook-handler template). Those are deliberately **not** shimmed — source-replacing them would corrupt the emitted template — and the audit accepts them only while every occurrence still matches a recorded context fingerprint.

`launcher.js` also forces `USE_BUILTIN_RIPGREP=0` so the bundle uses the system `rg` via `which`, instead of a build-time-baked `/home/runner/work/...` path that doesn't exist on a real install.

### Tests

```
npm install       # once: the suites exercise the shims' real npm backers
npm test          # runs every test/*.test.js
```

No test framework and no dev dependencies, and `bundle.js` is not needed (the suites resolve modules relative to it but never read it), so the tests run on a clone without a deployed release. They do need `node_modules`, because a shim is tested through the package that backs it rather than through a mock.

- **`test/lockstep.test.js`** enforces the invariants that are silent when they break. Every shimmed symbol must appear in all four places it has to: the source-replace regex, the `__bunShim` object behind it, `SHIMMED_BUN` in `update.sh`, and the coverage tables above. The worst drift direction is a symbol in `SHIMMED_BUN` that nothing rewrites, because the audit then stays quiet while a bare `Bun.X` reaches the eval'd bundle and throws `ReferenceError` on first use; the README direction is the one that actually happened, sitting stale at 15 symbols for four releases. `SHIMMED_BUN` is read by handing the array to `bash` rather than by regex, so quoting and word-splitting agree with `update.sh` by construction. The same file also asserts that every `bundleRequire()` backer resolves (see below).
- **`test/bunfile-shim.test.js`** covers the `Bun.file` shim (55 cases): input forms, lazy construction, positioned `fd` reads, MIME mapping, `writer()`, `stream()`, and the deliberate `slice()` throw.
- **`test/toml-shim.test.js`** covers the `Bun.TOML` shim (51 cases), including the documented limits of the date round-trip.
- **`test/spawn-shim.test.js`** covers the non-PTY `Bun.spawn` shim (20 cases, POSIX-only): the exact shapes of the bundle's call sites (rg probe, bg-pty-host breadcrumb, spare pool), stream readers, fd ownership, signal/ENOENT degradation, and a guard that fails loudly if an `unref()`d child drains the event loop before the report runs.
- **`test/plugin-shim.test.js`** verifies that loading `plugin-shim.js` via `node --require` correctly sets up `globalThis.Bun` with the shimmed API surface (27 probes: namespace presence, YAML round-trip, file construction, hash, inert values, throw-on-use symbols, and Bun.ant members).

A lazily required shim backer is invisible to **both** deploy gates: the dep audit reads `require()` targets out of `bundle.js` only, so a launcher-side package never appears in it, and the smoke test exercises only the eager requires at the top of `launcher.js`. `smol-toml` and `node-pty` are both lazy, so `npm ci`, `npm prune`, a partial `node_modules` restore or a fresh machine could produce a tree that passes every audit and both smoke probes and then fails when a user runs `claude import` or opens a background terminal. `update.sh` therefore asserts backer resolvability before the smoke test, and `npm test` asserts it too.

Shim suites extract the implementation from `launcher.js` between its `// --- <name> shim` / `// --- end <name> shim` markers and `eval` it, so the code under test is the shipped code rather than a copy that can drift. Renaming or dropping a marker makes the suite fail loudly instead of silently testing nothing. Since real Bun can never run on the hardware this project targets, a shim's semantics can only be calibrated against Bun's documentation and pinned down by cases like these, so any deliberate deviation belongs in a test with the reasoning next to it.

## Dependencies

The `package.json` deps are mostly of two kinds:

- **Shim backers** — Node packages the loader wires into `__bunShim`: `yaml`, `smol-toml`, `semver`, `node-pty`, `string-width`, `strip-ansi`, `wrap-ansi`, `which`. (`smol-toml` is `require()`d lazily on first `Bun.TOML.parse`, so it costs nothing at startup.)
- **The bundle's own `require()` targets** — modules the bundle imports directly under Node: `ajv` (+ `ajv-formats`), `undici`, `ws`, and — **since v2.1.160** — `react` + `react-dom` (`react-dom/client`).

(`node-fetch` looks orphaned — the dep audit never lists it — because it's reached via a dynamic **`import("node-fetch")`**, not a static `require()`, inside the vendored `gaxios` HTTP client (Google-auth code paths). Under Node that lazy branch is the one taken (`window` is undefined), so it's a real conditional runtime dep and must stay. Pinned to v2 for CommonJS default-export compatibility. Caveat: the updater's require()-audit cannot see dynamic imports — a future bundle that adds a new `import()`-only dep would deploy without being flagged.)

React is pinned to **19** (`^19.2.0`). The bundle is built against React 19, not 18 — it references React-19-only exports (`useActionState`, `useOptimistic`) and the 19-era internals symbol, and uses `createRoot` with no legacy `render`. `react` and `react-dom` must resolve to the **same** version (react-dom enforces a runtime version-match check). If a future release bumps the React major, determine it from the extracted bundle (internals symbol + hook names), don't guess.

## Usage

```sh
claude-node-update                  # fetch latest from npm, audit, deploy
claude-node-update --dry-run        # run all audits, no deploy
claude-node-update 2.1.160          # pin to a specific version
claude-node-update --rollback       # restore most recent backup
claude-node-update --list-backups   # show available backups
claude-node-update --force          # continue past audit warnings (use after manual review)
```

When the dep audit reports a **new** `require()` target (as v2.1.160 did with React), add the package(s) to `package.json`, run `npm install`, then re-run the updater — `--force` is not needed once the dep is declared.

After a successful deploy a smoke test runs both `claude-node --version` and `claude-node --help` (the `--help` path exercises the ANSI text-metric shims that a `--version`-only test would miss). On failure the previous bundle is auto-restored and the full probe output is kept in `logs/`.

## Why source-replace and not `globalThis.Bun = {...}`

The bundle uses `typeof Bun<"u"` in ~20 places to choose between Bun-native and Node fallbacks. Defining a global `Bun` object would flip all those guards to true and route execution into Bun-only code paths whose Node fallbacks would then never run. Source-replacing only the shimmed symbols keeps the existing guards working as intended. (AST rewriting would be more robust against minifier aliasing but adds a 15 MB parse at every startup and its own breakage surface — not worth it for a personal tool.)

## Bundle compatibility notes

The shape of the extracted bundle can change between Claude Code releases. Notable ones the loader/updater had to adapt to:

- **v2.1.128** — the minifier inlined unguarded `Bun.*` thunks that earlier releases only used behind `typeof Bun` guards. The audit switched to per-call-site classification and the shim set grew to 15 symbols.
- **v2.1.133** — the `.bun` ELF section was restructured (~111 MB of precompiled bytecode prepended, plus extra worker bundles), so the `cli.js` offset floats. The extractor now anchors on the `/$bunfs/root/src/entrypoints/cli.js` path marker instead of a fixed offset.
- **v2.1.138** — interactive-stdin smoke-test hang root-caused; the updater now redirects stdin to `/dev/null` for every probe.
- **v2.1.141** — `Bun.stdin` appeared as inert template-string content; handled via the `AUDIT_INERT_BUN` carve-out rather than a shim.
- **v2.1.160** — React was externalized: the bundle now `require()`s `react` + `react-dom` (+ `react-dom/client`) instead of having React baked into the Bun binary. Declared in `package.json` and pinned to React 19.
- **v2.1.167** — first unguarded `Bun.deepEquals`; shimmed with a hand-rolled deep equality (no Node builtin matches Bun's non-strict mode — `util.isDeepStrictEqual` is strict and uses `Object.is`).
- **v2.1.195** — `Bun.serve` (the `claude gateway` HTTP server) arrived: the first *feature*-level Bun-only API rather than a utility. Left as a throws-stub, because the same subsystem's `Bun.SQL` site is gated in-bundle behind `typeof Bun>"u" → throw "claude gateway requires the native binary"`.
- **v2.1.198** — `Bun.isStandaloneExecutable` appeared as a *property* read, not a call. Shimmed as the value `false`; a `() => false` stub would be truthy and route into standalone/embedded mode.
- **v2.1.201** — `Bun.file` replaced an `fs.openSync` call site. Given a real `fs`-backed shim rather than a stub, since the audit stops flagging new sites once a symbol is shimmed.
- **v2.1.214** — `Bun.TOML.parse` arrived with the `claude import` migration feature (importing OpenAI Codex / Gemini CLI config). Backed by `smol-toml`; see the deviation notes under *Bun shim coverage*.
- **v2.1.217**: first unguarded `Bun.connect`, the direct-dial (CONNECT) client of the agent-proxy selective relay. Left as a throws-stub: its only caller sits inside the relay's request handling, and the relay's server is the `Bun.listen` site that already throws under Node, so the dial-out is unreachable by construction.
- **v2.1.219**: `Bun.ant` arrived, a namespace of Anthropic-private natives (members `getPeerUid` and `setDumpable`, both migrated from `bun:ffi` call sites whose callers degrade in-bundle). Shimmed as a Proxy that throws per member, plus a member-level release audit (`ANT_MEMBERS` in `update.sh`), because the symbol-level audit stops seeing new members once `Bun.ant` itself is in `SHIMMED_BUN`.
- **v2.1.220 (runtime finding, not a release audit)**: the background-worker subsystem (bg-pty-host, spare pool, bridge sessions) started exercising **non-PTY** `Bun.spawn` in normal operation, four days after the release deployed cleanly. The May-era throws-stub then crashed every worker spawn and eventually session startup ("worker crashed … respawning"). This is the release audit's documented blind spot: new call sites of an already-shimmed symbol are deliberately accepted, and only operation can surface them. The non-PTY branch is now a real `child_process`-backed implementation (see the coverage table); the stub policy (throw until a stub actually fires in normal use, then build the real shim) concluded as designed.
- **v2.1.226**: `Bun.ant.getPeerPid` joined the namespace, the peer-pid sibling of `getPeerUid` at a new `[peer-cred]` call site. Same throws-stub treatment (SO_PEERCRED has no Node core equivalent, and the caller catches, warns and returns undefined), caught by the member-level `ANT_MEMBERS` audit rather than the symbol audit, which stops seeing new `Bun.ant` members once the namespace itself is shimmed.

## Security notes

- The updater runs `npm view`/`npm pack`/`npm install` against the public registry. It does not authenticate and does not transmit any local state.
- Bundle source is verified via header (`@bun` + `function(exports, require, module`) and trailer (`})`). A mismatch aborts the update before anything is swapped.
- The dep audit refuses new `require()` targets not declared in `package.json`; the `Bun.*` audit refuses new unguarded call sites without a shim. Continue past either only with `--force` after manual review.
- Backups are kept in-place. There is no remote backup; rollbacks are local.

This is a personal-use tool. The Anthropic bundle itself is **not** redistributed here — it's fetched from npm at update time.
