import { defineConfig } from "tsup";

export default defineConfig({
	entry: { "dendri-y": "src/index.ts" },
	format: ["esm", "cjs"],
	dts: true,
	sourcemap: true,
	clean: true,
	treeshake: true,
	external: ["yjs", "y-protocols", "y-protocols/awareness"],
});
