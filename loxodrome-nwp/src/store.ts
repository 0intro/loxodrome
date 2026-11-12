/* The read path's view of the bucket: the published pointers (kept 30 s in
 * the isolate, the same copy the meta and the forecast read), opened
 * archives (an isolate LRU), and tile bytes through the zone's edge cache.
 * An archive key names immutable bytes (a run's block is written once), so
 * every cached range is valid until the bucket's retention deletes it,
 * after which no pointer names it. */

import { Archive } from './pmtiles.ts';
import { checkDescriptor, type Descriptor } from './archive.ts';
import { isPointer, type Pointer } from './pointer.ts';
import { ArchiveMissing, type Source, type TileRequest, type TileResult } from './forecast.ts';

/** The header, the root directory and the metadata fit here. */
const HEAD_BYTES = 64 * 1024;
/** Tiles of one archive this close are read in one request: an R2 round
 *  trip is about 80 ms from the edge, a tile 40 to 55 KB, and reading the
 *  bytes between two neighbours costs less than asking for both. */
const COALESCE_GAP = 384 * 1024;
const COALESCE_SPAN = 4 * 1024 * 1024;
/** Requests in flight at once: the Workers' simultaneous connections. */
const IN_FLIGHT = 6;
const POINTER_TTL_MS = 30_000;
const ARCHIVES_KEPT = 150;

interface Opened {
	archive: Archive;
	desc: Descriptor;
}

const pointers = new Map<string, { at: number; value: Promise<Pointer | null> }>();
const archives = new Map<string, Promise<Opened>>();

export interface Waiter {
	waitUntil(p: Promise<unknown>): void;
}

export class R2Source implements Source {
	private readonly bucket: R2Bucket;
	private readonly cache: Cache | null;
	private readonly origin: string;
	private readonly ctx: Waiter | null;
	/** R2 reads this request made, cache misses only. */
	reads = 0;

	constructor(bucket: R2Bucket, cache: Cache | null, origin: string, ctx: Waiter | null) {
		this.bucket = bucket;
		this.cache = cache;
		this.origin = origin;
		this.ctx = ctx;
	}

	pointer(model: string): Promise<Pointer | null> {
		const now = Date.now();
		const held = pointers.get(model);
		if (held && now - held.at < POINTER_TTL_MS) {
			return held.value;
		}
		const value = this.bucket.get(`latest/${model}.json`).then(async (obj) => {
			if (!obj) {
				return null;
			}
			const p: unknown = await obj.json();
			return isPointer(p) ? p : null;
		});
		pointers.set(model, { at: now, value });
		this.keep(value.catch(() => pointers.delete(model)));
		return value;
	}

	/** Keeps a promise other requests may await alive past this request's
	 *  end. The isolate's maps share an archive's opening and a pointer's
	 *  read with every request that asks while it is in flight, but the I/O
	 *  belongs to the request that started it: ended by a failure elsewhere
	 *  in its answer, or by its client going away (the client aborts its
	 *  route request on every edit), the runtime cancels that I/O, the
	 *  promise never settles, its catch never removes it, and every later
	 *  request needing it hangs (reproduced in workerd, 2026-10-07). */
	private keep(p: Promise<unknown>): void {
		this.ctx?.waitUntil(p.catch(() => undefined));
	}

	async descriptor(key: string): Promise<Descriptor> {
		return (await this.open(key)).desc;
	}

	async tile(key: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
		const { archive } = await this.open(key);
		// A leaf directory read is cached in the archive for every later
		// request: made through this request's source, kept alive like the
		// opening.
		const at = await archive.locate(z, x, y, (off, len) => {
			const p = this.range(key, off, len);
			this.keep(p);
			return p;
		});
		return at ? this.range(key, at.offset, at.length) : null;
	}

	private open(key: string): Promise<Opened> {
		let held = archives.get(key);
		if (held) {
			archives.delete(key);
			archives.set(key, held);
			return held;
		}
		held = (async () => {
			const head = await this.range(key, 0, HEAD_BYTES, true);
			const archive = await Archive.open(head, (off, len) => this.range(key, off, len));
			return { archive, desc: checkDescriptor(archive.metadata) };
		})();
		archives.set(key, held);
		this.keep(held.catch(() => archives.delete(key)));
		while (archives.size > ARCHIVES_KEPT) {
			archives.delete(archives.keys().next().value as string);
		}
		return held;
	}

