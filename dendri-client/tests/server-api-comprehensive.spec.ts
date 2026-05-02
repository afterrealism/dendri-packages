import { afterEach, describe, expect, it, vi } from "vitest";
import { DendriServerAPI } from "../src/server-api";

describe("DendriServerAPI — comprehensive", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	// -----------------------------------------------------------------------
	// Error handling for network failures (fetch throws)
	// -----------------------------------------------------------------------

	describe("network failure handling", () => {
		it("getHealth rejects when fetch throws a network error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getHealth()).rejects.toThrow("Failed to fetch");
		});

		it("listPeers rejects when fetch throws a network error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network request failed"));

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.listPeers()).rejects.toThrow("Network request failed");
		});

		it("generatePeerId rejects when fetch throws a network error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("DNS resolution failed"));

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.generatePeerId()).rejects.toThrow("DNS resolution failed");
		});

		it("getTurnCredentials rejects when fetch throws", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getTurnCredentials()).rejects.toThrow("Connection refused");
		});

		it("getAnalytics rejects when fetch throws", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("Timeout"));

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getAnalytics()).rejects.toThrow("Timeout");
		});
	});

	// -----------------------------------------------------------------------
	// Error handling for non-JSON responses
	// -----------------------------------------------------------------------

	describe("non-JSON response handling", () => {
		it("getHealth rejects when json() throws", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.reject(new SyntaxError("Unexpected token")),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getHealth()).rejects.toThrow("Unexpected token");
		});

		it("listPeers rejects when json() throws", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.reject(new SyntaxError("Not valid JSON")),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.listPeers()).rejects.toThrow("Not valid JSON");
		});

		it("getTurnCredentials rejects when json() throws", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getTurnCredentials()).rejects.toThrow("Unexpected end of JSON input");
		});
	});

	// -----------------------------------------------------------------------
	// Error handling for 500 status codes
	// -----------------------------------------------------------------------

	describe("500 status code handling", () => {
		it("getHealth throws on 500", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getHealth()).rejects.toThrow("Health check failed: 500");
		});

		it("listPeers throws on 500", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.listPeers()).rejects.toThrow("List peers failed: 500");
		});

		it("generatePeerId throws on 500", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.generatePeerId()).rejects.toThrow("Generate ID failed: 500");
		});

		it("getTurnCredentials throws on 500", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getTurnCredentials()).rejects.toThrow("TURN credentials failed: 500");
		});

		it("getAnalytics throws on 500", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getAnalytics()).rejects.toThrow("Analytics failed: 500");
		});
	});

	// -----------------------------------------------------------------------
	// Custom key in URL construction
	// -----------------------------------------------------------------------

	describe("custom key in URL construction", () => {
		it("uses custom key for listPeers URL", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev", key: "myapp" });
			await api.listPeers();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/myapp/peers");
		});

		it("uses custom key for generatePeerId URL", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve("id-123"),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev", key: "myapp" });
			await api.generatePeerId();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/myapp/id");
		});

		it("uses custom key for listPeers with room parameter", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev", key: "game" });
			await api.listPeers("lobby");
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/game/peers?room=lobby");
		});

		it("uses default key 'dendri' when no key provided", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/dendri/peers");
		});
	});

	// -----------------------------------------------------------------------
	// listPeers with special characters in room name (URL encoding)
	// -----------------------------------------------------------------------

	describe("URL encoding of room names", () => {
		it("encodes spaces in room name", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("my room");
			expect(mockFetch).toHaveBeenCalledWith(
				"https://signal.dendri.dev/dendri/peers?room=my%20room",
			);
		});

		it("encodes special characters (&, =, ?) in room name", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("room&extra=true?yes");
			expect(mockFetch).toHaveBeenCalledWith(
				"https://signal.dendri.dev/dendri/peers?room=room%26extra%3Dtrue%3Fyes",
			);
		});

		it("encodes unicode characters in room name", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("room-cafe\u0301");
			const calledUrl = mockFetch.mock.calls[0][0] as string;
			expect(calledUrl).toContain("?room=");
			expect(calledUrl).toBe(
				`https://signal.dendri.dev/dendri/peers?room=${encodeURIComponent("room-cafe\u0301")}`,
			);
		});

		it("encodes forward slashes in room name", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("path/to/room");
			expect(mockFetch).toHaveBeenCalledWith(
				"https://signal.dendri.dev/dendri/peers?room=path%2Fto%2Froom",
			);
		});

		it("encodes hash (#) in room name", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("room#123");
			expect(mockFetch).toHaveBeenCalledWith(
				"https://signal.dendri.dev/dendri/peers?room=room%23123",
			);
		});
	});

	// -----------------------------------------------------------------------
	// Concurrent API calls (all should work independently)
	// -----------------------------------------------------------------------

	describe("concurrent API calls", () => {
		it("handles multiple concurrent calls independently", async () => {
			let callIndex = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								status: "ok",
								clients: 5,
								rooms: 2,
								uptime_ms: 1000,
								relay_enabled: true,
							}),
					});
				}
				if (callIndex === 2) {
					return Promise.resolve({
						ok: true,
						json: () => Promise.resolve(["peer-a", "peer-b"]),
					});
				}
				return Promise.resolve({
					ok: true,
					text: () => Promise.resolve("new-peer-id"),
				});
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });

			const [health, peers, peerId] = await Promise.all([
				api.getHealth(),
				api.listPeers(),
				api.generatePeerId(),
			]);

			expect(health.status).toBe("ok");
			expect(health.clients).toBe(5);
			expect(peers).toEqual(["peer-a", "peer-b"]);
			expect(peerId).toBe("new-peer-id");
			expect(mockFetch).toHaveBeenCalledTimes(3);
		});

		it("handles mixed success and failure in concurrent calls", async () => {
			let callIndex = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				callIndex++;
				if (callIndex === 1) {
					return Promise.resolve({
						ok: true,
						json: () =>
							Promise.resolve({
								status: "ok",
								clients: 0,
								rooms: 0,
								uptime_ms: 50,
								relay_enabled: false,
							}),
					});
				}
				// Second call fails with 500
				return Promise.resolve({
					ok: false,
					status: 500,
				});
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });

			const results = await Promise.allSettled([api.getHealth(), api.listPeers()]);

			expect(results[0].status).toBe("fulfilled");
			expect((results[0] as PromiseFulfilledResult<any>).value.status).toBe("ok");

			expect(results[1].status).toBe("rejected");
			expect((results[1] as PromiseRejectedResult).reason.message).toContain("500");
		});
	});

	// -----------------------------------------------------------------------
	// getTurnCredentials response parsing (iceServers array)
	// -----------------------------------------------------------------------

	describe("getTurnCredentials response parsing", () => {
		it("parses iceServers array with multiple entries", async () => {
			const turnData = {
				iceServers: [
					{ urls: "turn:turn1.example.com:3478", username: "user1", credential: "pass1" },
					{ urls: "turn:turn2.example.com:3478", username: "user2", credential: "pass2" },
					{ urls: "stun:stun.example.com:3478" },
				],
			};
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(turnData),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const creds = await api.getTurnCredentials();

			expect(creds.iceServers).toHaveLength(3);
			expect(creds.iceServers[0].urls).toBe("turn:turn1.example.com:3478");
			expect((creds.iceServers[0] as any).username).toBe("user1");
			expect((creds.iceServers[0] as any).credential).toBe("pass1");
			expect(creds.iceServers[2].urls).toBe("stun:stun.example.com:3478");
		});

		it("parses empty iceServers array", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ iceServers: [] }),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const creds = await api.getTurnCredentials();

			expect(creds.iceServers).toEqual([]);
		});

		it("parses iceServers with urls as string array", async () => {
			const turnData = {
				iceServers: [
					{
						urls: ["turn:turn1.example.com:3478", "turn:turn1.example.com:5349"],
						username: "user1",
						credential: "pass1",
					},
				],
			};
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(turnData),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const creds = await api.getTurnCredentials();

			expect(creds.iceServers).toHaveLength(1);
			expect(creds.iceServers[0].urls).toEqual([
				"turn:turn1.example.com:3478",
				"turn:turn1.example.com:5349",
			]);
		});
	});

	// -----------------------------------------------------------------------
	// getHealth response type validation
	// -----------------------------------------------------------------------

	describe("getHealth response type validation", () => {
		it("returns all expected fields in health response", async () => {
			const healthData = {
				status: "ok",
				clients: 10,
				rooms: 3,
				uptime_ms: 86400000,
				relay_enabled: false,
			};
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(healthData),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const health = await api.getHealth();

			expect(typeof health.status).toBe("string");
			expect(typeof health.clients).toBe("number");
			expect(typeof health.rooms).toBe("number");
			expect(typeof health.uptime_ms).toBe("number");
			expect(typeof health.relay_enabled).toBe("boolean");

			expect(health.status).toBe("ok");
			expect(health.clients).toBe(10);
			expect(health.rooms).toBe(3);
			expect(health.uptime_ms).toBe(86400000);
			expect(health.relay_enabled).toBe(false);
		});

		it("returns health response with zero values", async () => {
			const healthData = {
				status: "starting",
				clients: 0,
				rooms: 0,
				uptime_ms: 0,
				relay_enabled: false,
			};
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(healthData),
			});

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const health = await api.getHealth();

			expect(health.status).toBe("starting");
			expect(health.clients).toBe(0);
			expect(health.rooms).toBe(0);
			expect(health.uptime_ms).toBe(0);
		});

		it("handles various HTTP error status codes consistently", async () => {
			const statusCodes = [400, 401, 403, 404, 429, 502, 503, 504];

			for (const status of statusCodes) {
				globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status });

				const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
				await expect(api.getHealth()).rejects.toThrow(`Health check failed: ${status}`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// URL construction edge cases
	// -----------------------------------------------------------------------

	describe("URL construction edge cases", () => {
		it("handles URL without trailing slash", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						status: "ok",
						clients: 0,
						rooms: 0,
						uptime_ms: 0,
						relay_enabled: true,
					}),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.getHealth();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/health");
		});

		it("handles URL with trailing slash", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						status: "ok",
						clients: 0,
						rooms: 0,
						uptime_ms: 0,
						relay_enabled: true,
					}),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev/" });
			await api.getHealth();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/health");
		});

		it("handles URL with port number", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "http://localhost:9000" });
			await api.listPeers();
			expect(mockFetch).toHaveBeenCalledWith("http://localhost:9000/dendri/peers");
		});

		it("handles URL with path prefix", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve("peer-xyz"),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://example.com/api/v1" });
			await api.generatePeerId();
			expect(mockFetch).toHaveBeenCalledWith("https://example.com/api/v1/dendri/id");
		});
	});
});
