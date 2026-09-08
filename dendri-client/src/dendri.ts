import { API } from "./api";
import { BinaryPack } from "./dataconnection/BufferedConnection/BinaryPack";
import { Json } from "./dataconnection/BufferedConnection/Json";
import { Raw } from "./dataconnection/BufferedConnection/Raw";
import type { DataConnection } from "./dataconnection/DataConnection";
import { type DendriError, EventEmitterWithError } from "./dendriError";
import {
	ConnectionState,
	ConnectionType,
	DendriErrorType,
	ServerMessageType,
	SocketEventType,
	type TransportMode,
} from "./enums";
import { HybridConnection } from "./hybridconnection";
import logger, { type LogLevel } from "./logger";
import { MediaConnection } from "./mediaconnection";
import type {
	CallOption,
	DendriConnectOption,
	DendriOption,
	HybridConnectionOption,
} from "./optionInterfaces";
import { PollingTransport } from "./polling-transport";
import type { ServerMessage } from "./servermessage";
import { Socket } from "./socket";
import { SSETransport } from "./sse-transport";
import type { SignalingTransport } from "./transport";
import { util } from "./util";

/** Expand a full server URL ("wss://signal.example.com[:port][/path]") into host/port/secure/path options. */
export function parseServerUrl(
	url: string,
): Pick<DendriOptions, "host" | "port" | "secure" | "path"> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(
			`Invalid Dendri "url" option: "${url}". Expected a full URL like "wss://signal.example.com".`,
		);
	}
	const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
	if (!secure && parsed.protocol !== "ws:" && parsed.protocol !== "http:") {
		throw new Error(
			`Invalid Dendri "url" protocol: "${parsed.protocol}". Use wss://, ws://, https://, or http://.`,
		);
	}
	return {
		host: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : secure ? 443 : 80,
		secure,
		path: parsed.pathname || "/",
	};
}

class DendriOptions implements DendriOption {
	/**
	 * Prints log messages depending on the debug level passed in.
	 */
	debug?: LogLevel;
	/**
	 * Full server URL, e.g. `"wss://signal.example.com"` or `"http://127.0.0.1:9876"`.
	 * Shorthand for host/port/secure/path; any of those passed explicitly win.
	 */
	url?: string;
	/** API key for hosted / multi-tenant Dendri deployments. Sent with every signaling and REST request. */
	apiKey?: string;
	/**
	 * Server host for your Dendri signaling server.
	 * Also accepts `'/'` to signify relative hostname.
	 */
	host!: string;
	/**
	 * Server port. Defaults to `443`.
	 */
	port?: number;
	/**
	 * The path where your self-hosted Dendri server is running. Defaults to `'/'`
	 */
	path?: string;
	/**
	 * API key for the Dendri server.
	 * This is not used anymore.
	 * @deprecated
	 */
	key?: string;
	token?: string;
	/**
	 * Configuration hash passed to RTCPeerConnection.
	 * This hash contains any custom ICE/TURN server configuration.
	 *
	 * Defaults to {@apilink util.defaultConfig}
	 */
	config?: RTCConfiguration;
	/**
	 * Set to true `true` if you're using TLS.
	 * :::danger
	 * If possible *always use TLS*
	 * :::
	 */
	secure?: boolean;
	pingInterval?: number;
	referrerPolicy?: ReferrerPolicy;
	logFunction?: (logLevel: LogLevel, ...rest: unknown[]) => void;
	serializers?: SerializerMapping;
	/** Auto-fetch TURN credentials from the signaling server's GET /turn endpoint. */
	fetchTurnCredentials?: boolean;
	/** Optional JWT for authenticated connections. */
	jwt?: string;
	/** Enable WebSocket relay fallback when WebRTC is unavailable. */
	enableRelay?: boolean;
	/** Optional function to validate connection metadata before accepting. */
	validateMetadata?: (metadata: unknown) => boolean;
	/** Signaling transport: 'websocket' (default), 'sse', 'polling', or 'auto' (tries WS then SSE then polling) */
	signalingTransport?: "websocket" | "sse" | "polling" | "auto";
	/**
	 * ICE candidate privacy policy.
	 * - 'all': RFC 8828 mode 1 — all candidates including host IPs (default)
	 * - 'public': RFC 8828 mode 3 — only STUN/TURN (srflx + relay) candidates
	 */
	ipPolicy?: "all" | "public";
}

export type { DendriOptions };

export interface SerializerMapping {
	[key: string]: new (peerId: string, provider: Dendri, options: any) => DataConnection;
}

