import { EventEmitter } from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { ConnectionState } from "../src/enums";
import { createDendriStore, type DendriStore, type DendriStoreOptions } from "../src/store";

// ---------------------------------------------------------------------------
// Mocks (reused from room.spec.ts patterns)
// ---------------------------------------------------------------------------

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

function createMockDendri(id: string) {
	const emitter = new EventEmitter();
	const peer = {
		id,
		open: true,
		destroyed: false,
		disconnected: false,
		options: {},
		socket: null,
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
 * Create a MockDendri constructor that immediately becomes host.
 * Returns both the constructor and a reference to the created mock peer.
 */
function createHostMockCtor() {
	const mockPeer = createMockDendri("test-room");
	const MockDendri = vi.fn().mockImplementation(() => {
		setTimeout(() => mockPeer.emit("open", "test-room"), 0);
		return mockPeer;
	});
	return { MockDendri, mockPeer };
}

/**
 * Create a MockDendri constructor that falls back to client mode
 * (first call: unavailable-id, second call: client opens).
 */
function createClientMockCtor(clientId: string) {
	const hostPeer = createMockDendri("test-room");
	const clientPeer = createMockDendri(clientId);
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
		setTimeout(() => clientPeer.emit("open", clientId), 0);
		return clientPeer;
	});

	clientPeer.connect.mockReturnValue(mockConn);

	return { MockDendri, hostPeer, clientPeer, mockConn };
}

