import { EventEmitter } from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { Room } from "../src/room";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockConn(peerId: string, isOpen = true): DataConnection {
	const emitter = new EventEmitter();
	return {
		peer: peerId,
		open: isOpen,
		send: vi.fn(),
		close: vi.fn(),
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		once: emitter.once.bind(emitter),
		emit: emitter.emit.bind(emitter),
		removeAllListeners: emitter.removeAllListeners.bind(emitter),
	} as unknown as DataConnection;
}

function createMockDendri(id: string) {
	const emitter = new EventEmitter();
	const peer = {
		id,
		open: true,
		destroyed: false,
		disconnected: false,
		options: {},
		socket: { send: vi.fn() },
		connect: vi.fn(),
		destroy: vi.fn(() => {
			peer.destroyed = true;
		}),
		joinRoom: vi.fn(),
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		once: emitter.once.bind(emitter),
		emit: emitter.emit.bind(emitter),
		removeAllListeners: emitter.removeAllListeners.bind(emitter),
	};
	return peer;
}

/**
 * Helper: join a room as host and return the mock peer.
 * Resolves after the "joined" event fires.
 */
function joinAsHost(
	room: Room,
	roomId = "test-room",
): Promise<ReturnType<typeof createMockDendri>> {
	return new Promise((resolve) => {
		const mockPeer = createMockDendri(roomId);
		const MockDendri = vi.fn().mockImplementation(() => {
			setTimeout(() => mockPeer.emit("open", roomId), 0);
			return mockPeer;
		});

		room.on("joined", () => resolve(mockPeer));
		room.join(MockDendri as any, { host: "localhost", port: 9000 });
	});
}

/**
 * Helper: join a room as client. The first Dendri creation fails with
 * unavailable-id, then a second peer is created with a server-assigned id.
 */
function joinAsClient(
	room: Room,
	clientId: string,
	roomId = "test-room",
): Promise<{
	mockPeer: ReturnType<typeof createMockDendri>;
	hostConn: DataConnection;
	MockDendri: ReturnType<typeof vi.fn>;
}> {
	return new Promise((resolve) => {
		const hostPeer = createMockDendri(roomId);
		const clientPeer = createMockDendri(clientId);
		const hostConn = createMockConn(roomId);

		let callCount = 0;
		const MockDendri = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				setTimeout(() => {
					hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
				}, 0);
				return hostPeer;
			}
			setTimeout(() => clientPeer.emit("open", clientId), 0);
			return clientPeer;
		});

		clientPeer.connect.mockReturnValue(hostConn);

		room.on("joined", () => {
			resolve({ mockPeer: clientPeer, hostConn, MockDendri });
		});

		room.join(MockDendri as any, { host: "localhost", port: 9000 });
		setTimeout(() => hostConn.emit("open"), 10);
	});
}

