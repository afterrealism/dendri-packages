import type { MockedFunction } from "vitest";
import { API } from "../src/api";

// Mock fetch globally
const mockFetch = vi.fn() as MockedFunction<typeof fetch>;
(global as any).fetch = mockFetch;

describe("API", () => {
	let api: API;

	beforeEach(() => {
		api = new API({
			host: "localhost",
			port: 9000,
			path: "/",
			key: "dendri",
			secure: false,
		});
		mockFetch.mockReset();
	});

	describe("retrieveId", () => {
		it("should return a peer ID from the server", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 200,
				text: () => Promise.resolve("generated-id-123"),
			} as Response);

			const id = await api.retrieveId();

			expect(id).toBe("generated-id-123");
			expect(mockFetch).toHaveBeenCalledTimes(1);

			const calledUrl = mockFetch.mock.calls[0][0] as string;
			expect(calledUrl).toContain("http://localhost:9000/dendri/id");
		});

		it("should throw on non-200 response", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 500,
			} as Response);

			await expect(api.retrieveId()).rejects.toThrow("Could not get an ID from the server");
		});

		it("should throw on network error", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Network failure"));

			await expect(api.retrieveId()).rejects.toThrow("Could not get an ID from the server");
		});

		it("should include path hint when using default path on self-hosted", async () => {
			const apiWithDefaultPath = new API({
				host: "myserver.com",
				port: 9000,
				path: "/",
				key: "dendri",
				secure: false,
			});

			mockFetch.mockRejectedValueOnce(new Error("fail"));

			await expect(apiWithDefaultPath.retrieveId()).rejects.toThrow("path");
		});

		it("should use HTTPS when secure is true", async () => {
			const secureApi = new API({
				host: "localhost",
				port: 443,
				path: "/",
				key: "dendri",
				secure: true,
			});

			mockFetch.mockResolvedValueOnce({
				status: 200,
				text: () => Promise.resolve("id"),
			} as Response);

			await secureApi.retrieveId();

			const calledUrl = mockFetch.mock.calls[0][0] as string;
			expect(calledUrl).toContain("https://");
		});

		it("should pass referrerPolicy option", async () => {
			const apiWithReferrer = new API({
				host: "localhost",
				port: 9000,
				path: "/",
				key: "dendri",
				secure: false,
				referrerPolicy: "no-referrer",
			});

			mockFetch.mockResolvedValueOnce({
				status: 200,
				text: () => Promise.resolve("id"),
			} as Response);

			await apiWithReferrer.retrieveId();

			const options = mockFetch.mock.calls[0][1] as RequestInit;
			expect(options.referrerPolicy).toBe("no-referrer");
		});
	});

	describe("listAllPeers", () => {
		it("should return list of peer IDs", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 200,
				json: () => Promise.resolve(["peer1", "peer2", "peer3"]),
			} as Response);

			const peers = await api.listAllPeers();

			expect(peers).toEqual(["peer1", "peer2", "peer3"]);
		});

		it("should throw with helpful message on 401", async () => {
			const selfHostedApi = new API({
				host: "myserver.com",
				port: 9000,
				path: "/",
				key: "dendri",
				secure: false,
			});

			mockFetch.mockResolvedValueOnce({
				status: 401,
			} as Response);

			await expect(selfHostedApi.listAllPeers()).rejects.toThrow("allow_discovery");
		});

		it("should throw with helpful hint on 401 for cloud host", async () => {
			const cloudApi = new API({
				host: "signal.dendri.dev",
				port: 443,
				path: "/",
				key: "dendri",
				secure: true,
			});

			mockFetch.mockResolvedValueOnce({
				status: 401,
			} as Response);

			await expect(cloudApi.listAllPeers()).rejects.toThrow("allow_discovery");
		});

		it("should throw on non-200/401 response", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 500,
			} as Response);

			await expect(api.listAllPeers()).rejects.toThrow("Could not get list peers");
		});

		it("should format error message correctly with Error objects", async () => {
			mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

			await expect(api.listAllPeers()).rejects.toThrow("Connection refused");
		});
	});

	describe("fetch timeout", () => {
		it("should pass AbortSignal to fetch requests", async () => {
			mockFetch.mockResolvedValueOnce({
				status: 200,
				text: () => Promise.resolve("id"),
			} as Response);

			await api.retrieveId();

			const fetchOptions = mockFetch.mock.calls[0][1] as RequestInit;
			expect(fetchOptions.signal).toBeDefined();
			expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
		});

		it("should handle abort errors in retrieveId", async () => {
			const abortError = new DOMException("The operation was aborted", "AbortError");
			mockFetch.mockRejectedValueOnce(abortError);

			await expect(api.retrieveId()).rejects.toThrow("Could not get an ID from the server");
		});

		it("should handle abort errors in listAllPeers", async () => {
			const abortError = new DOMException("The operation was aborted", "AbortError");
			mockFetch.mockRejectedValueOnce(abortError);

			await expect(api.listAllPeers()).rejects.toThrow("Could not get list peers");
		});
	});
});
