import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, RpcErrorCode, RpcManager, type RpcRequest } from "../src/rpc";

describe("RpcManager — comprehensive", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// Large payload
	// -----------------------------------------------------------------------

	it("handles a 100KB string payload", async () => {
		const mgr = new RpcManager();
		const largePayload = "x".repeat(100 * 1024);
		let capturedId = "";

		mgr.registerMethod("echo", (payload) => payload);

		const sendFn = vi.fn((req: RpcRequest) => {
			capturedId = req.id;
		});

		const promise = mgr.performRpc("echo", largePayload, sendFn);

		// Simulate the request being handled locally and response returned
		const response = await mgr.handleRequest({
			__rpc: true,
			id: capturedId,
			method: "echo",
			payload: largePayload,
			sender: "peer-A",
		});

		mgr.handleResponse(response);

		await expect(promise).resolves.toBe(largePayload);
	});

	// -----------------------------------------------------------------------
	// Handler returning undefined
	// -----------------------------------------------------------------------

	it("resolves with undefined when handler returns undefined", async () => {
		const mgr = new RpcManager();
		mgr.registerMethod("noop", () => undefined);

		const response = await mgr.handleRequest({
			__rpc: true,
			id: "rpc_u1",
			method: "noop",
			payload: null,
			sender: "peer-A",
		});

		expect(response.__rpc_response).toBe(true);
		expect(response.result).toBeUndefined();
		expect(response.error).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// Handler returning a Promise rejecting with RpcError
	// -----------------------------------------------------------------------

	it("preserves RpcError code when async handler rejects with RpcError", async () => {
		const mgr = new RpcManager();
		mgr.registerMethod("async-rpc-error", async () => {
			throw new RpcError(RpcErrorCode.RESPONSE_PAYLOAD_TOO_LARGE, "Too big");
		});

		const response = await mgr.handleRequest({
			__rpc: true,
			id: "rpc_re1",
			method: "async-rpc-error",
			payload: null,
			sender: "peer-A",
		});

		expect(response.error).toBeDefined();
		expect(response.error!.code).toBe(RpcErrorCode.RESPONSE_PAYLOAD_TOO_LARGE);
		expect(response.error!.message).toBe("Too big");
	});

	// -----------------------------------------------------------------------
	// Handler that takes 9 seconds (just under default 10s timeout)
	// -----------------------------------------------------------------------

	it("resolves when handler completes at 9s (under default 10s timeout)", async () => {
		const mgr = new RpcManager();
		let capturedId = "";

		const sendFn = vi.fn((req: RpcRequest) => {
			capturedId = req.id;
		});

		const promise = mgr.performRpc("slow", "data", sendFn);

		// Advance 9 seconds — still within the 10s timeout
		vi.advanceTimersByTime(9000);
		expect(mgr.pendingCount).toBe(1);

		// Simulate the response arriving at 9s
		mgr.handleResponse({
			__rpc_response: true,
			id: capturedId,
			result: "done",
		});

		await expect(promise).resolves.toBe("done");
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Concurrent RPCs to different methods
	// -----------------------------------------------------------------------

	it("handles concurrent RPCs to different methods", async () => {
		const mgr = new RpcManager();
		const ids: string[] = [];

		const sendFn = vi.fn((req: RpcRequest) => {
			ids.push(req.id);
		});

		const p1 = mgr.performRpc("add", { a: 1, b: 2 }, sendFn);
		const p2 = mgr.performRpc("multiply", { a: 3, b: 4 }, sendFn);
		const p3 = mgr.performRpc("greet", "world", sendFn);

		expect(mgr.pendingCount).toBe(3);
		expect(ids).toHaveLength(3);

		mgr.handleResponse({ __rpc_response: true, id: ids[0], result: 3 });
		mgr.handleResponse({ __rpc_response: true, id: ids[1], result: 12 });
		mgr.handleResponse({ __rpc_response: true, id: ids[2], result: "Hello, world!" });

		await expect(p1).resolves.toBe(3);
		await expect(p2).resolves.toBe(12);
		await expect(p3).resolves.toBe("Hello, world!");
		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Concurrent RPCs to the same method
	// -----------------------------------------------------------------------

	it("handles concurrent RPCs to the same method independently", async () => {
		const mgr = new RpcManager();
		const ids: string[] = [];

		const sendFn = vi.fn((req: RpcRequest) => {
			ids.push(req.id);
		});

		const p1 = mgr.performRpc("echo", "first", sendFn);
		const p2 = mgr.performRpc("echo", "second", sendFn);
		const p3 = mgr.performRpc("echo", "third", sendFn);

		expect(mgr.pendingCount).toBe(3);

		// Resolve in reverse order
		mgr.handleResponse({ __rpc_response: true, id: ids[2], result: "third-result" });
		mgr.handleResponse({ __rpc_response: true, id: ids[0], result: "first-result" });
		mgr.handleResponse({ __rpc_response: true, id: ids[1], result: "second-result" });

		await expect(p1).resolves.toBe("first-result");
		await expect(p2).resolves.toBe("second-result");
		await expect(p3).resolves.toBe("third-result");
	});

	// -----------------------------------------------------------------------
	// registerMethod overwrites existing handler
	// -----------------------------------------------------------------------

	it("overwrites existing handler — old handler no longer called", async () => {
		const mgr = new RpcManager();
		const oldHandler = vi.fn().mockReturnValue("old");
		const newHandler = vi.fn().mockReturnValue("new");

		mgr.registerMethod("method", oldHandler);
		mgr.registerMethod("method", newHandler);

		const response = await mgr.handleRequest({
			__rpc: true,
			id: "rpc_ow1",
			method: "method",
			payload: "test",
			sender: "peer-A",
		});

		expect(newHandler).toHaveBeenCalledWith("test", "peer-A");
		expect(oldHandler).not.toHaveBeenCalled();
		expect(response.result).toBe("new");
	});

	// -----------------------------------------------------------------------
	// Unregister method then call it — METHOD_NOT_FOUND
	// -----------------------------------------------------------------------

	it("returns METHOD_NOT_FOUND after unregistering a method", async () => {
		const mgr = new RpcManager();
		const handler = vi.fn().mockReturnValue("ok");

		const unregister = mgr.registerMethod("temp", handler);
		unregister();

		const response = await mgr.handleRequest({
			__rpc: true,
			id: "rpc_unr1",
			method: "temp",
			payload: null,
			sender: "peer-A",
		});

		expect(handler).not.toHaveBeenCalled();
		expect(response.error).toBeDefined();
		expect(response.error!.code).toBe(RpcErrorCode.METHOD_NOT_FOUND);
		expect(response.error!.message).toContain("temp");
	});

	// -----------------------------------------------------------------------
	// performRpc with custom timeout — 1s
	// -----------------------------------------------------------------------

	it("respects custom timeout of 1s", async () => {
		const mgr = new RpcManager();
		const sendFn = vi.fn();

		const promise = mgr.performRpc("fast", null, sendFn, { timeout: 1000 });

		vi.advanceTimersByTime(999);
		expect(mgr.pendingCount).toBe(1);

		vi.advanceTimersByTime(2);

		await expect(promise).rejects.toThrow("RPC timeout: fast");

		try {
			await promise;
		} catch (err) {
			expect((err as RpcError).code).toBe(RpcErrorCode.RESPONSE_TIMEOUT);
		}
	});

	// -----------------------------------------------------------------------
	// performRpc with custom timeout — 30s
	// -----------------------------------------------------------------------

	it("respects custom timeout of 30s", async () => {
		const mgr = new RpcManager();
		let capturedId = "";

		const sendFn = vi.fn((req: RpcRequest) => {
			capturedId = req.id;
		});

		const promise = mgr.performRpc("long", null, sendFn, { timeout: 30_000 });

		// Should still be pending at 29s
		vi.advanceTimersByTime(29_000);
		expect(mgr.pendingCount).toBe(1);

		// Resolve before timeout
		mgr.handleResponse({ __rpc_response: true, id: capturedId, result: "finally" });

		await expect(promise).resolves.toBe("finally");
	});

	// -----------------------------------------------------------------------
	// RPC round-trip via simulated peers
	// -----------------------------------------------------------------------

	it("round-trips an RPC between two RpcManagers (simulated Room peers)", async () => {
		const mgrA = new RpcManager();
		const mgrB = new RpcManager();

		// Peer B registers a method
		mgrB.registerMethod("greet", (payload) => `Hello, ${payload}!`);

		let capturedRequest: RpcRequest | null = null;

		// Peer A calls the method; sendFn captures the request
		const promise = mgrA.performRpc("greet", "world", (req) => {
			capturedRequest = { ...req, sender: "peer-A" };
		});

		// Simulate transport: B receives the request, handles it, and sends response
		const response = await mgrB.handleRequest(capturedRequest!);

		// Simulate transport: A receives the response
		mgrA.handleResponse(response);

		await expect(promise).resolves.toBe("Hello, world!");
	});

	// -----------------------------------------------------------------------
	// handleResponse for already-resolved RPC (idempotent)
	// -----------------------------------------------------------------------

	it("returns false for handleResponse on an already-resolved RPC", async () => {
		const mgr = new RpcManager();
		let capturedId = "";

		const sendFn = vi.fn((req: RpcRequest) => {
			capturedId = req.id;
		});

		const promise = mgr.performRpc("test", null, sendFn);

		// First response resolves
		const first = mgr.handleResponse({
			__rpc_response: true,
			id: capturedId,
			result: "first",
		});
		expect(first).toBe(true);

		await expect(promise).resolves.toBe("first");

		// Second response is a no-op
		const second = mgr.handleResponse({
			__rpc_response: true,
			id: capturedId,
			result: "second",
		});
		expect(second).toBe(false);

		// Original promise still holds first value
		await expect(promise).resolves.toBe("first");
	});

	// -----------------------------------------------------------------------
	// RPC with binary/ArrayBuffer payload
	// -----------------------------------------------------------------------

	it("handles ArrayBuffer payload", async () => {
		const mgr = new RpcManager();
		const buffer = new ArrayBuffer(8);
		const view = new Uint8Array(buffer);
		view.set([1, 2, 3, 4, 5, 6, 7, 8]);

		mgr.registerMethod("binary", (payload) => {
			// Verify the payload is the same buffer content
			return (payload as ArrayBuffer).byteLength;
		});

		const response = await mgr.handleRequest({
			__rpc: true,
			id: "rpc_bin1",
			method: "binary",
			payload: buffer,
			sender: "peer-A",
		});

		expect(response.result).toBe(8);
		expect(response.error).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// 100 concurrent RPCs — all should resolve or timeout correctly
	// -----------------------------------------------------------------------

	it("handles 100 concurrent RPCs without interference", async () => {
		const mgr = new RpcManager();
		const rpcMap = new Map<string, { method: string; index: number }>();

		const sendFn = vi.fn((req: RpcRequest) => {
			rpcMap.set(req.id, { method: req.method, index: rpcMap.size });
		});

		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 100; i++) {
			promises.push(mgr.performRpc(`method_${i}`, i, sendFn));
		}

		expect(mgr.pendingCount).toBe(100);

		// Resolve all RPCs
		for (const [id, info] of rpcMap) {
			mgr.handleResponse({
				__rpc_response: true,
				id,
				result: `result_${info.index}`,
			});
		}

		const results = await Promise.all(promises);

		expect(results).toHaveLength(100);
		for (let i = 0; i < 100; i++) {
			expect(results[i]).toBe(`result_${i}`);
		}

		expect(mgr.pendingCount).toBe(0);
	});

	it("times out remaining RPCs when only some are resolved out of 100", async () => {
		const mgr = new RpcManager();
		const ids: string[] = [];

		const sendFn = vi.fn((req: RpcRequest) => {
			ids.push(req.id);
		});

		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 100; i++) {
			promises.push(mgr.performRpc("batch", i, sendFn, { timeout: 5000 }));
		}

		// Resolve only the first 50
		for (let i = 0; i < 50; i++) {
			mgr.handleResponse({
				__rpc_response: true,
				id: ids[i],
				result: `ok_${i}`,
			});
		}

		expect(mgr.pendingCount).toBe(50);

		// Timeout the rest
		vi.advanceTimersByTime(5001);

		const settled = await Promise.allSettled(promises);

		const fulfilled = settled.filter((r) => r.status === "fulfilled");
		const rejected = settled.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(50);
		expect(rejected).toHaveLength(50);

		for (const r of rejected) {
			const reason = (r as PromiseRejectedResult).reason;
			expect(reason).toBeInstanceOf(RpcError);
			expect((reason as RpcError).code).toBe(RpcErrorCode.RESPONSE_TIMEOUT);
		}

		expect(mgr.pendingCount).toBe(0);
	});

	// -----------------------------------------------------------------------
	// RPC error code propagation
	// -----------------------------------------------------------------------

	it("propagates custom error code 1500 from server to client", async () => {
		const mgr = new RpcManager();
		let capturedId = "";

		const sendFn = vi.fn((req: RpcRequest) => {
			capturedId = req.id;
		});

		const promise = mgr.performRpc("will-fail", null, sendFn);

		mgr.handleResponse({
			__rpc_response: true,
			id: capturedId,
			error: { code: 1500, message: "Application error" },
		});

		try {
			await promise;
			expect.unreachable("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(RpcError);
			expect((err as RpcError).code).toBe(1500);
			expect((err as RpcError).message).toBe("Application error");
		}
	});

	it("propagates all standard RpcErrorCode values", async () => {
		const codes = [
			RpcErrorCode.APPLICATION_ERROR,
			RpcErrorCode.CONNECTION_TIMEOUT,
			RpcErrorCode.RESPONSE_TIMEOUT,
			RpcErrorCode.RECIPIENT_DISCONNECTED,
			RpcErrorCode.RESPONSE_PAYLOAD_TOO_LARGE,
			RpcErrorCode.METHOD_NOT_FOUND,
		];

		for (const code of codes) {
			const mgr = new RpcManager();
			let capturedId = "";

			const sendFn = vi.fn((req: RpcRequest) => {
				capturedId = req.id;
			});

			const promise = mgr.performRpc("test", null, sendFn);

			mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				error: { code, message: `Error ${code}` },
			});

			try {
				await promise;
				expect.unreachable("Should have thrown");
			} catch (err) {
				expect((err as RpcError).code).toBe(code);
			}
		}
	});
});
