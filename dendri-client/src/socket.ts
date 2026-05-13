import { ServerMessageType, SocketEventType } from "./enums";
import logger from "./logger";
import { SignalingTransport } from "./transport";

declare const __VERSION__: string;
const version = __VERSION__;

/**
 * An abstraction on top of WebSockets to provide fastest
 * possible connection for peers.
 */
export class Socket extends SignalingTransport {
	private _disconnected: boolean = true;
	private _id?: string;
	private _messagesQueue: Array<object> = [];
	private _socket?: WebSocket;
	private _wsPingTimer?: any;
	private _heartbeatWorker: Worker | null = null;
	private _heartbeatWorkerUrl: string | undefined = undefined;
	private _visibilityHandler?: () => void;
	private readonly _baseUrl: string;

	/** When true, unexpected closes trigger automatic reconnection (enabled by default). */
	private _autoReconnect: boolean = true;

	/** Tracks the last server-assigned sequence number for replay on reconnect. */
	private _lastSeq: number = 0;

	/** Current reconnect attempt counter (reset on successful connection). */
	private _reconnectAttempt: number = 0;

	/** Timer handle for the pending reconnect delay. */
	private _reconnectTimer?: ReturnType<typeof setTimeout>;

	/** Saved token for reconnection. */
	private _token?: string;

	/** Optional JWT for authenticated connections. */
	private readonly _jwt?: string;

	/** Backoff schedule base delays in milliseconds. */
	private static readonly BACKOFF_SCHEDULE = [0, 1000, 2000, 4000, 8000, 16000, 30000];

	/** Random jitter range in milliseconds (applied as +/-). */
	private static readonly BACKOFF_JITTER = 500;

	constructor(
		secure: boolean,
		host: string,
		port: number,
		path: string,
		key: string,
		private readonly pingInterval: number = 5000,
		jwt?: string,
	) {
		super();

		const wsProtocol = secure ? "wss://" : "ws://";

		this._baseUrl = `${wsProtocol + host}:${port}${path}dendri?key=${key}`;
		this._jwt = jwt;
	}

	start(id: string, token: string): void {
		this._id = id;
		this._token = token;

		let wsUrl = `${this._baseUrl}&id=${id}&token=${token}`;
		if (this._jwt) {
			wsUrl += `&jwt=${encodeURIComponent(this._jwt)}`;
		}

		if (this._socket || !this._disconnected) {
			return;
		}

		this._socket = new WebSocket(`${wsUrl}&version=${version}`);
		this._disconnected = false;

		this._socket.onmessage = (event) => {
			let data: unknown;

			try {
				data = JSON.parse(event.data);
				logger.log("Server message received:", data);
			} catch (_e) {
				logger.log("Invalid server message", event.data);
				return;
			}

			// Track server-assigned sequence numbers for replay on reconnect.
			if (
				data !== null &&
				typeof data === "object" &&
				"seq" in data &&
				typeof (data as { seq: unknown }).seq === "number"
			) {
				this._lastSeq = (data as { seq: number }).seq;
			}

			this.emit(SocketEventType.Message, data);
		};

		this._socket.onclose = (event) => {
			if (this._disconnected) {
				return;
			}

			logger.log("Socket closed.", event);

			this._cleanup();
			this._disconnected = true;

			if (this._autoReconnect && this._id && this._token) {
				this._scheduleReconnect();
			} else {
				this.emit(SocketEventType.Disconnected);
			}
		};

		this._socket.onerror = (event) => {
			logger.error("Socket error:", event);
			// WebSocket errors are always followed by a close event which handles
			// cleanup and reconnection. We just log here to surface the error.
		};

		// Take care of the queue of connections if necessary and make sure Peer knows
		// socket is open.
		this._socket.onopen = () => {
			if (this._disconnected) {
				return;
			}

			const wasReconnecting = this._reconnectAttempt > 0;

			// Successful connection — reset backoff counter.
			this._reconnectAttempt = 0;

			this._sendQueuedMessages();

			logger.log("Socket open");

			this._createHeartbeatWorker();
			this._startWorkerHeartbeat();

			if (wasReconnecting) {
				this.emit(SocketEventType.Reconnected);
			}
		};

		if (typeof document !== "undefined") {
			this._visibilityHandler = () => {
				if (document.visibilityState === "hidden") {
					// Pause heartbeat when tab is backgrounded
					clearTimeout(this._wsPingTimer!);
				} else {
					// Tab is visible again — check connection and resume
					if (this._wsOpen()) {
						this._sendHeartbeat();
					} else if (this._autoReconnect && !this._disconnected) {
						this._scheduleReconnect();
					}
				}
			};
			document.addEventListener("visibilitychange", this._visibilityHandler);
		}
	}

