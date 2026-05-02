import { Server } from "mock-socket";
import { BinaryPack } from "../src/dataconnection/BufferedConnection/BinaryPack";
import { Json } from "../src/dataconnection/BufferedConnection/Json";
import { Raw } from "../src/dataconnection/BufferedConnection/Raw";
import { Dendri } from "../src/dendri";
import { ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8087/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("BufferedConnection serializers", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8087, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("Json serializer", () => {
		it("should use json serialization type", () => {
			const conn = peer.connect("2", { serialization: "json" });
			expect(conn).toBeInstanceOf(Json);
			expect(conn.serialization).toBe("json");
		});

		it("should allow custom stringify/parse", () => {
			const conn = peer.connect("2", { serialization: "json" }) as Json;
			expect(conn).toBeDefined();
			expect(typeof conn.stringify).toBe("function");
			expect(typeof conn.parse).toBe("function");
		});
	});

	describe("BinaryPack serializer", () => {
		it("should use binary serialization type", () => {
			const conn = peer.connect("2", { serialization: "binary" });
			expect(conn).toBeInstanceOf(BinaryPack);
			expect(conn.serialization).toBe("binary");
		});

		it("should be the default serializer", () => {
			const conn = peer.connect("2");
			expect(conn).toBeInstanceOf(BinaryPack);
		});

		it("should handle binary-utf8 serialization", () => {
			const conn = peer.connect("2", { serialization: "binary-utf8" });
			expect(conn).toBeInstanceOf(BinaryPack);
		});
	});

	describe("Raw serializer", () => {
		it("should use raw serialization type", () => {
			const conn = peer.connect("2", { serialization: "raw" });
			expect(conn).toBeInstanceOf(Raw);
			expect(conn.serialization).toBe("raw");
		});
	});

	describe("close with flush", () => {
		it("should not throw when calling close with flush on a non-open connection", () => {
			const conn = peer.connect("2");
			expect(conn).toBeDefined();

			// close({flush: true}) calls send() which should emit error since not open
			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			conn.close({ flush: true });

			// Should have emitted a "not open yet" error since connection isn't open
			expect(errorSpy).toHaveBeenCalled();
		});
	});

	describe("bufferSize", () => {
		it("should start at 0", () => {
			const conn = peer.connect("2");
			expect(conn).toBeDefined();

			// Access bufferSize from the abstract BufferedConnection
			expect((conn as any).bufferSize).toBe(0);
		});
	});

	describe("DataChannel initialization", () => {
		it("should accept data channel and set up handlers", () => {
			const conn = peer.connect("2");
			expect(conn).toBeDefined();

			// Create a mock data channel
			const dc = new (window as any).RTCDataChannel("test-channel");

			// Initialize should not throw
			conn._initializeDataChannel(dc);

			expect(conn.dataChannel).toBe(dc);
			expect(dc.binaryType).toBe("arraybuffer");
		});

		it("should emit open event when data channel opens", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2");
				expect(conn).toBeDefined();

				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);

				conn.on("open", () => {
					expect(conn.open).toBe(true);
					resolve();
				});

				dc._open();
			}));

		it("should call close when data channel closes", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2");
				expect(conn).toBeDefined();

				const dc = new (window as any).RTCDataChannel("test-channel");
				conn._initializeDataChannel(dc);

				// Open first, then close
				dc._open();

				conn.on("close", () => {
					expect(conn.open).toBe(false);
					resolve();
				});

				dc.close();
			}));
	});

	describe("event listener cleanup", () => {
		it("should remove message event listener on close", () => {
			const conn = peer.connect("2");
			expect(conn).toBeDefined();

			const dc = new (window as any).RTCDataChannel("test-channel");
			conn._initializeDataChannel(dc);

			// Track listeners
			const listenersBefore = dc._listeners.get("message")?.size || 0;
			expect(listenersBefore).toBe(1);

			conn.close();

			const listenersAfter = dc._listeners.get("message")?.size || 0;
			expect(listenersAfter).toBe(0);
		});
	});
});
