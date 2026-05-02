/**
 * Host migration utilities for star topology rooms.
 *
 * When the host disconnects, the peer with the lowest alphabetical ID
 * among all remaining peers becomes the new host. This is deterministic:
 * every peer arrives at the same answer independently.
 */

export interface HostMigrationOptions {
	readonly roomId: string;
	readonly myPeerId: string;
	readonly knownPeers: readonly string[];
	readonly onBecomeHost: () => void;
	readonly onNewHost: (hostId: string) => void;
	readonly migrationTimeout?: number;
}

/**
 * Elect a new host from the given set of peer IDs.
 * Deterministic: the lowest alphabetical ID always wins.
 *
 * @param myPeerId - The local peer's ID.
 * @param peerIds  - All other known peer IDs (excluding the departed host).
 * @returns The peer ID that should become the new host.
 */
export function electNewHost(myPeerId: string, peerIds: readonly string[]): string {
	const candidates = [...peerIds, myPeerId].sort();
	return candidates[0];
}
