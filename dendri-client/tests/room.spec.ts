import { EventEmitter } from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { electNewHost } from "../src/hostmigration";
import { Room } from "../src/room";

// ---------------------------------------------------------------------------
// electNewHost — pure function tests
// ---------------------------------------------------------------------------
describe("electNewHost", () => {
	it("returns the lowest alphabetical ID among all candidates", () => {
		expect(electNewHost("charlie", ["alice", "bob"])).toBe("alice");
	});

	it("returns self when self is the lowest ID", () => {
		expect(electNewHost("alice", ["bob", "charlie"])).toBe("alice");
	});

	it("handles single peer (self becomes host)", () => {
		expect(electNewHost("only-peer", [])).toBe("only-peer");
	});

	it("is deterministic regardless of input order", () => {
		const result1 = electNewHost("charlie", ["bob", "alice"]);
		const result2 = electNewHost("charlie", ["alice", "bob"]);
		expect(result1).toBe(result2);
		expect(result1).toBe("alice");
	});

	it("handles numeric-style string IDs correctly", () => {
		// Alphabetical sort: "1" < "10" < "2" < "9"
		expect(electNewHost("9", ["2", "10", "1"])).toBe("1");
	});

	it("handles IDs with mixed case", () => {
		// Uppercase letters sort before lowercase in standard sort
		expect(electNewHost("bob", ["Alice", "charlie"])).toBe("Alice");
	});
});

// ---------------------------------------------------------------------------
// Mock Dendri peer for Room tests
// ---------------------------------------------------------------------------

/** Minimal mock DataConnection */
function createMockConn(peerId: string): DataConnection {
	const emitter = new EventEmitter();
	return {
		peer: peerId,
		open: true,
		send: vi.fn(),
		close: vi.fn(),
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		once: emitter.once.bind(emitter),
		emit: emitter.emit.bind(emitter),
		removeAllListeners: emitter.removeAllListeners.bind(emitter),
	} as unknown as DataConnection;
}

/** Minimal mock Dendri peer */
function createMockDendri(id: string) {
	const emitter = new EventEmitter();
	const peer = {
		id,
		open: true,
		destroyed: false,
		disconnected: false,
		options: {},
		connect: vi.fn(),
		destroy: vi.fn(() => {
			peer.destroyed = true;
		}),
		joinRoom: vi.fn(),
		socket: { send: vi.fn() },
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		once: emitter.once.bind(emitter),
		emit: emitter.emit.bind(emitter),
		removeAllListeners: emitter.removeAllListeners.bind(emitter),
	};
	return peer;
}

