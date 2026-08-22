/* The Android shell's passive tile cache (docs/offline-maps.md): a small
 * IndexedDB blob store in front of tile fetches, LRU-pruned to MAX_TILES
 * (~150 MB of typical raster tiles). The web app gets passive offline from
 * the Workbox service worker instead, so every entry point here degrades to
 * the plain network path off isNativeApp(); no double caching.
 *
 * Leaflet-free ON PURPOSE: terrain.ts (node-tested) reads through
 * passiveFetchBlob, while the Leaflet layer factory lives in
 * passiveTiles.ts on top of this store. */

import { isNativeApp } from '$lib/native/platform';

const DB_NAME = 'loxodrome-tiles';
const STORE = 'tiles';
const MAX_TILES = 3000;
/** Prune in batches so the count check isn't per-put. */
const PRUNE_SLACK = 100;

interface TileRow {
	url: string;
	blob: Blob;
	ts: number;
}

/** Route-corridor terrain pins (docs/offline-maps.md): same row shape,
 *  separate store, EXEMPT from the LRU prune. Both platforms read it (the
 *  web SW's terrain cache is LRU'd and guarantees nothing). */
const PINNED = 'pinned';

let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
	dbPromise ??= new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 2);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains(STORE)) {
				const store = d.createObjectStore(STORE, { keyPath: 'url' });
				store.createIndex('ts', 'ts');
			}
			if (!d.objectStoreNames.contains(PINNED)) {
				d.createObjectStore(PINNED, { keyPath: 'url' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
	});
	return dbPromise;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
	});
}

export async function cacheGet(url: string): Promise<Blob | null> {
	try {
		const d = await db();
		const row = await reqDone<TileRow | undefined>(
			d.transaction(STORE).objectStore(STORE).get(url) as IDBRequest<TileRow | undefined>,
		);
		if (row) {
			// LRU touch, fire-and-forget.
			row.ts = Date.now();
			void reqDone(d.transaction(STORE, 'readwrite').objectStore(STORE).put(row)).catch(
				() => {},
			);
			return row.blob;
		}
		return null;
	} catch {
		return null;
	}
}

export async function cachePut(url: string, blob: Blob): Promise<void> {
	try {
		const d = await db();
		await reqDone(
			d
				.transaction(STORE, 'readwrite')
				.objectStore(STORE)
				.put({ url, blob, ts: Date.now() } satisfies TileRow),
		);
		void prune(d);
	} catch {
		/* cache full / private mode: the map still works from the network */
	}
}

let pruning = false;
async function prune(d: IDBDatabase): Promise<void> {
	if (pruning) {
		return;
	}
	pruning = true;
	try {
		const count = await reqDone(d.transaction(STORE).objectStore(STORE).count());
		if (count <= MAX_TILES + PRUNE_SLACK) {
			return;
		}
		let toDrop = count - MAX_TILES;
		// A fresh transaction: the counting one may have auto-committed by now.
		const store = d.transaction(STORE, 'readwrite').objectStore(STORE);
		await new Promise<void>((resolve, reject) => {
			const cur = store.index('ts').openCursor();
			cur.onsuccess = () => {
				const c = cur.result;
				if (!c || toDrop <= 0) {
					resolve();
					return;
				}
				c.delete();
				toDrop--;
				c.continue();
			};
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			cur.onerror = () => reject(cur.error ?? new Error('prune failed'));
		});
	} catch {
		/* best effort */
	} finally {
		pruning = false;
	}
}

/** How many stale rows a prune pass would drop; the pure decision half of
 *  prune(), pinned by tests. */
export function pruneCount(count: number): number {
	return count <= MAX_TILES + PRUNE_SLACK ? 0 : count - MAX_TILES;
}

// --- Terrain pins ---------------------------------------------------------

export async function pinnedGet(url: string): Promise<Blob | null> {
	try {
		const d = await db();
		const row = await reqDone<TileRow | undefined>(
			d.transaction(PINNED).objectStore(PINNED).get(url) as IDBRequest<TileRow | undefined>,
		);
		return row?.blob ?? null;
	} catch {
		return null;
	}
}

export async function pinnedPut(url: string, blob: Blob): Promise<void> {
	const d = await db();
	await reqDone(
		d
			.transaction(PINNED, 'readwrite')
			.objectStore(PINNED)
			.put({ url, blob, ts: Date.now() } satisfies TileRow),
	);
}

export async function pinnedDrop(urls: readonly string[]): Promise<void> {
	if (urls.length === 0) {
		return;
	}
	const d = await db();
	const store = d.transaction(PINNED, 'readwrite').objectStore(PINNED);
	await Promise.all(urls.map((u) => reqDone(store.delete(u))));
}

export async function pinnedKeys(): Promise<Set<string>> {
	try {
		const d = await db();
		const keys = await reqDone(d.transaction(PINNED).objectStore(PINNED).getAllKeys());
		return new Set(keys.map(String));
	} catch {
		return new Set();
	}
}

/** Count, byte total and newest write of the pin set; the Route tab's
 *  status line is derived from this at boot (no localStorage, so pins
 *  survive "Reset application" like everything else offline). */
export async function pinnedStats(): Promise<{ count: number; bytes: number; newestTs: number }> {
	const stats = { count: 0, bytes: 0, newestTs: 0 };
	try {
		const d = await db();
		const store = d.transaction(PINNED).objectStore(PINNED);
		await new Promise<void>((resolve, reject) => {
			const cur = store.openCursor();
			cur.onsuccess = () => {
				const c = cur.result;
				if (!c) {
					resolve();
					return;
				}
				const row = c.value as TileRow;
				stats.count++;
				stats.bytes += row.blob.size;
				stats.newestTs = Math.max(stats.newestTs, row.ts);
				c.continue();
			};
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			cur.onerror = () => reject(cur.error ?? new Error('pinned stats failed'));
		});
	} catch {
		/* absent store / private mode: zeros */
	}
	return stats;
}

/** The passive LRU's copy of a tile, for promoting into the pin set
 *  without a refetch. */
export function lruPeek(url: string): Promise<Blob | null> {
	return cacheGet(url);
}

/** Fetch a tile blob with the offline stores in front: terrain pins first
 *  (both platforms; they are the guaranteed set), then on the Android shell
 *  network-refreshes-LRU with cache fallback; on the web a plain fetch (the
 *  service worker owns passive caching there). */
export async function passiveFetchBlob(url: string): Promise<Blob | null> {
	const pinned = await pinnedGet(url);
	if (pinned) {
		return pinned;
	}
	if (!isNativeApp()) {
		try {
			const res = await fetch(url);
			return res.ok ? await res.blob() : null;
		} catch {
			return null;
		}
	}
	try {
		const res = await fetch(url);
		if (res.ok) {
			const blob = await res.blob();
			void cachePut(url, blob);
			return blob;
		}
		return null;
	} catch {
		return cacheGet(url);
	}
}
