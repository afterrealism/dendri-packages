# dendri-y — Agent Guide

`@afterrealism/dendri-y` — Yjs CRDT provider on top of `@afterrealism/dendri-client` rooms.

Apache-2.0. Pre-1.0 (currently `0.1.0`) — expect breaking changes; bump minor on any wire-format or constructor-signature change.

## Commands (run from `dendri-packages/`)

```bash
pnpm --filter @afterrealism/dendri-y build         # tsup → dist/{esm,cjs,d.ts,d.cts}
pnpm --filter @afterrealism/dendri-y build:watch
pnpm --filter @afterrealism/dendri-y typecheck     # tsc --noEmit
pnpm --filter @afterrealism/dendri-y clean         # rm -rf dist
```

There is **no test script and no `test` directory** in this package. Behavioural tests live in the consuming demos (`dendri-examples/chat`, `collaborative-edit`, `collaborative-layers`). If a regression appears, add a unit test here before fixing — don't rely on demo coverage forever.

## Source layout

```
src/index.ts        the entire provider — single-file SDK
tsup.config.ts      esm+cjs, dts on, sourcemap on, treeshake on
package.json        peerDependencies pattern (see below)
dist/               build output (gitignored)
afterrealism-dendri-y-0.1.0.tgz  pnpm pack output, consumed by demos via file: refs
```

Keep it one file until splitting is forced — the API surface is small and demos import the whole thing.

## Peer dependency pattern (read before adding deps)

```jsonc
"peerDependencies": {
  "y-protocols": "^1.0.0",
  "yjs": "^13.6.0",
  "@afterrealism/dendri-client": "^2.3.7"
}
```

These are **peers, not runtime deps**. The host application supplies them. Reasons:
- Yjs requires a single instance across the document graph; bundling it here would shadow the host's copy and break collaboration silently.
- `@afterrealism/dendri-client` ditto — two SDK instances in one page produce two WebSocket connections and double-deliver messages.
- `y-protocols/awareness` is also marked `external` in `tsup.config.ts` so it stays a peer at bundle time.

**Don't move any of these to `dependencies`.** If the SDK needs a new helper, add it to `devDependencies` and either `external` it in tsup or vendor the specific function.

## Build invariants

- `format: ["esm", "cjs"]` + `dts: true` → ships `.js` (ESM) and `.cjs` (CJS) and matching `.d.ts`/`.d.cts`. `package.json` `exports` map locks both.
- `sideEffects: false` lets bundlers tree-shake. Don't add top-level `console.*` or any module-side effect; both will silently disable tree-shaking for consumers.
- `treeshake: true` in tsup config — verify any dynamic-import hack still tree-shakes via `pnpm --filter @afterrealism/dendri-y build` then inspecting `dist/dendri-y.js` size.
- `engines.node >=18` — don't use Node-only APIs anyway (this is a browser/runtime-agnostic package), but any future Node-targeted utility must respect that floor.

## Versioning

Demos pin via the local tarball: `file:../../dendri-packages/dendri-y/afterrealism-dendri-y-0.1.0.tgz`. Bumping the version means: `pnpm version`, `pnpm pack`, then update the tarball filename in every consuming demo's `package.json`. The `dendri-packages/AGENTS.md` README-typo callout (this package vs `dendri-client-y`) applies — the published name is `@afterrealism/dendri-y`.
