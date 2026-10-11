/* The radar session cache's observable rules (state/radar.svelte.ts), driven
 * the way MapView's ensure effect drives it: ensureRadar after every settle,
 * a stubbed proxy answering the index and the frames. What is pinned: the
 * age counts from the proxy's SERVE time (x-opera-now), not the listing's
 * own instant; a frame's failure stands as the error through its retry
 * minute rather than reading "loading" with nothing in flight; Refresh keeps
 * the frames on screen while the index is asked again; a product switch
 * discards the other product's answers in flight; each tile of an answer is
 * filed under its own index at its own byte count, framed by the head THAT
 * answer carried; the loop fits both tiers; a frame's head goes with its
 * listing; and a rate limit waits as long as the strictest refusal of the
 * incident asked. Every test starts from a module reset
 * (resetRadarForTest), so none depends on what an earlier one left: the
 * rate-limit cases run a timer under fake timers, and shuffled, the stamps
 * they left on the fake clock failed seventeen of the file's tests. */
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { display } from '$lib/state/display.svelte';
import { nav } from '$lib/state/navRecording.svelte';
import { ui } from '$lib/state/ui.svelte';
import {
	ensureRadar,
	radar,
	radarFeed,
	radarFrameHeld,
	radarLoop,
	radarHeadKeysForTest,
	radarIdleForTest,
	radarTileAt,
	refreshRadar,
	resetRadarForTest,
	setRadarLoop,
	setRadarProduct,
	setRadarShownFrame,
	setShowRadarOnMap,
	shownRadarFrame,
	type RadarView,
} from '$lib/state/radar.svelte';
import { OPERA_GRID, OPERA_GRID_2KM, type OperaGrid } from '$lib/weather/laea';
import {
	NODATA,
	OPERA_HEAD_BYTES,
	UNDETECT,
	decodedTileBytes,
	frameSlot,
	slotMs,
	type OperaProduct,
} from '$lib/weather/opera';

const TILE = 30;
const VIEW: RadarView = { product: 'DBZH', tiles: [TILE], p: 1 };
const RATE_VIEW: RadarView = { product: 'RATE', tiles: [9], p: 1 };
const MIN = 60_000;

/** One zlib-wrapped tile of the OPERA layout (512 x 512 Float32 pairs). */
const TILE_BYTES = new Uint8Array(deflateSync(Buffer.alloc(OPERA_GRID.tile * OPERA_GRID.tile * 2 * 4)));
/** The same tile of noise: incompressible, so it takes 2 MB in tier A, twenty
 *  times the product's p90 estimate (a rainy day's tile in the extreme). */
const BIG_TILE_BYTES = new Uint8Array(deflateSync(randomBytes(OPERA_GRID.tile * OPERA_GRID.tile * 2 * 4)));

/** The float every cell of tile `i` carries in object `version`: distinct
 *  per tile, so a tile filed under another's index decodes to the wrong
 *  value, and per version, so an answer cut by another object's head does. */
function rawValue(i: number, version: number): number {
	return (version === 1 ? 20 : 25) + i;
}

/** The stored cell tile `i` decodes to at pooling 1 (Int8 dBZ, Int16 tenths). */
function expectedCell(product: OperaProduct, i: number, version = 1): number {
	return product === 'RATE' ? rawValue(i, version) * 10 : rawValue(i, version);
}

const distinctCache = new Map<string, Uint8Array>();

/** Tile `i` of object `version`, zlib-wrapped: every cell `rawValue`, the
 *  first few hundred varied so each tile, and each version of it, has a byte
 *  count of its own (a client that cut every tile at the first one's count
 *  would read garbage). Cell 0 is always `rawValue` itself. */
function distinctTile(i: number, version: number): Uint8Array {
	const key = `${version}|${i}`;
	const hit = distinctCache.get(key);
	if (hit) {
		return hit;
	}
	const cells = OPERA_GRID.tile * OPERA_GRID.tile;
	const f = new Float32Array(cells * 2);
	const v = rawValue(i, version);
	const varied = i * 97 + (version === 1 ? 0 : 5000);
	for (let k = 0; k < cells; k++) {
		f[k * 2] = k < varied ? v + (k % 7) : v;
		f[k * 2 + 1] = 1;
	}
	const out = new Uint8Array(deflateSync(Buffer.from(f.buffer)));
	distinctCache.set(key, out);
	return out;
}

/** What each tile of a frame answer holds; tests that are about something
 *  else pin a single buffer for every tile. */
