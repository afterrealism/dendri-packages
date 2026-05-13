/**
 * High-level Room abstraction for star-topology P2P rooms with host migration.
 *
 * Usage pattern:
 *   const room = new Room("my-room");
 *   room.join({ host: "localhost", port: 9000, secure: false, path: "/" });
 *   room.on("joined", (peerId, isHost) => { ... });
 *   room.on("data", (peerId, data) => { ... });
 *   room.broadcast({ cursor: [10, 20] });
 *
 * The Room class is opt-in. Existing Dendri usage patterns are unaffected.
 */

import { EventEmitter } from "eventemitter3";
import { AckManager } from "./ack";
import type { DataConnection } from "./dataconnection/DataConnection";
import type { Dendri, DendriOptions } from "./dendri";
import { ServerMessageType } from "./enums";
import { electNewHost } from "./hostmigration";
import { PresenceManager } from "./presence";
import { isRpcRequest, isRpcResponse, type RpcHandler, RpcManager } from "./rpc";
import { isTopicEnvelope, TopicManager } from "./topics";

/**
 * Encode bytes as base64 so binary payloads survive JSON-only signaling-relay
 * and topic envelopes. WebRTC paths could carry Uint8Array natively, but we
 * wrap uniformly to keep host-fanout, relay fallback, and receivers identical.
 */
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

export interface RoomEvents {
	/** Fired when this peer has successfully joined the room. */
	joined: (peerId: string, isHost: boolean) => void;
	/** Fired when a remote peer joins the room. */
	peerJoined: (peerId: string) => void;
	/** Fired when a remote peer leaves the room. */
	peerLeft: (peerId: string) => void;
	/** Fired when data is received from any peer. */
	data: (peerId: string, data: unknown) => void;
	/** Fired when the host changes (either via initial join or migration). */
	hostChanged: (newHostId: string) => void;
	/** Fired on errors. */
	error: (err: Error) => void;
}

export interface RoomOptions {
	/** Milliseconds to wait for a new host to become reachable (default 10000). */
	readonly migrationTimeout?: number;
}

/**
 * A Room manages the lifecycle of a star-topology P2P room:
 * - First peer to join becomes the host (claims the room ID as its peer ID).
 * - Subsequent peers connect to the host.
 * - If the host disconnects, the remaining peer with the lowest alphabetical ID
 *   takes over as host (deterministic election).
 */
export class Room extends EventEmitter<RoomEvents> {
	private _peer: Dendri | null = null;
	private _isHost = false;
	private _hostId: string | null = null;
	private readonly _connections = new Map<string, DataConnection>();
	private readonly _knownPeers = new Set<string>();
	private readonly _topics = new TopicManager();
	private readonly _ackManager = new AckManager();
	private readonly _rpc = new RpcManager();
	private readonly _presence = new PresenceManager();
	private readonly _roomId: string;
	private readonly _migrationTimeout: number;
	private _dendriOptions: DendriOptions | null = null;
	private _DendriCtor: (new (id: string, opts?: DendriOptions) => Dendri) | null = null;
	private _migrationTimer: ReturnType<typeof setTimeout> | null = null;
	private _roomJoinInterval: ReturnType<typeof setInterval> | null = null;
	private _joined = false;

	constructor(roomId: string, options?: RoomOptions) {
		super();
		this._roomId = roomId;
		this._migrationTimeout = options?.migrationTimeout ?? 10_000;
	}

	/** Whether this peer is the current host. */
	get isHost(): boolean {
		return this._isHost;
	}

	/** The peer ID of the current host, or null if not yet joined. */
	get hostId(): string | null {
		return this._hostId;
	}

	/** All known peer IDs in the room (excluding self). */
	get peers(): string[] {
		return Array.from(this._knownPeers);
	}

	/** Number of known peers (excluding self). */
	get peerCount(): number {
		return this._knownPeers.size;
	}

	/** The local peer's ID, or null if not joined. */
	get peerId(): string | null {
		return this._peer?.id ?? null;
	}

