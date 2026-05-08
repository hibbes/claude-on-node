#!/usr/bin/env bash
# claude-node-update — extract a new Claude Code release's JS bundle from the
# native Bun binary and deploy it under Node (Core2Duo has no AVX/POPCNT).
#
# Usage: claude-node-update [VERSION]        — upgrade to VERSION (default: latest)
#        claude-node-update --dry-run        — run all audits, skip deploy
#        claude-node-update --rollback       — restore most recent backup
#        claude-node-update --list-backups   — list available backups
#
# Performs three safety checks before swapping the live bundle:
#   1. External deps haven't changed (new require() targets → abort)
#   2. No new unguarded Bun.* call sites (→ warn, require --force)
#   3. Extracted bundle has expected header/trailer (→ abort on mismatch)
# After deploy, runs a smoke test — auto-rolls back on failure.

set -euo pipefail

CLAUDE_NODE_DIR="${HOME}/.claude-node"
FORCE=0
DRY_RUN=0
VERSION=""
MODE="update"

for arg in "$@"; do
    case "$arg" in
        --force)         FORCE=1 ;;
        --dry-run)       DRY_RUN=1 ;;
        --rollback)      MODE="rollback" ;;
        --list-backups)  MODE="list" ;;
        -h|--help)
            sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) VERSION="$arg" ;;
    esac
done

# Per-run log file. Without this, auto-rollback's stderr scrolls past in the
# terminal and a regression like v129's transient smoke-test failure leaves no
# forensic trail. We tee stdout+stderr through a log file kept alongside the
# bundle backups, rotated to the last 20 runs.
LOG_DIR="${CLAUDE_NODE_DIR}/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/update-$(date +%Y%m%d-%H%M%S)-$$.log"
# Wrap in subshell + || true — under `set -o pipefail` an empty glob would make
# `ls` exit 2 and abort the whole script before the log even gets written.
(ls -1t "$LOG_DIR"/update-*.log 2>/dev/null | tail -n +21 | xargs -r rm -f) || true
ln -sfn "$(basename "$LOG_FILE")" "$LOG_DIR/latest.log"
exec > >(tee -a "$LOG_FILE") 2>&1
printf '=== claude-node-update run %s (pid %s, args: %s) ===\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$*"

