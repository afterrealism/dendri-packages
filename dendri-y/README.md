# @afterrealism/y-dendri

Framework-neutral Yjs provider for Dendri rooms.

## Install

```bash
npm install @afterrealism/dendri @afterrealism/y-dendri yjs y-protocols
```

## Usage

```ts
import { createDendriStore } from "@afterrealism/dendri";
import { DendriYjsProvider } from "@afterrealism/y-dendri";
import * as Y from "yjs";

const room = createDendriStore({
	host: "localhost",
	port: 9876,
	secure: false,
	path: "/",
});

const doc = new Y.Doc();
const provider = new DendriYjsProvider({ room, doc });

room.join("my-room");
```

The provider only depends on a small `DendriRoomLike` surface, so React, Vue, Svelte, and vanilla apps can use it with their normal UI reactivity.

Call `provider.destroy()`, `room.destroy()`, and `doc.destroy()` during app cleanup.
# @afterrealism/y-dendri

Minimal [Yjs](https://github.com/yjs/yjs) provider on top of a
[Dendri](https://dendri.dev) P2P room. Bridges a `Y.Doc` (and optionally an
`Awareness` instance) over Dendri's reserved `__yjs` topic.

## Install

```bash
pnpm add @afterrealism/y-dendri yjs y-protocols
```

`yjs` and `y-protocols` are peer dependencies — bring your own to avoid dual
instances breaking CRDT identity.

## Usage

```ts
import Dendri, { createDendriStore } from "@afterrealism/dendri";
import { DendriYjsProvider } from "@afterrealism/y-dendri";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

const store = createDendriStore({
  DendriCtor: Dendri,
  dendriOptions: { host: "localhost", port: 9876, secure: false, path: "/" },
});

const ydoc = new Y.Doc();
const awareness = new Awareness(ydoc);
const provider = new DendriYjsProvider({ room: store, doc: ydoc, awareness });

store.join("my-room");

// ...later
provider.destroy();
store.destroy();
```

## Wire format

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

MIT