	/**
	 * Join the room. Tries to become host first (claims roomId as peer ID).
	 * If the ID is already taken, joins as a client.
	 *
	 * @param DendriCtor - The Dendri constructor to use for creating peer instances.
	 * @param dendriOptions - Options forwarded to the Dendri constructor.
	 */
	join(
		DendriCtor: new (id: string, opts?: DendriOptions) => Dendri,
		dendriOptions: DendriOptions,
	): void {
		if (this._joined) {
			this.emit("error", new Error("Already joined this room"));
			return;
		}

		this._DendriCtor = DendriCtor;
		this._dendriOptions = dendriOptions;
		this._tryBecomeHost();
	}

	/**
	 * Send data to all peers in the room, optionally tagged with a topic.
	 * Tries WebRTC first; falls back to signaling server DATA relay when
	 * no WebRTC connections are open (e.g. behind a VPN).
	 */
	broadcast(data: unknown, options?: { readonly topic?: string }): void {
		const topic = options?.topic;
		const wire = topic ? { __topic: topic, __data: data } : data;

		let sentViaWebRTC = false;

		if (this._isHost) {
			for (const conn of this._connections.values()) {
				if (conn.open) {
					conn.send(wire);
					sentViaWebRTC = true;
				}
			}
		} else if (this._hostId) {
			const hostConn = this._connections.get(this._hostId);
			if (hostConn?.open) {
				hostConn.send(wire);
				sentViaWebRTC = true;
			}
		}

		// Relay fallback: always send via the signaling server when
		// `enableRelay` is configured. A DataConnection may report
		// "open" (ICE succeeded) but fail to deliver packets through
		// restrictive networks (VPNs, symmetric NAT, UDP blocked).
		// The relay ensures messages reach peers regardless of P2P
		// connectivity — duplicates on the receiving end are harmless
		// because topic envelopes are idempotent.
		if (this._dendriOptions?.enableRelay && this._peer?.socket) {
			this._peer.socket.send({
				type: ServerMessageType.Data,
				room: this._roomId,
				payload: wire,
			});
		} else if (!sentViaWebRTC && this._peer?.socket) {
			this._peer.socket.send({
				type: ServerMessageType.Data,
				room: this._roomId,
				payload: wire,
			});
		}
	}

	/**
	 * Broadcast a binary payload tagged with a topic. Wraps bytes in a
	 * base64 topic envelope so they survive both WebRTC fanout and the
	 * JSON-only signaling-relay fallback. Receivers see a Uint8Array.
	 */
	broadcastBinary(bytes: Uint8Array, options: { readonly topic: string }): void {
		const wire = {
			__topic: options.topic,
			__binary: true,
			__data: bytesToBase64(bytes),
		};

		let sentViaWebRTC = false;

		if (this._isHost) {
			for (const conn of this._connections.values()) {
				if (conn.open) {
					conn.send(wire);
					sentViaWebRTC = true;
				}
			}
		} else if (this._hostId) {
			const hostConn = this._connections.get(this._hostId);
			if (hostConn?.open) {
				hostConn.send(wire);
				sentViaWebRTC = true;
			}
		}

		if (this._dendriOptions?.enableRelay && this._peer?.socket) {
			this._peer.socket.send({
				type: ServerMessageType.Data,
				room: this._roomId,
				payload: wire,
			});
		} else if (!sentViaWebRTC && this._peer?.socket) {
			this._peer.socket.send({
				type: ServerMessageType.Data,
				room: this._roomId,
				payload: wire,
			});
		}
	}

	/**
	 * Broadcast data with delivery confirmation (at-least-once guarantee).
	 * Resolves when all currently connected peers have ACKed.
	 */
	async broadcastWithAck(data: unknown, timeoutMs: number = 5000): Promise<void> {
		const connections: DataConnection[] = [];

		if (this._isHost) {
			for (const conn of this._connections.values()) {
				if (conn.open) {
					connections.push(conn);
				}
			}
		} else if (this._hostId) {
			const hostConn = this._connections.get(this._hostId);
			if (hostConn?.open) {
				connections.push(hostConn);
			}
		}

		if (connections.length === 0) {
			return;
		}

		const promises: Promise<void>[] = [];

		for (const conn of connections) {
			const ackId = this._ackManager.nextId();
			conn.send({ __ackId: ackId, data });
			// Tag with the peer so a disconnect on that peer rejects the
			// promise immediately instead of waiting out the full timeout.
			promises.push(this._ackManager.waitForAck(ackId, timeoutMs, conn.peer));
		}

		await Promise.all(promises);
	}

