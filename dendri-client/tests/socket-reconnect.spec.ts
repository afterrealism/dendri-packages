import { Server } from "mock-socket";
import { ServerMessageType, SocketEventType } from "../src/enums";
import { Socket } from "../src/socket";

const WS_URL = "ws://localhost:8090/dendri?key=dendri";

describe("Socket reconnection", () => {
	let socket: Socket;
	let mockServer: Server;

	beforeEach(() => {
		vi.useFakeTimers();
		socket = new Socket(false, "localhost", 8090, "/", "dendri");
	});

	afterEach(() => {
		socket.close();
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined as any;
		}
		vi.useRealTimers();
	});

	describe("_autoReconnect behavior", () => {
		it("should auto-reconnect by default (autoReconnect is true)", () => {
			const disconnectedSpy = vi.fn();
			socket.on(SocketEventType.Disconnected, disconnectedSpy);

			// Access private field to verify default
			expect((socket as any)._autoReconnect).toBe(true);
		});

		it("should disable auto-reconnect on explicit close()", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Enable auto-reconnect
					(socket as any)._autoReconnect = true;

					// Explicit close should disable auto-reconnect
					socket.close();

					expect((socket as any)._autoReconnect).toBe(false);
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	describe("_scheduleReconnect", () => {
		it("should increment reconnectAttempt when auto-reconnect is enabled", () => {
			// Directly test the reconnect scheduling logic without real WebSocket timing
			(socket as any)._autoReconnect = true;
			(socket as any)._disconnected = false;
			(socket as any)._id = "test";

			// Simulate an unexpected close triggering reconnect scheduling
			(socket as any)._reconnectAttempt = 0;
			(socket as any)._scheduleReconnect();

			// reconnectAttempt should have incremented
			expect((socket as any)._reconnectAttempt).toBe(1);
		});
	});

	describe("_getReconnectDelay", () => {
		it("should return 0 (with jitter) for first attempt", () => {
			(socket as any)._reconnectAttempt = 0;
			const delay = (socket as any)._getReconnectDelay();
			// First attempt base is 0, jitter is +/- 500
			expect(delay).toBeGreaterThanOrEqual(0);
			expect(delay).toBeLessThanOrEqual(500);
		});

		it("should increase delay for subsequent attempts", () => {
			// Get multiple delays and verify they increase
			const delays: number[] = [];
			// Use a fixed Math.random for predictable results
			const origRandom = Math.random;
			Math.random = () => 0.5; // This makes jitter = 0

			try {
				for (let attempt = 0; attempt < 7; attempt++) {
					(socket as any)._reconnectAttempt = attempt;
					delays.push((socket as any)._getReconnectDelay());
				}

				// BACKOFF_SCHEDULE = [0, 1000, 2000, 4000, 8000, 16000, 30000]
				expect(delays[0]).toBe(0);
				expect(delays[1]).toBe(1000);
				expect(delays[2]).toBe(2000);
				expect(delays[3]).toBe(4000);
				expect(delays[4]).toBe(8000);
				expect(delays[5]).toBe(16000);
				expect(delays[6]).toBe(30000);
			} finally {
				Math.random = origRandom;
			}
		});

		it("should cap delay at max schedule value", () => {
			const origRandom = Math.random;
			Math.random = () => 0.5; // jitter = 0

			try {
				// Attempt beyond schedule length
				(socket as any)._reconnectAttempt = 100;
				const delay = (socket as any)._getReconnectDelay();
				expect(delay).toBe(30000);
			} finally {
				Math.random = origRandom;
			}
		});

		it("should add jitter to the delay", () => {
			const origRandom = Math.random;

			// With Math.random = 0, jitter = -500
			Math.random = () => 0;
			(socket as any)._reconnectAttempt = 1;
			const delayLow = (socket as any)._getReconnectDelay();

			// With Math.random = 1, jitter = +500
			Math.random = () => 1;
			(socket as any)._reconnectAttempt = 1;
			const delayHigh = (socket as any)._getReconnectDelay();

			// Base for attempt 1 is 1000
			// Low jitter: 1000 + (-500) = 500
			// High jitter: 1000 + 500 = 1500
			expect(delayLow).toBe(500);
			expect(delayHigh).toBe(1500);

			Math.random = origRandom;
		});

		it("should never return negative delay", () => {
			const origRandom = Math.random;
			Math.random = () => 0; // jitter = -500

			try {
				(socket as any)._reconnectAttempt = 0;
				const delay = (socket as any)._getReconnectDelay();
				// Base is 0, jitter is -500, Math.max(0, ...) ensures non-negative
				expect(delay).toBe(0);
			} finally {
				Math.random = origRandom;
			}
		});
	});

	describe("seq tracking on reconnect URL", () => {
		it("should track server sequence numbers from messages", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open, seq: 5 }));
				});

				socket.on(SocketEventType.Message, () => {
					expect((socket as any)._lastSeq).toBe(5);
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should start with _lastSeq = 0", () => {
			expect((socket as any)._lastSeq).toBe(0);
		});
	});

	describe("heartbeat scheduling", () => {
		it("should schedule heartbeat after connection opens", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// _wsPingTimer should be set
					expect((socket as any)._wsPingTimer).toBeDefined();
					resolve();
				});

				socket.start("test", "tok");
			}));

		it("should send heartbeat messages periodically", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				const heartbeatSocket = new Socket(false, "localhost", 8090, "/", "dendri", 100);

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				const heartbeats: any[] = [];

				mockServer.on("connection", (ws) => {
					//@ts-expect-error
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

	describe("_cleanup", () => {
		it("should clear reconnect timer on cleanup", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Manually set a reconnect timer
					(socket as any)._reconnectTimer = setTimeout(() => {}, 10000);

					socket.close();

					// After close, reconnect timer should be cleared
					expect((socket as any)._reconnectTimer).toBeUndefined();
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	describe("send during reconnect", () => {
		it("should queue messages sent before id is set", () => {
			// Start the socket but do not set _id
			(socket as any)._disconnected = false;

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
					// Close the underlying socket but keep _disconnected false
					const ws = (socket as any)._socket;
					if (ws) ws.close();
					(socket as any)._socket = undefined;
					(socket as any)._disconnected = false;

					socket.send({ type: ServerMessageType.Offer, dst: "peer" });

					// Should be queued since ws is not open
					expect((socket as any)._messagesQueue.length).toBe(1);
					resolve();
				});

				socket.start("test", "tok");
			}));
	});

	describe("reconnected event", () => {
		it("should emit Reconnected on successful reconnection", () =>
			new Promise<void>((resolve) => {
				vi.useRealTimers();

				// Set up initial connection
				mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

				mockServer.on("connection", (ws) => {
					ws.send(JSON.stringify({ type: ServerMessageType.Open }));
				});

				socket.on(SocketEventType.Message, () => {
					// Simulate that we were reconnecting by setting _reconnectAttempt > 0
					(socket as any)._reconnectAttempt = 1;

					// The next open event should emit Reconnected
					socket.on(SocketEventType.Reconnected, () => {
						resolve();
					});

					// Manually trigger onopen to simulate reconnection success
					const ws = (socket as any)._socket;
					if (ws && ws.onopen) {
						ws.onopen();
					}
				});

				socket.start("test", "tok");
			}));
	});
});