let tileBytesOf: (i: number) => Uint8Array = (i) => distinctTile(i, 1);

/** The 8 KB head the proxy prepends: a little-endian classic TIFF whose
 *  IFD0 states the grid's layout, tile i `tileBytesOf(i)` long. The head is
 *  the OBJECT's, the same whichever tiles an answer carries. */
function operaHead(grid: OperaGrid): Uint8Array {
	const tiles = grid.tileCount;
	const tags: [number, number, number[]][] = [
		[256, 4, [grid.cols]],
		[257, 4, [grid.rows]],
		[258, 3, [32, 32]],
		[259, 3, [8]],
		[277, 3, [2]],
		[317, 3, [1]],
		[322, 4, [512]],
		[323, 4, [512]],
		[324, 4, []],
		[325, 4, []],
		[339, 3, [3, 3]],
	];
	const ifdAt = 8;
	const ifdBytes = 2 + tags.length * 12 + 4;
	let valuesAt = ifdAt + ifdBytes;
	const dataAt = valuesAt + 2 * 4 * tiles + 4 * 2 * 2;
	const counts = Array.from({ length: tiles }, (_, i) => tileBytesOf(i).length);
	let at = dataAt;
	tags[8][2] = counts.map((n) => {
		const o = at;
		at += n;
		return o;
	});
	tags[9][2] = counts;
	const head = new Uint8Array(OPERA_HEAD_BYTES);
	const dv = new DataView(head.buffer);
	head[0] = 0x49;
	head[1] = 0x49;
	dv.setUint16(2, 42, true);
	dv.setUint32(4, ifdAt, true);
	dv.setUint16(ifdAt, tags.length, true);
	let e = ifdAt + 2;
	for (const [tag, type, values] of tags) {
		const size = type === 3 ? 2 : 4;
		dv.setUint16(e, tag, true);
		dv.setUint16(e + 2, type, true);
		dv.setUint32(e + 4, values.length, true);
		let p = e + 8;
		if (values.length * size > 4) {
			p = valuesAt;
			dv.setUint32(e + 8, valuesAt, true);
			valuesAt += values.length * size;
		}
		values.forEach((v, k) => {
			if (type === 3) dv.setUint16(p + k * 2, v, true);
			else dv.setUint32(p + k * 4, v, true);
		});
		e += 12;
	}
	return head;
}

/** The relay's answer: the head, then the tiles asked for in ascending
 *  order, each at its own byte count. */
function frameAnswer(tiles: number[], grid: OperaGrid): Response {
	const head = operaHead(grid);
	const parts = tiles.map((i) => tileBytesOf(i));
	const body = new Uint8Array(OPERA_HEAD_BYTES + parts.reduce((n, b) => n + b.length, 0));
	body.set(head, 0);
	let at = OPERA_HEAD_BYTES;
	for (const b of parts) {
		body.set(b, at);
		at += b.length;
	}
	return new Response(body, { status: 200 });
}

interface Proxy {
	/** The product the index lists (its frames answer on that grid). */
	product: OperaProduct;
	/** The slots the index lists, oldest first. */
	slots: string[];
	/** The listing's own instant and the serve time it is answered at. */
	listedAt: number;
	servedAt: number;
	/** Per-slot HTTP status for the frame route (200 by default). */
	frameStatus: Record<string, number>;
	/** Holds the index answer until released; `indexFail` rejects it then. */
	gate: Promise<void> | null;
	indexFail: boolean;
	/** Holds every frame answer until released. */
	frameGate: Promise<void> | null;
	/** Frame answers carry noise where the tiles should be. */
	corruptTiles: boolean;
	/** The Retry-After a 429 states, seconds (0 for none), and per slot. */
	retryAfter: number;
	retryAfterFor: Record<string, number>;
	calls: string[];
	/** The cache mode of each frame fetch, in call order. */
	cacheModes: string[];
}

const proxy: Proxy = {
	product: 'DBZH',
	slots: [],
	listedAt: 0,
	servedAt: 0,
	frameStatus: {},
	gate: null,
	indexFail: false,
	frameGate: null,
	corruptTiles: false,
	retryAfter: 0,
	retryAfterFor: {},
	calls: [],
	cacheModes: [],
};

