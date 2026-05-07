# dendri-packages — Agent Guide

## What This Is

**pnpm workspace** (pinned `pnpm@10.30.1`) hosting two TS packages:
- `@afterrealism/dendri-client` — framework-neutral WebRTC P2P SDK (Apache-2.0)
- `@afterrealism/dendri-y` — Yjs CRDT provider over Dendri rooms (Apache-2.0)

Both share dev tooling (biome — tabs, width 100, double quotes; vitest; tsup) but are independently publishable.

> README typo trap: it sometimes spells the Yjs provider `dendri-client-y`. The published name is `@afterrealism/dendri-y` and the dir is `dendri-y/`.

## Commands

```bash
# Root install (required first)
pnpm install

# Filter to specific package
pnpm --filter @afterrealism/dendri-client build
pnpm --filter @afterrealism/dendri-client test
pnpm --filter @afterrealism/dendri-client test:watch
pnpm --filter @afterrealism/dendri-client coverage
pnpm --filter @afterrealism/dendri-client lint
pnpm --filter @afterrealism/dendri-client lint:fix
pnpm --filter @afterrealism/dendri-client format
pnpm --filter @afterrealism/dendri-client validate    # publint + attw

# Yjs provider
pnpm --filter @afterrealism/dendri-y build
pnpm --filter @afterrealism/dendri-y typecheck
```

## Single Test File

```bash
pnpm --filter @afterrealism/dendri-client test path/to/file.test.ts
pnpm --filter @afterrealism/dendri-client test -t "fragment"  # by name
```

## Package Structure

```
dendri-packages/
├── dendri-client/          # Main SDK
│   ├── src/
│   ├── dist/               # tsup output (ESM + CJS, dual entry points)
│   ├── package.json        # exports: ., ./store, ./msgpack
│   └── vitest.config.ts
└── dendri-y/
    ├── src/
    ├── package.json        # peer deps: yjs, y-protocols, @afterrealism/dendri-client
    └── tsconfig.json
```

## Per-package details

- **dendri-client** triple entry points (`.` / `./store` / `./msgpack`) → see `dendri-client/AGENTS.md`. Always `pnpm --filter ... validate` before publishing.
- **dendri-y** peer-deps contract (yjs, y-protocols, @afterrealism/dendri-client) → see `dendri-y/AGENTS.md`. Never promote a peer to a runtime dep.

Biome config (`biome.json`) is at the workspace root and applies to both packages.

## Red Flags

1. **Hardcoded server URLs** — SDK must receive URL from constructor/config
2. **Yjs logic in dendri-client** — keep Y-* concerns in `dendri-y`
3. **GPL/AGPL deps in either package** — both are Apache-2.0; no copyleft
4. **Framework coupling in dendri-client** — React/Vue/Svelte adapters go in `dendri-examples/`
5. **Missing export in package.json** — breaks the entry-point contract; validate catches this
