# claude-on-node

Run [Anthropic's Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) under plain Node.js on machines where the official Bun-compiled binary won't boot — typically older x86_64 CPUs without AVX2/POPCNT (Core2Duo, early Nehalem) where Bun crashes with `SIGILL` on startup.

## What it does

Anthropic ships `claude` as a Bun single-file executable. The actual logic is a JavaScript bundle embedded in a `.bun` ELF section. This repo:

1. **Extracts** the JS bundle from the Bun SFE (`objcopy --dump-section`, then anchors on the in-section `cli.js` path marker)
2. **Runs** it under Node via a thin loader (`launcher.js`)
3. **Shims** the Bun-only APIs the bundle uses (YAML, semver, PTY, ANSI text metrics, hashing, …) with Node equivalents, by source-replacing each `Bun.<symbol>` before `eval`
4. **Audits** new releases before deploying — refuses updates that introduce unguarded `Bun.*` call sites without a known shim, or new `require()` targets that aren't declared in `package.json`

## Layout

```
~/.claude-node/
  bundle.js              # extracted JS bundle (gitignored, fetched per release)
  bundle.js.v*.bak       # rollback backups (gitignored)
  launcher.js            # Node loader + Bun shim
  update.sh              # updater (symlinked as claude-node-update in PATH)
  package.json           # deps: Bun-shim backers + the bundle's own require() targets
  package-lock.json      # pinned dependency tree
  logs/                  # per-run updater logs (gitignored, last 20 + latest.log)
```

The recommended setup keeps the working tree at `~/.claude-node/` and a wrapper script `claude-node` (PATH) that does `node ~/.claude-node/launcher.js "$@"`.

## Bun shim coverage

All 15 symbols below are source-replaced in `launcher.js` (`Bun.X` → `__bunShim.X`) before the bundle is evaluated. The set must stay in lockstep with `SHIMMED_BUN` in `update.sh`, which the release audit checks against.

**Real Node-equivalent implementations:**

| Bun API | Mapped to | Notes |
|---|---|---|
| `Bun.YAML.parse` / `stringify` | `yaml` | skill/agent/output-style frontmatter |
| `Bun.semver.order` / `satisfies` | `semver` | version comparisons |
| `Bun.Terminal` + `Bun.spawn(opts.terminal)` | `node-pty` | background PTY sessions (non-PTY `Bun.spawn` throws — no such call site exists today) |
| `Bun.stringWidth` | `string-width` | ANSI-aware width for help/UI layout |
| `Bun.stripANSI` | `strip-ansi` | |
| `Bun.wrapAnsi` | `wrap-ansi` | |
| `Bun.which` | `which` | executable lookup |
| `Bun.hash` | 64-bit FNV-1a (BigInt) | cache-key derivation; only `.toString()` shape is observed, so exact Wyhash parity isn't needed |

**Inert under Node** (the Node code path doesn't depend on them):

| Bun API | Shimmed as |
|---|---|
| `Bun.gc` | no-op |
| `Bun.embeddedFiles` | `[]` (embedded-bundle mode stays off) |
| `Bun.JSONL` | `undefined` |

**Throw on first use** (rare paths only — REPL, heap-dump, background-PTY TCP host): `Bun.generateHeapSnapshot`, `Bun.Transpiler`, `Bun.listen`.

A separate `AUDIT_INERT_BUN` map in `update.sh` whitelists `Bun.*` symbols that appear **only** as inert string-literal content the bundle emits verbatim (e.g. `Bun.stdin` inside a scaffolded hook-handler template). Those are deliberately **not** shimmed — source-replacing them would corrupt the emitted template — and the audit accepts them only while every occurrence still matches a recorded context fingerprint.

`launcher.js` also forces `USE_BUILTIN_RIPGREP=0` so the bundle uses the system `rg` via `which`, instead of a build-time-baked `/home/runner/work/...` path that doesn't exist on a real install.

## Dependencies

The `package.json` deps are mostly of two kinds:

- **Shim backers** — Node packages the loader wires into `__bunShim`: `yaml`, `semver`, `node-pty`, `string-width`, `strip-ansi`, `wrap-ansi`, `which`.
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

## Security notes

- The updater runs `npm view`/`npm pack`/`npm install` against the public registry. It does not authenticate and does not transmit any local state.
- Bundle source is verified via header (`@bun` + `function(exports, require, module`) and trailer (`})`). A mismatch aborts the update before anything is swapped.
- The dep audit refuses new `require()` targets not declared in `package.json`; the `Bun.*` audit refuses new unguarded call sites without a shim. Continue past either only with `--force` after manual review.
- Backups are kept in-place. There is no remote backup; rollbacks are local.

This is a personal-use tool. The Anthropic bundle itself is **not** redistributed here — it's fetched from npm at update time.
