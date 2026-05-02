import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8091/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("StreamConnection", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach((done) => {
		mockServer = createMockServer();
		peer = new Dendri("1", { port: 8091, host: "localhost" });
		peer.once("open", () => done());
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("close()", () => {
		it("should not crash when close is called before dataChannel is initialized", () => {
			// MsgPack creates a StreamConnection
			const conn = peer.connect("2", { serialization: "default" });
			// Connection was created, close should not throw
			conn.close();
		});

		it("should handle close being called multiple times", () => {
			const conn = peer.connect("2", { serialization: "default" });
			conn.close();
			conn.close(); // Should not throw
		});
	});

	describe("writer lifecycle", () => {
		it("should create connection with writer available", () => {
			const conn = peer.connect("2", { serialization: "default" });
			// The connection should have been created
			expect(conn).toBeDefined();
			expect(conn.type).toBe("data");
			conn.close();
		});
	});
});
