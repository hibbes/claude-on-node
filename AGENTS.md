# Agent notes for claude-on-node

What this project is, how it works, and what is covered by which shim lives in
`README.md`; the symbol tables there are mechanically gated by
`test/lockstep.test.js`. This file carries only the constraints an agent cannot
infer from the code, plus the traps that have actually bitten.

## Hard constraints

1. **Never run or install the native `claude` binary here, and never "verify" a
   shim against real Bun.** The CPUs this project exists for cannot execute the
   Bun SFE (SIGILL on startup); that is the entire reason the repo exists.
   Installing `@anthropic-ai/claude-code-linux-x64` to "fix" something bricks
   the working setup. Shims are calibrated against Bun's published docs and
   pinned by the unit suites, nothing else.
2. **`modules-*/` (and the `modules` symlink) hold extracted proprietary
   Anthropic code**, as `bundle.js` did before the module-graph rework. Never
   commit them, never quote module source into tracked files, never weaken
   `.gitignore`. The release is fetched from npm at update time only.
3. **No `npm ci`.** It rebuilds `node-pty`'s prebuilt native binary. Use
   `npm install` for new deps and `npm update <pkg>` for in-range bumps; plain
   `npm install` will NOT move a package the lockfile pins, even when a newer
   version satisfies the range. Verify security bumps on disk
   (`node -p "require('./node_modules/<pkg>/package.json').version"`), not via
   `npm audit`, which reads only the lockfile.
4. **Shim discipline.** Once a symbol is in `SHIMMED_BUN`, the release audit
   stops flagging its new call sites, so a throws-stub on a cheap, well-defined
   API is a silent landmine; give those real implementations. Deliberate
   deviations from Bun's docs belong in a KNOWN LIMIT test, not in prose.
5. **Every new test must be mutation-tested**: break exactly the line the test
   protects, watch exactly the intended case fail, revert, check `git status`.
   A green test that cannot go red is documentation that lies with authority.
   This is not hypothetical here: a doc-derived suite in this repo shipped two
   divergences a docs-derived rewrite later caught, and the tests that would
   have caught them earlier only ever lived in a temp directory and were lost.
6. **`npm test` gates deploys** (update.sh runs it before swapping bundles) and
   test suites extract shim blocks from `launcher.js` via their
   `// --- <name> shim` BEGIN/END markers, so the tested code is the shipped
   code. Renaming a marker fails the suite loudly; keep it that way.
7. **The `claude-node` wrapper script on PATH may carry local modifications
   that `update.sh` never touches.** After any reinstall or reset of the
   setup, re-apply them, or behavior silently reverts (effort level,
   auto-updater suppression).
8. **Some hosts wrap `grep` with ugrep**, which rejects `-oE`/`-oc`. When
   probing the module graph, use `python3` or `command grep`.
9. **Never delete or rewrite a `modules-<ver>/` directory that `modules`
   points at, or that a running session started from.** Chunks are imported
   lazily; a session keeps reading the directory it resolved at startup.
   `update.sh` moves an existing directory aside (`*.replaced-*`) rather than
   overwriting it, and rotation skips the live target. Keep it that way.

## Editing rules

- Counts and version claims in `README.md` are gated by `test/lockstep.test.js`
  (symbol tables, "All N symbols", the Node floor, backer names). If you change
  one side, the gate tells you the other; do not silence the gate, fix the
  drift. Do not add NEW ungated counts anywhere.
- Commit messages in this repo carry the reasoning (what release changed, what
  the audit caught, how it was verified); keep that standard.
