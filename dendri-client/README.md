# @afterrealism/dendri-client

Framework-neutral TypeScript client SDK for Dendri WebRTC signaling.

## Install

```bash
npm install @afterrealism/dendri-client
```

## Connect To Your Server

Dendri is self-host-first. You must provide the signaling server that your app should use:

```ts
import { Dendri } from "@afterrealism/dendri-client";

const peer = new Dendri({
	host: "signal.example.com",
	port: 443,
	secure: true,
	path: "/",
});
```

Local development usually looks like:

```ts
const peer = new Dendri({
	host: "localhost",
	port: 9876,
	secure: false,
	path: "/",
});
```

## Room Store

Use `createDendriStore()` when integrating with UI frameworks:

```ts
import { createDendriStore } from "@afterrealism/dendri-client";

const store = createDendriStore({
	host: "localhost",
	port: 9876,
	secure: false,
	path: "/",
});

const unsubscribe = store.subscribe(() => {
	console.log(store.connectionState, store.peers);
});

store.join("my-room");
```

React can wrap `store.subscribe` and `store.getSnapshot()` with `useSyncExternalStore`. Vue can mirror snapshots into `shallowRef`. Svelte can create the store in `onMount` or a `.svelte.ts` factory and call `destroy()` during cleanup.

## SSR

Importing the package is safe in SSR code, but creating peers and joining rooms should happen only in browser/client lifecycle code because WebRTC and WebSocket connections are browser/runtime side effects.

## Browser Global Build

The package still builds browser global assets in `dist/` for CDN/script-tag workflows:

- `dist/dendri.browser.global.js`
- `dist/dendri.min.global.js`

Prefer npm imports for framework apps.
# @afterrealism/dendri-client

WebRTC P2P signaling library for the browser and Node.js.

## Install

```bash
npm install @afterrealism/dendri-client
```

## Quick Start

```typescript
import Dendri from "@afterrealism/dendri-client";

const peer = new Dendri("my-peer-id", {
  host: "signal.example.com",
  secure: true,
});

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

```typescript
import { MsgPackDendri } from "@afterrealism/dendri-client";

const peer = new MsgPackDendri("my-peer-id", {
  host: "signal.example.com",
  secure: true,
});
```

## License

MIT
