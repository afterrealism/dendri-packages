import { ServerMessageType, SocketEventType } from "./enums";
import logger from "./logger";
import { SignalingTransport } from "./transport";

/**
 * HTTP Long Polling transport — works through any network that allows HTTPS.
 * Client->Server: POST
 * Server->Client: GET (held open until data available or timeout)
 */
export class PollingTransport extends SignalingTransport {
	private _connected = false;
	private _disconnected = true;
	private _id?: string;
	private _token?: string;
	private _messagesQueue: Array<object> = [];
	private _polling = false;
	private _autoReconnect = true;
	private _reconnectAttempt = 0;
	private _reconnectTimer?: ReturnType<typeof setTimeout>;
	private _heartbeatTimer?: ReturnType<typeof setInterval>;
	private _lastSeq = 0;
	private _baseUrl: string;
	private _key: string;
	private _jwt?: string;
	private _apiKey?: string;
	private readonly _pingInterval: number;
	private _abortController?: AbortController;

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
		pingInterval: number = 5000,
		jwt?: string,
		apiKey?: string,
	) {
		super();
		const protocol = secure ? "https://" : "http://";
		this._baseUrl = `${protocol + host}:${port}${path}`;
		this._pingInterval = pingInterval;
		this._key = key;
		this._jwt = jwt;
		this._apiKey = apiKey;
	}

	/** Append the shared auth params (key, jwt, api_key) so every HTTP call authenticates like the WS transport. */
	private _applyAuthParams(params: URLSearchParams): void {
		params.set("key", this._key);
		if (this._jwt) params.set("jwt", this._jwt);
		if (this._apiKey) params.set("api_key", this._apiKey);
	}

	get reconnectAttempt(): number {
		return this._reconnectAttempt;
	}

	start(id: string, token: string): void {
		this._id = id;
		this._token = token;
		this._disconnected = false;
		this._connected = true;
		this._reconnectAttempt = 0;
		// _startPolling is async; ensure a pre-loop rejection lands in the
		// reconnect path instead of becoming an unhandled promise rejection.
		this._startPolling().catch((err) => {
			logger.error("Polling start failed:", err);
			if (!this._disconnected && this._autoReconnect) this._scheduleReconnect();
		});
		this._startHeartbeat();
		this._sendQueuedMessages();
	}

	private async _startPolling(): Promise<void> {
		if (this._polling || this._disconnected) return;
		this._polling = true;

		while (this._polling && !this._disconnected) {
			try {
				this._abortController = new AbortController();
				const params = new URLSearchParams({
					id: this._id!,
					token: this._token!,
				});
				this._applyAuthParams(params);
				if (this._lastSeq > 0) params.set("last_seq", String(this._lastSeq));

				const response = await fetch(`${this._baseUrl}http/poll?${params}`, {
					signal: this._abortController.signal,
				});

				if (!response.ok) throw new Error(`Poll failed: ${response.status}`);

				const messages: any[] = await response.json();
				for (const msg of messages) {
					// Truthiness check would drop seq=0; tracking it is required
					// so reconnect resumes from the correct replay cursor.
					if (typeof msg.seq === "number") this._lastSeq = msg.seq;
					this.emit(SocketEventType.Message, msg);
				}
			} catch (error: unknown) {
				if ((error as { name?: string })?.name === "AbortError") break;
				logger.error("Poll error:", error);
				await new Promise((r) => setTimeout(r, 1000)); // Brief pause before retry
			}
		}

		this._polling = false;
		if (!this._disconnected && this._autoReconnect) {
			this._scheduleReconnect();
		}
	}

	send(data: any): void {
		if (this._disconnected) return;

		if (!this._id || !this._connected) {
			this._messagesQueue.push(data);
			return;
		}

		if (!data.type) {
			this.emit(SocketEventType.Error, "Invalid message");
			return;
		}

		this._postMessage(data);
	}

	private async _postMessage(data: any): Promise<void> {
		const params = new URLSearchParams({
			id: this._id!,
			token: this._token!,
		});
		this._applyAuthParams(params);

		try {
			await fetch(`${this._baseUrl}http/send?${params}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			});
		} catch {
			this._messagesQueue.push(data);
		}
	}

	close(): void {
		this._autoReconnect = false;
		this._cleanup();
		this._disconnected = true;
	}

	/** Compute the backoff delay (with jitter) for the current attempt. */
	private _getReconnectDelay(): number {
		const schedule = PollingTransport.BACKOFF_SCHEDULE;
		const idx = Math.min(this._reconnectAttempt, schedule.length - 1);
		const base = schedule[idx];
		const jitter =
			Math.random() * PollingTransport.BACKOFF_JITTER * 2 - PollingTransport.BACKOFF_JITTER;
		return Math.max(0, base + jitter);
	}

	private _scheduleReconnect(): void {
		this._reconnectAttempt++;
		this.emit(SocketEventType.ReconnectAttempt, this._reconnectAttempt);
		const delay = this._getReconnectDelay();
		this._reconnectTimer = setTimeout(
			() => {
				this._startPolling().catch((err) => {
					logger.error("Polling reconnect failed:", err);
					if (!this._disconnected && this._autoReconnect) this._scheduleReconnect();
				});
			},
			Math.max(0, delay),
		);
	}

	private _startHeartbeat(): void {
		this._heartbeatTimer = setInterval(() => {
			if (this._connected) {
				this._postMessage({ type: ServerMessageType.Heartbeat });
			}
		}, this._pingInterval);
	}

	private _sendQueuedMessages(): void {
		const queue = [...this._messagesQueue];
		this._messagesQueue = [];
		for (const msg of queue) {
			this.send(msg);
		}
	}

	private _cleanup(): void {
		this._polling = false;
		this._abortController?.abort();
		this._abortController = undefined;
		clearTimeout(this._reconnectTimer);
		this._reconnectTimer = undefined;
		clearInterval(this._heartbeatTimer);
		this._heartbeatTimer = undefined;
		this._connected = false;
	}
}
