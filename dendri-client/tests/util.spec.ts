import { util } from "../src/util";

describe("util", () => {
	describe("#chunkedMTU", () => {
		it("should be 16300", () => {
			expect(util.chunkedMTU).toBe(16300);
		});
	});
});
