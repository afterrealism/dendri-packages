#!/usr/bin/env bash
# @afterrealism/dendri-y setup
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
pnpm install --no-frozen-lockfile 2>/dev/null || npm install
echo "@afterrealism/dendri-y: dependencies installed."