// ---------------------------------------------------------------------------
// Room class tests
// ---------------------------------------------------------------------------
describe("Room", () => {
	let room: Room;

	beforeEach(() => {
		room = new Room("test-room");
	});

	afterEach(() => {
		room.leave();
	});

	it("has correct initial state", () => {
		expect(room.isHost).toBe(false);
		expect(room.hostId).toBeNull();
		expect(room.peers).toEqual([]);
		expect(room.peerCount).toBe(0);
		expect(room.peerId).toBeNull();
	});

	it("emits joined event when becoming host", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			// Mock constructor that returns our fake peer and immediately triggers open
			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", (peerId, isHost) => {
				expect(peerId).toBe("test-room");
				expect(isHost).toBe(true);
				expect(room.isHost).toBe(true);
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("falls back to client when host ID is taken", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-abc");

			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation((id: string) => {
				callCount++;
				if (callCount === 1) {
					// First call: trying to be host, ID taken
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				// Second call: joining as client (server-assigned ID)
				setTimeout(() => clientPeer.emit("open", "client-abc"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			room.on("joined", (peerId, isHost) => {
				expect(isHost).toBe(false);
				expect(peerId).toBe("client-abc");
				expect(room.isHost).toBe(false);
				expect(room.hostId).toBe("test-room");
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });

			// Need to trigger the conn open after join flow completes
			setTimeout(() => mockConn.emit("open"), 10);
		}));

	it("broadcasts to all connections when host", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				// Simulate two peers connecting
				const conn1 = createMockConn("peer-1");
				const conn2 = createMockConn("peer-2");

				// Trigger the host's "connection" event
				mockPeer.emit("connection", conn1);
				mockPeer.emit("connection", conn2);

				// Simulate open events
				conn1.emit("open");
				conn2.emit("open");

				// Broadcast
				room.broadcast({ cursor: [10, 20] });

				expect(conn1.send).toHaveBeenCalledWith({ cursor: [10, 20] });
				expect(conn2.send).toHaveBeenCalledWith({ cursor: [10, 20] });
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("sends to host when client broadcasts", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-xyz");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				setTimeout(() => clientPeer.emit("open", "client-xyz"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			room.on("joined", () => {
				// Open the WebRTC connection first, then broadcast.
				mockConn.emit("open");
				room.broadcast({ hello: "world" });
				expect(mockConn.send).toHaveBeenCalledWith({ hello: "world" });
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("emits peerJoined when a new connection opens (host mode)", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				room.on("peerJoined", (peerId) => {
					expect(peerId).toBe("new-peer");
					expect(room.peerCount).toBe(1);
					expect(room.peers).toContain("new-peer");
					resolve();
				});

				const conn = createMockConn("new-peer");
				mockPeer.emit("connection", conn);
				conn.emit("open");
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("emits peerLeft when a connection closes (host mode)", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn = createMockConn("leaving-peer");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				room.on("peerLeft", (peerId) => {
					expect(peerId).toBe("leaving-peer");
					expect(room.peerCount).toBe(0);
					resolve();
				});

				conn.emit("close");
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("emits data event when receiving data from a peer (host mode)", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn = createMockConn("sender");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				room.on("data", (peerId, data) => {
					expect(peerId).toBe("sender");
					expect(data).toEqual({ msg: "hello" });
					resolve();
				});

				conn.emit("data", { msg: "hello" });
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("relays data from one peer to all others when host", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn1 = createMockConn("peer-a");
				const conn2 = createMockConn("peer-b");

				mockPeer.emit("connection", conn1);
				mockPeer.emit("connection", conn2);
				conn1.emit("open");
				conn2.emit("open");

				// peer-a sends data; it should be relayed to peer-b but not back to peer-a
				room.on("data", () => {
					expect(conn2.send).toHaveBeenCalledWith({ payload: 42 });
					// conn1 should NOT receive the relay (it's the sender)
					expect(conn1.send).not.toHaveBeenCalledWith({ payload: 42 });
					resolve();
				});

				conn1.emit("data", { payload: 42 });
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("host sends peer-joined notification to existing clients when new peer joins", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn1 = createMockConn("client-1");
				const conn2 = createMockConn("client-2");

				mockPeer.emit("connection", conn1);
				conn1.emit("open");

				// Clear previous calls (peer-list sent to client-1)
				(conn1.send as ReturnType<typeof vi.fn>).mockClear();

				// Now client-2 joins
				mockPeer.emit("connection", conn2);
				conn2.emit("open");

				// client-1 should have received a peer-joined notification about client-2
				expect(conn1.send).toHaveBeenCalledWith({
					__room: { type: "peer-joined", peerId: "client-2" },
				});
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("host sends peer-left notification to remaining clients when peer leaves", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn1 = createMockConn("client-1");
				const conn2 = createMockConn("client-2");

				mockPeer.emit("connection", conn1);
				mockPeer.emit("connection", conn2);
				conn1.emit("open");
				conn2.emit("open");

				(conn1.send as ReturnType<typeof vi.fn>).mockClear();

				// client-2 disconnects
				conn2.emit("close");

				// client-1 should be notified about client-2 leaving
				expect(conn1.send).toHaveBeenCalledWith({
					__room: { type: "peer-left", peerId: "client-2" },
				});
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("client updates peers when receiving peer-joined protocol message", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-1");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				setTimeout(() => clientPeer.emit("open", "client-1"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			room.on("joined", () => {
				// Initially only the host is known
				expect(room.peerCount).toBe(1);
				expect(room.peers).toEqual(["test-room"]);

				room.on("peerJoined", (peerId) => {
					expect(peerId).toBe("client-2");
					expect(room.peerCount).toBe(2);
					expect(room.peers).toContain("test-room");
					expect(room.peers).toContain("client-2");
					resolve();
				});

				// Simulate receiving peer-joined from the host via data channel
				mockConn.emit("data", {
					__room: { type: "peer-joined", peerId: "client-2" },
				});
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("client updates peers when receiving peer-left protocol message", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-1");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				setTimeout(() => clientPeer.emit("open", "client-1"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			room.on("joined", () => {
				// First simulate client-2 joining (via peer-joined)
				mockConn.emit("data", {
					__room: { type: "peer-joined", peerId: "client-2" },
				});
				expect(room.peerCount).toBe(2);

				room.on("peerLeft", (peerId) => {
					expect(peerId).toBe("client-2");
					expect(room.peerCount).toBe(1);
					expect(room.peers).toEqual(["test-room"]);
					resolve();
				});

				// Now simulate client-2 leaving
				mockConn.emit("data", {
					__room: { type: "peer-left", peerId: "client-2" },
				});
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("client updates peers from initial peer-list", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-3");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				setTimeout(() => clientPeer.emit("open", "client-3"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			let peerJoinedCount = 0;
			room.on("joined", () => {
				room.on("peerJoined", () => {
					peerJoinedCount++;
				});

				// Simulate receiving peer-list from host with 2 other clients
				mockConn.emit("data", {
					__room: {
						type: "peer-list",
						peers: ["client-1", "client-2", "client-3"],
					},
				});

				// client-3 is self → filtered out. client-1 and client-2 are new.
				expect(peerJoinedCount).toBe(2);
				expect(room.peerCount).toBe(3); // host + client-1 + client-2
				expect(room.peers).toContain("test-room");
				expect(room.peers).toContain("client-1");
				expect(room.peers).toContain("client-2");
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("emits error when trying to join twice", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				room.on("error", (err) => {
					expect(err.message).toContain("Already joined");
					resolve();
				});

				room.join(MockDendri as any, { host: "localhost", port: 9000 });
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("cleans up on leave", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				room.leave();
				expect(room.isHost).toBe(false);
				expect(room.hostId).toBeNull();
				expect(room.peers).toEqual([]);
				expect(room.peerId).toBeNull();
				expect(mockPeer.destroy).toHaveBeenCalled();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("emits hostChanged when host disconnects (client mode)", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-aaa");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				if (callCount === 2) {
					setTimeout(() => clientPeer.emit("open", "client-aaa"), 0);
					return clientPeer;
				}
				// Third call: becoming the new host after migration
				const newHostPeer = createMockDendri("test-room");
				setTimeout(() => newHostPeer.emit("open", "test-room"), 0);
				return newHostPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			room.on("joined", () => {
				room.on("hostChanged", (newHostId) => {
					// client-aaa is the only remaining peer, so it becomes host
					expect(newHostId).toBe("client-aaa");
					resolve();
				});

				// Simulate host disconnecting
				mockConn.emit("close");
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
			setTimeout(() => mockConn.emit("open"), 10);
		}));
});

// ---------------------------------------------------------------------------
// Signaling-based peer tracking (ROOM-PEERS)
// ---------------------------------------------------------------------------
describe("Room signaling peer tracking", () => {
	let room: Room;

	beforeEach(() => {
		room = new Room("test-room");
	});

	afterEach(() => {
		room.leave();
	});

	it("updates peerCount from ROOM-PEERS when WebRTC connections are absent (host)", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				expect(room.peerCount).toBe(0);

				room.on("peerJoined", (peerId) => {
					if (peerId === "peer-b") {
						// Both peers visible via signaling even without WebRTC
						expect(room.peerCount).toBe(2);
						expect(room.peers).toContain("peer-a");
						expect(room.peers).toContain("peer-b");
						resolve();
					}
				});

				// Simulate signaling server sending ROOM-PEERS (no WebRTC needed)
				mockPeer.emit("roomPeers", "test-room", ["test-room", "peer-a", "peer-b"]);
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("does not duplicate peers already known via WebRTC (host)", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				// Peer joins via WebRTC first
				const conn = createMockConn("peer-a");
				mockPeer.emit("connection", conn);
				conn.emit("open");
				expect(room.peerCount).toBe(1);

				let extraJoinCount = 0;
				room.on("peerJoined", () => {
					extraJoinCount++;
				});

				// Now signaling sends ROOM-PEERS including peer-a
				mockPeer.emit("roomPeers", "test-room", ["test-room", "peer-a"]);

				// No duplicate peerJoined event should fire
				expect(extraJoinCount).toBe(0);
				expect(room.peerCount).toBe(1);
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("removes peers absent from ROOM-PEERS when they have no active connection", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				// Add peers via signaling
				mockPeer.emit("roomPeers", "test-room", ["test-room", "peer-a", "peer-b"]);
				expect(room.peerCount).toBe(2);

				room.on("peerLeft", (peerId) => {
					expect(peerId).toBe("peer-b");
					expect(room.peerCount).toBe(1);
					expect(room.peers).toContain("peer-a");
					expect(room.peers).not.toContain("peer-b");
					resolve();
				});

				// Signaling now says peer-b is gone
				mockPeer.emit("roomPeers", "test-room", ["test-room", "peer-a"]);
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("keeps peers with active WebRTC connections even if missing from ROOM-PEERS", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				// Peer joins via WebRTC
				const conn = createMockConn("peer-a");
				mockPeer.emit("connection", conn);
				conn.emit("open");
				expect(room.peerCount).toBe(1);

				const peerLeftSpy = vi.fn();
				room.on("peerLeft", peerLeftSpy);

				// Signaling says peer-a is gone, but WebRTC connection is still open
				mockPeer.emit("roomPeers", "test-room", ["test-room"]);

				// peer-a should NOT be removed (active WebRTC connection overrides)
				expect(peerLeftSpy).not.toHaveBeenCalled();
				expect(room.peerCount).toBe(1);
				expect(room.peers).toContain("peer-a");
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("ignores ROOM-PEERS for other rooms", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const peerJoinedSpy = vi.fn();
				room.on("peerJoined", peerJoinedSpy);

				// ROOM-PEERS for a different room — should be ignored
				mockPeer.emit("roomPeers", "other-room", ["peer-x", "peer-y"]);

				expect(peerJoinedSpy).not.toHaveBeenCalled();
				expect(room.peerCount).toBe(0);
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("filters out self from ROOM-PEERS", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				mockPeer.emit("roomPeers", "test-room", ["test-room", "peer-a"]);

				// Only peer-a should be in knownPeers, not self (test-room)
				expect(room.peerCount).toBe(1);
				expect(room.peers).toEqual(["peer-a"]);
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("updates peerCount from ROOM-PEERS in client mode", () =>
		new Promise<void>((resolve) => {
			const hostPeer = createMockDendri("test-room");
			const clientPeer = createMockDendri("client-vpn");
			const mockConn = createMockConn("test-room");

			let callCount = 0;
			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				setTimeout(() => clientPeer.emit("open", "client-vpn"), 0);
				return clientPeer;
			});

			clientPeer.connect.mockReturnValue(mockConn);

			let joinFired = false;
			room.on("joined", () => {
				joinFired = true;
			});

			// Wait for open event + joinRoom to fire, then check signaling tracking
			setTimeout(() => {
				// Signaling sends ROOM-PEERS before WebRTC conn opens
				clientPeer.emit("roomPeers", "test-room", ["test-room", "client-vpn", "peer-other"]);

				// Even without conn.open, signaling adds peers
				expect(room.peers).toContain("test-room");
				expect(room.peers).toContain("peer-other");
				expect(room.peerCount).toBe(2);

				// Now open the conn — joined fires
				mockConn.emit("open");

				setTimeout(() => {
					expect(joinFired).toBe(true);
					resolve();
				}, 5);
			}, 15);

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));
});

// ---------------------------------------------------------------------------
// ServerMessageType.HostMigrate wire format
// ---------------------------------------------------------------------------
describe("ServerMessageType.HostMigrate", () => {
	it("has the correct wire format value", async () => {
		const { ServerMessageType } = await import("../src/enums");
		expect(ServerMessageType.HostMigrate).toBe("HOST-MIGRATE");
	});
});
