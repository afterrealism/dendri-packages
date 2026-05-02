import { SerializationType } from "../../enums";
import { BufferedConnection } from "./BufferedConnection";

export class Raw extends BufferedConnection {
	readonly serialization = SerializationType.None;

	protected _handleDataMessage({ data }: MessageEvent): void {
		super.emit("data", data);
	}

	override _send(data: ArrayBuffer, _chunked: boolean): void {
		this._bufferedSend(data);
	}
}
