import { MsgPack } from "./dataconnection/StreamConnection/MsgPack";
import { Dendri, type SerializerMapping } from "./dendri";

/**
 * @experimental
 */
export class MsgPackDendri extends Dendri {
	override _serializers: SerializerMapping = {
		MsgPack,
		default: MsgPack,
	};
}
