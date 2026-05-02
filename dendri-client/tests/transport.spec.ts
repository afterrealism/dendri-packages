import { Server } from "mock-socket";
import { ServerMessageType, SocketEventType } from "../src/enums";
import { PollingTransport } from "../src/polling-transport";
import { Socket } from "../src/socket";
import { SSETransport } from "../src/sse-transport";
import { SignalingTransport } from "../src/transport";

const WS_URL = "ws://localhost:8081/dendri?key=dendri";

describe("SignalingTransport", () => {
	describe("interface compliance", () => {
		it("Socket extends SignalingTransport", () => {
			const socket = new Socket(false, "localhost", 8081, "/", "dendri");
			expect(socket).toBeInstanceOf(SignalingTransport);
			socket.close();
		});

		it("SSETransport extends SignalingTransport", () => {
			const sse = new SSETransport(false, "localhost", 8081, "/", "dendri");
			expect(sse).toBeInstanceOf(SignalingTransport);
			sse.close();
		});

		it("PollingTransport extends SignalingTransport", () => {
			const poll = new PollingTransport(false, "localhost", 8081, "/", "dendri");
			expect(poll).toBeInstanceOf(SignalingTransport);
			poll.close();
		});

		it("all transports have required methods", () => {
			const transports: SignalingTransport[] = [
				new Socket(false, "localhost", 8081, "/", "dendri"),
				new SSETransport(false, "localhost", 8081, "/", "dendri"),
				new PollingTransport(false, "localhost", 8081, "/", "dendri"),
			];

			for (const t of transports) {
				expect(typeof t.start).toBe("function");
				expect(typeof t.send).toBe("function");
				expect(typeof t.close).toBe("function");
				expect(typeof t.reconnectAttempt).toBe("number");
				expect(typeof t.on).toBe("function");
				expect(typeof t.emit).toBe("function");
				t.close();
			}
		});
	});
});

describe("SSETransport", () => {
	describe("constructor", () => {
		it("constructs correct base URL with http", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/path/", "dendri");
			expect((sse as any)._baseUrl).toBe("http://localhost:9000/path/");
			sse.close();
		});

		it("constructs correct base URL with https", () => {
			const sse = new SSETransport(true, "signal.dendri.dev", 443, "/", "dendri");
			expect((sse as any)._baseUrl).toBe("https://signal.dendri.dev:443/");
			sse.close();
		});

		it("stores ping interval", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri", 3000);
			expect((sse as any)._pingInterval).toBe(3000);
			sse.close();
		});

		it("stores JWT when provided", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri", 5000, "my-jwt");
			expect((sse as any)._jwt).toBe("my-jwt");
			sse.close();
		});

		it("defaults ping interval to 5000ms", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			expect((sse as any)._pingInterval).toBe(5000);
			sse.close();
		});
	});

	describe("send", () => {
		it("queues messages when not connected", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			// Start to set id/token and mark non-disconnected, but connection will fail
			(sse as any)._disconnected = false;
			(sse as any)._id = "test-id";
			(sse as any)._token = "test-token";
			(sse as any)._connected = false;

			sse.send({ type: ServerMessageType.Offer, dst: "peer2" });

			expect((sse as any)._messagesQueue).toHaveLength(1);
			expect((sse as any)._messagesQueue[0]).toEqual({
				type: ServerMessageType.Offer,
				dst: "peer2",
			});
			sse.close();
		});

		it("queues messages when id is not set", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			(sse as any)._disconnected = false;

			sse.send({ type: ServerMessageType.Offer, dst: "peer2" });

			expect((sse as any)._messagesQueue).toHaveLength(1);
			sse.close();
		});

		it("drops messages when disconnected", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			// Default: _disconnected = true
			sse.send({ type: ServerMessageType.Offer, dst: "peer2" });

			expect((sse as any)._messagesQueue).toHaveLength(0);
		});

		it("emits error for messages without type", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			(sse as any)._disconnected = false;
			(sse as any)._id = "test-id";
			(sse as any)._token = "test-token";
			(sse as any)._connected = true;

			const errors: string[] = [];
			sse.on(SocketEventType.Error, (err) => errors.push(err));

			sse.send({ noType: true } as any);

			expect(errors).toEqual(["Invalid message"]);
			sse.close();
		});
	});

	describe("close", () => {
		it("sets disconnected state and disables auto-reconnect", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			(sse as any)._disconnected = false;
			(sse as any)._autoReconnect = true;

			sse.close();

			expect((sse as any)._disconnected).toBe(true);
			expect((sse as any)._autoReconnect).toBe(false);
			expect((sse as any)._connected).toBe(false);
		});

		it("is idempotent", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			sse.close();
			sse.close();
			// No error thrown
		});

		it("clears timers on close", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			(sse as any)._disconnected = false;
			(sse as any)._heartbeatTimer = setInterval(() => {}, 1000);
			(sse as any)._reconnectTimer = setTimeout(() => {}, 1000);

			sse.close();

			expect((sse as any)._heartbeatTimer).toBeUndefined();
			expect((sse as any)._reconnectTimer).toBeUndefined();
		});
	});

	describe("reconnectAttempt", () => {
		it("starts at 0", () => {
			const sse = new SSETransport(false, "localhost", 9000, "/", "dendri");
			expect(sse.reconnectAttempt).toBe(0);
			sse.close();
		});
	});
});

