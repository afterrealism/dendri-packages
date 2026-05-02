import { AckManager } from "../src/ack";

describe("AckManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// nextId
	// -----------------------------------------------------------------------

	describe("nextId", () => {
		it("generates unique IDs", () => {
			const mgr = new AckManager();
			const ids = new Set<string>();

			for (let i = 0; i < 100; i++) {
				ids.add(mgr.nextId());
			}

			expect(ids.size).toBe(100);
		});

		it("includes a monotonically increasing counter", () => {
			const mgr = new AckManager();
			const id1 = mgr.nextId();
			const id2 = mgr.nextId();

			// Extract counter portion (ack_<counter>_<timestamp>)
			const counter1 = Number.parseInt(id1.split("_")[1], 10);
			const counter2 = Number.parseInt(id2.split("_")[1], 10);

			expect(counter2).toBeGreaterThan(counter1);
		});
	});

	// -----------------------------------------------------------------------
	// waitForAck + handleAck
	// -----------------------------------------------------------------------

	describe("waitForAck / handleAck", () => {
		it("resolves when handleAck is called with matching ID", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId);

			// Resolve the pending ACK.
			expect(mgr.handleAck(ackId)).toBe(true);

			await expect(promise).resolves.toBeUndefined();
		});

		it("rejects after timeout", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId, 1000);

			// Advance time past the timeout.
			vi.advanceTimersByTime(1001);

			await expect(promise).rejects.toThrow(`ACK timeout for ${ackId}`);
		});

		it("uses default timeout of 5000ms", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId);

			// Before default timeout — should still be pending.
			vi.advanceTimersByTime(4999);
			expect(mgr.pendingCount).toBe(1);

			// Past default timeout.
			vi.advanceTimersByTime(2);

			await expect(promise).rejects.toThrow("ACK timeout");
		});

		it("cleans up the pending entry after timeout", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId, 100);
			expect(mgr.pendingCount).toBe(1);

			vi.advanceTimersByTime(101);

			await expect(promise).rejects.toThrow("ACK timeout");
			expect(mgr.pendingCount).toBe(0);
		});

		it("cleans up the pending entry after resolution", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId);
			expect(mgr.pendingCount).toBe(1);

			mgr.handleAck(ackId);

			await promise;
			expect(mgr.pendingCount).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// handleAck with unknown ID
	// -----------------------------------------------------------------------

	describe("handleAck with unknown ID", () => {
		it("returns false for an unknown ackId", () => {
			const mgr = new AckManager();
			expect(mgr.handleAck("nonexistent_123")).toBe(false);
		});

		it("returns false for an already-resolved ackId", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId);
			mgr.handleAck(ackId);

			await promise;

			// Second call should return false.
			expect(mgr.handleAck(ackId)).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// clear
	// -----------------------------------------------------------------------

	describe("clear", () => {
		it("rejects all pending ACKs with 'Connection closed'", async () => {
			const mgr = new AckManager();
			const id1 = mgr.nextId();
			const id2 = mgr.nextId();
			const id3 = mgr.nextId();

			const p1 = mgr.waitForAck(id1);
			const p2 = mgr.waitForAck(id2);
			const p3 = mgr.waitForAck(id3);

			expect(mgr.pendingCount).toBe(3);

			mgr.clear();

			expect(mgr.pendingCount).toBe(0);

			await expect(p1).rejects.toThrow("Connection closed");
			await expect(p2).rejects.toThrow("Connection closed");
			await expect(p3).rejects.toThrow("Connection closed");
		});

		it("is safe to call on an empty manager", () => {
			const mgr = new AckManager();
			expect(() => mgr.clear()).not.toThrow();
			expect(mgr.pendingCount).toBe(0);
		});

		it("clears timeout timers so they do not fire after clear", async () => {
			const mgr = new AckManager();
			const ackId = mgr.nextId();

			const promise = mgr.waitForAck(ackId, 1000);
			mgr.clear();

			// The promise should already be rejected with "Connection closed"
			await expect(promise).rejects.toThrow("Connection closed");

			// Advancing timers should not cause issues (double-reject).
			vi.advanceTimersByTime(2000);

			// pendingCount stays 0.
			expect(mgr.pendingCount).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// pendingCount
	// -----------------------------------------------------------------------

	describe("pendingCount", () => {
		it("starts at 0", () => {
			const mgr = new AckManager();
			expect(mgr.pendingCount).toBe(0);
		});

		it("tracks multiple pending ACKs", () => {
			const mgr = new AckManager();

			const id1 = mgr.nextId();
			const id2 = mgr.nextId();

			mgr.waitForAck(id1);
			mgr.waitForAck(id2);

			expect(mgr.pendingCount).toBe(2);
		});

		it("decrements when ACKs are handled", async () => {
			const mgr = new AckManager();

			const id1 = mgr.nextId();
			const id2 = mgr.nextId();

			const p1 = mgr.waitForAck(id1);
			mgr.waitForAck(id2);

			expect(mgr.pendingCount).toBe(2);

			mgr.handleAck(id1);
			await p1;

			expect(mgr.pendingCount).toBe(1);
		});

		it("decrements on timeout", async () => {
			const mgr = new AckManager();

			const id1 = mgr.nextId();
			const id2 = mgr.nextId();

			const p1 = mgr.waitForAck(id1, 100);
			mgr.waitForAck(id2, 5000);

			expect(mgr.pendingCount).toBe(2);

			vi.advanceTimersByTime(101);

			await expect(p1).rejects.toThrow("ACK timeout");
			expect(mgr.pendingCount).toBe(1);
		});
	});
});
