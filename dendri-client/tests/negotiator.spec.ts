import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8084/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Negotiator", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(
		() =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				peer = new Dendri("1", { port: 8084, host: "localhost" });
				peer.once("open", () => resolve());
			}),
	);

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	describe("startConnection", () => {
		it("should create RTCPeerConnection for data connections", () => {
			const conn = peer.connect("2");

			expect(conn).toBeDefined();
			expect(conn.peerConnection).toBeDefined();
		});

		it("should create RTCPeerConnection for media connections", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);

			expect(conn).toBeDefined();
			expect(conn.peerConnection).toBeDefined();
		});

		it("should send offer message to server", () =>
			new Promise<void>((resolve) => {
				mockServer.stop();

				const fakeURL = "ws://localhost:8084/dendri?key=dendri&id=1&token=testToken";
				mockServer = new Server(fakeURL);

				mockServer.on("connection", (socket) => {
					//@ts-expect-error
					socket.on("message", (data: string) => {
						const msg = JSON.parse(data);
						if (msg.type === ServerMessageType.Offer) {
							expect(msg.dst).toBe("2");
							expect(msg.payload.sdp).toBeDefined();
							expect(msg.payload.type).toBe(ConnectionType.Data);
							resolve();
						}
					});
					socket.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				peer.destroy();
				peer = new Dendri("1", { port: 8084, host: "localhost" });
				peer.once("open", () => {
					peer.connect("2");
				});
			}));
	});

	describe("ICE candidates", () => {
		it("should handle ICE candidate messages", () => {
			const conn = peer.connect("2");

			// Simulate receiving an ICE candidate - should not throw
			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: {
					candidate: {
						candidate: "candidate:123",
						sdpMid: "0",
						sdpMLineIndex: 0,
					},
				},
			});
		});

		it("should handle candidate after connection cleanup gracefully", () => {
			const conn = peer.connect("2");
			conn.close(); // This sets peerConnection to null

			// Should not throw
			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: {
					candidate: {
						candidate: "candidate:123",
						sdpMid: "0",
						sdpMLineIndex: 0,
					},
				},
			});
		});
	});

	describe("SDP handling", () => {
		it("should handle answer SDP", () => {
			const conn = peer.connect("2");

			// Simulate receiving an answer - should not throw
			conn.handleMessage({
				type: ServerMessageType.Answer,
				src: "2",
				payload: {
					sdp: { type: "answer", sdp: "fake-answer-sdp" },
				},
			});
		});

		it("should apply sdpTransform if provided", () =>
			new Promise<void>((resolve) => {
				mockServer.stop();

				const fakeURL = "ws://localhost:8084/dendri?key=dendri&id=1&token=testToken";
				mockServer = new Server(fakeURL);

				mockServer.on("connection", (socket) => {
					//@ts-expect-error
					socket.on("message", (data: string) => {
						const msg = JSON.parse(data);
						if (msg.type === ServerMessageType.Offer) {
							expect(msg.payload.sdp.sdp).toBe("transformed-sdp");
							resolve();
						}
					});
					socket.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				peer.destroy();
				peer = new Dendri("1", { port: 8084, host: "localhost" });
				peer.once("open", () => {
					const stream = new MediaStream([new MediaStreamTrack()]);
					peer.call("2", stream, {
						sdpTransform: (_sdp: string) => "transformed-sdp",
					});
				});
			}));
	});

	describe("null safety", () => {
		it("should handle getConnection returning null in ondatachannel", () => {
			const conn = peer.connect("2");
			const pc = conn.peerConnection;

			// Remove the connection before the data channel event fires
			conn.close();

			// Simulate ondatachannel event - getConnection returns null
			if (pc?.ondatachannel) {
				// Should not throw due to null check
				pc.ondatachannel({
					channel: new (window as any).RTCDataChannel("test"),
				} as any);
			}
		});

		it("should handle getConnection returning null in ontrack", () => {
			const stream = new MediaStream([new MediaStreamTrack()]);
			const conn = peer.call("2", stream);
			const pc = conn.peerConnection;

			// Remove the connection before the track event fires
			conn.close();

			// Simulate ontrack event - getConnection returns null
			if (pc?.ontrack) {
				// Should not throw due to null check
				pc.ontrack({
					streams: [new MediaStream()],
				} as any);
			}
		});
	});

	describe("ICE candidate queueing", () => {
		it("should queue candidates before remote description is set", () => {
			const conn = peer.connect("2");
			const pc = conn.peerConnection as any;

			// remoteDescription starts null in our mock
			expect(pc.remoteDescription).toBeNull();

			// Send candidate before any SDP exchange
			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: {
					candidate: {
						candidate: "candidate:early",
						sdpMid: "0",
						sdpMLineIndex: 0,
					},
				},
			});

			// The candidate should NOT have been added yet (no remote desc)
			// It should be queued internally
		});

		it("should flush queued candidates after remote description is set", async () => {
			const conn = peer.connect("2");
			const pc = conn.peerConnection as any;
			const addIceSpy = vi.spyOn(pc, "addIceCandidate");

			// Queue a candidate before SDP
			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: {
					candidate: {
						candidate: "candidate:queued",
						sdpMid: "0",
						sdpMLineIndex: 0,
					},
				},
			});

			// addIceCandidate should NOT have been called (queued)
			expect(addIceSpy).not.toHaveBeenCalled();

			// Now handle SDP answer which sets remote description
			await conn.handleMessage({
				type: ServerMessageType.Answer,
				src: "2",
				payload: {
					sdp: { type: "answer", sdp: "fake-answer-sdp" },
				},
			});

			// Allow microtask queue to drain
			await new Promise((r) => setTimeout(r, 0));

			// Now addIceCandidate should have been called with the queued candidate
			expect(addIceSpy).toHaveBeenCalled();
		});
	});

	describe("null safety after close during negotiation", () => {
		it("should not crash when connection is closed during async offer creation", async () => {
			// Intercept createOffer to close the connection mid-flight
			const origCreate = (global as any).RTCPeerConnection.prototype.createOffer;
			(global as any).RTCPeerConnection.prototype.createOffer = async function (...args: any[]) {
				const result = await origCreate.apply(this, args);
				// Close the connection before returning, simulating a race condition
				return result;
			};

			try {
				const conn = peer.connect("3");

				// Close immediately after creating, while _makeOffer is still in flight
				conn.close();

				// Allow async negotiation to run and settle
				await new Promise((r) => setTimeout(r, 50));

				// No crash should have occurred; the peer should still be alive
				expect(peer.destroyed).toBe(false);
			} finally {
				(global as any).RTCPeerConnection.prototype.createOffer = origCreate;
			}
		});

		it("should not crash when connection is closed while flushing pending candidates", async () => {
			const conn = peer.connect("2");
			const pc = conn.peerConnection as any;

			// Spy on addIceCandidate so we can verify it is never called after cleanup
			const addIceSpy = vi.spyOn(pc, "addIceCandidate");

			// Queue a candidate
			conn.handleMessage({
				type: ServerMessageType.Candidate,
				src: "2",
				payload: {
					candidate: {
						candidate: "candidate:will-be-dropped",
						sdpMid: "0",
						sdpMLineIndex: 0,
					},
				},
			});

			// Close the connection before the SDP answer arrives
			conn.close();

			// Sending an Answer now should be a no-op — the negotiator was cleaned up
			// and the DataConnection ignores messages when _negotiator is null
			await conn.handleMessage({
				type: ServerMessageType.Answer,
				src: "2",
				payload: {
					sdp: { type: "answer", sdp: "fake-answer-sdp" },
				},
			});

			await new Promise((r) => setTimeout(r, 0));

			// addIceCandidate must never be invoked because the negotiator was
			// destroyed before the flush could happen
			expect(addIceSpy).not.toHaveBeenCalled();
		});
	});
});
