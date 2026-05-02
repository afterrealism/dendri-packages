import { describe, expect, it } from "vitest";
import { ServerMessageType } from "../src/enums";

describe("Wire Protocol Snapshots", () => {
	describe("ServerMessageType values", () => {
		it("all message types match expected wire format", () => {
			const types: Record<string, string> = {};
			for (const [key, value] of Object.entries(ServerMessageType)) {
				if (Number.isNaN(Number(key))) types[key] = value as string;
			}
			expect(types).toMatchSnapshot();
		});
	});

	describe("Topic envelope format", () => {
		it("matches expected shape", () => {
			const envelope = { __topic: "cursor", __data: { x: 10, y: 20 } };
			expect(JSON.stringify(envelope)).toMatchSnapshot();
		});
	});

	describe("ACK request format", () => {
		it("matches expected shape", () => {
			const ackRequest = { __ackId: "ack_1_1234567890", data: { hello: "world" } };
			expect(JSON.stringify(ackRequest)).toMatchSnapshot();
		});
	});

	describe("RPC request format", () => {
		it("matches expected shape", () => {
			const rpcReq = {
				__rpc: true,
				id: "rpc_1_1234567890",
				method: "getScore",
				payload: { level: 1 },
				sender: "peer-abc",
			};
			expect(JSON.stringify(rpcReq)).toMatchSnapshot();
		});
	});

	describe("RPC response format", () => {
		it("success matches expected shape", () => {
			const rpcRes = { __rpc_response: true, id: "rpc_1_1234567890", result: { score: 42 } };
			expect(JSON.stringify(rpcRes)).toMatchSnapshot();
		});

		it("error matches expected shape", () => {
			const rpcErr = {
				__rpc_response: true,
				id: "rpc_1_1234567890",
				error: { code: 1505, message: "Method not found: foo" },
			};
			expect(JSON.stringify(rpcErr)).toMatchSnapshot();
		});
	});

	describe("Encrypted payload format", () => {
		it("matches expected shape", () => {
			const encrypted = { __encrypted: { iv: "base64iv==", ciphertext: "base64data==" } };
			expect(JSON.stringify(encrypted)).toMatchSnapshot();
		});
	});

	describe("KEY-EXCHANGE format", () => {
		it("matches expected shape", () => {
			const keyExchange = {
				type: "KEY-EXCHANGE",
				src: "peer-a",
				dst: "peer-b",
				payload: { publicKey: { kty: "EC", crv: "P-256", x: "...", y: "..." } },
			};
			expect(JSON.stringify(keyExchange)).toMatchSnapshot();
		});
	});
});
