#!/usr/bin/env bash
# Build the MCPB bundle for Smithery / Claude Desktop one-click install.
# Usage: ./scripts/build-mcpb.sh [version]
set -euo pipefail

VERSION="${1:-$(node -p "require('./mcp/package.json').version")}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/mcp/bundle"
OUTPUT="$ROOT/mcp/sendblue-browser.mcpb"

echo "Building MCPB bundle v$VERSION"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/server"

# Compile the wrapper
( cd "$ROOT/mcp" && npm run build )
cp "$ROOT/mcp/dist/index.js" "$BUNDLE/server/index.js"

# Install production deps inside the bundle dir
cat > "$BUNDLE/package.json" <<JSON
{
  "name": "sendblue-browser-mcp-bundle",
  "version": "$VERSION",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.8"
  }
}
JSON
( cd "$BUNDLE" && npm install --omit=dev --silent --no-audit --no-fund )

# Reuse the canonical manifest from the source tree
cp "$ROOT/mcp/manifest.json" "$BUNDLE/manifest.json"

# Pack
npx --yes @anthropic-ai/mcpb pack "$BUNDLE" "$OUTPUT"
echo "Built: $OUTPUT"
