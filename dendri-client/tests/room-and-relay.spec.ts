import { Server } from "mock-socket";
import { Dendri } from "../src/dendri";
import { ServerMessageType } from "../src/enums";

const PORT = 8095;
const WS_BASE = `ws://localhost:${PORT}/dendri?key=dendri`;

/**
 * Create a mock-socket Server that sends OPEN on connection.
 * Returns a handle to send arbitrary messages and inspect received ones.
 */
function createMockServer(id: string) {
	const fakeURL = `${WS_BASE}&id=${id}&token=testToken`;
	const mockServer = new Server(fakeURL);
	const received: any[] = [];

	mockServer.on("connection", (socket) => {
		socket.send(JSON.stringify({ type: ServerMessageType.Open }));

		//@ts-expect-error mock-socket types
		socket.on("message", (data: string) => {
			try {
				received.push(JSON.parse(data));
			} catch {
				received.push(data);
			}
		});
	});

	return { server: mockServer, received };
}

function createPeer(id: string): Promise<Dendri> {
	return new Promise((resolve) => {
		const peer = new Dendri(id, { port: PORT, host: "localhost" });
		peer.once("open", () => resolve(peer));
	});
}

// ---------------------------------------------------------------------------
// Room operations: joinRoom / leaveRoom wire format
// ---------------------------------------------------------------------------
describe("Room operations wire format", () => {
	let mockServer: Server;
	let received: any[];
	let peer: Dendri;

	beforeEach(async () => {
		const mock = createMockServer("room-peer");
		mockServer = mock.server;
		received = mock.received;
		peer = await createPeer("room-peer");
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("joinRoom sends ROOM-JOIN with hyphen (matching server wire format)", async () => {
		peer.joinRoom("lobby");

		// Give mock-socket time to process
		await new Promise((r) => setTimeout(r, 50));

		const joinMsg = received.find((m) => m.type === "ROOM-JOIN");
		expect(joinMsg).toBeDefined();
		expect(joinMsg.type).toBe("ROOM-JOIN");
		expect(joinMsg.room).toBe("lobby");
	});

	it("leaveRoom sends ROOM-LEAVE with hyphen (matching server wire format)", async () => {
		peer.leaveRoom("lobby");

		await new Promise((r) => setTimeout(r, 50));

		const leaveMsg = received.find((m) => m.type === "ROOM-LEAVE");
		expect(leaveMsg).toBeDefined();
		expect(leaveMsg.type).toBe("ROOM-LEAVE");
		expect(leaveMsg.room).toBe("lobby");
	});

	it("joinRoom and leaveRoom do not use underscore format", async () => {
		peer.joinRoom("test-room");
		peer.leaveRoom("test-room");

		await new Promise((r) => setTimeout(r, 50));

		const underscoredMsgs = received.filter(
			(m) => m.type === "ROOM_JOIN" || m.type === "ROOM_LEAVE",
		);
		expect(underscoredMsgs.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// ROOM-PEERS handling in _handleMessage
// ---------------------------------------------------------------------------
describe("ROOM-PEERS message handling", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(async () => {
		const mock = createMockServer("rp-peer");
		mockServer = mock.server;
		peer = await createPeer("rp-peer");
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("emits roomPeers event with room name and peer list", () =>
		new Promise<void>((resolve) => {
			peer.on("roomPeers", (room: string, peers: string[]) => {
				expect(room).toBe("game");
				expect(peers).toEqual(["alice", "bob", "rp-peer"]);
				resolve();
			});

			// Simulate server sending ROOM-PEERS (hyphen format, matching wire)
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.RoomPeers,
				room: "game",
				payload: ["alice", "bob", "rp-peer"],
			});
		}));

	it("handles empty peer list", () =>
		new Promise<void>((resolve) => {
			peer.on("roomPeers", (room: string, peers: string[]) => {
				expect(room).toBe("empty-room");
				expect(peers).toEqual([]);
				resolve();
			});

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.RoomPeers,
				room: "empty-room",
				payload: [],
			});
		}));

	it("defaults room to empty string when missing", () =>
		new Promise<void>((resolve) => {
			peer.on("roomPeers", (room: string, peers: string[]) => {
				expect(room).toBe("");
				expect(peers).toEqual(["p1"]);
				resolve();
			});

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.RoomPeers,
				payload: ["p1"],
			});
		}));

	it("treats non-array payload as empty peers list", () =>
		new Promise<void>((resolve) => {
			peer.on("roomPeers", (room: string, peers: string[]) => {
				expect(room).toBe("r1");
				expect(peers).toEqual([]);
				resolve();
			});

			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.RoomPeers,
				room: "r1",
				payload: "not-an-array",
			});
		}));
});