function indexBody(): string {
	return JSON.stringify({
		product: proxy.product,
		frames: proxy.slots.map((t) => ({ t, bytes: 3_000_000, publishedAt: new Date(proxy.listedAt).toISOString() })),
		now: new Date(proxy.listedAt).toISOString(),
	});
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = new URL(String(input instanceof Request ? input.url : input));
	proxy.calls.push(url.pathname + url.search);
	if (url.pathname.endsWith('.tiff')) {
		proxy.cacheModes.push(init?.cache ?? 'default');
	}
	if (url.pathname === '/opera/frames') {
		if (proxy.gate) {
			await proxy.gate;
		}
		if (proxy.indexFail) {
			throw new TypeError('index down');
		}
		return new Response(indexBody(), {
			status: 200,
			headers: { 'content-type': 'application/json', 'x-opera-now': new Date(proxy.servedAt).toISOString() },
		});
	}
	const m = /^\/opera\/(\d{8}T\d{4})\/(DBZH|RATE)\.tiff$/.exec(url.pathname);
	if (!m) {
		return new Response('no', { status: 404 });
	}
	if (proxy.frameGate) {
		await proxy.frameGate;
	}
	const status = proxy.frameStatus[m[1]] ?? 200;
	if (status !== 200) {
		const ra = proxy.retryAfterFor[m[1]] ?? proxy.retryAfter;
		return new Response('boom', { status, headers: ra ? { 'retry-after': String(ra) } : {} });
	}
	const answer = frameAnswer(url.searchParams.get('tiles')!.split(',').map(Number), m[2] === 'RATE' ? OPERA_GRID_2KM : OPERA_GRID);
	if (!proxy.corruptTiles) {
		return answer;
	}
	const body = new Uint8Array(await answer.arrayBuffer());
	body.fill(0x5a, OPERA_HEAD_BYTES);
	return new Response(body, { status: 200 });
}

/** The settle for a test under vitest's fake timers. */
async function settleFake(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await vi.advanceTimersByTimeAsync(15);
	}
}

/** Fifteen-minute slots for a RATE index, oldest first. */
function rateSlots(now: number, n: number): string[] {
	return Array.from({ length: n }, (_, i) => frameSlot(now - (n - i) * 15 * MIN, 15));
}

/** Let the fetches, the decodes and their macrotasks settle: until the
 *  product shown has nothing in flight or queued (radarIdleForTest), a few
 *  macrotask turns at least and three seconds at most. Timed by the work
 *  rather than a fixed 180 ms, which a loaded machine overran. */
async function settle(): Promise<void> {
	const t0 = Date.now();
	for (let i = 0; ; i++) {
		await new Promise((r) => setTimeout(r, 15));
		if ((i >= 2 && radarIdleForTest()) || Date.now() - t0 > 3_000) {
			return;
		}
	}
}

/** Drive the ensure pass the way MapView's effect does until `done` holds
 *  (every frame fetched, every tile decoded), or give up after `ms`. */
async function driveUntil(v: RadarView, done: () => boolean, ms = 20_000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		ensureRadar(v, Date.now());
		if (done()) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 20));
	}
	return done();
}

/** Every view tile of every frame the loop offers, decoded and held at once. */
function loopHeldDecoded(v: RadarView): boolean {
	const { frames } = radarLoop();
	return frames.length > 0 && frames.every((f) => v.tiles.every((i) => radarTileAt(f.t, i, v.p) != null));
}

const store = new Map<string, string>();

beforeEach(() => {
	store.clear();
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, String(v));
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	});
	vi.stubGlobal('fetch', vi.fn(fakeFetch));
	display.liveWeather = true;
	ui.isMobile = false;
	tileBytesOf = (i) => distinctTile(i, 1);
	setRadarLoop(60);
	resetRadarForTest();
	// Back on DBZH, whichever product the last test left.
	setRadarProduct('RATE');
	setRadarProduct('DBZH');
	setShowRadarOnMap(true);
	const now = Date.now();
	proxy.product = 'DBZH';
	proxy.slots = [frameSlot(now - 15 * MIN), frameSlot(now - 10 * MIN)];
	proxy.listedAt = now;
	proxy.servedAt = now;
	proxy.frameStatus = {};
	proxy.gate = null;
	proxy.indexFail = false;
	proxy.frameGate = null;
	proxy.corruptTiles = false;
	proxy.retryAfter = 0;
	proxy.retryAfterFor = {};
	proxy.calls = [];
	proxy.cacheModes = [];
});

afterEach(async () => {
	nav.recording = false;
	setShowRadarOnMap(false);
	await settle();
	vi.unstubAllGlobals();
});

