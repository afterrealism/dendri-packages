import { decodeMultiStream, Encoder } from "@msgpack/msgpack";
import type { Dendri } from "../../dendri";
import logger from "../../logger";
import { StreamConnection } from "./StreamConnection";

export class MsgPack extends StreamConnection {
	readonly serialization = "MsgPack";
	private _encoder = new Encoder();

	constructor(peerId: string, provider: Dendri, options: any) {
		super(peerId, provider, options);

		(async () => {
			for await (const msg of decodeMultiStream(this._rawReadStream)) {
				const peerData = (msg as any)?.__peerData;
				if (peerData?.type === "close") {
					this.close();
					return;
				}
				this.emit("data", msg);
			}
		})().catch((err) => {
			// Stream was closed or errored — expected during connection teardown
			if (this.open) {
				logger.error(`DC#${this.connectionId} MsgPack decode error:`, err);
			}
		});
	}

	protected override _send(data: unknown) {
		return this.writer.write(this._encoder.encode(data));
	}
}