export interface DendriEvents {
	/**
	 * Emitted when a connection to the Dendri server is established.
	 *
	 * You may use the peer before this is emitted, but messages to the server will be queued. <code>id</code> is the brokering ID of the peer (which was either provided in the constructor or assigned by the server).<span class='tip'>You should not wait for this event before connecting to other peers if connection speed is important.</span>
	 */
	open: (id: string) => void;
	/**
	 * Emitted when a new data connection is established from a remote peer.
	 */
	connection: (dataConnection: DataConnection) => void;
	/**
	 * Emitted when a remote peer attempts to call you.
	 */
	call: (mediaConnection: MediaConnection) => void;
	/**
	 * Emitted when the peer is destroyed and can no longer accept or create any new connections.
	 */
	close: () => void;
	/**
	 * Emitted when the peer is disconnected from the signalling server
	 */
	disconnected: (currentId: string) => void;
	/**
	 * Errors on the peer are almost always fatal and will destroy the peer.
	 *
	 * Errors from the underlying socket and PeerConnections are forwarded here.
	 */
	error: (error: DendriError<`${DendriErrorType}`>) => void;
	/**
	 * Emitted when the server sends a ROOM_PEERS message with the current
	 * list of peers in a room.
	 */
	roomPeers: (room: string, peers: string[]) => void;
	/**
	 * Emitted when the connection state machine transitions to a new state.
	 */
	connectionStateChanged: (state: ConnectionState, previousState: ConnectionState) => void;
	/**
	 * Emitted when a PRESENCE_UPDATE message is received from the server.
	 */
	presenceUpdate: (peerId: string, room: string, data: unknown) => void;
	/**
	 * Emitted when the underlying signaling socket finishes a successful
	 * reconnection. Consumers (e.g. Room) should re-send server-side
	 * state (joinRoom, presence) so it survives server-side state loss
	 * such as a Durable Object hibernation + wake-up cycle.
	 */
	reconnected: () => void;
}
/**
 * A peer who can initiate connections with other peers.
 */
export class Dendri extends EventEmitterWithError<DendriErrorType, DendriEvents> {
	private static readonly DEFAULT_KEY = "dendri";

	protected readonly _serializers: SerializerMapping = {
		raw: Raw,
		json: Json,
		binary: BinaryPack,
		"binary-utf8": BinaryPack,

		default: BinaryPack,
	};
	private readonly _options: DendriOptions;
	private readonly _api: API;
	private readonly _socket: SignalingTransport;

	private _id: string | null = null;
	private _lastServerId: string | null = null;

	// Connection state machine.
	private _connectionState: ConnectionState = ConnectionState.Initialized;

	/** Number of consecutive reconnection failures that triggers the Suspended state. */
	private static readonly SUSPEND_THRESHOLD = 5;

	private readonly _connections: Map<string, (DataConnection | MediaConnection)[]> = new Map(); // All connections for this peer.
	private readonly _lostMessages: Map<string, ServerMessage[]> = new Map(); // src => [list of messages]
	private readonly _lostMessageGeneration: Map<string, number> = new Map();
	private readonly _hybridConnections: Map<string, HybridConnection> = new Map(); // peer => HybridConnection
	/**
	 * The brokering ID of this peer
	 *
	 * If no ID was specified in {@apilink Dendri | the constructor},
	 * this will be `undefined` until the {@apilink DendriEvents | `open`} event is emitted.
	 */
	get id() {
		return this._id;
	}

	get options() {
		return this._options;
	}

	/**
	 * The current connection state of this peer.
	 */
	get connectionState(): ConnectionState {
		return this._connectionState;
	}

	get open() {
		return this._connectionState === ConnectionState.Connected;
	}

	/**
	 * @internal
	 */
	get socket() {
		return this._socket;
	}

	/**
	 * A hash of all connections associated with this peer, keyed by the remote peer's ID.
	 * @deprecated
	 * Return type will change from Object to Map<string,[]>
	 */
	get connections(): Object {
		const plainConnections = Object.create(null);

		for (const [k, v] of this._connections) {
			plainConnections[k] = [...v];
		}

		return plainConnections;
	}

	/**
	 * true if this peer and all of its connections can no longer be used.
	 */
	get destroyed() {
		return (
			this._connectionState === ConnectionState.Closed ||
			this._connectionState === ConnectionState.Failed
		);
	}
	/**
	 * false if there is an active connection to the Dendri server.
	 *
	 * Also returns true for terminal states (Closed/Failed) to preserve
	 * backward compatibility: the original boolean was set during
	 * disconnect() and never cleared by destroy().
	 */
	get disconnected() {
		const s = this._connectionState;
		return (
			s === ConnectionState.Disconnected ||
			s === ConnectionState.Suspended ||
			s === ConnectionState.Closed ||
			s === ConnectionState.Failed
		);
	}

