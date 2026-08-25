#!/usr/bin/env python3
"""Extract every module of a Claude Code release from the Bun standalone
module graph embedded in the native binary's `.bun` ELF section.

Usage: extract-modulegraph.py CLAUDE_BUN --out DIR [--audit-concat FILE] [--version V]

Reads the dumped `.bun` section (objcopy --dump-section .bun=FILE), parses the
StandaloneModuleGraph table, and writes one file per module into DIR plus a
DIR/_index.json manifest the loader (modulegraph-loader.js) consumes.

Section layout, verified against claude-code-linux-x64 2.1.245 (the first
release shipping the split, bytecode-tagged graph instead of one CJS bundle):

  [0..8)          u64 LE: byte count of everything after this header
  [8..)           payload: module names, module contents, bytecode blobs, ...
  ...             module table: N entries x 52 bytes (13 u32 LE each)
  ...             64 bytes of u32 words, of which
                    [10] = table offset, [11] = table byte length,
                    [12] = entry point index into the table
  tail            b"\\n---- Bun! ----\\n"

Every StringPointer offset in the table and in the trailer words is relative
to byte 8 (i.e. to the payload, not the section start). A table entry's first
four words are name.off, name.len, contents.off, contents.len; the remaining
words carry sourcemap / bytecode pointers and flags the loader does not need.
`contents` of a JS module is its SOURCE TEXT (a `// @bun @bytecode` comment
header followed by minified ESM); the precompiled bytecode is a separate blob
the `@bytecode` tag refers to. Assets (*.asset, *.node, vendored *.min.js) are
table entries too, without the `// @bun` header.

Exit status: 0 on success, 2 on any format violation (nothing is written on
a violation detected before extraction starts; a violation mid-table leaves a
partial DIR behind, which update.sh discards with its work directory).
"""
import argparse
import json
import os
import struct
import sys

TRAILER = b"\n---- Bun! ----\n"
BASE = 8            # StringPointer offsets are relative to after the header
ENTRY_SIZE = 52     # 13 x u32 per module table entry
ROOT = "/$bunfs/root/"
JS_HEADER = b"// @bun"


class FormatError(Exception):
    pass


def parse(data):
    n = len(data)
    if n < BASE + 64 + len(TRAILER):
        raise FormatError(f"section too small ({n} bytes)")
    if not data.endswith(TRAILER):
        raise FormatError("no Bun trailer at end of section")
    count_hdr = struct.unpack_from("<Q", data, 0)[0]
    if count_hdr != n - BASE:
        raise FormatError(f"header byte count {count_hdr} != section size - 8 ({n - BASE})")
    tr = n - len(TRAILER)
    words = struct.unpack_from("<16I", data, tr - 64)
    tab_off, tab_len, entry_id = words[10], words[11], words[12]
    if tab_len == 0 or tab_len % ENTRY_SIZE != 0:
        raise FormatError(f"module table length {tab_len} is not a multiple of {ENTRY_SIZE}")
    tab_abs = BASE + tab_off
    if tab_abs + tab_len > tr:
        raise FormatError("module table runs past the trailer")
    count = tab_len // ENTRY_SIZE
    if entry_id >= count:
        raise FormatError(f"entry point index {entry_id} out of range (table has {count} entries)")

    modules = []
    for i in range(count):
        f = struct.unpack_from("<13I", data, tab_abs + i * ENTRY_SIZE)
        n_off, n_len, c_off, c_len = BASE + f[0], f[1], BASE + f[2], f[3]
        if n_off + n_len > tr or c_off + c_len > tr:
            raise FormatError(f"entry {i}: string pointer out of bounds")
        try:
            name = data[n_off:n_off + n_len].decode("utf-8")
        except UnicodeDecodeError:
            raise FormatError(f"entry {i}: module name is not UTF-8")
        if not name.startswith(ROOT) or len(name) == len(ROOT):
            raise FormatError(f"entry {i}: unexpected module name {name!r}")
        body = data[c_off:c_off + c_len]
        modules.append((i, name, body))
    return entry_id, modules


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("bunfile")
    ap.add_argument("--out", required=True, help="output directory (created)")
    ap.add_argument("--audit-concat", help="also write all JS module sources concatenated here")
    ap.add_argument("--version", default=None, help="release version to record in _index.json")
    args = ap.parse_args(argv)

    with open(args.bunfile, "rb") as fh:
        data = fh.read()
    try:
        entry_id, modules = parse(data)
    except FormatError as e:
        print(f"extract-modulegraph: {e}", file=sys.stderr)
        return 2

    os.makedirs(args.out, exist_ok=True)
    index = []
    concat = open(args.audit_concat, "wb") if args.audit_concat else None
    js_count = js_bytes = 0
    entry_path = None
    for i, name, body in modules:
        rel = name[len(ROOT):]
        safe = rel.replace("/", "__")
        with open(os.path.join(args.out, safe), "wb") as fh:
            fh.write(body)
        is_js = body.startswith(JS_HEADER)
        if is_js:
            js_count += 1
            js_bytes += len(body)
            if concat:
                concat.write(body)
                concat.write(b"\n")
        if i == entry_id:
            entry_path = name
            if not is_js:
                print(f"extract-modulegraph: entry point {name} is not a JS module", file=sys.stderr)
                return 2
        index.append({"path": name, "file": safe, "bytes": len(body), "js": is_js})
    if concat:
        concat.close()
    manifest = {
        "format": 1,
        "version": args.version,
        "entry": entry_path,
        "entry_index": entry_id,
        "modules": index,
    }
    with open(os.path.join(args.out, "_index.json"), "w") as fh:
        json.dump(manifest, fh, indent=1)
    print(f"extracted {len(index)} modules ({js_count} JS, {js_bytes:,} bytes of source; "
          f"{len(index) - js_count} assets); entry {entry_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
