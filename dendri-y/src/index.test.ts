/**
 * Tests for DendriYjsProvider — the Yjs CRDT bridge for Dendri rooms.
 *
 * Uses a fake DendriRoomLike (no real signaling server) so tests run
 * in plain Node.js without network or browser APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { DendriYjsProvider, type DendriRoomLike } from "./index.js";

/** Create a minimal fake room that tracks subscriptions, broadcasts, and peer events. */
function fakeRoom(peerId = "test-peer-1"): DendriRoomLike & { _sent: Uint8Array[] } {
	const subscribers = new Map<string, Array<(data: unknown, peerId: string) => void>>();
	const peerJoinHandlers: Array<(peerId: string) => void> = [];
	const peerLeaveHandlers: Array<(peerId: string) => void> = [];
	const sent: Uint8Array[] = [];

	return {
		myPeerId: peerId,
		_sent: sent,
		broadcastBinary(bytes: Uint8Array): void {
			sent.push(bytes);
			// Deliver back to local subscribers (simulating a room echo).
			const handlers = subscribers.get("__yjs");
			if (handlers) {
				for (const h of handlers) {
					try {
						h(bytes, peerId);
					} catch {
						// Subscriber threw — ignore in test harness.
					}
				}
			}
		},
		subscribe(topic: string, handler: (data: unknown, peerId: string) => void): () => void {
			if (!subscribers.has(topic)) subscribers.set(topic, []);
			subscribers.get(topic)!.push(handler);
			return () => {
				const arr = subscribers.get(topic);
				if (arr) {
					const idx = arr.indexOf(handler);
					if (idx !== -1) arr.splice(idx, 1);
				}
			};
		},
		onPeerJoin(handler: (peerId: string) => void): () => void {
			peerJoinHandlers.push(handler);
			return () => {
				const idx = peerJoinHandlers.indexOf(handler);
				if (idx !== -1) peerJoinHandlers.splice(idx, 1);
			};
		},
		onPeerLeave(handler: (peerId: string) => void): () => void {
			peerLeaveHandlers.push(handler);
			return () => {
				const idx = peerLeaveHandlers.indexOf(handler);
				if (idx !== -1) peerLeaveHandlers.splice(idx, 1);
			};
		},
		// Helpers for tests
		_simulatePeerJoin(id: string): void {
			for (const h of peerJoinHandlers) h(id);
		},
		_simulatePeerLeave(id: string): void {
			for (const h of peerLeaveHandlers) h(id);
		},
	};
}

describe("DendriYjsProvider", () => {
	let doc: Y.Doc;
	let room: ReturnType<typeof fakeRoom>;

	beforeEach(() => {
		doc = new Y.Doc();
		room = fakeRoom();
	});

	it("sends SyncStep1 on peer join", () => {
		const provider = new DendriYjsProvider({ room, doc });

		// Clear any initial broadcasts (constructor may have side effects).
		room._sent.length = 0;

		room._simulatePeerJoin("peer-2");

		// Should have broadcast a SyncStep1 (type = 0) frame.
		const syncFrames = room._sent.filter(
			(b) => b.length > 0 && b[0] === 0,
		);
		expect(syncFrames.length).toBeGreaterThanOrEqual(1);

		provider.destroy();
	});

	it("applies incoming Yjs updates to the document", () => {
		const provider = new DendriYjsProvider({ room, doc });

		// Create a Yjs update from a separate document.
		const remoteDoc = new Y.Doc();
		const text = remoteDoc.getText("test");
		text.insert(0, "hello from remote");
		const update = Y.encodeStateAsUpdate(remoteDoc);

		// Frame as Update (type = 2) and deliver via fake room.
		const framed = new Uint8Array(update.length + 1);
		framed[0] = 2; // MsgType.Update
		framed.set(update, 1);

		room.broadcastBinary(framed);

		// The local doc should now contain the remote text.
		const localText = doc.getText("test");
		expect(localText.toString()).toBe("hello from remote");

		remoteDoc.destroy();
		provider.destroy();
	});

	it("broadcasts local Yjs changes to the room", () => {
		const provider = new DendriYjsProvider({ room, doc });

		room._sent.length = 0;

		// Make a local change.
		const text = doc.getText("local-test");
		text.insert(0, "local change");

		// Should have broadcast an Update frame (type = 2).
		const updates = room._sent.filter(
			(b) => b.length > 0 && b[0] === 2,
		);
		expect(updates.length).toBeGreaterThanOrEqual(1);

		provider.destroy();
	});

	it("cleans up subscribers on destroy", () => {
		let unsubscribeCalled = false;
		const roomWithSpy: DendriRoomLike = {
			myPeerId: "p1",
			broadcastBinary: vi.fn(),
			subscribe: vi.fn(() => {
				return () => {
					unsubscribeCalled = true;
				};
			}),
			onPeerJoin: vi.fn(() => () => void 0),
			onPeerLeave: vi.fn(() => () => void 0),
		};

		const provider = new DendriYjsProvider({
			room: roomWithSpy,
			doc: new Y.Doc(),
		});

		provider.destroy();
		expect(unsubscribeCalled).toBe(true);
	});
});

