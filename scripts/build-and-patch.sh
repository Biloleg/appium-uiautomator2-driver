#!/usr/bin/env bash
#
# build-and-patch.sh
#
# Build the project and produce a patch-package-style patch describing the
# delta between the current working tree (lib/ + freshly built build/lib/) and
# a clean upstream base. Output paths are prefixed with
# `node_modules/appium-uiautomator2-driver/` so the patch drops straight into
# any downstream project's `patches/` directory and is consumed by
# `patch-package` on `postinstall`.
#
# Usage:
#   scripts/build-and-patch.sh [BASE_REF] [OUT_PATH]
#
# Defaults:
#   BASE_REF  = upstream release tag / commit matching the version in
#               package.json. If not found, falls back to `b4ac21c`
#               (chore(release): 7.2.2).
#   OUT_PATH  = scripts/appium-uiautomator2-driver+<version>.patch
#
# Examples:
#   scripts/build-and-patch.sh
#   scripts/build-and-patch.sh b4ac21c
#   scripts/build-and-patch.sh origin/master /tmp/my.patch
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BASE_REF="${1:-}"
OUT_PATH="${2:-}"

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"

# ---------------------------------------------------------------------------
# 1. Resolve the base ref.
# ---------------------------------------------------------------------------
if [[ -z "$BASE_REF" ]]; then
  # Try to locate a commit whose subject matches the published version
  # (semantic-release commits look like: "chore(release): X.Y.Z [skip ci]").
  BASE_REF="$(git log --all --format=%H --grep="chore(release): ${PKG_VERSION}" -1 || true)"
  if [[ -z "$BASE_REF" ]]; then
    echo "[build-and-patch] No commit found for version ${PKG_VERSION}, falling back to 7.2.2 (b4ac21c)"
    BASE_REF="b4ac21c"
  fi
fi

if ! git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1; then
  echo "[build-and-patch] ERROR: base ref '$BASE_REF' is not a valid commit" >&2
  exit 1
fi
BASE_SHA="$(git rev-parse --short "${BASE_REF}^{commit}")"

if [[ -z "$OUT_PATH" ]]; then
  OUT_PATH="${ROOT}/scripts/${PKG_NAME}+${PKG_VERSION}.patch"
fi

echo "[build-and-patch] Package: ${PKG_NAME}@${PKG_VERSION}"
echo "[build-and-patch] Base ref: ${BASE_REF} (${BASE_SHA})"
echo "[build-and-patch] Output:   ${OUT_PATH}"

# ---------------------------------------------------------------------------
# 2. Build the current working tree.
# ---------------------------------------------------------------------------
echo "[build-and-patch] Building current working tree..."
npx --no-install tsc -b --clean >/dev/null 2>&1 || true
npx --no-install tsc -b
echo "[build-and-patch] Build complete."

# ---------------------------------------------------------------------------
# 3. Materialize a clean copy of the base ref in a temp directory and build
#    it there, so we can diff like-for-like (lib/ + build/lib/).
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d -t uia2-base.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
echo "[build-and-patch] Materializing base ref into ${WORK_DIR}..."

# Use a worktree so we share the object database (fast, no clone).
git worktree add --quiet --detach "$WORK_DIR" "$BASE_REF"
# Always remove the worktree on exit too.
trap 'git worktree remove --force "$WORK_DIR" >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"' EXIT

# Reuse this project's node_modules to avoid a full reinstall.
if [[ -d "${ROOT}/node_modules" ]]; then
  ln -s "${ROOT}/node_modules" "${WORK_DIR}/node_modules"
else
  echo "[build-and-patch] WARNING: ${ROOT}/node_modules missing — running 'npm ci' in worktree" >&2
  ( cd "$WORK_DIR" && npm ci --no-audit --no-fund --prefer-offline )
fi

echo "[build-and-patch] Building base ref..."
( cd "$WORK_DIR" && npx --no-install tsc -b --clean >/dev/null 2>&1 || true )
( cd "$WORK_DIR" && npx --no-install tsc -b )

# ---------------------------------------------------------------------------
# 4. Diff current lib/ and build/ against the freshly built base, then
#    rewrite paths so the patch is consumable by patch-package.
# ---------------------------------------------------------------------------
echo "[build-and-patch] Computing diff..."

