import { EventEmitter } from "eventemitter3";
import { SocketEventType } from "./enums";

/**
 * Events emitted by all signaling transports.
 */
export interface TransportEvents {
	[SocketEventType.Message]: (data: any) => void;
	[SocketEventType.Disconnected]: () => void;
	[SocketEventType.Error]: (error: string) => void;
	[SocketEventType.Reconnected]: () => void;
	[SocketEventType.ReconnectAttempt]: (attempt: number) => void;
}

/**
 * Abstract signaling transport. WebSocket, SSE+POST, and Long Polling
 * all implement this interface so the Dendri class is transport-agnostic.
 */
export abstract class SignalingTransport extends EventEmitter<TransportEvents> {
	abstract start(id: string, token: string): void;
	abstract send(data: any): void;
	abstract close(): void;
	abstract get reconnectAttempt(): number;
}
