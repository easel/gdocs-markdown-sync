#!/bin/bash

# Simple build script for Google Docs Sync plugin

echo "Building Google Docs Sync plugin..."

# Check if Bun is available
if ! command -v bun &> /dev/null; then
    echo "Bun not found. Please install Bun first: https://bun.sh"
    exit 1
fi

# Use Bun's built-in TypeScript compiler
bun run build

echo "Build completed successfully!"