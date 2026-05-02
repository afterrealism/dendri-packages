import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionState, ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8090/dendri?key=dendri&id=diag-1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Dendri.diagnostics()", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("diag-1", { port: 8090, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("should return correct structure with all expected fields", () => {
		const diag = peer.diagnostics();

		expect(diag).toHaveProperty("peerId");
		expect(diag).toHaveProperty("connectionState");
		expect(diag).toHaveProperty("serverConnected");
		expect(diag).toHaveProperty("connections");
		expect(diag).toHaveProperty("hybridConnections");
		expect(diag).toHaveProperty("socket");
		expect(diag).toHaveProperty("pendingMessages");

		expect(diag.socket).toHaveProperty("connected");
		expect(diag.socket).toHaveProperty("autoReconnect");
		expect(diag.socket).toHaveProperty("reconnectAttempt");
		expect(diag.socket).toHaveProperty("lastSeq");
	});

	it("should reflect connected state after open", () => {
		const diag = peer.diagnostics();

		expect(diag.peerId).toBe("diag-1");
		expect(diag.connectionState).toBe(ConnectionState.Connected);
		expect(diag.serverConnected).toBe(true);
		expect(diag.connections).toEqual([]);
		expect(diag.hybridConnections).toEqual([]);
		expect(diag.pendingMessages).toBe(0);
	});

	it("should reflect disconnected state after disconnect", () => {
		peer.disconnect();

		const diag = peer.diagnostics();

		expect(diag.peerId).toBeNull();
		expect(diag.connectionState).toBe(ConnectionState.Disconnected);
		expect(diag.serverConnected).toBe(false);
	});

	it("should reflect destroyed state after destroy", () => {
		peer.destroy();

		const diag = peer.diagnostics();

		expect(diag.connectionState).toBe(ConnectionState.Closed);
		expect(diag.serverConnected).toBe(false);
	});
});