describe('the frames and their age', () => {
	it('fills the loop for the view and measures the age from the serve time', async () => {
		// The listing was built 50 s before it was served (an edge hit):
		// counting from the listing's own `now` would read every frame 50 s
		// younger than it is.
		proxy.listedAt = Date.now() - 50_000;
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('loading');
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('ok');
		expect(radar.loaded).toBe(2);
		expect(radar.wanted).toBe(2);
		expect(radarLoop().frames.map((f) => f.t)).toEqual(proxy.slots);
		expect(shownRadarFrame()!.t).toBe(proxy.slots[1]);
		const feed = radarFeed()!;
		expect(feed.newest.t).toBe(proxy.slots[1]);
		// From the serve time, not the listing's instant 50 s earlier.
		const fromServe = (proxy.servedAt - slotMs(proxy.slots[1])!) / MIN;
		expect(feed.ms / MIN).toBeGreaterThanOrEqual(fromServe);
		expect(feed.ms / MIN).toBeLessThan(fromServe + 0.1);
		expect(proxy.calls.filter((c) => c.startsWith('/opera/frames'))).toHaveLength(1);
	});
});

describe('off the composite', () => {
	it('offers no frame, so the strip says outside rather than reading one', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar({ product: 'DBZH', tiles: [], p: 1 }, Date.now());
		expect(radar.status).toBe('outside');
		expect(radarLoop().frames).toHaveLength(0);
		expect(shownRadarFrame()).toBeNull();
		// The index is still held: back over the composite the loop returns.
		ensureRadar(VIEW, Date.now());
		expect(radarLoop().frames).toHaveLength(2);
	});

	it('offers no frame when the map hands over no view at all, the path a pan off the grid takes', async () => {
		// MapView passes ensureRadar(null) when gridBoxOfBounds finds no cell
		// under the map (a pan to New York). The loop fell through to its
		// one-frame floor there and the strip read the newest European frame,
		// its age and "loading" over an empty map, the Weather tab saying
		// "outside" beside it.
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radarLoop().frames).toHaveLength(2);
		ensureRadar(null, Date.now());
		expect(radar.status).toBe('outside');
		expect(radarLoop().frames).toHaveLength(0);
		expect(shownRadarFrame()).toBeNull();
		ensureRadar(VIEW, Date.now());
		expect(radarLoop().frames).toHaveLength(2);
	});
});

describe('the tiles of an answer', () => {
	it('are filed each under its own index, at its own byte count, on both grids', async () => {
		// Five tiles of distinct content and distinct length in one answer: a
		// client that walked them out of order, or cut every one at the first
		// one's count, would decode another tile's cells here.
		const v: RadarView = { product: 'DBZH', tiles: [9, 10, 17, 18, 40], p: 1 };
		expect(await driveUntil(v, () => loopHeldDecoded(v))).toBe(true);
		for (const f of radarLoop().frames) {
			for (const i of v.tiles) {
				expect(radarTileAt(f.t, i, 1)![0], `DBZH tile ${i}`).toBe(expectedCell('DBZH', i));
			}
		}
		expect(radar.status).toBe('ok');
		proxy.product = 'RATE';
		proxy.slots = rateSlots(Date.now(), 2);
		setRadarProduct('RATE');
		const r: RadarView = { product: 'RATE', tiles: [0, 5, 6, 19], p: 1 };
		expect(await driveUntil(r, () => loopHeldDecoded(r))).toBe(true);
		for (const i of r.tiles) {
			expect(radarTileAt(proxy.slots[1], i, 1)![0], `RATE tile ${i}`).toBe(expectedCell('RATE', i));
		}
	}, 30_000);

	it('are cut by the head of the answer they came in, never one a previous answer left', async () => {
		// The object behind a slot changes between two answers (a
		// re-published frame, the browser's copy of an older cut): the second
		// answer's byte counts are its own, and the first one's tiles are the
		// old object's and go.
		const a: RadarView = { product: 'DBZH', tiles: [9], p: 1 };
		expect(await driveUntil(a, () => loopHeldDecoded(a))).toBe(true);
		const t = proxy.slots[1];
		expect(radarTileAt(t, 9, 1)![0]).toBe(expectedCell('DBZH', 9, 1));
		tileBytesOf = (i) => distinctTile(i, 2);
		const b: RadarView = { product: 'DBZH', tiles: [10], p: 1 };
		expect(await driveUntil(b, () => loopHeldDecoded(b))).toBe(true);
		expect(radarTileAt(t, 10, 1)![0]).toBe(expectedCell('DBZH', 10, 2));
		expect(radar.status).toBe('ok');
		// Back over both: tile 9 is fetched again, from the object the slot
		// now holds, so one frame is never drawn from two objects.
		const both: RadarView = { product: 'DBZH', tiles: [9, 10], p: 1 };
		expect(
			await driveUntil(both, () => loopHeldDecoded(both) && radarTileAt(t, 9, 1)![0] === expectedCell('DBZH', 9, 2)),
		).toBe(true);
		expect(radarTileAt(t, 10, 1)![0]).toBe(expectedCell('DBZH', 10, 2));
	}, 30_000);
});