	/**
	 * Subscribe to messages on a specific topic.
	 * Returns an unsubscribe function.
	 */
	subscribe(topic: string, handler: (data: unknown, peerId: string) => void): () => void {
		return this._topics.subscribe(topic, handler);
	}

	/**
	 * Subscribe to all incoming data regardless of topic.
	 * Returns an unsubscribe function.
	 */
	onData(handler: (data: unknown, peerId: string) => void): () => void {
		return this._topics.subscribeAll(handler);
	}

	/**
	 * Register an RPC method that other peers can call.
	 * Returns an unregister function.
	 */
	registerRpcMethod(name: string, handler: RpcHandler): () => void {
		return this._rpc.registerMethod(name, handler);
	}

	/**
	 * Call an RPC method on a remote peer (or broadcast to all).
	 *
	 * When `peerId` is specified the request is sent only to that peer.
	 * Otherwise it is broadcast to every connected peer (useful when any
	 * peer may handle the method).
	 */
	async performRpc(
		method: string,
		payload: unknown,
		options?: { readonly timeout?: number; readonly peerId?: string },
	): Promise<unknown> {
		return this._rpc.performRpc(
			method,
			payload,
			(request) => {
				const wire = { ...request, sender: this._peer?.id ?? "" };

				if (options?.peerId) {
					this._sendToPeer(options.peerId, wire);
				} else {
					this.broadcast(wire, { topic: "__rpc" });
				}
			},
			{ timeout: options?.timeout },
		);
	}

	/**
	 * Set my presence data -- automatically broadcast to all room peers
	 * via the signaling server's PRESENCE_UPDATE message.
	 */
	setPresence<P extends Record<string, unknown>>(data: P): void {
		this._presence.setMyPresence(data);

		if (this._peer?.socket) {
			this._peer.socket.send({
				type: ServerMessageType.PresenceUpdate,
				room: this._roomId,
				payload: this._presence.myPresence,
			});
		}
	}

	/** Get all other peers' presence data. */
	getOthers(): Map<string, unknown> {
		return this._presence.getOthers();
	}

	/** Get a specific peer's presence data. */
	getPresence(peerId: string): unknown {
		return this._presence.getPresence(peerId);
	}

	/** Get the presence manager for direct event listening. */
	get presence(): PresenceManager {
		return this._presence;
	}

	/**
	 * Leave the room and clean up all connections.
	 */
	leave(): void {
		this._clearMigrationTimer();
		this._stopRoomJoinHeartbeat();

		for (const conn of this._connections.values()) {
			conn.close();
		}
		this._connections.clear();
		this._knownPeers.clear();
		this._topics.clear();
		this._ackManager.clear();
		this._rpc.clear();
		this._presence.clear();

		if (this._peer) {
			this._peer.off("reconnected" as any, this._onSignalingReconnected);
			this._peer.destroy();
			this._peer = null;
		}

		this._isHost = false;
		this._hostId = null;
		this._joined = false;
		this._DendriCtor = null;
		this._dendriOptions = null;
	}

	// -----------------------------------------------------------------------
	// Internal: host path
	// -----------------------------------------------------------------------

	private _tryBecomeHost(): void {
		const peer = new this._DendriCtor!(this._roomId, this._dendriOptions!);

		peer.once("open", () => {
			this._postJoinSetup(peer, true);
			this.emit("joined", peer.id!, true);
		});

		peer.once("error", (err) => {
			// ID taken means someone else is host already
			if (err.type === "unavailable-id") {
				peer.destroy();
				this._joinAsClient();
				return;
			}

			this.emit("error", err);
		});
	}

