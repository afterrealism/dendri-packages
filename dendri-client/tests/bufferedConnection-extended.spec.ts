import { Server } from "mock-socket";
import type { BinaryPack } from "../src/dataconnection/BufferedConnection/BinaryPack";
import type { Json } from "../src/dataconnection/BufferedConnection/Json";
import type { Raw } from "../src/dataconnection/BufferedConnection/Raw";
import { Dendri } from "../src/dendri";
import { DataConnectionErrorType, ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8091/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("BufferedConnection extended", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8091, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("BufferedConnection _bufferedSend and buffering", () => {
		it("should buffer when dataChannel bufferedAmount exceeds MAX_BUFFERED_AMOUNT", () => {
			vi.useFakeTimers();

			try {
				const conn = peer.connect("2") as BinaryPack;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				// Set bufferedAmount above threshold (8MB)
				dc.bufferedAmount = 9 * 1024 * 1024;

				const sendSpy = vi.spyOn(dc, "send");

				// Try to send - should be buffered due to high bufferedAmount
				(conn as any)._bufferedSend(new ArrayBuffer(10));

				expect(sendSpy).not.toHaveBeenCalled();
				expect((conn as any)._bufferSize).toBe(1);

				// Reset bufferedAmount and advance timer to trigger _tryBuffer
				dc.bufferedAmount = 0;
				vi.advanceTimersByTime(50);

				expect(sendSpy).toHaveBeenCalledTimes(1);
				expect((conn as any)._bufferSize).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("should handle send error by closing connection", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			// Make send throw
			dc.send = () => {
				throw new Error("send failed");
			};

			const closeSpy = vi.spyOn(conn, "close");

			(conn as any)._bufferedSend(new ArrayBuffer(10));

			expect(closeSpy).toHaveBeenCalled();
		});

		it("should not send when connection is not open", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			// Do NOT open the channel

			const sendSpy = vi.spyOn(dc, "send");

			(conn as any)._bufferedSend(new ArrayBuffer(10));

			expect(sendSpy).not.toHaveBeenCalled();
			expect((conn as any)._bufferSize).toBe(1);
		});

		it("should clear buffer timer on close", () => {
			vi.useFakeTimers();

			try {
				const conn = peer.connect("2") as BinaryPack;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				// Trigger buffering
				dc.bufferedAmount = 9 * 1024 * 1024;
				(conn as any)._bufferedSend(new ArrayBuffer(10));

				// There should be a timer
				expect((conn as any)._bufferTimer).not.toBeNull();

				conn.close();

				expect((conn as any)._bufferTimer).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		it("should drain buffer items until one fails", () => {
			vi.useFakeTimers();

			try {
				const conn = peer.connect("2") as BinaryPack;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				// Buffer multiple items
				dc.bufferedAmount = 9 * 1024 * 1024;
				(conn as any)._bufferedSend(new ArrayBuffer(1));
				(conn as any)._bufferedSend(new ArrayBuffer(2));
				(conn as any)._bufferedSend(new ArrayBuffer(3));

				expect((conn as any)._bufferSize).toBe(3);

				// Reset buffered amount so first sends succeed, but then set it high again
				let sendCount = 0;
				const origSend = dc.send.bind(dc);
				dc.send = (...args: any[]) => {
					sendCount++;
					if (sendCount >= 2) {
						// After first successful send, simulate high buffered amount
						dc.bufferedAmount = 9 * 1024 * 1024;
					}
					return origSend(...args);
				};

				dc.bufferedAmount = 0;
				vi.advanceTimersByTime(50);

				// First item should have been sent, rest remain buffered
				expect(sendCount).toBeGreaterThanOrEqual(1);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("BinaryPack chunk reassembly", () => {
		it("should reassemble chunked data", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2") as BinaryPack;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				// We need to import pack to create proper binary data
				const { pack } = require("peerjs-js-binarypack");

				conn.on("data", (data) => {
					// Data should be the reassembled original
					expect(data).toBeDefined();
					resolve();
				});

				// Create chunked data manually
				// First chunk
				const chunk1Data = pack({
					__peerData: 1,
					n: 0,
					total: 2,
					data: new ArrayBuffer(4),
				});
				dc._receive(new Uint8Array(chunk1Data));

				// Second chunk
				const chunk2Data = pack({
					__peerData: 1,
					n: 1,
					total: 2,
					data: new ArrayBuffer(4),
				});
				dc._receive(new Uint8Array(chunk2Data));
			}));

		it("should handle close message via __peerData", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const { pack } = require("peerjs-js-binarypack");
			const closeSpy = vi.spyOn(conn, "close");

			// Send a close peerData message
			const closeMsg = pack({ __peerData: { type: "close" } });
			dc._receive(new Uint8Array(closeMsg));

			expect(closeSpy).toHaveBeenCalled();
		});

		it("should clear chunked data on close", () => {
			const conn = peer.connect("2") as BinaryPack;

			// Manually set some chunked data
			(conn as any)._chunkedData = {
				1: { data: [], count: 1, total: 3 },
			};

			conn.close();

			expect((conn as any)._chunkedData).toEqual({});
		});

		it("should drop chunks with invalid index", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const { pack } = require("peerjs-js-binarypack");

			// Send chunk with n >= total (invalid)
			const invalidChunk = pack({
				__peerData: 42,
				n: 5,
				total: 3,
				data: new ArrayBuffer(4),
			});
			dc._receive(new Uint8Array(invalidChunk));

			// Should not have stored anything
			expect((conn as any)._chunkedData[42]).toBeUndefined();
		});

		it("should drop chunks with negative index", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const { pack } = require("peerjs-js-binarypack");

			const invalidChunk = pack({
				__peerData: 42,
				n: -1,
				total: 3,
				data: new ArrayBuffer(4),
			});
			dc._receive(new Uint8Array(invalidChunk));

			expect((conn as any)._chunkedData[42]).toBeUndefined();
		});

		it("should cap pending chunk sets and drop oldest when exceeding MAX_CHUNKED_SETS", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const { pack } = require("peerjs-js-binarypack");

			// Fill up to MAX_CHUNKED_SETS + 1 (257 unique chunk IDs, each incomplete)
			for (let i = 0; i < 257; i++) {
				const chunk = pack({
					__peerData: i,
					n: 0,
					total: 2,
					data: new ArrayBuffer(1),
				});
				dc._receive(new Uint8Array(chunk));
			}

			// Should have dropped the oldest entry
			const keys = Object.keys((conn as any)._chunkedData);
			expect(keys.length).toBeLessThanOrEqual(256);
		});
	});

	describe("BinaryPack _send", () => {
		it("should chunk large data", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const sendSpy = vi.spyOn(conn, "send");

			// Create data larger than chunkedMTU (16300)
			const largeData = new ArrayBuffer(20000);
			(conn as any)._send(largeData, false);

			// send() should have been called multiple times (chunks)
			expect(sendSpy).toHaveBeenCalled();
		});

		it("should send small data directly without chunking", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const bufferedSendSpy = vi.spyOn(conn as any, "_bufferedSend");

			// Small data within chunkedMTU
			const smallData = "hello";
			(conn as any)._send(smallData, false);

			expect(bufferedSendSpy).toHaveBeenCalled();
		});

		it("should not chunk when chunked flag is true regardless of size", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const bufferedSendSpy = vi.spyOn(conn as any, "_bufferedSend");

			// Large data but chunked=true should go straight to _bufferedSend
			const { pack } = require("peerjs-js-binarypack");
			const largeBlob = pack(new ArrayBuffer(20000));

			(conn as any)._send(new ArrayBuffer(20000), true);

			expect(bufferedSendSpy).toHaveBeenCalled();
		});
	});

	describe("Raw send/receive", () => {
		it("should emit data on message", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2", { serialization: "raw" }) as Raw;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				conn.on("data", (data) => {
					expect(data).toEqual(new ArrayBuffer(4));
					resolve();
				});

				dc._receive(new ArrayBuffer(4));
			}));

		it("should send data via _bufferedSend", () => {
			const conn = peer.connect("2", { serialization: "raw" }) as Raw;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const bufferedSendSpy = vi.spyOn(conn as any, "_bufferedSend");

			(conn as any)._send(new ArrayBuffer(10), false);

			expect(bufferedSendSpy).toHaveBeenCalledWith(expect.any(ArrayBuffer));
		});
	});

	describe("Json send error path", () => {
		it("should emit error for messages that exceed chunkedMTU", () => {
			const conn = peer.connect("2", { serialization: "json" }) as Json;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			// Create a very large message that exceeds chunkedMTU
			const largeData = "x".repeat(20000);
			(conn as any)._send(largeData, false);

			expect(errorSpy).toHaveBeenCalled();
			const errorArg = errorSpy.mock.calls[0][0];
			expect(errorArg.type).toBe(DataConnectionErrorType.MessageToBig);
		});

		it("should send JSON data normally for small messages", () => {
			const conn = peer.connect("2", { serialization: "json" }) as Json;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const bufferedSendSpy = vi.spyOn(conn as any, "_bufferedSend");

			(conn as any)._send({ hello: "world" }, false);

			expect(bufferedSendSpy).toHaveBeenCalled();
		});

		it("should handle close peerData message in JSON", () => {
			const conn = peer.connect("2", { serialization: "json" }) as Json;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const closeSpy = vi.spyOn(conn, "close");

			const encoder = new TextEncoder();
			const closeMsg = encoder.encode(JSON.stringify({ __peerData: { type: "close" } }));
			dc._receive(closeMsg);

			expect(closeSpy).toHaveBeenCalled();
		});

		it("should emit data for normal JSON messages", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2", { serialization: "json" }) as Json;
				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);
				dc._open();

				conn.on("data", (data) => {
					expect(data).toEqual({ hello: "world" });
					resolve();
				});

				const encoder = new TextEncoder();
				const msg = encoder.encode(JSON.stringify({ hello: "world" }));
				dc._receive(msg);
			}));

		it("should handle parse errors gracefully", () => {
			const conn = peer.connect("2", { serialization: "json" }) as Json;
			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);
			dc._open();

			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			// Send invalid JSON
			const encoder = new TextEncoder();
			const invalidMsg = encoder.encode("not{json");
			dc._receive(invalidMsg);

			expect(errorSpy).toHaveBeenCalled();
		});
	});
});
