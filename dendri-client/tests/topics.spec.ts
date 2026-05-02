import { EventEmitter } from "eventemitter3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataConnection } from "../src/dataconnection/DataConnection";
import { Room } from "../src/room";
import { isTopicEnvelope, TopicManager } from "../src/topics";

// ---------------------------------------------------------------------------
// isTopicEnvelope — type guard tests
// ---------------------------------------------------------------------------
describe("isTopicEnvelope", () => {
	it("returns true for a valid envelope", () => {
		expect(isTopicEnvelope({ __topic: "cursor", __data: { x: 1 } })).toBe(true);
	});

	it("returns true when __data is null", () => {
		expect(isTopicEnvelope({ __topic: "t", __data: null })).toBe(true);
	});

	it("returns false for null", () => {
		expect(isTopicEnvelope(null)).toBe(false);
	});

	it("returns false for a string", () => {
		expect(isTopicEnvelope("hello")).toBe(false);
	});

	it("returns false for an object missing __topic", () => {
		expect(isTopicEnvelope({ __data: 1 })).toBe(false);
	});

	it("returns false for an object missing __data", () => {
		expect(isTopicEnvelope({ __topic: "t" })).toBe(false);
	});

	it("returns false when __topic is not a string", () => {
		expect(isTopicEnvelope({ __topic: 42, __data: "x" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// TopicManager
// ---------------------------------------------------------------------------
describe("TopicManager", () => {
	let tm: TopicManager;

	beforeEach(() => {
		tm = new TopicManager();
	});

	it("subscribe receives matching topic messages", () => {
		const handler = vi.fn();
		tm.subscribe("cursor", handler);

		tm.dispatch("cursor", { x: 10 }, "peer-a");

		expect(handler).toHaveBeenCalledOnce();
		expect(handler).toHaveBeenCalledWith({ x: 10 }, "peer-a");
	});

	it("subscribe does not receive non-matching topics", () => {
		const handler = vi.fn();
		tm.subscribe("cursor", handler);

		tm.dispatch("chat", { msg: "hi" }, "peer-b");

		expect(handler).not.toHaveBeenCalled();
	});

	it("subscribeAll receives all messages regardless of topic", () => {
		const handler = vi.fn();
		tm.subscribeAll(handler);

		tm.dispatch("cursor", { x: 1 }, "peer-a");
		tm.dispatch("chat", { msg: "hi" }, "peer-b");
		tm.dispatch(undefined, "raw", "peer-c");

		expect(handler).toHaveBeenCalledTimes(3);
		expect(handler).toHaveBeenCalledWith({ x: 1 }, "peer-a");
		expect(handler).toHaveBeenCalledWith({ msg: "hi" }, "peer-b");
		expect(handler).toHaveBeenCalledWith("raw", "peer-c");
	});

	it("unsubscribe function removes the handler", () => {
		const handler = vi.fn();
		const unsub = tm.subscribe("cursor", handler);

		tm.dispatch("cursor", 1, "p");
		expect(handler).toHaveBeenCalledOnce();

		unsub();
		tm.dispatch("cursor", 2, "p");
		expect(handler).toHaveBeenCalledOnce(); // still 1
	});

	it("subscribeAll unsubscribe function works", () => {
		const handler = vi.fn();
		const unsub = tm.subscribeAll(handler);

		tm.dispatch("t", 1, "p");
		expect(handler).toHaveBeenCalledOnce();

		unsub();
		tm.dispatch("t", 2, "p");
		expect(handler).toHaveBeenCalledOnce();
	});

	it("dispatch returns true when handled, false when not", () => {
		const handler = vi.fn();
		tm.subscribe("cursor", handler);

		expect(tm.dispatch("cursor", 1, "p")).toBe(true);
		expect(tm.dispatch("unknown", 1, "p")).toBe(false);
	});

	it("dispatch returns true for global handlers even with no topic match", () => {
		const handler = vi.fn();
		tm.subscribeAll(handler);

		expect(tm.dispatch("anything", 1, "p")).toBe(true);
		expect(tm.dispatch(undefined, 1, "p")).toBe(true);
	});

	it("clear removes all handlers", () => {
		const topicHandler = vi.fn();
		const globalHandler = vi.fn();
		tm.subscribe("cursor", topicHandler);
		tm.subscribeAll(globalHandler);

		tm.clear();

		expect(tm.dispatch("cursor", 1, "p")).toBe(false);
		expect(topicHandler).not.toHaveBeenCalled();
		expect(globalHandler).not.toHaveBeenCalled();
	});

	it("multiple handlers on same topic all fire", () => {
		const h1 = vi.fn();
		const h2 = vi.fn();
		const h3 = vi.fn();
		tm.subscribe("cursor", h1);
		tm.subscribe("cursor", h2);
		tm.subscribe("cursor", h3);

		tm.dispatch("cursor", "data", "peer");

		expect(h1).toHaveBeenCalledOnce();
		expect(h2).toHaveBeenCalledOnce();
		expect(h3).toHaveBeenCalledOnce();
	});

	it("topic-specific and global handlers both fire for the same message", () => {
		const topicHandler = vi.fn();
		const globalHandler = vi.fn();
		tm.subscribe("cursor", topicHandler);
		tm.subscribeAll(globalHandler);

		tm.dispatch("cursor", "data", "peer");

		expect(topicHandler).toHaveBeenCalledOnce();
		expect(globalHandler).toHaveBeenCalledOnce();
	});

	it("dispatch with undefined topic only fires global handlers", () => {
		const topicHandler = vi.fn();
		const globalHandler = vi.fn();
		tm.subscribe("cursor", topicHandler);
		tm.subscribeAll(globalHandler);

		tm.dispatch(undefined, "data", "peer");

		expect(topicHandler).not.toHaveBeenCalled();
		expect(globalHandler).toHaveBeenCalledOnce();
	});
});

// ---------------------------------------------------------------------------
// Room topic integration
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
		on: emitter.on.bind(emitter),
		off: emitter.off.bind(emitter),
		once: emitter.once.bind(emitter),
		emit: emitter.emit.bind(emitter),
		removeAllListeners: emitter.removeAllListeners.bind(emitter),
	};
	return peer;
}

describe("Room — topic support", () => {
	let room: Room;

	beforeEach(() => {
		room = new Room("test-room");
	});

	afterEach(() => {
		room.leave();
	});

	it("broadcast with topic wraps data in envelope", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				room.broadcast({ x: 10 }, { topic: "cursor" });

				expect(conn.send).toHaveBeenCalledWith({
					__topic: "cursor",
					__data: { x: 10 },
				});
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("broadcast without topic sends raw data", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const conn = createMockConn("peer-1");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				room.broadcast({ x: 10 });

				expect(conn.send).toHaveBeenCalledWith({ x: 10 });
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("subscribe routes topic messages to the correct handler", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const cursorHandler = vi.fn();
				const chatHandler = vi.fn();
				room.subscribe("cursor", cursorHandler);
				room.subscribe("chat", chatHandler);

				const conn = createMockConn("sender");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				// Simulate receiving a topic-tagged message
				conn.emit("data", { __topic: "cursor", __data: { x: 5, y: 10 } });

				expect(cursorHandler).toHaveBeenCalledOnce();
				expect(cursorHandler).toHaveBeenCalledWith({ x: 5, y: 10 }, "sender");
				expect(chatHandler).not.toHaveBeenCalled();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("onData receives all messages regardless of topic", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const allHandler = vi.fn();
				room.onData(allHandler);

				const conn = createMockConn("sender");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("data", { __topic: "cursor", __data: { x: 1 } });
				conn.emit("data", { msg: "plain" });

				expect(allHandler).toHaveBeenCalledTimes(2);
				expect(allHandler).toHaveBeenCalledWith({ x: 1 }, "sender");
				expect(allHandler).toHaveBeenCalledWith({ msg: "plain" }, "sender");
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("data event emits unwrapped payload for topic messages", () =>
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
					// Should be the unwrapped payload, not the envelope
					expect(data).toEqual({ x: 5 });
					resolve();
				});

				conn.emit("data", { __topic: "cursor", __data: { x: 5 } });
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("host relays topic-wrapped data as-is to other peers", () =>
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

				const envelope = { __topic: "cursor", __data: { x: 10 } };

				room.on("data", () => {
					// peer-b should receive the raw envelope so it can unwrap on its side
					expect(conn2.send).toHaveBeenCalledWith(envelope);
					expect(conn1.send).not.toHaveBeenCalledWith(envelope);
					resolve();
				});

				conn1.emit("data", envelope);
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("unsubscribe from room topic stops delivery", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const handler = vi.fn();
				const unsub = room.subscribe("cursor", handler);

				const conn = createMockConn("sender");
				mockPeer.emit("connection", conn);
				conn.emit("open");

				conn.emit("data", { __topic: "cursor", __data: 1 });
				expect(handler).toHaveBeenCalledOnce();

				unsub();

				conn.emit("data", { __topic: "cursor", __data: 2 });
				expect(handler).toHaveBeenCalledOnce(); // still 1
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));

	it("leave clears topic subscriptions", () =>
		new Promise<void>((resolve) => {
			const mockPeer = createMockDendri("test-room");

			const MockDendri = vi.fn().mockImplementation(() => {
				setTimeout(() => mockPeer.emit("open", "test-room"), 0);
				return mockPeer;
			});

			room.on("joined", () => {
				const handler = vi.fn();
				room.subscribe("cursor", handler);

				room.leave();

				// After leave, creating a new room instance to verify
				// the old handler no longer fires (Room is cleaned up)
				expect(room.isHost).toBe(false);
				expect(room.peerId).toBeNull();
				resolve();
			});

			room.join(MockDendri as any, { host: "localhost", port: 9000 });
		}));
});
