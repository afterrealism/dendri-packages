import { EventEmitter } from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { PresenceManager } from "../src/presence";
import { Room } from "../src/room";

// ---------------------------------------------------------------------------
// PresenceManager unit tests
// ---------------------------------------------------------------------------

describe("PresenceManager", () => {
	let pm: PresenceManager<{ cursor: [number, number]; name?: string }>;

	beforeEach(() => {
		pm = new PresenceManager();
		pm.setMyPeerId("self");
	});

	afterEach(() => {
		pm.clear();
		pm.removeAllListeners();
	});

	it("setMyPresence stores data and emits update", () => {
		const handler = vi.fn();
		pm.on("update", handler);

		pm.setMyPresence({ cursor: [10, 20] });

		expect(pm.myPresence).toEqual({ cursor: [10, 20] });
		expect(handler).toHaveBeenCalledWith("self", { cursor: [10, 20] });
	});

	it("getPresence returns correct data for a peer", () => {
		pm.handleUpdate("alice", { cursor: [1, 2] });

		expect(pm.getPresence("alice")).toEqual({ cursor: [1, 2] });
		expect(pm.getPresence("nonexistent")).toBeUndefined();
	});

	it("getOthers excludes self", () => {
		pm.setMyPresence({ cursor: [0, 0] });
		pm.handleUpdate("alice", { cursor: [1, 1] });
		pm.handleUpdate("bob", { cursor: [2, 2] });

		const others = pm.getOthers();

		expect(others.size).toBe(2);
		expect(others.has("self")).toBe(false);
		expect(others.has("alice")).toBe(true);
		expect(others.has("bob")).toBe(true);
	});

	it("getAll includes self", () => {
		pm.setMyPresence({ cursor: [0, 0] });
		pm.handleUpdate("alice", { cursor: [1, 1] });

		const all = pm.getAll();

		expect(all.size).toBe(2);
		expect(all.has("self")).toBe(true);
		expect(all.has("alice")).toBe(true);
	});

	it("handleUpdate emits join on first update, then update on subsequent", () => {
		const joinHandler = vi.fn();
		const updateHandler = vi.fn();
		pm.on("join", joinHandler);
		pm.on("update", updateHandler);

		pm.handleUpdate("alice", { cursor: [1, 1] });

		expect(joinHandler).toHaveBeenCalledTimes(1);
		expect(joinHandler).toHaveBeenCalledWith("alice", { cursor: [1, 1] });
		expect(updateHandler).toHaveBeenCalledTimes(1);

		pm.handleUpdate("alice", { cursor: [2, 2] });

		// join should NOT fire again
		expect(joinHandler).toHaveBeenCalledTimes(1);
		// update fires again
		expect(updateHandler).toHaveBeenCalledTimes(2);
		expect(updateHandler).toHaveBeenCalledWith("alice", { cursor: [2, 2] });
	});

	it("handleLeave emits leave and removes data", () => {
		const leaveHandler = vi.fn();
		pm.on("leave", leaveHandler);

		pm.handleUpdate("alice", { cursor: [1, 1] });
		expect(pm.getPresence("alice")).toBeDefined();

		pm.handleLeave("alice");

		expect(leaveHandler).toHaveBeenCalledTimes(1);
		expect(leaveHandler).toHaveBeenCalledWith("alice");
		expect(pm.getPresence("alice")).toBeUndefined();
	});

	it("handleLeave does nothing for unknown peer", () => {
		const leaveHandler = vi.fn();
		pm.on("leave", leaveHandler);

		pm.handleLeave("unknown-peer");

		expect(leaveHandler).not.toHaveBeenCalled();
	});

	it("clear resets everything", () => {
		pm.setMyPresence({ cursor: [0, 0] });
		pm.handleUpdate("alice", { cursor: [1, 1] });

		pm.clear();

		expect(pm.myPresence).toBeNull();
		expect(pm.size).toBe(0);
		expect(pm.getPresence("alice")).toBeUndefined();
	});

	it("partial updates merge with existing presence", () => {
		pm.setMyPresence({ cursor: [10, 20] });
		pm.setMyPresence({ name: "Bob" } as any);

		expect(pm.myPresence).toEqual({ cursor: [10, 20], name: "Bob" });
	});

	it("size tracks correctly", () => {
		expect(pm.size).toBe(0);

		pm.setMyPresence({ cursor: [0, 0] });
		expect(pm.size).toBe(1);

		pm.handleUpdate("alice", { cursor: [1, 1] });
		expect(pm.size).toBe(2);

		pm.handleUpdate("bob", { cursor: [2, 2] });
		expect(pm.size).toBe(3);

		pm.handleLeave("alice");
		expect(pm.size).toBe(2);
	});

	it("setMyPresence before setMyPeerId does not crash", () => {
		const fresh = new PresenceManager();
		// No peerId set yet -- should not throw.
		fresh.setMyPresence({ cursor: [1, 2] });
		expect(fresh.myPresence).toEqual({ cursor: [1, 2] });
		// Size should be 0 because no peerId means it can't store in the map.
		expect(fresh.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Room.setPresence integration test
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

describe("Room.setPresence", () => {
	it("broadcasts PRESENCE_UPDATE message via the socket", () =>
		new Promise<void>((resolve) => {
			const room = new Room("my-room");

			const socketSend = vi.fn();
			const peerEmitter = new EventEmitter();
			const mockPeer = {
				id: "my-room",
				open: true,
				destroyed: false,
				disconnected: false,
				options: {},
				socket: { send: socketSend },
				connect: vi.fn(),
				destroy: vi.fn(),
				joinRoom: vi.fn(),
				on: peerEmitter.on.bind(peerEmitter),
				off: peerEmitter.off.bind(peerEmitter),
				once: peerEmitter.once.bind(peerEmitter),
				emit: peerEmitter.emit.bind(peerEmitter),
				removeAllListeners: peerEmitter.removeAllListeners.bind(peerEmitter),
			};

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => peerEmitter.emit("open", "my-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				room.setPresence({ cursor: [10, 20], status: "active" });

				expect(socketSend).toHaveBeenCalledTimes(1);
				const call = socketSend.mock.calls[0]![0];
				expect(call.type).toBe("PRESENCE-UPDATE");
				expect(call.room).toBe("my-room");
				expect(call.payload).toEqual({
					cursor: [10, 20],
					status: "active",
				});

				room.leave();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("exposes presence manager for event listening", () => {
		const room = new Room("my-room");
		expect(room.presence).toBeInstanceOf(PresenceManager);
		room.leave();
	});

	it("getOthers returns remote presences", () =>
		new Promise<void>((resolve) => {
			const room = new Room("my-room");

			const peerEmitter = new EventEmitter();
			const mockPeer = {
				id: "my-room",
				open: true,
				destroyed: false,
				disconnected: false,
				options: {},
				socket: { send: vi.fn() },
				connect: vi.fn(),
				destroy: vi.fn(),
				joinRoom: vi.fn(),
				on: peerEmitter.on.bind(peerEmitter),
				off: peerEmitter.off.bind(peerEmitter),
				once: peerEmitter.once.bind(peerEmitter),
				emit: peerEmitter.emit.bind(peerEmitter),
				removeAllListeners: peerEmitter.removeAllListeners.bind(peerEmitter),
			};

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => peerEmitter.emit("open", "my-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				// Simulate an incoming presence update from "alice"
				room.presence.handleUpdate("alice", { cursor: [5, 5] });

				const others = room.getOthers();
				expect(others.size).toBe(1);
				expect(others.get("alice")).toEqual({ cursor: [5, 5] });

				expect(room.getPresence("alice")).toEqual({ cursor: [5, 5] });

				room.leave();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("leave clears presence", () =>
		new Promise<void>((resolve) => {
			const room = new Room("my-room");

			const peerEmitter = new EventEmitter();
			const mockPeer = {
				id: "my-room",
				open: true,
				destroyed: false,
				disconnected: false,
				options: {},
				socket: { send: vi.fn() },
				connect: vi.fn(),
				destroy: vi.fn(),
				joinRoom: vi.fn(),
				on: peerEmitter.on.bind(peerEmitter),
				off: peerEmitter.off.bind(peerEmitter),
				once: peerEmitter.once.bind(peerEmitter),
				emit: peerEmitter.emit.bind(peerEmitter),
				removeAllListeners: peerEmitter.removeAllListeners.bind(peerEmitter),
			};

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => peerEmitter.emit("open", "my-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				room.setPresence({ cursor: [1, 2] });
				room.presence.handleUpdate("bob", { name: "Bob" });

				expect(room.presence.size).toBe(2);

				room.leave();

				expect(room.presence.size).toBe(0);
				expect(room.presence.myPresence).toBeNull();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));
});
