/**
 * Framework-agnostic reactive store factory for Dendri Room.
 *
 * Works with any UI framework. Provides a subscribe-based reactivity model
 * (similar to Svelte stores or Zustand) that can be consumed by:
 *
 * - **Svelte 5**: Wrap getters in `$derived` or read in `$effect`
 * - **React**: Use `useSyncExternalStore` with `store.subscribe`
 * - **Vue**: Use `watchEffect` over store getters
 * - **Vanilla JS**: Call `store.subscribe` directly
 *
 * @example
 * ```ts
 * import { Dendri } from "dendri";
 * import { createDendriStore } from "dendri/store";
 *
 * const store = createDendriStore({
 *   DendriCtor: Dendri,
 *   dendriOptions: { host: "localhost", port: 9000, secure: false, path: "/" },
 * });
 *
 * store.join("my-room");
 * store.subscribe(() => console.log("peers:", store.peers));
 * ```
 */

import { Dendri as DefaultDendri, type Dendri, type DendriOptions } from "./dendri";
import { ConnectionState } from "./enums";
import type { PresenceEvents } from "./presence";
import { Room, type RoomOptions } from "./room";

/** Options passed to {@link createDendriStore} in advanced form. */
export interface DendriStoreOptions {
	/**
	 * The Dendri constructor to use for creating peer instances. When
	 * omitted the default {@link Dendri} class is used. Overriding is
	 * useful for injecting a mock in tests.
	 */
	readonly DendriCtor?: new (
		id: string,
		opts?: DendriOptions,
	) => Dendri;
	/** Options forwarded to the Dendri constructor on each join. */
	readonly dendriOptions?: DendriOptions;
	/** Optional Room-level options (e.g. migration timeout). */
	readonly roomOptions?: RoomOptions;
}

/**
 * `createDendriStore` accepts either the advanced {@link DendriStoreOptions}
 * shape or a flat {@link DendriOptions} object. Pass an explicit signaling
 * server host so open-source/self-hosted apps connect to their own server.
 */
export type CreateDendriStoreInput = DendriStoreOptions | DendriOptions;

function isAdvancedOptions(input: CreateDendriStoreInput | undefined): input is DendriStoreOptions {
	return (
		!!input &&
		typeof input === "object" &&
		("DendriCtor" in input || "dendriOptions" in input || "roomOptions" in input)
	);
}

/** Snapshot of the store's reactive state at a given point in time. */
export interface DendriStoreSnapshot {
	readonly connectionState: ConnectionState;
	readonly isHost: boolean;
	readonly myPeerId: string | null;
	readonly hostId: string | null;
	readonly peers: readonly string[];
	readonly peerCount: number;
	readonly presences: ReadonlyMap<string, unknown>;
}

/** Listener callback for store state changes. */
export type StoreListener = () => void;

/**
 * A framework-agnostic reactive wrapper around a Dendri {@link Room}.
 *
 * State is accessed via getters. External frameworks react to changes
 * by subscribing with {@link DendriStore.subscribe}.
 */
export interface DendriStore {
	// -----------------------------------------------------------------------
	// Reactive state (read via getters)
	// -----------------------------------------------------------------------

	/** Current connection lifecycle state. */
	readonly connectionState: ConnectionState;
	/** Whether this peer is the current room host. */
	readonly isHost: boolean;
	/** The local peer's ID, or `null` before joining. */
	readonly myPeerId: string | null;
	/** The current host's peer ID, or `null` before joining. */
	readonly hostId: string | null;
	/** All known remote peer IDs in the room. */
	readonly peers: readonly string[];
	/** Number of known remote peers. */
	readonly peerCount: number;
	/** Map of remote peer presences. */
	readonly presences: ReadonlyMap<string, unknown>;

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	/** Join a room by ID. Creates a new Room internally. */
	join(roomId: string): void;
	/** Leave the current room and clean up. */
	leave(): void;
	/** Broadcast data to all room peers, optionally on a topic. */
	broadcast(data: unknown, options?: { readonly topic?: string }): void;
	/** Broadcast a binary payload tagged with a topic. Receivers see a Uint8Array. */
	broadcastBinary(bytes: Uint8Array, options: { readonly topic: string }): void;
	/** Broadcast with delivery confirmation. */
	broadcastWithAck(data: unknown, timeout?: number): Promise<void>;
	/** Set this peer's presence data. */
	setPresence(data: Record<string, unknown>): void;

