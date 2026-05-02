import { Dendri } from "../src/dendri";
import { createDendriStore } from "../src/store";

describe("required signaling server configuration", () => {
	it("throws when Dendri is constructed without a host", () => {
		expect(() => new Dendri()).toThrow("Dendri requires a signaling server host");
	});

	it("throws when Dendri is constructed with an empty host", () => {
		expect(() => new Dendri({ host: "" })).toThrow("Dendri requires a signaling server host");
	});

	it("allows an explicitly configured host", () => {
		const peer = new Dendri({ host: "localhost", port: 9876, secure: false, path: "/" });
		expect(peer.options.host).toBe("localhost");
		peer.destroy();
	});

	it("throws when a store joins without explicit Dendri options", () => {
		const store = createDendriStore();

		expect(() => store.join("room-1")).toThrow("Dendri requires a signaling server host");

		store.destroy();
	});
});