	/**
	 * Wire up all listeners and register with the server-side room.
	 * Used by every entry path (_tryBecomeHost, _joinAsClient, _becomeHost)
	 * so the three can't drift out of sync. This is the single source of
	 * truth for "a peer has just entered the room".
	 */
	private _postJoinSetup(peer: Dendri, isHost: boolean): void {
		this._peer = peer;
		this._isHost = isHost;
		this._hostId = this._roomId;
		this._joined = true;
		this._presence.setMyPeerId(peer.id!);

		if (isHost) {
			this._setupHostListeners();
		}
		this._setupPresenceListener();
		this._setupSignalingPeerTracking();
		this._setupRelayDataListener();
		// Re-join the server-side room whenever the signaling socket
		// reconnects (e.g. after a DO hibernation wake-up). Otherwise the
		// server would not know we're in this room until the 30 s
		// heartbeat ticks, and broadcasts during that window would skip us.
		peer.on("reconnected" as any, this._onSignalingReconnected);

		peer.joinRoom(this._roomId);
		this._startRoomJoinHeartbeat();
	}

	private readonly _onSignalingReconnected = (): void => {
		if (this._peer && this._joined) {
			this._peer.joinRoom(this._roomId);
			// Also re-broadcast current presence so other peers' views
			// reflect our state immediately instead of on our next update.
			const current = this._presence.myPresence;
			if (current && Object.keys(current).length > 0) {
				this._peer.socket.send({
					type: ServerMessageType.PresenceUpdate,
					room: this._roomId,
					payload: current,
				});
			}
		}
	};

	private _setupHostListeners(): void {
		if (!this._peer) return;

		this._peer.on("connection", (conn: DataConnection) => {
			const remotePeerId = conn.peer;
			this._connections.set(remotePeerId, conn);
			this._knownPeers.add(remotePeerId);
			this.emit("peerJoined", remotePeerId);

			conn.on("open", () => {
				// Notify existing clients about the new peer
				for (const [peerId, c] of this._connections) {
					if (peerId !== remotePeerId && c.open) {
						c.send({ __room: { type: "peer-joined", peerId: remotePeerId } });
					}
				}

				// Inform the new peer about existing peers
				conn.send({
					__room: {
						type: "peer-list",
						peers: this.peers,
					},
				});
			});

			conn.on("data", (data: unknown) => {
				this._handleIncomingData(remotePeerId, data);
			});

			conn.on("close", () => {
				this._connections.delete(remotePeerId);
				this._knownPeers.delete(remotePeerId);
				this._presence.handleLeave(remotePeerId);
				// Fail outstanding broadcastWithAck promises targeting this
				// peer immediately; otherwise they stall to the full
				// timeout after the transport already knows they're gone.
				this._ackManager.rejectAllForPeer(remotePeerId);

				// Notify remaining clients about the departed peer
				for (const c of this._connections.values()) {
					if (c.open) {
						c.send({ __room: { type: "peer-left", peerId: remotePeerId } });
					}
				}

				this.emit("peerLeft", remotePeerId);
			});
		});
	}

	// -----------------------------------------------------------------------
	// Internal: client path
	// -----------------------------------------------------------------------

	private _joinAsClient(): void {
		// Create peer with server-assigned ID
		const peer = new this._DendriCtor!("", this._dendriOptions!);

		peer.once("open", () => {
			this._postJoinSetup(peer, false);

			// Attempt WebRTC connection to host for lower latency.
			const conn = peer.connect(this._roomId);
			if (conn) {
				this._connections.set(this._roomId, conn);

				conn.on("data", (data: unknown) => {
					this._handleIncomingData(this._roomId!, data);
				});

				conn.on("close", () => {
					this._connections.delete(this._roomId);
					this._handleHostDisconnect();
				});
			}

			// Emit joined immediately — the signaling relay ensures data
			// can flow even if WebRTC never connects (e.g. behind a VPN).
			this._knownPeers.add(this._roomId);
			this.emit("joined", peer.id!, false);
		});

		peer.once("error", (err) => {
			this.emit("error", err);
		});
	}

	// -----------------------------------------------------------------------
	// Internal: host migration
	// -----------------------------------------------------------------------

