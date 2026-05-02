import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, ServerMessageType } from "../src/enums";
import { MediaConnection } from "../src/mediaconnection";
import { util } from "../src/util";
import { randomToken } from "../src/utils/randomToken";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8083/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("MediaConnection", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8083, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("call()", () => {
		it("should create a MediaConnection with a stream", () => {
			const track = new MediaStreamTrack();
			const stream = new MediaStream([track]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			expect(conn.type).toBe(ConnectionType.Media);
			expect(conn.peer).toBe("2");
		});

		it("should set metadata on the connection", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream, {
				metadata: { caller: "user1" },
			});

			expect(conn).toBeDefined();
			expect(conn.metadata).toEqual({ caller: "user1" });
		});

		it("should return undefined when disconnected", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			peer.disconnect();
			const conn = peer.call("2", stream);

			expect(conn).toBeUndefined();
		});

		it("should return undefined when no stream provided", () => {
			const conn = peer.call("2", null as any);

			expect(conn).toBeUndefined();
		});

		it("should add the track to peer connection senders", () => {
			const track = new MediaStreamTrack();
			const stream = new MediaStream([track]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			const senders = conn.peerConnection.getSenders();
			expect(senders.length).toBe(1);
			expect(senders[0].track.id).toBe(track.id);
		});

		it("should have a unique connectionId", () => {
			// Restore real randomToken for this test since the mock returns a constant
			const savedToken = util.randomToken;
			util.randomToken = randomToken;

			try {
				const stream = new MediaStream([new MediaStreamTrack()]);
				const conn1 = peer.call("2", stream);
				const conn2 = peer.call("3", stream);

				expect(conn1).toBeDefined();
				expect(conn2).toBeDefined();
				expect(conn1.connectionId).not.toBe(conn2.connectionId);
			} finally {
				util.randomToken = savedToken;
			}
		});
	});

	describe("incoming call", () => {
		it("should emit call event for incoming media offer", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					expect(mediaConn).toBeInstanceOf(MediaConnection);
					expect(mediaConn.type).toBe(ConnectionType.Media);
					expect(mediaConn.peer).toBe("remote-caller");
					expect(mediaConn.metadata).toEqual({ video: true });
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_incoming",
						metadata: { video: true },
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));
	});

	describe("close()", () => {
		it("should clean up resources on close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			conn.close();

			expect(conn.open).toBe(false);
			// Connection should be removed from peer
			const connections = peer.connections as any;
			expect(connections["2"]).toBeUndefined();
		});

		it("should handle double close gracefully", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			conn.close();
			conn.close(); // Should not throw
		});
	});

	describe("handleMessage after close", () => {
		it("should not crash when receiving messages after close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			conn.close();

			// Should not throw even though _negotiator is null
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

	describe("answer() after close", () => {
		it("should not crash when calling answer() on a closed connection", () =>
			new Promise<void>((resolve) => {
				// Simulate incoming call
				peer.on("call", (mediaConn) => {
					// Close the connection first
					mediaConn.close();

					// Now try to answer - should not throw
					const stream = new MediaStream([new MediaStreamTrack()]);
					mediaConn.answer(stream);

					// Verify connection is still closed
					expect(mediaConn.open).toBe(false);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_test_answer_after_close",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));
	});

	describe("removeAllListeners on close", () => {
		it("should remove all listeners after close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			const closeSpy = vi.fn();
			const streamSpy = vi.fn();
			conn.on("close", closeSpy);
			conn.on("stream", streamSpy);

			// Force _open so close emits the event
			(conn as any)._open = true;
			conn.close();

			// "close" was emitted once
			expect(closeSpy).toHaveBeenCalledTimes(1);

			// After close, listeners should be removed
			expect(conn.listenerCount("close")).toBe(0);
			expect(conn.listenerCount("stream")).toBe(0);
		});
	});
});