describe('a tile that does not read', () => {
	it('is the frame\'s own failure, retried after the minute past the browser\'s cache, never at the ensure pace', async () => {
		proxy.corruptTiles = true;
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('error');
		expect(radar.error).not.toBeNull();
		expect(radar.loaded).toBe(0);
		const fetches = proxy.calls.filter((c) => c.includes('.tiff')).length;
		expect(fetches).toBe(2);
		// Further passes inside the minute fetch nothing (the bad copy sat in
		// the browser's cache: refetched at the debounce, it was inflated
		// twice a second for as long as the frame was in the loop).
		for (let i = 0; i < 4; i++) {
			ensureRadar(VIEW, Date.now());
			await settle();
		}
		expect(proxy.calls.filter((c) => c.includes('.tiff')).length).toBe(fetches);
		expect(proxy.cacheModes.every((m) => m === 'default')).toBe(true);
		// Past the minute, the retry bypasses the browser's cache once, and
		// a good answer clears the error.
		proxy.corruptTiles = false;
		ensureRadar(VIEW, Date.now() + 61_000);
		await settle();
		ensureRadar(VIEW, Date.now() + 61_000);
		expect(proxy.cacheModes.slice(-2)).toEqual(['reload', 'reload']);
		expect(radar.status).toBe('ok');
		expect(radar.error).toBeNull();
		expect(radar.loaded).toBe(2);
	});
});

describe('a frame that fails', () => {
	it('keeps the error on the status through its retry minute, then clears on the refetch', async () => {
		proxy.frameStatus[proxy.slots[1]] = 502;
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		// The ensure pass that follows the settle (fetchSeq in the app).
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('error');
		expect(radar.error).not.toBeNull();
		expect(radar.loaded).toBe(1);
		// Another pass with nothing in flight (the failure stamp holds the
		// frame back for a minute): the error stands, never "loading".
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('error');
		const frameCalls = proxy.calls.filter((c) => c.includes(proxy.slots[1])).length;
		ensureRadar(VIEW, Date.now() + 30_000);
		expect(proxy.calls.filter((c) => c.includes(proxy.slots[1])).length).toBe(frameCalls);
		// The proxy recovers: the retry after the minute fills the frame and
		// the status reads ok again.
		delete proxy.frameStatus[proxy.slots[1]];
		ensureRadar(VIEW, Date.now() + 61_000);
		await settle();
		ensureRadar(VIEW, Date.now() + 61_000);
		expect(radar.status).toBe('ok');
		expect(radar.error).toBeNull();
		expect(radar.loaded).toBe(2);
	});
});

describe('the heads', () => {
	it('are kept while their frame is listed, and go with it', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radarHeadKeysForTest().sort()).toEqual(proxy.slots.map((t) => `DBZH|${t}`).sort());
		// The oldest slot leaves the listing: its directory, about 9 KB,
		// was held for the session outside both budgets.
		const gone = proxy.slots[0];
		proxy.slots = [proxy.slots[1], frameSlot(Date.now() - 5 * MIN)];
		refreshRadar();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radarHeadKeysForTest()).not.toContain(`DBZH|${gone}`);
		expect(radarHeadKeysForTest()).toContain(`DBZH|${proxy.slots[0]}`);
	});
});

describe('Refresh', () => {
	it('keeps the frames on screen while the index is asked again', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(shownRadarFrame()).not.toBeNull();
		let release!: () => void;
		proxy.gate = new Promise<void>((r) => {
			release = r;
		});
		const newer = frameSlot(Date.now() - 5 * MIN);
		proxy.slots = [...proxy.slots, newer];
		refreshRadar();
		ensureRadar(VIEW, Date.now());
		expect(proxy.calls.filter((c) => c.startsWith('/opera/frames'))).toHaveLength(2);
		// In flight: the held index still answers, nothing blanks.
		expect(shownRadarFrame()).not.toBeNull();
		expect(radarFeed()).not.toBeNull();
		release();
		await settle();
		expect(radarFeed()!.newest.t).toBe(newer);
	});
});

