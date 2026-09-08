import type { DendriStore, DendriStoreSnapshot } from "../store";

/** Svelte store contract (readable). Works with `$store` auto-subscription in Svelte 4 and 5. */
export interface SvelteReadable<T> {
	subscribe(run: (value: T) => void): () => void;
}

/**
 * Wrap a Dendri store in Svelte's store contract.
 *
 * ```svelte
 * <script>
 * import { createDendriStore } from "@afterrealism/dendri-client";
 * import { toSvelteStore } from "@afterrealism/dendri-client/svelte";
 *
 * const store = createDendriStore({ url: "wss://signal.example.com" });
 * const snapshot = toSvelteStore(store);
 * </script>
 *
 * {$snapshot.connectionState} — {$snapshot.peers.length} peers
 * ```
 *
 * Plain store contract — no Svelte compiler or dependency involved, so it
 * also works from `.js`/`.ts` modules and with Svelte 5 runes code via
 * `fromStore()` if preferred.
 */
export function toSvelteStore(store: DendriStore): SvelteReadable<DendriStoreSnapshot> {
	return {
		subscribe(run) {
			run(store.getSnapshot());
			return store.subscribe(() => run(store.getSnapshot()));
		},
	};
}