log()  { printf '\033[1;34m[claude-node-update %s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*"; }
warn() { printf '\033[1;33m[claude-node-update %s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*" >&2; }
die()  {
    printf '\033[1;31m[claude-node-update %s]\033[0m %s\n' "$(date '+%H:%M:%S')" "$*" >&2
    printf '\033[1;31m[claude-node-update]\033[0m Full log: %s\n' "$LOG_FILE" >&2
    exit 1
}

smoke_test() {
    # Two probes: --version is cheap, --help exercises ANSI text formatting
    # (Bun.stringWidth, wrapAnsi, stripANSI) — the v128 release added unguarded
    # call sites for those, and a --version-only smoke test let it through.
    # On failure we dump the FULL output (not a head -c 400 slice) into the log
    # so post-mortem after auto-rollback isn't a guessing game.
    local out rc
    set +e; out="$(timeout 30 claude-node --version 2>&1)"; rc=$?; set -e
    if [[ $rc -ne 0 ]]; then
        warn "Smoke test (--version) failed (exit $rc)"
        printf '=== BEGIN --version OUTPUT ===\n%s\n=== END --version OUTPUT ===\n' "$out" >&2
        return 1
    fi
    log "  --version: $out"
    set +e; out="$(timeout 30 claude-node --help 2>&1)"; rc=$?; set -e
    if [[ $rc -ne 0 ]]; then
        warn "Smoke test (--help) failed (exit $rc)"
        printf '=== BEGIN --help OUTPUT ===\n%s\n=== END --help OUTPUT ===\n' "$out" >&2
        return 1
    fi
    if ! grep -q 'Usage:' <<<"$out"; then
        warn "Smoke test (--help) produced no 'Usage:' line — bundle likely broken"
        printf '=== BEGIN --help OUTPUT ===\n%s\n=== END --help OUTPUT ===\n' "$out" >&2
        return 1
    fi
    log "  --help: ok ($(wc -l <<<"$out") lines)"
    return 0
}

list_backups() {
    local backups
    mapfile -t backups < <(ls -1t "$CLAUDE_NODE_DIR"/bundle.js.v*.bak 2>/dev/null || true)
    if [[ ${#backups[@]} -eq 0 ]]; then
        echo "(no backups found in $CLAUDE_NODE_DIR)"
        return 1
    fi
    for b in "${backups[@]}"; do
        local v ts
        v="$(basename "$b" | sed -E 's/^bundle\.js\.v(.+)\.bak$/\1/')"
        ts="$(stat -c %y "$b" | cut -d'.' -f1)"
        printf '  %s  →  v%s\n' "$ts" "$v"
    done
}

rollback() {
    local target="${1:-}"
    local backup
    if [[ -n "$target" ]]; then
        backup="$CLAUDE_NODE_DIR/bundle.js.v${target}.bak"
        [[ -f "$backup" ]] || die "No backup for version $target"
    else
        backup="$(ls -1t "$CLAUDE_NODE_DIR"/bundle.js.v*.bak 2>/dev/null | head -1)"
        [[ -n "$backup" ]] || die "No backups available in $CLAUDE_NODE_DIR"
    fi
    local v
    v="$(basename "$backup" | sed -E 's/^bundle\.js\.v(.+)\.bak$/\1/')"
    log "Rolling back to v$v (from $backup)…"
    cp "$backup" "$CLAUDE_NODE_DIR/bundle.js"
    local tmp
    tmp="$(mktemp)"
    jq --arg v "$v" '.version = $v' "$CLAUDE_NODE_DIR/package.json" > "$tmp"
    mv "$tmp" "$CLAUDE_NODE_DIR/package.json"
    sed -i -E "s|Run Claude Code [0-9.]+'s JS bundle|Run Claude Code ${v}'s JS bundle|" \
        "$CLAUDE_NODE_DIR/launcher.js"
    log "✅ Rolled back to v$v"
}

if [[ "$MODE" == "list" ]]; then
    list_backups
    exit 0
fi

if [[ "$MODE" == "rollback" ]]; then
    rollback "$VERSION"
    exit 0
fi

if [[ -z "$VERSION" ]]; then
    log "Resolving latest version from npm…"
    VERSION="$(npm view @anthropic-ai/claude-code version)"
    [[ -n "$VERSION" ]] || die "Could not resolve latest version"
fi
log "Target version: $VERSION"

CURRENT="$(jq -r .version "$CLAUDE_NODE_DIR/package.json" 2>/dev/null || echo 'unknown')"
log "Currently deployed: $CURRENT"

if [[ "$CURRENT" == "$VERSION" && "$FORCE" -eq 0 ]]; then
    log "Already up-to-date. (use --force to reinstall)"
    exit 0
fi

WORK="$(mktemp -d -t claude-node-update.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

log "Downloading @anthropic-ai/claude-code-linux-x64@${VERSION}…"
npm pack "@anthropic-ai/claude-code-linux-x64@${VERSION}" >/dev/null
TARBALL="$(ls anthropic-ai-claude-code-linux-x64-*.tgz | head -1)"
[[ -n "$TARBALL" ]] || die "npm pack produced no tarball"
tar xzf "$TARBALL"
[[ -f package/claude ]] || die "package/claude missing in tarball"

log "Dumping .bun ELF section…"
objcopy --dump-section .bun=claude.bun package/claude 2>/dev/null \
    || die "objcopy failed (is it a Bun SFE?)"
[[ -s claude.bun ]] || die "claude.bun is empty"

log "Extracting JS bundle (anchored to cli.js header)…"
# Pre-2.1.133 the cli.js bundle sat at fixed offset 0x1b0 in the .bun section.
# v2.1.133 prepends ~111 MB of precompiled bytecode and packs extra worker
# bundles (image-processor.js, audio-capture.js) into the same section, so the
# offset now floats. Anchor on the bunfs path immediately followed by the
# `// @bun` header — the worker bundles carry the same `// @bun` marker but
# different path prefixes, so the path is what disambiguates.
python3 - <<'PY'
data = open('claude.bun', 'rb').read()
prefix = b'/$bunfs/root/src/entrypoints/cli.js\x00'
i = data.find(prefix + b'// @bun')
if i == -1:
    raise SystemExit("cli.js bundle marker not found in .bun section "
                     "(expected '/$bunfs/root/src/entrypoints/cli.js\\0// @bun')")
start = i + len(prefix)
end = start
while end < len(data) and (32 <= data[end] <= 126 or data[end] in (9, 10, 13)):
    end += 1
open('bundle.js', 'wb').write(data[start:end])
print(f"extracted {end - start} bytes (start at 0x{start:x})")
PY
[[ -s bundle.js ]] || die "bundle.js is empty"

log "Header/trailer sanity check…"
HEAD="$(head -c 80 bundle.js)"
TAIL="$(tail -c 8 bundle.js)"
if ! [[ "$HEAD" == *"@bun"* ]] \
   || ! [[ "$HEAD" =~ function\(exports,[[:space:]]*require,[[:space:]]*module ]]; then
    die "Bundle header mismatch — extraction offset may have changed.
     Got: $HEAD"
fi
if ! [[ "$TAIL" == *"})"* ]]; then
    die "Bundle trailer not '})' — extraction incomplete. Got: '$TAIL'"
fi
log "  ✓ header + trailer match"

log "External require() audit (vs package.json)…"
mapfile -t REQS < <(
    grep -oE 'require\("[^"]+"\)' bundle.js \
        | sed -E 's/^require\("([^"]+)"\)$/\1/' \
        | grep -vE '^(node:|\./|/)' \
        | grep -vE '^(fs|path|os|util|crypto|http|https|url|child_process|stream|events|buffer|assert|zlib|net|tls|dns|readline|worker_threads|module|v8|perf_hooks|tty|string_decoder|timers|async_hooks|querystring|process|cluster|repl|inspector|vm|constants|dgram|punycode|trace_events|http2|domain|console)(/.*)?$' \
        | sort -u
)
log "  Bundle requires: ${REQS[*]}"

DECLARED=$(jq -r '.dependencies | keys[]' "$CLAUDE_NODE_DIR/package.json" | sort -u)
log "  Declared deps: $(echo $DECLARED | tr '\n' ' ')"

# Reduce a require specifier to its root package name.
#   @scope/name/sub  → @scope/name
#   name/sub         → name
pkg_root() {
    local r="$1"
    if [[ "$r" == @*/* ]]; then
        local rest="${r#*/}"
        printf '%s/%s' "${r%%/*}" "${rest%%/*}"
    else
        printf '%s' "${r%%/*}"
    fi
}

MISSING=()
for r in "${REQS[@]}"; do
    # Skip bun:* — these are guarded in-bundle.
    [[ "$r" == bun:* ]] && continue
    root="$(pkg_root "$r")"
    if ! grep -qxF "$root" <<<"$DECLARED"; then
        MISSING+=("$root")
    fi
done
# Deduplicate MISSING (multiple subpaths of the same missing pkg collapse).
if [[ ${#MISSING[@]} -gt 0 ]]; then
    mapfile -t MISSING < <(printf '%s\n' "${MISSING[@]}" | sort -u)
fi
if [[ ${#MISSING[@]} -gt 0 ]]; then
    warn "NEW external deps detected: ${MISSING[*]}"
    if [[ "$FORCE" -eq 0 ]]; then
        die "Add these to $CLAUDE_NODE_DIR/package.json, run npm install, then re-run with --force"
    fi
    warn "Continuing because --force was passed."
fi
log "  ✓ dep audit clean"

log "Unguarded Bun.* call-site audit…"
# For every Bun.<symbol> occurrence, look at a ±200-char window around it for
# a guard (typeof Bun, typeof globalThis.Bun). Flag a symbol if *any* occurrence
# is unguarded — even one direct call (e.g. `function w8(H){return Bun.X(H)}`)
# is enough to throw ReferenceError under Node, regardless of how many other
# sites are well-guarded. v128 broke the previous "any guarded → safe" heuristic
# by inlining minifier-extracted thunks for symbols already in SHIMMED_BUN, so
# we now classify each site individually and rely solely on launcher.js's
# source-replace to redirect them.
#
# SHIMMED_BUN must stay in lockstep with launcher.js's source-replace regex
# (the alternation in `src.replace(/Bun\.(...)\b/g, '__bunShim.$1')`).
SHIMMED_BUN=(
    # Real Node-equivalent implementations:
    Bun.YAML Bun.semver Bun.Terminal Bun.spawn
    Bun.stringWidth Bun.stripANSI Bun.wrapAnsi Bun.which Bun.hash
    # Inert under Node (no-op / empty / undefined):
    Bun.gc Bun.embeddedFiles Bun.JSONL
    # Throws on first use (rare paths: REPL, heap-dump, bg-pty TCP host):
    Bun.generateHeapSnapshot Bun.Transpiler Bun.listen
)
mapfile -t BUN_HITS < <(
python3 - <<'PY'
import re
src = open('bundle.js').read()
guard_re = re.compile(r'typeof\s+(?:globalThis\.)?Bun')
sym_re = re.compile(r'Bun\.[A-Za-z_]+')
flagged = set()
for m in sym_re.finditer(src):
    pos = m.start()
    window = src[max(0, pos-200):pos+200]
    if not guard_re.search(window):
        flagged.add(m.group(0))
for s in sorted(flagged):
    print(s)
PY
)
NEW_BUN=()
for h in "${BUN_HITS[@]}"; do
    if ! printf '%s\n' "${SHIMMED_BUN[@]}" | grep -qxF "$h"; then
        NEW_BUN+=("$h")
    fi
done
if [[ ${#NEW_BUN[@]} -gt 0 ]]; then
    warn "NEW unguarded Bun.* call sites: ${NEW_BUN[*]}"
    warn "Add shims in launcher.js (globalThis.__bunShim + source-replace regex)"
    warn "and extend SHIMMED_BUN here in lockstep, then re-run."
    if [[ "$FORCE" -eq 0 ]]; then
        die "Investigate, add shims if needed, then re-run with --force"
    fi
    warn "Continuing because --force was passed."
fi
log "  ✓ Bun audit clean (shimmed: ${SHIMMED_BUN[*]})"

if [[ "$DRY_RUN" -eq 1 ]]; then
    log "✅ Dry-run complete — all audits passed for v${VERSION}. No changes made."
    log "   Extracted bundle: $WORK/bundle.js ($(stat -c %s "$WORK/bundle.js") bytes)"
    exit 0
fi

log "Backing up current bundle…"
cp "$CLAUDE_NODE_DIR/bundle.js" "$CLAUDE_NODE_DIR/bundle.js.v${CURRENT}.bak"
log "  → bundle.js.v${CURRENT}.bak"

log "Deploying new bundle…"
cp bundle.js "$CLAUDE_NODE_DIR/bundle.js"

log "Bumping package.json version…"
tmp="$(mktemp)"
jq --arg v "$VERSION" '.version = $v' "$CLAUDE_NODE_DIR/package.json" > "$tmp"
mv "$tmp" "$CLAUDE_NODE_DIR/package.json"

log "Updating launcher.js version comment…"
sed -i -E "s|Run Claude Code [0-9.]+'s JS bundle|Run Claude Code ${VERSION}'s JS bundle|" \
    "$CLAUDE_NODE_DIR/launcher.js"

log "Running smoke test (claude-node --version)…"
if ! smoke_test; then
    warn "❌ Smoke test failed — auto-rolling back to v${CURRENT}"
    rollback "$CURRENT"
    die "Update aborted. Bundle reverted. Inspect $CLAUDE_NODE_DIR/bundle.js.v${CURRENT}.bak vs. new candidate manually."
fi
log "  ✓ smoke test passed"

log "Bumping global npm package too (for version-reporting parity)…"
if ! npm i -g "@anthropic-ai/claude-code@${VERSION}" >/dev/null 2>&1; then
    warn "Global npm install failed — not fatal, claude-node will still work."
fi

log "✅ Updated $CURRENT → $VERSION"
log "   Backup: $CLAUDE_NODE_DIR/bundle.js.v${CURRENT}.bak"
log "   Rollback: claude-node-update --rollback"
log "   Log: $LOG_FILE"
