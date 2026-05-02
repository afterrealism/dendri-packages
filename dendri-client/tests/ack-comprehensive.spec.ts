import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AckManager } from "../src/ack";

describe("AckManager — comprehensive", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// ACK with 0ms timeout — should reject on next tick
	// -----------------------------------------------------------------------

	it("rejects immediately (next tick) with 0ms timeout", async () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		const promise = mgr.waitForAck(ackId, 0);

		// setTimeout(fn, 0) fires on next timer advance
		vi.advanceTimersByTime(1);

		await expect(promise).rejects.toThrow(`ACK timeout for ${ackId}`);
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// ACK with very long timeout (60s) — verify timer is set
	// -----------------------------------------------------------------------

	it("sets a timer for 60s timeout and stays pending until then", () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		mgr.waitForAck(ackId, 60_000);

		// Still pending after 59s
		vi.advanceTimersByTime(59_000);
		expect(mgr.pendingCount).toBe(1);
	});

	it("rejects after 60s timeout fires", async () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		const promise = mgr.waitForAck(ackId, 60_000);

		vi.advanceTimersByTime(60_001);

		await expect(promise).rejects.toThrow(`ACK timeout for ${ackId}`);
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// 100 concurrent ACKs — all resolve independently
	// -----------------------------------------------------------------------

	it("handles 100 concurrent ACKs that all resolve independently", async () => {
		const mgr = new AckManager();
		const ids: string[] = [];
		const promises: Promise<void>[] = [];

		for (let i = 0; i < 100; i++) {
			const id = mgr.nextId();
			ids.push(id);
			promises.push(mgr.waitForAck(id, 10_000));
		}

		expect(mgr.pendingCount).toBe(100);

		// Resolve all in reverse order
		for (let i = 99; i >= 0; i--) {
			expect(mgr.handleAck(ids[i])).toBe(true);
		}

		await Promise.all(promises);
		expect(mgr.pendingCount).toBe(0);
	});

	it("handles 100 concurrent ACKs where some timeout", async () => {
		const mgr = new AckManager();
		const ids: string[] = [];
		const promises: Promise<void>[] = [];

		for (let i = 0; i < 100; i++) {
			const id = mgr.nextId();
			ids.push(id);
			promises.push(mgr.waitForAck(id, 5000));
		}

		// Resolve only first 50
		for (let i = 0; i < 50; i++) {
			mgr.handleAck(ids[i]);
		}

		expect(mgr.pendingCount).toBe(50);

		// Timeout the remaining 50
		vi.advanceTimersByTime(5001);

		const settled = await Promise.allSettled(promises);
		const fulfilled = settled.filter((r) => r.status === "fulfilled");
		const rejected = settled.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(50);
		expect(rejected).toHaveLength(50);

		for (const r of rejected) {
			expect((r as PromiseRejectedResult).reason).toBeInstanceOf(Error);
			expect((r as PromiseRejectedResult).reason.message).toContain("ACK timeout");
		}

		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// handleAck called twice for same ID (second returns false)
	// -----------------------------------------------------------------------

	it("returns false when handleAck is called twice for the same ID", async () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		const promise = mgr.waitForAck(ackId);

		expect(mgr.handleAck(ackId)).toBe(true);
		expect(mgr.handleAck(ackId)).toBe(false);

		await promise;
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// clear() while timeout is in progress (timer should be cleared)
	// -----------------------------------------------------------------------

	it("clears pending timers so they do not fire after clear()", async () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		const promise = mgr.waitForAck(ackId, 3000);

		mgr.clear();

		// Should be rejected with "Connection closed", not "ACK timeout"
		await expect(promise).rejects.toThrow("Connection closed");

		// Advancing timers should not cause any additional rejection
		vi.advanceTimersByTime(5000);
		expect(mgr.pendingCount).toBe(0);
	});

	it("clear() on manager with multiple active timers clears all", async () => {
		const mgr = new AckManager();
		const promises: Promise<void>[] = [];

		for (let i = 0; i < 5; i++) {
			const id = mgr.nextId();
			promises.push(mgr.waitForAck(id, 10_000));
		}

		expect(mgr.pendingCount).toBe(5);
		mgr.clear();
		expect(mgr.pendingCount).toBe(0);

		const settled = await Promise.allSettled(promises);
		for (const r of settled) {
			expect(r.status).toBe("rejected");
			expect((r as PromiseRejectedResult).reason.message).toBe("Connection closed");
		}

		// No timeout fires after clear
		vi.advanceTimersByTime(15_000);
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// nextId() generates unique IDs even when called rapidly
	// -----------------------------------------------------------------------

	it("generates unique IDs even when called in rapid succession", () => {
		const mgr = new AckManager();
		const ids = new Set<string>();

		for (let i = 0; i < 1000; i++) {
			ids.add(mgr.nextId());
		}

		expect(ids.size).toBe(1000);
	});

	it("IDs contain monotonically increasing counter", () => {
		const mgr = new AckManager();
		const counters: number[] = [];

		for (let i = 0; i < 10; i++) {
			const id = mgr.nextId();
			const counter = Number.parseInt(id.split("_")[1], 10);
			counters.push(counter);
		}

		for (let i = 1; i < counters.length; i++) {
			expect(counters[i]).toBeGreaterThan(counters[i - 1]);
		}
	});

	// -----------------------------------------------------------------------
	// ACK interleaving: send A, send B, ACK B, ACK A — both resolve correctly
	// -----------------------------------------------------------------------

	it("resolves interleaved ACKs in correct order", async () => {
		const mgr = new AckManager();
		const idA = mgr.nextId();
		const idB = mgr.nextId();

		const results: string[] = [];

		const promiseA = mgr.waitForAck(idA).then(() => {
			results.push("A");
		});
		const promiseB = mgr.waitForAck(idB).then(() => {
			results.push("B");
		});

		// ACK B first, then A
		expect(mgr.handleAck(idB)).toBe(true);
		expect(mgr.handleAck(idA)).toBe(true);

		await Promise.all([promiseA, promiseB]);

		// Both resolved — B resolved first
		expect(results).toContain("A");
		expect(results).toContain("B");
		expect(results[0]).toBe("B");
		expect(results[1]).toBe("A");
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Memory: after 1000 resolved ACKs, pendingCount should be 0
	// -----------------------------------------------------------------------

	it("has pendingCount 0 after resolving 1000 ACKs", async () => {
		const mgr = new AckManager();
		const promises: Promise<void>[] = [];

		for (let i = 0; i < 1000; i++) {
			const id = mgr.nextId();
			promises.push(mgr.waitForAck(id, 60_000));
			mgr.handleAck(id);
		}

		await Promise.all(promises);
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// waitForAck rejection message includes the ackId
	// -----------------------------------------------------------------------

	it("timeout rejection message includes the ackId", async () => {
		const mgr = new AckManager();
		const ackId = mgr.nextId();

		const promise = mgr.waitForAck(ackId, 100);

		vi.advanceTimersByTime(101);

		try {
			await promise;
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect((err as Error).message).toContain(ackId);
			expect((err as Error).message).toBe(`ACK timeout for ${ackId}`);
		}
	});

	it("timeout rejection for multiple ACKs includes each respective ackId", async () => {
		const mgr = new AckManager();
		const id1 = mgr.nextId();
		const id2 = mgr.nextId();

		const p1 = mgr.waitForAck(id1, 100);
		const p2 = mgr.waitForAck(id2, 100);

		vi.advanceTimersByTime(101);

		try {
			await p1;
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect((err as Error).message).toContain(id1);
		}

		try {
			await p2;
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect((err as Error).message).toContain(id2);
		}
	});
});