	/**
	 * A peer can connect to other peers and listen for connections.
	 */
	constructor(options: DendriOptions);

	/**
	 * A peer can connect to other peers and listen for connections.
	 * @param id Other peers can connect to this peer using the provided ID.
	 *     If no ID is given, one will be generated by the brokering server.
	 * The ID must start and end with an alphanumeric character (lower or upper case character or a digit). In the middle of the ID spaces, dashes (-) and underscores (_) are allowed. Use {@apilink DendriOptions.metadata } to send identifying information.
	 * @param options for specifying details about Dendri server
	 */
	constructor(id: string, options?: DendriOptions);

	constructor(id?: string | DendriOptions, options?: DendriOptions) {
		super();

		let userId: string | undefined;
		let providedOptions = options;

		// Deal with overloading
		if (id && typeof id === "object" && id.constructor === Object) {
			providedOptions = id as DendriOptions;
		} else if (id) {
			userId = id.toString();
		}

		// Expand the `url` shorthand into host/port/secure/path; explicit fields win.
		if (providedOptions?.url) {
			providedOptions = { ...parseServerUrl(providedOptions.url), ...providedOptions };
		}

		// Configurize options
		const normalizedOptions = {
			debug: 0, // 1: Errors, 2: Warnings, 3: All logs
			port: util.CLOUD_PORT,
			path: "/",
			key: Dendri.DEFAULT_KEY,
			token: util.randomToken(),
			config: util.defaultConfig,
			referrerPolicy: "strict-origin-when-cross-origin",
			serializers: {},
			...providedOptions,
		} as DendriOptions;
		this._options = normalizedOptions;

		if (typeof this._options.host !== "string" || this._options.host.trim() === "") {
			throw new Error(
				'Dendri requires a signaling server host. Pass your self-hosted server domain, for example { host: "signal.example.com", secure: true }.',
			);
		}
		this._options.host = this._options.host.trim();

		this._serializers = { ...this._serializers, ...this.options.serializers };

		// Detect relative URL host.
		if (this._options.host === "/") {
			this._options.host = typeof window !== "undefined" ? window.location.hostname : "localhost";
		}

		// Set path correctly.
		if (this._options.path) {
			if (this._options.path[0] !== "/") {
				this._options.path = `/${this._options.path}`;
			}
			if (this._options.path[this._options.path.length - 1] !== "/") {
				this._options.path += "/";
			}
		}

		// Set whether we use SSL to same as current host
		if (this._options.secure === undefined && this._options.host !== util.CLOUD_HOST) {
			this._options.secure = util.isSecure();
		} else if (this._options.host === util.CLOUD_HOST) {
			this._options.secure = true;
		}
		// Set a custom log function if present
		if (this._options.logFunction) {
			logger.setLogFunction(this._options.logFunction);
		}

		logger.logLevel = this._options.debug || 0;

		this._api = new API(this._options);
		this._socket = this._createServerConnection();

		// Sanity checks
		// Ensure WebRTC supported (or relay-only mode enabled)
		if (!util.supports.audioVideo && !util.supports.data) {
			if (this._options.enableRelay) {
				logger.warn("WebRTC not supported — operating in relay-only mode");
			} else {
				this._delayedAbort(
					DendriErrorType.BrowserIncompatible,
					"The current browser does not support WebRTC",
				);
				return;
			}
		}

		// Ensure alphanumeric id
		if (userId && !util.validateId(userId)) {
			this._delayedAbort(DendriErrorType.InvalidID, `ID "${userId}" is invalid`);
			return;
		}

		if (userId) {
			this._initialize(userId);
		} else {
			this._api
				.retrieveId()
				.then((id) => this._initialize(id))
				.catch((error) => this._abort(DendriErrorType.ServerError, error, true));
		}
	}

	/**
	 * Transition to a new connection state. Invalid transitions are logged and ignored.
	 */
	private _setState(newState: ConnectionState): void {
		const oldState = this._connectionState;
		if (oldState === newState) return;

		if (!Dendri._isValidTransition(oldState, newState)) {
			logger.warn(`Invalid state transition: ${oldState} → ${newState}`);
			return;
		}

		this._connectionState = newState;
		this.emit("connectionStateChanged", newState, oldState);
	}

