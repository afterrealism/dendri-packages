# @afterrealism/dendri-y

Minimal [Yjs](https://github.com/yjs/yjs) provider on top of a
[Dendri](https://dendri.dev) P2P room. Bridges a `Y.Doc` (and optionally an
`Awareness` instance) over Dendri's reserved `__yjs` topic.

## Install

```bash
npm install @afterrealism/dendri-client @afterrealism/dendri-y yjs y-protocols
```

`@afterrealism/dendri-client`, `yjs`, and `y-protocols` are peer dependencies —
bring your own to avoid dual instances breaking CRDT identity.

## Usage

```ts
import { createDendriStore } from "@afterrealism/dendri-client";
import { DendriYjsProvider } from "@afterrealism/dendri-y";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const room = createDendriStore({
	host: "signal.example.com",
	port: 443,
	secure: true,
	path: "/",
});

const doc = new Y.Doc();
const awareness = new Awareness(doc);
const provider = new DendriYjsProvider({ room, doc, awareness });

room.join("my-room");

// ...later, during app cleanup
provider.destroy();
room.destroy();
doc.destroy();
```

The provider only depends on a small `DendriRoomLike` surface, so React, Vue,
Svelte, and vanilla apps can use it with their normal UI reactivity.

## Wire Format

Reserved topic: `__yjs`. Each frame is a single header byte followed by raw
Yjs bytes:

| Byte | Type        | Payload                                     |
| ---- | ----------- | ------------------------------------------- |
| 0    | `SyncStep1` | `Y.encodeStateVector(doc)`                  |
| 1    | `SyncStep2` | `Y.encodeStateAsUpdate(doc, remoteVector)`  |
| 2    | `Update`    | Incremental update from `doc.on('update')`  |
| 3    | `Awareness` | `encodeAwarenessUpdate(awareness, ids)`     |

On peer-join the new peer sends `SyncStep1`, the remote responds with
`SyncStep2`, and both sides stream `Update` frames thereafter. Yjs updates are
idempotent and commutative, so no delivery guarantees beyond Dendri's defaults
are required.

## Requires

- Dendri client `>= 2.3.7` (for `room.broadcastBinary()`)
- `yjs ^13.6.0`
- `y-protocols ^1.0.0`

## License

Apache-2.0