	// -----------------------------------------------------------------------
	// Events — register callbacks that fire on room lifecycle events
	// -----------------------------------------------------------------------

	/** Register a callback for when a remote peer joins. Returns unsubscribe fn. */
	onPeerJoin(handler: (peerId: string) => void): () => void;
	/** Register a callback for when a remote peer leaves. Returns unsubscribe fn. */
	onPeerLeave(handler: (peerId: string) => void): () => void;
	/** Register a callback for all incoming data. Returns unsubscribe fn. */
	onData(handler: (data: unknown, peerId: string) => void): () => void;
	/** Register a callback for presence updates. Returns unsubscribe fn. */
	onPresenceUpdate(handler: PresenceEvents<Record<string, unknown>>["update"]): () => void;
	/** Register a callback for host changes. Returns unsubscribe fn. */
	onHostChanged(handler: (hostId: string) => void): () => void;

	// -----------------------------------------------------------------------
	// Framework integration
	// -----------------------------------------------------------------------

	/**
	 * Subscribe to state changes. The listener is called whenever reactive
	 * state changes. Returns an unsubscribe function.
	 *
	 * Compatible with React's `useSyncExternalStore`, Svelte's `$effect`,
	 * and any callback-based reactivity system.
	 */
	subscribe: {
		// Overload 1: topic subscription (matches Room.subscribe)
		(topic: string, handler: (data: unknown, peerId: string) => void): () => void;
		// Overload 2: state-change listener (for framework reactivity)
		(listener: StoreListener): () => void;
	};

	/**
	 * Get an immutable snapshot of the current state.
	 * Compatible with React's `useSyncExternalStore` (getSnapshot).
	 */
	getSnapshot(): DendriStoreSnapshot;

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	/** Leave the room and remove all listeners. */
	destroy(): void;
}

/**
 * Create a framework-agnostic reactive store wrapping a Dendri Room.
 *
 * Accepts three calling shapes:
 *
 * ```ts
 * // 1. Flat DendriOptions (passthrough to the Dendri constructor)
 * const store = createDendriStore({ host: "localhost", port: 9000, secure: false });
 *
 * // 2. Advanced — inject a custom Dendri class (for tests / mocks)
 * const store = createDendriStore({
 *   DendriCtor: MyDendri,
 *   dendriOptions: { secure: true },
 *   roomOptions: { migrationTimeout: 5000 },
 * });
 * ```
 *
 * @param input - Configuration containing an explicit signaling server host.
 * @returns A {@link DendriStore} instance.
 */
