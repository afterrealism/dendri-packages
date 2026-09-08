import { Dendri, parseServerUrl } from "../src/dendri";

/**
 * The `url` option is shorthand for host/port/secure/path so hosted-service
 * users can paste a single URL instead of four fields.
 */

describe("parseServerUrl", () => {
	it("parses a bare wss URL with defaults", () => {
		expect(parseServerUrl("wss://signal.example.com")).toEqual({
			host: "signal.example.com",
			port: 443,
			secure: true,
			path: "/",
		});
	});

	it("parses explicit port, path, and insecure schemes", () => {
		expect(parseServerUrl("http://127.0.0.1:9876/api")).toEqual({
			host: "127.0.0.1",
			port: 9876,
			secure: false,
			path: "/api",
		});
		expect(parseServerUrl("ws://localhost:9876")).toEqual({
			host: "localhost",
			port: 9876,
			secure: false,
			path: "/",
		});
		expect(parseServerUrl("https://signal.example.com")).toEqual({
			host: "signal.example.com",
			port: 443,
			secure: true,
			path: "/",
		});
	});

	it("defaults insecure schemes to port 80", () => {
		expect(parseServerUrl("ws://signal.example.com").port).toBe(80);
	});

	it("rejects garbage and unsupported protocols with clear errors", () => {
		expect(() => parseServerUrl("not a url")).toThrow(/Invalid Dendri "url" option/);
		expect(() => parseServerUrl("ftp://signal.example.com")).toThrow(
			/Invalid Dendri "url" protocol/,
		);
	});
});

describe("Dendri url option", () => {
	it("expands url into host/port/secure/path", () => {
		const peer = new Dendri("test-peer", { url: "wss://signal.example.com/api" });
		peer.on("error", () => {}); // jsdom has no WebRTC; swallow the delayed abort

		expect(peer.options.host).toBe("signal.example.com");
		expect(peer.options.port).toBe(443);
		expect(peer.options.secure).toBe(true);
		// Existing path normalization appends the trailing slash.
		expect(peer.options.path).toBe("/api/");
		peer.destroy();
	});

	it("lets explicit fields win over url-derived ones", () => {
		const peer = new Dendri("test-peer", {
			url: "wss://signal.example.com",
			port: 9999,
		});
		peer.on("error", () => {});

		expect(peer.options.host).toBe("signal.example.com");
		expect(peer.options.port).toBe(9999);
		expect(peer.options.secure).toBe(true);
		peer.destroy();
	});

	it("works as options-only constructor arg", () => {
		const peer = new Dendri({ url: "http://127.0.0.1:9876" });
		peer.on("error", () => {});

		expect(peer.options.host).toBe("127.0.0.1");
		expect(peer.options.port).toBe(9876);
		expect(peer.options.secure).toBe(false);
		peer.destroy();
	});

	it("throws the standard host error when neither url nor host is given", () => {
		expect(() => new Dendri({})).toThrow(/requires a signaling server host/);
	});
});