	private static _isValidTransition(from: ConnectionState, to: ConnectionState): boolean {
		const transitions: Record<ConnectionState, ConnectionState[]> = {
			[ConnectionState.Initialized]: [
				ConnectionState.Connecting,
				ConnectionState.Disconnected,
				ConnectionState.Closed,
				ConnectionState.Failed,
			],
			[ConnectionState.Connecting]: [
				ConnectionState.Connected,
				ConnectionState.Disconnected,
				ConnectionState.Failed,
				ConnectionState.Closed,
			],
			[ConnectionState.Connected]: [ConnectionState.Disconnected, ConnectionState.Closed],
			[ConnectionState.Disconnected]: [
				ConnectionState.Connecting,
				ConnectionState.Suspended,
				ConnectionState.Closed,
				ConnectionState.Failed,
			],
			[ConnectionState.Suspended]: [
				ConnectionState.Connecting,
				ConnectionState.Closed,
				ConnectionState.Failed,
			],
			[ConnectionState.Closed]: [], // Terminal
			[ConnectionState.Failed]: [ConnectionState.Closed], // Terminal, can only close
		};
		return transitions[from]?.includes(to) ?? false;
	}

	private _createServerConnection(): SignalingTransport {
		const transport = this._options.signalingTransport || "websocket";

		const socket: SignalingTransport =
			transport === "sse"
				? new SSETransport(
						this._options.secure ?? false,
						this._options.host!,
						this._options.port!,
						this._options.path!,
						this._options.key!,
						this._options.pingInterval,
						this._options.jwt,
						this._options.apiKey,
					)
				: transport === "polling"
					? new PollingTransport(
							this._options.secure ?? false,
							this._options.host!,
							this._options.port!,
							this._options.path!,
							this._options.key!,
							this._options.pingInterval,
							this._options.jwt,
							this._options.apiKey,
						)
					: new Socket(
							this._options.secure ?? false,
							this._options.host!,
							this._options.port!,
							this._options.path!,
							this._options.key!,
							this._options.pingInterval,
							this._options.jwt,
							this._options.apiKey,
						);

		socket.on(SocketEventType.Message, (data: ServerMessage) => {
			this._handleMessage(data);
		});

		socket.on(SocketEventType.Error, (error: string) => {
			this._abort(DendriErrorType.SocketError, error, true);
		});

		socket.on(SocketEventType.Disconnected, () => {
			if (this.disconnected) {
				return;
			}

			this.emitError(DendriErrorType.Network, "Lost connection to server.", true);
			this.disconnect();
		});

		socket.on(SocketEventType.ReconnectAttempt, (attempt: number) => {
			if (
				attempt >= Dendri.SUSPEND_THRESHOLD &&
				this._connectionState === ConnectionState.Disconnected
			) {
				this._setState(ConnectionState.Suspended);
			}
		});

		socket.on(SocketEventType.Reconnected, () => {
			this.emit("reconnected");
		});

		return socket;
	}

	/** Initialize a connection with the server. */
	private _initialize(id: string): void {
		this._id = id;
		this._setState(ConnectionState.Connecting);
		this.socket.start(id, this._options.token!);

		if (util.isSafari || util.isIOS) {
			logger.log("Safari/iOS detected — H.264 codec preference will be applied for video calls");
		}
	}

