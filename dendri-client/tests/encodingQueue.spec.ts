import { EncodingQueue } from "../src/encodingQueue";

describe("EncodingQueue", () => {
	let queue: EncodingQueue;

	beforeEach(() => {
		queue = new EncodingQueue();
	});

	afterEach(() => {
		queue.destroy();
		queue.removeAllListeners();
	});

	describe("initial state", () => {
		it("should start with empty queue", () => {
			expect(queue.size).toBe(0);
			expect(queue.queue).toEqual([]);
		});

		it("should not be processing initially", () => {
			expect(queue.processing).toBe(false);
		});
	});

	describe("enqueue", () => {
		it("should process a single blob and emit done", () =>
			new Promise<void>((resolve) => {
				const testData = new Uint8Array([1, 2, 3, 4]);
				const blob = new Blob([testData]);

				queue.on("done", (result: ArrayBuffer) => {
					expect(result).toBeInstanceOf(ArrayBuffer);
					expect(new Uint8Array(result)).toEqual(testData);
					expect(queue.processing).toBe(false);
					resolve();
				});

				queue.enqueue(blob);
			}));

		it("should process multiple blobs sequentially", () =>
			new Promise<void>((resolve) => {
				const results: ArrayBuffer[] = [];
				const blob1 = new Blob([new Uint8Array([1, 2])]);
				const blob2 = new Blob([new Uint8Array([3, 4])]);
				const blob3 = new Blob([new Uint8Array([5, 6])]);

				queue.on("done", (result: ArrayBuffer) => {
					results.push(result);

					if (results.length === 3) {
						expect(new Uint8Array(results[0])).toEqual(new Uint8Array([1, 2]));
						expect(new Uint8Array(results[1])).toEqual(new Uint8Array([3, 4]));
						expect(new Uint8Array(results[2])).toEqual(new Uint8Array([5, 6]));
						resolve();
					}
				});

				queue.enqueue(blob1);
				queue.enqueue(blob2);
				queue.enqueue(blob3);
			}));

		it("should be processing while reading", () => {
			const blob = new Blob([new Uint8Array([1])]);
			queue.enqueue(blob);

			// Immediately after enqueue, processing should be true
			expect(queue.processing).toBe(true);
		});

		it("should queue items when already processing", () => {
			const blob1 = new Blob([new Uint8Array([1])]);
			const blob2 = new Blob([new Uint8Array([2])]);

			queue.enqueue(blob1);
			// First blob starts processing, second gets queued
			queue.enqueue(blob2);

			// The first blob is being processed (shifted from queue),
			// so only the second blob remains in the queue
			expect(queue.queue.length).toBe(1);
		});
	});

	describe("destroy", () => {
		it("should clear the queue", () => {
			const blob1 = new Blob([new Uint8Array([1])]);
			const blob2 = new Blob([new Uint8Array([2])]);
			queue.enqueue(blob1);
			queue.enqueue(blob2);

			queue.destroy();

			expect(queue.queue).toEqual([]);
			expect(queue.size).toBe(0);
		});
	});

	describe("error handling", () => {
		it("should emit error and destroy on blob.arrayBuffer() failure", () =>
			new Promise<void>((resolve) => {
				const errorSpy = vi.fn();
				queue.on("error", errorSpy);

				// Create a blob whose arrayBuffer() rejects
				const badBlob = new Blob([new Uint8Array([1])]);
				badBlob.arrayBuffer = () => Promise.reject(new Error("arrayBuffer failed"));

				queue.on("error", () => {
					// After error, queue should be destroyed (empty)
					expect(queue.queue).toEqual([]);
					expect(queue.processing).toBe(false);
					resolve();
				});

				queue.enqueue(badBlob);
			}));
	});

	describe("doNextTask", () => {
		it("should not process when queue is empty", () =>
			new Promise<void>((resolve) => {
				const doneSpy = vi.fn();
				queue.on("done", doneSpy);

				// Enqueue and process a single item, then verify no further processing
				const blob = new Blob([new Uint8Array([1])]);
				queue.enqueue(blob);

				queue.on("done", () => {
					// Queue is now empty; doNextTask should be a no-op
					expect(queue.size).toBe(0);
					expect(queue.processing).toBe(false);
					resolve();
				});
			}));
	});
});