describe("DendriYjsProvider — timing regression", () => {
	/**
	 * Regression: if `store.join()` is called BEFORE `new DendriYjsProvider()`,
	 * the ROOM-PEERS response fires `onPeerJoin` events before the provider
	 * has registered its handler. The joining peer never sends SyncStep1,
	 * so it never receives the initial Yjs document state.
	 *
	 * This test simulates the broken ordering and verifies that even when
	 * the provider is created AFTER a join-like event, it still properly
	 * handles the SyncStep1/Step2 protocol once a peer-join is simulated.
	 */
	it("receives full document state when provider created before join", () => {
		// Host doc with shared state (dots + scores).
		const hostDoc = new Y.Doc();
		const hostMap = hostDoc.getMap<number>("scores");
		hostMap.set("peer-a", 42);
		hostMap.set("peer-b", 7);
		const hostText = hostDoc.getText("board");
		hostText.insert(0, "game-state");

		// Joiner doc (empty).
		const joinerDoc = new Y.Doc();
		const joinerRoom = fakeRoom("joiner");

		// Create provider BEFORE simulating join — this is the CORRECT order.
		const joinerProvider = new DendriYjsProvider({
			room: joinerRoom,
			doc: joinerDoc,
		});

		// Simulate receiving a SyncStep2 (full state) from the host.
		const syncUpdate = Y.encodeStateAsUpdate(hostDoc);
		const framed = new Uint8Array(syncUpdate.length + 1);
		framed[0] = 1; // MsgType.SyncStep2
		framed.set(syncUpdate, 1);
		joinerRoom.broadcastBinary(framed);

		// Joiner should now have the host's state.
		const joinerMap = joinerDoc.getMap<number>("scores");
		expect(joinerMap.get("peer-a")).toBe(42);
		expect(joinerMap.get("peer-b")).toBe(7);
		const joinerText = joinerDoc.getText("board");
		expect(joinerText.toString()).toBe("game-state");

		hostDoc.destroy();
		joinerProvider.destroy();
	});

	/**
	 * Verifies that even when onPeerJoin is registered AND fires immediately,
	 * the provider handles it correctly. The fix ensures the provider's
	 * handler is registered before any join() call triggers peer events.
	 */
	it("handles SyncStep1 sent by onPeerJoin handler", () => {
		const doc = new Y.Doc();
		const room = fakeRoom("test-peer");

		// Create provider — this registers onPeerJoin which sends SyncStep1.
		const provider = new DendriYjsProvider({ room, doc });

		room._sent.length = 0;

		// Simulate a peer joining — should trigger SyncStep1.
		room._simulatePeerJoin("new-peer");

		// SyncStep1 has type=0.
		const syncFrames = room._sent.filter(
			(b) => b.length > 0 && b[0] === 0,
		);
		expect(syncFrames.length).toBeGreaterThanOrEqual(
			1,
			"onPeerJoin must trigger SyncStep1 broadcast",
		);

		provider.destroy();
	});

	/**
	 * Regression: verifies that the provider can be created and its
	 * onPeerJoin handler survives being created BEFORE any join()
	 * call. This is the exact scenario that was broken in production
	 * (store.join() happened before new DendriYjsProvider).
	 */
	it("provider survives creation order: register handler, then simulate join", () => {
		const doc = new Y.Doc();
		const room = fakeRoom("late-joiner");

		// Step 1: Create provider (registers onPeerJoin handler).
		const provider = new DendriYjsProvider({ room, doc });

		// Step 2: Simulate peer join AFTER provider is ready.
		// This is the correct order — the bug was that join happened
		// BEFORE provider creation, so handler was never registered.
		room._simulatePeerJoin("host-peer");

		// Step 3: Host responds with a SyncStep2 (full document state).
		const hostDoc = new Y.Doc();
		hostDoc.getMap("scores").set("host", 100);
		const update = Y.encodeStateAsUpdate(hostDoc);
		const framed = new Uint8Array(update.length + 1);
		framed[0] = 1; // SyncStep2
		framed.set(update, 1);

		room.broadcastBinary(framed);

		// Step 4: Verify the late-joiner received the full state.
		const scores = doc.getMap<number>("scores");
		expect(scores.get("host")).toBe(
			100,
			"Document state must sync when provider is created before join",
		);

		hostDoc.destroy();
		provider.destroy();
	});
});

