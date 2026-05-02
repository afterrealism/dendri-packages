/**
 * y-dendri — minimal Yjs provider on top of a Dendri room/store.
 *
 * Reserved topic: "__yjs". Wire framing is a single header byte then the raw
 * Yjs update / state-vector / awareness bytes:
 *   0 = SyncStep1   payload = encodeStateVector(doc)
 *   1 = SyncStep2   payload = encodeStateAsUpdate(doc, remoteStateVector)
 *   2 = Update      payload = an incremental update from y.on('update', ...)
 *   3 = Awareness   payload = encodeAwarenessUpdate(awareness, [clientID, ...])
 *
 * On peer-join we send SyncStep1 → remote replies SyncStep2 → both sides also
 * stream Update messages on every local change. Yjs is idempotent and
 * commutative so we don't need delivery guarantees beyond Dendri's defaults.
 */

import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
	encodeAwarenessUpdate,
	applyAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";

/** Minimum Dendri surface this provider relies on. */
export interface DendriRoomLike {
	readonly myPeerId: string | null;
	broadcastBinary(bytes: Uint8Array, options: { readonly topic: string }): void;
	subscribe(
		topic: string,
		handler: (data: unknown, peerId: string) => void,
	): () => void;
	onPeerJoin(handler: (peerId: string) => void): () => void;
	onPeerLeave(handler: (peerId: string) => void): () => void;
}

const TOPIC = "__yjs";

const enum MsgType {
	SyncStep1 = 0,
	SyncStep2 = 1,
	Update = 2,
	Awareness = 3,
}

function frame(type: MsgType, payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(payload.length + 1);
	out[0] = type;
	out.set(payload, 1);
	return out;
}

export interface DendriYjsProviderOptions {
	readonly room: DendriRoomLike;
	readonly doc: Y.Doc;
	readonly awareness?: Awareness;
}

/**
 * Bridges a Y.Doc (and optionally an Awareness instance) to a Dendri room.
 * Construct after the room exists; call `destroy()` when done to detach
 * listeners and clean up local awareness state.
 */
export class DendriYjsProvider {
	private readonly _room: DendriRoomLike;
	private readonly _doc: Y.Doc;
	private readonly _awareness: Awareness | null;
	private readonly _disposers: Array<() => void> = [];
	private readonly _origin = Symbol("y-dendri");

	constructor(options: DendriYjsProviderOptions) {
		this._room = options.room;
		this._doc = options.doc;
		this._awareness = options.awareness ?? null;

		this._disposers.push(
			this._room.subscribe(TOPIC, (data, peerId) => {
				if (data instanceof Uint8Array) {
					this._handleMessage(data, peerId);
				}
			}),
		);

		const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
			if (origin === this._origin) return;
			this._room.broadcastBinary(frame(MsgType.Update, update), { topic: TOPIC });
		};
		this._doc.on("update", onDocUpdate);
		this._disposers.push(() => this._doc.off("update", onDocUpdate));

		this._disposers.push(
			this._room.onPeerJoin(() => this._sendSyncStep1()),
		);

		if (this._awareness) {
			const aw = this._awareness;
			const onAwarenessUpdate = (
				changes: { added: number[]; updated: number[]; removed: number[] },
				origin: unknown,
			): void => {
				if (origin === this._origin) return;
				const ids = [...changes.added, ...changes.updated, ...changes.removed];
				if (ids.length === 0) return;
				this._room.broadcastBinary(
					frame(MsgType.Awareness, encodeAwarenessUpdate(aw, ids)),
					{ topic: TOPIC },
				);
			};
			aw.on("update", onAwarenessUpdate);
			this._disposers.push(() => aw.off("update", onAwarenessUpdate));

			this._disposers.push(
				this._room.onPeerLeave(() => {
					removeAwarenessStates(aw, [...aw.getStates().keys()].filter((id) => id !== aw.clientID), this._origin);
				}),
			);
		}
	}

	private _sendSyncStep1(): void {
		this._room.broadcastBinary(
			frame(MsgType.SyncStep1, Y.encodeStateVector(this._doc)),
			{ topic: TOPIC },
		);
		if (this._awareness) {
			const ids = [...this._awareness.getStates().keys()];
			if (ids.length > 0) {
				this._room.broadcastBinary(
					frame(MsgType.Awareness, encodeAwarenessUpdate(this._awareness, ids)),
					{ topic: TOPIC },
				);
			}
		}
	}

	private _handleMessage(bytes: Uint8Array, _peerId: string): void {
		if (bytes.length === 0) return;
		const type = bytes[0] as MsgType;
		const payload = bytes.subarray(1);

		switch (type) {
			case MsgType.SyncStep1: {
				const update = Y.encodeStateAsUpdate(this._doc, payload);
				this._room.broadcastBinary(frame(MsgType.SyncStep2, update), { topic: TOPIC });
				return;
			}
			case MsgType.SyncStep2:
			case MsgType.Update:
				Y.applyUpdate(this._doc, payload, this._origin);
				return;
			case MsgType.Awareness:
				if (this._awareness) {
					applyAwarenessUpdate(this._awareness, payload, this._origin);
				}
				return;
		}
	}

	destroy(): void {
		for (const d of this._disposers) d();
		this._disposers.length = 0;
		if (this._awareness) {
			removeAwarenessStates(this._awareness, [this._awareness.clientID], this._origin);
		}
	}
}
