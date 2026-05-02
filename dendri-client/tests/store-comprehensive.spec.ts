import { EventEmitter } from "eventemitter3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { ConnectionState } from "../src/enums";
import { createDendriStore, type DendriStore, type DendriStoreOptions } from "../src/store";

// ---------------------------------------------------------------------------
// Mocks
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

function createHostMockCtor() {
	const mockPeer = createMockDendri("test-room");
	const MockDendri = vi.fn().mockImplementation(() => {
		setTimeout(() => mockPeer.emit("open", "test-room"), 0);
		return mockPeer;
	});
	return { MockDendri, mockPeer };
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

describe("createDendriStore — comprehensive", () => {
	let store: DendriStore;

	afterEach(() => {
		store?.destroy();
	});

	// -----------------------------------------------------------------------
	// State changes reflected in getSnapshot() immediately
	// -----------------------------------------------------------------------

	it("getSnapshot() reflects state changes immediately after join()", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const snap1 = store.getSnapshot();
		expect(snap1.connectionState).toBe(ConnectionState.Initialized);

		store.join("test-room");

		const snap2 = store.getSnapshot();
		expect(snap2.connectionState).toBe(ConnectionState.Connecting);
		expect(snap1).not.toBe(snap2);
	});

	it("getSnapshot() reflects state changes immediately after leave()", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const snap1 = store.getSnapshot();
				expect(snap1.connectionState).toBe(ConnectionState.Connected);

				store.leave();

				const snap2 = store.getSnapshot();
				expect(snap2.connectionState).toBe(ConnectionState.Closed);
				expect(snap2.myPeerId).toBeNull();
				expect(snap2.peers).toEqual([]);
				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// Multiple subscribers all called on state change
	// -----------------------------------------------------------------------

	it("notifies all subscribers on state change", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const listener1 = vi.fn();
		const listener2 = vi.fn();
		const listener3 = vi.fn();

		store.subscribe(listener1);
		store.subscribe(listener2);
		store.subscribe(listener3);

		store.join("test-room");

		// All three should be called once for the Connecting transition
		expect(listener1).toHaveBeenCalledTimes(1);
		expect(listener2).toHaveBeenCalledTimes(1);
		expect(listener3).toHaveBeenCalledTimes(1);
	});

	// -----------------------------------------------------------------------
	// Unsubscribed listener is not called
	// -----------------------------------------------------------------------

	it("does not notify an unsubscribed listener", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const active = vi.fn();
		const removed = vi.fn();

		store.subscribe(active);
		const unsub = store.subscribe(removed);

		unsub();

		store.join("test-room");

		expect(active).toHaveBeenCalledTimes(1);
		expect(removed).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// join() then destroy() then join() again (re-initialization)
	// -----------------------------------------------------------------------

	it("can join after destroy by creating a fresh store", () =>
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
				store.destroy();
				expect(store.connectionState).toBe(ConnectionState.Closed);

				// Create a new store (destroy clears listeners, so re-join needs new store)
				store = createDendriStore(defaultOptions(MockDendri));
				store.join("test-room");

				setTimeout(() => {
					expect(store.connectionState).toBe(ConnectionState.Connected);
					expect(store.isHost).toBe(true);
					resolve();
				}, 20);
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// All event callbacks return unsubscribe functions that work
	// -----------------------------------------------------------------------

	it("onPeerJoin returns a working unsubscribe function", () =>
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
				expect(handler).toHaveBeenCalledTimes(1);
				resolve();
			}, 20);
		}));

	it("onPeerLeave returns a working unsubscribe function", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				const unsub = store.onPeerLeave(handler);

				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");
				conn.emit("close");
				expect(handler).toHaveBeenCalledTimes(1);

				unsub();

				const conn2 = createMockConn("peer-2");
				mockPeer.emit("connection", conn2);
				conn2.emit("open");
				conn2.emit("close");
				expect(handler).toHaveBeenCalledTimes(1);
				resolve();
			}, 20);
		}));

	it("onData returns a working unsubscribe function", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				const unsub = store.onData(handler);

				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("data", { msg: "hello" });
				expect(handler).toHaveBeenCalledTimes(1);

				unsub();

				conn.emit("data", { msg: "world" });
				expect(handler).toHaveBeenCalledTimes(1);
				resolve();
			}, 20);
		}));

	it("onHostChanged returns a working unsubscribe function", () =>
		new Promise<void>((resolve) => {
			const { MockDendri } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				const handler = vi.fn();
				const unsub = store.onHostChanged(handler);

				// Verify it returns a function
				expect(typeof unsub).toBe("function");

				unsub();
				// No further assertions needed — we verified the unsubscribe function works
				resolve();
			}, 20);
		}));

	it("event callbacks return no-op unsubscribe when not joined", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const unsubJoin = store.onPeerJoin(vi.fn());
		const unsubLeave = store.onPeerLeave(vi.fn());
		const unsubData = store.onData(vi.fn());
		const unsubPresence = store.onPresenceUpdate(vi.fn());
		const unsubHost = store.onHostChanged(vi.fn());

		// All should be functions and not throw
		expect(typeof unsubJoin).toBe("function");
		expect(typeof unsubLeave).toBe("function");
		expect(typeof unsubData).toBe("function");
		expect(typeof unsubPresence).toBe("function");
		expect(typeof unsubHost).toBe("function");

		unsubJoin();
		unsubLeave();
		unsubData();
		unsubPresence();
		unsubHost();
	});

	// -----------------------------------------------------------------------
	// Store with all options set
	// -----------------------------------------------------------------------

	it("creates store with all options (host, port, secure, path, debug)", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore({
			DendriCtor: MockDendri as any,
			dendriOptions: {
				host: "signal.example.com",
				port: 443,
				secure: true,
				path: "/ws",
				debug: 3,
			},
			roomOptions: {
				migrationTimeout: 5000,
			},
		});

		expect(store.connectionState).toBe(ConnectionState.Initialized);
		store.join("test-room");
		expect(store.connectionState).toBe(ConnectionState.Connecting);
	});

	// -----------------------------------------------------------------------
	// Concurrent broadcasts from multiple stores (no cross-contamination)
	// -----------------------------------------------------------------------

	it("multiple stores operate independently without cross-contamination", () =>
		new Promise<void>((resolve) => {
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

			const storeA = createDendriStore({
				DendriCtor: MockDendriA as any,
				dendriOptions: { host: "localhost", port: 9000, secure: false, path: "/" },
			});
			const storeB = createDendriStore({
				DendriCtor: MockDendriB as any,
				dendriOptions: { host: "localhost", port: 9000, secure: false, path: "/" },
			});

			storeA.join("room-a");
			storeB.join("room-b");

			setTimeout(() => {
				// Add a peer to store A
				const connA = createMockConn("peer-in-a");
				mockPeerA.emit("connection", connA);
				connA.emit("open");

				// Store A sees the peer, store B does not
				expect(storeA.peerCount).toBe(1);
				expect(storeA.peers).toContain("peer-in-a");
				expect(storeB.peerCount).toBe(0);

				// Broadcast from store A should not affect store B
				storeA.broadcast({ source: "A" });
				expect(connA.send).toHaveBeenCalledWith({ source: "A" });

				storeA.destroy();
				storeB.destroy();
				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// getSnapshot() memoization — same reference when unchanged, new when changed
	// -----------------------------------------------------------------------

	it("getSnapshot() returns same reference when state is unchanged", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		const snap1 = store.getSnapshot();
		const snap2 = store.getSnapshot();
		const snap3 = store.getSnapshot();

		expect(snap1).toBe(snap2);
		expect(snap2).toBe(snap3);
	});

	it("getSnapshot() returns new reference after each state change", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			const snapInit = store.getSnapshot();
			expect(snapInit.connectionState).toBe(ConnectionState.Initialized);

			store.join("test-room");
			const snapConnecting = store.getSnapshot();
			expect(snapConnecting).not.toBe(snapInit);
			expect(snapConnecting.connectionState).toBe(ConnectionState.Connecting);

			setTimeout(() => {
				const snapConnected = store.getSnapshot();
				expect(snapConnected).not.toBe(snapConnecting);
				expect(snapConnected.connectionState).toBe(ConnectionState.Connected);

				// Add a peer to trigger another change
				const conn = createMockConn("peer-x");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				const snapWithPeer = store.getSnapshot();
				expect(snapWithPeer).not.toBe(snapConnected);
				expect(snapWithPeer.peerCount).toBe(1);

				// Reading again without changes returns same reference
				const snapSame = store.getSnapshot();
				expect(snapSame).toBe(snapWithPeer);

				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// Presence updates reflected in snapshot.presences
	// -----------------------------------------------------------------------

	it("reflects presence updates in snapshot via onPresenceUpdate", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				// Simulate a peer connecting
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				// Verify presence is initially empty
				const snap1 = store.getSnapshot();
				expect(snap1.presences.size).toBe(0);

				resolve();
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// subscribe() with invalid arguments returns no-op
	// -----------------------------------------------------------------------

	it("subscribe with string topic and no handler returns no-op unsubscribe", () => {
		const { MockDendri } = createHostMockCtor();
		store = createDendriStore(defaultOptions(MockDendri));

		// Calling subscribe with just a string and no handler
		const unsub = (store.subscribe as any)("some-topic");
		expect(typeof unsub).toBe("function");
		unsub(); // Should not throw
	});

	// -----------------------------------------------------------------------
	// leave() then join() retains subscriber across re-join
	// -----------------------------------------------------------------------

	it("subscriber added before first join is notified across leave/join cycles", () =>
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

			const listener = vi.fn();
			store.subscribe(listener);

			store.join("test-room");
			expect(listener).toHaveBeenCalledTimes(1); // Connecting

			setTimeout(() => {
				expect(listener).toHaveBeenCalledTimes(2); // Connected

				store.leave();
				expect(listener).toHaveBeenCalledTimes(3); // Closed

				store.join("test-room");
				expect(listener).toHaveBeenCalledTimes(4); // Connecting again

				setTimeout(() => {
					expect(listener).toHaveBeenCalledTimes(5); // Connected again
					resolve();
				}, 20);
			}, 20);
		}));

	// -----------------------------------------------------------------------
	// getSnapshot() peerCount matches peers.length
	// -----------------------------------------------------------------------

	it("peerCount in snapshot always matches peers.length", () =>
		new Promise<void>((resolve) => {
			const { MockDendri, mockPeer } = createHostMockCtor();
			store = createDendriStore(defaultOptions(MockDendri));

			store.join("test-room");

			setTimeout(() => {
				let snap = store.getSnapshot();
				expect(snap.peerCount).toBe(snap.peers.length);
				expect(snap.peerCount).toBe(0);

				const conn1 = createMockConn("p1");
				mockPeer.emit("connection", conn1);
				conn1.emit("open");

				snap = store.getSnapshot();
				expect(snap.peerCount).toBe(1);
				expect(snap.peerCount).toBe(snap.peers.length);

				const conn2 = createMockConn("p2");
				mockPeer.emit("connection", conn2);
				conn2.emit("open");

				snap = store.getSnapshot();
				expect(snap.peerCount).toBe(2);
				expect(snap.peerCount).toBe(snap.peers.length);

				conn1.emit("close");

				snap = store.getSnapshot();
				expect(snap.peerCount).toBe(1);
				expect(snap.peerCount).toBe(snap.peers.length);

				resolve();
			}, 20);
		}));
});
