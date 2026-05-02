import { Server } from "mock-socket";
import { ServerMessageType, SocketEventType } from "../src/enums";
import { Socket } from "../src/socket";

const WS_URL = "ws://localhost:8091/dendri?key=dendri";

describe("Socket — comprehensive", () => {
	let socket: Socket;
	let mockServer: Server;

	beforeEach(() => {
		vi.useFakeTimers();
		socket = new Socket(false, "localhost", 8091, "/", "dendri");
	});

	afterEach(() => {
		socket.close();
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined as any;
		}
		vi.useRealTimers();
	});

	// -----------------------------------------------------------------------
	// 1. Reconnect backoff delays
	// -----------------------------------------------------------------------
	describe("reconnect backoff delays", () => {
		it("should return base delay 0ms for attempt 0 (with jitter)", () => {
			const origRandom = Math.random;
			Math.random = () => 0.5; // jitter = 0

			try {
				(socket as any)._reconnectAttempt = 0;
				const delay = (socket as any)._getReconnectDelay();
				expect(delay).toBe(0);
			} finally {
				Math.random = origRandom;
			}
		});

		it("should follow BACKOFF_SCHEDULE for attempts 0-6", () => {
			const origRandom = Math.random;
			Math.random = () => 0.5; // jitter = 0

			try {
				const expected = [0, 1000, 2000, 4000, 8000, 16000, 30000];
				for (let attempt = 0; attempt < expected.length; attempt++) {
					(socket as any)._reconnectAttempt = attempt;
					const delay = (socket as any)._getReconnectDelay();
					expect(delay).toBe(expected[attempt]);
				}
			} finally {
				Math.random = origRandom;
			}
		});

		it("should cap at 30000ms for attempts >= 6", () => {
			const origRandom = Math.random;
			Math.random = () => 0.5;

			try {
				for (const attempt of [6, 7, 10, 50, 100]) {
					(socket as any)._reconnectAttempt = attempt;
					const delay = (socket as any)._getReconnectDelay();
					expect(delay).toBe(30000);
				}
			} finally {
				Math.random = origRandom;
			}
		});
	});

	// -----------------------------------------------------------------------
	// 2. Reconnect jitter range
	// -----------------------------------------------------------------------
	describe("reconnect jitter", () => {
		it("should apply jitter within +/-500ms range", () => {
			const origRandom = Math.random;

			// With Math.random = 0, jitter = -500
			Math.random = () => 0;
			(socket as any)._reconnectAttempt = 3; // base = 4000
			const delayLow = (socket as any)._getReconnectDelay();
			expect(delayLow).toBe(3500); // 4000 - 500

			// With Math.random = 1, jitter = +500
			Math.random = () => 1;
			(socket as any)._reconnectAttempt = 3;
			const delayHigh = (socket as any)._getReconnectDelay();
			expect(delayHigh).toBe(4500); // 4000 + 500

			// Range should be exactly 1000ms (+-500)
			expect(delayHigh - delayLow).toBe(1000);

			Math.random = origRandom;
		});

		it("should never return a negative delay (attempt 0 with max negative jitter)", () => {
			const origRandom = Math.random;
			Math.random = () => 0; // jitter = -500

			try {
				(socket as any)._reconnectAttempt = 0;
				const delay = (socket as any)._getReconnectDelay();
				expect(delay).toBeGreaterThanOrEqual(0);
			} finally {
				Math.random = origRandom;
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. autoReconnect=false prevents reconnection
	// -----------------------------------------------------------------------
	describe("autoReconnect=false prevents reconnection", () => {
		it("should emit Disconnected instead of scheduling reconnect when autoReconnect is false", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Disable auto-reconnect
					(socket as any)._autoReconnect = false;

					const disconnectedSpy = vi.fn();
					const reconnectSpy = vi.fn();
					socket.on(SocketEventType.Disconnected, disconnectedSpy);
					socket.on(SocketEventType.ReconnectAttempt, reconnectSpy);

					// Close the server to trigger disconnect
					mockServer.close();

					// Give time for close event to propagate
					setTimeout(() => {
						expect(disconnectedSpy).toHaveBeenCalled();
						expect(reconnectSpy).not.toHaveBeenCalled();
						resolve();
					}, 100);
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 4. autoReconnect=true triggers reconnection
	// -----------------------------------------------------------------------
	describe("autoReconnect=true triggers reconnection", () => {
		it("should schedule reconnect on unexpected close", () => {
			(socket as any)._autoReconnect = true;
			(socket as any)._disconnected = false;
			(socket as any)._id = "test";
			(socket as any)._token = "tok";

			expect((socket as any)._reconnectAttempt).toBe(0);

			(socket as any)._scheduleReconnect();

			expect((socket as any)._reconnectAttempt).toBe(1);
		});

		it("should emit reconnect-attempt event", () => {
			(socket as any)._autoReconnect = true;
			(socket as any)._disconnected = false;
			(socket as any)._id = "test";
			(socket as any)._token = "tok";

			const spy = vi.fn();
			socket.on(SocketEventType.ReconnectAttempt, spy);

			(socket as any)._scheduleReconnect();

			expect(spy).toHaveBeenCalledWith(1);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Explicit close() sets autoReconnect=false
	// -----------------------------------------------------------------------
	describe("explicit close disables autoReconnect", () => {
		it("should set _autoReconnect to false on close()", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._autoReconnect).toBe(true);

					socket.close();

					expect((socket as any)._autoReconnect).toBe(false);
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 6. last_seq is sent on reconnect URL
	// -----------------------------------------------------------------------
	describe("last_seq on reconnect", () => {
		it("should track seq from incoming messages", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open, seq: 42 }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._lastSeq).toBe(42);
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should start with _lastSeq = 0", () => {
			expect((socket as any)._lastSeq).toBe(0);
		});

		it("should update _lastSeq on each message with seq", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);
				let msgCount = 0;

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open, seq: 1 }));
					ws.send(JSON.stringify({ type: ServerMessageType.Data, seq: 5, payload: "a" }));
					ws.send(JSON.stringify({ type: ServerMessageType.Data, seq: 10, payload: "b" }));
				});

				socket.on(SocketEventType.Message, () => {
					msgCount++;
					if (msgCount === 3) {
						expect((socket as any)._lastSeq).toBe(10);
						resolve();
					}
				});

				socket.start("test", "tok");
			}));

		it("should not update _lastSeq for messages without seq", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);
				let msgCount = 0;

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open, seq: 7 }));
					ws.send(JSON.stringify({ type: ServerMessageType.Data, payload: "no-seq" }));
				});

				socket.on(SocketEventType.Message, () => {
					msgCount++;
					if (msgCount === 2) {
						// _lastSeq should still be 7, not updated by the no-seq message
						expect((socket as any)._lastSeq).toBe(7);
						resolve();
					}
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 7. Heartbeat fires every pingInterval ms
	// -----------------------------------------------------------------------
	describe("heartbeat scheduling", () => {
		it("should schedule heartbeat after connection opens", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// _wsPingTimer or _heartbeatWorker should be set
					const hasTimer = (socket as any)._wsPingTimer !== undefined;
					const hasWorker = (socket as any)._heartbeatWorker !== null;
					expect(hasTimer || hasWorker).toBe(true);
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should send heartbeat messages at configured interval", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				// Short ping interval for test speed
				const heartbeatSocket = new Socket(false, "localhost", 8091, "/", "dendri", 100);

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				const heartbeats: any[] = [];

				mockServer.on("connection", (ws) => {
					// @ts-expect-error mock-socket types
					ws.on("message", (data: string) => {
						const parsed = JSON.parse(data);
						if (parsed.type === ServerMessageType.Heartbeat) {
							heartbeats.push(parsed);
							if (heartbeats.length >= 2) {
								heartbeatSocket.close();
								resolve();
							}
						}
					});
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				heartbeatSocket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 8. Visibility handler: pause on hidden, resume on visible
	// -----------------------------------------------------------------------
	describe("visibility handler", () => {
		it("should register a visibilitychange listener on start", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._visibilityHandler).toBeDefined();
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should remove visibilitychange listener on close", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._visibilityHandler).toBeDefined();

					socket.close();

					expect((socket as any)._visibilityHandler).toBeUndefined();
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 9. Worker heartbeat fallback when Worker is not available
	// -----------------------------------------------------------------------
	describe("Worker heartbeat fallback", () => {
		it("should fall back to setTimeout when Worker is unavailable", () => {
			const origWorker = globalThis.Worker;
			const origBlob = globalThis.Blob;

			// Remove Worker to simulate environment without it
			// @ts-expect-error testing
			delete globalThis.Worker;

			try {
				const s = new Socket(false, "localhost", 8091, "/", "dendri", 1000);
				// Access internal method
				(s as any)._createHeartbeatWorker();

				// Worker should be null since Worker global doesn't exist
				expect((s as any)._heartbeatWorker).toBeNull();
				s.close();
			} finally {
				globalThis.Worker = origWorker;
			}
		});

		it("should use setTimeout-based heartbeat when worker is null", () => {
			const s = new Socket(false, "localhost", 8091, "/", "dendri", 1000);
			(s as any)._heartbeatWorker = null;

			// _startWorkerHeartbeat should fall back to _scheduleHeartbeat
			const scheduleSpy = vi.spyOn(s as any, "_scheduleHeartbeat");
			(s as any)._startWorkerHeartbeat();

			expect(scheduleSpy).toHaveBeenCalled();
			s.close();
		});
	});

	// -----------------------------------------------------------------------
	// 10. Message queue: messages queued while disconnected, sent on reconnect
	// -----------------------------------------------------------------------
	describe("message queue", () => {
		it("should queue messages sent before id is set", () => {
			(socket as any)._disconnected = false;
			// _id is not set

			socket.send({ type: ServerMessageType.Offer, dst: "peer" });

			expect((socket as any)._messagesQueue.length).toBe(1);
		});

		it("should queue messages when socket is not open", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Close the underlying ws but keep _disconnected false
					const ws = (socket as any)._socket;
					if (ws) ws.close();
					(socket as any)._socket = undefined;
					(socket as any)._disconnected = false;

					socket.send({ type: ServerMessageType.Offer, dst: "peer" });

					expect((socket as any)._messagesQueue.length).toBe(1);
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should not queue or send when disconnected", () => {
			(socket as any)._disconnected = true;

			socket.send({ type: ServerMessageType.Offer, dst: "peer" });

			expect((socket as any)._messagesQueue.length).toBe(0);
		});

		it("should emit error for messages without type", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					const errorSpy = vi.fn();
					socket.on(SocketEventType.Error, errorSpy);

					socket.send({ dst: "peer" }); // no type

					expect(errorSpy).toHaveBeenCalledWith("Invalid message");
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should flush queued messages when socket reconnects/opens", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				const receivedMessages: any[] = [];

				mockServer.on("connection", (ws) => {
					// @ts-expect-error mock-socket types
					ws.on("message", (data: string) => {
						const parsed = JSON.parse(data);
						if (parsed.type === ServerMessageType.Offer) {
							receivedMessages.push(parsed);
							if (receivedMessages.length >= 1) {
								resolve();
							}
						}
					});
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Now that we're connected, close the underlying socket
					// and queue a message while it's not open
					const ws = (socket as any)._socket;
					if (ws) ws.close();
					(socket as any)._socket = undefined;
					(socket as any)._disconnected = false;

					// Queue a message (socket not open, so it gets queued)
					socket.send({ type: ServerMessageType.Offer, dst: "peer" });
					expect((socket as any)._messagesQueue.length).toBe(1);

					// Manually flush the queue as if socket just reconnected
					(socket as any)._socket = new WebSocket(`${WS_URL}&id=test&token=tok&version=2.0.0`);
					(socket as any)._sendQueuedMessages();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 11. WebSocket error followed by close
	// -----------------------------------------------------------------------
	describe("error followed by close", () => {
		it("should not trigger reconnect on error alone (close does the reconnect)", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Socket error handler just logs, doesn't trigger reconnect
					const ws = (socket as any)._socket;
					if (ws && ws.onerror) {
						ws.onerror(new Event("error"));
					}

					// _reconnectAttempt should still be 0 (error alone doesn't reconnect)
					expect((socket as any)._reconnectAttempt).toBe(0);
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 12. send() with various data types
	// -----------------------------------------------------------------------
	describe("send with various data types", () => {
		it("should serialize and send objects", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					// @ts-expect-error mock-socket types
					ws.on("message", (data: string) => {
						const parsed = JSON.parse(data);
						if (parsed.type === ServerMessageType.Data) {
							expect(parsed.payload).toEqual({ nested: { key: "value" } });
							resolve();
						}
					});
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					socket.send({
						type: ServerMessageType.Data,
						payload: { nested: { key: "value" } },
					});
				});

				socket.start("test", "tok");
			}));

		it("should serialize and send arrays in payload", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					// @ts-expect-error mock-socket types
					ws.on("message", (data: string) => {
						const parsed = JSON.parse(data);
						if (parsed.type === ServerMessageType.Data) {
							expect(parsed.payload).toEqual([1, 2, 3]);
							resolve();
						}
					});
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					socket.send({
						type: ServerMessageType.Data,
						payload: [1, 2, 3],
					});
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 13. Reconnected event
	// -----------------------------------------------------------------------
	describe("reconnected event", () => {
		it("should emit Reconnected when reconnecting succeeds", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Simulate a previous reconnect attempt
					(socket as any)._reconnectAttempt = 1;

					socket.on(SocketEventType.Reconnected, () => {
						resolve();
					});

					// Trigger onopen to simulate reconnection
					const ws = (socket as any)._socket;
					if (ws && ws.onopen) {
						ws.onopen();
					}
				});

				socket.start("test", "tok");
			}));

		it("should reset reconnectAttempt on successful reconnection", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// After successful connection, reconnectAttempt should be reset
					expect((socket as any)._reconnectAttempt).toBe(0);
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 14. Cleanup clears all resources
	// -----------------------------------------------------------------------
	describe("cleanup", () => {
		it("should clear reconnect timer on close", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Set a reconnect timer
					(socket as any)._reconnectTimer = setTimeout(() => {}, 10000);

					socket.close();

					expect((socket as any)._reconnectTimer).toBeUndefined();
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should clear heartbeat timer on close", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					socket.close();

					// Worker should be terminated
					expect((socket as any)._heartbeatWorker).toBeNull();
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should nullify socket on close", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._socket).toBeDefined();

					socket.close();

					expect((socket as any)._socket).toBeUndefined();
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 15. Double start is no-op
	// -----------------------------------------------------------------------
	describe("double start", () => {
		it("should not create a second socket when start is called twice", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.start("test", "tok");

				// Second start should be a no-op
				const socketRef = (socket as any)._socket;
				socket.start("test", "tok");
				expect((socket as any)._socket).toBe(socketRef);

				// Wait for connection to verify first start worked
				socket.on(SocketEventType.Message, () => {
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 16. Close before connect
	// -----------------------------------------------------------------------
	describe("close before connect", () => {
		it("should handle close() on unstarted socket gracefully", () => {
			// _disconnected is true initially, so close() is a no-op
			expect(() => socket.close()).not.toThrow();
		});
	});

	// -----------------------------------------------------------------------
	// 17. reconnectAttempt getter
	// -----------------------------------------------------------------------
	describe("reconnectAttempt getter", () => {
		it("should expose the current reconnect attempt count", () => {
			expect(socket.reconnectAttempt).toBe(0);

			(socket as any)._reconnectAttempt = 5;
			expect(socket.reconnectAttempt).toBe(5);
		});
	});

	// -----------------------------------------------------------------------
	// 18. Invalid JSON message handling
	// -----------------------------------------------------------------------
	describe("invalid JSON message", () => {
		it("should not emit message event for invalid JSON", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				const messagesSpy = vi.fn();

				mockServer.on("connection", (ws) => {
					// Send invalid JSON first, then valid
					ws.send("not json!!!");
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, (data) => {
					messagesSpy(data);
					// Should only receive the valid OPEN message
					if ((data as any).type === ServerMessageType.Open) {
						expect(messagesSpy).toHaveBeenCalledTimes(1);
						resolve();
					}
				});

				socket.start("test", "tok");
			}));
	});

	// -----------------------------------------------------------------------
	// 19. JWT in WebSocket URL
	// -----------------------------------------------------------------------
	describe("JWT support", () => {
		it("should include jwt parameter in initial connection URL", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				const jwtSocket = new Socket(
					false,
					"localhost",
					8091,
					"/",
					"dendri",
					5000,
					"test-jwt-token",
				);

				const jwtUrl = `${WS_URL}&id=test&token=tok&jwt=test-jwt-token&version=2.0.0`;
				mockServer = new Server(jwtUrl);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				jwtSocket.on(SocketEventType.Message, () => {
					jwtSocket.close();
					resolve();
				});

				jwtSocket.start("test", "tok");
			}));
	});
});
