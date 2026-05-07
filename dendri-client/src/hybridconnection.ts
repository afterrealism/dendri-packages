import { EventEmitter } from "eventemitter3";
import { AckManager } from "./ack";
import type { DataConnection } from "./dataconnection/DataConnection";
import type { Dendri } from "./dendri";
import { RelayEncryption } from "./encryption";
import { type ConnectionQuality, ServerMessageType, TransportMode } from "./enums";
import logger from "./logger";
import type { HybridConnectionOption } from "./optionInterfaces";
import { isTopicEnvelope, TopicManager } from "./topics";

/** Options accepted by {@link HybridConnection.send}. */
export interface HybridSendOptions {
	/** When set, the message is tagged with this topic string. */
	readonly topic?: string;
}

interface HybridConnectionEvents {
	open: () => void;
	data: (data: unknown) => void;
	close: () => void;
	error: (err: Error) => void;
	transportChanged: (mode: TransportMode) => void;
	qualityChanged: (quality: ConnectionQuality) => void;
}

/**
 * Wraps both a WebRTC DataConnection and a WebSocket relay,
 * switching transparently between them.
 *
 * - Attempts WebRTC first; falls back to WS relay on ICE timeout.
 * - Periodically retries WebRTC upgrade when on relay.
 * - Emits `transportChanged` whenever the active transport switches.
 */
export class HybridConnection extends EventEmitter<HybridConnectionEvents> {
	readonly peer: string;
	private readonly _provider: Dendri;
	private readonly _options: Readonly<HybridConnectionOption>;
	private _dataConnection: DataConnection | null = null;
	private _mode: TransportMode = TransportMode.Reconnecting;
	private _iceTimer: ReturnType<typeof setTimeout> | null = null;
	private _upgradeTimer: ReturnType<typeof setInterval> | null = null;
	private _upgradeAttempts: number = 0;
	private _open: boolean = false;
	private _closed: boolean = false;
	private readonly _ackManager = new AckManager();
	private readonly _topics = new TopicManager();
	private readonly _encryption = new RelayEncryption();
	private readonly _encryptRelay: boolean;
	private _keyExchangeSent = false;
	private _pendingRelayQueue: unknown[] = [];

	// --- Reorder buffer for sequenced relay delivery ---
	// `null` means no baseline seen yet; the first message establishes it.
	// Using a real sentinel avoids the `=== 0` check misfiring when the
	// server assigns seq=0 (valid after a restart).
	private _expectedSeq: number | null = null;
	private _reorderBuffer = new Map<number, unknown>();
	private readonly _reorderTimeout = 500; // ms to wait for missing messages
	// Track pending gap timers so close() can cancel them; otherwise a
	// timer firing after close will emit on a dead emitter.
	private _reorderTimers = new Set<ReturnType<typeof setTimeout>>();

	constructor(peer: string, provider: Dendri, options: HybridConnectionOption = {}) {
		super();

		this.peer = peer;
		this._provider = provider;
		this._options = Object.freeze({ ...options });
		this._encryptRelay = options.encryptRelay ?? true;
	}

	get mode(): TransportMode {
		return this._mode;
	}

	get open(): boolean {
		return this._open;
	}

	/** Start connection: try WebRTC first, fall back to WS relay on timeout. */
	start(): void {
		if (this._closed) {
			return;
		}

		logger.log(
			`HybridConnection: start peer=${this.peer} iceTimeout=${this._options.iceTimeout ?? 10_000}ms encryptRelay=${this._encryptRelay}`,
		);

		if (typeof this._provider?.on !== "function") {
			this._attemptWebRTC();
			return;
		}

		this._tryConnectionReversal().then((direct) => {
			if (direct) return;
			this._attemptWebRTC();
		});
	}

	/** Send data through the best available transport, optionally tagged with a topic. */
	send(data: unknown, options?: HybridSendOptions): void {
		if (this._closed) {
			this.emit("error", new Error("Connection is closed."));
			return;
		}

		if (!this._open) {
			this.emit(
				"error",
				new Error("Connection is not open. Listen for the `open` event before sending."),
			);
			return;
		}

		const topic = options?.topic;
		const wire = topic ? { __topic: topic, __data: data } : data;

		if (this._mode === TransportMode.WebRTC && this._dataConnection?.open) {
			this._dataConnection.send(wire);
		} else if (this._mode === TransportMode.WebSocketRelay) {
			this._sendRelay(wire);
		} else {
			this.emit("error", new Error(`No transport available (current mode: ${this._mode}).`));
		}
	}