describe("PollingTransport", () => {
	describe("constructor", () => {
		it("constructs correct base URL with http", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/path/", "dendri");
			expect((poll as any)._baseUrl).toBe("http://localhost:9000/path/");
			poll.close();
		});

		it("constructs correct base URL with https", () => {
			const poll = new PollingTransport(true, "signal.dendri.dev", 443, "/", "dendri");
			expect((poll as any)._baseUrl).toBe("https://signal.dendri.dev:443/");
			poll.close();
		});

		it("stores ping interval", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri", 3000);
			expect((poll as any)._pingInterval).toBe(3000);
			poll.close();
		});

		it("defaults ping interval to 5000ms", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			expect((poll as any)._pingInterval).toBe(5000);
			poll.close();
		});
	});

	describe("send", () => {
		it("queues messages when not connected", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			(poll as any)._disconnected = false;

			poll.send({ type: ServerMessageType.Offer, dst: "peer2" });

			expect((poll as any)._messagesQueue).toHaveLength(1);
			expect((poll as any)._messagesQueue[0]).toEqual({
				type: ServerMessageType.Offer,
				dst: "peer2",
			});
			poll.close();
		});

		it("drops messages when disconnected", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			// Default: _disconnected = true
			poll.send({ type: ServerMessageType.Offer, dst: "peer2" });

			expect((poll as any)._messagesQueue).toHaveLength(0);
		});

		it("emits error for messages without type", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			(poll as any)._disconnected = false;
			(poll as any)._id = "test-id";
			(poll as any)._token = "test-token";
			(poll as any)._connected = true;

			const errors: string[] = [];
			poll.on(SocketEventType.Error, (err) => errors.push(err));

			poll.send({ noType: true } as any);

			expect(errors).toEqual(["Invalid message"]);
			poll.close();
		});
	});

	describe("close", () => {
		it("sets disconnected state and disables auto-reconnect", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			(poll as any)._disconnected = false;
			(poll as any)._autoReconnect = true;

			poll.close();

			expect((poll as any)._disconnected).toBe(true);
			expect((poll as any)._autoReconnect).toBe(false);
			expect((poll as any)._connected).toBe(false);
		});

		it("is idempotent", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			poll.close();
			poll.close();
			// No error thrown
		});

		it("stops polling on close", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			(poll as any)._polling = true;

			poll.close();

			expect((poll as any)._polling).toBe(false);
		});
	});

	describe("reconnectAttempt", () => {
		it("starts at 0", () => {
			const poll = new PollingTransport(false, "localhost", 9000, "/", "dendri");
			expect(poll.reconnectAttempt).toBe(0);
			poll.close();
		});
	});
});

describe("Transport option in Dendri", () => {
	// We test that the Dendri constructor selects the correct transport
	// by checking the internal _socket field type after construction.
	// We need to import Dendri for this.

	it("'websocket' (default) creates Socket", async () => {
		const { Dendri } = await import("../src/dendri");
		const peer = new Dendri({ host: "localhost", port: 8081, path: "/" });
		expect((peer as any)._socket).toBeInstanceOf(Socket);
		peer.destroy();
	});

	it("'sse' creates SSETransport", async () => {
		const { Dendri } = await import("../src/dendri");
		const peer = new Dendri({
			host: "localhost",
			port: 8081,
			path: "/",
			signalingTransport: "sse",
		});
		expect((peer as any)._socket).toBeInstanceOf(SSETransport);
		peer.destroy();
	});

	it("'polling' creates PollingTransport", async () => {
		const { Dendri } = await import("../src/dendri");
		const peer = new Dendri({
			host: "localhost",
			port: 8081,
			path: "/",
			signalingTransport: "polling",
		});
		expect((peer as any)._socket).toBeInstanceOf(PollingTransport);
		peer.destroy();
	});

	it("Socket still works through SignalingTransport interface via WebSocket", () => {
		return new Promise<void>((resolve) => {
			const mockServer = new Server(`${WS_URL}&id=test&token=tok&version=2.0.0`);

			const socket: SignalingTransport = new Socket(false, "localhost", 8081, "/", "dendri");

			mockServer.on("connection", (ws) => {
				ws.send(JSON.stringify({ type: ServerMessageType.Open }));
			});

			socket.on(SocketEventType.Message, (data: any) => {
				expect(data.type).toBe(ServerMessageType.Open);
				socket.close();
				mockServer.stop();
				resolve();
			});

			socket.start("test", "tok");
		});
	});
});