describe('the loop cap', () => {
	it('is measured off the tiles held, so a rainy day never has the eviction and the refetch chase each other', async () => {
		// The phone budget (16 MB) and 2 MB tiles: the p90 estimate would
		// admit 144 frames, nine tenths of the budget hold six. Ten frames
		// listed.
		ui.isMobile = true;
		tileBytesOf = () => BIG_TILE_BYTES;
		const now = Date.now();
		proxy.slots = Array.from({ length: 10 }, (_, i) => frameSlot(now - (10 - i) * 5 * MIN));
		for (let pass = 0; pass < 12; pass++) {
			ensureRadar(VIEW, Date.now());
			await settle();
		}
		ensureRadar(VIEW, Date.now());
		const loop = radarLoop();
		expect(loop.capped).toBe(true);
		// The loop fits nine tenths of the phone's 16 MB tier-A budget at the
		// tiles' MEASURED size, and one more frame would not.
		const perFrame = BIG_TILE_BYTES.length;
		expect(loop.frames.length * perFrame).toBeLessThanOrEqual(16_000_000 * 0.9);
		expect((loop.frames.length + 1) * perFrame).toBeGreaterThan(16_000_000 * 0.9);
		expect(radar.loaded).toBe(loop.frames.length);
		expect(radar.status).toBe('ok');
		// Settled: further passes fetch nothing.
		const fetches = proxy.calls.filter((c) => c.includes('.tiff')).length;
		expect(fetches).toBeLessThanOrEqual(10);
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(proxy.calls.filter((c) => c.includes('.tiff')).length).toBe(fetches);
	}, 30_000);

	it('fits the DECODED tier as well, so the paint never evicts the frame it shows next', async () => {
		// The review's phone: a two-hour loop (25 frames) over five tiles at
		// pooling 1. The compressed tiles fit tier A many times over; decoded,
		// 25 x 5 x 262 144 bytes is 32.8 MB against a 32 MB tier, and the
		// eviction then took, beat after beat, the very frame the loop showed
		// next. Nine tenths of tier B hold 21 frames of five.
		ui.isMobile = true;
		setRadarLoop(120);
		const now = Date.now();
		proxy.slots = Array.from({ length: 25 }, (_, i) => frameSlot(now - (25 - i) * 5 * MIN));
		const v: RadarView = { product: 'DBZH', tiles: [9, 10, 11, 12, 13], p: 1 };
		const perFrame = v.tiles.length * decodedTileBytes('DBZH', 1);
		expect(25 * perFrame).toBeGreaterThan(32_000_000);
		expect(await driveUntil(v, () => loopHeldDecoded(v), 25_000)).toBe(true);
		const loop = radarLoop();
		expect(loop.capped).toBe(true);
		expect(loop.frames.length).toBe(Math.floor((32_000_000 * 0.9) / perFrame));
		expect(radar.frameCap).toBe(loop.frames.length);
		// Every frame the loop offers is held decoded at once: a play cycle
		// through all of them asks the decoder for nothing.
		for (const f of loop.frames) {
			for (const i of v.tiles) {
				expect(radarTileAt(f.t, i, 1), `${f.t} tile ${i}`).not.toBeNull();
			}
		}
	}, 30_000);
});

describe('a scrub', () => {
	it('holds on the ground and follows the arrivals in flight', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		await settle();
		setRadarShownFrame(proxy.slots[0]);
		expect(radar.shownT).toBe(proxy.slots[0]);
		// A new frame lands on the ground: the scrub holds.
		proxy.slots = [...proxy.slots, frameSlot(Date.now() - 5 * MIN)];
		refreshRadar();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radarFeed()!.newest.t).toBe(proxy.slots[2]);
		expect(radar.shownT).toBe(proxy.slots[0]);
		// In flight, a thumb brushed across the slider must not pin the
		// picture: the next arrival returns the strip to the newest.
		nav.recording = true;
		proxy.slots = [...proxy.slots, frameSlot(Date.now())];
		refreshRadar();
		ensureRadar(VIEW, Date.now());
		await settle();
		expect(radarFeed()!.newest.t).toBe(proxy.slots[3]);
		expect(radar.shownT).toBeNull();
	});
});