function defaultOptions(MockDendri: unknown): DendriStoreOptions {
	return {
		DendriCtor: MockDendri as any,
		dendriOptions: { host: "localhost", port: 9000, secure: false, path: "/" },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDendriStore", () => {
	let store: DendriStore;

	afterEach(() => {
		store?.destroy();
	});

	// -----------------------------------------------------------------------
	// Initial state
	// -----------------------------------------------------------------------

	it("returns correct initial state", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		expect(store.connectionState).toBe(ConnectionState.Initialized);
		expect(store.isHost).toBe(false);
		expect(store.myPeerId).toBeNull();
		expect(store.hostId).toBeNull();
		expect(store.peers).toEqual([]);
		expect(store.peerCount).toBe(0);
		expect(store.presences).toEqual(new Map());
	});

	it("getSnapshot returns consistent initial snapshot", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const snap = store.getSnapshot();
		expect(snap.connectionState).toBe(ConnectionState.Initialized);
		expect(snap.isHost).toBe(false);
		expect(snap.myPeerId).toBeNull();
		expect(snap.hostId).toBeNull();
		expect(snap.peers).toEqual([]);
		expect(snap.peerCount).toBe(0);
		expect(snap.presences).toEqual(new Map());
	});

	// -----------------------------------------------------------------------
	// join() — host path
	// -----------------------------------------------------------------------

	it("join() sets connectionState to Connecting immediately", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		store.join("test-room");
		expect(store.connectionState).toBe(ConnectionState.Connecting);
	});

	it("join() updates state when becoming host", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			const listener = vi.fn();
			store.subscribe(listener);

			store.join("test-room");

			// Wait for async "open" event
			setTimeout(() => {
				expect(store.connectionState).toBe(ConnectionState.Connected);
				expect(store.isHost).toBe(true);
				expect(store.myPeerId).toBe("test-room");
				expect(store.hostId).toBe("test-room");
				// listener called: once for Connecting, once for Connected
				expect(listener).toHaveBeenCalledTimes(2);
				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// join() — client path
	// -----------------------------------------------------------------------

	it("join() updates state when joining as client", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockConn } = createClientMockCtor("client-abc");
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				mockConn.emit("open");

				setTimeout(() => {
					expect(store.connectionState).toBe(ConnectionState.Connected);
					expect(store.isHost).toBe(false);
					expect(store.myPeerId).toBe("client-abc");
					expect(store.hostId).toBe("test-room");
					resolve();
				}, 20);
			}, 10);
		}));

	// -----------------------------------------------------------------------
	// leave()
	// -----------------------------------------------------------------------

	it("leave() resets state and notifies listeners", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const listener = vi.fn();
				store.subscribe(listener);

				store.leave();

				expect(store.connectionState).toBe(ConnectionState.Closed);
				expect(store.isHost).toBe(false);
				expect(store.myPeerId).toBeNull();
				expect(store.hostId).toBeNull();
				expect(store.peers).toEqual([]);
				expect(store.peerCount).toBe(0);
				expect(store.presences).toEqual(new Map());
				expect(listener).toHaveBeenCalledTimes(1);
				resolve();
			}, 20);
		}));

	it("leave() is safe to call when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		// Should not throw
		store.leave();
		expect(store.connectionState).toBe(ConnectionState.Closed);
	});

	// -----------------------------------------------------------------------
	// broadcast()
	// -----------------------------------------------------------------------

	it("broadcast() delegates to room", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				store.broadcast({ cursor: [10, 20] });
				expect(conn.send).toHaveBeenCalledWith({ cursor: [10, 20] });
				resolve();
			}, 20);
		}));

	it("broadcast() with topic wraps in envelope", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				store.broadcast({ x: 1 }, { topic: "cursor" });
				expect(conn.send).toHaveBeenCalledWith({
					__topic: "cursor",
					__data: { x: 1 },
				});
				resolve();
			}, 20);
		}));

	it("broadcast() is safe to call when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		// Should not throw
		store.broadcast({ data: "test" });
	});

	// -----------------------------------------------------------------------
	// broadcastWithAck()
	// -----------------------------------------------------------------------

	it("broadcastWithAck() resolves when no room is joined", async () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		// Should resolve immediately (no room = no-op)
		await store.broadcastWithAck({ data: "test" });
	});

	// -----------------------------------------------------------------------
	// setPresence()
	// -----------------------------------------------------------------------

	it("setPresence() delegates to room", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				// Should not throw; presence is set internally
				store.setPresence({ name: "Alice" });
				resolve();
			}, 20);
		}));

	it("setPresence() is safe to call when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		// Should not throw
		store.setPresence({ name: "Alice" });
	});

	// -----------------------------------------------------------------------
	// subscribe() — topic overload
	// -----------------------------------------------------------------------

	it("subscribe(topic, handler) returns unsubscribe function", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				const unsub = store.subscribe("cursor", handler);

				// Simulate receiving topic data from a peer
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("data", { __topic: "cursor", __data: { x: 5 } });

				expect(handler).toHaveBeenCalledWith({ x: 5 }, "peer-1");

				// Unsubscribe and send again
				unsub();
				conn.emit("data", { __topic: "cursor", __data: { x: 10 } });
				expect(handler).toHaveBeenCalledTimes(1);

				resolve();
			}, 20);
		}));

	it("subscribe(topic) returns no-op unsubscribe when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const handler = vi.fn();
		const unsub = store.subscribe("cursor", handler);

		expect(typeof unsub).toBe("function");
		// Should not throw
		unsub();
	});

	// -----------------------------------------------------------------------
	// subscribe() — state listener overload
	// -----------------------------------------------------------------------

	it("subscribe(listener) fires on state changes", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			const listener = vi.fn();
			const unsub = store.subscribe(listener);

			store.join("test-room");

			// Connecting state fires listener
			expect(listener).toHaveBeenCalledTimes(1);

			setTimeout(() => {
				// Connected state fires listener again
				expect(listener).toHaveBeenCalledTimes(2);

				unsub();
				store.leave();

				// After unsubscribe, listener should not be called again
				expect(listener).toHaveBeenCalledTimes(2);
				resolve();
			}, 20);
		}));

	it("subscribe(listener) returns working unsubscribe function", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const listener = vi.fn();
		const unsub = store.subscribe(listener);

		store.join("test-room");
		expect(listener).toHaveBeenCalledTimes(1);

		unsub();

		store.leave();
		// Should not be called after unsubscribe
		expect(listener).toHaveBeenCalledTimes(1);
	});

	// -----------------------------------------------------------------------
	// getSnapshot()
	// -----------------------------------------------------------------------

	it("getSnapshot() returns same reference if state has not changed", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const snap1 = store.getSnapshot();
		const snap2 = store.getSnapshot();
		expect(snap1).toBe(snap2);
	});

	it("getSnapshot() returns new reference after state change", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			const snap1 = store.getSnapshot();

			store.join("test-room");

			// After joining (Connecting), snapshot should be different
			const snap2 = store.getSnapshot();
			expect(snap1).not.toBe(snap2);
			expect(snap2.connectionState).toBe(ConnectionState.Connecting);

			setTimeout(() => {
				const snap3 = store.getSnapshot();
				expect(snap2).not.toBe(snap3);
				expect(snap3.connectionState).toBe(ConnectionState.Connected);
				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// Event callbacks
	// -----------------------------------------------------------------------

	it("onPeerJoin fires when a peer connects", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				store.onPeerJoin(handler);

				const conn = createMockConn("new-peer");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				expect(handler).toHaveBeenCalledWith("new-peer");
				expect(store.peers).toContain("new-peer");
				resolve();
			}, 20);
		}));

	it("onPeerLeave fires when a peer disconnects", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				store.onPeerLeave(handler);

				const conn = createMockConn("leaving-peer");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("close");

				expect(handler).toHaveBeenCalledWith("leaving-peer");
				resolve();
			}, 20);
		}));

	it("onData fires when data is received", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				store.onData(handler);

				const conn = createMockConn("sender");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("data", { msg: "hello" });

				expect(handler).toHaveBeenCalledWith({ msg: "hello" }, "sender");
				resolve();
			}, 20);
		}));

	it("onHostChanged fires when host changes", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockConn, clientPeer } = createClientMockCtor("client-aaa");

			// Need a third Dendri for the host migration
			let callCount = 0;
			const origImpl = (MockDendri as any).getMockImplementation?.() ?? MockDendri;
			const PatchedDendri = vi.fn().mockImplementation((id: string) => {
				callCount++;
				if (callCount <= 2) {
					return origImpl(id);
				}
				// Third call: becoming new host after migration
				const newHostPeer = createMockDendri("test-room");
				setTimeout(() => newHostPeer.emit("open", "test-room"), 0);
				return newHostPeer;
			});

			// Replicate the client mock behavior manually
			const hostPeer = createMockDendri("test-room");
			const clientPeerLocal = createMockDendri("client-aaa");
			const mockConnLocal = createMockConn("test-room");
			let localCallCount = 0;
			const FinalDendri = vi.fn().mockImplementation(() => {
				localCallCount++;
				if (localCallCount === 1) {
					setTimeout(() => {
						hostPeer.emit("error", { type: "unavailable-id", message: "ID taken" });
					}, 0);
					return hostPeer;
				}
				if (localCallCount === 2) {
					setTimeout(() => clientPeerLocal.emit("open", "client-aaa"), 0);
					return clientPeerLocal;
				}
				const newHostPeer = createMockDendri("test-room");
				setTimeout(() => newHostPeer.emit("open", "test-room"), 0);
				return newHostPeer;
			});

			clientPeerLocal.connect.mockReturnValue(mockConnLocal);

			store = createDendriStore(defaultOptions(FinalDendri));
			store.join("test-room");

			setTimeout(() => {
				mockConnLocal.emit("open");

				setTimeout(() => {
					const handler = vi.fn();
					store.onHostChanged(handler);

					// Host disconnects
					mockConnLocal.emit("close");

					expect(handler).toHaveBeenCalledWith("client-aaa");
					resolve();
				}, 20);
			}, 10);
		}));

	it("onPeerJoin unsubscribe works", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				const unsub = store.onPeerJoin(handler);

				const conn1 = createMockConn("peer-1");
				mockPeer.emit("connection", conn1);
				conn1.emit("open");

				expect(handler).toHaveBeenCalledTimes(1);

				unsub();

				const conn2 = createMockConn("peer-2");
				mockPeer.emit("connection", conn2);
				conn2.emit("open");

				// Should still be 1 after unsubscribe
				expect(handler).toHaveBeenCalledTimes(1);
				resolve();
			}, 20);
		}));

	it("onData returns no-op when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const handler = vi.fn();
		const unsub = store.onData(handler);

		expect(typeof unsub).toBe("function");
		// Should not throw
		unsub();
	});

	// -----------------------------------------------------------------------
	// destroy()
	// -----------------------------------------------------------------------

	it("destroy() cleans up everything including listeners", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			const listener = vi.fn();
			store.subscribe(listener);

			store.join("test-room");

			setTimeout(() => {
				store.destroy();

				expect(store.connectionState).toBe(ConnectionState.Closed);
				expect(store.isHost).toBe(false);
				expect(store.myPeerId).toBeNull();
				expect(store.hostId).toBeNull();
				expect(store.peers).toEqual([]);
				expect(store.presences).toEqual(new Map());

				// Listener count should be cleared (no calls after destroy)
				const callsBefore = listener.mock.calls.length;

				// Operations after destroy should not trigger listener
				// (listener set is cleared by destroy)
				// We verify getSnapshot still works after destroy
				const snap = store.getSnapshot();
				expect(snap.connectionState).toBe(ConnectionState.Closed);
				expect(listener.mock.calls.length).toBe(callsBefore);

				resolve();
			}, 20);
		}));

	it("destroy() is safe to call multiple times", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		store.destroy();
		store.destroy();
		expect(store.connectionState).toBe(ConnectionState.Closed);
	});

	// -----------------------------------------------------------------------
	// Re-join after leave
	// -----------------------------------------------------------------------

	it("can join again after leaving", () =>
		new Promise<void>((resolve) => {
			const mockPeer1 = createMockDendri("test-room");
			const mockPeer2 = createMockDendri("test-room");
			let callCount = 0;

			const MockDendri = vi.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					setTimeout(() => mockPeer1.emit("open", "test-room"), 0);
					return mockPeer1;
				}
				setTimeout(() => mockPeer2.emit("open", "test-room"), 0);
				return mockPeer2;
			});

			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				expect(store.connectionState).toBe(ConnectionState.Connected);

				store.leave();
				expect(store.connectionState).toBe(ConnectionState.Closed);

				store.join("test-room");

				setTimeout(() => {
					expect(store.connectionState).toBe(ConnectionState.Connected);
					expect(store.isHost).toBe(true);
					resolve();
				}, 20);
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// Peer tracking via state
	// -----------------------------------------------------------------------

	it("peers and peerCount update as peers join and leave", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				expect(store.peerCount).toBe(0);

				const conn1 = createMockConn("peer-a");
				mockPeer.emit("connection", conn1);
				conn1.emit("open");

				expect(store.peerCount).toBe(1);
				expect(store.peers).toContain("peer-a");

				const conn2 = createMockConn("peer-b");
				mockPeer.emit("connection", conn2);
				conn2.emit("open");

				expect(store.peerCount).toBe(2);

				conn1.emit("close");

				expect(store.peerCount).toBe(1);
				expect(store.peers).not.toContain("peer-a");
				expect(store.peers).toContain("peer-b");

				resolve();
			}, 20);
		}));

	it("client-mode peerCount updates when receiving peer-joined protocol message", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockConn } = createClientMockCtor("client-1");
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				mockConn.emit("open");

				setTimeout(() => {
					// Client initially knows only the host
					expect(store.peerCount).toBe(1);
					expect(store.peers).toEqual(["test-room"]);

					// Simulate host sending peer-joined for a new client
					mockConn.emit("data", {
						__room: { type: "peer-joined", peerId: "client-2" },
					});

					expect(store.peerCount).toBe(2);
					expect(store.peers).toContain("test-room");
					expect(store.peers).toContain("client-2");

					// Simulate another peer joining
					mockConn.emit("data", {
						__room: { type: "peer-joined", peerId: "client-3" },
					});

					expect(store.peerCount).toBe(3);

					// Simulate peer leaving
					mockConn.emit("data", {
						__room: { type: "peer-left", peerId: "client-2" },
					});

					expect(store.peerCount).toBe(2);
					expect(store.peers).not.toContain("client-2");

					resolve();
				}, 20);
			}, 20);
		}));

	it("client-mode peerCount updates from initial peer-list", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockConn } = createClientMockCtor("client-3");
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				mockConn.emit("open");

				setTimeout(() => {
					expect(store.peerCount).toBe(1); // just host

					// Simulate host sending peer-list with existing peers
					mockConn.emit("data", {
						__room: {
							type: "peer-list",
							peers: ["client-1", "client-2", "client-3"],
						},
					});

					// client-3 is self → filtered. client-1 and client-2 are new.
					expect(store.peerCount).toBe(3); // host + client-1 + client-2
					expect(store.peers).toContain("test-room");
					expect(store.peers).toContain("client-1");
					expect(store.peers).toContain("client-2");
					expect(store.peers).not.toContain("client-3"); // self excluded

					resolve();
				}, 20);
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// Error state
	// -----------------------------------------------------------------------

	it("error transitions connectionState to Failed", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");
			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => {
					mockPeer.emit("error", { type: "network", message: "Connection lost" });
				}, 0);
				return mockPeer;
			});

			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				expect(store.connectionState).toBe(ConnectionState.Failed);
				resolve();
			}, 20);
		}));
});
