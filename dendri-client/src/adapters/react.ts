import { useSyncExternalStore } from "react";
import type { DendriStore, DendriStoreSnapshot } from "../store";

/**
 * Subscribe a React component to a Dendri store.
 *
 * ```tsx
 * import { createDendriStore } from "@afterrealism/dendri-client";
 * import { useDendriStore } from "@afterrealism/dendri-client/react";
 *
 * const store = createDendriStore({ url: "wss://signal.example.com" });
 *
 * function Room() {
 *   const { connectionState, peers } = useDendriStore(store);
 *   return <div>{connectionState} — {peers.length} peers</div>;
 * }
 * ```
 *
 * The component re-renders whenever the store changes. Snapshots are
 * referentially stable between changes, so this is safe for
 * `useSyncExternalStore` and React 18 concurrent rendering.
 */
export function useDendriStore(store: DendriStore): DendriStoreSnapshot {
	return useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.getSnapshot(),
		() => store.getSnapshot(),
	);
}
