import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Negotiator } from "../src/negotiator";
import { Util } from "../src/util";

// -- _preferH264InSdp tests (pure SDP string manipulation) --

/**
 * Create a minimal Negotiator instance with just enough wiring
 * to call the SDP helper.
 */
function createNegotiator(): InstanceType<typeof Negotiator> {
	const fakeConnection = {
		type: "media",
		peer: "test",
		connectionId: "test-conn",
		provider: null,
		peerConnection: null,
		options: {},
		label: "test",
	} as any;

	return new Negotiator(fakeConnection);
}

describe("_preferH264InSdp", () => {
	let negotiator: InstanceType<typeof Negotiator>;

	beforeEach(() => {
		negotiator = createNegotiator();
	});

	it("should reorder H.264 payloads to the front of the m=video line", () => {
		const sdp = [
			"v=0",
			"m=video 9 UDP/TLS/RTP/SAVPF 96 97 98",
			"a=rtpmap:96 VP8/90000",
			"a=rtpmap:97 VP9/90000",
			"a=rtpmap:98 H264/90000",
		].join("\r\n");

		const result = negotiator._preferH264InSdp(sdp);
		const videoLine = result.split("\r\n").find((l) => l.startsWith("m=video"));

		expect(videoLine).toBeDefined();
		// H.264 payload 98 should now be first
		expect(videoLine).toBe("m=video 9 UDP/TLS/RTP/SAVPF 98 96 97");
	});

	it("should preserve SDP unchanged when no H.264 codecs are present", () => {
		const sdp = [
			"v=0",
			"m=video 9 UDP/TLS/RTP/SAVPF 96 97",
			"a=rtpmap:96 VP8/90000",
			"a=rtpmap:97 VP9/90000",
		].join("\r\n");

		const result = negotiator._preferH264InSdp(sdp);

		expect(result).toBe(sdp);
	});

	it("should handle SDP with multiple H.264 payload types", () => {
		const sdp = [
			"v=0",
			"m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99",
			"a=rtpmap:96 VP8/90000",
			"a=rtpmap:97 VP9/90000",
			"a=rtpmap:98 H264/90000",
			"a=rtpmap:99 H264/90000",
		].join("\r\n");

		const result = negotiator._preferH264InSdp(sdp);
		const videoLine = result.split("\r\n").find((l) => l.startsWith("m=video"));

		expect(videoLine).toBeDefined();
		// Both H.264 payloads (98, 99) should be at the front
		expect(videoLine).toBe("m=video 9 UDP/TLS/RTP/SAVPF 98 99 96 97");
	});

	it("should not modify audio lines", () => {
		const sdp = [
			"v=0",
			"m=audio 9 UDP/TLS/RTP/SAVPF 111 112",
			"a=rtpmap:111 opus/48000/2",
			"m=video 9 UDP/TLS/RTP/SAVPF 96 98",
			"a=rtpmap:96 VP8/90000",
			"a=rtpmap:98 H264/90000",
		].join("\r\n");

		const result = negotiator._preferH264InSdp(sdp);
		const lines = result.split("\r\n");
		const audioLine = lines.find((l) => l.startsWith("m=audio"));
		const videoLine = lines.find((l) => l.startsWith("m=video"));

		expect(audioLine).toBe("m=audio 9 UDP/TLS/RTP/SAVPF 111 112");
		expect(videoLine).toBe("m=video 9 UDP/TLS/RTP/SAVPF 98 96");
	});

	it("should not duplicate H.264 payloads that are already first", () => {
		const sdp = [
			"v=0",
			"m=video 9 UDP/TLS/RTP/SAVPF 98 96 97",
			"a=rtpmap:96 VP8/90000",
			"a=rtpmap:97 VP9/90000",
			"a=rtpmap:98 H264/90000",
		].join("\r\n");

		const result = negotiator._preferH264InSdp(sdp);
		const videoLine = result.split("\r\n").find((l) => l.startsWith("m=video"));

		expect(videoLine).toBe("m=video 9 UDP/TLS/RTP/SAVPF 98 96 97");
	});
});

// -- Safari / iOS detection --

describe("Safari detection", () => {
	const originalNavigator = globalThis.navigator;

	afterEach(() => {
		Object.defineProperty(globalThis, "navigator", {
			value: originalNavigator,
			writable: true,
			configurable: true,
		});
	});

	function setUserAgent(ua: string, platform = "MacIntel", maxTouchPoints = 0) {
		Object.defineProperty(globalThis, "navigator", {
			value: {
				userAgent: ua,
				platform,
				maxTouchPoints,
			},
			writable: true,
			configurable: true,
		});
	}

	it("isSafari returns true for Safari on macOS", () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
		);
		const u = new Util();
		expect(u.isSafari).toBe(true);
	});

	it("isSafari returns false for Chrome on macOS", () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
		);
		const u = new Util();
		expect(u.isSafari).toBe(false);
	});

	it("isSafari returns false for Firefox", () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
		);
		const u = new Util();
		expect(u.isSafari).toBe(false);
	});

	it("isIOS returns true for iPhone", () => {
		setUserAgent(
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			"iPhone",
			0,
		);
		const u = new Util();
		expect(u.isIOS).toBe(true);
	});

	it("isIOS returns true for iPad with maxTouchPoints (iPadOS 13+)", () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15",
			"MacIntel",
			5,
		);
		const u = new Util();
		expect(u.isIOS).toBe(true);
	});

	it("isIOS returns false for desktop macOS", () => {
		setUserAgent(
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
			"MacIntel",
			0,
		);
		const u = new Util();
		expect(u.isIOS).toBe(false);
	});

	it("isIOS returns false for Android", () => {
		setUserAgent(
			"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
			"Linux armv8l",
			5,
		);
		const u = new Util();
		expect(u.isIOS).toBe(false);
	});
});
