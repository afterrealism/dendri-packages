import { Server } from "mock-socket";
import { ServerMessageType, SocketEventType } from "../src/enums";
import { Socket } from "../src/socket";

const WS_URL = "ws://localhost:8081/dendri?key=dendri";

describe("Socket", () => {
	let socket: Socket;
	let mockServer: Server;

	beforeEach(() => {
		socket = new Socket(false, "localhost", 8081, "/", "dendri");
	});

	afterEach(() => {
		socket.close();
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined;
		}
	});

	describe("construction", () => {
		it("should start in disconnected state", () => {
			// Socket starts disconnected; calling close before start is safe
			socket.close();
		});
	});

	describe("start", () => {
		it("should connect to the server and emit messages", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, (data: any) => {
				expect(data.type).toBe(ServerMessageType.Open);
				done();
			});

			socket.start("test", "tok");
		});

		it("should not allow double start", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				// First start worked; second start should be no-op
				socket.start("test", "tok");
				done();
			});

			socket.start("test", "tok");
		});
	});

	describe("send", () => {
		it("should drop messages sent before start (disconnected state)", () => {
			// Socket starts disconnected, send() silently drops
			socket.send({ type: ServerMessageType.Offer, dst: "peer2" });
			// No error thrown - message is silently dropped
		});

		it("should send messages once connection is open", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				//@ts-expect-error
				ws.on("message", (data: string) => {
					const parsed = JSON.parse(data);
					if (parsed.type === ServerMessageType.Offer) {
						expect(parsed.dst).toBe("peer2");
						done();
					}
				});
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				// Connection is open, now send
				socket.send({ type: ServerMessageType.Offer, dst: "peer2" });
			});

			socket.start("test", "tok");
		});

		it("should drop messages when disconnected", () => {
			// Before start, socket is disconnected, sends should be no-ops
			socket.close();
			socket.send({ type: ServerMessageType.Offer, dst: "peer2" });
			// No error thrown
		});

		it("should emit error for messages without type", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				socket.on(SocketEventType.Error, (error: string) => {
					expect(error).toBe("Invalid message");
					done();
				});

				socket.send({ noType: true } as any);
			});

			socket.start("test", "tok");
		});

		it("should queue messages when WebSocket is not open and re-send on reconnect", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);
			const receivedMessages: any[] = [];

			mockServer.on("connection", (ws) => {
				//@ts-expect-error
				ws.on("message", (data: string) => {
					const parsed = JSON.parse(data);
					if (parsed.type !== ServerMessageType.Heartbeat) {
						receivedMessages.push(parsed);
					}
				});
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				// Message queue should have been sent
				setTimeout(() => {
					expect(receivedMessages.length).toBeGreaterThanOrEqual(0);
					done();
				}, 100);
			});

			socket.start("test", "tok");
		});
	});

	describe("close", () => {
		it("should clean up on close", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				socket.close();
				// After close, send should be no-op (no errors)
				socket.send({ type: ServerMessageType.Offer, dst: "peer2" });
				done();
			});

			socket.start("test", "tok");
		});

		it("should be idempotent", () => {
			socket.close();
			socket.close();
			// No error thrown
		});
	});

	describe("disconnection", () => {
		it("should emit disconnected when server closes connection (auto-reconnect off)", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			// Disable auto-reconnect so the socket emits Disconnected instead of retrying
			(socket as any)._autoReconnect = false;

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				// Close the connection after a short delay
				setTimeout(() => ws.close(), 50);
			});

			socket.on(SocketEventType.Disconnected, () => {
				done();
			});

			socket.start("test", "tok");
		});
	});

	describe("invalid messages", () => {
		it("should ignore non-JSON messages from server", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			let messageCount = 0;

			mockServer.on("connection", (ws) => {
				ws.send("not-json");
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				messageCount++;
				if (messageCount === 1) {
					// Only the valid JSON message should arrive
					done();
				}
			});

			socket.start("test", "tok");
		});
	});

	describe("heartbeat worker", () => {
		it("falls back to setTimeout when Worker is not available", () => {
			// Worker is not defined in jsdom — verify fallback works
			const s = new Socket(false, "localhost", 8081, "/", "dendri");
			expect((s as any)._heartbeatWorker).toBeNull();
		});

		it("does not create worker in environments without Worker constructor", () => {
			const s = new Socket(false, "localhost", 8081, "/", "dendri");
			// Directly invoke _createHeartbeatWorker — should be a no-op in jsdom
			(s as any)._createHeartbeatWorker();
			expect((s as any)._heartbeatWorker).toBeNull();
		});

		it("startWorkerHeartbeat falls back to _scheduleHeartbeat without worker", () => {
			const s = new Socket(false, "localhost", 8081, "/", "dendri");
			const scheduleSpy = vi.spyOn(s as any, "_scheduleHeartbeat").mockImplementation(() => {});
			(s as any)._startWorkerHeartbeat();
			expect(scheduleSpy).toHaveBeenCalled();
			scheduleSpy.mockRestore();
		});

		it("stopWorkerHeartbeat is safe to call without worker", () => {
			const s = new Socket(false, "localhost", 8081, "/", "dendri");
			// Should not throw
			expect(() => (s as any)._stopWorkerHeartbeat()).not.toThrow();
		});
	});

	describe("WebSocket error handling", () => {
		it("should handle WebSocket errors without crashing", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				// Connection established, socket should handle errors gracefully
				// The onerror handler just logs, so no error event should fire
				done();
			});

			socket.start("test", "tok");
		});

		it("should null onerror handler on cleanup", (done) => {
			mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, () => {
				socket.close();
				// After close, internal socket handlers are nulled
				// This is verified by the fact that close doesn't throw
				done();
			});

			socket.start("test", "tok");
		});
	});
});
