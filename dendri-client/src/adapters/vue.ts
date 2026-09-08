import { getCurrentScope, onScopeDispose, type ShallowRef, shallowRef } from "vue";
import type { DendriStore, DendriStoreSnapshot } from "../store";

/**
 * Subscribe a Vue setup scope to a Dendri store.
 *
 * ```vue
 * <script setup>
 * import { createDendriStore } from "@afterrealism/dendri-client";
 * import { useDendriStore } from "@afterrealism/dendri-client/vue";
 *
 * const store = createDendriStore({ url: "wss://signal.example.com" });
 * const snapshot = useDendriStore(store);
 * </script>
 *
 * <template>{{ snapshot.connectionState }}</template>
 * ```
 *
 * The ref updates on every store change and unsubscribes automatically when
 * the component (effect scope) is torn down.
 */
export function useDendriStore(store: DendriStore): Readonly<ShallowRef<DendriStoreSnapshot>> {
	const snapshot = shallowRef(store.getSnapshot());
	const unsubscribe = store.subscribe(() => {
		snapshot.value = store.getSnapshot();
	});
	if (getCurrentScope()) {
		onScopeDispose(unsubscribe);
	}
	return snapshot;
}
