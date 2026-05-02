import { DendriError, EventEmitterWithError } from "../src/dendriError";
import { DendriErrorType } from "../src/enums";

describe("DendriError", () => {
	describe("construction with string", () => {
		it("should preserve the error message", () => {
			const error = new DendriError(DendriErrorType.Network, "Connection failed");

			expect(error.message).toBe("Connection failed");
			expect(error.type).toBe(DendriErrorType.Network);
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(DendriError);
		});

		it("should set different error types", () => {
			const err1 = new DendriError(DendriErrorType.Disconnected, "Disconnected from server");
			const err2 = new DendriError(DendriErrorType.WebRTC, "ICE failure");

			expect(err1.type).toBe("disconnected");
			expect(err2.type).toBe("webrtc");
		});
	});

	describe("construction with Error object", () => {
		it("should preserve the original error message", () => {
			const originalError = new Error("Original error message");
			const peerError = new DendriError(DendriErrorType.ServerError, originalError);

			expect(peerError.message).toBe("Original error message");
			expect(peerError.type).toBe(DendriErrorType.ServerError);
		});

		it("should preserve the original error stack", () => {
			const originalError = new Error("Stack test");
			const peerError = new DendriError(DendriErrorType.Network, originalError);

			expect(peerError.stack).toBe(originalError.stack);
		});

		it("should not lose message when wrapping Error objects", () => {
			const original = new TypeError("Cannot read property 'x' of null");
			const wrapped = new DendriError(DendriErrorType.WebRTC, original);

			expect(wrapped.message).toBe("Cannot read property 'x' of null");
			expect(wrapped.type).toBe(DendriErrorType.WebRTC);
		});
	});
});

describe("EventEmitterWithError", () => {
	it("should emit typed DendriError events", () =>
		new Promise<void>((resolve) => {
			const emitter = new EventEmitterWithError<
				DendriErrorType,
				{ error: (error: DendriError<`${DendriErrorType}`>) => void }
			>();

			emitter.on("error", (error) => {
				expect(error).toBeInstanceOf(DendriError);
				expect(error.type).toBe(DendriErrorType.Network);
				expect(error.message).toBe("test error");
				resolve();
			});

			emitter.emitError(DendriErrorType.Network, "test error");
		}));

	it("should emit DendriError from Error objects", () =>
		new Promise<void>((resolve) => {
			const emitter = new EventEmitterWithError<
				DendriErrorType,
				{ error: (error: DendriError<`${DendriErrorType}`>) => void }
			>();

			emitter.on("error", (error) => {
				expect(error).toBeInstanceOf(DendriError);
				expect(error.message).toBe("original message");
				resolve();
			});

			emitter.emitError(DendriErrorType.ServerError, new Error("original message"));
		}));
});
