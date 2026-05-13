#!/usr/bin/env bash
# @afterrealism/dendri-y publish
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
rm -rf dist node_modules
pnpm install --no-frozen-lockfile || npm install
pnpm build
echo ""
echo "Ready to publish. Run:"
echo "  cd $(pwd) && pnpm publish --access public --no-git-checks"
