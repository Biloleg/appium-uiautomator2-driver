#!/usr/bin/env bash
# Builds the project, patches the installed Appium driver in ~/.appium,
# and regenerates custom-changes.patch

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
diff -ru \
  "$TARGET_DIR/lib" \
  "$PROJECT_DIR/lib" \
  --exclude="*.js" \
  > "$PROJECT_DIR/custom-changes.patch" || true   # diff exits 1 when files differ

LINES=$(wc -l < "$PROJECT_DIR/custom-changes.patch")
echo "✅ Done. build/ synced and custom-changes.patch updated ($LINES lines)."
