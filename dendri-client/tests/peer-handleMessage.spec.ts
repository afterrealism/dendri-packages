import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, DendriErrorType, ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8085/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Dendri._handleMessage", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8085, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("ServerMessageType.Open", () => {
		it("should set open state and emit open event on initial connection", () => {
			// Already handled by beforeEach - peer is open
			expect(peer.open).toBe(true);
			expect(peer.id).toBe("1");
		});
	});

	describe("ServerMessageType.Error", () => {
		it("should emit error and abort", () =>
			new Promise<void>((resolve) => {
				peer.on("error", (error) => {
					expect(error.type).toBe(DendriErrorType.ServerError);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Error,
					payload: { msg: "Server error occurred" },
				});
			}));
	});

	describe("ServerMessageType.IdTaken", () => {
		it("should emit error for taken ID", () =>
			new Promise<void>((resolve) => {
				peer.on("error", (error) => {
					expect(error.type).toBe(DendriErrorType.UnavailableID);
					expect(error.message).toContain("1");
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.IdTaken,
					payload: {},
				});
			}));
	});

	describe("ServerMessageType.InvalidKey", () => {
		it("should emit error for invalid key", () =>
			new Promise<void>((resolve) => {
				peer.on("error", (error) => {
					expect(error.type).toBe(DendriErrorType.InvalidKey);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.InvalidKey,
					payload: {},
				});
			}));
	});

	describe("ServerMessageType.Leave", () => {
		it("should clean up connections for leaving peer", () => {
			const conn = peer.connect("remote-peer");
			expect(conn).toBeDefined();

			// Verify connection exists
			expect(peer.getConnection("remote-peer", conn.connectionId)).toBe(conn);

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Leave,
				src: "remote-peer",
				payload: {},
			});

			// Connection should be cleaned up
			expect(peer.getConnection("remote-peer", conn.connectionId)).toBeNull();
		});
	});

	describe("ServerMessageType.Expire", () => {
		it("should emit peer-unavailable error", () =>
			new Promise<void>((resolve) => {
				peer.on("error", (error) => {
					expect(error.type).toBe(DendriErrorType.PeerUnavailable);
					expect(error.message).toContain("remote-peer");
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Expire,
					src: "remote-peer",
					payload: {},
				});
			}));
	});

	describe("ServerMessageType.Offer", () => {
		it("should emit connection event for data offer", () =>
			new Promise<void>((resolve) => {
				peer.on("connection", (conn) => {
					expect(conn.type).toBe(ConnectionType.Data);
					expect(conn.peer).toBe("sender");
					expect(conn.label).toBe("test-label");
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "sender",
					payload: {
						type: ConnectionType.Data,
						connectionId: "dc_test",
						serialization: "binary",
						label: "test-label",
						reliable: true,
						metadata: {},
						sdp: { type: "offer", sdp: "fake" },
					},
				});
			}));

		it("should emit call event for media offer", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (conn) => {
					expect(conn.type).toBe(ConnectionType.Media);
					expect(conn.peer).toBe("caller");
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_test",
						metadata: {},
						sdp: { type: "offer", sdp: "fake" },
					},
				});
			}));

		it("should close existing connection on duplicate offer", () => {
			// First offer creates a connection
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Offer,
				src: "sender",
				payload: {
					type: ConnectionType.Data,
					connectionId: "dc_dup",
					serialization: "binary",
					label: "old-label",
					reliable: true,
					metadata: {},
					sdp: { type: "offer", sdp: "fake" },
				},
			});

			const firstConn = peer.getConnection("sender", "dc_dup");
			expect(firstConn).not.toBeNull();

			// Spy on close() to verify it gets called
			const closeSpy = vi.spyOn(firstConn!, "close");

			// Second offer with same connectionId should close first connection
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Offer,
				src: "sender",
				payload: {
					type: ConnectionType.Data,
					connectionId: "dc_dup",
					serialization: "binary",
					label: "new-label",
					reliable: true,
					metadata: {},
					sdp: { type: "offer", sdp: "fake2" },
				},
			});

			// close() was called on the old connection (but doesn't emit "close" since it was never opened)
			expect(closeSpy).toHaveBeenCalled();

			// The new connection should be accessible
			const newConn = peer.getConnection("sender", "dc_dup");
			expect(newConn).not.toBeNull();
			expect(newConn).not.toBe(firstConn);
		});

		it("should ignore offer with malformed connection type", () => {
			const connectionSpy = vi.fn();
			const callSpy = vi.fn();

			peer.on("connection", connectionSpy);
			peer.on("call", callSpy);

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Offer,
				src: "sender",
				payload: {
					type: "unknown-type",
					connectionId: "dc_bad",
					serialization: "binary",
					label: "test",
					reliable: false,
					metadata: {},
				},
			});

			expect(connectionSpy).not.toHaveBeenCalled();
			expect(callSpy).not.toHaveBeenCalled();
		});
	});

	describe("lost messages", () => {
		it("should store messages for unknown connections", () => {
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Candidate,
				src: "sender",
				payload: {
					connectionId: "dc_future",
					candidate: { candidate: "test" },
				},
			});

			// Messages should be retrievable
			const messages = peer._getMessages("dc_future");
			expect(messages.length).toBe(1);
			expect(messages[0].type).toBe(ServerMessageType.Candidate);
		});

		it("should deliver stored messages when connection arrives", () =>
			new Promise<void>((resolve) => {
				// Store a candidate message first
				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Candidate,
					src: "sender",
					payload: {
						connectionId: "dc_delayed",
						candidate: { candidate: "test" },
					},
				});

				peer.on("connection", (conn) => {
					// The stored message should have been delivered
					// (handleMessage called internally)
					expect(conn.connectionId).toBe("dc_delayed");
					resolve();
				});

				// Now send the offer
				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "sender",
					payload: {
						type: ConnectionType.Data,
						connectionId: "dc_delayed",
						serialization: "binary",
						label: "test",
						reliable: false,
						metadata: {},
						sdp: { type: "offer", sdp: "fake" },
					},
				});
			}));

		it("should clear lost messages when retrieved via _getMessages", () => {
			// Store messages
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Candidate,
				src: "sender",
				payload: {
					connectionId: "dc_cleanup",
					candidate: { candidate: "test" },
				},
			});

			// First call retrieves and removes the messages
			const messages = peer._getMessages("dc_cleanup");
			expect(messages.length).toBe(1);

			// Second call should return empty - messages were consumed
			const messagesAfter = peer._getMessages("dc_cleanup");
			expect(messagesAfter.length).toBe(0);
		});
	});

	describe("malformed messages", () => {
		it("should warn on message without payload", () => {
			// Should not throw
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Candidate,
				src: "sender",
				payload: undefined,
			});
		});

		it("should warn on unrecognized message without connectionId", () => {
			// Should not throw
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Candidate,
				src: "sender",
				payload: {},
			});
		});
	});
});

