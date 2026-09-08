# @afterrealism/dendri-client

Framework-neutral TypeScript client SDK for Dendri WebRTC P2P signaling. Works in the browser and Node.js.

## Install

```bash
npm install @afterrealism/dendri-client
```

## Connect To Your Server

Pass the signaling server your app should use as a single URL:

```ts
import { Dendri } from "@afterrealism/dendri-client";

const peer = new Dendri({
	url: "wss://signal.example.com",
	apiKey: "your-api-key", // only needed for hosted / multi-tenant deployments
});
```

`url` is shorthand for `host`/`port`/`secure`/`path` — pass those individually if you
prefer; explicitly passed fields win over url-derived ones.

You can also pass an explicit peer id as the first argument: `new Dendri("my-peer-id", { ... })`.

Local development usually looks like:

```ts
const peer = new Dendri({ url: "ws://localhost:9876" });
```

## Quick Start

```ts
// Connect to another peer
const conn = peer.connect("other-peer-id");

conn.on("open", () => {
	conn.send("hello");
});

conn.on("data", (data) => {
	console.log("Received:", data);
});

// Receive connections
peer.on("connection", (conn) => {
	conn.on("data", (data) => {
		console.log("Received:", data);
	});
});
```

## Room Store

Use `createDendriStore()` when integrating with UI frameworks:

```ts
import { createDendriStore } from "@afterrealism/dendri-client";

const store = createDendriStore({ url: "wss://signal.example.com" });

const unsubscribe = store.subscribe(() => {
	console.log(store.connectionState, store.peers);
});

store.join("my-room");
```

## Framework Adapters

Ready-made bindings ship as subpath exports (`react` and `vue` are optional peer
dependencies; the Svelte adapter is dependency-free):

```tsx
// React — re-renders on store changes (useSyncExternalStore under the hood)
import { useDendriStore } from "@afterrealism/dendri-client/react";
const { connectionState, peers } = useDendriStore(store);
```

```ts
// Vue — shallowRef that tracks the store, auto-unsubscribes with the component
import { useDendriStore } from "@afterrealism/dendri-client/vue";
const snapshot = useDendriStore(store); // snapshot.value.connectionState
```

```svelte
<!-- Svelte — standard store contract, works with $ auto-subscription (Svelte 4 + 5) -->
<script>
	import { toSvelteStore } from "@afterrealism/dendri-client/svelte";
	const snapshot = toSvelteStore(store);
</script>
{$snapshot.connectionState}
```

Any other framework can wrap `store.subscribe` and `store.getSnapshot()` the same way.

## Features

- **P2P Data Channels** - Send data directly between browsers
- **Media Calls** - Video and audio streaming via WebRTC
- **Rooms** - Group peers into rooms with automatic peer discovery
- **Presence** - Track online status and custom metadata across peers
- **Topics** - Pub/sub messaging with named topics
- **RPC** - Request/response pattern over data channels
- **Host Migration** - Automatic leader election when the host disconnects
- **Hybrid Connections** - Seamless fallback between data channel and relay
- **Relay Encryption** - End-to-end encryption for relayed messages
- **Store** - Shared synchronized state across peers
- **Auto Reconnect** - Exponential backoff with jitter
- **MsgPack Serializer** - Binary serialization for smaller payloads

## Multi-Tab Reconnection

When two browser tabs use the same `peer_id` to connect to the same signaling server:

- **Same peer_id, same token** — Treated as a reconnection. The server replaces the old WebSocket with the new one. Room memberships and queued messages are preserved. The first tab eventually receives a disconnect event via heartbeat timeout.
- **Same peer_id, different token** — Rejected with an `ID_TAKEN` error. Prevents accidental or malicious ID hijacking.

For multi-tab apps, use `BroadcastChannel` or `localStorage` to coordinate a single Dendri connection across tabs, or let each tab create its own instance with distinct `peer_id` values and communicate through rooms.

## MsgPack Serializer

For binary serialization instead of JSON:

```ts
import { MsgPackDendri } from "@afterrealism/dendri-client";

const peer = new MsgPackDendri("my-peer-id", {
	host: "signal.example.com",
	secure: true,
});
```

## SSR

Importing the package is safe in SSR code, but creating peers and joining rooms should happen only in browser/client lifecycle code because WebRTC and WebSocket connections are browser/runtime side effects.

## Browser Global Build

The package ships browser global (IIFE) assets for CDN/script-tag workflows:

```html
<script src="https://unpkg.com/@afterrealism/dendri-client"></script>
<script>
	const peer = new dendri.Dendri({ host: "signal.example.com", port: 443, secure: true, path: "/" });
</script>
```

- `dist/dendri.min.global.js` (minified, served by unpkg/jsdelivr by default)
- `dist/dendri.browser.global.js` (unminified, for debugging)

The global build exposes `Dendri` and `util` on `window.dendri`. Prefer npm imports for framework apps.

## License

Apache-2.0