	/**
	 * Send data with delivery confirmation (at-least-once guarantee).
	 * Resolves when the remote peer ACKs, rejects on timeout.
	 */
	async sendWithAck(data: unknown, timeoutMs?: number): Promise<void> {
		if (this._closed) {
			throw new Error("Connection is closed.");
		}

		if (!this._open) {
			throw new Error("Connection is not open. Listen for the `open` event before sending.");
		}

		const ackId = this._ackManager.nextId();

		if (this._mode === TransportMode.WebRTC && this._dataConnection?.open) {
			this._dataConnection.send({ __ackId: ackId, data });
		} else if (this._mode === TransportMode.WebSocketRelay) {
			this._sendRelay({ __ackId: ackId, data });
		} else {
			throw new Error(`No transport available (current mode: ${this._mode}).`);
		}

		return this._ackManager.waitForAck(ackId, timeoutMs);
	}

	/**
	 * @internal
	 * Expose the AckManager so the Dendri instance can route incoming ACKs.
	 */
	get ackManager(): AckManager {
		return this._ackManager;
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
	 * Handle a DATA message received via WebSocket relay.
	 * Called by Dendri._handleMessage when routing relay data.
	 *
	 * @param payload - The message payload.
	 * @param seq - Optional server-assigned sequence number for ordering.
	 */
	handleRelayData(payload: unknown, seq?: number): void {
		if (
			this._encryptRelay &&
			this._encryption.ready &&
			payload !== null &&
			typeof payload === "object" &&
			"__encrypted" in payload
		) {
			const enc = payload as { __encrypted: { iv: string; ciphertext: string } };
			this._encryption
				.decrypt(enc.__encrypted)
				.then((plaintext) => {
					this._deliverInOrder(seq, JSON.parse(plaintext));
				})
				.catch((err) => {
					this.emit("error", new Error(`Relay decryption failed: ${String(err)}`));
				});
			return;
		}

		this._deliverInOrder(seq, payload);
	}

	/** Close connection and clean up all resources. */
	close(): void {
		if (this._closed) {
			return;
		}

		this._closed = true;
		this._clearIceTimer();
		this._clearUpgradeTimer();
		this._ackManager.clear();
		this._topics.clear();
		this._encryption.clear();
		this._pendingRelayQueue = [];
		this._keyExchangeSent = false;
		this._reorderBuffer.clear();
		this._expectedSeq = null;
		for (const t of this._reorderTimers) clearTimeout(t);
		this._reorderTimers.clear();

		if (this._dataConnection) {
			this._dataConnection.close();
			this._dataConnection = null;
		}

		if (this._open) {
			this._open = false;
			this.emit("close");
		}

		this.removeAllListeners();
	}

	/**
	 * Initiate the ECDH key exchange by generating a key pair and sending
	 * the public key to the remote peer via signaling.
	 */
	initiateKeyExchange(): void {
		if (!this._encryptRelay || this._keyExchangeSent) {
			return;
		}

		// Set the flag synchronously before the await so a second call made
		// before generateKeyPair resolves is rejected. Otherwise two key
		// pairs could be generated and the second would silently replace
		// the first, invalidating messages already encrypted with key A.
		this._keyExchangeSent = true;

		this._encryption
			.generateKeyPair()
			.then((publicKey) => {
				this._provider.socket.send({
					type: ServerMessageType.KeyExchange,
					dst: this.peer,
					payload: { publicKey },
				});
			})
			.catch((err) => {
				// Roll back so a retry can succeed.
				this._keyExchangeSent = false;
				this.emit("error", new Error(`Key exchange initiation failed: ${String(err)}`));
			});
	}

	/**
	 * Handle an incoming KEY_EXCHANGE message from the remote peer.
	 * Derives the shared secret and sends our public key back if we haven't yet.
	 */
	handleKeyExchange(payload: { publicKey: JsonWebKey }): void {
		if (!this._encryptRelay) {
			return;
		}

		const deriveAndFlush = (remoteKey: JsonWebKey): void => {
			this._encryption
				.deriveSharedKey(remoteKey)
				.then(() => {
					logger.log(`HybridConnection: E2E encryption established with ${this.peer}`);
					this._flushPendingRelayQueue();
				})
				.catch((err) => {
					this.emit("error", new Error(`Key derivation failed: ${String(err)}`));
				});
		};

		if (!this._keyExchangeSent) {
			// We received the first KEY_EXCHANGE — generate our key pair and respond.
			// Flag set synchronously to block a concurrent initiateKeyExchange.
			this._keyExchangeSent = true;
			this._encryption
				.generateKeyPair()
				.then((publicKey) => {
					this._provider.socket.send({
						type: ServerMessageType.KeyExchange,
						dst: this.peer,
						payload: { publicKey },
					});
					deriveAndFlush(payload.publicKey);
				})
				.catch((err) => {
					this._keyExchangeSent = false;
					this.emit("error", new Error(`Key exchange response failed: ${String(err)}`));
				});
		} else {
			// We already sent our key — just derive from the peer's key.
			deriveAndFlush(payload.publicKey);
		}
	}

	/**
	 * Send a payload via WebSocket relay, encrypting it if encryption is ready.
	 * If encryption is enabled but not yet ready, the message is queued.
	 */
	private _sendRelay(wire: unknown): void {
		if (!this._encryptRelay) {
			this._provider.socket.send({
				type: ServerMessageType.Data,
				dst: this.peer,
				payload: wire,
			});
			return;
		}

		if (!this._encryption.ready) {
			// Key exchange in progress — queue the message.
			this._pendingRelayQueue.push(wire);
			return;
		}

		const serialized = JSON.stringify(wire);
		this._encryption
			.encrypt(serialized)
			.then((encrypted) => {
				this._provider.socket.send({
					type: ServerMessageType.Data,
					dst: this.peer,
					payload: { __encrypted: encrypted },
				});
			})
			.catch((err) => {
				this.emit("error", new Error(`Relay encryption failed: ${String(err)}`));
			});
	}

	/** Flush messages that were queued while waiting for key exchange. */
	private _flushPendingRelayQueue(): void {
		const queued = [...this._pendingRelayQueue];
		this._pendingRelayQueue = [];

		for (const wire of queued) {
			this._sendRelay(wire);
		}
	}

	/**
	 * Enforce ordered delivery for sequenced relay messages.
	 * Messages without a seq or when not in relay mode are delivered immediately.
	 */
	private _deliverInOrder(seq: number | undefined, data: unknown): void {
		if (seq === undefined || !this._encryptRelay) {
			// No seq or not in relay mode -- deliver immediately (backward compat)
			this._dispatchIncoming(data);
			return;
		}

		if (this._expectedSeq === null) {
			// First message -- establish baseline.
			this._dispatchIncoming(data);
			this._expectedSeq = seq + 1;
			return;
		}

		if (seq === this._expectedSeq) {
			// In order -- deliver and flush any buffered
			this._dispatchIncoming(data);
			this._expectedSeq = seq + 1;
			this._flushReorderBuffer();
		} else if (seq > this._expectedSeq) {
			// Out of order -- buffer it
			this._reorderBuffer.set(seq, data);
			// Track the timer so close() can cancel it. If we don't, a
			// late fire after close would dispatch on a closed emitter.
			const timer = setTimeout(() => {
				this._reorderTimers.delete(timer);
				if (this._closed) return;
				if (this._reorderBuffer.has(seq)) {
					this._forceFlushReorderBuffer();
				}
			}, this._reorderTimeout);
			this._reorderTimers.add(timer);
		}
		// seq < _expectedSeq = duplicate, ignore
	}

	/** Flush consecutive messages from the reorder buffer. */
	private _flushReorderBuffer(): void {
		if (this._expectedSeq === null) return;
		while (this._reorderBuffer.has(this._expectedSeq)) {
			this._dispatchIncoming(this._reorderBuffer.get(this._expectedSeq));
			this._reorderBuffer.delete(this._expectedSeq);
			this._expectedSeq++;
		}
	}

	/**
	 * Force-flush the reorder buffer when a timeout fires.
	 * Skips past any gaps by advancing _expectedSeq to the lowest buffered
	 * sequence, then delivers all consecutive messages from there.
	 */
	private _forceFlushReorderBuffer(): void {
		if (this._reorderBuffer.size === 0) {
			return;
		}

		// Find the lowest buffered seq and skip the gap.
		let minSeq = Number.MAX_SAFE_INTEGER;
		for (const seq of this._reorderBuffer.keys()) {
			if (seq < minSeq) {
				minSeq = seq;
			}
		}

		// Skip past the gap to the lowest buffered message.
		this._expectedSeq = minSeq;
		this._flushReorderBuffer();
	}

	/**
	 * Route an incoming payload through the TopicManager (if applicable)
	 * and emit the generic `data` event.
	 *
	 * If the payload is a topic envelope, the inner data is extracted and
	 * dispatched to topic-specific handlers. The raw `data` event always fires
	 * with the unwrapped payload so legacy listeners still work.
	 */
	private _dispatchIncoming(payload: unknown): void {
		if (isTopicEnvelope(payload)) {
			this._topics.dispatch(payload.__topic, payload.__data, this.peer);
			this.emit("data", payload.__data);
		} else {
			this._topics.dispatch(undefined, payload, this.peer);
			this.emit("data", payload);
		}
	}

	/** Attempt a WebRTC connection with ICE timeout. */
	private _attemptWebRTC(): void {
		if (this._closed) {
			return;
		}

		const iceTimeout = this._options.iceTimeout ?? 10_000;

		// Start WebRTC negotiation via the provider's existing connect() method.
		const dc = this._provider.connect(this.peer, { reliable: true });

		if (!dc) {
			// connect() returned undefined (disconnected, invalid peer, etc.)
			this._fallbackToRelay();
			return;
		}

		this._dataConnection = dc;

		// Set ICE timeout — if WebRTC hasn't opened by then, fall back.
		this._iceTimer = setTimeout(() => {
			if (this._mode !== TransportMode.WebRTC) {
				logger.warn(
					`HybridConnection: ICE timeout after ${iceTimeout}ms for ${this.peer}, falling back to relay`,
				);
				this._fallbackToRelay();
			}
		}, iceTimeout);

		this._dataConnection.on("open", () => {
			logger.log(`HybridConnection: WebRTC opened to ${this.peer} (attempt ${this._upgradeAttempts + 1})`);
			this._clearIceTimer();
			this._clearUpgradeTimer();
			this._upgradeAttempts = 0;
			this._setMode(TransportMode.WebRTC);

			if (!this._open) {
				this._open = true;
				this.emit("open");
			}
		});

		this._dataConnection.on("data", (data) => {
			this._dispatchIncoming(data);
		});

		this._dataConnection.on("close", () => {
			if (this._open && !this._closed) {
				// WebRTC dropped mid-session — fall back to relay.
				logger.log(`HybridConnection: WebRTC to ${this.peer} closed, falling back to relay`);
				this._dataConnection = null;
				this._fallbackToRelay();
			}
		});

		this._dataConnection.on("error", (err) => {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		});
	}

	/** Switch to WebSocket relay and optionally schedule periodic upgrade attempts. */
	private _fallbackToRelay(): void {
		if (this._closed) {
			return;
		}

		this._clearIceTimer();
		this._setMode(TransportMode.WebSocketRelay);

		if (!this._open) {
			this._open = true;
			this.emit("open");
		}

		// Initiate E2E encryption key exchange for the relay path.
		this.initiateKeyExchange();

		this._scheduleUpgrade();
	}

	/** Update the transport mode and emit if changed. */
	private _setMode(mode: TransportMode): void {
		if (this._mode !== mode) {
			logger.log(`HybridConnection: transport ${this._mode} -> ${mode} for ${this.peer}`);
			this._mode = mode;
			this.emit("transportChanged", mode);
		}
	}

	private _clearIceTimer(): void {
		if (this._iceTimer !== null) {
			clearTimeout(this._iceTimer);
			this._iceTimer = null;
		}
	}

	private _clearUpgradeTimer(): void {
		if (this._upgradeTimer !== null) {
			clearInterval(this._upgradeTimer);
			this._upgradeTimer = null;
		}
	}

	/**
	 * Periodically retry WebRTC when on relay.
	 * Respects `autoUpgrade`, `upgradeInterval`, and `maxUpgradeAttempts` options.
	 */
	private _scheduleUpgrade(): void {
		if (!(this._options.autoUpgrade ?? true)) {
			return;
		}

		// Don't stack multiple upgrade timers.
		this._clearUpgradeTimer();

		const interval = this._options.upgradeInterval ?? 60_000;
		const maxAttempts = this._options.maxUpgradeAttempts ?? 5;

		this._upgradeTimer = setInterval(() => {
			if (this._closed) {
				this._clearUpgradeTimer();
				return;
			}

			if (this._upgradeAttempts >= maxAttempts) {
				this._clearUpgradeTimer();
				return;
			}

			this._upgradeAttempts++;
			this._attemptWebRTC();
		}, interval);
	}

	private async _tryConnectionReversal(): Promise<boolean> {
		if (typeof this._provider?.on !== "function") return false;
		try {
			const resp = await new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), 3000);
				const handler = (data: unknown) => {
					clearTimeout(timer);
					(this._provider as any).off(ServerMessageType.ConnectRequest, handler);
					resolve(data);
				};
				(this._provider as any).on(ServerMessageType.ConnectRequest, handler);
				this._provider.socket.send({
					type: ServerMessageType.ConnectRequest,
					payload: { peer: this.peer },
				});
			});
			const addr = (resp as any)?.address;
			if (!addr) return false;
			const pc = new RTCPeerConnection(this._provider.options.config);
			const dc = pc.createDataChannel("probe", { id: 0 });
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { pc.close(); reject(new Error("direct-dial-timeout")); }, 2500);
				dc.onopen = () => { clearTimeout(timer); resolve(); };
				dc.onerror = () => { clearTimeout(timer); pc.close(); reject(new Error("dc-error")); };
			});
			this._dataConnection = undefined as any;
			this._setMode(TransportMode.WebRTC);
			pc.close();
			return true;
		} catch {
			return false;
		}
	}

	private async _gatherSrflxCandidates(): Promise<string[]> {
		const pc = new RTCPeerConnection({ iceServers: this._provider.options.config?.iceServers });
		pc.createDataChannel("probe");
		const offer = await pc.createOffer();
		await pc.setLocalDescription(offer);
		const candidates: string[] = [];
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 2000);
			pc.onicecandidate = (evt) => {
				if (!evt.candidate) { clearTimeout(timer); resolve(); return; }
				if (!evt.candidate.candidate.includes("typ host")) {
					candidates.push(evt.candidate.candidate);
				}
			};
		});
		pc.close();
		return candidates;
	}

	async _dcutrHolePunch(): Promise<boolean> {
		try {
			const localAddrs = await this._gatherSrflxCandidates();
			const t0 = performance.now();
			const peerAddrs = await new Promise<string[]>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("dcutr-timeout")), 8000);
				const handler = (data: unknown) => {
					clearTimeout(timer);
					(this._provider as any).off(ServerMessageType.DcutrConnect, handler);
					resolve(((data as any)?.addresses ?? []) as string[]);
				};
				(this._provider as any).on(ServerMessageType.DcutrConnect, handler);
				this._provider.socket.send({
					type: ServerMessageType.DcutrConnect,
					payload: { addresses: localAddrs },
				});
			});
			const relayRtt = performance.now() - t0;
			this._provider.socket.send({ type: ServerMessageType.DcutrSync, payload: {} });
			await new Promise((r) => setTimeout(r, relayRtt / 2));
			for (let i = 0; i < Math.min(peerAddrs.length, 4); i++) {
				try {
					const pc = new RTCPeerConnection(this._provider.options.config);
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(() => { pc.close(); reject(new Error("dc-dial-timeout")); }, 5000);
						const dc = pc.createDataChannel("dcutr");
						dc.onopen = () => { clearTimeout(timer); resolve(); };
					});
					this._dataConnection = undefined as any;
					this._setMode(TransportMode.WebRTC);
					pc.close();
					return true;
				} catch { continue; }
			}
			return false;
		} catch {
			return false;
		}
	}
}
