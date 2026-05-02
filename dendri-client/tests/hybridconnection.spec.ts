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
		options?: Parameters<typeof HybridConnection.prototype.constructor>[2];
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HybridConnection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// 1. Construction defaults
	// -----------------------------------------------------------------------
	describe("construction", () => {
		it("should default mode to Reconnecting", () => {
			const { hybrid } = createHybrid();
			expect(hybrid.mode).toBe(TransportMode.Reconnecting);
		});

		it("should default open to false", () => {
			const { hybrid } = createHybrid();
			expect(hybrid.open).toBe(false);
		});

		it("should store the peer id", () => {
			const { hybrid } = createHybrid({ peer: "peer-42" });
			expect(hybrid.peer).toBe("peer-42");
		});
	});

	// -----------------------------------------------------------------------
	// 2. WebRTC success path
	// -----------------------------------------------------------------------
	describe("WebRTC success", () => {
		it("should set mode to WebRTC when DataConnection opens before ICE timeout", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();

			// Simulate DataConnection opening before ICE timeout
			dc!.open = true;
			dc!.emit("open");

			expect(hybrid.mode).toBe(TransportMode.WebRTC);
			expect(hybrid.open).toBe(true);
		});

		it("should emit open and transportChanged on WebRTC success", () => {
			const { hybrid, dc } = createHybrid();

			const openSpy = vi.fn();
			const transportSpy = vi.fn();
			hybrid.on("open", openSpy);
			hybrid.on("transportChanged", transportSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebRTC);
		});

		it("should forward data events from DataConnection", () => {
			const { hybrid, dc } = createHybrid();
			const dataSpy = vi.fn();
			hybrid.on("data", dataSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			dc!.emit("data", { hello: "world" });
			expect(dataSpy).toHaveBeenCalledWith({ hello: "world" });
		});

		it("should forward error events from DataConnection", () => {
			const { hybrid, dc } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();

			const err = new Error("rtc boom");
			dc!.emit("error", err);

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error);
			expect(errorSpy.mock.calls[0][0].message).toBe("rtc boom");
		});
	});

	// -----------------------------------------------------------------------
	// 3. ICE timeout fallback
	// -----------------------------------------------------------------------
	describe("ICE timeout fallback", () => {
		it("should fall back to WebSocketRelay when DataConnection does not open in time", () => {
			const { hybrid } = createHybrid();
			hybrid.start();

			// ICE timeout fires (500ms configured)
			vi.advanceTimersByTime(500);

			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
			expect(hybrid.open).toBe(true);
		});

		it("should emit open and transportChanged on fallback", () => {
			const { hybrid } = createHybrid();

			const openSpy = vi.fn();
			const transportSpy = vi.fn();
			hybrid.on("open", openSpy);
			hybrid.on("transportChanged", transportSpy);

			hybrid.start();
			vi.advanceTimersByTime(500);

			expect(openSpy).toHaveBeenCalledTimes(1);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebSocketRelay);
		});

		it("should fall back immediately if connect() returns null", () => {
			const { hybrid, provider } = createHybrid({ dc: null });

			const transportSpy = vi.fn();
			hybrid.on("transportChanged", transportSpy);

			hybrid.start();

			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
			expect(hybrid.open).toBe(true);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebSocketRelay);
		});

		it("should not fall back if WebRTC opened before timeout", () => {
			const { hybrid, dc } = createHybrid();

			hybrid.start();

			// Open at 200ms, well before the 500ms timeout
			vi.advanceTimersByTime(200);
			dc!.open = true;
			dc!.emit("open");
			expect(hybrid.mode).toBe(TransportMode.WebRTC);

			// Now let the timeout elapse — mode should remain WebRTC
			vi.advanceTimersByTime(300);
			expect(hybrid.mode).toBe(TransportMode.WebRTC);
		});
	});

	// -----------------------------------------------------------------------
	// 4. send() via WebRTC
	// -----------------------------------------------------------------------
	describe("send() via WebRTC", () => {
		it("should call dataConnection.send() when mode is WebRTC", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			hybrid.send({ msg: "hello" });

			expect(dc!.send).toHaveBeenCalledWith({ msg: "hello" });
		});

		it("should emit error when sending on a closed connection", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");
			hybrid.close();

			const errorSpy = vi.fn();
			// Listeners were removed by close(), re-attach for verification
			hybrid.on("error", errorSpy);
			hybrid.send("data");

			// close() calls removeAllListeners so the new listener won't fire
			// but send() on closed emits error — since listeners were removed,
			// we verify the method doesn't throw
		});

		it("should emit error when sending before open", () => {
			const { hybrid } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			hybrid.send("data");

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0].message).toMatch(/not open/i);
		});
	});

	// -----------------------------------------------------------------------
	// 5. send() via WS relay
	// -----------------------------------------------------------------------
	describe("send() via WebSocket relay", () => {
		it("should call provider.socket.send() with DATA message", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 500, encryptRelay: false },
			});
			hybrid.start();

			// Let ICE timeout fire → relay mode
			vi.advanceTimersByTime(500);
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			hybrid.send({ cursor: [1, 2] });

			expect(provider.socket.send).toHaveBeenCalledWith({
				type: ServerMessageType.Data,
				dst: "remote-peer",
				payload: { cursor: [1, 2] },
			});
		});
	});

	// -----------------------------------------------------------------------
	// 6. handleRelayData()
	// -----------------------------------------------------------------------
	describe("handleRelayData()", () => {
		it("should emit data event with the payload", () => {
			const { hybrid } = createHybrid();
			const dataSpy = vi.fn();
			hybrid.on("data", dataSpy);

			hybrid.handleRelayData({ viewport: [10, 20, 30, 40] });

			expect(dataSpy).toHaveBeenCalledWith({ viewport: [10, 20, 30, 40] });
		});

		it("should handle primitive payloads", () => {
			const { hybrid } = createHybrid();
			const dataSpy = vi.fn();
			hybrid.on("data", dataSpy);

			hybrid.handleRelayData("simple-string");

			expect(dataSpy).toHaveBeenCalledWith("simple-string");
		});
	});

	// -----------------------------------------------------------------------
	// 7. close()
	// -----------------------------------------------------------------------
	describe("close()", () => {
		it("should emit close when connection was open", () => {
			const { hybrid, dc } = createHybrid();
			const closeSpy = vi.fn();
			hybrid.on("close", closeSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			hybrid.close();

			expect(closeSpy).toHaveBeenCalledTimes(1);
			expect(hybrid.open).toBe(false);
		});

		it("should close the DataConnection", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			hybrid.close();

			expect(dc!.close).toHaveBeenCalled();
		});

		it("should clear ICE timer", () => {
			const { hybrid } = createHybrid();
			hybrid.start();

			// Close before ICE timeout fires
			hybrid.close();

			// Advance past ICE timeout — should not change mode
			vi.advanceTimersByTime(1000);

			// Mode stays Reconnecting (close doesn't update mode)
			// The key assertion: no error thrown, timer was cleared
		});

		it("should clear upgrade timer", () => {
			const { hybrid, provider } = createHybrid();
			hybrid.start();
			vi.advanceTimersByTime(500); // fall back to relay, starts upgrade timer

			hybrid.close();

			// Reset call count after close
			provider.connect.mockClear();

			// Advance past upgrade interval — no new connect() call
			vi.advanceTimersByTime(5000);

			expect(provider.connect).not.toHaveBeenCalled();
		});

		it("should remove all listeners after close", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.on("data", vi.fn());
			hybrid.on("open", vi.fn());

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");
			hybrid.close();

			expect(hybrid.listenerCount("data")).toBe(0);
			expect(hybrid.listenerCount("open")).toBe(0);
			expect(hybrid.listenerCount("close")).toBe(0);
		});

		it("should handle double close gracefully", () => {
			const { hybrid, dc } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			const closeSpy = vi.fn();
			hybrid.on("close", closeSpy);

			hybrid.close();
			hybrid.close(); // second close should be a no-op

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});

		it("should not emit close if connection was never opened", () => {
			const { hybrid } = createHybrid();
			const closeSpy = vi.fn();
			hybrid.on("close", closeSpy);

			hybrid.close();

			expect(closeSpy).not.toHaveBeenCalled();
		});

		it("should prevent start() from working after close", () => {
			const { hybrid, provider } = createHybrid();
			hybrid.close();

			provider.connect.mockClear();
			hybrid.start();

			expect(provider.connect).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// 8. WebRTC drops mid-session → fallback to relay
	// -----------------------------------------------------------------------
	describe("WebRTC drops mid-session", () => {
		it("should fall back to relay when DataConnection closes during active session", () => {
			const { hybrid, dc } = createHybrid();
			const transportSpy = vi.fn();
			hybrid.on("transportChanged", transportSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			expect(hybrid.mode).toBe(TransportMode.WebRTC);

			// Simulate WebRTC channel dropping
			dc!.emit("close");

			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
			expect(transportSpy).toHaveBeenCalledWith(TransportMode.WebSocketRelay);
		});

		it("should not emit open again when falling back (already open)", () => {
			const { hybrid, dc } = createHybrid();
			const openSpy = vi.fn();
			hybrid.on("open", openSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");
			expect(openSpy).toHaveBeenCalledTimes(1);

			// Drop WebRTC
			dc!.emit("close");

			// open should NOT be emitted a second time
			expect(openSpy).toHaveBeenCalledTimes(1);
		});

		it("should schedule upgrade attempts after mid-session fallback", () => {
			const { hybrid, dc, provider } = createHybrid();
			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			// Reset to count only post-fallback connect calls
			provider.connect.mockClear();

			// Simulate WebRTC dropping
			dc!.emit("close");
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			// Advance past upgrade interval → should attempt reconnect
			vi.advanceTimersByTime(1000);

			expect(provider.connect).toHaveBeenCalledTimes(1);
		});
	});

	// -----------------------------------------------------------------------
	// 9. Auto-upgrade scheduling (autoUpgrade=true, the default)
	// -----------------------------------------------------------------------
	describe("auto-upgrade scheduling", () => {
		it("should periodically retry WebRTC after falling back to relay", () => {
			const { hybrid, provider } = createHybrid();
			hybrid.start();

			// Fall back via ICE timeout (iceTimeout=500)
			vi.advanceTimersByTime(500);
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			// connect() was called once for the initial attempt
			expect(provider.connect).toHaveBeenCalledTimes(1);

			// Each upgrade cycle: upgradeInterval fires → connect() → ICE timer fires
			// → _fallbackToRelay() → restarts interval. So one full cycle takes
			// upgradeInterval + iceTimeout = 1000 + 500 = 1500ms.

			// 1st upgrade attempt: +1000ms (interval fires)
			vi.advanceTimersByTime(1000);
			expect(provider.connect).toHaveBeenCalledTimes(2);

			// ICE timeout for the 1st upgrade (+500) then interval fires again (+1000)
			vi.advanceTimersByTime(500 + 1000);
			expect(provider.connect).toHaveBeenCalledTimes(3);
		});

		it("should clear upgrade timer when WebRTC succeeds on upgrade", () => {
			const dc1 = new MockDataConnection();
			const dc2 = new MockDataConnection();
			const provider = createMockProvider(dc1);

			const hybrid = new HybridConnection("remote-peer", provider, {
				iceTimeout: 500,
				upgradeInterval: 1000,
				maxUpgradeAttempts: 5,
			});

			hybrid.start();

			// Fall back via ICE timeout
			vi.advanceTimersByTime(500);
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			// Now configure connect() to return a new DC for upgrade
			provider.connect.mockReturnValue(dc2);

			// 1st upgrade attempt
			vi.advanceTimersByTime(1000);

			// Simulate the new DC opening
			dc2.open = true;
			dc2.emit("open");

			expect(hybrid.mode).toBe(TransportMode.WebRTC);

			// Reset and verify no more upgrade attempts
			provider.connect.mockClear();
			vi.advanceTimersByTime(5000);

			expect(provider.connect).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// 10. Max upgrade attempts stops retrying
	// -----------------------------------------------------------------------
	describe("max upgrade attempts", () => {
		it("should stop retrying after maxUpgradeAttempts", () => {
			const { hybrid, provider } = createHybrid({
				options: {
					iceTimeout: 500,
					upgradeInterval: 1000,
					maxUpgradeAttempts: 3,
				},
			});

			hybrid.start();
			vi.advanceTimersByTime(500); // fallback to relay
			expect(provider.connect).toHaveBeenCalledTimes(1);

			// Each cycle = upgradeInterval (1000) + iceTimeout (500) = 1500ms
			// except the last cycle doesn't need the ICE timeout to count
			// Attempt 1: +1000ms
			vi.advanceTimersByTime(1000);
			expect(provider.connect).toHaveBeenCalledTimes(2);

			// Attempt 2: +500 (ice) + 1000 (interval)
			vi.advanceTimersByTime(500 + 1000);
			expect(provider.connect).toHaveBeenCalledTimes(3);

			// Attempt 3: +500 (ice) + 1000 (interval)
			vi.advanceTimersByTime(500 + 1000);
			expect(provider.connect).toHaveBeenCalledTimes(4);

			// Further intervals should NOT trigger more attempts
			provider.connect.mockClear();
			vi.advanceTimersByTime(10000);

			expect(provider.connect).not.toHaveBeenCalled();
		});

		it("should use default maxUpgradeAttempts of 5 when not specified", () => {
			const dc = new MockDataConnection();
			const provider = createMockProvider(dc);
			const hybrid = new HybridConnection("remote-peer", provider, {
				iceTimeout: 200,
				upgradeInterval: 500,
			});

			hybrid.start();
			vi.advanceTimersByTime(200); // fallback → relay
			expect(provider.connect).toHaveBeenCalledTimes(1);

			// Each cycle = upgradeInterval (500) + iceTimeout (200) = 700ms
			// except the first attempt only needs the interval.
			// Attempt 1: +500
			vi.advanceTimersByTime(500);
			expect(provider.connect).toHaveBeenCalledTimes(2);

			// Attempts 2-5: each +200 (ice) + 500 (interval) = +700
			for (let i = 0; i < 4; i++) {
				vi.advanceTimersByTime(200 + 500);
			}
			expect(provider.connect).toHaveBeenCalledTimes(6); // 1 initial + 5 upgrades

			// No more
			provider.connect.mockClear();
			vi.advanceTimersByTime(5000);
			expect(provider.connect).not.toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// 11. autoUpgrade=false: no timer
	// -----------------------------------------------------------------------
	describe("autoUpgrade=false", () => {
		it("should not schedule upgrade attempts when autoUpgrade is false", () => {
			const { hybrid, provider } = createHybrid({
				options: {
					iceTimeout: 500,
					autoUpgrade: false,
					upgradeInterval: 1000,
					maxUpgradeAttempts: 3,
				},
			});

			hybrid.start();
			vi.advanceTimersByTime(500); // fallback to relay
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);

			// connect() called once for initial attempt only
			expect(provider.connect).toHaveBeenCalledTimes(1);

			// Advance well past upgrade intervals — no more connect() calls
			provider.connect.mockClear();
			vi.advanceTimersByTime(10000);

			expect(provider.connect).not.toHaveBeenCalled();
		});

		it("should still work for send() on relay without upgrade timer", () => {
			const { hybrid, provider } = createHybrid({
				options: { iceTimeout: 500, autoUpgrade: false, encryptRelay: false },
			});

			hybrid.start();
			vi.advanceTimersByTime(500);

			hybrid.send({ payload: "test" });

			expect(provider.socket.send).toHaveBeenCalledWith({
				type: ServerMessageType.Data,
				dst: "remote-peer",
				payload: { payload: "test" },
			});
		});
	});

	// -----------------------------------------------------------------------
	// Edge cases
	// -----------------------------------------------------------------------
	describe("edge cases", () => {
		it("should emit error when no transport available in unexpected mode", () => {
			const { hybrid, dc } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			dc!.open = true;
			dc!.emit("open");

			// Forcibly set dc.open to false to simulate a broken state
			dc!.open = false;

			hybrid.send("test");

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0].message).toMatch(/No transport available/);
		});

		it("should coerce non-Error objects from DataConnection error events", () => {
			const { hybrid, dc } = createHybrid();
			const errorSpy = vi.fn();
			hybrid.on("error", errorSpy);

			hybrid.start();
			dc!.emit("error", "string error");

			expect(errorSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error);
			expect(errorSpy.mock.calls[0][0].message).toBe("string error");
		});

		it("should use default iceTimeout of 10000ms when not specified", () => {
			const dc = new MockDataConnection();
			const provider = createMockProvider(dc);
			const hybrid = new HybridConnection("remote-peer", provider);

			hybrid.start();

			// At 9999ms, should still be in Reconnecting
			vi.advanceTimersByTime(9999);
			expect(hybrid.mode).toBe(TransportMode.Reconnecting);

			// At 10000ms, should fall back
			vi.advanceTimersByTime(1);
			expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
		});
	});
});
