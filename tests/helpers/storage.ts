/* A whole in-memory Storage for the specs that need more than get / set /
 * remove: key(i) and length, which the prefix sweeps enumerate with
 * (state/persist.ts keysWithPrefix), and dump() to compare what is left.
 * Stub it with vi.stubGlobal('localStorage', memoryStorage(seed)). */

export type MemoryStorage = Storage & { dump: () => Record<string, string> };

export function memoryStorage(seed: Record<string, string> = {}): MemoryStorage {
	const store = new Map<string, string>(Object.entries(seed));
	return {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, String(v)),
		removeItem: (k: string) => void store.delete(k),
		key: (i: number) => [...store.keys()][i] ?? null,
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		dump: () => Object.fromEntries(store),
	};
}