describe('a product switch', () => {
	it('discards the other product\'s index in flight', async () => {
		let release!: () => void;
		proxy.gate = new Promise<void>((r) => {
			release = r;
		});
		ensureRadar(VIEW, Date.now());
		setRadarProduct('RATE');
		release();
		await settle();
		expect(radarFeed()).toBeNull();
		expect(radar.status).not.toBe('error');
		expect(radar.product).toBe('RATE');
	});

	it('discards the other product\'s rejection in flight', async () => {
		// A timeout of the product before the switch is not the new
		// product's error.
		let release!: () => void;
		proxy.gate = new Promise<void>((r) => {
			release = r;
		});
		proxy.indexFail = true;
		ensureRadar(VIEW, Date.now());
		setRadarProduct('RATE');
		release();
		await settle();
		expect(radar.status).toBe('loading');
		expect(radar.error).toBeNull();
	});

	it('never lets the frames of the product before hold the new product\'s slots', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		let release!: () => void;
		proxy.frameGate = new Promise<void>((r) => {
			release = r;
		});
		// Two DBZH frames in flight, the module's whole allowance.
		ensureRadar(VIEW, Date.now());
		expect(proxy.calls.filter((c) => c.includes('DBZH.tiff'))).toHaveLength(2);
		proxy.frameGate = null;
		proxy.product = 'RATE';
		proxy.slots = rateSlots(Date.now(), 2);
		setRadarProduct('RATE');
		ensureRadar(RATE_VIEW, Date.now());
		await settle();
		ensureRadar(RATE_VIEW, Date.now());
		await settle();
		// RATE's own two fetched while DBZH's two still hang.
		expect(proxy.calls.filter((c) => c.includes('RATE.tiff'))).toHaveLength(2);
		ensureRadar(RATE_VIEW, Date.now());
		expect(radar.status).toBe('ok');
		release();
		await settle();
		ensureRadar(RATE_VIEW, Date.now());
		expect(radar.status).toBe('ok');
		expect(radar.loaded).toBe(2);
	});
});

describe('hidden', () => {
	it('discards a frame landing after the switch-off and holds nothing', async () => {
		ensureRadar(VIEW, Date.now());
		await settle();
		let release!: () => void;
		proxy.frameGate = new Promise<void>((r) => {
			release = r;
		});
		ensureRadar(VIEW, Date.now());
		setShowRadarOnMap(false);
		ensureRadar(VIEW, Date.now());
		expect(radar.status).toBe('idle');
		release();
		await settle();
		expect(radarFrameHeld(proxy.slots[1])).toBe(false);
		expect(radarFrameHeld(proxy.slots[0])).toBe(false);
		// Shown again, the frames are fetched afresh.
		const calls = proxy.calls.length;
		proxy.frameGate = null;
		setShowRadarOnMap(true);
		ensureRadar(VIEW, Date.now());
		await settle();
		ensureRadar(VIEW, Date.now());
		expect(proxy.calls.length).toBeGreaterThan(calls);
		expect(radar.status).toBe('ok');
		expect(radar.loaded).toBe(2);
	});
});

describe('the edge tiles', () => {
	it('mask the producer\'s padding past the grid on both products, at the call site', async () => {
		// All-zero tiles, which is what the producer pads with.
		tileBytesOf = () => TILE_BYTES;
		// DBZH tile 71, the last of the 1 km grid: 216 columns and 304 rows of
		// grid, the rest padding the producer fills with 0.0, which decodes
		// to a 0 dBZ VALUE and would beat no coverage under the pool.
		const v71: RadarView = { product: 'DBZH', tiles: [71], p: 1 };
		ensureRadar(v71, Date.now());
		await settle();
		ensureRadar(v71, Date.now());
		await settle();
		const t = radarTileAt(proxy.slots[1], 71, 1)!;
		expect(t).not.toBeNull();
		expect(t[0]).toBe(0);
		expect(t[215]).toBe(0);
		expect(t[216]).toBe(NODATA);
		expect(t[303 * 512]).toBe(0);
		expect(t[304 * 512]).toBe(NODATA);
		// RATE tile 19, the last of the 2 km grid: 364 columns and 152 rows;
		// a 0.0 rate is a dry cell, the padding no coverage.
		proxy.product = 'RATE';
		proxy.slots = rateSlots(Date.now(), 2);
		setRadarProduct('RATE');
		const v19: RadarView = { product: 'RATE', tiles: [19], p: 1 };
		ensureRadar(v19, Date.now());
		await settle();
		ensureRadar(v19, Date.now());
		await settle();
		const r = radarTileAt(proxy.slots[1], 19, 1)!;
		expect(r).not.toBeNull();
		expect(r[0]).toBe(UNDETECT);
		expect(r[363]).toBe(UNDETECT);
		expect(r[364]).toBe(NODATA);
		expect(r[151 * 512]).toBe(UNDETECT);
		expect(r[152 * 512]).toBe(NODATA);
	});
});

