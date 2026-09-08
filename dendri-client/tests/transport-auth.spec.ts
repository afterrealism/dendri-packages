import { PollingTransport } from "../src/polling-transport";
import { Socket } from "../src/socket";
import { SSETransport } from "../src/sse-transport";

/**
 * Auth parity across signaling transports: every transport must carry the
 * configured key, jwt, and api_key on every request it makes. Regression
 * guard for the polling transport silently dropping jwt/key (auth vanished
 * whenever the "auto" transport fell back to polling) and for the SSE
 * transport hardcoding key="dendri" and dropping auth on its send path.
 */

const captured: string[] = [];

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	url: string;
	readyState = 0;
	onopen: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}
	send(_data: string): void {}
	close(): void {}
}

function expectAuthParams(rawUrl: string): void {
	const params = new URL(rawUrl).searchParams;
	expect(params.get("key")).toBe("k1");
	expect(params.get("jwt")).toBe("jwt-1");
	expect(params.get("api_key")).toBe("ak-1");
}

describe("transport auth parity", () => {
	beforeEach(() => {
		captured.length = 0;
		FakeWebSocket.instances.length = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("polling: poll and send requests carry key, jwt, and api_key", async () => {
		// Hang every fetch — the URLs are all we need, and a resolving poll
		// response would spin the poll loop.
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				captured.push(String(url));
				return new Promise<Response>(() => {});
			}),
		);

		const transport = new PollingTransport(
			false,
			"localhost",
			9876,
			"/",
			"k1",
			5000,
			"jwt-1",
			"ak-1",
		);
		transport.start("peer-1", "tok-1");
		transport.send({ type: "HEARTBEAT" });

		await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(2));
		transport.close();

		const poll = captured.find((u) => u.includes("http/poll"));
		const send = captured.find((u) => u.includes("http/send"));
		expect(poll).toBeDefined();
		expect(send).toBeDefined();
		expectAuthParams(poll!);
		expectAuthParams(send!);
	});

	it("sse: connect and send requests carry key, jwt, and api_key", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				captured.push(String(url));
				if (String(url).includes("http/sse")) {
					// A stream that never yields keeps the SSE reader parked while
					// the transport reports connected and flushes queued sends.
					const stream = new ReadableStream({ start() {} });
					return Promise.resolve(new Response(stream, { status: 200 }));
				}
				return new Promise<Response>(() => {});
			}),
		);

		const transport = new SSETransport(false, "localhost", 9876, "/", "k1", 5000, "jwt-1", "ak-1");
		transport.start("peer-1", "tok-1");
		transport.send({ type: "HEARTBEAT" });

		await vi.waitFor(() => expect(captured.some((u) => u.includes("http/send"))).toBe(true));
		transport.close();

		const sse = captured.find((u) => u.includes("http/sse"));
		const send = captured.find((u) => u.includes("http/send"));
		expect(sse).toBeDefined();
		expect(send).toBeDefined();
		expectAuthParams(sse!);
		expectAuthParams(send!);
	});

	it("websocket: connection URL carries key, jwt, and api_key", () => {
		vi.stubGlobal("WebSocket", FakeWebSocket);

		const socket = new Socket(false, "localhost", 9876, "/", "k1", 5000, "jwt-1", "ak-1");
		socket.start("peer-1", "tok-1");

		const ws = FakeWebSocket.instances[0];
		expect(ws).toBeDefined();
		expectAuthParams(ws.url);
		socket.close();
	});

	it("transports omit jwt and api_key params when not configured", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				captured.push(String(url));
				return new Promise<Response>(() => {});
			}),
		);

		const transport = new PollingTransport(false, "localhost", 9876, "/", "k1");
		transport.start("peer-1", "tok-1");

		await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(1));
		transport.close();

		const params = new URL(captured[0]).searchParams;
		expect(params.get("key")).toBe("k1");
		expect(params.has("jwt")).toBe(false);
		expect(params.has("api_key")).toBe(false);
	});
});
