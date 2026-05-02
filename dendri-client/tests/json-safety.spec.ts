import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8092/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Json safety", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach((done) => {
		mockServer = createMockServer();
		peer = new Dendri("1", { port: 8092, host: "localhost" });
		peer.once("open", () => done());
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("malformed JSON handling", () => {
		it("should emit error when JSON parse fails", () => {
			const conn = peer.connect("2", { serialization: "json" });
			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Send invalid JSON (not valid UTF-8 JSON text)
				const encoder = new TextEncoder();
				const badJson = encoder.encode("{invalid json!!!");
				dc._receive(badJson);

				expect(errorSpy).toHaveBeenCalled();
			}
		});

		it("should not crash on empty data", () => {
			const conn = peer.connect("2", { serialization: "json" });
			const errorSpy = vi.fn();
			conn.on("error", errorSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				// Send empty buffer
				dc._receive(new Uint8Array(0));

				// Should emit error (empty string is invalid JSON)
				expect(errorSpy).toHaveBeenCalled();
			}
		});
	});

	describe("valid JSON handling", () => {
		it("should handle valid JSON data correctly", () => {
			const conn = peer.connect("2", { serialization: "json" });
			const dataSpy = vi.fn();
			conn.on("data", dataSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				const encoder = new TextEncoder();
				const validJson = encoder.encode(JSON.stringify({ hello: "world" }));
				dc._receive(validJson);

				expect(dataSpy).toHaveBeenCalledWith({ hello: "world" });
			}
		});

		it("should handle close message correctly", () => {
			const conn = peer.connect("2", { serialization: "json" });
			const closeSpy = vi.fn();
			conn.on("close", closeSpy);

			const dc = conn.dataChannel as any;
			if (dc) {
				dc._open();

				const encoder = new TextEncoder();
				const closeMsg = encoder.encode(JSON.stringify({ __peerData: { type: "close" } }));
				dc._receive(closeMsg);

				// Connection should be closed
				expect(conn.open).toBe(false);
			}
		});
	});
});
