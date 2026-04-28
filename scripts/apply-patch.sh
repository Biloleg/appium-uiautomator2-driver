#!/usr/bin/env bash
# Applies uiautomator2-driver-improvements.patch to the installed Appium driver
# Usage:
#   ./scripts/apply-patch.sh                  # applies to ~/.appium/node_modules/appium-uiautomator2-driver
#   ./scripts/apply-patch.sh /custom/path     # applies to a custom target directory

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PATCH_FILE="$PROJECT_DIR/scripts/uiautomator2-driver-improvements.patch"
TARGET_DIR="${1:-$HOME/.appium/node_modules/appium-uiautomator2-driver}"

if [ ! -f "$PATCH_FILE" ]; then
  echo "❌ Patch file not found: $PATCH_FILE"
  echo "   Run 'npm run patch' first to generate it."  exit 1
fi

if [ ! -d "$TARGET_DIR" ]; then
  echo "❌ Target directory not found: $TARGET_DIR"
  exit 1
fi

echo "🔧 Applying $PATCH_FILE to $TARGET_DIR ..."

cd "$TARGET_DIR"

# Show what will be changed
git apply --stat "$PATCH_FILE" 2>&1 || true

# Apply the patch (paths in patch are relative: lib/file.ts → <TARGET_DIR>/lib/file.ts)
git apply "$PATCH_FILE"

echo ""
echo "✅ Patch applied successfully to $TARGET_DIR"
echo "   Restart Appium to pick up the changes."
