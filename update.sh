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

dump_forensics() {
    # Capture system state on smoke-test failure. Previous post-mortems (v136
    # 2026-05-08, v137 2026-05-09) were guessing games because the log only
    # showed exit 124. With this we'll know if it was I/O contention, swap
    # thrash, or an actual regression.
    {
        printf '=== forensics @ %s ===\n' "$(date '+%H:%M:%S')"
        printf 'loadavg: %s\n' "$(cut -d' ' -f1-3 /proc/loadavg)"
        printf 'memory:\n'; free -h | sed 's/^/  /'
        printf 'top cpu:\n'
        ps -eo pcpu,pmem,rss,etime,comm --sort=-pcpu --no-headers \
            | head -5 | sed 's/^/  /'
    } >&2
}

smoke_test() {
    # Two probes: --version is cheap, --help exercises ANSI text formatting
    # (Bun.stringWidth, wrapAnsi, stripANSI) — the v128 release added unguarded
    # call sites for those, and a --version-only smoke test let it through.
    # On failure we dump the FULL output (not a head -c 400 slice) into the log
    # so post-mortem after auto-rollback isn't a guessing game.
    #
    # IMPORTANT: redirect stdin to /dev/null on every claude-node invocation.
    # The bundle has 15× process.stdin.isTTY checks + 6× setRawMode + 11×
    # stdin.on() listeners. When the updater is launched from a real terminal
    # (anything with a TTY on stdin), the bundle's startup hooks register stdin
    # listeners that keep the event loop alive past process.exit(), even on
    # the --help path that should print and quit. Result: --help hangs until
    # SIGTERM. Earlier "cold page cache" / "concurrent I/O" hypotheses were
    # wrong; the failures were 100 % reproducible with a TTY stdin and 0 % with
    # /dev/null stdin. The pre-warm cat below is harmless on Core2Duo and stays.
    cat "$CLAUDE_NODE_DIR/bundle.js" > /dev/null 2>&1 || true

    local out rc
    set +e; out="$(timeout 30 claude-node --version </dev/null 2>&1)"; rc=$?; set -e
    if [[ $rc -ne 0 ]]; then
        warn "Smoke test (--version) failed (exit $rc)"
        printf '=== BEGIN --version OUTPUT ===\n%s\n=== END --version OUTPUT ===\n' "$out" >&2
        dump_forensics
        return 1
    fi
    log "  --version: $out"

    # --help reads the 14 MB bundle into Node's eval and walks Commander's whole
    # option tree (each option goes through Bun.stringWidth/wrapAnsi). With the
    # </dev/null fix above this lands in ~4 s on this hardware; the 30 s first
    # budget plus 90 s retry are kept as belt-and-suspenders for unexpected
    # I/O contention, not for the (now-fixed) TTY hang.
    local attempt tmo
    for attempt in 1 2; do
        tmo=$(( attempt == 1 ? 30 : 90 ))
        set +e; out="$(timeout "$tmo" claude-node --help </dev/null 2>&1)"; rc=$?; set -e
        if [[ $rc -eq 0 ]] && grep -q 'Usage:' <<<"$out"; then
            log "  --help: ok ($(wc -l <<<"$out") lines, attempt ${attempt}/2)"
            return 0
        fi
        if [[ $attempt -eq 1 ]]; then
            warn "Smoke test (--help) attempt 1/2 failed (exit $rc); retrying with 90 s budget"
            dump_forensics
        fi
    done
    warn "Smoke test (--help) failed both attempts (last exit $rc)"
    printf '=== BEGIN --help OUTPUT (attempt 2) ===\n%s\n=== END --help OUTPUT ===\n' "$out" >&2
    dump_forensics
    return 1
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
    # Keep the lockfile in step with package.json here too, or a rolled-back
    # tree reports two different versions depending on which file you read.
    if [[ -f "$CLAUDE_NODE_DIR/package-lock.json" ]]; then
        tmp="$(mktemp)"
        jq --arg v "$v" '.version = $v | .packages[""].version = $v' \
            "$CLAUDE_NODE_DIR/package-lock.json" > "$tmp"
        mv "$tmp" "$CLAUDE_NODE_DIR/package-lock.json"
    fi
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
# Entries in the .bun section are NUL-separated: the cli.js payload is followed
# by \x00 and then the next path ("\x00/$bunfs/root/image-processor.js\x00//
# @bun"). Cut on that terminator. The previous boundary scanned forward while
# bytes stayed printable ASCII, which lands on the same offset only because Bun
# currently escapes non-ASCII to \uXXXX: one raw byte >= 0x80 anywhere in the
# bundle would have cut it short there, and a truncation whose last 8 bytes
# happen to contain "})" slips past the trailer check below (~1.6% of cut
# points). Verified identical output on 2.1.113 / .133 / .167 / .206 / .212.
end = data.find(b'\x00', start)
if end == -1:
    raise SystemExit("no NUL terminator after the cli.js bundle "
                     "(.bun section truncated?)")
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
    Bun.YAML Bun.TOML Bun.semver Bun.Terminal Bun.spawn
    Bun.stringWidth Bun.stripANSI Bun.wrapAnsi Bun.which Bun.hash Bun.deepEquals
    Bun.file
    # Inert under Node (no-op / empty / undefined / false):
    Bun.gc Bun.embeddedFiles Bun.JSONL Bun.isStandaloneExecutable
    # Throws on first use (rare paths: REPL, heap-dump, agent-proxy relay, gateway):
    Bun.generateHeapSnapshot Bun.Transpiler Bun.listen Bun.serve Bun.connect
    # Anthropic-private native namespace (Proxy; members audited separately below):
    Bun.ant
)