	/** Several tiles at once, in the order asked: each from the edge cache
	 *  where it is there, the others read archive by archive, neighbours
	 *  together (COALESCE_GAP), the cache written once every read is in. A
	 *  missing archive answers `missing` for its tiles. */
	async tiles(reqs: readonly TileRequest[]): Promise<TileResult[]> {
		const out: TileResult[] = reqs.map(() => ({ payload: null }));
		const byKey = new Map<string, number[]>();
		reqs.forEach((r, i) => byKey.set(r.key, [...(byKey.get(r.key) ?? []), i]));
		const located: { i: number; key: string; offset: number; length: number }[] = [];
		await inPool([...byKey], IN_FLIGHT, async ([key, idx]) => {
			try {
				const { archive } = await this.open(key);
				for (const i of idx) {
					const r = reqs[i];
					const at = await archive.locate(r.z, r.x, r.y, (off, len) => {
						const p = this.range(key, off, len);
						this.keep(p);
						return p;
					});
					if (at) {
						located.push({ i, key, offset: at.offset, length: at.length });
					}
				}
			} catch (err) {
				if (!(err instanceof ArchiveMissing)) {
					throw err;
				}
				for (const i of idx) {
					out[i] = { missing: key };
				}
			}
		});
		// The edge cache first, a tile at a time (its keys are per tile, so
		// a later request for one of them finds it whatever it is read with).
		const misses: typeof located = [];
		await inPool(located, IN_FLIGHT, async (t) => {
			const hit = this.cache ? await this.cache.match(this.cacheKey(t.key, t.offset, t.length)) : undefined;
			if (hit) {
				out[t.i] = { payload: new Uint8Array(await hit.arrayBuffer()) };
			} else {
				misses.push(t);
			}
		});
		// Then the misses, neighbours in one ranged read.
		const spans: { key: string; start: number; end: number; tiles: typeof located }[] = [];
		for (const [key] of byKey) {
			const mine = misses.filter((t) => t.key === key).sort((a, b) => a.offset - b.offset);
			for (const t of mine) {
				const s = spans.at(-1);
				if (s && s.key === key && t.offset - s.end <= COALESCE_GAP && t.offset + t.length - s.start <= COALESCE_SPAN) {
					s.end = Math.max(s.end, t.offset + t.length);
					s.tiles.push(t);
				} else {
					spans.push({ key, start: t.offset, end: t.offset + t.length, tiles: [t] });
				}
			}
		}
		const puts: { key: string; bytes: Uint8Array }[] = [];
		await inPool(spans, IN_FLIGHT, async (s) => {
			const obj = await this.bucket.get(s.key, { range: { offset: s.start, length: s.end - s.start } });
			if (!obj) {
				for (const t of s.tiles) {
					out[t.i] = { missing: s.key };
				}
				return;
			}
			this.reads++;
			const b = new Uint8Array(await obj.arrayBuffer());
			if (b.length !== s.end - s.start) {
				throw new Error(`nwp: ${s.key} answered ${b.length} bytes of ${s.end - s.start} at ${s.start}`);
			}
			for (const t of s.tiles) {
				// A copy: the span's buffer is let go once its tiles are out.
				const bytes = b.slice(t.offset - s.start, t.offset - s.start + t.length);
				out[t.i] = { payload: bytes };
				puts.push({ key: this.cacheKey(t.key, t.offset, t.length), bytes });
			}
		});
		// The cache is written once the reads are in: a write in flight held
		// one of the six connections the reads needed.
		if (this.cache && puts.length > 0) {
			const cache = this.cache;
			const all = Promise.all(
				puts.map((p) => cache.put(p.key, new Response(p.bytes, { headers: { 'Cache-Control': 'public, max-age=604800, immutable' } }))),
			);
			if (this.ctx) {
				this.ctx.waitUntil(all);
			} else {
				await all;
			}
		}
		return out;
	}

	private cacheKey(key: string, offset: number, length: number): string {
		return `${this.origin}/__cache/${key}?r=${offset}-${length}`;
	}

	/** Bytes [offset, offset+length) of an object, through the edge cache;
	 *  `upTo` accepts fewer at the end of a short object (R2 cuts a range
	 *  running past the end; never a read of the object whole, which for a
	 *  block archive is 100 to 210 MB in a 128 MB isolate). */
	private async range(key: string, offset: number, length: number, upTo = false): Promise<Uint8Array> {
		const cacheKey = this.cacheKey(key, offset, length);
		if (this.cache) {
			const hit = await this.cache.match(cacheKey);
			if (hit) {
				return new Uint8Array(await hit.arrayBuffer());
			}
		}
		const obj = await this.bucket.get(key, { range: { offset, length } });
		if (!obj) {
			throw new ArchiveMissing(key);
		}
		this.reads++;
		const b = new Uint8Array(await obj.arrayBuffer());
		if (b.length !== length && !(upTo && b.length > 0)) {
			throw new Error(`nwp: ${key} answered ${b.length} bytes of ${length} at ${offset}`);
		}
		if (this.cache) {
			const put = this.cache.put(
				cacheKey,
				new Response(b, { headers: { 'Cache-Control': 'public, max-age=604800, immutable' } }),
			);
			if (this.ctx) {
				this.ctx.waitUntil(put);
			} else {
				await put;
			}
		}
		return b;
	}
}

/** Runs fn over the items, n at a time, every one settled before a failure
 *  is thrown (the read path's pool, for the same reason). */
async function inPool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let failure: { err: unknown } | null = null;
	const worker = async (): Promise<void> => {
		while (next < items.length && !failure) {
			try {
				await fn(items[next++]);
			} catch (err) {
				failure ??= { err };
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	if (failure) {
		throw (failure as { err: unknown }).err;
	}
}

/** Forgets the isolate's copies (tests). */
export function resetStoreCaches(): void {
	pointers.clear();
	archives.clear();
}
