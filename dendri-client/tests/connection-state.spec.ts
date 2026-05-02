import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionState, DendriErrorType, ServerMessageType } from "../src/enums";
import { util } from "../src/util";

const createMockServer = (id = "1"): Server => {
	const fakeURL = `ws://localhost:8095/dendri?key=dendri&id=${id}&token=testToken`;
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("ConnectionState machine", () => {
	let mockServer: Server;

	afterEach(() => {
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined as any;
		}
	});

	describe("initial state", () => {
		it("should start in Initialized state before _initialize runs", () => {
			// When constructed without an ID and the API retrieval hasn't resolved,
			// the state remains Initialized (no synchronous _initialize call).
			const peer = new Dendri({ port: 8095, host: "localhost" });
			expect(peer.connectionState).toBe(ConnectionState.Initialized);
			peer.destroy();
		});

		it("should be Connecting after constructor with explicit ID", () => {
			// With an explicit ID, _initialize runs synchronously in the constructor
			const peer = new Dendri("1", { port: 8095, host: "localhost" });
			expect(peer.connectionState).toBe(ConnectionState.Connecting);
			peer.destroy();
		});
	});

	describe("Initialized -> Connecting", () => {
		it("should transition to Connecting when _initialize is called", () => {
			mockServer = createMockServer();
			const stateChanges: Array<{ from: ConnectionState; to: ConnectionState }> = [];

			const peer = new Dendri("1", { port: 8095, host: "localhost" });
			peer.on("connectionStateChanged", (to, from) => {
				stateChanges.push({ from, to });
			});

			// After construction with an ID, _initialize is called synchronously,
			// transitioning to Connecting.
			expect(peer.connectionState).toBe(ConnectionState.Connecting);

			peer.destroy();
		});
	});

	describe("Connecting -> Connected", () => {
		it("should transition to Connected on server OPEN message", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					expect(peer.connectionState).toBe(ConnectionState.Connected);
					peer.destroy();
					resolve();
				});
			}));
	});

	describe("Connected -> Disconnected", () => {
		it("should transition to Disconnected on disconnect()", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);
						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));
	});

	describe("Connected -> Disconnected on network loss", () => {
		it("should transition to Disconnected when socket emits disconnected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				// Disable socket auto-reconnect so the disconnect event
				// propagates to the Dendri layer.
				(peer as any)._socket._autoReconnect = false;

				peer.once("open", () => {
					peer.once("disconnected", () => {
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);
						peer.destroy();
						resolve();
					});

					// Simulate server-side close (network loss)
					mockServer.close();
				});
			}));
	});

	describe("Disconnected -> Connecting (reconnect)", () => {
		it("should transition to Connecting on reconnect()", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);

						peer.once("connectionStateChanged", (newState) => {
							expect(newState).toBe(ConnectionState.Connecting);
							peer.destroy();
							resolve();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});

	describe("Disconnected -> Suspended after N failed reconnects", () => {
		it("should transition to Suspended after SUSPEND_THRESHOLD reconnect attempts", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					// Move to disconnected state first
					peer.once("disconnected", () => {
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);

						// Simulate reconnect attempts at the socket level
						const socket = (peer as any)._socket;
						const threshold = (Dendri as any).SUSPEND_THRESHOLD;

						// Fire reconnect attempts up to the threshold
						for (let i = 1; i < threshold; i++) {
							socket.emit("reconnect-attempt", i);
						}

						// Should still be Disconnected
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);

						// Fire the threshold attempt
						socket.emit("reconnect-attempt", threshold);

						// Should now be Suspended
						expect(peer.connectionState).toBe(ConnectionState.Suspended);
						expect(peer.disconnected).toBe(true);

						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));
	});

	describe("Suspended -> Connecting (reconnect)", () => {
		it("should allow reconnect from Suspended state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						// Force into Suspended state
						const socket = (peer as any)._socket;
						const threshold = (Dendri as any).SUSPEND_THRESHOLD;
						socket.emit("reconnect-attempt", threshold);
						expect(peer.connectionState).toBe(ConnectionState.Suspended);

						peer.once("connectionStateChanged", (newState) => {
							expect(newState).toBe(ConnectionState.Connecting);
							peer.destroy();
							resolve();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});

	describe("-> Closed on destroy()", () => {
		it("should transition to Closed on destroy()", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("close", () => {
						expect(peer.connectionState).toBe(ConnectionState.Closed);
						resolve();
					});

					peer.destroy();
				});
			}));

		it("should transition to Closed from Initialized", () => {
			const peer = new Dendri("1", { port: 8095, host: "localhost" });
			peer.destroy();
			expect(peer.connectionState).toBe(ConnectionState.Closed);
		});
	});

	describe("-> Failed on unrecoverable error", () => {
		it("should transition to Failed on BrowserIncompatible error", () =>
			new Promise<void>((resolve) => {
				const origAudioVideo = util.supports.audioVideo;
				const origData = util.supports.data;

				util.supports.audioVideo = false;
				util.supports.data = false;

				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.BrowserIncompatible);
					expect(peer.connectionState).toBe(ConnectionState.Failed);
					expect(peer.destroyed).toBe(true);

					// Restore
					util.supports.audioVideo = origAudioVideo;
					util.supports.data = origData;
					resolve();
				});
			}));

		it("should transition to Failed on InvalidID error", () =>
			new Promise<void>((resolve) => {
				const peer = new Dendri("invalid id with spaces!@#", {
					port: 8095,
					host: "localhost",
				});

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.InvalidID);
					expect(peer.connectionState).toBe(ConnectionState.Failed);
					expect(peer.destroyed).toBe(true);
					resolve();
				});
			}));
	});

	describe("invalid transitions", () => {
		it("should reject Closed -> Connected transition", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();
					expect(peer.connectionState).toBe(ConnectionState.Closed);

					// Attempt to set Connected via private method — should be rejected
					(peer as any)._setState(ConnectionState.Connected);
					expect(peer.connectionState).toBe(ConnectionState.Closed);

					resolve();
				});
			}));

		it("should reject Connected -> Initialized transition", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					(peer as any)._setState(ConnectionState.Initialized);
					expect(peer.connectionState).toBe(ConnectionState.Connected);

					peer.destroy();
					resolve();
				});
			}));

		it("should not emit event on rejected transition", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();

					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();

					resolve();
				});
			}));
	});

	describe("connectionStateChanged event", () => {
		it("should fire with new and old state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const stateChanges: Array<{ from: ConnectionState; to: ConnectionState }> = [];

				const peer = new Dendri("1", { port: 8095, host: "localhost" });
				// The Initialized -> Connecting transition fires synchronously in
				// the constructor, before we can register a listener. We capture
				// subsequent transitions here.
				peer.on("connectionStateChanged", (to, from) => {
					stateChanges.push({ from, to });
				});

				peer.once("open", () => {
					// The listener captures: Connecting -> Connected
					expect(stateChanges.length).toBeGreaterThanOrEqual(1);

					const connectedTransition = stateChanges.find((s) => s.to === ConnectionState.Connected);
					expect(connectedTransition).toBeDefined();
					expect(connectedTransition!.from).toBe(ConnectionState.Connecting);

					peer.destroy();
					resolve();
				});
			}));

		it("should not fire on same-state transition", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					// Try to set same state
					(peer as any)._setState(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();

					peer.destroy();
					resolve();
				});
			}));
	});

	describe("backward compatibility", () => {
		it("open getter should return true when Connected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					expect(peer.open).toBe(true);
					peer.destroy();
					resolve();
				});
			}));

		it("open getter should return false when not Connected", () => {
			const peer = new Dendri("1", { port: 8095, host: "localhost" });
			expect(peer.open).toBe(false);
			peer.destroy();
		});

		it("disconnected getter should return true for Disconnected state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						expect(peer.disconnected).toBe(true);
						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));

		it("disconnected getter should return true for Suspended state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						// Force into Suspended
						const socket = (peer as any)._socket;
						const threshold = (Dendri as any).SUSPEND_THRESHOLD;
						socket.emit("reconnect-attempt", threshold);

						expect(peer.disconnected).toBe(true);
						expect(peer.connectionState).toBe(ConnectionState.Suspended);
						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));

		it("disconnected getter should return false for Connected state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					expect(peer.disconnected).toBe(false);
					peer.destroy();
					resolve();
				});
			}));

		it("destroyed getter should return true for Closed state", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();
					expect(peer.destroyed).toBe(true);
					expect(peer.connectionState).toBe(ConnectionState.Closed);
					resolve();
				});
			}));

		it("destroyed getter should return true for Failed state", () =>
			new Promise<void>((resolve) => {
				const origAudioVideo = util.supports.audioVideo;
				const origData = util.supports.data;

				util.supports.audioVideo = false;
				util.supports.data = false;

				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("error", () => {
					expect(peer.destroyed).toBe(true);
					expect(peer.connectionState).toBe(ConnectionState.Failed);

					util.supports.audioVideo = origAudioVideo;
					util.supports.data = origData;
					resolve();
				});
			}));

		it("destroyed getter should return false for non-terminal states", () => {
			const peer = new Dendri("1", { port: 8095, host: "localhost" });
			expect(peer.destroyed).toBe(false);
			peer.destroy();
		});

		it("connect => disconnect => reconnect => destroy flow should match existing behavior", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8095, host: "localhost" });

				peer.once("open", () => {
					expect(peer.open).toBe(true);
					expect(peer.disconnected).toBe(false);
					expect(peer.destroyed).toBe(false);

					peer.once("disconnected", () => {
						expect(peer.open).toBe(false);
						expect(peer.disconnected).toBe(true);
						expect(peer.destroyed).toBe(false);

						peer.once("open", () => {
							expect(peer.open).toBe(true);
							expect(peer.disconnected).toBe(false);
							expect(peer.destroyed).toBe(false);

							peer.once("close", () => {
								expect(peer.open).toBe(false);
								expect(peer.disconnected).toBe(true);
								expect(peer.destroyed).toBe(true);
								resolve();
							});

							peer.destroy();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});

	describe("full lifecycle state tracking", () => {
		it("should track complete state sequence through lifecycle", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const states: ConnectionState[] = [];

				const peer = new Dendri("1", { port: 8095, host: "localhost" });
				// Initialized -> Connecting happens synchronously in the constructor.
				// Capture the current state and listen for subsequent transitions.
				states.push(peer.connectionState);

				peer.on("connectionStateChanged", (newState) => {
					states.push(newState);
				});

				peer.once("open", () => {
					peer.once("disconnected", () => {
						peer.once("open", () => {
							peer.once("close", () => {
								// Connecting (captured after constructor) -> Connected -> Disconnected -> Connecting -> Connected -> Disconnected -> Closed
								expect(states).toEqual([
									ConnectionState.Connecting,
									ConnectionState.Connected,
									ConnectionState.Disconnected,
									ConnectionState.Connecting,
									ConnectionState.Connected,
									ConnectionState.Disconnected,
									ConnectionState.Closed,
								]);
								resolve();
							});

							peer.destroy();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});
});
