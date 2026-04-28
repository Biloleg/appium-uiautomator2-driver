#!/usr/bin/env bash
# Builds the project, patches the installed Appium driver in ~/.appium,
# and regenerates uiautomator2-driver-improvements.patch

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="$HOME/.appium/node_modules/appium-uiautomator2-driver"

echo "🔨 Building project..."
cd "$PROJECT_DIR"
./node_modules/.bin/tsc -b

echo "📦 Patching installed driver at $TARGET_DIR ..."
rsync -a --delete "$PROJECT_DIR/build/" "$TARGET_DIR/build/"

echo "📝 Regenerating custom-changes.patch ..."

# Generate raw diff, then normalize all paths to relative 'a/lib/...' 'b/lib/...'
# so the patch is portable and can be applied with: cd <driver_root> && git apply uiautomator2-driver-improvements.patch

git diff --no-index "$TARGET_DIR/lib" "$PROJECT_DIR/lib" 2>/dev/null | \
  sed \
    -E \
    -e "s|^diff --git a/[^ ]*/lib/([^ ]+) b/[^ ]*/lib/([^ ]+)|diff --git a/lib/\1 b/lib/\2|g" \
    -e "s|^--- a/[^ ]*/lib/|--- a/lib/|g" \
    -e "s|^\+\+\+ b/[^ ]*/lib/|+++ b/lib/|g" \
    > "$PROJECT_DIR/scripts/uiautomator2-driver-improvements.patch" || true

LINES=$(wc -l < "$PROJECT_DIR/scripts/uiautomator2-driver-improvements.patch")
echo "✅ Done. build/ synced and uiautomator2-driver-improvements.patch updated ($LINES lines)."
