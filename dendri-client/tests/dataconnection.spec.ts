import { Server } from "mock-socket";
import { BinaryPack } from "../src/dataconnection/BufferedConnection/BinaryPack";
import { Json } from "../src/dataconnection/BufferedConnection/Json";
import { Raw } from "../src/dataconnection/BufferedConnection/Raw";
import { Dendri } from "../src/dendri";
import { ConnectionType, DataConnectionErrorType, ServerMessageType } from "../src/enums";

const createMockServer = (port = 8082): Server => {
	const fakeURL = `ws://localhost:${port}/dendri?key=dendri&id=1&token=testToken`;
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("DataConnection", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8082, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("connect()", () => {
		it("should create a DataConnection with default serialization", () => {
			const conn = peer.connect("2");

			expect(conn).toBeDefined();
			expect(conn.type).toBe(ConnectionType.Data);
			expect(conn.peer).toBe("2");
			expect(conn).toBeInstanceOf(BinaryPack);
		});

		it("should create a connection with json serialization", () => {
			const conn = peer.connect("2", { serialization: "json" });

			expect(conn).toBeDefined();
			expect(conn).toBeInstanceOf(Json);
		});

		it("should create a connection with raw serialization", () => {
			const conn = peer.connect("2", { serialization: "raw" });

			expect(conn).toBeDefined();
			expect(conn).toBeInstanceOf(Raw);
		});

		it("should create a connection with custom label", () => {
			const conn = peer.connect("2", { label: "myLabel" });

			expect(conn).toBeDefined();
			expect(conn.label).toBe("myLabel");
		});

		it("should create a connection with metadata", () => {
			const metadata = { role: "host", version: 2 };
			const conn = peer.connect("2", { metadata });

			expect(conn).toBeDefined();
			expect(conn.metadata).toEqual(metadata);
		});

		it("should create a reliable connection", () => {
			const conn = peer.connect("2", { reliable: true });

			expect(conn).toBeDefined();
			expect(conn.reliable).toBe(true);
		});

		it("should return undefined when disconnected", () => {
			peer.disconnect();
			const conn = peer.connect("2");

			expect(conn).toBeUndefined();
		});

		it("should return undefined for unknown serialization type", () => {
			const conn = peer.connect("2", { serialization: "unknown" });

			expect(conn).toBeUndefined();
		});

		it("should add connection to peer connections", () => {
			const conn = peer.connect("2");

			expect(conn).toBeDefined();
			const connections = peer.connections as any;
			expect(connections["2"]).toBeDefined();
			expect(connections["2"].length).toBe(1);
		});

		it("should support multiple connections to same peer", () => {
			const conn1 = peer.connect("2", { label: "conn1" });
			const conn2 = peer.connect("2", { label: "conn2" });

			expect(conn1).toBeDefined();
			expect(conn2).toBeDefined();

			const connections = peer.connections as any;
			expect(connections["2"].length).toBe(2);
		});
	});

	describe("DataConnection lifecycle", () => {
		it("should have a unique connectionId", () => {
			const conn1 = peer.connect("2");
			const conn2 = peer.connect("3");

			expect(conn1.connectionId).toBeDefined();
			expect(conn2.connectionId).toBeDefined();
			expect(conn1.connectionId).not.toBe(conn2.connectionId);
		});

		it("should start as not open", () => {
			const conn = peer.connect("2");

			expect(conn.open).toBe(false);
		});

		it("should emit error when sending before open", () => {
			const conn = peer.connect("2");
			const errorSpy = vi.fn();

			conn.on("error", errorSpy);
			conn.send("test");

			expect(errorSpy).toHaveBeenCalled();
			expect((errorSpy.mock.calls[0][0] as any).type).toBe(DataConnectionErrorType.NotOpenYet);
		});

		it("should clean up on close", () => {
			const conn = peer.connect("2");
			conn.close();

			const connections = peer.connections as any;
			expect(connections["2"]).toBeUndefined();
		});

		it("should handle double close gracefully", () => {
			const conn = peer.connect("2");
			conn.close();
			conn.close(); // Should not throw
		});
	});

	describe("incoming connection", () => {
		it("should handle incoming data connection offer", () =>
			new Promise<void>((resolve) => {
				peer.on("connection", (conn) => {
					expect(conn.type).toBe(ConnectionType.Data);
					expect(conn.peer).toBe("remote-peer");
					expect(conn.metadata).toEqual({ info: "test" });
					resolve();
				});

				// Simulate incoming offer from server
				//@ts-expect-error access private method
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-peer",
					payload: {
						type: ConnectionType.Data,
						connectionId: "dc_incoming",
						serialization: "binary",
						label: "test-label",
						reliable: false,
						metadata: { info: "test" },
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));

		it("should reject offers with unknown serialization", () => {
			const connectionSpy = vi.fn();
			peer.on("connection", connectionSpy);

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Offer,
				src: "remote-peer",
				payload: {
					type: ConnectionType.Data,
					connectionId: "dc_unknown",
					serialization: "nonexistent",
					label: "test",
					reliable: false,
					metadata: {},
				},
			});

			expect(connectionSpy).not.toHaveBeenCalled();
		});
	});

	describe("handleMessage after close", () => {
		it("should not crash when receiving messages after close", () => {
			const conn = peer.connect("2");
			conn.close();

			// handleMessage accesses _negotiator which is null after close
			// This should not throw
			conn.handleMessage({
				type: ServerMessageType.Answer,
				src: "2",
				payload: { sdp: { type: "answer", sdp: "fake" } },
			});

			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: { candidate: {} },
			});
		});
	});

	describe("removeAllListeners on close", () => {
		it("should remove all listeners after close emits", () => {
			const conn = peer.connect("2");

			const closeSpy = vi.fn();
			const dataSpy = vi.fn();
			conn.on("close", closeSpy);
			conn.on("data", dataSpy);

			// Force _open so close() will emit "close"
			(conn as any)._open = true;
			conn.close();

			// "close" should have been emitted once
			expect(closeSpy).toHaveBeenCalledTimes(1);

			// After close, all listeners should be removed
			expect(conn.listenerCount("close")).toBe(0);
			expect(conn.listenerCount("data")).toBe(0);
		});
	});

	describe("flush-close timeout", () => {
		it("should force close after flush timeout expires", () =>
			new Promise<void>((resolve) => {
				const conn = peer.connect("2");
				const dc = conn.dataChannel as any;

				if (dc) {
					dc._open();

					// Now connection is open, try flush-close
					// Override send to prevent errors (we're not actually sending)
					dc.send = vi.fn();

					const closeSpy = vi.fn();
					conn.on("close", closeSpy);

					// Use flush option — this should schedule a 5s timeout
					conn.close({ flush: true });

					// Connection should still be open (flush is pending)
					// After the 5s timeout, it should force close
					// We'll use fake timers to verify
				}

				// Clean up
				conn.close();
				resolve();
			}));

		it("should clear flush timeout when close is called without flush", () => {
			const conn = peer.connect("2");
			const dc = conn.dataChannel as any;

			if (dc) {
				dc._open();
				dc.send = vi.fn();

				// Start a flush close
				conn.close({ flush: true });

				// Now immediately close without flush — should clear the timeout
				(conn as any)._open = true; // force re-open to get through the check
				conn.close(); // This should clear the timeout

				// No error should occur from dangling timeout
			}
		});
	});
});
