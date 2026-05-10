export interface AnswerOption {
	/**
	 * Function which runs before create answer to modify sdp answer message.
	 */
	sdpTransform?: (sdp: string) => string;
}

export interface DendriOption {
	key?: string;
	host?: string;
	port?: number;
	path?: string;
	secure?: boolean;
	token?: string;
	config?: RTCConfiguration;
	debug?: number;
	referrerPolicy?: ReferrerPolicy;
	/** Auto-fetch TURN credentials from the signaling server's GET /{key}/turn-credentials endpoint. */
	fetchTurnCredentials?: boolean;
	/** Optional JWT for authenticated connections. */
	jwt?: string;
	/** Enable WebSocket relay fallback when WebRTC is unavailable. */
	enableRelay?: boolean;
	/** Optional function to validate connection metadata before accepting. */
	validateMetadata?: (metadata: unknown) => boolean;
	/** Signaling transport: 'websocket' (default), 'sse', 'polling', or 'auto' (tries WS then SSE then polling) */
	signalingTransport?: "websocket" | "sse" | "polling" | "auto";
}

export interface DendriConnectOption {
	/**
	 * A unique label by which you want to identify this data connection.
	 * If left unspecified, a label will be generated at random.
	 *
	 * Can be accessed with {@apilink DataConnection.label}
	 */
	label?: string;
	/**
	 * Metadata associated with the connection, passed in by whoever initiated the connection.
	 *
	 * Can be accessed with {@apilink DataConnection.metadata}.
	 * Can be any serializable type.
	 */
	metadata?: any;
	serialization?: string;
	reliable?: boolean;
}

export interface HybridConnectionOption {
	/** Milliseconds before falling back to WebSocket relay (default 10000). */
	iceTimeout?: number;
	/** Periodically retry WebRTC when on relay (default true). */
	autoUpgrade?: boolean;
	/** Milliseconds between upgrade attempts (default 60000). */
	upgradeInterval?: number;
	/** Max consecutive upgrade failures before stopping (default 5). */
	maxUpgradeAttempts?: number;
	/** Poll getStats() for connection quality metrics (default false). */
	enableMetrics?: boolean;
	/** Encrypt relay (WebSocket) messages with ECDH + AES-256-GCM (default true). */
	encryptRelay?: boolean;
}

export interface CallOption {
	/**
	 * Metadata associated with the connection, passed in by whoever initiated the connection.
	 *
	 * Can be accessed with {@apilink MediaConnection.metadata}.
	 * Can be any serializable type.
	 */
	metadata?: any;
	/**
	 * Function which runs before create offer to modify sdp offer message.
	 */
	sdpTransform?: (sdp: string) => string;
}
