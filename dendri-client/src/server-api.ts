/**
 * Server-side API client for dendri signal server.
 * Use this from your backend to manage peers and rooms programmatically.
 */
export class DendriServerAPI {
	private readonly _baseUrl: string;
	private readonly _key: string;

	constructor(options: { url: string; key?: string }) {
		this._baseUrl = options.url.replace(/\/$/, "");
		this._key = options.key ?? "dendri";
	}

	/** Get server health and stats */
	async getHealth(): Promise<{
		status: string;
		clients: number;
		rooms: number;
		uptime_ms: number;
		relay_enabled: boolean;
	}> {
		const res = await fetch(`${this._baseUrl}/health`);
		if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
		return res.json();
	}

	/** List all connected peer IDs */
	async listPeers(room?: string): Promise<string[]> {
		const url = room
			? `${this._baseUrl}/${this._key}/peers?room=${encodeURIComponent(room)}`
			: `${this._baseUrl}/${this._key}/peers`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`List peers failed: ${res.status}`);
		return res.json();
	}

	/** Generate a new peer ID */
	async generatePeerId(): Promise<string> {
		const res = await fetch(`${this._baseUrl}/${this._key}/id`);
		if (!res.ok) throw new Error(`Generate ID failed: ${res.status}`);
		return res.text();
	}

	/** Get TURN credentials */
	async getTurnCredentials(): Promise<{ iceServers: RTCIceServer[] }> {
		const res = await fetch(`${this._baseUrl}/${this._key}/turn-credentials`);
		if (!res.ok) throw new Error(`TURN credentials failed: ${res.status}`);
		return res.json();
	}

	/** Get analytics metadata */
	async getAnalytics(): Promise<{ dataset: string; events_tracked: string[] }> {
		const res = await fetch(`${this._baseUrl}/analytics`);
		if (!res.ok) throw new Error(`Analytics failed: ${res.status}`);
		return res.json();
	}
}