RAW_DIFF="$(mktemp -t uia2-rawdiff.XXXXXX)"
# We use plain `diff -urN` (not git diff) so the new build/ artifacts (which
# are gitignored in the worktree) are included. -N treats missing files as
# empty so additions and deletions are captured. Binary files (rare here)
# are emitted as "Binary files differ" — patch-package can handle text only,
# but the package's build output is text JS/.d.ts/.map.
diff -urN \
  --exclude='.git' \
  --exclude='tsconfig.tsbuildinfo' \
  --label "a/PLACEHOLDER" --label "b/PLACEHOLDER" \
  /dev/null /dev/null >/dev/null 2>&1 || true   # warm up diff

# Actually run the diffs for the two trees we care about.
{
  diff -urN \
    "${WORK_DIR}/lib" "${ROOT}/lib" \
    || true
  diff -urN \
    --exclude='tsconfig.tsbuildinfo' \
    "${WORK_DIR}/build" "${ROOT}/build" \
    || true
} > "$RAW_DIFF"

# Rewrite the file headers from the absolute temp paths into
# `a/node_modules/<pkg>/...` and `b/node_modules/<pkg>/...`, and emit a
# `diff --git` line so the result looks like git/patch-package output.
python3 - "$RAW_DIFF" "$WORK_DIR" "$ROOT" "$PKG_NAME" "$OUT_PATH" <<'PY'
import re, sys, os
from typing import Optional

raw_path, base_dir, cur_dir, pkg_name, out_path = sys.argv[1:6]
prefix = f"node_modules/{pkg_name}"

raw = open(raw_path, "r", errors="replace").read()
lines = raw.splitlines(keepends=True)

out = []
i = 0
n = len(lines)

def to_rel(p: str) -> Optional[str]:
    """Convert an absolute path inside base_dir or cur_dir into a relative
    path under the package (e.g. 'lib/driver.ts' or 'build/lib/driver.js').
    Returns None for /dev/null or unknown roots."""
    if p == "/dev/null":
        return None
    for root in (base_dir, cur_dir):
        if p == root or p.startswith(root + os.sep):
            return os.path.relpath(p, root)
    return None

while i < n:
    line = lines[i]
    if line.startswith("diff -"):
        # Skip — we'll synthesize our own `diff --git` header from the
        # following --- / +++ pair.
        i += 1
        continue
    if line.startswith("--- "):
        # Expect: "--- <path>\t<timestamp>\n"  followed by "+++ <path>...\n"
        if i + 1 >= n or not lines[i + 1].startswith("+++ "):
            out.append(line); i += 1; continue
        a_path = line[4:].split("\t", 1)[0].rstrip("\n")
        b_path = lines[i + 1][4:].split("\t", 1)[0].rstrip("\n")

        a_rel = to_rel(a_path)
        b_rel = to_rel(b_path)
        # The "b" side (current tree) is the source of truth for the
        # canonical filename. Fall back to "a" side if it's a deletion.
        rel = b_rel or a_rel
        if rel is None:
            # Unknown — pass through verbatim.
            out.append(line)
            out.append(lines[i + 1])
            i += 2
            continue

        a_label = "/dev/null" if a_rel is None else f"a/{prefix}/{a_rel}"
        b_label = "/dev/null" if b_rel is None else f"b/{prefix}/{b_rel}"

        out.append(f"diff --git a/{prefix}/{rel} b/{prefix}/{rel}\n")
        if a_rel is None:
            out.append(f"new file mode 100644\n")
        elif b_rel is None:
            out.append(f"deleted file mode 100644\n")
        out.append(f"--- {a_label}\n")
        out.append(f"+++ {b_label}\n")
        i += 2
        continue
    out.append(line)
    i += 1

with open(out_path, "w") as f:
    f.writelines(out)

# Summary
file_count = sum(1 for l in out if l.startswith("diff --git "))
line_count = len(out)
print(f"[build-and-patch] Patched files: {file_count}")
print(f"[build-and-patch] Patch size:    {line_count} lines, {os.path.getsize(out_path)} bytes")
PY

rm -f "$RAW_DIFF"

echo "[build-and-patch] Wrote ${OUT_PATH}"
echo "[build-and-patch] Done."

