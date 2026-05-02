import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ConnectionType, DendriErrorType, ServerMessageType } from "../src/enums";

const createMockServer = (): Server => {
	const fakeURL = "ws://localhost:8080/dendri?key=dendri&id=1&token=testToken";
	const mockServer = new Server(fakeURL);

	mockServer.on("connection", (socket) => {
		//@ts-expect-error
		socket.on("message", (_data) => {
			socket.send("test message from mock server");
		});

		socket.send(JSON.stringify({ type: ServerMessageType.Open }));
	});

	return mockServer;
};
describe("Dendri", () => {
	describe("after construct with explicit server options", () => {
		it("shouldn't contains any connection", () => {
			const peer = new Dendri({ host: "localhost", port: 8080 });

			expect(peer.open).toBe(false);
			expect(peer.connections).toEqual({});
			expect(peer.id).toBeNull();
			expect(peer.disconnected).toBe(false);
			expect(peer.destroyed).toBe(false);

			peer.destroy();
		});
	});

	describe("after construct with parameters", () => {
		it("should contains id and key", () => {
			const peer = new Dendri("1", { key: "anotherKey", host: "localhost", port: 8080 });

			expect(peer.id).toBe("1");
			expect(peer.options.key).toBe("anotherKey");

			peer.destroy();
		});
	});

	describe.skip("after call to peer #2", () => {
		let mockServer: ReturnType<typeof createMockServer>;

		beforeAll(() => {
			mockServer = createMockServer();
		});

		it("Dendri#1 should has id #1", () =>
			new Promise<void>((resolve) => {
				const peer1 = new Dendri("1", { port: 8080, host: "localhost" });
				expect(peer1.open).toBe(false);

				const mediaOptions = {
					metadata: { var: "123" },
					constraints: {
						mandatory: {
							OfferToReceiveAudio: true,
							OfferToReceiveVideo: true,
						},
					},
				};

				const track = new MediaStreamTrack();
				const mediaStream = new MediaStream([track]);

				const mediaConnection = peer1.call("2", mediaStream, { ...mediaOptions });

				expect(typeof mediaConnection.connectionId).toBe("string");
				expect(mediaConnection.type).toBe(ConnectionType.Media);
				expect(mediaConnection.peer).toBe("2");
				expect(mediaConnection.options).toEqual(
					// expect.arrayContaining([mediaOptions]),mediaOptions
					expect.objectContaining(mediaOptions),
				);
				expect(mediaConnection.metadata).toEqual(mediaOptions.metadata);
				expect(mediaConnection.peerConnection.getSenders()[0].track.id).toBe(track.id);

				peer1.once("open", (id) => {
					expect(id).toBe("1");
					//@ts-expect-error
					expect(peer1._lastServerId).toBe("1");
					expect(peer1.disconnected).toBe(false);
					expect(peer1.destroyed).toBe(false);
					expect(peer1.open).toBe(true);

					peer1.destroy();

					expect(peer1.disconnected).toBe(true);
					expect(peer1.destroyed).toBe(true);
					expect(peer1.open).toBe(false);
					expect(peer1.connections).toEqual({});

					resolve();
				});
			}));

		afterAll(() => {
			mockServer.stop();
		});
	});

	describe("reconnect", () => {
		let mockServer: ReturnType<typeof createMockServer>;

		beforeAll(() => {
			mockServer = createMockServer();
		});

		it("connect to server => disconnect => reconnect => destroy", () =>
			new Promise<void>((resolve) => {
				const peer1 = new Dendri("1", { port: 8080, host: "localhost" });

				peer1.once("open", () => {
					expect(peer1.open).toBe(true);

					peer1.once("disconnected", () => {
						expect(peer1.disconnected).toBe(true);
						expect(peer1.destroyed).toBe(false);
						expect(peer1.open).toBe(false);

						peer1.once("open", (id) => {
							expect(id).toBe("1");
							expect(peer1.disconnected).toBe(false);
							expect(peer1.destroyed).toBe(false);
							expect(peer1.open).toBe(true);

							peer1.once("disconnected", () => {
								expect(peer1.disconnected).toBe(true);
								expect(peer1.destroyed).toBe(false);
								expect(peer1.open).toBe(false);

								peer1.once("close", () => {
									expect(peer1.disconnected).toBe(true);
									expect(peer1.destroyed).toBe(true);
									expect(peer1.open).toBe(false);

									resolve();
								});
							});

							peer1.destroy();
						});

						peer1.reconnect();
					});

					peer1.disconnect();
				});
			}));

		it("disconnect => reconnect => destroy", () =>
			new Promise<void>((resolve) => {
				mockServer.stop();

				const peer1 = new Dendri("1", { port: 8080, host: "localhost" });

				// Disable socket-level auto-reconnect so the initial connection
				// failure surfaces as a Dendri-level disconnected event (this test
				// exercises Dendri.reconnect(), not socket auto-reconnect).
				(peer1 as any)._socket._autoReconnect = false;

				peer1.once("disconnected", (id) => {
					expect(id).toBe("1");
					expect(peer1.disconnected).toBe(true);
					expect(peer1.destroyed).toBe(false);
					expect(peer1.open).toBe(false);

					peer1.once("open", (id) => {
						expect(id).toBe("1");
						expect(peer1.disconnected).toBe(false);
						expect(peer1.destroyed).toBe(false);
						expect(peer1.open).toBe(true);

						peer1.once("disconnected", () => {
							expect(peer1.disconnected).toBe(true);
							expect(peer1.destroyed).toBe(false);
							expect(peer1.open).toBe(false);

							peer1.once("close", () => {
								expect(peer1.disconnected).toBe(true);
								expect(peer1.destroyed).toBe(true);
								expect(peer1.open).toBe(false);

								resolve();
							});
						});

						peer1.destroy();
					});

					mockServer = createMockServer();

					peer1.reconnect();
				});
			}));

		it("reconnect => disconnect => destroy", () =>
			new Promise<void>((resolve) => {
				const peer1 = new Dendri("1", { port: 8080, host: "localhost" });

				peer1.once("open", () => {
					expect(peer1.open).toBe(true);

					peer1.once("disconnected", () => {
						expect(peer1.disconnected).toBe(true);
						expect(peer1.destroyed).toBe(false);
						expect(peer1.open).toBe(false);

						peer1.once("open", (id) => {
							expect(id).toBe("1");
							expect(peer1.disconnected).toBe(false);
							expect(peer1.destroyed).toBe(false);
							expect(peer1.open).toBe(true);

							peer1.once("disconnected", () => {
								expect(peer1.disconnected).toBe(true);
								expect(peer1.destroyed).toBe(false);
								expect(peer1.open).toBe(false);

								peer1.once("close", () => {
									expect(peer1.disconnected).toBe(true);
									expect(peer1.destroyed).toBe(true);
									expect(peer1.open).toBe(false);

									resolve();
								});
							});

							peer1.destroy();
						});

						peer1.reconnect();
					});

					peer1.disconnect();
				});
			}));

		it("destroy peer if no id and no connection", () =>
			new Promise<void>((resolve) => {
				mockServer.stop();

				const peer1 = new Dendri({ port: 8080, host: "localhost" });

				peer1.once("error", (error) => {
					expect(error.type).toBe(DendriErrorType.ServerError);

					peer1.once("close", () => {
						expect(peer1.disconnected).toBe(true);
						expect(peer1.destroyed).toBe(true);
						expect(peer1.open).toBe(false);

						resolve();
					});

					mockServer = createMockServer();
				});
			}));

		afterAll(() => {
			mockServer.stop();
		});
	});
});
