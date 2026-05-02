import type { Dendri } from "../../dendri";
import logger from "../../logger";
import { DataConnection } from "../DataConnection";

export abstract class StreamConnection extends DataConnection {
	private _CHUNK_SIZE = 1024 * 8 * 4;
	private _splitStream = new TransformStream<Uint8Array>({
		transform: (chunk, controller) => {
			for (let split = 0; split < chunk.length; split += this._CHUNK_SIZE) {
				controller.enqueue(chunk.subarray(split, split + this._CHUNK_SIZE));
			}
		},
	});
	private _rawSendStream = new WritableStream<ArrayBuffer>({
		write: async (chunk, controller) => {
			// Only register the backpressure listener when the buffer is actually full
			if (
				this.dataChannel &&
				this.dataChannel.bufferedAmount > DataConnection.MAX_BUFFERED_AMOUNT - chunk.byteLength
			) {
				await new Promise<void>((resolve, reject) => {
					const onLow = () => {
						cleanup();
						resolve();
					};
					const onClose = () => {
						cleanup();
						reject(new Error("DataChannel closed while waiting for buffer drain"));
					};
					const cleanup = () => {
						this.dataChannel?.removeEventListener("bufferedamountlow", onLow);
						this.dataChannel?.removeEventListener("close", onClose);
					};

					this.dataChannel?.addEventListener("bufferedamountlow", onLow, {
						once: true,
					});
					this.dataChannel?.addEventListener("close", onClose, {
						once: true,
					});
				});
			}

			if (!this.dataChannel || this.dataChannel.readyState !== "open") {
				controller.error(new Error("DataChannel is not open"));
				return;
			}

			try {
				this.dataChannel.send(chunk);
			} catch (e) {
				logger.error(`DC#:${this.connectionId} Error when sending:`, e);
				controller.error(e);
				this.close();
			}
		},
	});
	protected writer = this._splitStream.writable.getWriter();

	private _readStreamMessageHandler: ((e: MessageEvent) => void) | null = null;
	private _readStreamController: ReadableStreamDefaultController<ArrayBuffer> | null = null;

	protected _rawReadStream = new ReadableStream<ArrayBuffer>({
		start: (controller) => {
			this._readStreamController = controller;
			this.once("open", () => {
				if (!this.dataChannel) return;
				this._readStreamMessageHandler = (e: MessageEvent) => {
					controller.enqueue(e.data);
				};
				this.dataChannel.addEventListener("message", this._readStreamMessageHandler);
			});
		},
	});

	protected constructor(peerId: string, provider: Dendri, options: any) {
		super(peerId, provider, { ...options, reliable: true });

		void this._splitStream.readable.pipeTo(this._rawSendStream);
	}

	public override _initializeDataChannel(dc: RTCDataChannel) {
		super._initializeDataChannel(dc);
		this.dataChannel!.binaryType = "arraybuffer";
		this.dataChannel!.bufferedAmountLowThreshold = DataConnection.MAX_BUFFERED_AMOUNT / 2;
	}

	public override close(options?: { flush?: boolean }): void {
		// Clean up stream resources
		if (this.dataChannel && this._readStreamMessageHandler) {
			this.dataChannel.removeEventListener("message", this._readStreamMessageHandler);
			this._readStreamMessageHandler = null;
		}

		// Send flush message via super BEFORE aborting the writer
		super.close(options);

		try {
			this.writer.abort();
		} catch (_) {
			// Writer may already be closed
		}

		if (this._readStreamController) {
			try {
				this._readStreamController.close();
			} catch (_) {
				// Controller may already be closed
			}
			this._readStreamController = null;
		}
	}
}
