import { type Packable, pack, unpack } from "peerjs-js-binarypack";
import { DataConnectionErrorType, SerializationType } from "../../enums";
import logger from "../../logger";
import { BufferedConnection } from "./BufferedConnection";
import { BinaryPackChunker, concatArrayBuffers } from "./binaryPackChunker";

export class BinaryPack extends BufferedConnection {
	private readonly chunker = new BinaryPackChunker();
	readonly serialization = SerializationType.Binary;

	private static readonly MAX_CHUNKED_SETS = 256;

	private _chunkedData: {
		[id: number]: {
			data: Uint8Array[];
			count: number;
			total: number;
		};
	} = {};

	public override close(options?: { flush?: boolean }) {
		this._chunkedData = {};
		super.close(options);
	}

	// Handles a DataChannel message.
	protected override _handleDataMessage({ data }: { data: Uint8Array }): void {
		let deserializedData: any;
		try {
			deserializedData = unpack(data as unknown as ArrayBuffer);
		} catch (e) {
			logger.error(`DC#${this.connectionId} Failed to unpack data:`, e);
			this.emitError(DataConnectionErrorType.NotOpenYet, "Failed to deserialize received data");
			return;
		}

		// Dendri specific message
		const peerData = deserializedData.__peerData;
		if (peerData) {
			if (peerData.type === "close") {
				this.close();
				return;
			}

			// Chunked data -- piece things back together.
			this._handleChunk(deserializedData);
			return;
		}

		this.emit("data", deserializedData);
	}

	private _handleChunk(data: {
		__peerData: number;
		n: number;
		total: number;
		data: ArrayBuffer;
	}): void {
		const id = data.__peerData;

		// Validate chunk index
		if (data.n < 0 || data.n >= data.total) {
			logger.warn(
				`DC#${this.connectionId} Invalid chunk index ${data.n} of ${data.total}, dropping`,
			);
			return;
		}

		const chunkInfo = this._chunkedData[id] || {
			data: [],
			count: 0,
			total: data.total,
		};

		chunkInfo.data[data.n] = new Uint8Array(data.data);
		chunkInfo.count++;
		this._chunkedData[id] = chunkInfo;

		if (chunkInfo.total === chunkInfo.count) {
			// Clean up before making the recursive call to `_handleDataMessage`.
			delete this._chunkedData[id];

			// We've received all the chunks--time to construct the complete data.
			// const data = new Blob(chunkInfo.data);
			const data = concatArrayBuffers(chunkInfo.data);
			this._handleDataMessage({ data });
		} else {
			// Cap pending incomplete chunk sets to prevent memory exhaustion
			const pendingKeys = Object.keys(this._chunkedData);
			if (pendingKeys.length > BinaryPack.MAX_CHUNKED_SETS) {
				// Remove the oldest entry
				const oldestKey = pendingKeys[0];
				logger.warn(
					`DC#${this.connectionId} Too many pending chunk sets (${pendingKeys.length}), dropping oldest`,
				);
				delete this._chunkedData[Number(oldestKey)];
			}
		}
	}

	protected override _send(data: Packable, chunked: boolean) {
		const blob = pack(data);
		if (blob instanceof Promise) {
			return this._send_blob(blob);
		}

		if (!chunked && blob.byteLength > this.chunker.chunkedMTU) {
			this._sendChunks(blob);
			return;
		}

		this._bufferedSend(blob);
	}
	private async _send_blob(blobPromise: Promise<ArrayBufferLike>) {
		const blob = (await blobPromise) as ArrayBuffer;

		if (!this.open) {
			logger.warn(`DC#${this.connectionId} Connection closed during async send, dropping message`);
			return;
		}

		if (blob.byteLength > this.chunker.chunkedMTU) {
			this._sendChunks(blob);
			return;
		}

		this._bufferedSend(blob);
	}

	private _sendChunks(blob: ArrayBuffer) {
		const blobs = this.chunker.chunk(blob);
		logger.log(`DC#${this.connectionId} Try to send ${blobs.length} chunks...`);

		for (const blob of blobs) {
			this.send(blob, true);
		}
	}
}