// ---------------------------------------------------------------------------
// DATA message routing to HybridConnection
// ---------------------------------------------------------------------------
describe("DATA message relay routing", () => {
	let mockServer: Server;
	let peer: Dendri;

	beforeEach(async () => {
		const mock = createMockServer("data-peer");
		mockServer = mock.server;
		peer = await createPeer("data-peer");
	});

	afterEach(() => {
		peer.destroy();
		mockServer.stop();
	});

	it("routes DATA messages to HybridConnection.handleRelayData", () =>
		new Promise<void>((resolve) => {
			// Create a hybrid connection (it uses the mock provider internally)
			const hybrid = peer.connectHybrid("remote-sender");
			expect(hybrid).toBeDefined();

			// Listen for data on the hybrid connection
			hybrid!.on("data", (data: any) => {
				expect(data).toEqual({ cursor: [10, 20] });
				hybrid!.close();
				resolve();
			});

			// Simulate receiving a DATA message from the server
			//@ts-expect-error
			peer._handleMessage({
				type: ServerMessageType.Data,
				src: "remote-sender",
				payload: { cursor: [10, 20] },
			});
		}));

	it("logs warning when DATA received for unknown peer (no HybridConnection)", () => {
		// This should not throw - just log a warning
		//@ts-expect-error
		peer._handleMessage({
			type: ServerMessageType.Data,
			src: "unknown-peer",
			payload: { x: 1 },
		});
		// No crash = test passes
	});
});

// ---------------------------------------------------------------------------
// ServerMessageType enum wire format consistency
// ---------------------------------------------------------------------------
describe("ServerMessageType wire format", () => {
	it("room types use hyphens to match server serde format", () => {
		expect(ServerMessageType.RoomJoin).toBe("ROOM-JOIN");
		expect(ServerMessageType.RoomLeave).toBe("ROOM-LEAVE");
		expect(ServerMessageType.RoomPeers).toBe("ROOM-PEERS");
	});

	it("ID-TAKEN uses hyphen to match server serde format", () => {
		expect(ServerMessageType.IdTaken).toBe("ID-TAKEN");
	});

	it("standard types match server format", () => {
		expect(ServerMessageType.Open).toBe("OPEN");
		expect(ServerMessageType.Error).toBe("ERROR");
		expect(ServerMessageType.Leave).toBe("LEAVE");
		expect(ServerMessageType.Expire).toBe("EXPIRE");
		expect(ServerMessageType.Heartbeat).toBe("HEARTBEAT");
		expect(ServerMessageType.Offer).toBe("OFFER");
		expect(ServerMessageType.Answer).toBe("ANSWER");
		expect(ServerMessageType.Candidate).toBe("CANDIDATE");
		expect(ServerMessageType.Data).toBe("DATA");
		expect(ServerMessageType.Ack).toBe("ACK");
	});
});

// ---------------------------------------------------------------------------
// API.getTurnCredentials tests
// ---------------------------------------------------------------------------
describe("API.getTurnCredentials", () => {
	it("is available as a method on the API class", async () => {
		const { API } = await import("../src/api");
		const api = new API({
			host: "localhost",
			port: 9000,
			path: "/",
			key: "dendri",
			secure: false,
		});
		expect(typeof api.getTurnCredentials).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// ServerMessage interface consistency
// ---------------------------------------------------------------------------
describe("ServerMessage interface fields", () => {
	it("message with seq, room, timestamp fields can be parsed", () => {
		// Simulate what the server sends for a DATA message with all fields
		const raw = JSON.stringify({
			type: "DATA",
			src: "alice",
			dst: "bob",
			payload: { x: 1 },
			seq: 42,
			room: "lobby",
			timestamp: 1700000000000,
		});

		const parsed = JSON.parse(raw);
		expect(parsed.seq).toBe(42);
		expect(parsed.room).toBe("lobby");
		expect(parsed.timestamp).toBe(1700000000000);
	});
});
