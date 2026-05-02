import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for jsdom which lacks it.
if (!globalThis.crypto?.subtle) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

import { RelayEncryption } from "../src/encryption";

describe("RelayEncryption", () => {
	// -------------------------------------------------------------------
	// 1. generateKeyPair
	// -------------------------------------------------------------------
	describe("generateKeyPair", () => {
		it("should return a JWK with expected ECDH P-256 fields", async () => {
			const enc = new RelayEncryption();
			const jwk = await enc.generateKeyPair();

			expect(jwk.kty).toBe("EC");
			expect(jwk.crv).toBe("P-256");
			expect(jwk.x).toBeDefined();
			expect(jwk.y).toBeDefined();
		});
	});

	// -------------------------------------------------------------------
	// 2. deriveSharedKey
	// -------------------------------------------------------------------
	describe("deriveSharedKey", () => {
		it("should succeed when both peers exchange public keys", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			expect(alice.ready).toBe(true);
			expect(bob.ready).toBe(true);
		});

		it("should throw if called before generateKeyPair", async () => {
			const enc = new RelayEncryption();
			const other = new RelayEncryption();
			const otherPub = await other.generateKeyPair();

			await expect(enc.deriveSharedKey(otherPub)).rejects.toThrow("Key pair not generated");
		});
	});

	// -------------------------------------------------------------------
	// 3. encrypt / decrypt round-trip
	// -------------------------------------------------------------------
	describe("encrypt and decrypt", () => {
		it("should round-trip a simple message", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			const encrypted = await alice.encrypt("hello world");
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe("hello world");
		});

		it("should work in both directions (B encrypts, A decrypts)", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			const encrypted = await bob.encrypt("from bob");
			const decrypted = await alice.decrypt(encrypted);

			expect(decrypted).toBe("from bob");
		});

		it("should work with unicode strings", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			const message = "Hello 世界! Привет мир! 🌍🔑";
			const encrypted = await alice.encrypt(message);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(message);
		});

		it("should work with large messages", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			// 100KB message
			const largeMessage = "x".repeat(100_000);
			const encrypted = await alice.encrypt(largeMessage);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(largeMessage);
		});

		it("should produce different ciphertexts for the same plaintext (unique IVs)", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			const enc1 = await alice.encrypt("same message");
			const enc2 = await alice.encrypt("same message");

			// IVs should differ (with overwhelming probability)
			expect(enc1.iv).not.toBe(enc2.iv);
			// Ciphertexts should differ
			expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
		});
	});

	// -------------------------------------------------------------------
	// 4. Error conditions
	// -------------------------------------------------------------------
	describe("error conditions", () => {
		it("should throw on encrypt before key derivation", async () => {
			const enc = new RelayEncryption();
			await enc.generateKeyPair();

			await expect(enc.encrypt("test")).rejects.toThrow("Shared key not derived");
		});

		it("should throw on decrypt before key derivation", async () => {
			const enc = new RelayEncryption();
			await enc.generateKeyPair();

			await expect(
				enc.decrypt({ iv: btoa("aaaaaaaaaaaa"), ciphertext: btoa("data") }),
			).rejects.toThrow("Shared key not derived");
		});

		it("should fail decryption with a wrong key (different key pair)", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();
			const eve = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();
			const evePub = await eve.generateKeyPair();

			// Alice and Bob establish a shared key
			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			// Eve derives a key with Alice (different shared secret)
			await eve.deriveSharedKey(alicePub);

			const encrypted = await alice.encrypt("secret for bob");

			// Bob can decrypt
			const decryptedByBob = await bob.decrypt(encrypted);
			expect(decryptedByBob).toBe("secret for bob");

			// Eve cannot decrypt (different shared key)
			await expect(eve.decrypt(encrypted)).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 5. clear()
	// -------------------------------------------------------------------
	describe("clear", () => {
		it("should reset state so ready is false", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			expect(alice.ready).toBe(true);

			alice.clear();
			expect(alice.ready).toBe(false);
		});

		it("should cause encrypt to throw after clear", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			alice.clear();

			await expect(alice.encrypt("test")).rejects.toThrow("Shared key not derived");
		});

		it("should cause generateKeyPair to be needed again after clear", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const bobPub = await bob.generateKeyPair();
			await alice.generateKeyPair();
			await alice.deriveSharedKey(bobPub);

			alice.clear();

			await expect(alice.deriveSharedKey(bobPub)).rejects.toThrow("Key pair not generated");
		});
	});

	// -------------------------------------------------------------------
	// 6. ready flag
	// -------------------------------------------------------------------
	describe("ready flag", () => {
		it("should be false initially", () => {
			const enc = new RelayEncryption();
			expect(enc.ready).toBe(false);
		});

		it("should be false after generateKeyPair but before deriveSharedKey", async () => {
			const enc = new RelayEncryption();
			await enc.generateKeyPair();
			expect(enc.ready).toBe(false);
		});

		it("should be true after deriveSharedKey", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			expect(alice.ready).toBe(true);
		});

		it("should be false after clear", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			expect(alice.ready).toBe(true);

			alice.clear();
			expect(alice.ready).toBe(false);
		});
	});
});
