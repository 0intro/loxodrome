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

/** Every terrain row, by the only thing that tells one from a map tile: its
 *  url. BOTH url shapes are matched, and the legacy one is the whole point:
 *  this runs on an upgrade, and a device arriving at v3 is a device that has
 *  only ever stored the terrain-RGB tiles the mosaic replaced, under
 *  `/tiles/terrarium/`. Matching our own `/terrain/` alone would make the
 *  sweep a no-op that leaves every unparseable row in place, and rows in
 *  `pinned` are exempt from the LRU, so they would never be reclaimed. The
 *  app no longer requests that path; devices may still be holding it. */
function dropTerrainRows(store: IDBObjectStore): void {
	const req = store.openCursor();
	req.onsuccess = () => {
		const cur = req.result;
		if (!cur) {
			return;
		}
		const url = typeof cur.primaryKey === 'string' ? cur.primaryKey : '';
		if (url.includes('/terrain/') || url.includes('/tiles/terrarium/')) {
			cur.delete();
		}
		cur.continue();
	};
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Forget the connection so the next call opens a fresh one. */
function forget(p: Promise<IDBDatabase>): void {
	if (dbPromise === p) {
		dbPromise = null;
	}
}

/** The database, opened once and kept while it stays open. Every read awaits
 *  it before the network (passiveFetchBlob), so it never waits on another
 *  tab: an open that a tab of an older version blocks fails, the reads going
 *  to the network, and this tab's connection closes for a newer version, as
 *  flightsDb's does. */
function db(): Promise<IDBDatabase> {
	if (dbPromise) {
		return dbPromise;
	}
	// A blocked open still succeeds once the other tab goes, handing over a
	// connection nobody holds: it is closed, or it would block the next
	// upgrade in turn.
	let gaveUp = false;
	const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, 3);
		req.onblocked = () => {
			gaveUp = true;
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			reject(new Error('indexeddb open blocked by another tab'));
		};
		req.onupgradeneeded = (ev) => {
			const d = req.result;
			if (!d.objectStoreNames.contains(STORE)) {
				const store = d.createObjectStore(STORE, { keyPath: 'url' });
				store.createIndex('ts', 'ts');
			}
			if (!d.objectStoreNames.contains(PINNED)) {
				d.createObjectStore(PINNED, { keyPath: 'url' });
			}
			// v3: the terrain tiles changed format under their own urls, so
			// every stored terrain row is bytes the reader can no longer
			// parse. They are DROPPED rather than migrated: there is nothing
			// to migrate a terrain-RGB PNG into, and a pilot who re-pins gets
			// a fifth the bytes for better ground. Map tiles share the LRU
			// and are left alone, which is why this is a cursor and not a
			// clear().
			if (ev.oldVersion > 0 && ev.oldVersion < 3) {
				const tx = req.transaction;
				if (tx) {
					dropTerrainRows(tx.objectStore(STORE));
					dropTerrainRows(tx.objectStore(PINNED));
				}
			}
		};
		req.onsuccess = () => {
			const d = req.result;
			if (gaveUp) {
				d.close();
				return;
			}
			d.onversionchange = () => {
				d.close();
				forget(opening);
			};
			d.onclose = () => {
				forget(opening);
			};
			resolve(d);
		};
		// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
		req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'));
	});
	// A failed open is not kept: the tab blocking it may go, and the next
	// read should find that out.
	dbPromise = opening;
	opening.catch(() => {
		forget(opening);
	});
	return opening;
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

/** A pin's row: a tile's row and the ETag its bytes were served with, so a
 *  pin run can ask the server whether the tile changed. The worker's 204, a
 *  copy promoted from the passive LRU and a row an earlier version wrote
 *  carry none, and a run reads those again whole. */
interface PinnedRow extends TileRow {
	etag?: string | undefined;
}

export async function pinnedPut(url: string, blob: Blob, etag: string | null = null): Promise<void> {
	const d = await db();
	await reqDone(
		d
			.transaction(PINNED, 'readwrite')
			.objectStore(PINNED)
			.put({ url, blob, ts: Date.now(), etag: etag ?? undefined } satisfies PinnedRow),
	);
}

/** Each pin's ETag by url, null where it holds none. */
export async function pinnedEtags(): Promise<Map<string, string | null>> {
	const tags = new Map<string, string | null>();
	try {
		const d = await db();
		const rows = await reqDone<PinnedRow[]>(
			d.transaction(PINNED).objectStore(PINNED).getAll() as IDBRequest<PinnedRow[]>,
		);
		for (const r of rows) {
			tags.set(r.url, r.etag ?? null);
		}
	} catch {
		/* absent store / private mode: no pins */
	}
	return tags;
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
/** What the passive LRU holds. Its own figure, not the pins': the two share
 *  a database and nothing else, and the manager has to be able to say which
 *  bytes are a promise and which are only a cache. */
export async function passiveStats(): Promise<{ count: number; bytes: number }> {
	const stats = { count: 0, bytes: 0 };
	try {
		const d = await db();
		const store = d.transaction(STORE).objectStore(STORE);
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
				c.continue();
			};
			// i18n-ignore: wire/internal diagnostic, stays EN (docs/i18n.md rule 7)
			cur.onerror = () => reject(cur.error ?? new Error('passive stats failed'));
		});
	} catch {
		/* absent store / private mode: zeros */
	}
	return stats;
}

