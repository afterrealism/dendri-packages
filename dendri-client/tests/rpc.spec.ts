import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isRpcRequest,
	isRpcResponse,
	RpcError,
	RpcErrorCode,
	RpcManager,
	type RpcRequest,
	type RpcResponse,
} from "../src/rpc";

describe("RpcManager", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// registerMethod
	// -----------------------------------------------------------------------

	describe("registerMethod", () => {
		it("stores a handler and returns an unregister function", () => {
			const mgr = new RpcManager();
			const handler = vi.fn();

			const unregister = mgr.registerMethod("greet", handler);

			expect(mgr.registeredMethods).toContain("greet");

			unregister();

			expect(mgr.registeredMethods).not.toContain("greet");
		});

		it("overwrites a previous handler for the same method name", async () => {
			const mgr = new RpcManager();
			const first = vi.fn().mockReturnValue("first");
			const second = vi.fn().mockReturnValue("second");

			mgr.registerMethod("echo", first);
			mgr.registerMethod("echo", second);

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_1",
				method: "echo",
				payload: null,
				sender: "peer-A",
			});

			expect(second).toHaveBeenCalled();
			expect(first).not.toHaveBeenCalled();
			expect(response.result).toBe("second");
		});
	});

	// -----------------------------------------------------------------------
	// performRpc
	// -----------------------------------------------------------------------

	describe("performRpc", () => {
		it("sends a request with correct format via sendFn", () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			mgr.performRpc("greet", { name: "world" }, sendFn);

			expect(sendFn).toHaveBeenCalledTimes(1);

			const sent: RpcRequest = sendFn.mock.calls[0][0];
			expect(sent.__rpc).toBe(true);
			expect(sent.method).toBe("greet");
			expect(sent.payload).toEqual({ name: "world" });
			expect(sent.id).toMatch(/^rpc_\d+_\d+$/);
			expect(sent.sender).toBe(""); // filled by caller
		});

		it("resolves when a matching response is received", async () => {
			const mgr = new RpcManager();
			let capturedId = "";

			const sendFn = vi.fn((req: RpcRequest) => {
				capturedId = req.id;
			});

			const promise = mgr.performRpc("greet", "world", sendFn);

			// Simulate response arriving
			mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				result: "Hello, world!",
			});

			await expect(promise).resolves.toBe("Hello, world!");
		});

		it("rejects on timeout with RESPONSE_TIMEOUT", async () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			const promise = mgr.performRpc("slow", null, sendFn, { timeout: 5000 });

			vi.advanceTimersByTime(5001);

			await expect(promise).rejects.toThrow("RPC timeout: slow");
			await expect(promise).rejects.toBeInstanceOf(RpcError);

			try {
				await promise;
			} catch (err) {
				expect((err as RpcError).code).toBe(RpcErrorCode.RESPONSE_TIMEOUT);
			}
		});

		it("uses default timeout of 10000ms", async () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			const promise = mgr.performRpc("slow", null, sendFn);

			// Before default timeout -- should still be pending
			vi.advanceTimersByTime(9999);
			expect(mgr.pendingCount).toBe(1);

			// Past default timeout
			vi.advanceTimersByTime(2);

			await expect(promise).rejects.toThrow("RPC timeout");
		});

		it("rejects with RpcError when response has error", async () => {
			const mgr = new RpcManager();
			let capturedId = "";

			const sendFn = vi.fn((req: RpcRequest) => {
				capturedId = req.id;
			});

			const promise = mgr.performRpc("fail", null, sendFn);

			mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				error: { code: RpcErrorCode.APPLICATION_ERROR, message: "Something broke" },
			});

			await expect(promise).rejects.toThrow("Something broke");
			await expect(promise).rejects.toBeInstanceOf(RpcError);

			try {
				await promise;
			} catch (err) {
				expect((err as RpcError).code).toBe(RpcErrorCode.APPLICATION_ERROR);
			}
		});

		it("generates unique IDs across calls", () => {
			const mgr = new RpcManager();
			const ids = new Set<string>();

			for (let i = 0; i < 50; i++) {
				const sendFn = vi.fn((req: RpcRequest) => {
					ids.add(req.id);
				});
				mgr.performRpc("method", null, sendFn);
			}

			expect(ids.size).toBe(50);
		});
	});

	// -----------------------------------------------------------------------
	// handleRequest
	// -----------------------------------------------------------------------

	describe("handleRequest", () => {
		it("returns METHOD_NOT_FOUND for an unknown method", async () => {
			const mgr = new RpcManager();

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_1",
				method: "nonexistent",
				payload: null,
				sender: "peer-A",
			});

			expect(response.__rpc_response).toBe(true);
			expect(response.id).toBe("rpc_1");
			expect(response.error).toBeDefined();
			expect(response.error!.code).toBe(RpcErrorCode.METHOD_NOT_FOUND);
			expect(response.error!.message).toContain("nonexistent");
			expect(response.result).toBeUndefined();
		});

		it("returns APPLICATION_ERROR when handler throws a plain Error", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("boom", () => {
				throw new Error("Kaboom!");
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_2",
				method: "boom",
				payload: null,
				sender: "peer-A",
			});

			expect(response.error).toBeDefined();
			expect(response.error!.code).toBe(RpcErrorCode.APPLICATION_ERROR);
			expect(response.error!.message).toBe("Kaboom!");
		});

		it("preserves RpcError code when handler throws an RpcError", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("custom-error", () => {
				throw new RpcError(RpcErrorCode.RESPONSE_PAYLOAD_TOO_LARGE, "Payload too big");
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_3",
				method: "custom-error",
				payload: null,
				sender: "peer-A",
			});

			expect(response.error).toBeDefined();
			expect(response.error!.code).toBe(RpcErrorCode.RESPONSE_PAYLOAD_TOO_LARGE);
			expect(response.error!.message).toBe("Payload too big");
		});

		it("returns result on success", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("add", (payload) => {
				const { a, b } = payload as { a: number; b: number };
				return a + b;
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_4",
				method: "add",
				payload: { a: 3, b: 7 },
				sender: "peer-A",
			});

			expect(response.__rpc_response).toBe(true);
			expect(response.id).toBe("rpc_4");
			expect(response.result).toBe(10);
			expect(response.error).toBeUndefined();
		});

		it("passes sender to the handler", async () => {
			const mgr = new RpcManager();
			const handler = vi.fn().mockReturnValue("ok");
			mgr.registerMethod("check-sender", handler);

			await mgr.handleRequest({
				__rpc: true,
				id: "rpc_5",
				method: "check-sender",
				payload: "data",
				sender: "peer-B",
			});

			expect(handler).toHaveBeenCalledWith("data", "peer-B");
		});

		it("supports async handlers", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("async-method", async (payload) => {
				return `processed: ${payload}`;
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_6",
				method: "async-method",
				payload: "input",
				sender: "peer-A",
			});

			expect(response.result).toBe("processed: input");
			expect(response.error).toBeUndefined();
		});

		it("handles async handler rejection", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("async-fail", async () => {
				throw new Error("Async failure");
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_7",
				method: "async-fail",
				payload: null,
				sender: "peer-A",
			});

			expect(response.error).toBeDefined();
			expect(response.error!.code).toBe(RpcErrorCode.APPLICATION_ERROR);
			expect(response.error!.message).toBe("Async failure");
		});

		it("handles non-Error throws (string)", async () => {
			const mgr = new RpcManager();
			mgr.registerMethod("throw-string", () => {
				throw "a string error";
			});

			const response = await mgr.handleRequest({
				__rpc: true,
				id: "rpc_8",
				method: "throw-string",
				payload: null,
				sender: "peer-A",
			});

			expect(response.error).toBeDefined();
			expect(response.error!.code).toBe(RpcErrorCode.APPLICATION_ERROR);
			expect(response.error!.message).toBe("a string error");
		});
	});

	// -----------------------------------------------------------------------
	// handleResponse
	// -----------------------------------------------------------------------

	describe("handleResponse", () => {
		it("resolves a pending RPC and returns true", async () => {
			const mgr = new RpcManager();
			let capturedId = "";

			const sendFn = vi.fn((req: RpcRequest) => {
				capturedId = req.id;
			});

			const promise = mgr.performRpc("test", null, sendFn);

			const handled = mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				result: 42,
			});

			expect(handled).toBe(true);
			await expect(promise).resolves.toBe(42);
		});

		it("returns false for an unknown response id", () => {
			const mgr = new RpcManager();

			const handled = mgr.handleResponse({
				__rpc_response: true,
				id: "nonexistent_123",
				result: null,
			});

			expect(handled).toBe(false);
		});

		it("returns false for an already-resolved id", async () => {
			const mgr = new RpcManager();
			let capturedId = "";

			const sendFn = vi.fn((req: RpcRequest) => {
				capturedId = req.id;
			});

			const promise = mgr.performRpc("test", null, sendFn);

			mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				result: "first",
			});

			await promise;

			// Second call should return false
			const handled = mgr.handleResponse({
				__rpc_response: true,
				id: capturedId,
				result: "second",
			});

			expect(handled).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// clear
	// -----------------------------------------------------------------------

	describe("clear", () => {
		it("rejects all pending RPCs with CONNECTION_TIMEOUT", async () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			const p1 = mgr.performRpc("a", null, sendFn);
			const p2 = mgr.performRpc("b", null, sendFn);
			const p3 = mgr.performRpc("c", null, sendFn);

			expect(mgr.pendingCount).toBe(3);

			mgr.clear();

			expect(mgr.pendingCount).toBe(0);

			await expect(p1).rejects.toThrow("Connection closed");
			await expect(p2).rejects.toThrow("Connection closed");
			await expect(p3).rejects.toThrow("Connection closed");

			// Verify the error code
			try {
				await p1;
			} catch (err) {
				expect((err as RpcError).code).toBe(RpcErrorCode.CONNECTION_TIMEOUT);
			}
		});

		it("is safe to call on an empty manager", () => {
			const mgr = new RpcManager();
			expect(() => mgr.clear()).not.toThrow();
			expect(mgr.pendingCount).toBe(0);
		});

		it("clears timeout timers so they do not fire after clear", async () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			const promise = mgr.performRpc("test", null, sendFn, { timeout: 1000 });

			mgr.clear();

			// Should be rejected with "Connection closed" (not timeout)
			await expect(promise).rejects.toThrow("Connection closed");

			// Advancing timers should not cause issues (double-reject)
			vi.advanceTimersByTime(2000);

			expect(mgr.pendingCount).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// pendingCount
	// -----------------------------------------------------------------------

	describe("pendingCount", () => {
		it("starts at 0", () => {
			const mgr = new RpcManager();
			expect(mgr.pendingCount).toBe(0);
		});

		it("tracks multiple pending RPCs", () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			mgr.performRpc("a", null, sendFn);
			mgr.performRpc("b", null, sendFn);

			expect(mgr.pendingCount).toBe(2);
		});

		it("decrements when responses are handled", async () => {
			const mgr = new RpcManager();
			const ids: string[] = [];
			const sendFn = vi.fn((req: RpcRequest) => {
				ids.push(req.id);
			});

			const p1 = mgr.performRpc("a", null, sendFn);
			mgr.performRpc("b", null, sendFn);

			expect(mgr.pendingCount).toBe(2);

			mgr.handleResponse({ __rpc_response: true, id: ids[0], result: "ok" });
			await p1;

			expect(mgr.pendingCount).toBe(1);
		});

		it("decrements on timeout", async () => {
			const mgr = new RpcManager();
			const sendFn = vi.fn();

			const p1 = mgr.performRpc("a", null, sendFn, { timeout: 100 });
			mgr.performRpc("b", null, sendFn, { timeout: 5000 });

			expect(mgr.pendingCount).toBe(2);

			vi.advanceTimersByTime(101);

			await expect(p1).rejects.toThrow("RPC timeout");
			expect(mgr.pendingCount).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// registeredMethods
	// -----------------------------------------------------------------------

	describe("registeredMethods", () => {
		it("returns empty array initially", () => {
			const mgr = new RpcManager();
			expect(mgr.registeredMethods).toEqual([]);
		});

		it("returns names of all registered methods", () => {
			const mgr = new RpcManager();
			mgr.registerMethod("greet", () => "hi");
			mgr.registerMethod("add", () => 0);
			mgr.registerMethod("echo", (p) => p);

			expect(mgr.registeredMethods).toEqual(expect.arrayContaining(["greet", "add", "echo"]));
			expect(mgr.registeredMethods).toHaveLength(3);
		});

		it("reflects unregistrations", () => {
			const mgr = new RpcManager();
			const unsub = mgr.registerMethod("temp", () => null);

			expect(mgr.registeredMethods).toContain("temp");

			unsub();

			expect(mgr.registeredMethods).not.toContain("temp");
		});
	});
});

// ---------------------------------------------------------------------------
// RpcError
// ---------------------------------------------------------------------------

describe("RpcError", () => {
	it("has correct code and message", () => {
		const err = new RpcError(RpcErrorCode.METHOD_NOT_FOUND, "No such method");

		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(RpcError);
		expect(err.name).toBe("RpcError");
		expect(err.code).toBe(RpcErrorCode.METHOD_NOT_FOUND);
		expect(err.message).toBe("No such method");
	});

	it("is catchable as an Error", () => {
		const err = new RpcError(1500, "test");

		try {
			throw err;
		} catch (e) {
			expect(e).toBeInstanceOf(Error);
			expect((e as RpcError).code).toBe(1500);
		}
	});
});

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

describe("isRpcRequest", () => {
	it("returns true for a valid RPC request", () => {
		expect(
			isRpcRequest({
				__rpc: true,
				id: "rpc_1_1234",
				method: "greet",
				payload: "hello",
				sender: "peer-A",
			}),
		).toBe(true);
	});

	it("returns false for null", () => {
		expect(isRpcRequest(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isRpcRequest(undefined)).toBe(false);
	});

	it("returns false for a string", () => {
		expect(isRpcRequest("hello")).toBe(false);
	});

	it("returns false for an object without __rpc", () => {
		expect(isRpcRequest({ id: "rpc_1", method: "greet" })).toBe(false);
	});

	it("returns false when __rpc is not true", () => {
		expect(isRpcRequest({ __rpc: false, id: "rpc_1", method: "greet" })).toBe(false);
	});

	it("returns false for an RPC response", () => {
		expect(isRpcRequest({ __rpc_response: true, id: "rpc_1", result: 42 })).toBe(false);
	});
});

describe("isRpcResponse", () => {
	it("returns true for a valid RPC response with result", () => {
		expect(
			isRpcResponse({
				__rpc_response: true,
				id: "rpc_1_1234",
				result: 42,
			}),
		).toBe(true);
	});

	it("returns true for a valid RPC response with error", () => {
		expect(
			isRpcResponse({
				__rpc_response: true,
				id: "rpc_1_1234",
				error: { code: 1500, message: "fail" },
			}),
		).toBe(true);
	});

	it("returns false for null", () => {
		expect(isRpcResponse(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isRpcResponse(undefined)).toBe(false);
	});

	it("returns false for a string", () => {
		expect(isRpcResponse("hello")).toBe(false);
	});

	it("returns false for an object without __rpc_response", () => {
		expect(isRpcResponse({ id: "rpc_1", result: 42 })).toBe(false);
	});

	it("returns false when __rpc_response is not true", () => {
		expect(isRpcResponse({ __rpc_response: false, id: "rpc_1", result: 42 })).toBe(false);
	});

	it("returns false for an RPC request", () => {
		expect(
			isRpcResponse({
				__rpc: true,
				id: "rpc_1",
				method: "greet",
				payload: null,
				sender: "peer-A",
			}),
		).toBe(false);
	});
});
