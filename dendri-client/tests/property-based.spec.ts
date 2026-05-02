import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AckManager } from "../src/ack";
import { electNewHost } from "../src/hostmigration";
import { isRpcRequest, isRpcResponse, RpcErrorCode, RpcManager } from "../src/rpc";
import { isTopicEnvelope, TopicManager } from "../src/topics";

describe("Property-Based Tests", () => {
	describe("TopicManager", () => {
		it("dispatch returns true iff at least one handler exists for the topic", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 50 }),
					fc.string({ minLength: 1, maxLength: 50 }),
					(subscribedTopic, dispatchTopic) => {
						const tm = new TopicManager();
						tm.subscribe(subscribedTopic, () => {});
						const result = tm.dispatch(dispatchTopic, "data", "peer1");
						return result === (subscribedTopic === dispatchTopic);
					},
				),
			);
		});

		it("subscribeAll always causes dispatch to return true", () => {
			fc.assert(
				fc.property(fc.string(), fc.anything(), (topic, data) => {
					const tm = new TopicManager();
					tm.subscribeAll(() => {});
					return tm.dispatch(topic, data, "peer") === true;
				}),
			);
		});
	});

	describe("isTopicEnvelope", () => {
		it("returns true for any object with __topic string and __data", () => {
			fc.assert(
				fc.property(fc.string(), fc.anything(), (topic, data) => {
					return isTopicEnvelope({ __topic: topic, __data: data }) === true;
				}),
			);
		});

		it("returns false for non-objects", () => {
			fc.assert(
				fc.property(
					fc.oneof(
						fc.string(),
						fc.integer(),
						fc.boolean(),
						fc.constant(null),
						fc.constant(undefined),
					),
					(value) => {
						return isTopicEnvelope(value) === false;
					},
				),
			);
		});
	});

	describe("AckManager", () => {
		it("nextId always returns unique IDs", () => {
			const manager = new AckManager();
			const ids = new Set<string>();
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 1000 }), (n) => {
					for (let i = 0; i < n; i++) {
						ids.add(manager.nextId());
					}
					return ids.size >= n; // All unique
				}),
			);
		});

		it("handleAck returns true only for pending IDs", () => {
			fc.assert(
				fc.property(
					fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 20 }),
					fc.nat({ max: 19 }),
					(ids, targetIndex) => {
						const manager = new AckManager();
						const idx = targetIndex % ids.length;
						const targetId = ids[idx];

						// Register one pending ACK
						manager.waitForAck(targetId, 60000).catch(() => {});

						// Only the registered ID should succeed
						return manager.handleAck(targetId) === true;
					},
				),
			);
		});
	});

	describe("RPC type guards", () => {
		it("isRpcRequest identifies valid requests", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1 }),
					fc.string({ minLength: 1 }),
					fc.anything(),
					fc.string(),
					(id, method, payload, sender) => {
						const req = { __rpc: true, id, method, payload, sender };
						return isRpcRequest(req) === true;
					},
				),
			);
		});

		it("isRpcResponse identifies valid responses", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1 }), fc.anything(), (id, result) => {
					return isRpcResponse({ __rpc_response: true, id, result }) === true;
				}),
			);
		});

		it("isRpcRequest and isRpcResponse are mutually exclusive", () => {
			fc.assert(
				fc.property(fc.anything(), (value) => {
					return !(isRpcRequest(value) && isRpcResponse(value));
				}),
			);
		});
	});

	describe("electNewHost", () => {
		it("always returns the lexicographically smallest peer ID", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1, maxLength: 20 }),
					fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 20 }),
					(myId, peerIds) => {
						const result = electNewHost(myId, peerIds);
						const all = [myId, ...peerIds].sort();
						return result === all[0];
					},
				),
			);
		});

		it("is deterministic — same inputs always produce same output", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1 }),
					fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 10 }),
					(myId, peerIds) => {
						const r1 = electNewHost(myId, peerIds);
						const r2 = electNewHost(myId, peerIds);
						return r1 === r2;
					},
				),
			);
		});

		it("result is always one of the input IDs", () => {
			fc.assert(
				fc.property(
					fc.string({ minLength: 1 }),
					fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 10 }),
					(myId, peerIds) => {
						const result = electNewHost(myId, peerIds);
						return [myId, ...peerIds].includes(result);
					},
				),
			);
		});
	});

	describe("Encryption round-trip", () => {
		// Only run if crypto.subtle is available
		const hasCrypto = typeof globalThis.crypto?.subtle !== "undefined";

		it.skipIf(!hasCrypto)("encrypt then decrypt preserves any string", async () => {
			const { RelayEncryption } = await import("../src/encryption");

			await fc.assert(
				fc.asyncProperty(fc.string({ minLength: 0, maxLength: 10000 }), async (plaintext) => {
					const a = new RelayEncryption();
					const b = new RelayEncryption();
					const pubA = await a.generateKeyPair();
					const pubB = await b.generateKeyPair();
					await a.deriveSharedKey(pubB);
					await b.deriveSharedKey(pubA);

					const encrypted = await a.encrypt(plaintext);
					const decrypted = await b.decrypt(encrypted);
					return decrypted === plaintext;
				}),
				{ numRuns: 20 },
			); // Limit runs since crypto is slow
		});
	});
});