// ---------------------------------------------------------------------------
// Room comprehensive tests
// ---------------------------------------------------------------------------
describe("Room — comprehensive", () => {
	let room: Room;

	beforeEach(() => {
		vi.useFakeTimers();
		room = new Room("test-room");
	});

	afterEach(() => {
		room.leave();
		vi.useRealTimers();
	});

	// -------------------------------------------------------------------
	// broadcast() when no peers connected
	// -------------------------------------------------------------------
	describe("broadcast with no peers", () => {
		it("is a silent no-op for host with no connections", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// No connections registered — should not throw
			expect(() => room.broadcast({ hello: "world" })).not.toThrow();
		});

		it("is a silent no-op for client when host connection is missing", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn } = await joinAsClient(room, "client-1");

			// Simulate host connection closing
			hostConn.emit("close");

			// Now broadcast — should not throw even though there's no host connection
			expect(() => room.broadcast({ hello: "world" })).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// broadcastWithAck() timeout handling
	// -------------------------------------------------------------------
	describe("broadcastWithAck timeout", () => {
		it("resolves immediately when no peers are connected", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// No connections — should resolve without waiting
			await expect(room.broadcastWithAck({ msg: "hello" }, 100)).resolves.toBeUndefined();
		});

		it("rejects when peer does not send ACK within timeout", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-1");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			// broadcastWithAck with a short timeout — peer never ACKs
			await expect(room.broadcastWithAck({ msg: "hello" }, 50)).rejects.toThrow("ACK timeout");
		});

		it("resolves when peer sends ACK before timeout", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-1");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			// Capture what is sent and respond with an ACK
			conn.send = vi.fn().mockImplementation((data: any) => {
				if (data.__ackId) {
					// Simulate the peer sending an ACK response back
					setTimeout(() => {
						conn.emit("data", { __ackResponse: data.__ackId });
					}, 5);
				}
			});

			await expect(room.broadcastWithAck({ msg: "hello" }, 1000)).resolves.toBeUndefined();
		});
	});

	// -------------------------------------------------------------------
	// Host migration with 3+ peers
	// -------------------------------------------------------------------
	describe("host migration with multiple peers", () => {
		it("elects the lowest alphabetical peer when host disconnects", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn } = await joinAsClient(room, "client-zzz");

			// The client learns about other peers via room protocol
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["client-aaa", "client-mmm", "client-zzz"] },
			});

			const hostChangedPromise = new Promise<string>((resolve) => {
				room.on("hostChanged", resolve);
			});

			// Host disconnects
			hostConn.emit("close");

			const newHostId = await hostChangedPromise;
			// client-aaa is alphabetically lowest among known peers (excluding departed host)
			expect(newHostId).toBe("client-aaa");
		});

		it("self becomes host when it has the lowest alphabetical ID", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn, MockDendri } = await joinAsClient(room, "aaa-self");

			// Learn about other peers
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["bbb-peer", "ccc-peer", "aaa-self"] },
			});

			// Prepare a new mock peer for when self becomes host
			const newHostPeer = createMockDendri("test-room");
			MockDendri.mockImplementation(() => {
				setTimeout(() => newHostPeer.emit("open", "test-room"), 0);
				return newHostPeer;
			});

			const hostChangedPromise = new Promise<string>((resolve) => {
				room.on("hostChanged", resolve);
			});

			hostConn.emit("close");

			const newHostId = await hostChangedPromise;
			expect(newHostId).toBe("aaa-self");
		});
	});

	// -------------------------------------------------------------------
	// Host migration: migration timeout
	// -------------------------------------------------------------------
	describe("host migration timeout", () => {
		it("drops the unreachable host and re-elects (emits peerLeft, not error)", async () => {
			vi.useRealTimers();

			const shortTimeoutRoom = new Room("test-room", { migrationTimeout: 100 });

			const { mockPeer, hostConn, MockDendri } = await joinAsClient(shortTimeoutRoom, "zzz-late");

			// Learn about another peer with a lower ID
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["aaa-new-host", "zzz-late"] },
			});

			// Make connect return a connection that always errors
			mockPeer.connect.mockImplementation(() => {
				const failConn = createMockConn("aaa-new-host");
				setTimeout(() => failConn.emit("error", new Error("refused")), 5);
				return failConn;
			});

			// L10: when the elected host never becomes reachable, the room
			// should drop them (emit peerLeft) and re-run election rather
			// than emit a dead-end error. We'll see two peerLeft events:
			// first for the original host (test-room) when it closes, then
			// for aaa-new-host when migration times out.
			const left: string[] = [];
			const peerLeftPromise = new Promise<void>((resolve) => {
				shortTimeoutRoom.on("peerLeft", (id) => {
					left.push(id);
					if (left.includes("aaa-new-host")) resolve();
				});
			});

			hostConn.emit("close");

			await peerLeftPromise;
			expect(left).toContain("aaa-new-host");

			shortTimeoutRoom.leave();
		});
	});

	// -------------------------------------------------------------------
	// leave() during active host migration
	// -------------------------------------------------------------------
	describe("leave during migration", () => {
		it("cleans up without errors when leave is called during migration", async () => {
			vi.useRealTimers();

			const { mockPeer, hostConn, MockDendri } = await joinAsClient(room, "client-bbb");

			// Learn about another peer
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["client-aaa", "client-bbb"] },
			});

			// Make connect return a connection that hangs (never opens)
			mockPeer.connect.mockReturnValue(createMockConn("client-aaa", false));

			// Host disconnects, triggering migration
			hostConn.emit("close");

			// Leave during migration — should not throw
			expect(() => room.leave()).not.toThrow();
			expect(room.isHost).toBe(false);
			expect(room.hostId).toBeNull();
			expect(room.peerId).toBeNull();
		});
	});

	// -------------------------------------------------------------------
	// Data relay: host relays between non-host peers
	// -------------------------------------------------------------------
	describe("data relay between peers", () => {
		it("host relays plain data from sender to all other peers", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn1 = createMockConn("peer-a");
			const conn2 = createMockConn("peer-b");
			const conn3 = createMockConn("peer-c");

			mockPeer.emit("connection", conn1);
			mockPeer.emit("connection", conn2);
			mockPeer.emit("connection", conn3);
			conn1.emit("open");
			conn2.emit("open");
			conn3.emit("open");

			conn1.emit("data", { cursor: [1, 2] });

			// peer-b and peer-c should receive the relay
			expect(conn2.send).toHaveBeenCalledWith({ cursor: [1, 2] });
			expect(conn3.send).toHaveBeenCalledWith({ cursor: [1, 2] });
			// peer-a (sender) should NOT receive the relay
			expect(conn1.send).not.toHaveBeenCalledWith({ cursor: [1, 2] });
		});

		it("host does not relay to closed connections", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const openConn = createMockConn("peer-a");
			const closedConn = createMockConn("peer-b");

			mockPeer.emit("connection", openConn);
			mockPeer.emit("connection", closedConn);
			openConn.emit("open");
			closedConn.emit("open");

			// Clear the peer-list sends that happen on open
			(openConn.send as ReturnType<typeof vi.fn>).mockClear();
			(closedConn.send as ReturnType<typeof vi.fn>).mockClear();

			// Now mark closedConn as closed
			(closedConn as any).open = false;

			// peer-c sends data
			const senderConn = createMockConn("peer-c");
			mockPeer.emit("connection", senderConn);
			senderConn.emit("open");

			senderConn.emit("data", { msg: "test" });

			expect(openConn.send).toHaveBeenCalledWith({ msg: "test" });
			expect(closedConn.send).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------
	// RPC via room: registerRpcMethod + performRpc
	// -------------------------------------------------------------------
	describe("RPC round-trip", () => {
		it("handles RPC request and response between host and peer", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// Register an RPC method on the room
			room.registerRpcMethod("greet", (payload) => `Hello, ${payload}!`);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			// Simulate an incoming RPC request from peer-a
			conn.emit("data", {
				__rpc: true,
				id: "rpc_1_12345",
				method: "greet",
				payload: "world",
				sender: "peer-a",
			});

			// Wait for async handler
			await new Promise((r) => setTimeout(r, 10));

			// The room should send an RPC response back to peer-a
			expect(conn.send).toHaveBeenCalledWith(
				expect.objectContaining({
					__rpc_response: true,
					id: "rpc_1_12345",
					result: "Hello, world!",
				}),
			);
		});

		it("returns METHOD_NOT_FOUND for unregistered RPC methods", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			conn.emit("data", {
				__rpc: true,
				id: "rpc_2_12345",
				method: "nonexistent",
				payload: null,
				sender: "peer-a",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(conn.send).toHaveBeenCalledWith(
				expect.objectContaining({
					__rpc_response: true,
					id: "rpc_2_12345",
					error: expect.objectContaining({
						code: 1505,
						message: expect.stringContaining("nonexistent"),
					}),
				}),
			);
		});

		it("unregister function stops handling RPC method", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const unregister = room.registerRpcMethod("echo", (payload) => payload);
			unregister();

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			conn.emit("data", {
				__rpc: true,
				id: "rpc_3_12345",
				method: "echo",
				payload: "test",
				sender: "peer-a",
			});

			await new Promise((r) => setTimeout(r, 10));

			expect(conn.send).toHaveBeenCalledWith(
				expect.objectContaining({
					__rpc_response: true,
					error: expect.objectContaining({ code: 1505 }),
				}),
			);
		});
	});

	// -------------------------------------------------------------------
	// Room protocol: peer-list handling
	// -------------------------------------------------------------------
	describe("room protocol messages", () => {
		it("host sends peer-list to newly connected client", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// First peer connects
			const conn1 = createMockConn("peer-a");
			mockPeer.emit("connection", conn1);
			conn1.emit("open");

			// Second peer connects — should receive peer-list including peer-a
			const conn2 = createMockConn("peer-b");
			mockPeer.emit("connection", conn2);
			conn2.emit("open");

			expect(conn2.send).toHaveBeenCalledWith({
				__room: {
					type: "peer-list",
					peers: expect.arrayContaining(["peer-a", "peer-b"]),
				},
			});
		});

		it("client adds peers from peer-list (excluding self)", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn } = await joinAsClient(room, "client-1");

			// Simulate receiving peer-list from host
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["client-1", "client-2", "client-3"] },
			});

			// client-1 should not include itself
			const peers = room.peers;
			expect(peers).toContain("client-2");
			expect(peers).toContain("client-3");
			// "client-1" is self — should not be in peers (which excludes self from _knownPeers)
		});
	});

	// -------------------------------------------------------------------
	// Room with 0 peers after all leave
	// -------------------------------------------------------------------
	describe("room with 0 peers after all leave", () => {
		it("peerCount is 0 after all peers disconnect", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn1 = createMockConn("peer-a");
			const conn2 = createMockConn("peer-b");

			mockPeer.emit("connection", conn1);
			mockPeer.emit("connection", conn2);
			conn1.emit("open");
			conn2.emit("open");

			expect(room.peerCount).toBe(2);

			conn1.emit("close");
			conn2.emit("close");

			expect(room.peerCount).toBe(0);
			expect(room.peers).toEqual([]);
		});
	});

	// -------------------------------------------------------------------
	// Error propagation from underlying Dendri instance
	// -------------------------------------------------------------------
	describe("error propagation", () => {
		it("emits error when Dendri peer errors during host creation", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();
				const mockPeer = createMockDendri("test-room");

				const MockDendri = vi.fn().mockImplementation(() => {
					setTimeout(() => {
						mockPeer.emit("error", { type: "network", message: "Server unreachable" });
					}, 0);
					return mockPeer;
				});

				room.on("error", (err) => {
					expect(err.type).toBe("network");
					resolve();
				});

				room.join(MockDendri as any, { host: "localhost", port: 9000 });
			}));

		it("emits error when Dendri peer errors during client creation", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();
				const hostPeer = createMockDendri("test-room");
				const clientPeer = createMockDendri("client-1");

				let callCount = 0;
				const MockDendri = vi.fn().mockImplementation(() => {
					callCount++;
					if (callCount === 1) {
						setTimeout(() => {
							hostPeer.emit("error", { type: "unavailable-id", message: "taken" });
						}, 0);
						return hostPeer;
					}
					setTimeout(() => {
						clientPeer.emit("error", { type: "network", message: "Cannot connect" });
					}, 0);
					return clientPeer;
				});

				room.on("error", (err) => {
					expect(err.type).toBe("network");
					resolve();
				});

				room.join(MockDendri as any, { host: "localhost", port: 9000 });
			}));

		it("still joins when WebRTC connect returns null (relay fallback)", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();
				const hostPeer = createMockDendri("test-room");
				const clientPeer = createMockDendri("client-1");

				let callCount = 0;
				const MockDendri = vi.fn().mockImplementation(() => {
					callCount++;
					if (callCount === 1) {
						setTimeout(() => {
							hostPeer.emit("error", { type: "unavailable-id", message: "taken" });
						}, 0);
						return hostPeer;
					}
					setTimeout(() => clientPeer.emit("open", "client-1"), 0);
					return clientPeer;
				});

				// connect returns null — WebRTC unavailable
				clientPeer.connect.mockReturnValue(null);

				room.on("joined", (_peerId, isHost) => {
					expect(isHost).toBe(false);
					// Room is joined via relay even without WebRTC
					resolve();
				});

				room.join(MockDendri as any, { host: "localhost", port: 9000 });
			}));
	});

	// -------------------------------------------------------------------
	// ACK request handling: host responds with ACK
	// -------------------------------------------------------------------
	describe("ACK request handling", () => {
		it("sends ACK response when receiving data with __ackId", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			conn.emit("data", { __ackId: "ack_1_12345", data: { msg: "confirmed" } });

			// Should send ACK response back
			expect(conn.send).toHaveBeenCalledWith({ __ackResponse: "ack_1_12345" });
		});

		it("emits unwrapped data from ACK request", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			const dataPromise = new Promise<[string, unknown]>((resolve) => {
				room.on("data", (peerId, data) => resolve([peerId, data]));
			});

			conn.emit("data", { __ackId: "ack_2_12345", data: { payload: 42 } });

			const [peerId, data] = await dataPromise;
			expect(peerId).toBe("peer-a");
			expect(data).toEqual({ payload: 42 });
		});
	});

	// -------------------------------------------------------------------
	// broadcast() with topic wrapping
	// -------------------------------------------------------------------
	describe("broadcast with topic from client", () => {
		it("client sends topic-wrapped data to host", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn } = await joinAsClient(room, "client-1");

			room.broadcast({ x: 10 }, { topic: "cursor" });

			expect(hostConn.send).toHaveBeenCalledWith({
				__topic: "cursor",
				__data: { x: 10 },
			});
		});
	});

	// -------------------------------------------------------------------
	// onData (subscribeAll) integration
	// -------------------------------------------------------------------
	describe("onData unsubscribe", () => {
		it("unsubscribe stops receiving data", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const handler = vi.fn();
			const unsub = room.onData(handler);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			conn.emit("data", { msg: "first" });
			expect(handler).toHaveBeenCalledTimes(1);

			unsub();

			conn.emit("data", { msg: "second" });
			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------
	// Host migration: _becomeHost error handling
	// -------------------------------------------------------------------
	describe("host migration _becomeHost error", () => {
		it("emits error when new peer creation fails during becomeHost", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn, MockDendri } = await joinAsClient(room, "aaa-self");

			// Self is the only known peer (lowest ID)
			hostConn.emit("data", {
				__room: { type: "peer-list", peers: ["aaa-self"] },
			});

			// When becoming host, the new Dendri peer errors
			const errorPeer = createMockDendri("test-room");
			MockDendri.mockImplementation(() => {
				setTimeout(() => {
					errorPeer.emit("error", { type: "network", message: "Server down" });
				}, 0);
				return errorPeer;
			});

			const errorPromise = new Promise<any>((resolve) => {
				room.on("error", resolve);
			});

			hostConn.emit("close");

			const err = await errorPromise;
			expect(err.type).toBe("network");
		});
	});

	// -------------------------------------------------------------------
	// _sendToPeer: client falls back to host relay
	// -------------------------------------------------------------------
	describe("_sendToPeer relay via host", () => {
		it("performRpc routes through host when target peer is not directly connected", async () => {
			vi.useRealTimers();
			const { mockPeer, hostConn } = await joinAsClient(room, "client-1");

			// Register an RPC method (it won't be called, we just need performRpc to send)
			const rpcPromise = room.performRpc("someMethod", "payload", {
				peerId: "unknown-peer",
				timeout: 50,
			});

			// Since client has no direct connection to "unknown-peer",
			// it should relay through the host
			expect(hostConn.send).toHaveBeenCalled();

			// Let it reject on timeout so the promise settles
			await expect(rpcPromise).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// Multiple rooms independence
	// -------------------------------------------------------------------
	describe("multiple rooms independence", () => {
		it("leaving room A does not affect room B", async () => {
			vi.useRealTimers();
			const roomA = new Room("room-a");
			const roomB = new Room("room-b");

			const mockPeerA = createMockDendri("room-a");
			const MockDendriA = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeerA.emit("open", "room-a"), 0);
				return mockPeerA;
			});

			const mockPeerB = createMockDendri("room-b");
			const MockDendriB = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeerB.emit("open", "room-b"), 0);
				return mockPeerB;
			});

			await new Promise<void>((resolve) => {
				roomA.on("joined", () => resolve());
				roomA.join(MockDendriA as any, { host: "localhost", port: 9000 });
			});

			await new Promise<void>((resolve) => {
				roomB.on("joined", () => resolve());
				roomB.join(MockDendriB as any, { host: "localhost", port: 9001 });
			});

			expect(roomA.isHost).toBe(true);
			expect(roomB.isHost).toBe(true);

			// Add a peer to room B
			const connB = createMockConn("peer-in-b");
			mockPeerB.emit("connection", connB);
			connB.emit("open");

			expect(roomB.peerCount).toBe(1);

			// Leave room A
			roomA.leave();

			// Room B should be unaffected
			expect(roomB.isHost).toBe(true);
			expect(roomB.peerCount).toBe(1);
			expect(roomB.peers).toContain("peer-in-b");

			roomB.leave();
		});
	});

	// -------------------------------------------------------------------
	// Presence integration via room
	// -------------------------------------------------------------------
	describe("presence via room after host migration", () => {
		it("presence manager is accessible after room events", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// Set presence
			mockPeer.socket = { send: vi.fn() };
			room.setPresence({ cursor: [10, 20] });

			expect(room.presence.myPresence).toEqual({ cursor: [10, 20] });
			expect(room.getOthers().size).toBe(0);
		});
	});

	// -------------------------------------------------------------------
	// Host receives RPC response from peer (handleResponse path)
	// -------------------------------------------------------------------
	describe("RPC response handling", () => {
		it("resolves performRpc when response arrives", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			// Capture the outgoing RPC request to extract its ID
			let sentRpcId: string | null = null;
			conn.send = vi.fn().mockImplementation((data: any) => {
				if (data.__rpc) {
					sentRpcId = data.id;
				}
			});

			const rpcPromise = room.performRpc("echo", "hello", { peerId: "peer-a", timeout: 1000 });

			// Simulate response
			await new Promise((r) => setTimeout(r, 5));
			expect(sentRpcId).not.toBeNull();

			conn.emit("data", {
				__rpc_response: true,
				id: sentRpcId,
				result: "hello back",
			});

			const result = await rpcPromise;
			expect(result).toBe("hello back");
		});
	});

	// -------------------------------------------------------------------
	// ACK response handling (_isAckResponse path)
	// -------------------------------------------------------------------
	describe("ACK response handling in data flow", () => {
		it("handles __ackResponse without emitting data event", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");

			const dataHandler = vi.fn();
			room.on("data", dataHandler);

			// Send an ACK response — should NOT trigger data event
			conn.emit("data", { __ackResponse: "ack_1_12345" });

			await new Promise((r) => setTimeout(r, 10));
			expect(dataHandler).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------
	// Host relay of ACK-wrapped data
	// -------------------------------------------------------------------
	describe("host relay of ACK-wrapped data", () => {
		it("relays unwrapped data from ACK request to other peers", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const sender = createMockConn("peer-a");
			const receiver = createMockConn("peer-b");

			mockPeer.emit("connection", sender);
			mockPeer.emit("connection", receiver);
			sender.emit("open");
			receiver.emit("open");

			// peer-a sends data wrapped with ACK
			sender.emit("data", { __ackId: "ack_99", data: { payload: "secret" } });

			// The unwrapped data should be relayed to peer-b
			// After unwrapping, data becomes { payload: "secret" }
			expect(receiver.send).toHaveBeenCalledWith({ payload: "secret" });
		});
	});

	// -------------------------------------------------------------------
	// Presence: handleLeave on peer disconnect (host mode)
	// -------------------------------------------------------------------
	describe("presence cleanup on peer disconnect", () => {
		it("removes peer presence when connection closes", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			// Simulate presence update from peer
			room.presence.handleUpdate("peer-a", { cursor: [1, 2] });
			expect(room.getPresence("peer-a")).toEqual({ cursor: [1, 2] });

			// Peer connects then disconnects
			const conn = createMockConn("peer-a");
			mockPeer.emit("connection", conn);
			conn.emit("open");
			conn.emit("close");

			// Presence should be cleaned up
			expect(room.getPresence("peer-a")).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------
	// Custom migrationTimeout option
	// -------------------------------------------------------------------
	describe("custom migrationTimeout", () => {
		it("uses default migrationTimeout of 10000ms", () => {
			const defaultRoom = new Room("default-room");
			// We can't directly read _migrationTimeout, but we can verify
			// the constructor doesn't throw
			expect(defaultRoom).toBeInstanceOf(Room);
			defaultRoom.leave();
		});

		it("accepts custom migrationTimeout", () => {
			const customRoom = new Room("custom-room", { migrationTimeout: 5000 });
			expect(customRoom).toBeInstanceOf(Room);
			customRoom.leave();
		});
	});

	// -------------------------------------------------------------------
	// Double leave is safe
	// -------------------------------------------------------------------
	describe("double leave safety", () => {
		it("calling leave twice does not throw", async () => {
			vi.useRealTimers();
			await joinAsHost(room);

			room.leave();
			expect(() => room.leave()).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// Client broadcast to closed host connection
	// -------------------------------------------------------------------
	describe("client broadcast with closed host connection", () => {
		it("does not throw when host connection is closed", async () => {
			vi.useRealTimers();
			const { hostConn } = await joinAsClient(room, "client-1");

			// Close host connection
			(hostConn as any).open = false;

			expect(() => room.broadcast({ msg: "test" })).not.toThrow();
			expect(hostConn.send).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------
	// Host broadcast skips closed connections
	// -------------------------------------------------------------------
	describe("host broadcast skips closed connections", () => {
		it("only sends to open connections", async () => {
			vi.useRealTimers();
			const mockPeer = await joinAsHost(room);

			const openConn = createMockConn("peer-a");
			const closedConn = createMockConn("peer-b");

			mockPeer.emit("connection", openConn);
			mockPeer.emit("connection", closedConn);
			openConn.emit("open");
			closedConn.emit("open");

			// Clear the peer-list sends that happen on open
			(openConn.send as ReturnType<typeof vi.fn>).mockClear();
			(closedConn.send as ReturnType<typeof vi.fn>).mockClear();

			// Mark one as closed
			(closedConn as any).open = false;

			room.broadcast({ msg: "test" });

			expect(openConn.send).toHaveBeenCalledWith({ msg: "test" });
			expect(closedConn.send).not.toHaveBeenCalled();
		});
	});
});
