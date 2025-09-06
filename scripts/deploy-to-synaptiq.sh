#!/bin/bash

# Deploy Google Docs Sync plugin to synaptiq_ops vault
set -e

PLUGIN_DIR="../synaptiq_ops/.obsidian/plugins/google-docs-sync"
DIST_DIR="./dist"

echo "🚀 Deploying Google Docs Sync plugin to synaptiq_ops vault..."

# CRITICAL: Verify TypeScript safety before deployment
echo "🔧 Pre-deployment TypeScript validation..."
if ! bun run typecheck; then
    echo "❌ DEPLOYMENT BLOCKED: TypeScript validation failed."
    echo "🛑 Fix all TypeScript errors before deploying to prevent runtime failures."
    exit 1
fi
echo "✅ TypeScript validation passed - safe to deploy"

# Show version being deployed
if [ -f "$DIST_DIR/manifest.json" ]; then
  DEPLOY_VERSION=$(grep '"version"' "$DIST_DIR/manifest.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
  echo "📦 Version being deployed: $DEPLOY_VERSION"
  echo "🕐 Deploy timestamp: $(date)"
fi

# Check if dist directory exists
if [ ! -d "$DIST_DIR" ]; then
    echo "❌ Error: $DIST_DIR directory not found. Please run 'bun run build:plugin' first."
    exit 1
fi

# Check required files exist
required_files=("main.js" "manifest.json" "styles.css")
for file in "${required_files[@]}"; do
    if [ ! -f "$DIST_DIR/$file" ]; then
        echo "❌ Error: Required file $DIST_DIR/$file not found."
        exit 1
    fi
done

# Create plugin directory if it doesn't exist
mkdir -p "$PLUGIN_DIR"

# Copy plugin files
echo "📁 Copying plugin files to $PLUGIN_DIR..."
cp "$DIST_DIR/main.js" "$PLUGIN_DIR/"
cp "$DIST_DIR/manifest.json" "$PLUGIN_DIR/"
cp "$DIST_DIR/styles.css" "$PLUGIN_DIR/"

echo "✅ Plugin deployed successfully!"
echo "📍 Plugin location: $PLUGIN_DIR"

# Verify deployed version
if [ -f "$PLUGIN_DIR/manifest.json" ]; then
  DEPLOYED_VERSION=$(grep '"version"' "$PLUGIN_DIR/manifest.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')
  echo "✅ Deployed version verified: $DEPLOYED_VERSION"
  if [ "$DEPLOY_VERSION" = "$DEPLOYED_VERSION" ]; then
    echo "🎯 Version match confirmed"
  else
    echo "⚠️  Warning: Version mismatch! Expected $DEPLOY_VERSION, got $DEPLOYED_VERSION"
  fi
fi

echo "🔧 You can now enable the plugin in Obsidian Settings → Community Plugins"