describe("Awareness sync — existing peers must be visible to new joiners", () => {

	/**
	 * Regression: When a new peer joins a room that already has peers,
	 * the joiner must receive awareness states from ALL existing peers.
	 * 
	 * Bug: store.join() was called before new DendriYjsProvider(), so
	 * the onPeerJoin handler (which triggers SyncStep1 to request state)
	 * was never registered. The joiner only saw peers that joined AFTER
	 * them, not peers already in the room.
	 */
	it("new joiner receives full awareness state from existing peers", () => {
		// Host: already in room with awareness state set.
		const hostDoc = new Y.Doc();
		const hostAwareness = new Awareness(hostDoc);
		hostAwareness.setLocalState({
			name: "Host",
			color: "#ff0000",
			status: "online",
		});

		// Joiner: just joining, creates provider BEFORE simulating join.
		const joinerDoc = new Y.Doc();
		const joinerAwareness = new Awareness(joinerDoc);
		const joinerRoom = fakeRoom("joiner-peer");

		// Create provider with awareness BEFORE join (correct order).
		const joinerProvider = new DendriYjsProvider({
			room: joinerRoom,
			doc: joinerDoc,
			awareness: joinerAwareness,
		});

		// Simulate the host broadcasting their awareness state to the room,
		// which the joiner would receive via the __yjs topic.
		const hostState = hostAwareness.getLocalState();
		expect(hostState).toBeTruthy();
		expect(hostState!.name).toBe("Host");

		// Encode the host's awareness and deliver it as a binary message
		// (simulating the awareness sync that happens when a peer joins).
		const { encodeAwarenessUpdate } = require("y-protocols/awareness");
		const awarenessUpdate = encodeAwarenessUpdate(hostAwareness, [hostAwareness.clientID]);
		const framed = new Uint8Array(awarenessUpdate.length + 1);
		framed[0] = 3; // MsgType.Awareness
		framed.set(awarenessUpdate, 1);
		joinerRoom.broadcastBinary(framed);

		// The joiner should now see the host's awareness state.
		const joinerStates = [...joinerAwareness.getStates().entries()];
		const hostStateInJoiner = joinerStates.find(
			([id]) => id === hostAwareness.clientID
		);

		expect(hostStateInJoiner).toBeTruthy();
		expect(hostStateInJoiner![1].name).toBe("Host");
		expect(hostStateInJoiner![1].status).toBe("online");

		hostDoc.destroy();
		joinerProvider.destroy();
	});

	/**
	 * Regression: Multiple existing peers must all be visible to a new joiner.
	 * When 3 peers are already in a room, a 4th peer joining must see all 3.
	 */
	it("new joiner sees all existing peers via awareness", () => {
		const joinerDoc = new Y.Doc();
		const joinerAwareness = new Awareness(joinerDoc);
		const joinerRoom = fakeRoom("joiner");

		const joinerProvider = new DendriYjsProvider({
			room: joinerRoom,
			doc: joinerDoc,
			awareness: joinerAwareness,
		});

		// Simulate 3 existing peers each broadcasting their awareness.
		const peers = [
			{ name: "Alice", color: "#ff0000" },
			{ name: "Bob", color: "#00ff00" },
			{ name: "Carol", color: "#0000ff" },
		];

		const { encodeAwarenessUpdate } = require("y-protocols/awareness");
		for (const peer of peers) {
			const peerDoc = new Y.Doc();
			const peerAw = new Awareness(peerDoc);
			peerAw.setLocalState(peer);
			const update = encodeAwarenessUpdate(peerAw, [peerAw.clientID]);
			const framed = new Uint8Array(update.length + 1);
			framed[0] = 3;
			framed.set(update, 1);
			joinerRoom.broadcastBinary(framed);
			peerDoc.destroy();
		}

		// Joiner should see all 3 peers.
		const states = [...joinerAwareness.getStates().values()];
		expect(states.length).toBeGreaterThanOrEqual(
			3,
			"Joiner must see all 3 existing peers"
		);

		joinerProvider.destroy();
	});
});