	/** Handles messages from the server. */
	private _handleMessage(message: ServerMessage): void {
		const type = message.type;
		const payload = message.payload;
		const peerId = message.src;

		switch (type) {
			case ServerMessageType.Open: // The connection to the server is open.
				this._lastServerId = this.id;
				this._setState(ConnectionState.Connected);
				this._fetchTurnIfEnabled().then(() => {
					this.emit("open", this.id!);
				});
				break;
			case ServerMessageType.Error: // Server error.
				this._abort(DendriErrorType.ServerError, payload.msg, true);
				break;
			case ServerMessageType.IdTaken: // The selected ID is taken.
				this._abort(DendriErrorType.UnavailableID, `ID "${this.id}" is taken`);
				break;
			case ServerMessageType.InvalidKey: // The given API key cannot be found.
				this._abort(DendriErrorType.InvalidKey, `API KEY "${this._options.key}" is invalid`);
				break;
			case ServerMessageType.Leave: // Another peer has closed its connection to this peer.
				logger.log(`Received leave message from ${peerId}`);
				this._cleanupPeer(peerId);
				this._connections.delete(peerId);
				break;
			case ServerMessageType.Expire: // The offer sent to a peer has expired without response.
				this.emitError(
					DendriErrorType.PeerUnavailable,
					`Could not connect to peer ${peerId}`,
					true,
				);
				break;
			case ServerMessageType.Offer: {
				// we should consider switching this to CALL/CONNECT, but this is the least breaking option.
				const connectionId = payload.connectionId;
				let connection = this.getConnection(peerId, connectionId);

				if (connection) {
					connection.close();
					logger.warn(`Offer received for existing Connection ID:${connectionId}`);
				}

				// Validate metadata if a validator is configured.
				if (this._options.validateMetadata && !this._options.validateMetadata(payload.metadata)) {
					logger.warn(`Rejected connection from ${peerId} - metadata validation failed`);
					return;
				}

				// Create a new connection.
				if (payload.type === ConnectionType.Media) {
					const mediaConnection = new MediaConnection(peerId, this, {
						connectionId: connectionId,
						_payload: payload,
						metadata: payload.metadata,
					});
					connection = mediaConnection;
					this._addConnection(peerId, connection);
					this.emit("call", mediaConnection);
				} else if (payload.type === ConnectionType.Data) {
					const Serializer = this._serializers[payload.serialization];

					if (!Serializer) {
						logger.warn(`Received offer with unknown serialization type: ${payload.serialization}`);
						return;
					}

					const dataConnection = new Serializer(peerId, this, {
						connectionId: connectionId,
						_payload: payload,
						metadata: payload.metadata,
						label: payload.label,
						serialization: payload.serialization,
						reliable: payload.reliable,
					});
					connection = dataConnection;

					this._addConnection(peerId, connection);
					this.emit("connection", dataConnection);
				} else {
					logger.warn(`Received malformed connection type:${payload.type}`);
					return;
				}

				// Find messages.
				const messages = this._getMessages(connectionId);
				for (const message of messages) {
					connection.handleMessage(message);
				}

				break;
			}
			case ServerMessageType.KeyExchange: {
				// Route KEY_EXCHANGE to the appropriate HybridConnection.
				const hybridKx = this._hybridConnections.get(peerId);
				if (hybridKx) {
					hybridKx.handleKeyExchange(payload);
				} else {
					logger.warn(`Received KEY-EXCHANGE from ${peerId} but no HybridConnection exists`);
				}
				break;
			}
			case ServerMessageType.Data: {
				// Relay data routed to a HybridConnection.
				const hybrid = this._hybridConnections.get(peerId);
				if (hybrid) {
					const seq = message.seq;
					// If the payload contains an __ackId, send an ACK back to the sender.
					if (
						payload !== null &&
						typeof payload === "object" &&
						"__ackId" in payload &&
						typeof payload.__ackId === "string"
					) {
						this._socket.send({
							type: ServerMessageType.Ack,
							dst: peerId,
							payload: { ackId: payload.__ackId },
						});
						// Unwrap and deliver the inner data.
						hybrid.handleRelayData(payload.data, seq);
					} else {
						hybrid.handleRelayData(payload, seq);
					}
				} else {
					// Emit for Room relay fallback — room-scoped DATA messages
					// that arrive when no HybridConnection exists.
					this.emit("relayData" as any, peerId, payload, message.room);
				}
				break;
			}
			case ServerMessageType.Ack: {
				// Route ACK to the matching HybridConnection's AckManager.
				if (payload?.ackId) {
					const hybrid = this._hybridConnections.get(peerId);
					if (hybrid) {
						hybrid.ackManager.handleAck(payload.ackId);
					}
				}
				break;
			}
			case ServerMessageType.RoomPeers: {
				const room = message.room ?? "";
				const peers: string[] = Array.isArray(payload) ? payload : [];
				this.emit("roomPeers", room, peers);
				break;
			}
			case ServerMessageType.PresenceUpdate: {
				this.emit("presenceUpdate", message.src, message.room ?? "", payload);
				break;
			}
			case ServerMessageType.Heartbeat:
				// Server echo — silently ignore.
				break;
			default: {
				if (!payload) {
					logger.warn(`You received a malformed message from ${peerId} of type ${type}`);
					return;
				}

				const connectionId = payload.connectionId;
				const connection = this.getConnection(peerId, connectionId);

				if (connection?.peerConnection) {
					// Pass it on.
					connection.handleMessage(message);
				} else if (connectionId) {
					// Store for possible later use
					this._storeMessage(connectionId, message);
				} else {
					logger.warn("You received an unrecognized message:", message);
				}
				break;
			}
		}
	}

	private static readonly MAX_LOST_MESSAGES = 1000;
	private static readonly LOST_MESSAGE_TTL = 5 * 60 * 1000; // 5 minutes

