import { EventEmitter } from "eventemitter3";
import { ServerMessageType, TransportMode } from "../src/enums";
import { HybridConnection } from "../src/hybridconnection";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockDataConnection extends EventEmitter {
	open = false;
	send = vi.fn();
	close = vi.fn();
}

function createMockSocket() {
	return { send: vi.fn() };
}

function createMockProvider(dc: MockDataConnection | null = new MockDataConnection()) {
	return {
		connect: vi.fn().mockReturnValue(dc),
		socket: createMockSocket(),
	} as unknown as any;
}

/** Create a HybridConnection in relay mode with encryption enabled (default). */
function createRelayHybrid(overrides: { encryptRelay?: boolean } = {}) {
	const dc = new MockDataConnection();
	const provider = createMockProvider(dc);
	const hybrid = new HybridConnection("remote-peer", provider, {
		iceTimeout: 100,
		autoUpgrade: false,
		encryptRelay: overrides.encryptRelay ?? true,
	});
	return { hybrid, provider, dc };
}

/** Put hybrid into relay mode by letting ICE timeout fire. */
function enterRelayMode(hybrid: HybridConnection): void {
	hybrid.start();
	vi.advanceTimersByTime(100);
	expect(hybrid.mode).toBe(TransportMode.WebSocketRelay);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HybridConnection reorder buffer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// Sequential delivery
	// -----------------------------------------------------------------------
	it("should deliver messages with sequential seq in order", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-2", 2);
		hybrid.handleRelayData("msg-3", 3);

		expect(received).toEqual(["msg-1", "msg-2", "msg-3"]);
	});

	// -----------------------------------------------------------------------
	// Out-of-order buffering
	// -----------------------------------------------------------------------
	it("should buffer out-of-order message and deliver when gap is filled", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		// Send seq 1, then skip 2, send 3
		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-3", 3); // buffered, waiting for seq 2

		expect(received).toEqual(["msg-1"]);

		// Now send the missing seq 2
		hybrid.handleRelayData("msg-2", 2);

		expect(received).toEqual(["msg-1", "msg-2", "msg-3"]);
	});

	// -----------------------------------------------------------------------
	// Timeout flush
	// -----------------------------------------------------------------------
	it("should flush buffered messages after reorder timeout if gap is not filled", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		// Send seq 1, then skip 2, send 3
		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-3", 3);

		expect(received).toEqual(["msg-1"]);

		// Advance past the 500ms reorder timeout
		vi.advanceTimersByTime(500);

		// msg-3 should be flushed even though msg-2 never arrived
		expect(received).toEqual(["msg-1", "msg-3"]);
	});

	// -----------------------------------------------------------------------
	// Duplicate seq ignored
	// -----------------------------------------------------------------------
	it("should ignore duplicate seq numbers", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-1-dup", 1); // duplicate, should be ignored

		expect(received).toEqual(["msg-1"]);
	});

	// -----------------------------------------------------------------------
	// No seq delivers immediately (backward compat)
	// -----------------------------------------------------------------------
	it("should deliver immediately when seq is undefined (backward compat)", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		hybrid.handleRelayData("no-seq-msg", undefined);
		hybrid.handleRelayData("no-seq-msg-2");

		expect(received).toEqual(["no-seq-msg", "no-seq-msg-2"]);
	});

	// -----------------------------------------------------------------------
	// No seq with encryptRelay=false delivers immediately
	// -----------------------------------------------------------------------
	it("should deliver immediately when encryptRelay is false regardless of seq", () => {
		const { hybrid } = createRelayHybrid({ encryptRelay: false });
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		// Even with seq numbers, should deliver immediately (no reorder buffer)
		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-3", 3);
		hybrid.handleRelayData("msg-2", 2);

		expect(received).toEqual(["msg-1", "msg-3", "msg-2"]);
	});

	// -----------------------------------------------------------------------
	// Close clears reorder buffer
	// -----------------------------------------------------------------------
	it("should clear reorder buffer on close", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-3", 3); // buffered

		hybrid.close();

		// Advance past reorder timeout -- should not deliver or throw
		vi.advanceTimersByTime(600);

		expect(received).toEqual(["msg-1"]);
	});

	// -----------------------------------------------------------------------
	// Multiple consecutive out-of-order messages
	// -----------------------------------------------------------------------
	it("should handle multiple buffered messages and deliver all when gap fills", () => {
		const { hybrid } = createRelayHybrid();
		enterRelayMode(hybrid);

		const received: unknown[] = [];
		hybrid.on("data", (data) => received.push(data));

		hybrid.handleRelayData("msg-1", 1);
		hybrid.handleRelayData("msg-4", 4); // buffered
		hybrid.handleRelayData("msg-3", 3); // buffered

		expect(received).toEqual(["msg-1"]);

		// Fill the gap
		hybrid.handleRelayData("msg-2", 2);

		expect(received).toEqual(["msg-1", "msg-2", "msg-3", "msg-4"]);
	});
});
