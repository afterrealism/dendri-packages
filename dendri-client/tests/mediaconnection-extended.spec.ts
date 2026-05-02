import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, ServerMessageType } from "../src/enums";
import { MediaConnection } from "../src/mediaconnection";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8093/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("MediaConnection extended", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8093, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("answer()", () => {
		it("should answer an incoming call with a stream", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					const stream = new MediaStream([new MediaStreamTrack()]);
					mediaConn.answer(stream);

					expect(mediaConn.localStream).toBe(stream);
					expect(mediaConn.open).toBe(true);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_answer_test",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));

		it("should answer without a stream (receive-only)", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					mediaConn.answer(); // No stream

					expect(mediaConn.localStream).toBeNull();
					expect(mediaConn.open).toBe(true);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_answer_no_stream",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));

		it("should warn and return when answering twice", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					const stream1 = new MediaStream([new MediaStreamTrack()]);
					const stream2 = new MediaStream([new MediaStreamTrack()]);

					mediaConn.answer(stream1);

					// Second answer should be a no-op (logged warning)
					mediaConn.answer(stream2);

					// localStream should still be the first stream
					expect(mediaConn.localStream).toBe(stream1);
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_double_answer",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));

		it("should apply sdpTransform from answer options", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					const stream = new MediaStream([new MediaStreamTrack()]);
					mediaConn.answer(stream, {
						sdpTransform: (sdp: string) => `modified-${sdp}`,
					});

					expect(mediaConn.options.sdpTransform).toBeDefined();
					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_sdp_transform",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));

		it("should process stored messages on answer", () =>
			new Promise<void>((resolve) => {
				peer.on("call", (mediaConn) => {
					// Store a message for this connection before answering
					// @ts-expect-error
					peer._storeMessage(mediaConn.connectionId, {
						type: ServerMessageType.Candidate,
						src: "remote-caller",
						payload: {
							candidate: {
								candidate: "candidate:stored",
								sdpMid: "0",
								sdpMLineIndex: 0,
							},
						},
					});

					const stream = new MediaStream([new MediaStreamTrack()]);
					mediaConn.answer(stream);

					// The stored messages should have been retrieved
					// @ts-expect-error
					const remainingMessages = peer._getMessages(mediaConn.connectionId);
					expect(remainingMessages).toEqual([]);

					resolve();
				});

				//@ts-expect-error
				peer._handleMessage({
					type: ServerMessageType.Offer,
					src: "remote-caller",
					payload: {
						type: ConnectionType.Media,
						connectionId: "mc_stored_msgs",
						metadata: {},
						sdp: { type: "offer", sdp: "fake-offer-sdp" },
					},
				});
			}));
	});

	describe("close()", () => {
		it("should clean up localStream on close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			expect(conn.localStream).toBeDefined();

			conn.close();

			expect(conn.localStream).toBeNull();
			expect(conn.remoteStream).toBeNull();
		});

		it("should null out options._stream on close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();

			conn.close();

			expect(conn.options._stream).toBeNull();
		});

		it("should set provider to null after close", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			expect((conn as any).provider).toBeDefined();

			conn.close();

			expect((conn as any).provider).toBeNull();
		});
	});

	describe("handleMessage", () => {
		it("should warn for unrecognized message types", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			// Should not throw for unknown message type
			conn.handleMessage({
				type: "UNKNOWN" as any,
				src: "2",
				payload: {},
			});
		});

		it("should handle Answer message and set _open", async () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			conn.handleMessage({
				type: ServerMessageType.Answer,
				src: "2",
				payload: {
					sdp: { type: "answer", sdp: "fake-answer-sdp" },
				},
			});

			// Allow the async handleSDP to resolve
			await new Promise((r) => setTimeout(r, 50));

			expect(conn.open).toBe(true);
		});
	});

	describe("_initializeDataChannel", () => {
		it("should emit willCloseOnRemote on data channel open", () =>
			new Promise<void>((resolve) => {
				const stream = new MediaStream([new MediaStreamTrack()]);
				const conn = peer.call("2", stream);

				const dc = new (window as any).RTCDataChannel("aux-channel");

				conn.on("willCloseOnRemote", () => {
					resolve();
				});

				conn._initializeDataChannel(dc);
				dc._open();
			}));

		it("should close connection when data channel closes", () =>
			new Promise<void>((resolve) => {
				const stream = new MediaStream([new MediaStreamTrack()]);
				const conn = peer.call("2", stream);

				const dc = new (window as any).RTCDataChannel("aux-channel");
				conn._initializeDataChannel(dc);

				// Force open first
				(conn as any)._open = true;

				conn.on("close", () => {
					resolve();
				});

				dc.close();
			}));
	});

	describe("addStream", () => {
		it("should set remote stream and emit stream event", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			const remoteStream = new MediaStream([new MediaStreamTrack()]);
			const streamSpy = vi.fn();
			conn.on("stream", streamSpy);

			conn.addStream(remoteStream);

			expect(conn.remoteStream).toBe(remoteStream);
			expect(streamSpy).toHaveBeenCalledWith(remoteStream);
		});
	});
});