describe("Dendri.getConnection", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8085, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("should return null for non-existent peer", () => {
		expect(peer.getConnection("nonexistent", "dc_123")).toBeNull();
	});

	it("should return null for non-existent connectionId", () => {
		peer.connect("2");
		expect(peer.getConnection("2", "dc_nonexistent")).toBeNull();
	});

	it("should find existing connection by peerId and connectionId", () => {
		const conn = peer.connect("2");
		expect(conn).toBeDefined();

		const found = peer.getConnection("2", conn.connectionId);
		expect(found).toBe(conn);
	});
});

describe("Dendri._removeConnection", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8085, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("should remove connection and clean up empty arrays", () => {
		const conn = peer.connect("2");
		expect(conn).toBeDefined();

		let connections = peer.connections as any;
		expect(connections["2"]).toBeDefined();

		conn.close();

		connections = peer.connections as any;
		// Empty array should be cleaned up
		expect(connections["2"]).toBeUndefined();
	});

	it("should only remove the specific connection", () => {
		const conn1 = peer.connect("2", { label: "c1" });
		const conn2 = peer.connect("2", { label: "c2" });

		expect(conn1).toBeDefined();
		expect(conn2).toBeDefined();

		conn1.close();

		const connections = peer.connections as any;
		expect(connections["2"]).toBeDefined();
		expect(connections["2"].length).toBe(1);
		expect(connections["2"][0]).toBe(conn2);
	});
});
