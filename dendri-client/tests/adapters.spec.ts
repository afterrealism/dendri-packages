import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { effectScope } from "vue";
import { useDendriStore as useDendriStoreReact } from "../src/adapters/react";
import { toSvelteStore } from "../src/adapters/svelte";
import { useDendriStore as useDendriStoreVue } from "../src/adapters/vue";
import type { DendriStore, DendriStoreSnapshot } from "../src/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeStore = DendriStore & { _emit(): void; _listenerCount(): number };

/** Minimal stand-in exposing only what the adapters use: subscribe + getSnapshot. */
function fakeStore(): FakeStore {
	const listeners = new Set<() => void>();
	let snapshot = { peerCount: 0 } as unknown as DendriStoreSnapshot;

	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot() {
			return snapshot;
		},
		_emit() {
			snapshot = { ...snapshot, peerCount: snapshot.peerCount + 1 };
			for (const listener of listeners) listener();
		},
		_listenerCount() {
			return listeners.size;
		},
	} as unknown as FakeStore;
}

describe("framework adapters", () => {
	it("react: re-renders on store change and unsubscribes on unmount", () => {
		const store = fakeStore();
		let rendered: DendriStoreSnapshot | undefined;

		function Probe() {
			rendered = useDendriStoreReact(store);
			return null;
		}

		const root = createRoot(document.createElement("div"));
		act(() => root.render(createElement(Probe)));
		expect(rendered?.peerCount).toBe(0);

		act(() => store._emit());
		expect(rendered?.peerCount).toBe(1);

		act(() => root.unmount());
		expect(store._listenerCount()).toBe(0);
	});

	it("vue: ref tracks store changes and unsubscribes on scope dispose", () => {
		const store = fakeStore();
		const scope = effectScope();
		const snapshot = scope.run(() => useDendriStoreVue(store));

		expect(snapshot?.value.peerCount).toBe(0);
		store._emit();
		expect(snapshot?.value.peerCount).toBe(1);

		scope.stop();
		expect(store._listenerCount()).toBe(0);
	});

	it("vue: works outside an effect scope (manual cleanup via store.destroy path)", () => {
		const store = fakeStore();
		const snapshot = useDendriStoreVue(store);

		store._emit();
		expect(snapshot.value.peerCount).toBe(1);
	});

	it("svelte: store contract emits immediately, on change, and unsubscribes cleanly", () => {
		const store = fakeStore();
		const readable = toSvelteStore(store);
		const seen: number[] = [];

		const unsubscribe = readable.subscribe((s) => seen.push(s.peerCount));
		expect(seen).toEqual([0]);

		store._emit();
		expect(seen).toEqual([0, 1]);

		unsubscribe();
		store._emit();
		expect(seen).toEqual([0, 1]);
		expect(store._listenerCount()).toBe(0);
	});
});
