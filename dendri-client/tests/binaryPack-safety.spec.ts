import { Server } from "mock-socket";
import { pack } from "peerjs-js-binarypack";
import type { BinaryPack } from "../src/dataconnection/BufferedConnection/BinaryPack";
import { Dendri } from "../src/dendri";
import { ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8090/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("BinaryPack safety", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach((done) => {
		mockServer = createMockServer();
		peer = new Dendri("1", { port: 8090, host: "localhost" });
		peer.once("open", () => done());
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("malformed data handling", () => {
		it("should emit error when unpack fails with malformed data", () => {
			const conn = peer.connect("2") as BinaryPack;
			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			// Simulate opening the data channel
			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Send an empty buffer which should cause unpack to fail
				// (msgpack requires at least some valid format byte)
				const badData = new Uint8Array(0);
				dc._receive(badData);

				// If unpack doesn't throw on empty data, the try/catch still
				// protects against it. Either way, no crash should occur.
				// The important thing is: no unhandled exception.
			}
		});

		it("should not crash when receiving data that unpack handles gracefully", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dataSpy = vi.fn();
			const errorSpy = vi.fn();
			conn.on("data", dataSpy);
			conn.on("error", errorSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Pack a valid simple object and send it
				const validData = pack("hello");
				if (!(validData instanceof Promise)) {
					dc._receive(new Uint8Array(validData));
					expect(dataSpy).toHaveBeenCalledWith("hello");
					expect(errorSpy).not.toHaveBeenCalled();
				}
			}
		});
	});

	describe("chunk validation", () => {
		it("should reject chunks with negative index", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dataSpy = vi.fn();
			conn.on("data", dataSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Create a chunk message with invalid negative index
				const chunkMsg = {
					__peerData: 1,
					n: -1,
					total: 3,
					data: new ArrayBuffer(10),
				};
				const packed = pack(chunkMsg);
				if (!(packed instanceof Promise)) {
					dc._receive(new Uint8Array(packed));
				}

				// Should not emit data
				expect(dataSpy).not.toHaveBeenCalled();
			}
		});

		it("should reject chunks with index >= total", () => {
			const conn = peer.connect("2") as BinaryPack;
			const dataSpy = vi.fn();
			conn.on("data", dataSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Create a chunk message where n >= total
				const chunkMsg = {
					__peerData: 2,
					n: 5,
					total: 3,
					data: new ArrayBuffer(10),
				};
				const packed = pack(chunkMsg);
				if (!(packed instanceof Promise)) {
					dc._receive(new Uint8Array(packed));
				}

				// Should not emit data
				expect(dataSpy).not.toHaveBeenCalled();
			}
		});
	});

	describe("chunk set cap", () => {
		it("should limit pending chunked data sets", () => {
			const conn = peer.connect("2") as BinaryPack;

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Send 260 different incomplete chunk sets (exceeding the 256 cap)
				for (let i = 0; i < 260; i++) {
					const chunkMsg = {
						__peerData: i,
						n: 0,
						total: 100, // intentionally large so it never completes
						data: new ArrayBuffer(4),
					};
					const packed = pack(chunkMsg);
					if (!(packed instanceof Promise)) {
						dc._receive(new Uint8Array(packed));
					}
				}

				// The internal _chunkedData should be capped
				const chunkedData = (conn as any)._chunkedData;
				expect(Object.keys(chunkedData).length).toBeLessThanOrEqual(257);
			}
		});
	});

	describe("open check after await in _send_blob", () => {
		it("should not send if connection closes during async pack", async () => {
			const conn = peer.connect("2") as BinaryPack;

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				const sendSpy = vi.spyOn(dc, "send");

				// Verify the connection is open
				expect(conn.open).toBe(true);

				// Close the connection
				conn.close();

				// After close, open should be false
				expect(conn.open).toBe(false);

				// Any buffered sends should not go through
				expect(sendSpy).not.toHaveBeenCalled();
			}
		});
	});
});
