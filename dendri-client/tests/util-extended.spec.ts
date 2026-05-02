import { util } from "../src/util";
import { randomToken } from "../src/utils/randomToken";
import { validateId } from "../src/utils/validateId";

describe("util", () => {
	describe("#chunkedMTU", () => {
		it("should be 16300", () => {
			expect(util.chunkedMTU).toBe(16300);
		});
	});

	describe("#CLOUD_HOST", () => {
		it("should be signal.dendri.dev", () => {
			expect(util.CLOUD_HOST).toBe("signal.dendri.dev");
		});
	});

	describe("#CLOUD_PORT", () => {
		it("should be 443", () => {
			expect(util.CLOUD_PORT).toBe(443);
		});
	});

	describe("#defaultConfig", () => {
		it("should contain ICE servers", () => {
			expect(util.defaultConfig.iceServers).toBeDefined();
			expect(util.defaultConfig.iceServers.length).toBeGreaterThan(0);
		});

		it("should include STUN server", () => {
			const hasStun = util.defaultConfig.iceServers.some(
				(server: any) => typeof server.urls === "string" && server.urls.startsWith("stun:"),
			);
			expect(hasStun).toBe(true);
		});

		it("should not include hardcoded TURN credentials", () => {
			const turnServer = util.defaultConfig.iceServers.find((server: any) => server.username);
			expect(turnServer).toBeUndefined();
		});

		it("should not include deprecated sdpSemantics", () => {
			expect((util.defaultConfig as any).sdpSemantics).toBeUndefined();
		});
	});

	describe("#supports", () => {
		it("should have browser support flags", () => {
			expect(typeof util.supports.browser).toBe("boolean");
			expect(typeof util.supports.webRTC).toBe("boolean");
			expect(typeof util.supports.data).toBe("boolean");
		});

		it("should detect audioVideo support", () => {
			// Set by setup.ts
			expect(util.supports.audioVideo).toBe(true);
		});
	});

	describe("#binaryStringToArrayBuffer", () => {
		it("should convert binary string to ArrayBuffer", () => {
			const result = util.binaryStringToArrayBuffer("ABC");

			expect(result.byteLength).toBe(3);
			const view = new Uint8Array(result);
			expect(view[0]).toBe(65); // 'A'
			expect(view[1]).toBe(66); // 'B'
			expect(view[2]).toBe(67); // 'C'
		});

		it("should handle empty string", () => {
			const result = util.binaryStringToArrayBuffer("");
			expect(result.byteLength).toBe(0);
		});

		it("should mask to 8 bits", () => {
			const result = util.binaryStringToArrayBuffer(String.fromCharCode(256));
			const view = new Uint8Array(result);
			expect(view[0]).toBe(0); // 256 & 0xff = 0
		});
	});

	describe("#isSecure", () => {
		it("should return a boolean", () => {
			expect(typeof util.isSecure()).toBe("boolean");
		});
	});

	describe("#noop", () => {
		it("should be a function that does nothing", () => {
			expect(() => util.noop()).not.toThrow();
		});
	});
});

describe("validateId", () => {
	it("should accept alphanumeric IDs", () => {
		expect(validateId("abc123")).toBe(true);
	});

	it("should accept IDs with dashes", () => {
		expect(validateId("my-peer-id")).toBe(true);
	});

	it("should accept IDs with underscores", () => {
		expect(validateId("my_peer_id")).toBe(true);
	});

	it("should allow empty string (server generates ID)", () => {
		expect(validateId("")).toBe(true);
	});

	it("should accept single character IDs", () => {
		expect(validateId("a")).toBe(true);
	});
});

describe("randomToken", () => {
	// Restore original randomToken for these tests
	let originalRandomToken: typeof util.randomToken;

	beforeAll(() => {
		originalRandomToken = util.randomToken;
		util.randomToken = randomToken;
	});

	afterAll(() => {
		util.randomToken = originalRandomToken;
	});

	it("should return a string", () => {
		expect(typeof randomToken()).toBe("string");
	});

	it("should return non-empty string", () => {
		expect(randomToken().length).toBeGreaterThan(0);
	});

	it("should generate different tokens on each call", () => {
		const tokens = new Set<string>();
		for (let i = 0; i < 100; i++) {
			tokens.add(randomToken());
		}
		// Should be highly unique (allowing small chance of collision)
		expect(tokens.size).toBeGreaterThan(90);
	});
});
