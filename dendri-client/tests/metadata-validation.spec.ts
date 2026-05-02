import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, ServerMessageType } from "../src/enums";

const createMockServer = (port: number, id: string): Server => {
	const fakeURL = `ws://localhost:${port}/dendri?key=dendri&id=${id}&token=testToken`;
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Dendri validateMetadata", () => {
	let mockServer: Server;
	let peer: Dendri;

	afterEach(() => {
		peer?.destroy();
		mockServer?.stop();
	});

	it("should call validateMetadata with metadata from incoming offer", () =>
		new Promise<void>((resolve) => {
			const validateFn = vi.fn().mockReturnValue(true);

			mockServer = createMockServer(8091, "meta-1");
			peer = new Dendri("meta-1", {
				port: 8091,
				host: "localhost",
				validateMetadata: validateFn,
			});

			peer.once("open", () => {
				// Simulate an incoming OFFER with metadata
				// @ts-expect-error - accessing private method for testing
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-peer",
					payload: {
						connectionId: "conn-1",
						type: ConnectionType.Data,
						serialization: "json",
						metadata: { role: "editor" },
						label: "test",
						reliable: true,
					},
				});

				expect(validateFn).toHaveBeenCalledTimes(1);
				expect(validateFn).toHaveBeenCalledWith({ role: "editor" });
				resolve();
			});
		}));

	it("should reject connection when validateMetadata returns false", () =>
		new Promise<void>((resolve) => {
			const validateFn = vi.fn().mockReturnValue(false);
			const connectionSpy = vi.fn();

			mockServer = createMockServer(8092, "meta-2");
			peer = new Dendri("meta-2", {
				port: 8092,
				host: "localhost",
				validateMetadata: validateFn,
			});

			peer.on("connection", connectionSpy);

			peer.once("open", () => {
				// @ts-expect-error - accessing private method for testing
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "bad-peer",
					payload: {
						connectionId: "conn-2",
						type: ConnectionType.Data,
						serialization: "json",
						metadata: { role: "attacker" },
						label: "test",
						reliable: true,
					},
				});

				// Connection event should NOT have been emitted
				expect(connectionSpy).not.toHaveBeenCalled();
				expect(validateFn).toHaveBeenCalledWith({ role: "attacker" });
				resolve();
			});
		}));

	it("should accept connection when validateMetadata returns true", () =>
		new Promise<void>((resolve) => {
			const validateFn = vi.fn().mockReturnValue(true);

			mockServer = createMockServer(8093, "meta-3");
			peer = new Dendri("meta-3", {
				port: 8093,
				host: "localhost",
				validateMetadata: validateFn,
			});

			peer.on("connection", (conn) => {
				expect(conn.metadata).toEqual({ role: "viewer" });
				resolve();
			});

			peer.once("open", () => {
				// @ts-expect-error - accessing private method for testing
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "good-peer",
					payload: {
						connectionId: "conn-3",
						type: ConnectionType.Data,
						serialization: "json",
						metadata: { role: "viewer" },
						label: "test",
						reliable: true,
					},
				});
			});
		}));

	it("should accept connection when validateMetadata is not set", () =>
		new Promise<void>((resolve) => {
			mockServer = createMockServer(8094, "meta-4");
			peer = new Dendri("meta-4", {
				port: 8094,
				host: "localhost",
				// No validateMetadata option
			});

			peer.on("connection", (conn) => {
				expect(conn.metadata).toEqual({ anything: true });
				resolve();
			});

			peer.once("open", () => {
				// @ts-expect-error - accessing private method for testing
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "any-peer",
					payload: {
						connectionId: "conn-4",
						type: ConnectionType.Data,
						serialization: "json",
						metadata: { anything: true },
						label: "test",
						reliable: true,
					},
				});
			});
		}));
});
