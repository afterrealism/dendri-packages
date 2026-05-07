# dendri-client — Agent Guide

## What This Is

Framework-neutral **WebRTC P2P SDK** — room-based signaling, typed presence, RPC + ACK delivery, multi-transport fallback (WebSocket, HTTP/SSE, long-poll).

**License:** Apache-2.0. No hardcoded Dendri host defaults.

## SDK Shape

Three independently exported entry points:

1. **`.`** — main client API
   - `DendriClient` class, room management, peer events, RPC
2. **`./store`** — pluggable persistence
   - Store interface for saving/loading room state
3. **`./msgpack`** — wire codec
   - Serialization layer (msgpack vs JSON, etc.)

Each is bundled separately (tsup). All three must export both ESM and CJS.

## Source Layout

Hotspots: `dendri.ts` (1149 LOC) is the main client class; `room.ts` (936) holds room state + peer book-keeping. Touch with care — both have surface area exported via the `.` entry.

```
src/
├── dendri.ts (1149)        # DendriClient class — main export, transport orchestration
├── room.ts (936)           # Room/peer state, presence, host migration
├── transport/              # WebSocket, SSE, long-poll implementations
├── store/                  # createDendriStore — pending-listener queue (export: ./store)
└── codecs/msgpack.ts       # Wire codec (export: ./msgpack)
```

`createDendriStore` queues listeners while the underlying client is still connecting, then flushes on connect — assume that ordering when adding store APIs.

**tsup bundling rationale:** the SDK ships pre-bundled (not just transpiled) so SvelteKit/Next.js SSR can `require()` it without choking on bare ESM-only deps. Don't replace tsup with plain `tsc` without checking SSR consumers.

**Versioning:** currently `2.3.7` (see `package.json`).

## No Framework Coupling

Plain TS/JS only. React/Vue/Svelte adapters live in `dendri-examples/` (see root `AGENTS.md > Anti-Patterns`).

## Testing

```bash
pnpm --filter @afterrealism/dendri-client test           # vitest
pnpm --filter @afterrealism/dendri-client test:watch
pnpm --filter @afterrealism/dendri-client coverage       # coverage report
pnpm --filter @afterrealism/dendri-client test -t "room"  # filter by name
```

Target: 80%+ coverage.

**Test patterns to copy:**
- `vi.useFakeTimers()` for reconnect/backoff/timeout assertions — never `setTimeout` real
- `mock-socket` (npm) for the WebSocket transport; do NOT use `ws` in tests
- "comprehensive" suites pair the spec with a `*.comprehensive.spec.ts` variant for edge-case coverage
- `peer.spec.ts:46` has an intentional `describe.skip` (RTCPeerConnection unavailable in jsdom) — leave it skipped, don't unmark

## Validation Before Publishing

```bash
pnpm --filter @afterrealism/dendri-client validate
```

This runs `publint` (package.json hygiene) and `attw` (TypeScript export validation). Both must pass.

## Red Flags

1. **No server URL passed to constructor** — must be explicit parameter
2. **Yjs-specific code here** — belongs in `dendri-y`
3. **Undeclared runtime deps** — update `package.json` or remove import
4. **Broken entry points** — validate catches; don't publish without it
5. **React/Vue/Svelte hooks in main code** — move to examples
