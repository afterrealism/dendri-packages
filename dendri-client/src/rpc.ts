/**
 * RPC (Remote Procedure Call) layer for request-response patterns over P2P connections.
 *
 * Inspired by LiveKit's `performRpc`/`registerRpcMethod`, this module enables
 * peers to expose named methods that other peers can call and await results.
 *
 * Usage (via Room):
 *   // Responder
 *   room.registerRpcMethod("greet", (payload) => `Hello, ${payload}!`);
 *
 *   // Caller
 *   const result = await room.performRpc("greet", "world");
 *   // result === "Hello, world!"
 */

export interface RpcRequest {
	readonly __rpc: true;
	readonly id: string;
	readonly method: string;
	readonly payload: unknown;
	readonly sender: string;
}

export interface RpcResponse {
	readonly __rpc_response: true;
	readonly id: string;
	readonly result?: unknown;
	readonly error?: { readonly code: number; readonly message: string };
}

export type RpcHandler = (payload: unknown, sender: string) => unknown | Promise<unknown>;

/** Standard RPC error codes (inspired by LiveKit). */
export enum RpcErrorCode {
	APPLICATION_ERROR = 1500,
	CONNECTION_TIMEOUT = 1501,
	RESPONSE_TIMEOUT = 1502,
	RECIPIENT_DISCONNECTED = 1503,
	RESPONSE_PAYLOAD_TOO_LARGE = 1504,
	METHOD_NOT_FOUND = 1505,
}

export class RpcError extends Error {
	readonly code: number;

	constructor(code: number, message: string) {
		super(message);
		this.name = "RpcError";
		this.code = code;
	}
}

interface PendingRpc {
	readonly resolve: (result: unknown) => void;
	readonly reject: (err: RpcError) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

export class RpcManager {
	private readonly _handlers = new Map<string, RpcHandler>();
	private readonly _pending = new Map<string, PendingRpc>();
	private _counter = 0;

	/** Register a method handler. Returns an unregister function. */
	registerMethod(name: string, handler: RpcHandler): () => void {
		this._handlers.set(name, handler);
		return () => {
			this._handlers.delete(name);
		};
	}

	/** Perform an RPC call -- returns a promise that resolves with the response. */
	performRpc(
		method: string,
		payload: unknown,
		sendFn: (data: RpcRequest) => void,
		options?: { readonly timeout?: number },
	): Promise<unknown> {
		const id = `rpc_${++this._counter}_${Date.now()}`;
		const timeout = options?.timeout ?? 10_000;

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new RpcError(RpcErrorCode.RESPONSE_TIMEOUT, `RPC timeout: ${method}`));
			}, timeout);

			this._pending.set(id, { resolve, reject, timer });

			sendFn({
				__rpc: true,
				id,
				method,
				payload,
				sender: "", // filled by the caller (e.g. Room)
			});
		});
	}

	/** Handle an incoming RPC request -- execute handler and return response. */
	async handleRequest(request: RpcRequest): Promise<RpcResponse> {
		const handler = this._handlers.get(request.method);

		if (!handler) {
			return {
				__rpc_response: true,
				id: request.id,
				error: {
					code: RpcErrorCode.METHOD_NOT_FOUND,
					message: `Method not found: ${request.method}`,
				},
			};
		}

		try {
			const result = await handler(request.payload, request.sender);
			return { __rpc_response: true, id: request.id, result };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const code = err instanceof RpcError ? err.code : RpcErrorCode.APPLICATION_ERROR;
			return {
				__rpc_response: true,
				id: request.id,
				error: { code, message },
			};
		}
	}

	/** Handle an incoming RPC response -- resolve the pending promise. */
	handleResponse(response: RpcResponse): boolean {
		const pending = this._pending.get(response.id);

		if (!pending) {
			return false;
		}

		clearTimeout(pending.timer);
		this._pending.delete(response.id);

		if (response.error) {
			pending.reject(new RpcError(response.error.code, response.error.message));
		} else {
			pending.resolve(response.result);
		}

		return true;
	}

	/** Clear all pending RPCs, rejecting them with CONNECTION_TIMEOUT. */
	clear(): void {
		for (const [, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new RpcError(RpcErrorCode.CONNECTION_TIMEOUT, "Connection closed"));
		}
		this._pending.clear();
	}

	/** Number of RPCs currently awaiting a response. */
	get pendingCount(): number {
		return this._pending.size;
	}

	/** Names of all registered RPC methods. */
	get registeredMethods(): string[] {
		return Array.from(this._handlers.keys());
	}
}

/** Type guard for RPC request messages. */
export function isRpcRequest(data: unknown): data is RpcRequest {
	return (
		typeof data === "object" &&
		data !== null &&
		"__rpc" in data &&
		(data as Record<string, unknown>).__rpc === true
	);
}

/** Type guard for RPC response messages. */
export function isRpcResponse(data: unknown): data is RpcResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		"__rpc_response" in data &&
		(data as Record<string, unknown>).__rpc_response === true
	);
}
