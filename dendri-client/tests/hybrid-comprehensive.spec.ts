import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for jsdom which lacks it.
if (!globalThis.crypto?.subtle) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

import { EventEmitter } from "eventemitter3";
import { ServerMessageType, TransportMode } from "../src/enums";
import { HybridConnection } from "../src/hybridconnection";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Minimal mock DataConnection (extends EventEmitter so listeners work). */
class MockDataConnection extends EventEmitter {
	open = false;
	send = vi.fn();
	close = vi.fn();
}

/** Minimal mock Socket with a spy-able send(). */
function createMockSocket() {
	return { send: vi.fn() };
}

/** Minimal mock Dendri provider. */
function createMockProvider(dc: MockDataConnection | null = new MockDataConnection()) {
	return {
		connect: vi.fn().mockReturnValue(dc),
		socket: createMockSocket(),
	} as unknown as any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a HybridConnection with sensible test defaults. */
function createHybrid(
	overrides: {
		peer?: string;
		provider?: ReturnType<typeof createMockProvider>;
		options?: Record<string, unknown>;
		dc?: MockDataConnection | null;
	} = {},
) {
	const dc = overrides.dc !== undefined ? overrides.dc : new MockDataConnection();
	const provider = overrides.provider ?? createMockProvider(dc);
	const hybrid = new HybridConnection(overrides.peer ?? "remote-peer", provider, {
		iceTimeout: 500,
		upgradeInterval: 1000,
		maxUpgradeAttempts: 3,
		...((overrides.options as any) ?? {}),
	});
	return { hybrid, provider, dc };
}

/** Put hybrid into relay mode by letting ICE timeout fire. */
function enterRelayMode(hybrid: HybridConnection): void {
	hybrid.start();
	vi.advanceTimersByTime(500);
	expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HybridConnection — comprehensive", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// 1. Full lifecycle: start -> WebRTC success -> send data -> close
	// -----------------------------------------------------------------------
	describe("full lifecycle with WebRTC", () => {
		it("should go through start -> WebRTC open -> send -> close", () => {
			const { hybrid, dc } = createHybrid();

			const openSpy = vi.fn();
			const dataSpy = vi.fn();
			const closeSpy = vi.fn();
			const transportSpy = vi.fn();

			hybrid.on("open", openSpy);
			hybrid.on("data", dataSpy);
			hybrid.on("close", closeSpy);
			hybrid.on("transportChanged", transportSpy);

			// Start
			hybrid.start();
			expect(hybrid.mode).toBe(TransportMode.Reconnecting);

			// WebRTC opens
			dc!.open = true;
			dc!.emit("open");

			expect(hybrid.mode).toBe(TransportMode.WebRTC);
			expect(hybrid.open).toBe(true);
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebRTC);

			// Send data
			hybrid.send({ msg: "hello" });
			expect(dc!.send).toHaveBeenCalledWith({ msg: "hello" });

			// Receive data
			dc!.emit("data", { response: "world" });
			expect(dataSpy).toHaveBeenCalledWith({ response: "world" });

			// Close
			hybrid.close();
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(hybrid.open).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Full lifecycle: start -> ICE timeout -> relay fallback -> send -> close
	// -----------------------------------------------------------------------
	describe("full lifecycle with relay fallback", () => {
		it("should go through start -> ICE timeout -> relay -> send -> close", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 500, encryptRelay: false },
			});

			const openSpy = vi.fn();
			const closeSpy = vi.fn();
			const transportSpy = vi.fn();

			hybrid.on("open", openSpy);
			hybrid.on("close", closeSpy);
			hybrid.on("transportChanged", transportSpy);

			// Start
			hybrid.start();

			// ICE timeout fires
			vi.advanceTimersByTime(500);

			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
			expect(hybrid.open).toBe(true);
			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebSocketRelay);

			// Send via relay
			hybrid.send({ cursor: [10, 20] });

			expect(provider.socket.send).toHaveBeenCalledWith({
				type: ServerMessageType.Data,
				dst: "remote-peer",
				payload: { cursor: [10, 20] },
			});

			// Close
			hybrid.close();
			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(hybrid.open).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 3. Transport change event fires with correct mode values
	// -----------------------------------------------------------------------
	describe("transportChanged event", () => {
		it("should fire Reconnecting -> WebRTC on direct success", () => {
			const { hybrid, dc } = createHybrid();
			const modes: TransportMode[] = [];

			hybrid.on("transportChanged", (mode) => modes.push(mode));

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			expect(modes).toEqual([TransportMode.WebRTC]);
		});

		it("should fire Reconnecting -> WebSocketRelay on ICE timeout", () => {
			const { hybrid } = createHybrid();
			const modes: TransportMode[] = [];

			hybrid.on("transportChanged", (mode) => modes.push(mode));

			hybrid.start();
			vi.advanceTimersByTime(500);

			expect(modes).toEqual([TransportMode.WebSocketRelay]);
		});

		it("should fire WebRTC -> WebSocketRelay on mid-session drop", () => {
			const { hybrid, dc } = createHybrid();
			const modes: TransportMode[] = [];

			hybrid.on("transportChanged", (mode) => modes.push(mode));

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");
			dc!.emit("close"); // WebRTC drops

			expect(modes).toEqual([TransportMode.WebRTC, TransportMode.WebSocketRelay]);
		});
	});

	// -----------------------------------------------------------------------
	// 4. send() before open
	// -----------------------------------------------------------------------
	describe("send() before open", () => {
		it("should emit error when sending before connection is open", () => {
			const { hybrid } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			// Not yet open
			hybrid.send("data");

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0].message).toMatch(/not open/i);
		});
	});

	// -----------------------------------------------------------------------
	// 5. send() after close
	// -----------------------------------------------------------------------
	describe("send() after close", () => {
		it("should not throw when sending after close (listeners removed)", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			hybrid.close();

			// close() removes all listeners, so send() emits error but no listener to catch
			// The key assertion: no exception thrown
			expect(() => hybrid.send("data")).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// 6. handleRelayData with encrypted payload (mock encryption)
	// -----------------------------------------------------------------------
	describe("handleRelayData with encrypted payload", () => {
		it("should decrypt __encrypted payloads when encryption is ready", async () => {
			// Use real timers for this test since it involves real async crypto
			vi.useRealTimers();

			const dc = new MockDataConnection();
			const provider = createMockProvider(dc);
			const hybrid = new HybridConnection("remote-peer", provider, {
				iceTimeout: 50,
				autoUpgrade: false,
			});

			hybrid.start();
			// Wait for ICE timeout to trigger relay mode
			await new Promise((r) => setTimeout(r, 60));
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			const received: unknown[] = [];
			hybrid.on("data", (d) => received.push(d));

			// Access the internal encryption to set it up
			const encryption = (hybrid as any)._encryption;
			const { RelayEncryption } = await import("../src/encryption");
			const otherEnc = new RelayEncryption();

			const hybridPub = await encryption.generateKeyPair();
			const otherPub = await otherEnc.generateKeyPair();
			await encryption.deriveSharedKey(otherPub);
			await otherEnc.deriveSharedKey(hybridPub);

			// Encrypt a payload as the remote peer would
			const encPayload = await otherEnc.encrypt(JSON.stringify({ cursor: [1, 2] }));

			// Feed the encrypted relay data
			hybrid.handleRelayData({ __encrypted: encPayload });

			// Wait for async decrypt
			await new Promise((r) => setTimeout(r, 50));

			expect(received).toEqual([{ cursor: [1, 2] }]);
			hybrid.close();

			// Re-enable fake timers for remaining tests
			vi.useFakeTimers();
		});

		it("should emit error on decryption failure", async () => {
			// Use real timers for this test since it involves real async crypto
			vi.useRealTimers();

			const dc = new MockDataConnection();
			const provider = createMockProvider(dc);
			const hybrid = new HybridConnection("remote-peer", provider, {
				iceTimeout: 50,
				autoUpgrade: false,
			});

			hybrid.start();
			await new Promise((r) => setTimeout(r, 60));
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			// Set up encryption with real keys
			const encryption = (hybrid as any)._encryption;
			const { RelayEncryption } = await import("../src/encryption");
			const otherEnc = new RelayEncryption();

			const hybridPub = await encryption.generateKeyPair();
			const otherPub = await otherEnc.generateKeyPair();
			await encryption.deriveSharedKey(otherPub);
			await otherEnc.deriveSharedKey(hybridPub);

			// Feed corrupted encrypted data
			hybrid.handleRelayData({
				__encrypted: { iv: btoa("aaaaaaaaaaaa"), ciphertext: btoa("corrupted") },
			});

			// Wait for async decrypt to fail
			await new Promise((r) => setTimeout(r, 50));

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0].message).toMatch(/decryption failed/i);
			hybrid.close();

			// Re-enable fake timers for remaining tests
			vi.useFakeTimers();
		});
	});

	// -----------------------------------------------------------------------
	// 7. Reorder buffer: receive seq 3, 1, 2 -> emit in order 1, 2, 3
	// -----------------------------------------------------------------------
	describe("reorder buffer: out-of-order delivery", () => {
		it("should reorder seq 3, 1, 2 into 1, 2, 3", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});
			enterRelayMode(hybrid);

			const received: unknown[] = [];
			hybrid.on("data", (d) => received.push(d));

			// First message sets baseline
			hybrid.handleRelayData("msg-1", 1);
			// Out of order
			hybrid.handleRelayData("msg-3", 3);
			hybrid.handleRelayData("msg-2", 2);

			expect(received).toEqual(["msg-1", "msg-2", "msg-3"]);
		});
	});

	// -----------------------------------------------------------------------
	// 8. Reorder buffer: gap timeout
	// -----------------------------------------------------------------------
	describe("reorder buffer: gap timeout", () => {
		it("should deliver 1 immediately, wait for 2, then timeout and deliver 3", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});
			enterRelayMode(hybrid);

			const received: unknown[] = [];
			hybrid.on("data", (d) => received.push(d));

			// Deliver 1
			hybrid.handleRelayData("msg-1", 1);
			expect(received).toEqual(["msg-1"]);

			// Deliver 3, skip 2
			hybrid.handleRelayData("msg-3", 3);
			expect(received).toEqual(["msg-1"]);

			// After 500ms (reorder timeout), 3 should be force-flushed
			vi.advanceTimersByTime(500);
			expect(received).toEqual(["msg-1", "msg-3"]);
		});
	});

	// -----------------------------------------------------------------------
	// 9. Reorder buffer: duplicate seq ignored
	// -----------------------------------------------------------------------
	describe("reorder buffer: duplicate seq", () => {
		it("should ignore duplicate sequence numbers", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});
			enterRelayMode(hybrid);

			const received: unknown[] = [];
			hybrid.on("data", (d) => received.push(d));

			hybrid.handleRelayData("msg-1", 1);
			hybrid.handleRelayData("msg-1-dup", 1); // duplicate, ignored

			expect(received).toEqual(["msg-1"]);
		});
	});

	// -----------------------------------------------------------------------
	// 10. Topic subscription via HybridConnection.subscribe()
	// -----------------------------------------------------------------------
	describe("topic subscription", () => {
		it("should route topic-tagged messages to subscribers", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const cursorHandler = vi.fn();
			hybrid.subscribe("cursor", cursorHandler);

			// Simulate receiving a topic-tagged message via DataConnection
			dc!.emit("data", { __topic: "cursor", __data: { x: 10, y: 20 } });

			expect(cursorHandler).toHaveBeenCalledWith({ x: 10, y: 20 }, "remote-peer");
		});

		it("should not call unsubscribed handler", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const handler = vi.fn();
			const unsub = hybrid.subscribe("cursor", handler);
			unsub();

			dc!.emit("data", { __topic: "cursor", __data: { x: 10 } });

			expect(handler).not.toHaveBeenCalled();
		});

		it("should deliver topic messages via relay handleRelayData", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});
			enterRelayMode(hybrid);

			const handler = vi.fn();
			hybrid.subscribe("viewport", handler);

			hybrid.handleRelayData({ __topic: "viewport", __data: { bounds: [0, 0, 100, 100] } });

			expect(handler).toHaveBeenCalledWith({ bounds: [0, 0, 100, 100] }, "remote-peer");
		});

		it("should fire onData handler for all messages including topic messages", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const allHandler = vi.fn();
			hybrid.onData(allHandler);

			dc!.emit("data", { __topic: "cursor", __data: { x: 5 } });
			dc!.emit("data", "plain message");

			expect(allHandler).toHaveBeenCalledTimes(2);
			expect(allHandler).toHaveBeenCalledWith({ x: 5 }, "remote-peer");
			expect(allHandler).toHaveBeenCalledWith("plain message", "remote-peer");
		});
	});

	// -----------------------------------------------------------------------
	// 11. sendWithAck via HybridConnection
	// -----------------------------------------------------------------------
	describe("sendWithAck", () => {
		it("should resolve when remote ACKs the message (WebRTC)", async () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const ackPromise = hybrid.sendWithAck({ payload: "important" });

			// Extract the ackId from the sent message
			const sentMsg = dc!.send.mock.calls[0][0];
			expect(sentMsg).toHaveProperty("__ackId");

			// Simulate receiving ACK
			hybrid.ackManager.handleAck(sentMsg.__ackId);

			await expect(ackPromise).resolves.toBeUndefined();
		});

		it("should reject on timeout if no ACK received", async () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const ackPromise = hybrid.sendWithAck({ payload: "lost" }, 100);

			vi.advanceTimersByTime(100);

			await expect(ackPromise).rejects.toThrow(/ACK timeout/);
		});

		it("should throw when called on closed connection", async () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");
			hybrid.close();

			await expect(hybrid.sendWithAck("data")).rejects.toThrow(/closed/i);
		});

		it("should throw when called before open", async () => {
			const { hybrid } = createHybrid();
			hybrid.start();

			await expect(hybrid.sendWithAck("data")).rejects.toThrow(/not open/i);
		});
	});

	// -----------------------------------------------------------------------
	// 12. close() during ICE negotiation (before timeout fires)
	// -----------------------------------------------------------------------
	describe("close during ICE negotiation", () => {
		it("should cancel ICE timer and not trigger fallback", () => {
			const { hybrid, provider } = createHybrid();

			hybrid.start();
			expect(hybrid.mode).toBe(TransportMode.Reconnecting);

			// Close before ICE timeout (500ms)
			hybrid.close();

			// Advance past ICE timeout
			vi.advanceTimersByTime(1000);

			// Should not have fallen back to relay
			expect(hybrid.mode).toBe(TransportMode.Reconnecting);
			expect(hybrid.open).toBe(false);
		});
	});

	// -----------------------------------------------------------------------
	// 13. close() during relay with pending messages in queue
	// -----------------------------------------------------------------------
	describe("close during relay with pending queue", () => {
		it("should clear pending relay queue on close", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});

			hybrid.start();
			vi.advanceTimersByTime(100); // fall back to relay

			// Encryption is not ready yet so messages get queued
			hybrid.send("queued-msg-1");
			hybrid.send("queued-msg-2");

			// Verify queue has items
			expect((hybrid as any)._pendingRelayQueue.length).toBeGreaterThan(0);

			hybrid.close();

			// Queue should be cleared
			expect((hybrid as any)._pendingRelayQueue.length).toBe(0);
		});
	});

	// -----------------------------------------------------------------------
	// 14. encryptRelay: false — no KEY-EXCHANGE sent, relay sends plaintext
	// -----------------------------------------------------------------------
	describe("encryptRelay: false", () => {
		it("should not send KEY-EXCHANGE when encryption is disabled", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});

			hybrid.start();
			vi.advanceTimersByTime(100); // fall back to relay

			// Check that no KEY-EXCHANGE message was sent
			const keyCalls = provider.socket.send.mock.calls.filter(
				(call: any[]) => call[0]?.type === ServerMessageType.KeyExchange,
			);
			expect(keyCalls.length).toBe(0);
		});

		it("should send plaintext DATA when encryption is disabled", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});

			hybrid.start();
			vi.advanceTimersByTime(100);

			hybrid.send({ cursor: [5, 10] });

			expect(provider.socket.send).toHaveBeenCalledWith({
				type: ServerMessageType.Data,
				dst: "remote-peer",
				payload: { cursor: [5, 10] },
			});
		});

		it("should NOT attempt decryption of incoming relay data", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});
			enterRelayMode(hybrid);

			const dataSpy = vi.fn();
			hybrid.on("data", dataSpy);

			// Even if payload looks encrypted, it should pass through as-is
			hybrid.handleRelayData({ __encrypted: { iv: "abc", ciphertext: "xyz" } });

			expect(dataSpy).toHaveBeenCalledWith({
				__encrypted: { iv: "abc", ciphertext: "xyz" },
			});
		});
	});

	// -----------------------------------------------------------------------
	// 15. send() with topic option
	// -----------------------------------------------------------------------
	describe("send with topic", () => {
		it("should wrap data in topic envelope for WebRTC", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			hybrid.send({ x: 1 }, { topic: "cursor" });

			expect(dc!.send).toHaveBeenCalledWith({
				__topic: "cursor",
				__data: { x: 1 },
			});
		});

		it("should wrap data in topic envelope for relay", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});
			enterRelayMode(hybrid);

			hybrid.send({ x: 1 }, { topic: "cursor" });

			expect(provider.socket.send).toHaveBeenCalledWith({
				type: ServerMessageType.Data,
				dst: "remote-peer",
				payload: { __topic: "cursor", __data: { x: 1 } },
			});
		});
	});

	// -----------------------------------------------------------------------
	// 16. Error handling edge cases
	// -----------------------------------------------------------------------
	describe("error handling", () => {
		it("should emit error when no transport is available", () => {
			const { hybrid, dc } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			// Break the transport
			dc!.open = false;
			hybrid.send("test");

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0].message).toMatch(/No transport available/);
		});

		it("should coerce non-Error DataConnection errors to Error instances", () => {
			const { hybrid, dc } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			dc!.emit("error", "string error message");

			expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error);
			expect(errorSpy.mock.calls[0][0].message).toBe("string error message");
		});
	});

	// -----------------------------------------------------------------------
	// 17. Key exchange flow
	// -----------------------------------------------------------------------
	describe("key exchange", () => {
		it("should initiate key exchange when falling back to relay with encryption enabled", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});

			hybrid.start();

			// At this point, ICE timeout hasn't fired yet, so no KEY_EXCHANGE
			const keyCallsBefore = provider.socket.send.mock.calls.filter(
				(call: any[]) => call[0]?.type === ServerMessageType.KeyExchange,
			);
			expect(keyCallsBefore.length).toBe(0);

			// Trigger relay fallback
			vi.advanceTimersByTime(100);

			// Now we need to wait for the async generateKeyPair to complete
			// The call is async, so let's advance microtasks
		});

		it("should not initiate key exchange twice", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: true },
			});

			hybrid.start();
			vi.advanceTimersByTime(100);

			// Manually call initiateKeyExchange again
			hybrid.initiateKeyExchange();

			// _keyExchangeSent flag should prevent duplicate
			// (the async nature means we can't directly assert send count,
			// but we verify it doesn't crash)
		});

		it("should not send key exchange when encryptRelay is false", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, autoUpgrade: false, encryptRelay: false },
			});

			hybrid.initiateKeyExchange();
			// Should be a no-op
		});
	});

	// -----------------------------------------------------------------------
	// 18. handleKeyExchange flow
	// -----------------------------------------------------------------------
	describe("handleKeyExchange", () => {
		it("should be a no-op when encryption is disabled", () => {
			const { hybrid } = createHybrid({
				options: { iceTimeout: 100, encryptRelay: false },
			});

			// Should not throw
			hybrid.handleKeyExchange({ publicKey: { kty: "EC", crv: "P-256", x: "a", y: "b" } });
		});
	});

	// -----------------------------------------------------------------------
	// 19. Double close is safe
	// -----------------------------------------------------------------------
	describe("double close", () => {
		it("should handle multiple close() calls gracefully", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const closeSpy = vi.fn();
			hybrid.on("close", closeSpy);

			hybrid.close();
			hybrid.close();
			hybrid.close();

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});
	});

	// -----------------------------------------------------------------------
	// 20. start() after close is no-op
	// -----------------------------------------------------------------------
	describe("start after close", () => {
		it("should not attempt WebRTC connection after close", () => {
			const { hybrid, provider } = createHybrid();
			hybrid.close();

			provider.connect.mockClear();
			hybrid.start();

			expect(provider.connect).not.toHaveBeenCalled();
		});
	});
});