# Bun.* symbols the regex audit sees but that are NOT executable call sites:
# they sit inside string literals the bundle emits verbatim as file content
# (plugin scaffolding templates), so they never run under Node. Deliberately
# NOT shimmed — routing them through launcher.js's source-replace would rewrite
# the emitted template text and corrupt the file a user gets when scaffolding a
# plugin. Each entry maps the symbol to a context fingerprint (which must
# contain the symbol exactly once); the audit below requires EVERY occurrence
# of the symbol to sit inside that fingerprint, so a future *executable* use —
# or just a reworded template — diverges the counts and re-trips the audit
# instead of being silently waved through.
#   Bun.stdin — v2.1.141, inside $p5()'s on-session-start.ts hook-handler template
declare -A AUDIT_INERT_BUN=(
    [Bun.stdin]='new Response(Bun.stdin.stream()).text()'
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
INERT_BUN=()
for h in "${BUN_HITS[@]}"; do
    # Already redirected by launcher.js's source-replace shim.
    if printf '%s\n' "${SHIMMED_BUN[@]}" | grep -qxF "$h"; then
        continue
    fi
    # Symbol verified-inert (string-literal content only)? Accept only when
    # EVERY occurrence sits inside its recorded context fingerprint; otherwise
    # a new or executable use has appeared, so fall through to NEW_BUN and re-flag.
    if [[ -n "${AUDIT_INERT_BUN[$h]+set}" ]]; then
        fp="${AUDIT_INERT_BUN[$h]}"
        set +e
        sym_n=$(grep -oF -- "$h" bundle.js | wc -l)
        fp_n=$(grep -oF -- "$fp" bundle.js | wc -l)
        set -e
        if [[ "$fp_n" -gt 0 && "$sym_n" -eq "$fp_n" ]]; then
            INERT_BUN+=("$h")
            continue
        fi
        warn "$h was classified inert but no longer matches its recorded context"
        warn "  expected all ${sym_n} occurrence(s) inside: ${fp}"
        warn "  matched ${fp_n} — inspect the bundle and update AUDIT_INERT_BUN"
    fi
    NEW_BUN+=("$h")
done
if [[ ${#INERT_BUN[@]} -gt 0 ]]; then
    log "  note: ${INERT_BUN[*]} present only as inert string-literal content (not executed)"
fi
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

log "Bun.ant member audit…"
# Bun.ant (v2.1.219) is a NAMESPACE of Anthropic-private natives, not a single
# API. The symbol audit above only ever sees the token `Bun.ant`, so once that
# entered SHIMMED_BUN, a release growing a new member (Bun.ant.newThing) would
# deploy without any audit noticing. This block closes that hole at the member
# level: every Bun.ant.<member> spelling in the bundle must be one launcher.js
# knowingly shims (today: throws into the call sites' own try/catch fallbacks,
# the same degradation the pre-2.1.219 bun:ffi paths had under Node).
#
# ANT_MEMBERS must stay in lockstep with _bunShim_antMembers in launcher.js;
# test/lockstep.test.js enforces that pairing. Runtime backstop for spellings
# this text-level scan cannot see (minifier aliasing like `let a=Bun.ant`):
# the shim Proxy throws loudly on any unknown member read.
ANT_MEMBERS=( getPeerUid setDumpable )
mapfile -t ANT_HITS < <(
python3 - <<'PY'
import re
src = open('bundle.js').read()
for s in sorted(set(m.group(1) for m in re.finditer(r'Bun\.ant\.([A-Za-z_$][A-Za-z0-9_$]*)', src))):
    print(s)
PY
)
NEW_ANT=()
for m in "${ANT_HITS[@]}"; do
    if ! printf '%s\n' "${ANT_MEMBERS[@]}" | grep -qxF "$m"; then
        NEW_ANT+=("Bun.ant.$m")
    fi
done
if [[ ${#NEW_ANT[@]} -gt 0 ]]; then
    warn "NEW Bun.ant members: ${NEW_ANT[*]}"
    warn "Extend _bunShim_antMembers in launcher.js and ANT_MEMBERS here in"
    warn "lockstep (decide throw vs. real impl from the call site's fallback)."
    if [[ "$FORCE" -eq 0 ]]; then
        die "Investigate, add member shims if needed, then re-run with --force"
    fi
    warn "Continuing because --force was passed."
fi
log "  ✓ Bun.ant member audit clean (members: ${ANT_HITS[*]:-none} / known: ${ANT_MEMBERS[*]})"

# Shim backers must be resolvable, and the smoke test cannot prove it: it only
# reaches the EAGER requires. Two blind spots meet here: the dep audit above reads
# require() targets out of bundle.js only, so a launcher-side backer never
# appears in it, and `--version`/`--help` only exercise the EAGER requires at the
# top of launcher.js. A lazily required backer (smol-toml for Bun.TOML, node-pty
# for the PTY path) can therefore be missing from node_modules while every audit
# and both smoke probes pass, and the failure surfaces months later on the first
# `claude import` or background terminal. npm ci, npm prune, a partial
# node_modules restore or a fresh machine all produce exactly that state, and
# this script never runs npm install itself.
#
# Runs here, alongside the audits and BEFORE anything is backed up or swapped,
# so a failure aborts with the deployed tree untouched and needs no rollback.
# --dry-run reaches this too, which is the point: it should validate everything
# that does not require the new bundle to be live.
log "Shim-backer resolvability check…"
BACKERS=$(grep -oE "bundleRequire\('[^']+'\)" "$CLAUDE_NODE_DIR/launcher.js" \
    | sed -E "s|bundleRequire\('([^']+)'\)|\1|" | sort -u)
[[ -n "$BACKERS" ]] || die "No bundleRequire() backers found in launcher.js — did the loader change shape?"
MISSING_BACKERS=()
while read -r m; do
    [[ -n "$m" ]] || continue
    node -e "require.resolve('$m', {paths:['$CLAUDE_NODE_DIR']})" 2>/dev/null \
        || MISSING_BACKERS+=("$m")
done <<< "$BACKERS"
if [[ ${#MISSING_BACKERS[@]} -gt 0 ]]; then
    warn "❌ Shim backers not resolvable: ${MISSING_BACKERS[*]}"
    die "Run 'npm install' in $CLAUDE_NODE_DIR, then re-run. (Nothing was changed.)"
fi
log "  ✓ all backers resolvable ($(echo $BACKERS | tr '\n' ' '))"

# The committed suites assert the shim invariants (four-way symbol lockstep,
# Bun.file and Bun.TOML semantics). They do not depend on the release being
# fetched, so running them here means a launcher.js that was hand-edited into an
# inconsistent state blocks the deploy instead of shipping. Fail-safe: aborting
# leaves the working version in place.
if [[ -d "$CLAUDE_NODE_DIR/test" ]]; then
    log "Running shim test suites…"
    if ! (cd "$CLAUDE_NODE_DIR" && npm test >/dev/null 2>&1); then
        warn "❌ Shim test suites failed — refusing to deploy over a broken launcher."
        warn "   Reproduce with: cd $CLAUDE_NODE_DIR && npm test"
        die "Update aborted. Nothing was changed."
    fi
    log "  ✓ shim test suites passed"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
    log "✅ Dry-run complete — all audits passed for v${VERSION}. No changes made."
    log "   Extracted bundle: $WORK/bundle.js ($(stat -c %s "$WORK/bundle.js") bytes)"
    exit 0
fi

# NOTE: on a fresh clone / first-time deploy, package.json can already record
# a version (e.g. committed by whoever last maintained the tree) while
# bundle.js has never actually been written to disk on THIS machine. In that
# case CURRENT == VERSION is possible too (handled above by --force), but even
# on a genuine version bump there may simply be no prior bundle.js yet. Guard
# the backup so first-time deploys don't abort on a missing source file.
if [[ -f "$CLAUDE_NODE_DIR/bundle.js" ]]; then
    log "Backing up current bundle…"
    cp "$CLAUDE_NODE_DIR/bundle.js" "$CLAUDE_NODE_DIR/bundle.js.v${CURRENT}.bak"
    log "  → bundle.js.v${CURRENT}.bak"
else
    log "No existing bundle to back up (first-time deploy)."
fi

# Rotate bundle backups to the newest 5, mirroring the log rotation above.
# Unbounded, this had grown to 59 files / 916 MB by 2026-07-19, gaining
# ~20 MB per nightly release; five backups cover every realistic rollback
# (the nightly auto-rollback needs exactly one). Same pipefail trap as the
# log rotation: an empty glob makes `ls` exit 2, so subshell + || true.
(ls -1t "$CLAUDE_NODE_DIR"/bundle.js.v*.bak 2>/dev/null | tail -n +6 | xargs -r rm -f) || true

log "Deploying new bundle…"
cp bundle.js "$CLAUDE_NODE_DIR/bundle.js"

log "Bumping package.json version…"
tmp="$(mktemp)"
jq --arg v "$VERSION" '.version = $v' "$CLAUDE_NODE_DIR/package.json" > "$tmp"
mv "$tmp" "$CLAUDE_NODE_DIR/package.json"

# package-lock.json carries the same version in two places and was NOT stamped
# here until 2026-07-19, so it drifted silently for ~50 releases (found at
# 2.1.160 while package.json said 2.1.212). Keep both in step, or `npm ci`
# and every tool that trusts the lockfile reports a version this tree hasn't
# run since April.
if [[ -f "$CLAUDE_NODE_DIR/package-lock.json" ]]; then
    log "Bumping package-lock.json version…"
    tmp="$(mktemp)"
    jq --arg v "$VERSION" '.version = $v | .packages[""].version = $v' \
        "$CLAUDE_NODE_DIR/package-lock.json" > "$tmp"
    mv "$tmp" "$CLAUDE_NODE_DIR/package-lock.json"
fi

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

# --- plugin support -----------------------------------------------------------
maybe_setup_plugins() {
    local shim="$CLAUDE_NODE_DIR/plugin-shim.js"
    local dispatcher="$CLAUDE_NODE_DIR/bin/bun"
    if ! [[ -f "$shim" ]]; then
        warn "plugin-shim.js not found — plugin subprocess support will not work."
        return
    fi
    if ! [[ -x "$dispatcher" ]]; then
        chmod +x "$dispatcher" 2>/dev/null || true
    fi
    # Validate the shim can load (spawn a quick probe, don't --require on this
    # shell's node — a broken shim printed a diagnostic that users miss in CI).
    if node -e "
        require('fs').readFileSync('${shim}','utf8').indexOf('globalThis.__bunShim = {') > -1
    " 2>/dev/null; then
        :
    else
        warn "plugin-shim.js looks damaged — it does not contain the expected __bunShim marker."
        warn "  Check $shim and re-deploy if needed."
        return
    fi
    log "  ✓ plugin-shim.js present"

    # Suggest PATH setup for the bun dispatcher if it isn't already on PATH.
    local bun_resolved
    bun_resolved="$(command -v bun 2>/dev/null || true)"
    if [[ -z "$bun_resolved" ]]; then
        log "  Plugin support: symlink bin/bun into your PATH."
        log "    ln -s $dispatcher ~/.local/bin/bun"
    elif [[ "$bun_resolved" != "$dispatcher" ]]; then
        log "  Note: existing 'bun' on PATH ($bun_resolved) is not our dispatcher."
        log "    If Claude Code plugins should route through Node, symlink our version:"
        log "    ln -sf $dispatcher ~/.local/bin/bun"
    else
        log "  ✓ bun dispatcher on PATH"
    fi
}
maybe_setup_plugins

log "✅ Updated $CURRENT → $VERSION"
log "   Backup: $CLAUDE_NODE_DIR/bundle.js.v${CURRENT}.bak"
log "   Rollback: claude-node-update --rollback"
log "   Log: $LOG_FILE"
