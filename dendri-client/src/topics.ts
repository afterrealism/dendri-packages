/**
 * Callback signature for topic message handlers.
 * @param data  The payload received on this topic.
 * @param peerId  The ID of the peer that sent the message.
 */
export type TopicHandler = (data: unknown, peerId: string) => void;

/**
 * Marker interface for messages that carry topic metadata.
 * When a topic is specified the original payload is wrapped in this envelope
 * so the receiver can extract and route it.
 */
export interface TopicEnvelope {
	readonly __topic: string;
	readonly __data: unknown;
	/** If true, `__data` is base64-encoded bytes — receivers must decode before use. */
	readonly __binary?: boolean;
}

/** Type-guard: does `value` look like a topic-wrapped envelope? */
export function isTopicEnvelope(value: unknown): value is TopicEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		"__topic" in value &&
		typeof (value as Record<string, unknown>).__topic === "string" &&
		"__data" in value
	);
}

/**
 * Manages per-topic subscriptions and dispatches incoming messages
 * to the matching handlers.
 *
 * Designed for use inside Room and HybridConnection so that
 * callers can filter messages by topic without manual switching logic.
 */
export class TopicManager {
	private readonly _handlers = new Map<string, Set<TopicHandler>>();
	private readonly _globalHandlers = new Set<TopicHandler>();

	/** Subscribe to a specific topic. Returns an unsubscribe function. */
	subscribe(topic: string, handler: TopicHandler): () => void {
		if (!this._handlers.has(topic)) {
			this._handlers.set(topic, new Set());
		}
		this._handlers.get(topic)!.add(handler);

		return () => {
			this._handlers.get(topic)?.delete(handler);
		};
	}

	/** Subscribe to ALL topics (including un-topiced messages). Returns an unsubscribe function. */
	subscribeAll(handler: TopicHandler): () => void {
		this._globalHandlers.add(handler);

		return () => {
			this._globalHandlers.delete(handler);
		};
	}

	/**
	 * Dispatch a message to the appropriate handlers.
	 *
	 * @returns `true` if at least one handler was invoked, `false` otherwise.
	 */
	dispatch(topic: string | undefined, data: unknown, peerId: string): boolean {
		let handled = false;

		if (topic !== undefined && this._handlers.has(topic)) {
			for (const handler of this._handlers.get(topic)!) {
				handler(data, peerId);
				handled = true;
			}
		}

		for (const handler of this._globalHandlers) {
			handler(data, peerId);
			handled = true;
		}

		return handled;
	}

	/** Remove all subscriptions. */
	clear(): void {
		this._handlers.clear();
		this._globalHandlers.clear();
	}
}
