import { DendriServerAPI } from "../src/server-api";

describe("DendriServerAPI", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("construction", () => {
		it("constructs with URL and default key", () => {
			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			expect(api).toBeDefined();
		});

		it("strips trailing slash from URL", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () =>
					Promise.resolve({
						status: "ok",
						clients: 0,
						rooms: 0,
						uptime_ms: 100,
						relay_enabled: true,
					}),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev/" });
			await api.getHealth();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/health");
		});

		it("uses custom key when provided", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({
				url: "https://signal.dendri.dev",
				key: "myapp",
			});
			await api.listPeers();
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/myapp/peers");
		});
	});

	describe("getHealth", () => {
		it("calls /health endpoint", async () => {
			const healthData = {
				status: "ok",
				clients: 0,
				rooms: 0,
				uptime_ms: 100,
				relay_enabled: true,
			};
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(healthData),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const health = await api.getHealth();
			expect(health.status).toBe("ok");
			expect(health.clients).toBe(0);
			expect(health.rooms).toBe(0);
			expect(health.uptime_ms).toBe(100);
			expect(health.relay_enabled).toBe(true);
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/health");
		});

		it("throws on non-ok response", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getHealth()).rejects.toThrow("Health check failed: 500");
		});
	});

	describe("listPeers", () => {
		it("calls /key/peers endpoint", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(["peer1", "peer2"]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const peers = await api.listPeers();
			expect(peers).toEqual(["peer1", "peer2"]);
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/dendri/peers");
		});

		it("includes room parameter when provided", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(["peer1"]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("my-room");
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/dendri/peers?room=my-room");
		});

		it("encodes room parameter", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve([]),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await api.listPeers("room with spaces");
			expect(mockFetch).toHaveBeenCalledWith(
				"https://signal.dendri.dev/dendri/peers?room=room%20with%20spaces",
			);
		});

		it("throws on non-ok response", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 403,
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.listPeers()).rejects.toThrow("List peers failed: 403");
		});
	});

	describe("generatePeerId", () => {
		it("calls /key/id endpoint", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve("abc123"),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const id = await api.generatePeerId();
			expect(id).toBe("abc123");
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/dendri/id");
		});

		it("throws on non-ok response", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.generatePeerId()).rejects.toThrow("Generate ID failed: 500");
		});
	});

	describe("getTurnCredentials", () => {
		it("calls /turn endpoint", async () => {
			const turnData = {
				iceServers: [{ urls: "turn:example.com", username: "u", credential: "p" }],
			};
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(turnData),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const creds = await api.getTurnCredentials();
			expect(creds.iceServers).toHaveLength(1);
			expect(creds.iceServers[0].urls).toBe("turn:example.com");
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/turn");
		});

		it("throws on non-ok response", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getTurnCredentials()).rejects.toThrow("TURN credentials failed: 401");
		});
	});

	describe("getAnalytics", () => {
		it("calls /analytics endpoint", async () => {
			const analyticsData = {
				dataset: "dendri",
				events_tracked: ["connect", "disconnect"],
			};
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve(analyticsData),
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			const analytics = await api.getAnalytics();
			expect(analytics.dataset).toBe("dendri");
			expect(analytics.events_tracked).toEqual(["connect", "disconnect"]);
			expect(mockFetch).toHaveBeenCalledWith("https://signal.dendri.dev/analytics");
		});

		it("throws on non-ok response", async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
			});
			globalThis.fetch = mockFetch;

			const api = new DendriServerAPI({ url: "https://signal.dendri.dev" });
			await expect(api.getAnalytics()).rejects.toThrow("Analytics failed: 404");
		});
	});
});
