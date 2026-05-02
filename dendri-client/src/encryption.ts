/**
 * E2E encryption for relay messages using ECDH + AES-256-GCM.
 * Uses the Web Crypto API -- available in all modern browsers and Node.js 18+.
 */

/** Encrypted payload structure sent over the relay. */
export interface EncryptedPayload {
	readonly iv: string;
	readonly ciphertext: string;
}

export class RelayEncryption {
	private _keyPair: CryptoKeyPair | null = null;
	private _sharedKey: CryptoKey | null = null;
	private _ready = false;

	get ready(): boolean {
		return this._ready;
	}

	/** Generate ECDH key pair and return the public key as JWK. */
	async generateKeyPair(): Promise<JsonWebKey> {
		this._keyPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
			"deriveKey",
		]);
		return crypto.subtle.exportKey("jwk", this._keyPair.publicKey);
	}

	/** Derive shared AES-256-GCM key from remote peer's public key. */
	async deriveSharedKey(remotePublicKeyJwk: JsonWebKey): Promise<void> {
		if (!this._keyPair) {
			throw new Error("Key pair not generated");
		}

		const remotePublicKey = await crypto.subtle.importKey(
			"jwk",
			remotePublicKeyJwk,
			{ name: "ECDH", namedCurve: "P-256" },
			false,
			[],
		);

		this._sharedKey = await crypto.subtle.deriveKey(
			{ name: "ECDH", public: remotePublicKey },
			this._keyPair.privateKey,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
		this._ready = true;
	}

	/** Encrypt a message for relay. */
	async encrypt(data: string): Promise<EncryptedPayload> {
		if (!this._sharedKey) {
			throw new Error("Shared key not derived");
		}

		const iv = crypto.getRandomValues(new Uint8Array(12));
		const encoded = new TextEncoder().encode(data);

		const ciphertext = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv },
			this._sharedKey,
			encoded,
		);

		return {
			iv: btoa(String.fromCharCode(...iv)),
			ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
		};
	}

	/** Decrypt a message from relay. */
	async decrypt(encrypted: EncryptedPayload): Promise<string> {
		if (!this._sharedKey) {
			throw new Error("Shared key not derived");
		}

		const iv = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0));
		const ciphertext = Uint8Array.from(atob(encrypted.ciphertext), (c) => c.charCodeAt(0));

		const decrypted = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv },
			this._sharedKey,
			ciphertext,
		);

		return new TextDecoder().decode(decrypted);
	}

	/** Reset encryption state. */
	clear(): void {
		this._keyPair = null;
		this._sharedKey = null;
		this._ready = false;
	}
}
