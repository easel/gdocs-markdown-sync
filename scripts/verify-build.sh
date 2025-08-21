#!/bin/bash

# Verify build outputs are up to date
set -e

DIST_DIR="./dist"

echo "🔍 Verifying build outputs..."

# Check if dist directory exists
if [ ! -d "$DIST_DIR" ]; then
    echo "❌ Error: $DIST_DIR directory not found. Run 'bun run build' first."
    exit 1
fi

# Check CLI build
if [ -f "$DIST_DIR/cli-fetch.js" ]; then
    CLI_SIZE=$(wc -c < "$DIST_DIR/cli-fetch.js")
    echo "✅ CLI build found: cli-fetch.js (${CLI_SIZE} bytes)"
else
    echo "❌ CLI build missing: cli-fetch.js"
    exit 1
fi

# Check plugin build files
PLUGIN_FILES=("main.js" "manifest.json" "styles.css")
for file in "${PLUGIN_FILES[@]}"; do
    if [ -f "$DIST_DIR/$file" ]; then
        FILE_SIZE=$(wc -c < "$DIST_DIR/$file")
        echo "✅ Plugin file found: $file (${FILE_SIZE} bytes)"
    else
        echo "❌ Plugin file missing: $file"
        exit 1
    fi
done

# Show version info
if [ -f "$DIST_DIR/manifest.json" ]; then
    VERSION=$(grep '"version"' "$DIST_DIR/manifest.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
    echo "📦 Built version: $VERSION"
fi

# Check if files are recent (less than 10 minutes old)
if [ -f "$DIST_DIR/main.js" ]; then
    AGE=$(find "$DIST_DIR/main.js" -mmin -10 -print)
    if [ -n "$AGE" ]; then
        echo "✅ Build appears fresh (less than 10 minutes old)"
    else
        echo "⚠️  Warning: Build files are older than 10 minutes"
        echo "    Consider running 'bun run build' to ensure latest code"
    fi
fi

echo "✅ Build verification complete!"