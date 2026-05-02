import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
	define: {
		__VERSION__: JSON.stringify(version),
	},
	test: {
		environment: "jsdom",
		globals: true,
		setupFiles: ["./tests/setup.ts"],
		include: ["tests/**/*.spec.ts"],
		coverage: {
			provider: "v8",
			include: ["src/**"],
			reporter: ["text", "json", "html"],
		},
	},
});
