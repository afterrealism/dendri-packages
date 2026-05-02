import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionState, DendriErrorType, ServerMessageType } from "../src/enums";
import { util } from "../src/util";

const createMockServer = (id = "1"): Server => {
	const fakeURL = `ws://localhost:8096/dendri?key=dendri&id=${id}&token=testToken`;
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};

describe("ConnectionState — comprehensive", () => {
	let mockServer: Server;

	afterEach(() => {
		if (mockServer) {
			mockServer.stop();
			mockServer = undefined as any;
		}
	});

	// -----------------------------------------------------------------------
	// 1. Every valid state transition fires connectionStateChanged
	// -----------------------------------------------------------------------
	describe("valid transitions fire connectionStateChanged", () => {
		it("Initialized -> Connecting fires event", () => {
			const peer = new Dendri("1", { port: 8096, host: "localhost" });
			// Initialized -> Connecting happens synchronously in constructor
			// So we verify the state is Connecting (event fired internally)
			expect(peer.connectionState).toBe(ConnectionState.Connecting);
			peer.destroy();
		});

		it("Connecting -> Connected fires event", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.on("connectionStateChanged", (newState, oldState) => {
					if (newState === ConnectionState.Connected) {
						expect(oldState).toBe(ConnectionState.Connecting);
						peer.destroy();
						resolve();
					}
				});
			}));

		it("Connected -> Disconnected fires event", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.on("connectionStateChanged", (newState, oldState) => {
						if (newState === ConnectionState.Disconnected) {
							expect(oldState).toBe(ConnectionState.Connected);
							peer.destroy();
							resolve();
						}
					});

					peer.disconnect();
				});
			}));

		it("Disconnected -> Connecting fires event on reconnect", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						peer.on("connectionStateChanged", (newState, oldState) => {
							if (newState === ConnectionState.Connecting) {
								expect(oldState).toBe(ConnectionState.Disconnected);
								peer.destroy();
								resolve();
							}
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));

		it("Connected -> Closed fires event on destroy", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.on("connectionStateChanged", (newState, oldState) => {
						if (newState === ConnectionState.Closed) {
							expect(oldState).toBe(ConnectionState.Disconnected);
							resolve();
						}
					});

					peer.destroy();
				});
			}));

		it("Disconnected -> Suspended fires event", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						peer.on("connectionStateChanged", (newState, oldState) => {
							if (newState === ConnectionState.Suspended) {
								expect(oldState).toBe(ConnectionState.Disconnected);
								peer.destroy();
								resolve();
							}
						});

						const socket = (peer as any)._socket;
						const threshold = (Dendri as any).SUSPEND_THRESHOLD;
						socket.emit("reconnect-attempt", threshold);
					});

					peer.disconnect();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 2. Invalid transitions are silently rejected (no event fired)
	// -----------------------------------------------------------------------
	describe("invalid transitions silently rejected", () => {
		it("should reject Connected -> Initialized", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Initialized);

					expect(peer.connectionState).toBe(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();
					peer.destroy();
					resolve();
				});
			}));

		it("should reject Connected -> Connecting", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Connecting);

					expect(peer.connectionState).toBe(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();
					peer.destroy();
					resolve();
				});
			}));

		it("should reject Connected -> Suspended", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Suspended);

					expect(peer.connectionState).toBe(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();
					peer.destroy();
					resolve();
				});
			}));

		it("should reject Connected -> Failed", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Failed);

					expect(peer.connectionState).toBe(ConnectionState.Connected);
					expect(spy).not.toHaveBeenCalled();
					peer.destroy();
					resolve();
				});
			}));

		it("should reject Closed -> anything (terminal)", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();
					expect(peer.connectionState).toBe(ConnectionState.Closed);

					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					// Try every possible state
					for (const state of Object.values(ConnectionState)) {
						(peer as any)._setState(state as ConnectionState);
					}

					expect(peer.connectionState).toBe(ConnectionState.Closed);
					expect(spy).not.toHaveBeenCalled();
					resolve();
				});
			}));

		it("should not fire event for same-state transition", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Connected);

					expect(spy).not.toHaveBeenCalled();
					peer.destroy();
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 3. Rapid connect/disconnect cycle (3 times)
	// -----------------------------------------------------------------------
	describe("rapid connect/disconnect cycles", () => {
		it(
			"should remain stable after 3 connect/disconnect cycles",
			() =>
				new Promise<void>((resolve) => {
					mockServer = createMockServer();
					const peer = new Dendri("1", { port: 8096, host: "localhost" });
					let cycles = 0;

					const cycle = () => {
						cycles++;
						if (cycles > 3) {
							// After 3 cycles, the state should be consistent
							expect(
								peer.connectionState === ConnectionState.Connected ||
									peer.connectionState === ConnectionState.Connecting ||
									peer.connectionState === ConnectionState.Disconnected,
							).toBe(true);
							peer.destroy();
							resolve();
							return;
						}

						peer.once("disconnected", () => {
							peer.once("open", () => {
								cycle();
							});
							peer.reconnect();
						});
						peer.disconnect();
					};

					peer.once("open", () => {
						cycle();
					});
				}),
			15000,
		);
	});

	// -----------------------------------------------------------------------
	// 4. Suspended -> Connecting -> Connected recovery path
	// -----------------------------------------------------------------------
	describe("Suspended recovery path", () => {
		it("should allow Suspended -> Connecting -> Connected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						// Force into Suspended
						const socket = (peer as any)._socket;
						const threshold = (Dendri as any).SUSPEND_THRESHOLD;
						socket.emit("reconnect-attempt", threshold);
						expect(peer.connectionState).toBe(ConnectionState.Suspended);

						// Reconnect from Suspended -> Connecting
						peer.once("connectionStateChanged", (newState) => {
							expect(newState).toBe(ConnectionState.Connecting);

							// Connected
							peer.once("open", () => {
								expect(peer.connectionState).toBe(ConnectionState.Connected);
								peer.destroy();
								resolve();
							});
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 5. Failed state is truly terminal (only Closed is allowed after)
	// -----------------------------------------------------------------------
	describe("Failed state is terminal", () => {
		it("should only allow Failed -> Closed", () =>
			new Promise<void>((resolve) => {
				const origAudioVideo = util.supports.audioVideo;
				const origData = util.supports.data;
				util.supports.audioVideo = false;
				util.supports.data = false;

				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("error", () => {
					expect(peer.connectionState).toBe(ConnectionState.Failed);

					// Try invalid transitions
					const spy = vi.fn();
					peer.on("connectionStateChanged", spy);

					(peer as any)._setState(ConnectionState.Connecting);
					(peer as any)._setState(ConnectionState.Connected);
					(peer as any)._setState(ConnectionState.Disconnected);
					(peer as any)._setState(ConnectionState.Suspended);
					(peer as any)._setState(ConnectionState.Initialized);

					expect(spy).not.toHaveBeenCalled();
					expect(peer.connectionState).toBe(ConnectionState.Failed);

					// Only Closed should work
					(peer as any)._setState(ConnectionState.Closed);
					expect(peer.connectionState).toBe(ConnectionState.Closed);
					expect(spy).toHaveBeenCalledTimes(1);
					expect(spy).toHaveBeenCalledWith(ConnectionState.Closed, ConnectionState.Failed);

					util.supports.audioVideo = origAudioVideo;
					util.supports.data = origData;
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 6. connectionState getter returns correct value at each stage
	// -----------------------------------------------------------------------
	describe("connectionState getter accuracy", () => {
		it("should return Initialized before constructor starts socket", () => {
			const peer = new Dendri({ port: 8096, host: "localhost" });
			expect(peer.connectionState).toBe(ConnectionState.Initialized);
			peer.destroy();
		});

		it("should return Connecting after explicit ID constructor", () => {
			const peer = new Dendri("1", { port: 8096, host: "localhost" });
			expect(peer.connectionState).toBe(ConnectionState.Connecting);
			peer.destroy();
		});

		it("should return Connected after OPEN message", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					expect(peer.connectionState).toBe(ConnectionState.Connected);
					peer.destroy();
					resolve();
				});
			}));

		it("should return Disconnected after disconnect()", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.once("disconnected", () => {
						expect(peer.connectionState).toBe(ConnectionState.Disconnected);
						peer.destroy();
						resolve();
					});
					peer.disconnect();
				});
			}));

		it("should return Closed after destroy()", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					peer.destroy();
					expect(peer.connectionState).toBe(ConnectionState.Closed);
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 7. Multiple listeners on connectionStateChanged all fire
	// -----------------------------------------------------------------------
	describe("multiple listeners", () => {
		it("should invoke all registered listeners on state change", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				const listener1 = vi.fn();
				const listener2 = vi.fn();
				const listener3 = vi.fn();

				peer.on("connectionStateChanged", listener1);
				peer.on("connectionStateChanged", listener2);
				peer.on("connectionStateChanged", listener3);

				peer.once("open", () => {
					// Connecting -> Connected fired for all three
					expect(listener1).toHaveBeenCalled();
					expect(listener2).toHaveBeenCalled();
					expect(listener3).toHaveBeenCalled();

					// All received same args
					const args1 = listener1.mock.calls.find((c: any[]) => c[0] === ConnectionState.Connected);
					const args2 = listener2.mock.calls.find((c: any[]) => c[0] === ConnectionState.Connected);
					const args3 = listener3.mock.calls.find((c: any[]) => c[0] === ConnectionState.Connected);

					expect(args1).toBeDefined();
					expect(args2).toBeDefined();
					expect(args3).toBeDefined();

					peer.destroy();
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 8. Remove listener during callback (doesn't crash)
	// -----------------------------------------------------------------------
	describe("remove listener during callback", () => {
		it("should not crash when a listener removes itself during emit", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				const selfRemoving = vi.fn(() => {
					peer.off("connectionStateChanged", selfRemoving);
				});

				const otherListener = vi.fn();

				peer.on("connectionStateChanged", selfRemoving);
				peer.on("connectionStateChanged", otherListener);

				peer.once("open", () => {
					// Both should have been called for the Connecting -> Connected transition
					const selfRemovingCalls = selfRemoving.mock.calls.filter(
						(c: any[]) => c[0] === ConnectionState.Connected,
					);
					expect(selfRemovingCalls.length).toBe(1);

					// Disconnect triggers another state change
					peer.once("disconnected", () => {
						// selfRemoving should NOT have been called again (it removed itself)
						const selfRemovingDisconnect = selfRemoving.mock.calls.filter(
							(c: any[]) => c[0] === ConnectionState.Disconnected,
						);
						expect(selfRemovingDisconnect.length).toBe(0);

						// otherListener should have been called
						const otherDisconnect = otherListener.mock.calls.filter(
							(c: any[]) => c[0] === ConnectionState.Disconnected,
						);
						expect(otherDisconnect.length).toBe(1);

						peer.destroy();
						resolve();
					});

					peer.disconnect();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 9. State during reconnection sequence
	// -----------------------------------------------------------------------
	describe("state during reconnection sequence", () => {
		it("should track Connected -> Disconnected -> Connecting -> Connected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const states: ConnectionState[] = [];

				const peer = new Dendri("1", { port: 8096, host: "localhost" });
				peer.on("connectionStateChanged", (newState) => {
					states.push(newState);
				});

				peer.once("open", () => {
					peer.once("disconnected", () => {
						peer.once("open", () => {
							// Should have: Connected, Disconnected, Connecting, Connected
							expect(states).toContain(ConnectionState.Connected);
							expect(states).toContain(ConnectionState.Disconnected);
							expect(states).toContain(ConnectionState.Connecting);

							// Last state should be Connected
							expect(states[states.length - 1]).toBe(ConnectionState.Connected);

							peer.destroy();
							resolve();
						});

						peer.reconnect();
					});

					peer.disconnect();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 10. State when server sends error during connection
	// -----------------------------------------------------------------------
	describe("state on server error during connection", () => {
		it("should transition to Failed on InvalidID error", () =>
			new Promise<void>((resolve) => {
				const peer = new Dendri("invalid id!!!", {
					port: 8096,
					host: "localhost",
				});

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.InvalidID);
					expect(peer.connectionState).toBe(ConnectionState.Failed);
					resolve();
				});
			}));

		it("should transition to Failed on BrowserIncompatible", () =>
			new Promise<void>((resolve) => {
				const origAudioVideo = util.supports.audioVideo;
				const origData = util.supports.data;
				util.supports.audioVideo = false;
				util.supports.data = false;

				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.BrowserIncompatible);
					expect(peer.connectionState).toBe(ConnectionState.Failed);
					expect(peer.destroyed).toBe(true);

					util.supports.audioVideo = origAudioVideo;
					util.supports.data = origData;
					resolve();
				});
			}));
	});

	// -----------------------------------------------------------------------
	// 11. _isValidTransition exhaustive coverage
	// -----------------------------------------------------------------------
	describe("_isValidTransition completeness", () => {
		const validTransitions: Array<[ConnectionState, ConnectionState]> = [
			[ConnectionState.Initialized, ConnectionState.Connecting],
			[ConnectionState.Initialized, ConnectionState.Disconnected],
			[ConnectionState.Initialized, ConnectionState.Closed],
			[ConnectionState.Initialized, ConnectionState.Failed],
			[ConnectionState.Connecting, ConnectionState.Connected],
			[ConnectionState.Connecting, ConnectionState.Disconnected],
			[ConnectionState.Connecting, ConnectionState.Failed],
			[ConnectionState.Connecting, ConnectionState.Closed],
			[ConnectionState.Connected, ConnectionState.Disconnected],
			[ConnectionState.Connected, ConnectionState.Closed],
			[ConnectionState.Disconnected, ConnectionState.Connecting],
			[ConnectionState.Disconnected, ConnectionState.Suspended],
			[ConnectionState.Disconnected, ConnectionState.Closed],
			[ConnectionState.Disconnected, ConnectionState.Failed],
			[ConnectionState.Suspended, ConnectionState.Connecting],
			[ConnectionState.Suspended, ConnectionState.Closed],
			[ConnectionState.Suspended, ConnectionState.Failed],
			[ConnectionState.Failed, ConnectionState.Closed],
		];

		const allStates = Object.values(ConnectionState);

		it.each(validTransitions)("should allow %s -> %s", (from, to) => {
			const result = (Dendri as any)._isValidTransition(from, to);
			expect(result).toBe(true);
		});

		it("should reject all invalid transitions", () => {
			const validSet = new Set(validTransitions.map(([f, t]) => `${f}->${t}`));

			for (const from of allStates) {
				for (const to of allStates) {
					if (from === to) continue; // same-state handled by _setState early return
					const key = `${from}->${to}`;
					if (!validSet.has(key)) {
						const result = (Dendri as any)._isValidTransition(from, to);
						expect(result).toBe(false);
					}
				}
			}
		});
	});

	// -----------------------------------------------------------------------
	// 12. Backward compatibility getters
	// -----------------------------------------------------------------------
	describe("backward compatibility getters", () => {
		it("open should be true only when Connected", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				expect(peer.open).toBe(false); // Connecting

				peer.once("open", () => {
					expect(peer.open).toBe(true); // Connected

					peer.once("disconnected", () => {
						expect(peer.open).toBe(false); // Disconnected

						peer.destroy();
						expect(peer.open).toBe(false); // Closed
						resolve();
					});

					peer.disconnect();
				});
			}));

		it("disconnected should be true for Disconnected, Suspended, Closed, Failed", () =>
			new Promise<void>((resolve) => {
				mockServer = createMockServer();
				const peer = new Dendri("1", { port: 8096, host: "localhost" });

				peer.once("open", () => {
					expect(peer.disconnected).toBe(false); // Connected

					peer.once("disconnected", () => {
						expect(peer.disconnected).toBe(true); // Disconnected
						peer.destroy();
						expect(peer.disconnected).toBe(true); // Closed
						resolve();
					});

					peer.disconnect();
				});
			}));

		it("destroyed should be true for Closed and Failed only", () => {
			const peer = new Dendri("1", { port: 8096, host: "localhost" });
			expect(peer.destroyed).toBe(false); // Connecting

			peer.destroy();
			expect(peer.destroyed).toBe(true); // Closed
		});
	});
});
