import logger from "../../logger";
import { DataConnection } from "../DataConnection";

export abstract class BufferedConnection extends DataConnection {
	private _buffer: any[] = [];
	private _bufferSize = 0;
	private _buffering = false;
	private _bufferTimer: ReturnType<typeof setTimeout> | null = null;
	private _messageHandler: ((e: MessageEvent) => void) | null = null;

	public get bufferSize(): number {
		return this._bufferSize;
	}

	public override _initializeDataChannel(dc: RTCDataChannel) {
		super._initializeDataChannel(dc);
		this.dataChannel!.binaryType = "arraybuffer";
		this._messageHandler = (e: MessageEvent) => this._handleDataMessage(e);
		this.dataChannel?.addEventListener("message", this._messageHandler);
	}

	protected abstract _handleDataMessage(e: MessageEvent): void;

	protected _bufferedSend(msg: ArrayBuffer): void {
		if (this._buffering || !this._trySend(msg)) {
			this._buffer.push(msg);
			this._bufferSize = this._buffer.length;
		}
	}

	// Returns true if the send succeeds.
	private _trySend(msg: ArrayBuffer): boolean {
		if (!this.open) {
			return false;
		}

		if ((this.dataChannel?.bufferedAmount ?? 0) > DataConnection.MAX_BUFFERED_AMOUNT) {
			this._buffering = true;
			this._bufferTimer = setTimeout(() => {
				this._bufferTimer = null;
				this._buffering = false;
				this._tryBuffer();
			}, 50);

			return false;
		}

		try {
			this.dataChannel?.send(msg);
		} catch (e) {
			logger.error(`DC#:${this.connectionId} Error when sending:`, e);
			this._buffering = true;

			this.close();

			return false;
		}

		return true;
	}

	// Try to send buffered messages iteratively.
	private _tryBuffer(): void {
		while (this.open && this._buffer.length > 0) {
			const msg = this._buffer[0];

			if (!this._trySend(msg)) {
				break;
			}

			this._buffer.shift();
			this._bufferSize = this._buffer.length;
		}
	}

	public override close(options?: { flush?: boolean }) {
		if (options?.flush) {
			this.send({
				__peerData: {
					type: "close",
				},
			});
			return;
		}

		if (this._bufferTimer) {
			clearTimeout(this._bufferTimer);
			this._bufferTimer = null;
		}

		if (this.dataChannel && this._messageHandler) {
			this.dataChannel.removeEventListener("message", this._messageHandler);
			this._messageHandler = null;
		}

		this._buffer = [];
		this._bufferSize = 0;
		super.close();
	}
}
