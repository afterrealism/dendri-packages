import type { ServerMessageType } from "./enums";

export interface ServerMessage {
	type: ServerMessageType;
	payload: any;
	src: string;
	/** Server-assigned sequence number for reliable ordering / replay. */
	seq?: number;
	/** Room name associated with this message. */
	room?: string;
	/** Server-assigned timestamp (epoch ms). */
	timestamp?: number;
	/** ACK identifier for delivery confirmation. */
	ackId?: string;
	/** Optional topic for data multiplexing / filtering. */
	topic?: string;
}
