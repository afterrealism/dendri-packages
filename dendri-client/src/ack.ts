/**
 * ACK-based message delivery confirmation manager.
 *
 * Tracks outgoing messages that expect an acknowledgement and resolves/rejects
 * the corresponding promise when the ACK arrives or the timeout fires.
 */

interface PendingAck {
	readonly resolve: () => void;
	readonly reject: (err: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	/** Optional peer tag so per-peer disconnects can reject only their ACKs. */
	readonly peerId?: string;
}

export class AckManager {
	private readonly _pending = new Map<string, PendingAck>();
	private _counter = 0;

	/** Generate a unique ack ID. */
	nextId(): string {
		return `ack_${++this._counter}_${Date.now()}`;
	}

	/**
	 * Register a pending ACK with timeout. When `peerId` is supplied, the
	 * ACK can be rejected early by {@link rejectAllForPeer} when that peer
	 * disconnects, so callers don't wait out the full timeout after the
	 * transport layer already knows the target is gone.
	 */
	waitForAck(ackId: string, timeoutMs: number = 5000, peerId?: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(ackId);
				reject(new Error(`ACK timeout for ${ackId}`));
			}, timeoutMs);

			this._pending.set(ackId, { resolve, reject, timer, peerId });
		});
	}

	/** Handle an incoming ACK message. Returns true if the ackId was pending. */
	handleAck(ackId: string): boolean {
		const pending = this._pending.get(ackId);

		if (pending) {
			clearTimeout(pending.timer);
			pending.resolve();
			this._pending.delete(ackId);
			return true;
		}

		return false;
	}

	/**
	 * Reject every pending ACK whose `peerId` matches. Called from the
	 * close path of a per-peer connection so broadcastWithAck promises
	 * resolve with a clear error immediately instead of stalling until
	 * the timeout.
	 */
	rejectAllForPeer(peerId: string): number {
		let rejected = 0;
		for (const [ackId, pending] of this._pending) {
			if (pending.peerId === peerId) {
				clearTimeout(pending.timer);
				pending.reject(new Error(`Peer ${peerId} disconnected`));
				this._pending.delete(ackId);
				rejected++;
			}
		}
		return rejected;
	}

	/** Clean up all pending ACKs (e.g. on disconnect). */
	clear(): void {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Connection closed"));
		}
		this._pending.clear();
	}

	/** Number of ACKs currently awaiting confirmation. */
	get pendingCount(): number {
		return this._pending.size;
	}
}
