import { BaseConnection, type BaseConnectionEvents } from "../baseconnection";
import type { Dendri } from "../dendri";
import type { EventsWithError } from "../dendriError";
import {
	type BaseConnectionErrorType,
	ConnectionType,
	DataConnectionErrorType,
	ServerMessageType,
} from "../enums";
import logger from "../logger";
import { Negotiator } from "../negotiator";
import type { ServerMessage } from "../servermessage";
import { randomToken } from "../utils/randomToken";

export interface DataConnectionEvents
	extends EventsWithError<DataConnectionErrorType | BaseConnectionErrorType>,
		BaseConnectionEvents<DataConnectionErrorType | BaseConnectionErrorType> {
	/**
	 * Emitted when data is received from the remote peer.
	 */
	data: (data: unknown) => void;
	/**
	 * Emitted when the connection is established and ready-to-use.
	 */
	open: () => void;
}

/**
 * Wraps a DataChannel between two Peers.
 */
export abstract class DataConnection extends BaseConnection<
	DataConnectionEvents,
	DataConnectionErrorType
> {
	protected static readonly ID_PREFIX = "dc_";
	protected static readonly MAX_BUFFERED_AMOUNT = 8 * 1024 * 1024;

	private _negotiator: Negotiator<DataConnectionEvents, this> | null;
	abstract readonly serialization: string;
	readonly reliable: boolean;

	public get type() {
		return ConnectionType.Data;
	}

	constructor(peerId: string, provider: Dendri, options: any) {
		super(peerId, provider, options);

		this.connectionId = this.options.connectionId || DataConnection.ID_PREFIX + randomToken();

		this.label = this.options.label || this.connectionId;
		this.reliable = !!this.options.reliable;

		this._negotiator = new Negotiator(this);

		this._negotiator.startConnection(
			this.options._payload || {
				originator: true,
				reliable: this.reliable,
			},
		);
	}

	/** Called by the Negotiator when the DataChannel is ready. */
	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} dc connection success`);
			this._open = true;
			this._applyAdaptiveBuffer(dc);
			this.emit("open");
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
			this.close();
		};
	}

	private _applyAdaptiveBuffer(dc: RTCDataChannel): void {
		const pc = this.peerConnection;
		if (!pc || typeof (pc as any).getStats !== "function") return;
		pc.getStats().then((stats: RTCStatsReport) => {
			let rtt: number | null = null;
			stats.forEach((report: any) => {
				if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime) {
					rtt = report.currentRoundTripTime * 1000;
				}
			});
			if (rtt !== null) {
				const bdp = 12.5 * 1024 * 1024 * (rtt / 1000);
				const optimal = Math.max(1 * 1024 * 1024, Math.min(32 * 1024 * 1024, Math.ceil(bdp)));
				dc.bufferedAmountLowThreshold = optimal;
			}
		}).catch(() => {});
	}

	/**
	 * Exposed functionality for users.
	 */

	private _flushCloseTimeout: ReturnType<typeof setTimeout> | null = null;

	/** Allows user to close connection. */
	close(options?: { flush?: boolean }): void {
		if (options?.flush) {
			this.send({
				__peerData: {
					type: "close",
				},
			});
			// Fallback timeout so close() is guaranteed even if flush hangs
			this._flushCloseTimeout = setTimeout(() => {
				this._flushCloseTimeout = null;
				this.close();
			}, 5000);
			return;
		}

		if (this._flushCloseTimeout) {
			clearTimeout(this._flushCloseTimeout);
			this._flushCloseTimeout = null;
		}

		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		if (this.provider) {
			this.provider._removeConnection(this);

			this.provider = null;
		}

		if (this.dataChannel) {
			this.dataChannel.onopen = null;
			this.dataChannel.onmessage = null;
			this.dataChannel.onclose = null;
			this.dataChannel = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		super.emit("close");
		this.removeAllListeners();
	}

	protected abstract _send(data: any, chunked: boolean): void | Promise<void>;

	/** Allows user to send data. */
	public send(data: any, chunked = false) {
		if (!this.open) {
			this.emitError(
				DataConnectionErrorType.NotOpenYet,
				"Connection is not open. You should listen for the `open` event before sending messages.",
			);
			return;
		}
		return this._send(data, chunked);
	}

	async handleMessage(message: ServerMessage) {
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				if (this._negotiator) {
					await this._negotiator.handleSDP(message.type, payload.sdp);
				}
				break;
			case ServerMessageType.Candidate:
				if (this._negotiator) {
					await this._negotiator.handleCandidate(payload.candidate);
				}
				break;
			default:
				logger.warn("Unrecognized message type:", message.type, "from peer:", this.peer);
				break;
		}
	}
}