	/**
	 * Called when the client detects the host has disconnected.
	 * Elects a new host deterministically (lowest alphabetical peer ID).
	 */
	private _handleHostDisconnect(): void {
		if (!this._peer?.id) return;

		const oldHostId = this._hostId;

		// Remove the departed host from known peers and emit peerLeft
		if (oldHostId && this._knownPeers.has(oldHostId)) {
			this._knownPeers.delete(oldHostId);
			this._presence.handleLeave(oldHostId);
			this._ackManager.rejectAllForPeer(oldHostId);
			this.emit("peerLeft", oldHostId);
		}

		const remainingPeers = Array.from(this._knownPeers);

		const newHostId = electNewHost(this._peer.id, remainingPeers);
		this._hostId = newHostId;

		this.emit("hostChanged", newHostId);

		if (newHostId === this._peer.id) {
			this._becomeHost();
		} else {
			this._connectToNewHost(newHostId);
		}
	}

	/**
	 * This peer won the election. Tear down the old peer and create a new
	 * one using the room ID so other peers can find us.
	 */
	private _becomeHost(): void {
		const oldPeer = this._peer;
		if (oldPeer) {
			oldPeer.destroy();
		}

		this._connections.clear();
		// Reset joined so _postJoinSetup runs the full wiring from scratch.
		// Heartbeat, presence, relay, and signaling tracking all need fresh
		// listeners on the new peer.
		this._joined = false;
		this._stopRoomJoinHeartbeat();

		const peer = new this._DendriCtor!(this._roomId, this._dendriOptions!);

		peer.once("open", () => {
			this._postJoinSetup(peer, true);
			// Migration happened — no "joined" emit (it was emitted on
			// initial join), but the app may care that we now host.
		});

		peer.once("error", (err) => {
			// Split-brain: two survivors elected themselves simultaneously
			// and both tried to claim the room ID. The loser falls back to
			// joining as a client so the room heals instead of dying.
			if (err.type === "unavailable-id") {
				peer.destroy();
				this._isHost = false;
				this._joinAsClient();
				return;
			}
			this.emit("error", err);
		});
	}

	/**
	 * Another peer won the election. Wait for it to claim the room ID,
	 * then connect.
	 */
	private _connectToNewHost(hostId: string): void {
		this._clearMigrationTimer();

		this._migrationTimer = setTimeout(() => {
			// The elected host never came online. Drop them from known
			// peers and re-run election with the remaining candidates
			// instead of surfacing a dead-end error. Without this the
			// room stalls until the app calls leave()+join().
			if (this._knownPeers.has(hostId)) {
				this._knownPeers.delete(hostId);
				this._presence.handleLeave(hostId);
				this._ackManager.rejectAllForPeer(hostId);
				this.emit("peerLeft", hostId);
			}

			if (this._knownPeers.size === 0 && this._peer?.id) {
				// Only self remains — become host.
				this._handleHostDisconnect();
				return;
			}

			if (this._peer?.id) {
				// Re-elect with remaining peers.
				this._handleHostDisconnect();
			} else {
				this.emit(
					"error",
					new Error(
						`Host migration timed out after ${this._migrationTimeout}ms waiting for ${hostId}`,
					),
				);
			}
		}, this._migrationTimeout);

		// The new host needs time to register with the room ID.
		// Retry connecting on a short interval.
		this._retryConnect(hostId, 0);
	}

	private _retryConnect(hostId: string, attempts: number): void {
		const MAX_RETRIES = 10;
		const RETRY_DELAY = 1_000;

		if (!this._peer || attempts >= MAX_RETRIES) {
			return;
		}

		const conn = this._peer.connect(hostId);
		if (!conn) return;

		conn.on("open", () => {
			this._clearMigrationTimer();
			this._connections.set(hostId, conn);

			conn.on("data", (data: unknown) => {
				this._handleIncomingData(hostId, data);
			});

			conn.on("close", () => {
				this._connections.delete(hostId);
				this._handleHostDisconnect();
			});
		});

		conn.on("error", () => {
			setTimeout(() => {
				this._retryConnect(hostId, attempts + 1);
			}, RETRY_DELAY);
		});
	}

	// -----------------------------------------------------------------------
	// Internal: data routing
	// -----------------------------------------------------------------------

