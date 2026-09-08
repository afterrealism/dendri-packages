import { ServerMessageType, SocketEventType } from "./enums";
import logger from "./logger";
import { SignalingTransport } from "./transport";

/**
 * SSE + POST transport for environments where WebSocket is blocked.
 * Server->Client: Server-Sent Events (fetch-based, supports custom headers)
 * Client->Server: HTTP POST requests
 */
export class SSETransport extends SignalingTransport {
	private _connected = false;
	private _disconnected = true;
	private _id?: string;
	private _token?: string;
	private _messagesQueue: Array<object> = [];
	private _abortController?: AbortController;
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
		// _connectSSE is async; a rejection before the inner try/catch (e.g. a
		// synchronous TypeError from the URL builder) would become an
		// unhandled rejection. Route any slip-through into _handleDisconnect.
		this._connectSSE().catch((err) => {
			logger.error("SSE start failed:", err);
			this._handleDisconnect();
		});
	}

	private async _connectSSE(): Promise<void> {
		if (this._disconnected) return;

		const params = new URLSearchParams({
			id: this._id!,
			token: this._token!,
		});
		this._applyAuthParams(params);
		if (this._lastSeq > 0) params.set("last_seq", String(this._lastSeq));

		const url = `${this._baseUrl}http/sse?${params}`;

		try {
			this._abortController = new AbortController();

			const response = await fetch(url, {
				headers: {
					Accept: "text/event-stream",
					"Cache-Control": "no-cache",
				},
				signal: this._abortController.signal,
			});

			if (!response.ok || !response.body) {
				throw new Error(`SSE connection failed: ${response.status}`);
			}

			const wasReconnecting = this._reconnectAttempt > 0;

			this._connected = true;
			this._reconnectAttempt = 0;

			if (wasReconnecting) {
				this.emit(SocketEventType.Reconnected);
			}

			// Start heartbeat via POST
			this._startHeartbeat();

			// Send queued messages
			this._sendQueuedMessages();

			// Read SSE stream
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6);
						try {
							const parsed = JSON.parse(data);
							// `if (parsed.seq)` is falsy on seq=0. The server's
							// seq counter starts from 1 today, but it resets to
							// 0 after restart — missing that update would
							// desynchronise the replay cursor on reconnect.
							if (typeof parsed.seq === "number") this._lastSeq = parsed.seq;
							logger.log("SSE message received:", parsed);
							this.emit(SocketEventType.Message, parsed);
						} catch {
							logger.log("Invalid SSE message", data);
						}
					}
				}
			}

			// Stream ended — connection closed
			this._handleDisconnect();
		} catch (error: unknown) {
			if ((error as { name?: string })?.name === "AbortError") return; // Intentional close
			logger.error("SSE error:", error);
			this._handleDisconnect();
		}
	}

	send(data: any): void {
		if (this._disconnected) return;

		if (!this._id) {
			this._messagesQueue.push(data);
			return;
		}

		if (!data.type) {
			this.emit(SocketEventType.Error, "Invalid message");
			return;
		}

		if (!this._connected) {
			this._messagesQueue.push(data);
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
		} catch (error) {
			logger.error("POST send failed:", error);
			this._messagesQueue.push(data);
		}
	}

	close(): void {
		if (this._disconnected) return;
		this._autoReconnect = false;
		this._cleanup();
		this._disconnected = true;
	}

	private _handleDisconnect(): void {
		this._connected = false;
		if (this._autoReconnect && !this._disconnected) {
			this._scheduleReconnect();
		} else {
			this._cleanup();
			this._disconnected = true;
			this.emit(SocketEventType.Disconnected);
		}
	}

	/** Compute the backoff delay (with jitter) for the current attempt. */
	private _getReconnectDelay(): number {
		const schedule = SSETransport.BACKOFF_SCHEDULE;
		const idx = Math.min(this._reconnectAttempt, schedule.length - 1);
		const base = schedule[idx];
		const jitter = Math.random() * SSETransport.BACKOFF_JITTER * 2 - SSETransport.BACKOFF_JITTER;
		return Math.max(0, base + jitter);
	}

	private _scheduleReconnect(): void {
		this._reconnectAttempt++;
		this.emit(SocketEventType.ReconnectAttempt, this._reconnectAttempt);

		const delay = this._getReconnectDelay();
		this._reconnectTimer = setTimeout(() => {
			this._connectSSE().catch((err) => {
				logger.error("SSE reconnect failed:", err);
				this._handleDisconnect();
			});
		}, delay);
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
		this._abortController?.abort();
		this._abortController = undefined;
		clearTimeout(this._reconnectTimer);
		this._reconnectTimer = undefined;
		clearInterval(this._heartbeatTimer);
		this._heartbeatTimer = undefined;
		this._connected = false;
	}
}