describe('a rate limit', () => {
	it('stands the fetches down behind a timer, keeps its notice across a product switch, and resumes when it fires', async () => {
		vi.useFakeTimers();
		try {
			const seq = radar.retrySeq;
			ensureRadar(VIEW, Date.now());
			await settleFake();
			// Both frames refused in the same pass, the proxy asking for two
			// minutes: ONE timer at the proxy's floor, not two doublings.
			proxy.frameStatus[proxy.slots[0]] = 429;
			proxy.frameStatus[proxy.slots[1]] = 429;
			proxy.retryAfter = 120;
			ensureRadar(VIEW, Date.now());
			await settleFake();
			expect(radar.status).toBe('error');
			expect(radar.error).not.toBeNull();
			expect(radar.error!()).toContain('busy');
			expect(radar.error!()).toContain('120');
			// The switch keeps the notice: the limit is the proxy's, whichever
			// product asked. (The refusals were DBZH's slots; a quarter-hour
			// RATE slot can spell the same key, so they are lifted here.)
			proxy.frameStatus = {};
			proxy.product = 'RATE';
			proxy.slots = rateSlots(Date.now(), 2);
			setRadarProduct('RATE');
			expect(radar.status).toBe('error');
			expect(radar.error).not.toBeNull();
			const before = proxy.calls.length;
			ensureRadar(RATE_VIEW, Date.now());
			expect(proxy.calls.length).toBe(before);
			// The timer is the sole path back to the network, and it is the
			// proxy's two minutes, not the module's own 66 s.
			await vi.advanceTimersByTimeAsync(66_000);
			expect(radar.retrySeq).toBe(seq);
			await vi.advanceTimersByTimeAsync(54_000);
			expect(radar.retrySeq).toBe(seq + 1);
			ensureRadar(RATE_VIEW, Date.now());
			await settleFake();
			ensureRadar(RATE_VIEW, Date.now());
			await settleFake();
			ensureRadar(RATE_VIEW, Date.now());
			expect(radar.status).toBe('ok');
			expect(radar.error).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('waits as long as the strictest refusal of the incident asked, whichever landed first', async () => {
		// Two frames refused in one pass: the newest (answered first) with no
		// Retry-After, the older with 300 s. Taking the first refusal's word
		// retried at the module's 66 s, into the window the proxy had asked
		// to be left alone; the notice read 66 too.
		for (const [first, second] of [
			[0, 300],
			[300, 0],
		]) {
			vi.useFakeTimers();
			try {
				// A fresh start per order (beforeEach's own reset): the frames
				// the previous order recovered are held and would not be asked.
				setRadarProduct('RATE');
				setRadarProduct('DBZH');
				ensureRadar(VIEW, Date.now());
				await settleFake();
				proxy.frameStatus[proxy.slots[0]] = 429;
				proxy.frameStatus[proxy.slots[1]] = 429;
				proxy.retryAfterFor = { [proxy.slots[1]]: first, [proxy.slots[0]]: second };
				const seq = radar.retrySeq;
				ensureRadar(VIEW, Date.now());
				await settleFake();
				expect(radar.status).toBe('error');
				expect(radar.error!(), `order ${first}, ${second}`).toContain('300');
				// Not at the module's own 66 s, whatever order the two came in.
				await vi.advanceTimersByTimeAsync(66_000);
				expect(radar.retrySeq, `order ${first}, ${second}`).toBe(seq);
				await vi.advanceTimersByTimeAsync(300_000 - 66_000);
				expect(radar.retrySeq).toBe(seq + 1);
				// Recovered, so the next incident starts from the module's floor.
				proxy.frameStatus = {};
				proxy.retryAfterFor = {};
				ensureRadar(VIEW, Date.now());
				await settleFake();
				ensureRadar(VIEW, Date.now());
				expect(radar.status).toBe('ok');
			} finally {
				vi.useRealTimers();
			}
		}
	});
});