	private _handleIncomingData(fromPeerId: string, data: unknown): void {
		// Check for internal room protocol messages
		if (this._isRoomProtocol(data)) {
			this._handleRoomProtocol(fromPeerId, data);
			return;
		}

		// Handle ACK responses from peers.
		if (this._isAckResponse(data)) {
			this._ackManager.handleAck(data.__ackResponse);
			return;
		}

		// Handle RPC responses — resolve pending performRpc calls.
		if (isRpcResponse(data)) {
			this._rpc.handleResponse(data);
			return;
		}

		// Handle RPC requests — execute handler and send response back.
		if (isRpcRequest(data)) {
			void this._rpc.handleRequest(data).then((response) => {
				this._sendToPeer(fromPeerId, response);
			});
			return;
		}

		// Handle incoming data with __ackId — send ACK back to sender.
		if (this._isAckRequest(data)) {
			const conn = this._connections.get(fromPeerId);
			if (conn?.open) {
				conn.send({ __ackResponse: data.__ackId });
			}
			// Replace data with the unwrapped inner payload for downstream processing.
			data = data.data;
		}

		// If we're the host, relay to all other peers (pass raw wire data)
		if (this._isHost) {
			for (const [peerId, conn] of this._connections) {
				if (peerId !== fromPeerId && conn.open) {
					conn.send(data);
				}
			}
		}

		// Unwrap topic envelope and dispatch through TopicManager
		if (isTopicEnvelope(data)) {
			const payload =
				data.__binary === true && typeof data.__data === "string"
					? base64ToBytes(data.__data)
					: data.__data;
			this._topics.dispatch(data.__topic, payload, fromPeerId);
			this.emit("data", fromPeerId, payload);
		} else {
			this._topics.dispatch(undefined, data, fromPeerId);
			this.emit("data", fromPeerId, data);
		}
	}

	private _isAckRequest(data: unknown): data is { __ackId: string; data: unknown } {
		return (
			typeof data === "object" &&
			data !== null &&
			"__ackId" in data &&
			typeof (data as Record<string, unknown>).__ackId === "string"
		);
	}

	private _isAckResponse(data: unknown): data is { __ackResponse: string } {
		return (
			typeof data === "object" &&
			data !== null &&
			"__ackResponse" in data &&
			typeof (data as Record<string, unknown>).__ackResponse === "string"
		);
	}

	private _isRoomProtocol(
		data: unknown,
	): data is { __room: { type: string; peers?: string[]; peerId?: string } } {
		return (
			typeof data === "object" &&
			data !== null &&
			"__room" in data &&
			typeof (data as Record<string, unknown>).__room === "object"
		);
	}