	/** Stores messages without a set up connection, to be claimed later. */
	private _storeMessage(connectionId: string, message: ServerMessage): void {
		if (!this._lostMessages.has(connectionId)) {
			this._lostMessages.set(connectionId, []);
		}

		this._lostMessages.get(connectionId)?.push(message);

		// Cap total stored messages to prevent unbounded growth
		let totalMessages = 0;
		for (const msgs of this._lostMessages.values()) {
			totalMessages += msgs.length;
		}
		if (totalMessages > Dendri.MAX_LOST_MESSAGES) {
			// Remove the oldest entry (first key in Map iteration order)
			const oldestKey = this._lostMessages.keys().next().value;
			if (oldestKey !== undefined) {
				this._lostMessages.delete(oldestKey);
				this._lostMessageGeneration.delete(oldestKey);
			}
		}

		// Schedule TTL cleanup with generation counter to avoid deleting
		// messages that were re-stored after the timer was set.
		const gen = (this._lostMessageGeneration.get(connectionId) ?? 0) + 1;
		this._lostMessageGeneration.set(connectionId, gen);

		setTimeout(() => {
			if (this._lostMessageGeneration.get(connectionId) === gen) {
				this._lostMessages.delete(connectionId);
				this._lostMessageGeneration.delete(connectionId);
			}
		}, Dendri.LOST_MESSAGE_TTL);
	}

	/**
	 * Retrieve messages from lost message store
	 * @internal
	 */
	//TODO Change it to private
	public _getMessages(connectionId: string): ServerMessage[] {
		const messages = this._lostMessages.get(connectionId);

		if (messages) {
			this._lostMessages.delete(connectionId);
			this._lostMessageGeneration.delete(connectionId);
			return messages;
		}

		return [];
	}

	/**
	 * Connects to the remote peer specified by id and returns a data connection.
	 * @param peer The brokering ID of the remote peer (their {@apilink Dendri.id}).
	 * @param options for specifying details about the data connection
	 */
	connect(peer: string, options: DendriConnectOption = {}): DataConnection | undefined {
		if (!peer || typeof peer !== "string") {
			this.emitError(DendriErrorType.InvalidID, "A non-empty peer ID is required to connect.");
			return undefined;
		}

		options = {
			serialization: "default",
			...options,
		};
		if (this.disconnected) {
			logger.warn(
				"You cannot connect to a new Dendri instance because you called " +
					".disconnect() on this Dendri instance and ended your connection with the " +
					"server. You can create a new Dendri instance to reconnect, or call reconnect " +
					"on this peer if you believe its ID to still be available.",
			);
			this.emitError(
				DendriErrorType.Disconnected,
				"Cannot connect to new Dendri instance after disconnecting from server.",
			);
			return undefined;
		}

		const Serializer = this._serializers[options.serialization!];

		if (!Serializer) {
			this.emitError(
				DendriErrorType.InvalidID,
				`Unknown serialization type: ${options.serialization}`,
			);
			return undefined;
		}

		const dataConnection = new Serializer(peer, this, options);
		this._addConnection(peer, dataConnection);
		return dataConnection;
	}

	/**
	 * Calls the remote peer specified by id and returns a media connection.
	 * @param peer The brokering ID of the remote peer (their peer.id).
	 * @param stream The caller's media stream
	 * @param options Metadata associated with the connection, passed in by whoever initiated the connection.
	 */
	call(peer: string, stream: MediaStream, options: CallOption = {}): MediaConnection | undefined {
		if (!peer || typeof peer !== "string") {
			this.emitError(DendriErrorType.InvalidID, "A non-empty peer ID is required to call.");
			return undefined;
		}

		if (this.disconnected) {
			logger.warn(
				"You cannot connect to a new Dendri instance because you called " +
					".disconnect() on this Dendri instance and ended your connection with the " +
					"server. You can create a new Dendri instance to reconnect.",
			);
			this.emitError(
				DendriErrorType.Disconnected,
				"Cannot connect to new Dendri instance after disconnecting from server.",
			);
			return undefined;
		}

		if (!stream) {
			logger.error("To call a peer, you must provide a stream from your browser's `getUserMedia`.");
			return undefined;
		}

		const mediaConnection = new MediaConnection(peer, this, {
			...options,
			_stream: stream,
		});
		this._addConnection(peer, mediaConnection);
		return mediaConnection;
	}

	/**
	 * Create a hybrid connection that uses WebRTC when possible
	 * and transparently falls back to WebSocket relay.
	 *
	 * @param peer The brokering ID of the remote peer.
	 * @param options HybridConnection-specific options (ICE timeout, upgrade behaviour, etc.)
	 */
	connectHybrid(peer: string, options?: HybridConnectionOption): HybridConnection | undefined {
		if (!peer || typeof peer !== "string") {
			this.emitError(DendriErrorType.InvalidID, "A non-empty peer ID is required to connect.");
			return undefined;
		}

		if (this.disconnected) {
			logger.warn(
				"You cannot connect to a new Dendri instance because you called " +
					".disconnect() on this Dendri instance and ended your connection with the " +
					"server. You can create a new Dendri instance to reconnect, or call reconnect " +
					"on this peer if you believe its ID to still be available.",
			);
			this.emitError(
				DendriErrorType.Disconnected,
				"Cannot connect to new Dendri instance after disconnecting from server.",
			);
			return undefined;
		}

		const hybrid = new HybridConnection(peer, this, options);
		this._hybridConnections.set(peer, hybrid);

		// Clean up the reference when the hybrid connection closes.
		hybrid.on("close", () => {
			this._hybridConnections.delete(peer);
		});

		hybrid.start();
		return hybrid;
	}

