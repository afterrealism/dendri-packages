import logger from "./logger";
import type { DendriOption } from "./optionInterfaces";
import { util } from "./util";

declare const __VERSION__: string;
const version = __VERSION__;

export class API {
	private static readonly FETCH_TIMEOUT = 10_000;

	constructor(private readonly _options: DendriOption) {}

	private _buildRequest(method: string): Promise<Response> {
		const protocol = this._options.secure ? "https" : "http";
		const { host, port, path, key } = this._options;
		const url = new URL(`${protocol}://${host}:${port}${path}${key}/${method}`);
		// TODO: Why timestamp, why random?
		url.searchParams.set("ts", `${Date.now()}${Math.random()}`);
		url.searchParams.set("version", version);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), API.FETCH_TIMEOUT);

		return fetch(url.href, {
			referrerPolicy: this._options.referrerPolicy,
			signal: controller.signal,
		}).finally(() => clearTimeout(timeoutId));
	}

	/** Get a unique ID from the server via XHR and initialize with it. */
	async retrieveId(): Promise<string> {
		try {
			const response = await this._buildRequest("id");

			if (response.status !== 200) {
				throw new Error(`Error. Status:${response.status}`);
			}

			return response.text();
		} catch (error) {
			logger.error("Error retrieving ID", error);

			let pathError = "";

			if (this._options.path === "/" && this._options.host !== util.CLOUD_HOST) {
				pathError =
					" If you passed in a `path` to your self-hosted Dendri server, " +
					"you'll also need to pass in that same path when creating a new " +
					"Dendri instance.";
			}

			throw new Error(`Could not get an ID from the server.${pathError}`);
		}
	}

	/** Fetch TURN credentials from the signaling server's GET /turn endpoint. */
	async getTurnCredentials(): Promise<RTCIceServer[]> {
		const protocol = this._options.secure ? "https" : "http";
		const { host, port } = this._options;
		const url = `${protocol}://${host}:${port}/turn`;

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), API.FETCH_TIMEOUT);

			const response = await fetch(url, {
				referrerPolicy: this._options.referrerPolicy,
				signal: controller.signal,
			}).finally(() => clearTimeout(timeoutId));

			if (!response.ok) {
				return [];
			}

			const data = await response.json();
			const raw = (data as { iceServers?: RTCIceServer | RTCIceServer[] }).iceServers;
			if (!raw) return [];
			return Array.isArray(raw) ? raw : [raw];
		} catch (error) {
			logger.error("Error fetching TURN credentials", error);
			return [];
		}
	}

	/** @deprecated */
	async listAllPeers(): Promise<any[]> {
		try {
			const response = await this._buildRequest("peers");

			if (response.status !== 200) {
				if (response.status === 401) {
					throw new Error(
						"It doesn't look like you have permission to list peers IDs. " +
							"Check your server configuration and ensure allow_discovery is enabled.",
					);
				}

				throw new Error(`Error. Status:${response.status}`);
			}

			return response.json();
		} catch (error) {
			logger.error("Error retrieving list peers", error);

			throw new Error(
				"Could not get list peers from the server. " +
					(error instanceof Error ? error.message : error),
			);
		}
	}
}