	private _handleRoomProtocol(
		_fromPeerId: string,
		data: { __room: { type: string; peers?: string[]; peerId?: string } },
	): void {
		const msg = data.__room;

		if (msg.type === "peer-list" && Array.isArray(msg.peers)) {
			for (const peerId of msg.peers) {
				if (peerId !== this._peer?.id && !this._knownPeers.has(peerId)) {
					this._knownPeers.add(peerId);
					this.emit("peerJoined", peerId);
				}
			}
		} else if (msg.type === "peer-joined" && msg.peerId) {
			if (msg.peerId !== this._peer?.id && !this._knownPeers.has(msg.peerId)) {
				this._knownPeers.add(msg.peerId);
				this.emit("peerJoined", msg.peerId);
			}
		} else if (msg.type === "peer-left" && msg.peerId) {
			if (this._knownPeers.has(msg.peerId)) {
				this._knownPeers.delete(msg.peerId);
				this._presence.handleLeave(msg.peerId);
				this.emit("peerLeft", msg.peerId);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Internal: presence
	// -----------------------------------------------------------------------

	/**
	 * Hook up the underlying Dendri peer's presenceUpdate event so incoming
	 * server-side presence broadcasts are routed to the PresenceManager.
	 */
	private _setupPresenceListener(): void {
		if (!this._peer) return;

		this._peer.on("presenceUpdate" as any, (peerId: string, room: string, data: unknown) => {
			if (room === this._roomId && peerId !== this._peer?.id) {
				this._presence.handleUpdate(peerId, data as Record<string, unknown>);
			}
		});
	}

	// -----------------------------------------------------------------------
	// Internal: signaling relay data listener
	// -----------------------------------------------------------------------

	/**
	 * Listen for relay DATA messages from the signaling server (room fan-out).
	 * This is the fallback path when WebRTC connections can't be established
	 * (e.g. behind a VPN or restrictive firewall).
	 */
	private _setupRelayDataListener(): void {
		if (!this._peer) return;

		this._peer.on("relayData" as any, (peerId: string, payload: unknown, room: string) => {
			if (room !== this._roomId) return;
			if (peerId === this._peer?.id) return; // ignore own messages

			// Track peers we see via relay
			if (!this._knownPeers.has(peerId)) {
				this._knownPeers.add(peerId);
				this.emit("peerJoined", peerId);
			}

			this._handleIncomingData(peerId, payload);
		});
	}

	// -----------------------------------------------------------------------
	// Internal: signaling-based peer tracking
	// -----------------------------------------------------------------------

	/**
	 * Listen for ROOM-PEERS messages from the signaling server and merge them
	 * into `_knownPeers`. This ensures the peer count stays accurate even when
	 * WebRTC connections fail (e.g. behind a VPN or restrictive firewall).
	 *
	 * WebRTC-connected peers are always trusted. Peers that only appear in the
	 * signaling list are added as "signaling-only" so the UI reflects the
	 * correct room membership.
	 */
	private _setupSignalingPeerTracking(): void {
		if (!this._peer) return;

		this._peer.on("roomPeers" as any, (room: string, peers: string[]) => {
			if (room !== this._roomId) return;

			const myId = this._peer?.id;
			if (!myId) return;

			const remotePeerSet = new Set(peers.filter((id) => id !== myId));

			// Add peers the signaling server knows about that we don't yet.
			for (const peerId of remotePeerSet) {
				if (!this._knownPeers.has(peerId)) {
					this._knownPeers.add(peerId);
					this.emit("peerJoined", peerId);
				}
			}

			// Remove peers absent from signaling AND without an active connection.
			for (const peerId of this._knownPeers) {
				if (!remotePeerSet.has(peerId)) {
					const conn = this._connections.get(peerId);
					if (!conn?.open) {
						this._knownPeers.delete(peerId);
						this._presence.handleLeave(peerId);
						this.emit("peerLeft", peerId);
					}
				}
			}
		});
	}

	// -----------------------------------------------------------------------
	// Internal: helpers
	// -----------------------------------------------------------------------

	/**
	 * Send data directly to a specific peer.
	 * If host: send via the direct connection.
	 * If client: send via the host connection (host relays).
	 */
	private _sendToPeer(peerId: string, data: unknown): void {
		const conn = this._connections.get(peerId);
		if (conn?.open) {
			conn.send(data);
			// When relay is enabled, also send via signaling server
			// as backup for restrictive networks (VPN, symmetric NAT).
			if (this._dendriOptions?.enableRelay && this._peer?.socket) {
				this._peer.socket.send({
					type: ServerMessageType.Data,
					dst: peerId,
					room: this._roomId,
					payload: data,
				});
			}
			return;
		}

		// If we're a client the only connection is to the host.
		// Send to the host and let it relay.
		if (!this._isHost && this._hostId) {
			const hostConn = this._connections.get(this._hostId);
			if (hostConn?.open) {
				hostConn.send(data);
			}
		}
	}

	private _clearMigrationTimer(): void {
		if (this._migrationTimer) {
			clearTimeout(this._migrationTimer);
			this._migrationTimer = null;
		}
	}

	/**
	 * Periodically re-send ROOM-JOIN to the signaling server so room
	 * membership survives server-side state loss (e.g. DO hibernation).
	 */
	private _startRoomJoinHeartbeat(): void {
		this._stopRoomJoinHeartbeat();
		this._roomJoinInterval = setInterval(() => {
			if (this._peer && this._joined) {
				this._peer.joinRoom(this._roomId);
			}
		}, 30_000);
	}

	private _stopRoomJoinHeartbeat(): void {
		if (this._roomJoinInterval) {
			clearInterval(this._roomJoinInterval);
			this._roomJoinInterval = null;
		}
	}
}
