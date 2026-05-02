import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceManager } from "../src/presence";

// ---------------------------------------------------------------------------
// PresenceManager comprehensive tests
// ---------------------------------------------------------------------------
describe("PresenceManager — comprehensive", () => {
	let pm: PresenceManager<Record<string, unknown>>;

	beforeEach(() => {
		pm = new PresenceManager();
		pm.setMyPeerId("self");
	});

	afterEach(() => {
		pm.clear();
		pm.removeAllListeners();
	});

	// -------------------------------------------------------------------
	// setMyPresence with deeply nested objects
	// -------------------------------------------------------------------
	describe("deeply nested presence data", () => {
		it("stores and retrieves deeply nested objects", () => {
			const deepData = {
				level1: {
					level2: {
						level3: {
							level4: {
								value: "deep",
								array: [1, 2, [3, 4, [5]]],
							},
						},
					},
				},
			};

			pm.setMyPresence(deepData);

			expect(pm.myPresence).toEqual(deepData);
			expect(pm.getPresence("self")).toEqual(deepData);
		});

		it("merges nested objects at top level only (shallow merge)", () => {
			pm.setMyPresence({ nested: { a: 1, b: 2 } });
			pm.setMyPresence({ nested: { c: 3 } });

			// Spread merge replaces the nested key entirely
			expect(pm.myPresence).toEqual({ nested: { c: 3 } });
		});
	});

	// -------------------------------------------------------------------
	// Rapid setMyPresence calls
	// -------------------------------------------------------------------
	describe("rapid setMyPresence calls", () => {
		it("only the latest state is visible after 10 rapid calls", () => {
			const updateHandler = vi.fn();
			pm.on("update", updateHandler);

			for (let i = 0; i < 10; i++) {
				pm.setMyPresence({ counter: i });
			}

			// All 10 updates should have fired
			expect(updateHandler).toHaveBeenCalledTimes(10);

			// But the final state should reflect only the last call
			expect(pm.myPresence).toEqual({ counter: 9 });
			expect(pm.getPresence("self")).toEqual({ counter: 9 });
		});
	});

	// -------------------------------------------------------------------
	// Presence for 10+ peers simultaneously
	// -------------------------------------------------------------------
	describe("many simultaneous peers", () => {
		it("handles 15 peers simultaneously", () => {
			for (let i = 0; i < 15; i++) {
				pm.handleUpdate(`peer-${i}`, { index: i, name: `Peer ${i}` });
			}

			expect(pm.size).toBe(15); // 15 peers (self not set yet)

			pm.setMyPresence({ index: -1, name: "Self" });
			expect(pm.size).toBe(16);

			const others = pm.getOthers();
			expect(others.size).toBe(15);
			expect(others.has("self")).toBe(false);

			for (let i = 0; i < 15; i++) {
				expect(pm.getPresence(`peer-${i}`)).toEqual({ index: i, name: `Peer ${i}` });
			}
		});

		it("getAll includes all peers plus self", () => {
			for (let i = 0; i < 10; i++) {
				pm.handleUpdate(`peer-${i}`, { active: true });
			}
			pm.setMyPresence({ active: true });

			const all = pm.getAll();
			expect(all.size).toBe(11);
			expect(all.has("self")).toBe(true);
		});
	});

	// -------------------------------------------------------------------
	// getOthers() after peers join and leave
	// -------------------------------------------------------------------
	describe("getOthers after joins and leaves", () => {
		it("returns correct set after multiple joins and some leaves", () => {
			pm.handleUpdate("alice", { status: "online" });
			pm.handleUpdate("bob", { status: "online" });
			pm.handleUpdate("charlie", { status: "online" });
			pm.handleUpdate("diana", { status: "online" });

			expect(pm.getOthers().size).toBe(4);

			pm.handleLeave("bob");
			pm.handleLeave("diana");

			const others = pm.getOthers();
			expect(others.size).toBe(2);
			expect(others.has("alice")).toBe(true);
			expect(others.has("charlie")).toBe(true);
			expect(others.has("bob")).toBe(false);
			expect(others.has("diana")).toBe(false);
		});

		it("returns empty map when all peers leave", () => {
			pm.handleUpdate("alice", { x: 1 });
			pm.handleUpdate("bob", { x: 2 });

			pm.handleLeave("alice");
			pm.handleLeave("bob");

			expect(pm.getOthers().size).toBe(0);
		});
	});

	// -------------------------------------------------------------------
	// Presence data types
	// -------------------------------------------------------------------
	describe("presence data types", () => {
		it("handles string values", () => {
			pm.handleUpdate("peer-1", { status: "active" } as any);
			expect(pm.getPresence("peer-1")).toEqual({ status: "active" });
		});

		it("handles number values", () => {
			pm.handleUpdate("peer-1", { score: 42 } as any);
			expect(pm.getPresence("peer-1")).toEqual({ score: 42 });
		});

		it("handles boolean values", () => {
			pm.handleUpdate("peer-1", { online: true } as any);
			expect(pm.getPresence("peer-1")).toEqual({ online: true });
		});

		it("handles array values", () => {
			pm.handleUpdate("peer-1", { tags: ["a", "b", "c"] } as any);
			expect(pm.getPresence("peer-1")).toEqual({ tags: ["a", "b", "c"] });
		});

		it("handles nested object values", () => {
			const nested = { user: { name: "Alice", cursor: { x: 10, y: 20 } } };
			pm.handleUpdate("peer-1", nested as any);
			expect(pm.getPresence("peer-1")).toEqual(nested);
		});

		it("handles null field values", () => {
			pm.handleUpdate("peer-1", { data: null } as any);
			expect(pm.getPresence("peer-1")).toEqual({ data: null });
		});

		it("handles empty object", () => {
			pm.handleUpdate("peer-1", {} as any);
			expect(pm.getPresence("peer-1")).toEqual({});
		});
	});

	// -------------------------------------------------------------------
	// handleUpdate with identical data
	// -------------------------------------------------------------------
	describe("handleUpdate with identical data", () => {
		it("still emits update event even when data is identical", () => {
			const updateHandler = vi.fn();
			pm.on("update", updateHandler);

			const data = { cursor: [5, 5] };

			pm.handleUpdate("peer-1", data as any);
			pm.handleUpdate("peer-1", data as any);
			pm.handleUpdate("peer-1", data as any);

			// First call emits both join + update; subsequent calls emit only update
			expect(updateHandler).toHaveBeenCalledTimes(3);
		});

		it("does not emit join again for identical repeat data", () => {
			const joinHandler = vi.fn();
			pm.on("join", joinHandler);

			const data = { cursor: [5, 5] };

			pm.handleUpdate("peer-1", data as any);
			pm.handleUpdate("peer-1", data as any);

			expect(joinHandler).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------
	// Two peers setting presence simultaneously
	// -------------------------------------------------------------------
	describe("simultaneous peer presence updates", () => {
		it("both updates are stored correctly", () => {
			const updateHandler = vi.fn();
			pm.on("update", updateHandler);

			pm.handleUpdate("alice", { x: 1 } as any);
			pm.handleUpdate("bob", { x: 2 } as any);

			expect(pm.getPresence("alice")).toEqual({ x: 1 });
			expect(pm.getPresence("bob")).toEqual({ x: 2 });
			expect(updateHandler).toHaveBeenCalledTimes(2);
		});

		it("interleaved updates maintain separate state", () => {
			pm.handleUpdate("alice", { step: 1 } as any);
			pm.handleUpdate("bob", { step: 1 } as any);
			pm.handleUpdate("alice", { step: 2 } as any);
			pm.handleUpdate("bob", { step: 2 } as any);

			expect(pm.getPresence("alice")).toEqual({ step: 2 });
			expect(pm.getPresence("bob")).toEqual({ step: 2 });
		});
	});

	// -------------------------------------------------------------------
	// Memory: clear() should free all references
	// -------------------------------------------------------------------
	describe("clear frees all references", () => {
		it("clears presences, myPresence, and myPeerId", () => {
			pm.setMyPresence({ cursor: [0, 0] });
			pm.handleUpdate("alice", { cursor: [1, 1] } as any);
			pm.handleUpdate("bob", { cursor: [2, 2] } as any);

			expect(pm.size).toBe(3);

			pm.clear();

			expect(pm.size).toBe(0);
			expect(pm.myPresence).toBeNull();
			expect(pm.getPresence("self")).toBeUndefined();
			expect(pm.getPresence("alice")).toBeUndefined();
			expect(pm.getPresence("bob")).toBeUndefined();
			expect(pm.getOthers().size).toBe(0);
			expect(pm.getAll().size).toBe(0);
		});

		it("can set new presence after clear", () => {
			pm.setMyPresence({ old: true });
			pm.clear();

			// Re-initialize
			pm.setMyPeerId("new-self");
			pm.setMyPresence({ fresh: true });

			expect(pm.myPresence).toEqual({ fresh: true });
			expect(pm.getPresence("new-self")).toEqual({ fresh: true });
			expect(pm.size).toBe(1);
		});
	});

	// -------------------------------------------------------------------
	// Presence with large data
	// -------------------------------------------------------------------
	describe("presence with large data", () => {
		it("handles 1KB+ presence data per peer", () => {
			// Generate a string >1KB
			const largeString = "x".repeat(1500);
			const largeData = {
				content: largeString,
				metadata: { size: largeString.length },
			};

			pm.handleUpdate("peer-1", largeData as any);

			const stored = pm.getPresence("peer-1") as Record<string, unknown>;
			expect(stored).toBeDefined();
			expect((stored.content as string).length).toBe(1500);
		});

		it("handles large data from multiple peers", () => {
			for (let i = 0; i < 10; i++) {
				const data = {
					buffer: "y".repeat(1024),
					index: i,
				};
				pm.handleUpdate(`peer-${i}`, data as any);
			}

			expect(pm.size).toBe(10);
			for (let i = 0; i < 10; i++) {
				const stored = pm.getPresence(`peer-${i}`) as Record<string, unknown>;
				expect((stored.buffer as string).length).toBe(1024);
				expect(stored.index).toBe(i);
			}
		});
	});

	// -------------------------------------------------------------------
	// Event ordering: join then update on first handleUpdate
	// -------------------------------------------------------------------
	describe("event ordering", () => {
		it("fires join before update on first handleUpdate", () => {
			const order: string[] = [];

			pm.on("join", () => order.push("join"));
			pm.on("update", () => order.push("update"));

			pm.handleUpdate("alice", { x: 1 } as any);

			expect(order).toEqual(["join", "update"]);
		});

		it("fires only update on subsequent handleUpdate calls", () => {
			const order: string[] = [];

			pm.on("join", () => order.push("join"));
			pm.on("update", () => order.push("update"));

			pm.handleUpdate("alice", { x: 1 } as any);
			order.length = 0; // reset

			pm.handleUpdate("alice", { x: 2 } as any);
			expect(order).toEqual(["update"]);
		});
	});

	// -------------------------------------------------------------------
	// handleLeave multiple times for same peer
	// -------------------------------------------------------------------
	describe("handleLeave edge cases", () => {
		it("calling handleLeave twice for same peer only emits once", () => {
			const leaveHandler = vi.fn();
			pm.on("leave", leaveHandler);

			pm.handleUpdate("alice", { x: 1 } as any);

			pm.handleLeave("alice");
			pm.handleLeave("alice");

			expect(leaveHandler).toHaveBeenCalledTimes(1);
		});

		it("peer can rejoin after leave", () => {
			const joinHandler = vi.fn();
			pm.on("join", joinHandler);

			pm.handleUpdate("alice", { x: 1 } as any);
			pm.handleLeave("alice");
			pm.handleUpdate("alice", { x: 2 } as any);

			// join should fire twice (once initial, once re-join)
			expect(joinHandler).toHaveBeenCalledTimes(2);
			expect(pm.getPresence("alice")).toEqual({ x: 2 });
		});
	});

	// -------------------------------------------------------------------
	// getOthers returns a copy, not the internal map
	// -------------------------------------------------------------------
	describe("getOthers returns independent copy", () => {
		it("modifying the returned map does not affect internal state", () => {
			pm.handleUpdate("alice", { x: 1 } as any);

			const others = pm.getOthers();
			others.delete("alice");
			others.set("mallory", { hacked: true } as any);

			// Internal state should be unaffected
			expect(pm.getPresence("alice")).toEqual({ x: 1 });
			expect(pm.getPresence("mallory")).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------
	// getAll returns a copy
	// -------------------------------------------------------------------
	describe("getAll returns independent copy", () => {
		it("modifying the returned map does not affect internal state", () => {
			pm.setMyPresence({ cursor: [0, 0] });
			pm.handleUpdate("alice", { cursor: [1, 1] } as any);

			const all = pm.getAll();
			all.clear();

			expect(pm.size).toBe(2);
		});
	});

	// -------------------------------------------------------------------
	// setMyPresence without peerId set stores myPresence but not in map
	// -------------------------------------------------------------------
	describe("setMyPresence without peerId", () => {
		it("stores myPresence but does not add to map", () => {
			const fresh = new PresenceManager();
			// No peerId set

			fresh.setMyPresence({ cursor: [1, 2] });

			expect(fresh.myPresence).toEqual({ cursor: [1, 2] });
			expect(fresh.size).toBe(0);

			// Now set peerId and set presence again
			fresh.setMyPeerId("late-id");
			fresh.setMyPresence({ cursor: [3, 4] });

			expect(fresh.size).toBe(1);
			// The merge overwrites cursor from [1,2] to [3,4]
			expect(fresh.getPresence("late-id")).toEqual({ cursor: [3, 4] });

			fresh.clear();
		});
	});

	// -------------------------------------------------------------------
	// Merge behavior across multiple partial updates
	// -------------------------------------------------------------------
	describe("partial update merging", () => {
		it("merges multiple partial setMyPresence calls at top level", () => {
			pm.setMyPresence({ name: "Alice" });
			pm.setMyPresence({ color: "blue" });
			pm.setMyPresence({ score: 100 });

			expect(pm.myPresence).toEqual({
				name: "Alice",
				color: "blue",
				score: 100,
			});
		});

		it("later keys overwrite earlier ones", () => {
			pm.setMyPresence({ name: "Alice" });
			pm.setMyPresence({ name: "Bob" });

			expect(pm.myPresence).toEqual({ name: "Bob" });
		});
	});
});
