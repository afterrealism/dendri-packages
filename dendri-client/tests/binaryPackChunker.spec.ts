import {
	BinaryPackChunker,
	concatArrayBuffers,
} from "../src/dataconnection/BufferedConnection/binaryPackChunker";

describe("BinaryPackChunker", () => {
	describe("chunkedMTU", () => {
		it("should be 16300", () => {
			const chunker = new BinaryPackChunker();
			expect(chunker.chunkedMTU).toBe(16300);
		});
	});

	describe("chunk()", () => {
		it("should return a single chunk for small data", () => {
			const chunker = new BinaryPackChunker();
			const data = new ArrayBuffer(100);

			const chunks = chunker.chunk(data);

			expect(chunks.length).toBe(1);
			expect(chunks[0].__peerData).toBe(1);
			expect(chunks[0].n).toBe(0);
			expect(chunks[0].total).toBe(1);
			expect(chunks[0].data.byteLength).toBe(100);
		});

		it("should split large data into multiple chunks", () => {
			const chunker = new BinaryPackChunker();
			const size = 16300 * 3 + 500; // Should produce 4 chunks
			const data = new ArrayBuffer(size);

			const chunks = chunker.chunk(data);

			expect(chunks.length).toBe(4);
			expect(chunks[0].total).toBe(4);

			// Verify chunk ordering
			for (let i = 0; i < chunks.length; i++) {
				expect(chunks[i].n).toBe(i);
				expect(chunks[i].__peerData).toBe(1); // First call on fresh instance, _dataCount = 1
			}

			// Verify total size
			const totalBytes = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
			expect(totalBytes).toBe(size);
		});

		it("should return data as ArrayBuffer (not Uint8Array)", () => {
			const chunker = new BinaryPackChunker();
			const data = new ArrayBuffer(50);

			const chunks = chunker.chunk(data);

			expect(chunks[0].data).toBeInstanceOf(ArrayBuffer);
		});

		it("should increment dataCount across calls", () => {
			const chunker = new BinaryPackChunker();

			const chunks1 = chunker.chunk(new ArrayBuffer(10));
			const chunks2 = chunker.chunk(new ArrayBuffer(10));
			const chunks3 = chunker.chunk(new ArrayBuffer(10));

			expect(chunks1[0].__peerData).toBe(1);
			expect(chunks2[0].__peerData).toBe(2);
			expect(chunks3[0].__peerData).toBe(3);
		});

		it("should handle data exactly at MTU boundary", () => {
			const chunker = new BinaryPackChunker();
			const data = new ArrayBuffer(16300);

			const chunks = chunker.chunk(data);

			expect(chunks.length).toBe(1);
			expect(chunks[0].data.byteLength).toBe(16300);
		});

		it("should handle data slightly over MTU boundary", () => {
			const chunker = new BinaryPackChunker();
			const data = new ArrayBuffer(16301);

			const chunks = chunker.chunk(data);

			expect(chunks.length).toBe(2);
			expect(chunks[0].data.byteLength).toBe(16300);
			expect(chunks[1].data.byteLength).toBe(1);
		});

		it("should return empty array for zero-length data", () => {
			const chunker = new BinaryPackChunker();
			const data = new ArrayBuffer(0);

			const chunks = chunker.chunk(data);

			expect(chunks.length).toBe(0);
		});
	});
});

describe("concatArrayBuffers", () => {
	it("should concatenate multiple Uint8Arrays", () => {
		const buf1 = new Uint8Array([1, 2, 3]);
		const buf2 = new Uint8Array([4, 5]);
		const buf3 = new Uint8Array([6, 7, 8, 9]);

		const result = concatArrayBuffers([buf1, buf2, buf3]);

		expect(result).toBeInstanceOf(Uint8Array);
		expect(result.byteLength).toBe(9);
		expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("should handle empty array", () => {
		const result = concatArrayBuffers([]);

		expect(result.byteLength).toBe(0);
	});

	it("should handle single buffer", () => {
		const buf = new Uint8Array([10, 20, 30]);
		const result = concatArrayBuffers([buf]);

		expect(result.byteLength).toBe(3);
		expect(Array.from(result)).toEqual([10, 20, 30]);
	});

	it("should handle empty buffers", () => {
		const buf1 = new Uint8Array([]);
		const buf2 = new Uint8Array([1, 2]);
		const buf3 = new Uint8Array([]);

		const result = concatArrayBuffers([buf1, buf2, buf3]);

		expect(result.byteLength).toBe(2);
		expect(Array.from(result)).toEqual([1, 2]);
	});
});