	/**
	 * Join a room on the signaling server.
	 * The server will respond with a ROOM_PEERS message listing current members.
	 */
	joinRoom(roomName: string): void {
		this.socket.send({ type: ServerMessageType.RoomJoin, room: roomName });
	}

	/**
	 * Leave a room on the signaling server.
	 */
	leaveRoom(roomName: string): void {
		this.socket.send({ type: ServerMessageType.RoomLeave, room: roomName });
	}

	/** Auto-fetch TURN credentials when the option is enabled. */
	private async _fetchTurnIfEnabled(): Promise<void> {
		if (!this._options.fetchTurnCredentials) {
			return;
		}

		try {
			const turnServers = await this._api.getTurnCredentials();
			if (turnServers.length > 0) {
				const existingServers = this._options.config?.iceServers ?? [];
				this._options.config = {
					...this._options.config,
					iceServers: [...existingServers, ...turnServers],
				};
			}
		} catch (error) {
			logger.error("Failed to fetch TURN credentials", error);
		}
	}

	/** Add a data/media connection to this peer. */
	private _addConnection(peerId: string, connection: MediaConnection | DataConnection): void {
		logger.log(`add connection ${connection.type}:${connection.connectionId} to peerId:${peerId}`);

		if (!this._connections.has(peerId)) {
			this._connections.set(peerId, []);
		}
		this._connections.get(peerId)?.push(connection);
	}

	//TODO should be private
	_removeConnection(connection: DataConnection | MediaConnection): void {
		const connections = this._connections.get(connection.peer);

		if (connections) {
			const index = connections.indexOf(connection);

			if (index !== -1) {
				connections.splice(index, 1);
			}

			if (connections.length === 0) {
				this._connections.delete(connection.peer);
			}
		}

		//remove from lost messages
		this._lostMessages.delete(connection.connectionId);
		this._lostMessageGeneration.delete(connection.connectionId);
	}

	/** Retrieve a data/media connection for this peer. */
	getConnection(peerId: string, connectionId: string): null | DataConnection | MediaConnection {
		const connections = this._connections.get(peerId);
		if (!connections) {
			return null;
		}

		for (const connection of connections) {
			if (connection.connectionId === connectionId) {
				return connection;
			}
		}

		return null;
	}

	/** Error types that indicate an unrecoverable problem. */
	private static readonly FATAL_ERROR_TYPES: ReadonlySet<DendriErrorType> = new Set([
		DendriErrorType.BrowserIncompatible,
		DendriErrorType.InvalidID,
		DendriErrorType.InvalidKey,
	]);

	private _delayedAbort(type: DendriErrorType, message: string | Error, retryable = false): void {
		setTimeout(() => {
			this._abort(type, message, retryable);
		}, 0);
	}

	/**
	 * Emits an error message and destroys the Dendri instance.
	 * The Dendri instance is not destroyed if it's in a disconnected state, in which case
	 * it retains its disconnected state and its existing connections.
	 */
	private _abort(type: DendriErrorType, message: string | Error, retryable = false): void {
		logger.error("Aborting!");

		if (!this._lastServerId) {
			const isFatal = Dendri.FATAL_ERROR_TYPES.has(type);
			const terminalState = isFatal ? ConnectionState.Failed : ConnectionState.Closed;

			// Perform cleanup and state transition before emitting the error
			// so that listeners see the correct terminal state.
			this.disconnect();
			this._cleanup();
			this._setState(terminalState);

			this.emitError(type, message, retryable);
			this.emit("close");
		} else {
			this.emitError(type, message, retryable);
			this.disconnect();
		}
	}

	/**
	 * Destroys the Dendri instance: closes all active connections as well as the connection
	 * to the server.
	 *
	 * :::caution
	 * This cannot be undone; the respective peer object will no longer be able
	 * to create or receive any connections, its ID will be forfeited on the server,
	 * and all of its data and media connections will be closed.
	 * :::
	 */
	destroy(): void {
		this._destroyWithState(ConnectionState.Closed);
	}

	/** Internal destroy that transitions to the given terminal state. */
	private _destroyWithState(terminalState: ConnectionState): void {
		if (this.destroyed) {
			return;
		}

		logger.log(`Destroy peer with ID:${this.id}`);

		this.disconnect();
		this._cleanup();

		this._setState(terminalState);

		this.emit("close");
	}

