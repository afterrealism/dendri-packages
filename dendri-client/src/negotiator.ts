import type { ValidEventTypes } from "eventemitter3";
import type { BaseConnection, BaseConnectionEvents } from "./baseconnection";
import type { DataConnection } from "./dataconnection/DataConnection";
import {
	BaseConnectionErrorType,
	ConnectionType,
	DendriErrorType,
	ServerMessageType,
} from "./enums";
import logger from "./logger";
import type { MediaConnection } from "./mediaconnection";

/**
 * Manages all negotiations between Peers.
 */
export class Negotiator<
	Events extends ValidEventTypes,
	T extends BaseConnection<Events | BaseConnectionEvents>,
> {
	private _pendingCandidates: RTCIceCandidate[] = [];

	constructor(readonly connection: T) {}

	/** Returns a PeerConnection object set up correctly (for data, media). */
	startConnection(options: any) {
		const peerConnection = this._startPeerConnection();

		// Set the connection's PC.
		this.connection.peerConnection = peerConnection;

		if (this.connection.type === ConnectionType.Media && options._stream) {
			this._addTracksToConnection(options._stream, peerConnection);
			this._setCodecPreferences(peerConnection);
		}

		// What do we need to do now?
		if (options.originator) {
			const dataConnection = this.connection;

			const config: RTCDataChannelInit = { ordered: !!options.reliable };

			const dataChannel = peerConnection.createDataChannel(dataConnection.label, config);
			dataConnection._initializeDataChannel(dataChannel);

			void this._makeOffer();
		} else {
			void this.handleSDP("OFFER", options.sdp);
		}
	}

	/** Start a PC. */
	private _startPeerConnection(): RTCPeerConnection {
		logger.log("Creating RTCPeerConnection.");

		const peerConnection = new RTCPeerConnection(this.connection.provider?.options.config);

		this._setupListeners(peerConnection);

		return peerConnection;
	}

	/** Set up various WebRTC listeners. */
	private _setupListeners(peerConnection: RTCPeerConnection) {
		const peerId = this.connection.peer;
		const connectionId = this.connection.connectionId;
		const connectionType = this.connection.type;
		const provider = this.connection.provider!;

		// ICE CANDIDATES.
		logger.log("Listening for ICE candidates.");

		peerConnection.onicecandidate = (evt) => {
			if (!evt.candidate?.candidate) return;

			logger.log(`Received ICE candidates for ${peerId}:`, evt.candidate);

			provider.socket.send({
				type: ServerMessageType.Candidate,
				payload: {
					candidate: evt.candidate,
					type: connectionType,
					connectionId: connectionId,
				},
				dst: peerId,
			});
		};

		peerConnection.oniceconnectionstatechange = () => {
			switch (peerConnection.iceConnectionState) {
				case "failed":
					logger.log(`iceConnectionState is failed, closing connections to ${peerId}`);
					this.connection.emitError(
						BaseConnectionErrorType.NegotiationFailed,
						`Negotiation of connection to ${peerId} failed.`,
					);
					this.connection.close();
					break;
				case "closed":
					logger.log(`iceConnectionState is closed, closing connections to ${peerId}`);
					this.connection.emitError(
						BaseConnectionErrorType.ConnectionClosed,
						`Connection to ${peerId} closed.`,
					);
					this.connection.close();
					break;
				case "disconnected":
					logger.log(`iceConnectionState changed to disconnected on the connection with ${peerId}`);
					break;
				case "completed":
					peerConnection.onicecandidate = () => {};
					break;
			}

			this.connection.emit("iceStateChanged", peerConnection.iceConnectionState);
		};

		// DATACONNECTION.
		logger.log("Listening for data channel");
		// Fired between offer and answer, so options should already be saved
		// in the options hash.
		peerConnection.ondatachannel = (evt) => {
			logger.log("Received data channel");

			const dataChannel = evt.channel;
			const connection = provider.getConnection(peerId, connectionId);

			if (!connection) {
				logger.warn(`Received data channel for non-existent connection ${connectionId}`);
				return;
			}

			connection._initializeDataChannel(dataChannel);
		};

		// MEDIACONNECTION.
		logger.log("Listening for remote stream");

		peerConnection.ontrack = (evt) => {
			logger.log("Received remote stream");

			const stream = evt.streams[0];
			const connection = provider.getConnection(peerId, connectionId);

			if (!connection) {
				logger.warn(`Received remote stream for non-existent connection ${connectionId}`);
				return;
			}

			if (connection.type === ConnectionType.Media) {
				const mediaConnection = <MediaConnection>connection;

				this._addStreamToMediaConnection(stream, mediaConnection);
			}
		};
	}

	cleanup(): void {
		logger.log(`Cleaning up PeerConnection to ${this.connection.peer}`);

		const peerConnection = this.connection.peerConnection;

		if (!peerConnection) {
			return;
		}

		this.connection.peerConnection = null;
		this._pendingCandidates = [];

		//unsubscribe from all PeerConnection's events
		peerConnection.onicecandidate =
			peerConnection.oniceconnectionstatechange =
			peerConnection.ondatachannel =
			peerConnection.ontrack =
				() => {};

		const peerConnectionNotClosed = peerConnection.signalingState !== "closed";
		let dataChannelNotClosed = false;

		const dataChannel = this.connection.dataChannel;

		if (dataChannel) {
			dataChannelNotClosed = !!dataChannel.readyState && dataChannel.readyState !== "closed";
			if (dataChannelNotClosed) {
				dataChannel.close();
			}
		}

		if (peerConnectionNotClosed || dataChannelNotClosed) {
			peerConnection.close();
		}
	}

	private async _makeOffer(): Promise<void> {
		const peerConnection = this.connection.peerConnection!;
		const provider = this.connection.provider!;

		try {
			const offer = await peerConnection.createOffer(this.connection.options.constraints);

			if (!this.connection.peerConnection) {
				logger.log("PeerConnection closed during createOffer");
				return;
			}

			logger.log("Created offer.");

			if (
				this.connection.options.sdpTransform &&
				typeof this.connection.options.sdpTransform === "function"
			) {
				offer.sdp = this.connection.options.sdpTransform(offer.sdp) || offer.sdp;
			}

			// Apply H.264 SDP fallback for video (Safari compatibility)
			if (this.connection.type === ConnectionType.Media && offer.sdp) {
				offer.sdp = this._applyH264SdpFallback(offer.sdp, peerConnection);
			}

			try {
				await peerConnection.setLocalDescription(offer);

				if (!this.connection.peerConnection) {
					logger.log("PeerConnection closed during setLocalDescription");
					return;
				}

				logger.log("Set localDescription:", offer, `for:${this.connection.peer}`);

				let payload: any = {
					sdp: offer,
					type: this.connection.type,
					connectionId: this.connection.connectionId,
					metadata: this.connection.metadata,
				};

				if (this.connection.type === ConnectionType.Data) {
					const dataConnection = <DataConnection>(<unknown>this.connection);

					payload = {
						...payload,
						label: dataConnection.label,
						reliable: dataConnection.reliable,
						serialization: dataConnection.serialization,
					};
				}

				provider.socket.send({
					type: ServerMessageType.Offer,
					payload,
					dst: this.connection.peer,
				});
			} catch (err: unknown) {
				// TODO: investigate why _makeOffer is being called from the answer
				if (
					err !==
					"OperationError: Failed to set local offer sdp: Called in wrong state: kHaveRemoteOffer"
				) {
					provider.emitError(DendriErrorType.WebRTC, err instanceof Error ? err : String(err));
					logger.log("Failed to setLocalDescription, ", err);
				}
			}
		} catch (err_1: unknown) {
			provider.emitError(DendriErrorType.WebRTC, err_1 instanceof Error ? err_1 : String(err_1));
			logger.log("Failed to createOffer, ", err_1);
		}
	}

	private async _makeAnswer(): Promise<void> {
		const peerConnection = this.connection.peerConnection!;
		const provider = this.connection.provider!;

		try {
			const answer = await peerConnection.createAnswer();

			if (!this.connection.peerConnection) {
				logger.log("PeerConnection closed during createAnswer");
				return;
			}

			logger.log("Created answer.");

			if (
				this.connection.options.sdpTransform &&
				typeof this.connection.options.sdpTransform === "function"
			) {
				answer.sdp = this.connection.options.sdpTransform(answer.sdp) || answer.sdp;
			}

			// Apply H.264 SDP fallback for video (Safari compatibility)
			if (this.connection.type === ConnectionType.Media && answer.sdp) {
				answer.sdp = this._applyH264SdpFallback(answer.sdp, peerConnection);
			}

			try {
				await peerConnection.setLocalDescription(answer);

				if (!this.connection.peerConnection) {
					logger.log("PeerConnection closed during setLocalDescription");
					return;
				}

				logger.log(`Set localDescription:`, answer, `for:${this.connection.peer}`);

				provider.socket.send({
					type: ServerMessageType.Answer,
					payload: {
						sdp: answer,
						type: this.connection.type,
						connectionId: this.connection.connectionId,
					},
					dst: this.connection.peer,
				});
			} catch (err: unknown) {
				provider.emitError(DendriErrorType.WebRTC, err instanceof Error ? err : String(err));
				logger.log("Failed to setLocalDescription, ", err);
			}
		} catch (err_1: unknown) {
			provider.emitError(DendriErrorType.WebRTC, err_1 instanceof Error ? err_1 : String(err_1));
			logger.log("Failed to create answer, ", err_1);
		}
	}

	/** Handle an SDP. */
	async handleSDP(type: string, sdp: any): Promise<void> {
		const peerConnection = this.connection.peerConnection!;
		const provider = this.connection.provider!;

		logger.log("Setting remote description", sdp);

		try {
			await peerConnection.setRemoteDescription(sdp);

			if (!this.connection.peerConnection) {
				logger.log("PeerConnection closed during setRemoteDescription");
				return;
			}

			logger.log(`Set remoteDescription:${type} for:${this.connection.peer}`);

			// Flush any ICE candidates that arrived before remote description was set
			if (this._pendingCandidates.length > 0) {
				logger.log(`Flushing ${this._pendingCandidates.length} pending ICE candidates`);
				const candidates = this._pendingCandidates;
				this._pendingCandidates = [];
				for (const candidate of candidates) {
					await this.handleCandidate(candidate);
				}
			}

			if (type === "OFFER") {
				await this._makeAnswer();
			}
		} catch (err: unknown) {
			provider.emitError(DendriErrorType.WebRTC, err instanceof Error ? err : String(err));
			logger.log("Failed to setRemoteDescription, ", err);
		}
	}

	/** Handle a candidate. */
	async handleCandidate(ice: RTCIceCandidate) {
		logger.log(`handleCandidate:`, ice);

		const peerConnection = this.connection.peerConnection;

		if (!peerConnection) {
			logger.warn(`PeerConnection not set for ${this.connection.peer}, cannot add ICE candidate`);
			return;
		}

		// Queue candidates that arrive before remote description is set
		if (!peerConnection.remoteDescription) {
			logger.log(`Queueing ICE candidate (no remote description yet)`);
			this._pendingCandidates.push(ice);
			return;
		}

		try {
			await peerConnection.addIceCandidate(ice);
			logger.log(`Added ICE candidate for:${this.connection.peer}`);
		} catch (err: unknown) {
			this.connection.provider?.emitError(
				DendriErrorType.WebRTC,
				err instanceof Error ? err : String(err),
			);
			logger.log("Failed to handleCandidate, ", err);
		}
	}

	/**
	 * Set codec preferences on all video transceivers to prioritize H.264.
	 * Safari only supports H.264 for video, so this ensures cross-browser
	 * compatibility when one peer is Safari and the other is Chrome/Firefox.
	 */
	private _setCodecPreferences(pc: RTCPeerConnection): void {
		if (!pc.getTransceivers) return;

		for (const transceiver of pc.getTransceivers()) {
			if (transceiver.sender?.track?.kind === "video") {
				const codecs =
					typeof RTCRtpReceiver !== "undefined"
						? RTCRtpReceiver.getCapabilities?.("video")?.codecs
						: undefined;
				if (!codecs) continue;

				const h264 = codecs.filter((c) => c.mimeType === "video/H264");
				const others = codecs.filter((c) => c.mimeType !== "video/H264");

				if (h264.length > 0 && typeof transceiver.setCodecPreferences === "function") {
					try {
						transceiver.setCodecPreferences([...h264, ...others]);
					} catch {
						// setCodecPreferences may throw if codecs are invalid
					}
				}
			}
		}
	}

	/**
	 * SDP fallback for browsers without setCodecPreferences support.
	 * Reorders H.264 payload types to the front of the m=video line so that
	 * H.264 is preferred during negotiation.
	 */
	_preferH264InSdp(sdp: string): string {
		const lines = sdp.split("\r\n");
		const result: string[] = [];

		// Collect H.264 payload types from a=rtpmap lines
		const h264Payloads: string[] = [];
		for (const line of lines) {
			if (line.includes("a=rtpmap:") && line.toLowerCase().includes("h264")) {
				const match = line.match(/a=rtpmap:(\d+)/);
				if (match) h264Payloads.push(match[1]);
			}
		}

		for (const line of lines) {
			if (line.startsWith("m=video") && h264Payloads.length > 0) {
				const parts = line.split(" ");
				const prefix = parts.slice(0, 3).join(" ");
				const payloads = parts.slice(3);
				const reordered = [...h264Payloads, ...payloads.filter((p) => !h264Payloads.includes(p))];
				result.push(`${prefix} ${reordered.join(" ")}`);
				continue;
			}
			result.push(line);
		}

		return result.join("\r\n");
	}

	/**
	 * Apply H.264 preference to SDP when setCodecPreferences is not available.
	 * Returns the original SDP unchanged if setCodecPreferences was already applied.
	 */
	private _applyH264SdpFallback(sdp: string, pc: RTCPeerConnection): string {
		// If setCodecPreferences is supported, the transceiver API already handled it
		const hasSetCodecPreferences =
			pc.getTransceivers &&
			pc.getTransceivers().some((t) => typeof t.setCodecPreferences === "function");

		if (hasSetCodecPreferences) return sdp;

		return this._preferH264InSdp(sdp);
	}

	private _addTracksToConnection(stream: MediaStream, peerConnection: RTCPeerConnection): void {
		logger.log(`add tracks from stream ${stream.id} to peer connection`);

		if (!peerConnection.addTrack) {
			logger.error(`Your browser doesn't support RTCPeerConnection#addTrack. Ignored.`);
			return;
		}

		stream.getTracks().forEach((track) => {
			peerConnection.addTrack(track, stream);
		});
	}

	private _addStreamToMediaConnection(stream: MediaStream, mediaConnection: MediaConnection): void {
		logger.log(`add stream ${stream.id} to media connection ${mediaConnection.connectionId}`);

		mediaConnection.addStream(stream);
	}
}
