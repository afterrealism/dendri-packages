import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { DendriErrorType, ServerMessageType } from "../src/enums";
import { util } from "../src/util";

const createMockServer = (id = "1"): Server => {
	const fakeURL = `ws://localhost:8086/dendri?key=dendri&id=${id}&token=testToken`;
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("Dendri lifecycle", () => {
	let mockServer: Server;

	afterEach(() => {
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined;
		}
	});

	describe("construction", () => {
		it("should create peer with explicit server options", () => {
			const peer = new Dendri({ host: "localhost", port: 8086 });
			expect(peer.open).toBe(false);
			expect(peer.destroyed).toBe(false);
			expect(peer.disconnected).toBe(false);
			expect(peer.id).toBeNull();
			peer.destroy();
		});

		it("should create peer with string ID", () => {
			const peer = new Dendri("my-id", { port: 8086, host: "localhost" });
			expect(peer.id).toBe("my-id");
			peer.destroy();
		});

		it("should create peer with options only", () => {
			const peer = new Dendri({ port: 8086, host: "localhost" });
			expect(peer.id).toBeNull();
			peer.destroy();
		});

		it("should normalize path with leading and trailing slashes", () => {
			const peer = new Dendri("1", {
				port: 8086,
				host: "localhost",
				path: "mypath",
			});
			expect(peer.options.path).toBe("/mypath/");
			peer.destroy();
		});

		it("should handle relative host '/'", () => {
			const peer = new Dendri("1", { host: "/", port: 8086 });
			// Should resolve to window.location.hostname or 'localhost'
			expect(peer.options.host).not.toBe("/");
			peer.destroy();
		});

		it("should set secure=true for cloud host", () => {
			const peer = new Dendri("1", { host: "signal.dendri.dev" });
			expect(peer.options.secure).toBe(true);
			peer.destroy();
		});

		it("should accept custom log function", () => {
			const logFn = vi.fn();
			const peer = new Dendri("1", {
				port: 8086,
				host: "localhost",
				logFunction: logFn,
			});
			peer.destroy();
		});
	});

	describe("open event", () => {
		it("should emit open event with peer ID", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", (id) => {
					expect(id).toBe("1");
					expect(peer.open).toBe(true);
					expect(peer.disconnected).toBe(false);
					peer.destroy();
					resolve();
				});
			}));
	});

	describe("disconnect()", () => {
		it("should disconnect from server but keep P2P state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", (id) => {
						expect(id).toBe("1");
						expect(peer.disconnected).toBe(true);
						expect(peer.destroyed).toBe(false);
						expect(peer.open).toBe(false);
						expect(peer.id).toBeNull();
						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));

		it("should be idempotent", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.disconnect();
					peer.disconnect(); // Should not throw
					peer.destroy();
					resolve();
				});
			}));
	});

	describe("destroy()", () => {
		it("should emit close event", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.once("close", () => {
						expect(peer.destroyed).toBe(true);
						expect(peer.disconnected).toBe(true);
						expect(peer.open).toBe(false);
						resolve();
					});

					peer.destroy();
				});
			}));

		it("should be idempotent", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();
					peer.destroy(); // Should not throw
					resolve();
				});
			}));

		it("should clean up all connections", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.connect("2");
					peer.connect("3");

					expect(Object.keys(peer.connections).length).toBe(2);

					peer.destroy();

					expect(peer.connections).toEqual({});
					resolve();
				});
			}));
	});

	describe("reconnect()", () => {
		it("should reconnect a disconnected peer", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						peer.once("open", (id) => {
							expect(id).toBe("1");
							expect(peer.open).toBe(true);
							peer.destroy();
							resolve();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));

		it("should throw when trying to reconnect a destroyed peer", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();

					expect(() => peer.reconnect()).toThrow("already been destroyed");
					resolve();
				});
			}));

		it("should throw when already connected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					expect(() => peer.reconnect()).toThrow("not disconnected");
					peer.destroy();
					resolve();
				});
			}));
	});

	describe("error handling", () => {
		it("should destroy peer on server error when no lastServerId", () =>
			new Promise<void>((resolve) => {
				const peer = new Dendri({ port: 8086, host: "localhost" });

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.ServerError);

					peer.once("close", () => {
						expect(peer.destroyed).toBe(true);
						resolve();
					});
				});

				// Simulate: server never responds, API fails
			}));

		it("should emit error for invalid peer ID", () =>
			new Promise<void>((resolve) => {
				const peer = new Dendri("invalid id with spaces!@#", {
					port: 8086,
					host: "localhost",
				});

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.InvalidID);
					peer.destroy();
					resolve();
				});
			}));
	});

	describe("listAllPeers", () => {
		it("should call callback with peer list", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				// Mock the API response
				//@ts-expect-error
				peer._api.listAllPeers = () => Promise.resolve(["peer1", "peer2"]);

				peer.once("open", () => {
					peer.listAllPeers((peers) => {
						expect(peers).toEqual(["peer1", "peer2"]);
						peer.destroy();
						resolve();
					});
				});
			}));
	});

	describe("connections property", () => {
		it("should return a plain object copy of connections", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.connect("2");

					const connections = peer.connections;
					expect(typeof connections).toBe("object");
					expect(connections["2"]).toBeDefined();
					expect(Array.isArray(connections["2"])).toBe(true);

					peer.destroy();
					resolve();
				});
			}));
	});

	describe("connections immutability", () => {
		it("should return cloned arrays from connections getter", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.connect("2");

					const connections1 = peer.connections as any;
					const arr = connections1["2"];
					expect(arr).toBeDefined();
					expect(arr.length).toBe(1);

					// Mutate the returned array
					arr.push("fake-entry");

					// The internal state should NOT be affected
					const connections2 = peer.connections as any;
					expect(connections2["2"].length).toBe(1);

					peer.destroy();
					resolve();
				});
			}));
	});

	describe("peer param validation", () => {
		it("should emit error when connect() is called with empty string", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.once("error", (err) => {
						expect(err.type).toBe(DendriErrorType.InvalidID);
						peer.destroy();
						resolve();
					});

					const conn = peer.connect("");
					expect(conn).toBeUndefined();
				});
			}));

		it("should emit error when call() is called with empty string", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				peer.once("open", () => {
					peer.once("error", (err) => {
						expect(err.type).toBe(DendriErrorType.InvalidID);
						peer.destroy();
						resolve();
					});

					const stream = new MediaStream([new MediaStreamTrack()]);
					const conn = peer.call("", stream);
					expect(conn).toBeUndefined();
				});
			}));
	});

	describe("listAllPeers error handling", () => {
		it("should not destroy peer when listAllPeers fails", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8086, host: "localhost" });

				//@ts-expect-error
				peer._api.listAllPeers = () => Promise.reject(new Error("API failure"));

				peer.once("open", () => {
					peer.once("error", (err) => {
						expect(err.type).toBe(DendriErrorType.ServerError);
						// Dendri should NOT be destroyed - just an error emitted
						expect(peer.destroyed).toBe(false);
						expect(peer.disconnected).toBe(false);
						peer.destroy();
						resolve();
					});

					peer.listAllPeers();
				});
			}));
	});

	describe("relay-only mode", () => {
		it("should not abort when enableRelay is true and WebRTC is not supported", () => {
			const origData = util.supports.data;
			const origAV = util.supports.audioVideo;
			util.supports.data = false;
			util.supports.audioVideo = false;

			try {
				const peer = new Dendri({
					enableRelay: true,
					port: 8086,
					host: "localhost",
				});
				expect(peer.destroyed).toBe(false);
				peer.destroy();
			} finally {
				util.supports.data = origData;
				util.supports.audioVideo = origAV;
			}
		});

		it("should abort when enableRelay is false and WebRTC is not supported", () =>
			new Promise<void>((resolve) => {
				const origData = util.supports.data;
				const origAV = util.supports.audioVideo;
				util.supports.data = false;
				util.supports.audioVideo = false;

				const peer = new Dendri({
					port: 8086,
					host: "localhost",
				});

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.BrowserIncompatible);
					util.supports.data = origData;
					util.supports.audioVideo = origAV;
					peer.destroy();
					resolve();
				});
			}));
	});
});