export function createDendriStore(input?: CreateDendriStoreInput): DendriStore {
	const advanced = isAdvancedOptions(input);
	const DendriCtor: new (id: string, opts?: DendriOptions) => Dendri =
		(advanced ? input.DendriCtor : undefined) ??
		(DefaultDendri as unknown as new (
			id: string,
			opts?: DendriOptions,
		) => Dendri);
	const dendriOptions = (advanced
		? (input.dendriOptions ?? {})
		: ((input as DendriOptions | undefined) ?? {})) as DendriOptions;
	const roomOptions: RoomOptions | undefined = advanced ? input.roomOptions : undefined;

	let room: Room | null = null;

	// -----------------------------------------------------------------------
	// Internal mutable state — exposed via getters
	// -----------------------------------------------------------------------

	let _connectionState: ConnectionState = ConnectionState.Initialized;
	let _isHost = false;
	let _myPeerId: string | null = null;
	let _hostId: string | null = null;
	let _peers: readonly string[] = [];
	let _presences: ReadonlyMap<string, unknown> = new Map();

	// -----------------------------------------------------------------------
	// Listener bookkeeping
	// -----------------------------------------------------------------------

	const _listeners = new Set<StoreListener>();

	/** Topic subscriptions registered before join() — replayed on the Room once created. */
	const _pendingTopicSubs: { topic: string; handler: (data: unknown, peerId: string) => void }[] =
		[];

	// Room-event handlers registered before join() are queued so they actually
	// fire on the eventual Room instance. Previously the on/off pair was a
	// no-op that returned a no-op unsubscriber, making the API look wired
	// but silently dropping every event.
	const _pendingPeerJoin: ((peerId: string) => void)[] = [];
	const _pendingPeerLeave: ((peerId: string) => void)[] = [];
	const _pendingHostChanged: ((hostId: string) => void)[] = [];
	const _pendingPresenceUpdate: PresenceEvents<Record<string, unknown>>["update"][] = [];

	/** Cached snapshot — invalidated on every notify(). */
	let _snapshot: DendriStoreSnapshot | null = null;

	function notify(): void {
		_snapshot = null; // invalidate
		for (const fn of _listeners) {
			fn();
		}
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	function join(roomId: string): void {
		if (room !== null) {
			leave();
		}

		room = new Room(roomId, roomOptions);

		// Replay any topic subscriptions that were registered before join().
		for (const { topic, handler } of _pendingTopicSubs) {
			room.subscribe(topic, handler);
		}
		_pendingTopicSubs.length = 0;

		// Replay room-event handlers queued before join().
		for (const h of _pendingPeerJoin) room.on("peerJoined", h);
		_pendingPeerJoin.length = 0;
		for (const h of _pendingPeerLeave) room.on("peerLeft", h);
		_pendingPeerLeave.length = 0;
		for (const h of _pendingHostChanged) room.on("hostChanged", h);
		_pendingHostChanged.length = 0;
		for (const h of _pendingPresenceUpdate) room.presence.on("update", h);
		_pendingPresenceUpdate.length = 0;

		// Capture the room instance for closures so late-firing callbacks
		// that arrive after leave()/destroy() can bail out safely.
		const currentRoom = room;

		currentRoom.on("joined", (peerId, isHost) => {
			if (room !== currentRoom) return;
			_myPeerId = peerId;
			_isHost = isHost;
			_hostId = currentRoom.hostId;
			_connectionState = ConnectionState.Connected;
			_peers = currentRoom.peers;
			notify();
		});

		currentRoom.on("peerJoined", () => {
			if (room !== currentRoom) return;
			_peers = currentRoom.peers;
			notify();
		});

		currentRoom.on("peerLeft", () => {
			if (room !== currentRoom) return;
			_peers = currentRoom.peers;
			_presences = currentRoom.getOthers();
			notify();
		});

		currentRoom.on("hostChanged", (newHostId) => {
			if (room !== currentRoom) return;
			_hostId = newHostId;
			_isHost = currentRoom.isHost;
			notify();
		});

		currentRoom.on("error", () => {
			if (room !== currentRoom) return;
			_connectionState = ConnectionState.Failed;
			notify();
		});

		currentRoom.presence.on("update", () => {
			if (room !== currentRoom) return;
			_presences = currentRoom.getOthers();
			notify();
		});

		_connectionState = ConnectionState.Connecting;
		notify();

		room.join(DendriCtor, dendriOptions);
	}

	function leave(): void {
		if (room !== null) {
			room.leave();
			room = null;
		}

		_connectionState = ConnectionState.Closed;
		_isHost = false;
		_myPeerId = null;
		_hostId = null;
		_peers = [];
		_presences = new Map();
		notify();
	}

	function broadcast(data: unknown, opts?: { readonly topic?: string }): void {
		room?.broadcast(data, opts);
	}

	function broadcastBinary(
		bytes: Uint8Array,
		opts: { readonly topic: string },
	): void {
		room?.broadcastBinary(bytes, opts);
	}

	function broadcastWithAck(data: unknown, timeout?: number): Promise<void> {
		return room?.broadcastWithAck(data, timeout) ?? Promise.resolve();
	}

	function setPresence(data: Record<string, unknown>): void {
		room?.setPresence(data);
	}

	// -----------------------------------------------------------------------
	// Event registration helpers
	// -----------------------------------------------------------------------

	function onPeerJoin(handler: (peerId: string) => void): () => void {
		if (room) {
			room.on("peerJoined", handler);
		} else {
			_pendingPeerJoin.push(handler);
		}
		return () => {
			if (room) {
				room.off("peerJoined", handler);
			} else {
				const idx = _pendingPeerJoin.indexOf(handler);
				if (idx !== -1) _pendingPeerJoin.splice(idx, 1);
			}
		};
	}

	function onPeerLeave(handler: (peerId: string) => void): () => void {
		if (room) {
			room.on("peerLeft", handler);
		} else {
			_pendingPeerLeave.push(handler);
		}
		return () => {
			if (room) {
				room.off("peerLeft", handler);
			} else {
				const idx = _pendingPeerLeave.indexOf(handler);
				if (idx !== -1) _pendingPeerLeave.splice(idx, 1);
			}
		};
	}

	function onData(handler: (data: unknown, peerId: string) => void): () => void {
		return room?.onData(handler) ?? (() => {});
	}

	function onPresenceUpdate(
		handler: PresenceEvents<Record<string, unknown>>["update"],
	): () => void {
		if (room) {
			room.presence.on("update", handler);
		} else {
			_pendingPresenceUpdate.push(handler);
		}
		return () => {
			if (room) {
				room.presence.off("update", handler);
			} else {
				const idx = _pendingPresenceUpdate.indexOf(handler);
				if (idx !== -1) _pendingPresenceUpdate.splice(idx, 1);
			}
		};
	}

	function onHostChanged(handler: (hostId: string) => void): () => void {
		if (room) {
			room.on("hostChanged", handler);
		} else {
			_pendingHostChanged.push(handler);
		}
		return () => {
			if (room) {
				room.off("hostChanged", handler);
			} else {
				const idx = _pendingHostChanged.indexOf(handler);
				if (idx !== -1) _pendingHostChanged.splice(idx, 1);
			}
		};
	}

	// -----------------------------------------------------------------------
	// Framework integration
	// -----------------------------------------------------------------------

	function subscribeFn(
		topicOrListener: string | StoreListener,
		handler?: (data: unknown, peerId: string) => void,
	): () => void {
		// Overload 1: topic subscription
		if (typeof topicOrListener === "string" && handler !== undefined) {
			if (room !== null) {
				return room.subscribe(topicOrListener, handler);
			}
			// Room not created yet — queue the subscription for replay in join().
			const entry = { topic: topicOrListener, handler };
			_pendingTopicSubs.push(entry);
			return () => {
				const idx = _pendingTopicSubs.indexOf(entry);
				if (idx !== -1) {
					_pendingTopicSubs.splice(idx, 1);
				}
			};
		}

		// Overload 2: state-change listener
		if (typeof topicOrListener === "function") {
			_listeners.add(topicOrListener);
			return () => {
				_listeners.delete(topicOrListener);
			};
		}

		return () => {};
	}

	function getSnapshot(): DendriStoreSnapshot {
		if (_snapshot !== null) {
			return _snapshot;
		}

		_snapshot = {
			connectionState: _connectionState,
			isHost: _isHost,
			myPeerId: _myPeerId,
			hostId: _hostId,
			peers: _peers,
			peerCount: _peers.length,
			presences: _presences,
		};

		return _snapshot;
	}

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	function destroy(): void {
		if (room !== null) {
			room.leave();
			room = null;
		}

		_connectionState = ConnectionState.Closed;
		_isHost = false;
		_myPeerId = null;
		_hostId = null;
		_peers = [];
		_presences = new Map();
		_listeners.clear();
		_snapshot = null;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	return {
		get connectionState() {
			return _connectionState;
		},
		get isHost() {
			return _isHost;
		},
		get myPeerId() {
			return _myPeerId;
		},
		get hostId() {
			return _hostId;
		},
		get peers() {
			return _peers;
		},
		get peerCount() {
			return _peers.length;
		},
		get presences() {
			return _presences;
		},

		join,
		leave,
		broadcast,
		broadcastBinary,
		broadcastWithAck,
		setPresence,

		onPeerJoin,
		onPeerLeave,
		onData,
		onPresenceUpdate,
		onHostChanged,

		subscribe: subscribeFn as DendriStore["subscribe"],
		getSnapshot,
		destroy,
	};
}