	/** Compute the backoff delay (with jitter) for the current attempt. */
	private _getReconnectDelay(): number {
		const schedule = Socket.BACKOFF_SCHEDULE;
		const idx = Math.min(this._reconnectAttempt, schedule.length - 1);
		const base = schedule[idx];
		const jitter = Math.random() * Socket.BACKOFF_JITTER * 2 - Socket.BACKOFF_JITTER;
		return Math.max(0, base + jitter);
	}

	/** Current reconnect attempt number (read-only for external inspection). */
	get reconnectAttempt(): number {
		return this._reconnectAttempt;
	}

	/** Schedule a reconnection attempt with exponential backoff + jitter. */
	private _scheduleReconnect(): void {
		const delay = this._getReconnectDelay();
		this._reconnectAttempt++;

		this.emit(SocketEventType.ReconnectAttempt, this._reconnectAttempt);

		logger.log(`Scheduling reconnect attempt ${this._reconnectAttempt} in ${Math.round(delay)}ms`);

		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = undefined;

			if (!this._autoReconnect || !this._id || !this._token) {
				return;
			}

			// Build URL with last_seq for server-side replay.
			let wsUrl = `${this._baseUrl}&id=${this._id}&token=${this._token}&version=${version}&last_seq=${this._lastSeq}`;
			if (this._jwt) {
				wsUrl += `&jwt=${encodeURIComponent(this._jwt)}`;
			}

			this._disconnected = false;
			this._socket = new WebSocket(wsUrl);

			this._socket.onmessage = (event) => {
				let data: unknown;

				try {
					data = JSON.parse(event.data);
					logger.log("Server message received:", data);
				} catch (_e) {
					logger.log("Invalid server message", event.data);
					return;
				}

				if (
					data !== null &&
					typeof data === "object" &&
					"seq" in data &&
					typeof (data as { seq: unknown }).seq === "number"
				) {
					this._lastSeq = (data as { seq: number }).seq;
				}

				this.emit(SocketEventType.Message, data);
			};

			this._socket.onclose = (event) => {
				if (this._disconnected) {
					return;
				}

				logger.log("Socket closed during reconnect.", event);

				this._cleanup();
				this._disconnected = true;

				if (this._autoReconnect && this._id && this._token) {
					this._scheduleReconnect();
				} else {
					this.emit(SocketEventType.Disconnected);
				}
			};

			this._socket.onerror = (event) => {
				logger.error("Socket error during reconnect:", event);
			};

			this._socket.onopen = () => {
				if (this._disconnected) {
					return;
				}

				// Successful reconnection — reset backoff counter.
				this._reconnectAttempt = 0;

				this._sendQueuedMessages();

				logger.log("Socket reconnected");

				this._createHeartbeatWorker();
				this._startWorkerHeartbeat();

				this.emit(SocketEventType.Reconnected);
			};
		}, delay);
	}

	private _createHeartbeatWorker(): void {
		if (typeof Worker === "undefined" || typeof Blob === "undefined") return;

		try {
			// Inline Web Worker for heartbeat — immune to tab throttling
			const workerCode = `
				let interval = null;
				self.onmessage = function(e) {
					if (e.data.type === 'start') {
						clearInterval(interval);
						interval = setInterval(() => self.postMessage('heartbeat'), e.data.interval);
					} else if (e.data.type === 'stop') {
						clearInterval(interval);
						interval = null;
					}
				};
			`;
			const blob = new Blob([workerCode], { type: "application/javascript" });
			const blobUrl = URL.createObjectURL(blob);
			this._heartbeatWorker = new Worker(blobUrl);
			this._heartbeatWorkerUrl = blobUrl;
			this._heartbeatWorker.onmessage = () => {
				this._sendHeartbeat();
			};
		} catch {
			// Workers not available — fall back to setTimeout (existing behavior)
		}
	}

	private _startWorkerHeartbeat(): void {
		if (this._heartbeatWorker) {
			this._heartbeatWorker.postMessage({ type: "start", interval: this.pingInterval });
		} else {
			// Fallback to setTimeout
			this._scheduleHeartbeat();
		}
	}

	private _stopWorkerHeartbeat(): void {
		if (this._heartbeatWorker) {
			this._heartbeatWorker.postMessage({ type: "stop" });
		}
	}

	private _scheduleHeartbeat(): void {
		this._wsPingTimer = setTimeout(() => {
			this._sendHeartbeat();
		}, this.pingInterval);
	}

	private _sendHeartbeat(): void {
		if (!this._wsOpen()) {
			logger.log(`Cannot send heartbeat, because socket closed`);
			return;
		}

		const message = JSON.stringify({ type: ServerMessageType.Heartbeat });

		this._socket?.send(message);

		// When using the Web Worker heartbeat, the worker drives the interval.
		// Only fall back to setTimeout-based scheduling when no worker is present.
		if (!this._heartbeatWorker) {
			this._scheduleHeartbeat();
		}
	}

	/** Is the websocket currently open? */
	private _wsOpen(): boolean {
		return !!this._socket && this._socket.readyState === 1;
	}

	/** Send queued messages. */
	private _sendQueuedMessages(): void {
		//Create copy of queue and clear it,
		//because send method push the message back to queue if smth will go wrong
		const copiedQueue = [...this._messagesQueue];
		this._messagesQueue = [];

		for (const message of copiedQueue) {
			this.send(message);
		}
	}

	/** Exposed send for DC & Peer. */
	send(data: any): void {
		if (this._disconnected) {
			return;
		}

		// If we didn't get an ID yet, we can't yet send anything so we should queue
		// up these messages.
		if (!this._id) {
			this._messagesQueue.push(data);
			return;
		}

		if (!data.type) {
			this.emit(SocketEventType.Error, "Invalid message");
			return;
		}

		if (!this._wsOpen()) {
			this._messagesQueue.push(data);
			return;
		}

		const message = JSON.stringify(data);

		this._socket?.send(message);
	}

	close(): void {
		if (this._disconnected) {
			return;
		}

		// Explicit close — disable auto-reconnect so we don't retry.
		this._autoReconnect = false;

		this._cleanup();

		this._disconnected = true;
	}

	private _cleanup(): void {
		if (this._socket) {
			this._socket.onopen =
				this._socket.onmessage =
				this._socket.onclose =
				this._socket.onerror =
					null;
			this._socket.close();
			this._socket = undefined;
		}

		clearTimeout(this._wsPingTimer!);

		this._stopWorkerHeartbeat();
		if (this._heartbeatWorker) {
			this._heartbeatWorker.terminate();
			this._heartbeatWorker = null;
		}
		if (this._heartbeatWorkerUrl) {
			// Revoke the blob URL that `_createHeartbeatWorker` created so
			// each reconnect doesn't permanently leak a blob URL.
			URL.revokeObjectURL(this._heartbeatWorkerUrl);
			this._heartbeatWorkerUrl = undefined;
		}

		if (this._visibilityHandler && typeof document !== "undefined") {
			document.removeEventListener("visibilitychange", this._visibilityHandler);
			this._visibilityHandler = undefined;
		}

		if (this._reconnectTimer !== undefined) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}
	}
}
