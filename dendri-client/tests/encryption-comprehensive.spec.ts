import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for jsdom which lacks it.
if (!globalThis.crypto?.subtle) {
	Object.defineProperty(globalThis, "crypto", { value: webcrypto, writable: true });
}

import { RelayEncryption } from "../src/encryption";

describe("RelayEncryption — comprehensive", () => {
	// -------------------------------------------------------------------
	// Helper: set up a fully-paired encryption channel between two parties.
	// -------------------------------------------------------------------
	async function setupPair(): Promise<{ alice: RelayEncryption; bob: RelayEncryption }> {
		const alice = new RelayEncryption();
		const bob = new RelayEncryption();

		const alicePub = await alice.generateKeyPair();
		const bobPub = await bob.generateKeyPair();

		await alice.deriveSharedKey(bobPub);
		await bob.deriveSharedKey(alicePub);

		return { alice, bob };
	}

	// -------------------------------------------------------------------
	// 1. Emoji and special characters
	// -------------------------------------------------------------------
	describe("emoji and special characters", () => {
		it("should encrypt/decrypt emoji-heavy strings", async () => {
			const { alice, bob } = await setupPair();

			const message = "Hello 🌍🔑💻🚀 — test with emojis!";
			const encrypted = await alice.encrypt(message);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(message);
		});

		it("should handle mixed scripts and special chars", async () => {
			const { alice, bob } = await setupPair();

			const message = "日本語テスト Привет 안녕하세요 مرحبا <>&\"'`\t\n\0";
			const encrypted = await alice.encrypt(message);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(message);
		});

		it("should handle combining characters and diacritics", async () => {
			const { alice, bob } = await setupPair();

			// e + combining acute accent, plus other combining marks
			const message = "cafe\u0301 re\u0301sume\u0301 nai\u0308ve";
			const encrypted = await alice.encrypt(message);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(message);
		});

		it("should handle zero-width characters", async () => {
			const { alice, bob } = await setupPair();

			const message = "zero\u200Bwidth\u200Cjoiner\u200Dtest\uFEFF";
			const encrypted = await alice.encrypt(message);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(message);
		});
	});

	// -------------------------------------------------------------------
	// 2. Unique IVs per encryption
	// -------------------------------------------------------------------
	describe("unique IVs per encryption", () => {
		it("should produce different IVs when encrypting the same message twice", async () => {
			const { alice } = await setupPair();

			const enc1 = await alice.encrypt("same message");
			const enc2 = await alice.encrypt("same message");

			expect(enc1.iv).not.toBe(enc2.iv);
		});

		it("should produce different IVs across 50 encryptions", async () => {
			const { alice } = await setupPair();

			const ivs = new Set<string>();
			for (let i = 0; i < 50; i++) {
				const enc = await alice.encrypt("repeated");
				ivs.add(enc.iv);
			}

			expect(ivs.size).toBe(50);
		});
	});

	// -------------------------------------------------------------------
	// 3. Two independent pairs communicating (A<->B and C<->D)
	// -------------------------------------------------------------------
	describe("two independent encryption pairs", () => {
		it("should not interfere with each other", async () => {
			const pairAB = await setupPair();
			const pairCD = await setupPair();

			const encAB = await pairAB.alice.encrypt("message for Bob");
			const encCD = await pairCD.alice.encrypt("message for David");

			// Each pair can decrypt its own messages
			const decAB = await pairAB.bob.decrypt(encAB);
			const decCD = await pairCD.bob.decrypt(encCD);

			expect(decAB).toBe("message for Bob");
			expect(decCD).toBe("message for David");
		});

		it("pair A-B cannot decrypt pair C-D messages", async () => {
			const pairAB = await setupPair();
			const pairCD = await setupPair();

			const encCD = await pairCD.alice.encrypt("secret for David");

			// Bob (from pair A-B) should not be able to decrypt C-D's message
			await expect(pairAB.bob.decrypt(encCD)).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 4. Key derivation symmetry
	// -------------------------------------------------------------------
	describe("key derivation symmetry", () => {
		it("should produce identical shared keys regardless of derivation order", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();

			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			// A encrypts, B decrypts
			const enc1 = await alice.encrypt("test symmetry");
			const dec1 = await bob.decrypt(enc1);
			expect(dec1).toBe("test symmetry");

			// B encrypts, A decrypts
			const enc2 = await bob.encrypt("reverse direction");
			const dec2 = await alice.decrypt(enc2);
			expect(dec2).toBe("reverse direction");
		});

		it("should work regardless of which peer generates first", async () => {
			// Bob generates first, then Alice
			const bob = new RelayEncryption();
			const alice = new RelayEncryption();

			const bobPub = await bob.generateKeyPair();
			const alicePub = await alice.generateKeyPair();

			// Derive in opposite order from typical
			await bob.deriveSharedKey(alicePub);
			await alice.deriveSharedKey(bobPub);

			const encrypted = await alice.encrypt("order-independent");
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe("order-independent");
		});
	});

	// -------------------------------------------------------------------
	// 5. Corrupted ciphertext should throw
	// -------------------------------------------------------------------
	describe("corrupted ciphertext", () => {
		it("should throw when ciphertext bytes are tampered with", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("secret message");

			// Tamper with the ciphertext: decode, flip a byte, re-encode
			const rawBytes = Uint8Array.from(atob(encrypted.ciphertext), (c) => c.charCodeAt(0));
			rawBytes[0] ^= 0xff;
			const corrupted = btoa(String.fromCharCode(...rawBytes));

			await expect(bob.decrypt({ iv: encrypted.iv, ciphertext: corrupted })).rejects.toThrow();
		});

		it("should throw when ciphertext is truncated", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("truncation test");

			// Truncate ciphertext to half
			const truncated = encrypted.ciphertext.slice(0, Math.floor(encrypted.ciphertext.length / 2));

			await expect(bob.decrypt({ iv: encrypted.iv, ciphertext: truncated })).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 6. Corrupted IV should throw
	// -------------------------------------------------------------------
	describe("corrupted IV", () => {
		it("should throw when IV bytes are tampered with", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("iv corruption test");

			// Tamper with the IV
			const rawIv = Uint8Array.from(atob(encrypted.iv), (c) => c.charCodeAt(0));
			rawIv[0] ^= 0xff;
			const corruptedIv = btoa(String.fromCharCode(...rawIv));

			await expect(
				bob.decrypt({ iv: corruptedIv, ciphertext: encrypted.ciphertext }),
			).rejects.toThrow();
		});

		it("should throw when IV is wrong length", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("wrong iv length");

			// Use a 6-byte IV instead of 12-byte
			const shortIv = btoa(String.fromCharCode(...new Uint8Array(6)));

			await expect(
				bob.decrypt({ iv: shortIv, ciphertext: encrypted.ciphertext }),
			).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 7. Wrong key pair should throw DOMException
	// -------------------------------------------------------------------
	describe("wrong key pair decryption", () => {
		it("should throw when decrypting with a mismatched shared key", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();
			const eve = new RelayEncryption();

			const alicePub = await alice.generateKeyPair();
			const bobPub = await bob.generateKeyPair();
			const evePub = await eve.generateKeyPair();

			// Alice-Bob pair
			await alice.deriveSharedKey(bobPub);
			await bob.deriveSharedKey(alicePub);

			// Eve derives with Bob (different shared secret from Alice-Bob)
			await eve.deriveSharedKey(bobPub);

			const encrypted = await alice.encrypt("only for Bob");

			// Eve should fail to decrypt
			await expect(eve.decrypt(encrypted)).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 8. encrypt() after clear() should throw
	// -------------------------------------------------------------------
	describe("encrypt after clear", () => {
		it("should throw 'Shared key not derived' when encrypting after clear()", async () => {
			const { alice } = await setupPair();

			alice.clear();

			await expect(alice.encrypt("after clear")).rejects.toThrow("Shared key not derived");
		});

		it("should throw 'Shared key not derived' when decrypting after clear()", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("before clear");
			bob.clear();

			await expect(bob.decrypt(encrypted)).rejects.toThrow("Shared key not derived");
		});

		it("should throw 'Key pair not generated' when deriving after clear()", async () => {
			const { alice, bob } = await setupPair();
			const bobPub = await bob.generateKeyPair();

			alice.clear();

			await expect(alice.deriveSharedKey(bobPub)).rejects.toThrow("Key pair not generated");
		});
	});

	// -------------------------------------------------------------------
	// 9. Performance: encrypt/decrypt 100 messages sequentially
	// -------------------------------------------------------------------
	describe("performance", () => {
		it("should encrypt/decrypt 100 messages sequentially without error", async () => {
			const { alice, bob } = await setupPair();

			for (let i = 0; i < 100; i++) {
				const msg = `message-${i}`;
				const encrypted = await alice.encrypt(msg);
				const decrypted = await bob.decrypt(encrypted);
				expect(decrypted).toBe(msg);
			}
		});
	});

	// -------------------------------------------------------------------
	// 10. Large message (64KB — safe for btoa spread limit)
	// -------------------------------------------------------------------
	describe("large message", () => {
		it("should encrypt/decrypt a 64KB message", async () => {
			const { alice, bob } = await setupPair();

			// 64KB is well under the call stack limit for String.fromCharCode spread
			const largeMessage = "x".repeat(64_000);
			const encrypted = await alice.encrypt(largeMessage);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(largeMessage);
			expect(decrypted.length).toBe(64_000);
		});

		it("should encrypt/decrypt a 100KB message", async () => {
			const { alice, bob } = await setupPair();

			// 100KB works (the existing test suite tests this size)
			const largeMessage = "x".repeat(100_000);
			const encrypted = await alice.encrypt(largeMessage);
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe(largeMessage);
			expect(decrypted.length).toBe(100_000);
		});
	});

	// -------------------------------------------------------------------
	// 11. Empty string encrypt/decrypt
	// -------------------------------------------------------------------
	describe("empty string", () => {
		it("should encrypt/decrypt an empty string", async () => {
			const { alice, bob } = await setupPair();

			const encrypted = await alice.encrypt("");
			const decrypted = await bob.decrypt(encrypted);

			expect(decrypted).toBe("");
		});

		it("should produce non-empty ciphertext for empty plaintext", async () => {
			const { alice } = await setupPair();

			const encrypted = await alice.encrypt("");

			// AES-GCM produces auth tag even for empty plaintext
			expect(encrypted.ciphertext.length).toBeGreaterThan(0);
			expect(encrypted.iv.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------
	// 12. generateKeyPair returns valid P-256 JWK
	// -------------------------------------------------------------------
	describe("generateKeyPair JWK format", () => {
		it("should return a JWK with kty=EC, crv=P-256, and x/y coordinates", async () => {
			const enc = new RelayEncryption();
			const jwk = await enc.generateKeyPair();

			expect(jwk.kty).toBe("EC");
			expect(jwk.crv).toBe("P-256");
			expect(typeof jwk.x).toBe("string");
			expect(typeof jwk.y).toBe("string");
			expect(jwk.x!.length).toBeGreaterThan(0);
			expect(jwk.y!.length).toBeGreaterThan(0);
		});

		it("should not include private key component (d) in the exported JWK", async () => {
			const enc = new RelayEncryption();
			const jwk = await enc.generateKeyPair();

			// The public key export should not contain the private scalar
			// (Web Crypto exportKey("jwk", publicKey) strips it by default)
			expect(jwk.d).toBeUndefined();
		});

		it("should generate unique key pairs on each call", async () => {
			const enc1 = new RelayEncryption();
			const enc2 = new RelayEncryption();

			const jwk1 = await enc1.generateKeyPair();
			const jwk2 = await enc2.generateKeyPair();

			expect(jwk1.x).not.toBe(jwk2.x);
		});

		it("should set ready to false after generateKeyPair (before deriveSharedKey)", async () => {
			const enc = new RelayEncryption();
			await enc.generateKeyPair();

			expect(enc.ready).toBe(false);
		});
	});

	// -------------------------------------------------------------------
	// 13. Multiple sequential key exchanges on same instance
	// -------------------------------------------------------------------
	describe("key regeneration", () => {
		it("should allow generating a new key pair after clear()", async () => {
			const alice = new RelayEncryption();
			const bob = new RelayEncryption();

			// First key exchange
			const alicePub1 = await alice.generateKeyPair();
			const bobPub1 = await bob.generateKeyPair();
			await alice.deriveSharedKey(bobPub1);
			await bob.deriveSharedKey(alicePub1);

			const enc1 = await alice.encrypt("first session");
			const dec1 = await bob.decrypt(enc1);
			expect(dec1).toBe("first session");

			// Clear and re-key
			alice.clear();
			bob.clear();

			const alicePub2 = await alice.generateKeyPair();
			const bobPub2 = await bob.generateKeyPair();
			await alice.deriveSharedKey(bobPub2);
			await bob.deriveSharedKey(alicePub2);

			const enc2 = await alice.encrypt("second session");
			const dec2 = await bob.decrypt(enc2);
			expect(dec2).toBe("second session");

			// Old ciphertext should not decrypt with new keys
			await expect(bob.decrypt(enc1)).rejects.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// 14. EncryptedPayload structure
	// -------------------------------------------------------------------
	describe("EncryptedPayload shape", () => {
		it("should return an object with iv and ciphertext string fields", async () => {
			const { alice } = await setupPair();

			const payload = await alice.encrypt("shape test");

			expect(typeof payload.iv).toBe("string");
			expect(typeof payload.ciphertext).toBe("string");
			expect(Object.keys(payload).sort()).toEqual(["ciphertext", "iv"]);
		});

		it("iv and ciphertext should be valid base64", async () => {
			const { alice } = await setupPair();

			const payload = await alice.encrypt("base64 test");

			// atob should not throw for valid base64
			expect(() => atob(payload.iv)).not.toThrow();
			expect(() => atob(payload.ciphertext)).not.toThrow();
		});
	});
});
