import { DataConnectionErrorType, SerializationType } from "../../enums";
import logger from "../../logger";
import { util } from "../../util";
import { BufferedConnection } from "./BufferedConnection";

export class Json extends BufferedConnection {
	readonly serialization = SerializationType.JSON;
	private readonly encoder = new TextEncoder();
	private readonly decoder = new TextDecoder();

	stringify: (data: any) => string = JSON.stringify;
	parse: (data: string) => any = JSON.parse;

	// Handles a DataChannel message.
	protected override _handleDataMessage({ data }: { data: Uint8Array }): void {
		let deserializedData: any;
		try {
			deserializedData = this.parse(this.decoder.decode(data));
		} catch (e) {
			logger.error(`DC#${this.connectionId} Failed to parse JSON data:`, e);
			this.emitError(DataConnectionErrorType.NotOpenYet, "Failed to parse received JSON data");
			return;
		}

		// Dendri specific message
		const peerData = deserializedData.__peerData;
		if (peerData && peerData.type === "close") {
			this.close();
			return;
		}

		this.emit("data", deserializedData);
	}

	override _send(data: any, _chunked: boolean) {
		const encodedData = this.encoder.encode(this.stringify(data));
		if (encodedData.byteLength >= util.chunkedMTU) {
			this.emitError(DataConnectionErrorType.MessageToBig, "Message too big for JSON channel");
			return;
		}
		this._bufferedSend(encodedData.buffer as ArrayBuffer);
	}
}
