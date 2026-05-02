import { EventEmitter } from "eventemitter3";

export interface PresenceEvents<T> {
	update: (peerId: string, data: T) => void;
	join: (peerId: string, data: T) => void;
	leave: (peerId: string) => void;
	sync: (presences: ReadonlyMap<string, T>) => void;
}

/**
 * Manages per-peer presence state for a room.
 *
 * Each peer can set arbitrary typed state that is broadcast to all room
 * members. Incoming updates are stored and exposed via getters; lifecycle
 * events (join, update, leave, sync) are emitted for subscribers.
 */
export class PresenceManager<T = Record<string, unknown>> extends EventEmitter<PresenceEvents<T>> {
	private readonly _presences = new Map<string, T>();
	private _myPresence: T | null = null;
	private _myPeerId: string | null = null;

	/** Set (or merge) my own presence data. */
	setMyPresence(data: Partial<T>): void {
		this._myPresence = {
			...((this._myPresence ?? {}) as T),
			...data,
		} as T;

		if (this._myPeerId) {
			this._presences.set(this._myPeerId, this._myPresence);
			this.emit("update", this._myPeerId, this._myPresence);
		}
	}

	/** Get a specific peer's presence. */
	getPresence(peerId: string): T | undefined {
		return this._presences.get(peerId);
	}

	/** Get all presences excluding this peer. */
	getOthers(): Map<string, T> {
		const others = new Map(this._presences);
		if (this._myPeerId) {
			others.delete(this._myPeerId);
		}
		return others;
	}

	/** Get all presences (including self). */
	getAll(): Map<string, T> {
		return new Map(this._presences);
	}

	/** Handle an incoming presence update from a remote peer. */
	handleUpdate(peerId: string, data: T): void {
		const isNew = !this._presences.has(peerId);
		this._presences.set(peerId, data);

		if (isNew) {
			this.emit("join", peerId, data);
		}
		this.emit("update", peerId, data);
	}

	/** Handle a peer leaving — remove their presence. */
	handleLeave(peerId: string): void {
		if (this._presences.has(peerId)) {
			this._presences.delete(peerId);
			this.emit("leave", peerId);
		}
	}

	/** Set this peer's ID (called by Room on join). */
	setMyPeerId(id: string): void {
		this._myPeerId = id;
	}

	/** Clear all presences and local state. */
	clear(): void {
		this._presences.clear();
		this._myPresence = null;
		this._myPeerId = null;
	}

	/** The local peer's current presence, or null if not yet set. */
	get myPresence(): T | null {
		return this._myPresence;
	}

	/** Number of tracked presences (including self if set). */
	get size(): number {
		return this._presences.size;
	}
}
