import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig([
	// ESM + CJS for bundlers/Node.js
	{
		entry: { dendri: "src/index.ts", store: "src/store.ts" },
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: true,
		clean: true,
		define: {
			__VERSION__: JSON.stringify(version),
		},
		// Bundle runtime deps so consumers don't hit CJS/ESM interop issues
		// under SvelteKit/Next.js SSR. The previous `external` list shipped
		// `import { EventEmitter } from "eventemitter3"` in our ESM output,
		// which Node refuses to resolve as a named export when eventemitter3
		// is loaded as CJS.
		noExternal: [
			"eventemitter3",
			"peerjs-js-binarypack",
			"@msgpack/msgpack",
			"webrtc-adapter",
		],
		treeshake: true,
	},
	// Browser global (IIFE) — minified
	{
		entry: { "dendri.min": "src/global.ts" },
		format: ["iife"],
		globalName: "dendri",
		minify: true,
		sourcemap: true,
		define: {
			__VERSION__: JSON.stringify(version),
		},
		noExternal: [/.*/],
		platform: "browser",
	},
	// Browser global (IIFE) — unminified (debugging)
	{
		entry: { "dendri.browser": "src/global.ts" },
		format: ["iife"],
		globalName: "dendri",
		minify: false,
		sourcemap: true,
		define: {
			__VERSION__: JSON.stringify(version),
		},
		noExternal: [/.*/],
		platform: "browser",
	},
	// MsgPack serializer (standalone ESM + CJS)
	{
		entry: { "serializer.msgpack": "src/dataconnection/StreamConnection/MsgPack.ts" },
		format: ["esm", "cjs"],
		dts: true,
		sourcemap: true,
		minify: true,
		define: {
			__VERSION__: JSON.stringify(version),
		},
		noExternal: [
			"@msgpack/msgpack",
			"eventemitter3",
			"peerjs-js-binarypack",
			"webrtc-adapter",
		],
	},
]);
