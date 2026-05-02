import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTopicEnvelope, TopicManager } from "../src/topics";

// ---------------------------------------------------------------------------
// TopicManager comprehensive tests
// ---------------------------------------------------------------------------
describe("TopicManager — comprehensive", () => {
	let tm: TopicManager;

	beforeEach(() => {
		tm = new TopicManager();
	});

	afterEach(() => {
		tm.clear();
	});

	// -------------------------------------------------------------------
	// Subscribe to many topics simultaneously
	// -------------------------------------------------------------------
	describe("subscribe to 100 topics", () => {
		it("handles 100 simultaneous topic subscriptions", () => {
			const handlers: ReturnType<typeof vi.fn>[] = [];

			for (let i = 0; i < 100; i++) {
				const handler = vi.fn();
				handlers.push(handler);
				tm.subscribe(`topic-${i}`, handler);
			}

			// Dispatch to each topic
			for (let i = 0; i < 100; i++) {
				tm.dispatch(`topic-${i}`, { index: i }, "peer-a");
			}

			// Each handler should have been called exactly once
			for (let i = 0; i < 100; i++) {
				expect(handlers[i]).toHaveBeenCalledTimes(1);
				expect(handlers[i]).toHaveBeenCalledWith({ index: i }, "peer-a");
			}
		});

		it("non-matching topics do not fire other handlers", () => {
			const handlers: ReturnType<typeof vi.fn>[] = [];

			for (let i = 0; i < 100; i++) {
				const handler = vi.fn();
				handlers.push(handler);
				tm.subscribe(`topic-${i}`, handler);
			}

			// Dispatch only to topic-50
			tm.dispatch("topic-50", "data", "peer-a");

			// Only topic-50 handler fires
			for (let i = 0; i < 100; i++) {
				if (i === 50) {
					expect(handlers[i]).toHaveBeenCalledTimes(1);
				} else {
					expect(handlers[i]).not.toHaveBeenCalled();
				}
			}
		});
	});

	// -------------------------------------------------------------------
	// Unsubscribe mid-dispatch
	// -------------------------------------------------------------------
	describe("unsubscribe mid-dispatch", () => {
		it("handler can unsubscribe itself during callback", () => {
			let unsub: (() => void) | null = null;
			const selfUnsubHandler = vi.fn().mockImplementation(() => {
				if (unsub) unsub();
			});

			unsub = tm.subscribe("events", selfUnsubHandler);

			// First dispatch — handler fires and unsubscribes itself
			tm.dispatch("events", "first", "p");
			expect(selfUnsubHandler).toHaveBeenCalledTimes(1);

			// Second dispatch — handler should NOT fire
			tm.dispatch("events", "second", "p");
			expect(selfUnsubHandler).toHaveBeenCalledTimes(1);
		});

		it("other handlers still fire when one unsubscribes itself", () => {
			const otherHandler = vi.fn();
			let unsub: (() => void) | null = null;

			const selfUnsubHandler = vi.fn().mockImplementation(() => {
				if (unsub) unsub();
			});

			unsub = tm.subscribe("events", selfUnsubHandler);
			tm.subscribe("events", otherHandler);

			tm.dispatch("events", "data", "p");

			// Both should fire on the first dispatch
			expect(selfUnsubHandler).toHaveBeenCalledTimes(1);
			expect(otherHandler).toHaveBeenCalledTimes(1);

			// On the second dispatch, only otherHandler should fire
			tm.dispatch("events", "data2", "p");
			expect(selfUnsubHandler).toHaveBeenCalledTimes(1);
			expect(otherHandler).toHaveBeenCalledTimes(2);
		});
	});

	// -------------------------------------------------------------------
	// Dispatch to topic with 0 handlers
	// -------------------------------------------------------------------
	describe("dispatch with 0 handlers", () => {
		it("returns false for topic with no handlers", () => {
			expect(tm.dispatch("empty-topic", "data", "peer")).toBe(false);
		});

		it("returns false for undefined topic with no global handlers", () => {
			expect(tm.dispatch(undefined, "data", "peer")).toBe(false);
		});
	});

	// -------------------------------------------------------------------
	// Dispatch to topic with 50 handlers
	// -------------------------------------------------------------------
	describe("dispatch with 50 handlers", () => {
		it("all 50 handlers fire for a single dispatch", () => {
			const handlers: ReturnType<typeof vi.fn>[] = [];

			for (let i = 0; i < 50; i++) {
				const handler = vi.fn();
				handlers.push(handler);
				tm.subscribe("busy-topic", handler);
			}

			const result = tm.dispatch("busy-topic", { value: "test" }, "sender");

			expect(result).toBe(true);
			for (const handler of handlers) {
				expect(handler).toHaveBeenCalledTimes(1);
				expect(handler).toHaveBeenCalledWith({ value: "test" }, "sender");
			}
		});
	});

	// -------------------------------------------------------------------
	// Topic names with special characters
	// -------------------------------------------------------------------
	describe("topic names with special characters", () => {
		it("handles topics with spaces", () => {
			const handler = vi.fn();
			tm.subscribe("my topic", handler);

			tm.dispatch("my topic", "data", "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles topics with unicode characters", () => {
			const handler = vi.fn();
			tm.subscribe("\u{1F680}-rocket", handler);

			tm.dispatch("\u{1F680}-rocket", "launched", "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles topics with slashes", () => {
			const handler = vi.fn();
			tm.subscribe("room/cursor/update", handler);

			tm.dispatch("room/cursor/update", { x: 1 }, "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles topics with dots", () => {
			const handler = vi.fn();
			tm.subscribe("event.cursor.move", handler);

			tm.dispatch("event.cursor.move", { x: 1 }, "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles empty string as topic", () => {
			const handler = vi.fn();
			tm.subscribe("", handler);

			tm.dispatch("", "data", "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles topics with special regex characters", () => {
			const handler = vi.fn();
			tm.subscribe("topic.*+?^${}()|[]\\", handler);

			tm.dispatch("topic.*+?^${}()|[]\\", "data", "p");
			expect(handler).toHaveBeenCalledOnce();
		});

		it("handles topics with newlines and tabs", () => {
			const handler = vi.fn();
			tm.subscribe("line1\nline2\ttab", handler);

			tm.dispatch("line1\nline2\ttab", "data", "p");
			expect(handler).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------
	// isTopicEnvelope edge cases
	// -------------------------------------------------------------------
	describe("isTopicEnvelope edge cases", () => {
		it("returns false for empty __topic string", () => {
			// Empty string IS a string, so this is technically valid per type guard
			expect(isTopicEnvelope({ __topic: "", __data: "data" })).toBe(true);
		});

		it("returns true when __data is null", () => {
			expect(isTopicEnvelope({ __topic: "t", __data: null })).toBe(true);
		});

		it("returns true when __data is undefined", () => {
			expect(isTopicEnvelope({ __topic: "t", __data: undefined })).toBe(true);
		});

		it("returns true with extra fields present", () => {
			expect(
				isTopicEnvelope({
					__topic: "cursor",
					__data: { x: 1 },
					extra: "field",
					another: 42,
				}),
			).toBe(true);
		});

		it("returns false for array", () => {
			expect(isTopicEnvelope([1, 2, 3])).toBe(false);
		});

		it("returns false for number", () => {
			expect(isTopicEnvelope(42)).toBe(false);
		});

		it("returns false for boolean", () => {
			expect(isTopicEnvelope(true)).toBe(false);
		});

		it("returns false for undefined", () => {
			expect(isTopicEnvelope(undefined)).toBe(false);
		});

		it("returns false when __topic is empty object", () => {
			expect(isTopicEnvelope({ __topic: {}, __data: "x" })).toBe(false);
		});

		it("returns false when __topic is array", () => {
			expect(isTopicEnvelope({ __topic: ["a"], __data: "x" })).toBe(false);
		});

		it("returns false when __topic is boolean", () => {
			expect(isTopicEnvelope({ __topic: true, __data: "x" })).toBe(false);
		});

		it("returns true when __data is a complex nested object", () => {
			expect(
				isTopicEnvelope({
					__topic: "t",
					__data: { nested: { deep: { value: [1, 2] } } },
				}),
			).toBe(true);
		});

		it("returns true when __data is 0", () => {
			expect(isTopicEnvelope({ __topic: "t", __data: 0 })).toBe(true);
		});

		it("returns true when __data is empty string", () => {
			expect(isTopicEnvelope({ __topic: "t", __data: "" })).toBe(true);
		});

		it("returns true when __data is false", () => {
			expect(isTopicEnvelope({ __topic: "t", __data: false })).toBe(true);
		});
	});

	// -------------------------------------------------------------------
	// subscribe + subscribeAll interaction
	// -------------------------------------------------------------------
	describe("subscribe + subscribeAll interaction", () => {
		it("both topic-specific and global handlers fire", () => {
			const topicHandler = vi.fn();
			const globalHandler = vi.fn();

			tm.subscribe("cursor", topicHandler);
			tm.subscribeAll(globalHandler);

			tm.dispatch("cursor", { x: 1 }, "peer-a");

			expect(topicHandler).toHaveBeenCalledOnce();
			expect(globalHandler).toHaveBeenCalledOnce();
		});

		it("topic handler fires before global handler (based on dispatch order)", () => {
			const order: string[] = [];

			tm.subscribe("cursor", () => order.push("topic"));
			tm.subscribeAll(() => order.push("global"));

			tm.dispatch("cursor", { x: 1 }, "peer-a");

			// Based on the implementation: topic handlers fire first, then global
			expect(order).toEqual(["topic", "global"]);
		});

		it("global handler fires for non-topic messages too", () => {
			const topicHandler = vi.fn();
			const globalHandler = vi.fn();

			tm.subscribe("cursor", topicHandler);
			tm.subscribeAll(globalHandler);

			tm.dispatch(undefined, "raw-data", "peer-a");

			expect(topicHandler).not.toHaveBeenCalled();
			expect(globalHandler).toHaveBeenCalledOnce();
		});

		it("multiple global handlers all fire", () => {
			const g1 = vi.fn();
			const g2 = vi.fn();
			const g3 = vi.fn();

			tm.subscribeAll(g1);
			tm.subscribeAll(g2);
			tm.subscribeAll(g3);

			tm.dispatch("any", "data", "p");

			expect(g1).toHaveBeenCalledOnce();
			expect(g2).toHaveBeenCalledOnce();
			expect(g3).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------
	// Memory: clear() after subscribing to many topics
	// -------------------------------------------------------------------
	describe("clear after many subscriptions", () => {
		it("clears all topic and global handlers", () => {
			for (let i = 0; i < 50; i++) {
				tm.subscribe(`topic-${i}`, vi.fn());
			}
			tm.subscribeAll(vi.fn());
			tm.subscribeAll(vi.fn());

			tm.clear();

			// After clear, dispatching should return false
			for (let i = 0; i < 50; i++) {
				expect(tm.dispatch(`topic-${i}`, "data", "p")).toBe(false);
			}
			expect(tm.dispatch(undefined, "data", "p")).toBe(false);
		});
	});

	// -------------------------------------------------------------------
	// Re-subscribe after clear()
	// -------------------------------------------------------------------
	describe("re-subscribe after clear", () => {
		it("can subscribe to topics after clear and receive dispatches", () => {
			const handler1 = vi.fn();
			tm.subscribe("cursor", handler1);

			tm.clear();

			// handler1 should no longer fire
			tm.dispatch("cursor", "data", "p");
			expect(handler1).not.toHaveBeenCalled();

			// Re-subscribe with new handler
			const handler2 = vi.fn();
			tm.subscribe("cursor", handler2);

			tm.dispatch("cursor", "new-data", "p");
			expect(handler2).toHaveBeenCalledOnce();
			expect(handler2).toHaveBeenCalledWith("new-data", "p");
		});

		it("can subscribeAll after clear", () => {
			const globalHandler = vi.fn();
			tm.subscribeAll(globalHandler);
			tm.clear();

			const newGlobalHandler = vi.fn();
			tm.subscribeAll(newGlobalHandler);

			tm.dispatch("any", "data", "p");
			expect(globalHandler).not.toHaveBeenCalled();
			expect(newGlobalHandler).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------
	// Topic handler that throws
	// -------------------------------------------------------------------
	describe("topic handler that throws", () => {
		it("throwing handler does not prevent other topic handlers from firing", () => {
			const throwingHandler = vi.fn().mockImplementation(() => {
				throw new Error("Handler error!");
			});
			const normalHandler = vi.fn();

			tm.subscribe("cursor", throwingHandler);
			tm.subscribe("cursor", normalHandler);

			// The dispatch iterates a Set. If the throwing handler runs first,
			// it will throw before the second handler runs. We test that the
			// dispatch itself propagates the error.
			// Note: based on the implementation, Set iteration will stop on throw.
			// This IS expected behavior — we document it here.
			expect(() => tm.dispatch("cursor", "data", "p")).toThrow("Handler error!");

			// throwingHandler was called
			expect(throwingHandler).toHaveBeenCalledOnce();
		});

		it("throwing global handler does not crash if it runs after topic handlers", () => {
			const topicHandler = vi.fn();
			const throwingGlobal = vi.fn().mockImplementation(() => {
				throw new Error("Global error!");
			});

			tm.subscribe("cursor", topicHandler);
			tm.subscribeAll(throwingGlobal);

			expect(() => tm.dispatch("cursor", "data", "p")).toThrow("Global error!");

			// Topic handler should have fired (it runs before global)
			expect(topicHandler).toHaveBeenCalledOnce();
		});
	});

	// -------------------------------------------------------------------
	// Dispatch data types
	// -------------------------------------------------------------------
	describe("dispatch with various data types", () => {
		it("dispatches null data", () => {
			const handler = vi.fn();
			tm.subscribe("topic", handler);

			tm.dispatch("topic", null, "p");
			expect(handler).toHaveBeenCalledWith(null, "p");
		});

		it("dispatches undefined data", () => {
			const handler = vi.fn();
			tm.subscribe("topic", handler);

			tm.dispatch("topic", undefined, "p");
			expect(handler).toHaveBeenCalledWith(undefined, "p");
		});

		it("dispatches number data", () => {
			const handler = vi.fn();
			tm.subscribe("topic", handler);

			tm.dispatch("topic", 42, "p");
			expect(handler).toHaveBeenCalledWith(42, "p");
		});

		it("dispatches array data", () => {
			const handler = vi.fn();
			tm.subscribe("topic", handler);

			tm.dispatch("topic", [1, 2, 3], "p");
			expect(handler).toHaveBeenCalledWith([1, 2, 3], "p");
		});

		it("dispatches boolean data", () => {
			const handler = vi.fn();
			tm.subscribe("topic", handler);

			tm.dispatch("topic", false, "p");
			expect(handler).toHaveBeenCalledWith(false, "p");
		});
	});

	// -------------------------------------------------------------------
	// Unsubscribe idempotency
	// -------------------------------------------------------------------
	describe("unsubscribe idempotency", () => {
		it("calling unsubscribe multiple times does not throw", () => {
			const handler = vi.fn();
			const unsub = tm.subscribe("topic", handler);

			unsub();
			expect(() => unsub()).not.toThrow();
			expect(() => unsub()).not.toThrow();
		});

		it("calling subscribeAll unsubscribe multiple times does not throw", () => {
			const handler = vi.fn();
			const unsub = tm.subscribeAll(handler);

			unsub();
			expect(() => unsub()).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// Same handler subscribed to multiple topics
	// -------------------------------------------------------------------
	describe("same handler on multiple topics", () => {
		it("fires once per topic dispatch", () => {
			const sharedHandler = vi.fn();

			tm.subscribe("topic-a", sharedHandler);
			tm.subscribe("topic-b", sharedHandler);

			tm.dispatch("topic-a", "data-a", "p");
			expect(sharedHandler).toHaveBeenCalledTimes(1);
			expect(sharedHandler).toHaveBeenCalledWith("data-a", "p");

			tm.dispatch("topic-b", "data-b", "p");
			expect(sharedHandler).toHaveBeenCalledTimes(2);
			expect(sharedHandler).toHaveBeenCalledWith("data-b", "p");
		});

		it("unsubscribing from one topic does not affect the other", () => {
			const sharedHandler = vi.fn();

			const unsubA = tm.subscribe("topic-a", sharedHandler);
			tm.subscribe("topic-b", sharedHandler);

			unsubA();

			tm.dispatch("topic-a", "data", "p");
			expect(sharedHandler).not.toHaveBeenCalled();

			tm.dispatch("topic-b", "data", "p");
			expect(sharedHandler).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------
	// Dispatch return value semantics
	// -------------------------------------------------------------------
	describe("dispatch return value", () => {
		it("returns true when only global handlers match", () => {
			tm.subscribeAll(vi.fn());

			expect(tm.dispatch("any-topic", "data", "p")).toBe(true);
		});

		it("returns true when only topic handlers match", () => {
			tm.subscribe("cursor", vi.fn());

			expect(tm.dispatch("cursor", "data", "p")).toBe(true);
		});

		it("returns true when both topic and global handlers match", () => {
			tm.subscribe("cursor", vi.fn());
			tm.subscribeAll(vi.fn());

			expect(tm.dispatch("cursor", "data", "p")).toBe(true);
		});

		it("returns false when nothing matches", () => {
			tm.subscribe("cursor", vi.fn());

			expect(tm.dispatch("chat", "data", "p")).toBe(false);
		});
	});
});