	/** Disconnects every connection on this peer. */
	private _cleanup(): void {
		const peerIds = [...this._connections.keys()];

		for (const peerId of peerIds) {
			this._cleanupPeer(peerId);
		}

		this._connections.clear();

		// Close all hybrid connections.
		for (const hybrid of this._hybridConnections.values()) {
			hybrid.close();
		}
		this._hybridConnections.clear();

		this.socket.removeAllListeners();
	}

	/** Closes all connections to this peer. */
	private _cleanupPeer(peerId: string): void {
		const connections = this._connections.get(peerId);

		if (!connections) return;

		// Copy array since close() calls _removeConnection which mutates it
		const connectionsToClose = [...connections];

		for (const connection of connectionsToClose) {
			connection.close();
		}
	}

	/**
	 * Disconnects the Dendri instance's connection to the Dendri server. Does not close any
	 *  active connections.
	 * Warning: The peer can no longer create or accept connections after being
	 *  disconnected. It also cannot reconnect to the server.
	 */
	disconnect(): void {
		const s = this._connectionState;
		if (
			s === ConnectionState.Disconnected ||
			s === ConnectionState.Suspended ||
			s === ConnectionState.Closed ||
			s === ConnectionState.Failed
		) {
			return;
		}

		const currentId = this.id;

		logger.log(`Disconnect peer with ID:${currentId}`);

		this._setState(ConnectionState.Disconnected);

		this.socket.close();

		this._lastServerId = currentId;
		this._id = null;

		this.emit("disconnected", currentId!);
	}

	/** Attempts to reconnect with the same ID.
	 *
	 * Only {@apilink Dendri.disconnect | disconnected peers} can be reconnected.
	 * Destroyed peers cannot be reconnected.
	 * If the connection fails (as an example, if the peer's old ID is now taken),
	 * the peer's existing connections will not close, but any associated errors events will fire.
	 */
	reconnect(): void {
		if (this.disconnected && !this.destroyed) {
			logger.log(`Attempting reconnection to server with ID ${this._lastServerId}`);
			this._initialize(this._lastServerId!);
		} else if (this.destroyed) {
			throw new Error("This peer cannot reconnect to the server. It has already been destroyed.");
		} else if (!this.disconnected && !this.open) {
			// Do nothing. We're still connecting the first time.
			logger.error("In a hurry? We're still trying to make the initial connection!");
		} else {
			throw new Error(
				`Dendri ${this.id} cannot reconnect because it is not disconnected from the server!`,
			);
		}
	}

	/**
	 * Get a list of available peer IDs. If you're running your own server, you'll
	 * want to set allow_discovery: true in the Dendri server options.
	 */
	listAllPeers(cb = (_: any[]) => {}): void {
		this._api
			.listAllPeers()
			.then((peers) => cb(peers))
			.catch((error) => this.emitError(DendriErrorType.ServerError, error, true));
	}

	/** Returns a snapshot of the current connection state for debugging. */
	diagnostics(): {
		peerId: string | null;
		connectionState: ConnectionState;
		serverConnected: boolean;
		connections: Array<{
			peerId: string;
			type: string;
			open: boolean;
		}>;
		hybridConnections: Array<{
			peerId: string;
			mode: TransportMode;
			open: boolean;
		}>;
		socket: {
			connected: boolean;
			autoReconnect: boolean;
			reconnectAttempt: number;
			lastSeq: number;
		};
		pendingMessages: number;
	} {
		const connections: Array<{ peerId: string; type: string; open: boolean }> = [];
		for (const [peerId, conns] of this._connections) {
			for (const conn of conns) {
				connections.push({
					peerId,
					type: conn.type,
					open: conn.open,
				});
			}
		}

		const hybridConnections: Array<{
			peerId: string;
			mode: TransportMode;
			open: boolean;
		}> = [];
		for (const [peerId, hybrid] of this._hybridConnections) {
			hybridConnections.push({
				peerId,
				mode: hybrid.mode,
				open: hybrid.open,
			});
		}

		return {
			peerId: this.id ?? null,
			connectionState: this.connectionState,
			serverConnected: !this.disconnected,
			connections,
			hybridConnections,
			socket: {
				connected: !!(this.socket as any)?._socket,
				autoReconnect: (this.socket as any)?._autoReconnect ?? false,
				reconnectAttempt: (this.socket as any)?._reconnectAttempt ?? 0,
				lastSeq: (this.socket as any)?._lastSeq ?? 0,
			},
			pendingMessages: this._lostMessages.size,
		};
	}
}
