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

log()  { printf '\033[1;34m[claude-node-update]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[claude-node-update]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[claude-node-update]\033[0m %s\n' "$*" >&2; exit 1; }

smoke_test() {
    # Boot claude-node and ask for --version. If it SIGILLs or throws, fail.
    local out
    if ! out="$(timeout 30 claude-node --version 2>&1)"; then
        warn "Smoke test output: $out"
        return 1
    fi
    log "  Smoke test output: $out"
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

log "Extracting JS bundle from offset 0x1b0…"
python3 - <<'PY'
data = open('claude.bun', 'rb').read()
start = 0x1b0
if start >= len(data):
    raise SystemExit(f"bundle too short: {len(data)} bytes")
end = start
while end < len(data) and (32 <= data[end] <= 126 or data[end] in (9, 10, 13)):
    end += 1
open('bundle.js', 'wb').write(data[start:end])
print(f"extracted {end - start} bytes")
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
# a guard (typeof Bun, typeof globalThis.Bun, Bun?.). Flag a symbol only if
# *no* occurrence is guarded. Symbols already audited manually live in
# KNOWN_BUN and are skipped.
KNOWN_BUN=(
    Bun.spawn Bun.listen Bun.Transpiler
    # Audited 2026-04-22 (v2.1.117): all guarded via typeof / typeof globalThis.Bun.
    Bun.gc Bun.JSONL Bun.stringWidth Bun.which
    Bun.embeddedFiles Bun.hash Bun.stripANSI Bun.wrapAnsi
    # Support call-sites referenced inside the same guarded branches.
    Bun.generateHeapSnapshot
    # Audited 2026-05-05 (v2.1.128): shimmed in launcher.js via source-replace.
    #   Bun.YAML.*    -> yaml package
    #   Bun.semver.*  -> semver package
    #   Bun.Terminal + Bun.spawn(opts.terminal) -> node-pty
    # Bundle wraps Terminal+spawn in try{}, so missing shim degrades to
    # spawnPty=undefined and a clean "Bun.Terminal unavailable" error.
    Bun.YAML Bun.semver Bun.Terminal
)
mapfile -t BUN_HITS < <(
python3 - <<'PY'
import re
src = open('bundle.js').read()
guard_re = re.compile(r'typeof\s+(?:globalThis\.)?Bun|Bun\?\.')
sym_re = re.compile(r'Bun\.[A-Za-z_]+')
flagged = set()
by_sym = {}
for m in sym_re.finditer(src):
    by_sym.setdefault(m.group(0), []).append(m.start())
for sym, positions in by_sym.items():
    any_guarded = False
    for pos in positions:
        window = src[max(0, pos-200):pos+200]
        if guard_re.search(window):
            any_guarded = True
            break
    if not any_guarded:
        flagged.add(sym)
for s in sorted(flagged):
    print(s)
PY
)
NEW_BUN=()
for h in "${BUN_HITS[@]}"; do
    if ! printf '%s\n' "${KNOWN_BUN[@]}" | grep -qxF "$h"; then
        NEW_BUN+=("$h")
    fi
done
if [[ ${#NEW_BUN[@]} -gt 0 ]]; then
    warn "NEW unguarded Bun.* call sites: ${NEW_BUN[*]}"
    warn "These may need shims in launcher.js. Check ungeguardete-Bun-Calls section in memory."
    if [[ "$FORCE" -eq 0 ]]; then
        die "Investigate, add shims if needed, then re-run with --force"
    fi
    warn "Continuing because --force was passed."
fi
log "  ✓ Bun audit clean (known: ${KNOWN_BUN[*]})"

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