/** Empty the passive LRU. The PINNED store is untouched: clearing a cache
 *  must never take the terrain a plan was promised. */
export async function passiveClear(): Promise<void> {
	try {
		const d = await db();
		await reqDone(d.transaction(STORE, 'readwrite').objectStore(STORE).clear());
	} catch {
		/* absent store / private mode: nothing to clear */
	}
}

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

/** A tile read's whole budget, headers and body. A socket a fading mobile
 *  link leaves open would otherwise hold its read for good, and with it one
 *  of the six connections every terrain read shares (map/terrain.ts): six
 *  such stalls held the shading, the alert's corridor, the ground under the
 *  aircraft and the route's MSA until the browser gave up on its own. A tile
 *  is 50 KB on average and 123 KB at most, so this is minutes of margin on a
 *  link that still moves. A read that runs out FAILS, and the terrain cache
 *  asks a failure again after its retry delay. */
export const TILE_FETCH_TIMEOUT_MS = 30_000;

/** fetch() the url within TILE_FETCH_TIMEOUT_MS, body included, or until
 *  `signal` aborts: the terrain reads, the map tiles of the Android shell's
 *  cached layers and the terrain pin job. The timer is the global setTimeout
 *  rather than AbortSignal.timeout, whose Node timer a spec's fake clock
 *  cannot advance. `init` is for the pin job, which asks about a pinned tile
 *  with a HEAD and reads a changed one again in 'reload', the mode the
 *  service worker's terrain rule leaves to the network (vite.config.ts). */
export async function fetchWithin(
	url: string,
	signal?: AbortSignal,
	init: { method?: 'GET' | 'HEAD'; cache?: RequestCache } = {},
): Promise<{ status: number; ok: boolean; blob: Blob | null; etag: string | null }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TILE_FETCH_TIMEOUT_MS);
	const stop = () => ctrl.abort();
	if (signal?.aborted) {
		ctrl.abort();
	}
	signal?.addEventListener('abort', stop, { once: true });
	try {
		const res = await fetch(url, {
			signal: ctrl.signal,
			method: init.method ?? 'GET',
			cache: init.cache ?? 'default',
		});
		return {
			status: res.status,
			ok: res.ok,
			blob: res.ok ? await res.blob() : null,
			etag: res.headers.get('ETag'),
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', stop);
	}
}

/** Fetch a tile blob with the offline stores in front: terrain pins first
 *  (both platforms; they are the guaranteed set), then on the Android shell
 *  network-refreshes-LRU with cache fallback; on the web a plain fetch (the
 *  service worker owns passive caching there).
 *
 *  Two outcomes a caller must be able to tell apart. A resolved null is an
 *  ANSWER: the server says it holds no such object (404; the tile worker
 *  states the same with an empty 204, which the decoder refuses). A REJECTION
 *  is a failure: nothing could be read (offline with no stored copy, a
 *  refused origin, a server error), which says nothing about the ground. The
 *  terrain cache remembers an answer for the session and asks a failure
 *  again later; conflating them used to leave a tile that failed once blank
 *  for the whole flight, where the terrain shading would have drawn it as
 *  open sea. */
export async function passiveFetchBlob(url: string): Promise<Blob | null> {
	const pinned = await pinnedGet(url);
	if (pinned) {
		return pinned;
	}
	if (!isNativeApp()) {
		const res = await fetchWithin(url);
		if (res.ok) {
			return res.blob;
		}
		if (res.status === 404) {
			return null;
		}
		// i18n-ignore: internal diagnostic, never displayed
		throw new Error(`tile fetch failed: HTTP ${res.status}`);
	}
	let res: { status: number; ok: boolean; blob: Blob | null } | null = null;
	try {
		res = await fetchWithin(url);
		if (res.ok && res.blob) {
			void cachePut(url, res.blob);
			return res.blob;
		}
		if (res.status === 404) {
			return null;
		}
	} catch {
		// Offline, the body failed mid-read, or the read timed out: the
		// stored copy below.
	}
	const cached = await cacheGet(url);
	if (cached) {
		return cached;
	}
	// i18n-ignore: internal diagnostic, never displayed
	throw new Error(`tile fetch failed${res ? `: HTTP ${res.status}` : ''}`);
}
