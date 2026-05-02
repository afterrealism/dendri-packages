import { BaseConnection, type BaseConnectionEvents } from "./baseconnection";
import type { Dendri } from "./dendri";
import { ConnectionType, ServerMessageType } from "./enums";
import logger from "./logger";
import { Negotiator } from "./negotiator";
import type { AnswerOption } from "./optionInterfaces";
import type { ServerMessage } from "./servermessage";
import { util } from "./util";

export interface MediaConnectionEvents extends BaseConnectionEvents<never> {
	/**
	 * Emitted when a connection to the Dendri server is established.
	 *
	 * ```ts
	 * mediaConnection.on('stream', (stream) => { ... });
	 * ```
	 */
	stream: (stream: MediaStream) => void;
	/**
	 * Emitted when the auxiliary data channel is established.
	 * After this event, hanging up will close the connection cleanly on the remote peer.
	 * @beta
	 */
	willCloseOnRemote: () => void;
}

/**
 * Wraps WebRTC's media streams.
 * To get one, use {@apilink Dendri.call} or listen for the {@apilink DendriEvents | `call`} event.
 */
export class MediaConnection extends BaseConnection<MediaConnectionEvents> {
	private static readonly ID_PREFIX = "mc_";
	declare readonly label: string;

	private _negotiator: Negotiator<MediaConnectionEvents, this> | null;
	private _localStream: MediaStream | null | undefined;
	private _remoteStream: MediaStream | null = null;

	/**
	 * For media connections, this is always 'media'.
	 */
	get type() {
		return ConnectionType.Media;
	}

	get localStream(): MediaStream | null | undefined {
		return this._localStream;
	}

	get remoteStream(): MediaStream | null {
		return this._remoteStream;
	}

	constructor(peerId: string, provider: Dendri, options: any) {
		super(peerId, provider, options);

		this._localStream = this.options._stream;
		this.connectionId = this.options.connectionId || MediaConnection.ID_PREFIX + util.randomToken();

		this._negotiator = new Negotiator(this);

		if (this._localStream) {
			this._negotiator.startConnection({
				_stream: this._localStream,
				originator: true,
			});
		}
	}

	/** Called by the Negotiator when the DataChannel is ready. */
	override _initializeDataChannel(dc: RTCDataChannel): void {
		this.dataChannel = dc;

		this.dataChannel.onopen = () => {
			logger.log(`DC#${this.connectionId} dc connection success`);
			this.emit("willCloseOnRemote");
		};

		this.dataChannel.onclose = () => {
			logger.log(`DC#${this.connectionId} dc closed for:`, this.peer);
			this.close();
		};
	}
	addStream(remoteStream: MediaStream) {
		logger.log("Receiving stream", remoteStream);

		this._remoteStream = remoteStream;
		super.emit("stream", remoteStream); // Should we call this `open`?
	}

	/**
	 * @internal
	 */
	handleMessage(message: ServerMessage): void {
		const type = message.type;
		const payload = message.payload;

		switch (message.type) {
			case ServerMessageType.Answer:
				// Forward to negotiator
				if (this._negotiator) {
					void this._negotiator.handleSDP(type, payload.sdp).then(() => {
						// Defer _open until handleSDP resolves
						this._open = true;
					});
				}
				break;
			case ServerMessageType.Candidate:
				if (this._negotiator) {
					void this._negotiator.handleCandidate(payload.candidate);
				}
				break;
			default:
				logger.warn(`Unrecognized message type:${type} from peer:${this.peer}`);
				break;
		}
	}

	/**
     * When receiving a {@apilink DendriEvents | `call`} event on a peer, you can call
     * `answer` on the media connection provided by the callback to accept the call
     * and optionally send your own media stream.

     *
     * @param stream A WebRTC media stream.
     * @param options
     * @returns
     */
	answer(stream?: MediaStream, options: AnswerOption = {}): void {
		if (this._localStream) {
			logger.warn(
				"Local stream already exists on this MediaConnection. Are you answering a call twice?",
			);
			return;
		}

		if (!this._negotiator || !this.provider) {
			logger.warn("Cannot answer a connection that has already been closed.");
			return;
		}

		this._localStream = stream ?? null;

		if (options?.sdpTransform) {
			this.options.sdpTransform = options.sdpTransform;
		}

		this._negotiator.startConnection({
			...this.options._payload,
			_stream: stream,
		});
		// Retrieve lost messages stored because PeerConnection not set up.
		const messages = this.provider._getMessages(this.connectionId);

		for (const message of messages) {
			this.handleMessage(message);
		}

		this._open = true;
	}

	/**
	 * Exposed functionality for users.
	 */

	/**
	 * Closes the media connection.
	 */
	close(): void {
		if (this._negotiator) {
			this._negotiator.cleanup();
			this._negotiator = null;
		}

		this._localStream = null;
		this._remoteStream = null;

		if (this.provider) {
			this.provider._removeConnection(this);

			this.provider = null;
		}

		if (this.options?._stream) {
			this.options._stream = null;
		}

		if (!this.open) {
			return;
		}

		this._open = false;

		super.emit("close");
		this.removeAllListeners();
	}
}
