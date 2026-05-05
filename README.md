# claude-on-node

Run [Anthropic's Claude Code CLI](https://www.npmjs.com/package/@anthropic-ai/claude-code) under plain Node.js on machines where the official Bun-compiled binary won't boot — typically older x86_64 CPUs without AVX2/POPCNT (Core2Duo, early Nehalem) where Bun crashes with `SIGILL` on startup.

## What it does

Anthropic ships `claude` as a Bun single-file executable. The actual logic is a JavaScript bundle embedded in a `.bun` ELF section. This repo:

1. **Extracts** the JS bundle from the Bun SFE (`objcopy --dump-section`)
2. **Runs** it under Node via a thin loader (`launcher.js`)
3. **Shims** the small set of Bun-only APIs the bundle uses (YAML, semver, PTY) with their Node equivalents
4. **Audits** new releases before deploying — refuses updates that introduce unguarded Bun.* call sites without a known shim, or new `require()` targets that aren't in `package.json`

## Layout

```
~/.claude-node/
  bundle.js              # extracted JS bundle (gitignored, fetched per release)
  bundle.js.v*.bak       # rollback backups (gitignored)
  launcher.js            # Node loader + Bun shim
  update.sh              # updater (symlinked as claude-node-update in PATH)
  package.json           # external deps the bundle requires under Node
```

The recommended setup keeps the working tree at `~/.claude-node/` and a wrapper script `claude-node` (PATH) that does `node ~/.claude-node/launcher.js "$@"`.

## Bun shim coverage (current)

Source-replaced in `launcher.js` before `eval`:

| Bun API | Mapped to | Notes |
|---|---|---|
| `Bun.YAML.parse` / `stringify` | `yaml` package | for skill/agent/output-style frontmatter |
| `Bun.semver.order` / `satisfies` | `semver` package | version comparisons |
| `Bun.Terminal` + `Bun.spawn(opts.terminal)` | `node-pty` | background PTY sessions |

Other `Bun.*` references in the bundle (`Bun.spawn` non-PTY, `Bun.gc`, `Bun.which`, etc.) live inside `typeof Bun<"u"` guards, so under Node those branches never execute and need no shim.

The audit list lives in `update.sh` (`KNOWN_BUN`); add new symbols there with a dated comment when you ship a shim.

## Usage

```sh
claude-node-update                  # fetch latest from npm, audit, deploy
claude-node-update --dry-run        # audit only, no deploy
claude-node-update 2.1.128          # pin to a specific version
claude-node-update --rollback       # restore most recent backup
claude-node-update --list-backups   # show available backups
claude-node-update --force          # bypass audit (use with care)
```

After a successful deploy, a smoke test runs `claude-node --version`. On failure, the previous bundle is auto-restored.

## Why source-replace and not `globalThis.Bun = {...}`

The bundle uses `typeof Bun<"u"` in ~20 places to decide between Bun-native and Node fallbacks. Defining a global `Bun` object would flip all those guards to true and route execution into Bun-only code paths whose Node fallbacks would no longer run. Replacing the four targeted symbols at load time keeps the existing guards working as intended.

## Security notes

- The updater runs `npm view`/`npm pack`/`npm install` against the public registry. It does not authenticate and does not transmit any local state.
- Bundle source is verified via header (`@bun` + `function(exports, require, module`) and trailer (`})`). Mismatch aborts the update.
- The dep audit refuses new `require()` targets not declared in `package.json`. Override only with `--force` after manual review.
- Backups are kept in-place. There is no remote backup; rollbacks are local.

This is a personal-use tool. The Anthropic bundle itself is not redistributed here — it's fetched from npm at update time.
