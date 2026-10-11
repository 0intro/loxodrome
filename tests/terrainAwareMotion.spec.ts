/* The terrain shading while the map moves (map/terrainAwareLayer.ts over
 * map/directDrawLayer.ts), on Leaflet itself in Node with a recording canvas
 * (tests/helpers/leafletNode.ts) and the tile cache standing on a store of
 * flat tiles the spec fills. What it pins:
 *   - at rest a painting is the viewport, each tile placed from the canvas's
 *     corner;
 *   - while the map moves, the newest painting covers the view at every frame,
 *     a lead on either side placed from the canvas's corner, and the settle
 *     repaints at rest, the canvas back to the viewport;
 *   - the level is held while the map moves where the viewport alone would
 *     step it, and taken afresh at the settle;
 *   - the legend counts the tiles on screen, never those of the lead;
 *   - the no-data dither stays anchored to the map under a lead;
 *   - a new reference makes every bitmap in reach again and is left out of
 *     the motion gate's average, while dear paints of its own close the gate;
 *   - following the aircraft, a re-centre paints at its settle only;
 *   - the warm asks for the view, the ground two levels up and the ring, in
 *     that order, and a drag past the ring draws that ground. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap, Point } from 'leaflet';
import { FakeCanvas, FakeContext2D, FakeElement, FakePattern, installLeafletNode, type DrawnImage } from './helpers/leafletNode';

/* The tile cache: the spec's store. `onPeek` runs at every peek (a clock to
 * make a paint dear). */
const T = vi.hoisted(() => ({
	tiles: new Map<string, unknown>(),
	failed: new Set<string>(),
	asked: [] as { z: number; x: number; y: number }[][],
	budget: 192,
	onPeek: null as (() => void) | null,
}));

vi.mock('$lib/map/terrain', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/map/terrain')>();
	const key = (z: number, x: number, y: number): string => {
		const n = 2 ** z;
		return `${z}/${((x % n) + n) % n}/${y}`;
	};
	return {
		...real,
		peekTile: (z: number, x: number, y: number) => {
			T.onPeek?.();
			const k = key(z, x, y);
			return T.tiles.has(k) ? T.tiles.get(k) : undefined;
		},
		terrainTileFailed: (z: number, x: number, y: number) => T.failed.has(key(z, x, y)),
		terrainTileDue: (z: number, x: number, y: number) => !T.tiles.has(key(z, x, y)) && !T.failed.has(key(z, x, y)),
		visitTiles: (tiles: readonly { z: number; x: number; y: number }[]) => {
			T.asked.push([...tiles]);
			return Promise.resolve({ visited: 0, missing: 0, sea: 0 });
		},
		terrainTileCacheStats: () => ({ decoded: T.tiles.size, budget: T.budget, failed: T.failed.size }),
	};
});

const env = installLeafletNode({ any3d: true, imageData: true });
const L = (await import('leaflet')).default;
const { buildTerrainAwareLayer, clearTerrainAwareLayer, setTerrainReference, setTerrainShadeListener, syncTerrainAwareLayer } = await import(
	'$lib/map/terrainAwareLayer'
);
const { setDrawOverscan } = await import('$lib/map/directDrawLayer');

const MAP_OPTIONS = {
	zoomControl: false,
	attributionControl: false,
	boxZoom: false,
	doubleClickZoom: false,
	dragging: false,
	keyboard: false,
	scrollWheelZoom: false,
	touchZoom: false,
	trackResize: false,
	fadeAnimation: false,
	zoomAnimation: false,
	markerZoomAnimation: false,
};

/** Ground a thousand metres up everywhere: every tile shades. */
const GROUND = new Int16Array(256 * 256).fill(1000);

/** The view's corners, projected. */
function corners(m: LeafletMap): { min: Point; max: Point } {
	const b = m.getPixelBounds();
	if (!b.min || !b.max) {
		throw new Error('the map has no view');
	}
	return { min: b.min, max: b.max };
}

/** A tile of that ground. */
function tileOf(z: number, x: number, y: number): unknown {
	return { z, tx: x, ty: y, mean: GROUND, max: GROUND, min: GROUND };
}

/** Hold every tile of `level` within `pad` tiles of the view, but those
 *  `skip` names. */
function hold(m: LeafletMap, level: number, pad: number, skip: (x: number, y: number) => boolean = () => false): void {
	const side = 256 * 2 ** (m.getZoom() - level);
	const b = corners(m);
	for (let y = Math.floor(b.min.y / side) - pad; y <= Math.floor(b.max.y / side) + pad; y++) {
		for (let x = Math.floor(b.min.x / side) - pad; x <= Math.floor(b.max.x / side) + pad; x++) {
			if (!skip(x, y)) {
				T.tiles.set(`${level}/${x}/${y}`, tileOf(level, x, y));
			}
		}
	}
}

const tick = (): Promise<void> => Promise.resolve();

/** Time a paint spends past the faked clock: each peek adds `peekMs` to what
 *  performance.now reads, firing no timer (one fired mid-paint would place
 *  the canvas anew under the paint). */
let extra = 0;
let peekMs = 0;

let map: LeafletMap | null = null;
let stats: { pending: number; failed: number; zoomedOut: boolean }[] = [];

/** The view's corner, projected, at the spec's place: where in its tile the
 *  view starts, on each axis. */
function startInTile(): { x: number; y: number } {
	const m = L.map(env.container(800, 600) as unknown as HTMLElement, MAP_OPTIONS).setView([45.9, 6.9], 11);
	const b = corners(m);
	m.remove();
	return { x: ((b.min.x % 256) + 256) % 256, y: ((b.min.y % 256) + 256) % 256 };
}

/** The shading on an 800 x 600 map at zoom 11 over the Alps, the reference
 *  at 300 ft, every tile of levels 9 to 11 in hand around the view unless
 *  `bare`; `at` puts the view's corner this far into its tile on an axis. */
async function mount({ bare = false, at = {} }: { bare?: boolean; at?: { x?: number; y?: number } } = {}): Promise<LeafletMap> {
	const m = L.map(env.container(800, 600) as unknown as HTMLElement, MAP_OPTIONS).setView([45.9, 6.9], 11);
	const was = startInTile();
	const nudge: [number, number] = [at.x === undefined ? 0 : at.x - was.x, at.y === undefined ? 0 : at.y - was.y];
	if (nudge[0] || nudge[1]) {
		m.panBy(nudge, { animate: false });
	}
	map = m;
	if (!bare) {
		for (const level of [9, 10, 11]) {
			hold(m, level, 6);
		}
	}
	setTerrainShadeListener((s) => stats.push(s));
	buildTerrainAwareLayer(m);
	setTerrainReference(300);
	syncTerrainAwareLayer(m, true);
	await tick();
	return m;
}

function canvas(m: LeafletMap): FakeCanvas {
	return (m.getPane('terrain-aware') as unknown as FakeElement).childNodes[0] as FakeCanvas;
}

interface Rect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** The newest painting: its images, and each one's place in layer points
 *  (through the transform it was drawn under, over the canvas's ratio),
 *  clipped to the canvas's CSS box (what the canvas shows of it). */
function newest(m: LeafletMap): { images: DrawnImage[]; rects: Rect[]; box: Rect } {
	const c = canvas(m);
	const at = (c as unknown as { _leaflet_pos: Point })._leaflet_pos;
	const cssW = parseFloat(c.style.width ?? '0');
	const box = { x0: at.x, y0: at.y, x1: at.x + cssW, y1: at.y + parseFloat(c.style.height ?? '0') };
	const r = c.width / cssW;
	const images = c.ctx.images.filter((i) => i.after === c.ctx.clears.length);
	const rects = images
		.map((i) => {
			const [a, , , d, e, f] = i.transform;
			const x = at.x + (a * i.dx + e) / r;
			const y = at.y + (d * i.dy + f) / r;
			return { x0: Math.max(box.x0, x), y0: Math.max(box.y0, y), x1: Math.min(box.x1, x + (a * i.dw) / r), y1: Math.min(box.y1, y + (d * i.dh) / r) };
		})
		.filter((q) => q.x0 < q.x1 && q.y0 < q.y1);
	return { images, rects, box };
}

/** The view in layer points. */
function view(m: LeafletMap): Rect {
	const tl = m.containerPointToLayerPoint([0, 0]);
	const s = m.getSize();
	return { x0: tl.x, y0: tl.y, x1: tl.x + s.x, y1: tl.y + s.y };
}

/** The points of `v`, every 8 px, no rect covers. */
function uncovered(v: Rect, rects: Rect[]): number {
	let n = 0;
	for (let y = v.y0 + 0.5; y < v.y1; y += 8) {
		for (let x = v.x0 + 0.5; x < v.x1; x += 8) {
			if (!rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) {
				n++;
			}
		}
	}
	return n;
}

/** One frame of a drag: the pane moved and a `move`, as Leaflet's drag does. */
async function frame(m: LeafletMap, dx: number, dy = 0): Promise<void> {
	vi.advanceTimersByTime(16);
	(m as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, dy));
	m.fire('move');
	await tick();
}

function startDrag(m: LeafletMap): void {
	vi.advanceTimersByTime(500);
	m.fire('movestart');
}

async function endDrag(m: LeafletMap): Promise<void> {
	m.fire('moveend');
	await tick();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
	const now = performance.now.bind(performance);
	extra = 0;
	peekMs = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => now() + extra);
	T.tiles.clear();
	T.failed.clear();
	T.asked.length = 0;
	T.budget = 192;
	T.onPeek = () => {
		extra += peekMs;
	};
	stats = [];
});
afterEach(() => {
	if (map) {
		clearTerrainAwareLayer(map);
		map.remove();
	}
	map = null;
	setTerrainShadeListener(null);
	setDrawOverscan(0);
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('the terrain shading while the map moves', () => {
	it('paints the viewport at rest, each tile placed from the canvas corner', async () => {
		env.window.devicePixelRatio = 2;
		const m = await mount();
		env.window.devicePixelRatio = 1;
		const c = canvas(m);
		expect([c.width, c.height]).toEqual([1600, 1200]);
		const { images, rects } = newest(m);
		// Zoom 11 draws level 11, 256 px a tile, under the ratio alone.
		expect(images.every((i) => i.dw === 256 && i.dh === 256)).toBe(true);
		expect(images.every((i) => i.transform.join() === '2,0,0,2,0,0')).toBe(true);
		expect(uncovered(view(m), rects)).toBe(0);
		// Each tile where its projected square is: the canvas corner plus its
		// offset, a multiple of the tile size in projected pixels.
		const origin = m.getPixelOrigin();
		const at = (c as unknown as { _leaflet_pos: Point })._leaflet_pos;
		for (const i of images) {
			expect((origin.x + at.x + i.dx) % 256).toBe(0);
			expect((origin.y + at.y + i.dy) % 256).toBe(0);
		}
		expect(stats.at(-1)).toEqual({ pending: 0, failed: 0, zoomedOut: false });
	});

	it('covers the view at every frame of a drag either way, and settles at rest', async () => {
		for (const dx of [12, -12, 0]) {
			const dy = dx === 0 ? 12 : 0;
			const m = await mount();
			const before = canvas(m).ctx.clears.length;
			startDrag(m);
			let wider = false;
			for (let f = 0; f < 30; f++) {
				await frame(m, dx, dy);
				const { rects, box } = newest(m);
				expect(uncovered(view(m), rects), `frame ${f} of ${dx},${dy}`).toBe(0);
				wider ||= box.x1 - box.x0 > 800 || box.y1 - box.y0 > 600;
			}
			// It painted while moving, ahead of the view.
			expect(canvas(m).ctx.clears.length - before).toBeGreaterThan(2);
			expect(wider).toBe(true);
			await endDrag(m);
			const c = canvas(m);
			expect([c.width, c.height]).toEqual([800, 600]);
			expect(uncovered(view(m), newest(m).rects)).toBe(0);
			clearTerrainAwareLayer(m);
			m.remove();
			map = null;
		}
	});

	it('holds its level while the map moves where the viewport alone would step it', async () => {
		// 35 tiles a warm: 4 x 3 tiles in view and their ring hold 30, a view
		// straddling one more row 36, one level coarser for the viewport.
		T.budget = 70;
		// Start 100 px into a row: three rows in view.
		const m = await mount({ at: { y: 100 } });
		expect(newest(m).images[0]?.dw).toBe(256);
		startDrag(m);
		const sides = new Set<number>();
		for (let f = 0; f < 10; f++) {
			// Down 12 px a frame: past 168 px into the row after six.
			await frame(m, 0, 12);
			for (const i of newest(m).images) {
				sides.add(i.dw);
			}
			expect(uncovered(view(m), newest(m).rects)).toBe(0);
		}
		expect([...sides]).toEqual([256]);
		await endDrag(m);
		// At rest the viewport's own level: one coarser, 512 px a tile.
		expect(new Set(newest(m).images.map((i) => i.dw))).toEqual(new Set([512]));
	});

	it('counts on the legend the tiles on screen, never those of the lead', async () => {
		// The view's right edge 26 px short of its tile's (800 px wide, so its
		// corner 198 px into one): a 20 px drag right stays on the tiles in
		// view, any lead past them is on tiles still loading.
		const m = await mount({ bare: true, at: { x: 198 } });
		const b = corners(m);
		const inView = (x: number, y: number): boolean => x * 256 < b.max.x && (x + 1) * 256 > b.min.x && y * 256 < b.max.y && (y + 1) * 256 > b.min.y;
		hold(m, 11, 1, (x, y) => !inView(x, y));
		hold(m, 10, 3);
		setTerrainReference(320);
		await tick();
		expect(stats.at(-1)?.pending).toBe(0);
		startDrag(m);
		let leadWanting = 0;
		for (let f = 0; f < 4; f++) {
			await frame(m, 5);
			const { images } = newest(m);
			// The lead's tiles are drawn from their ancestors (a 512 px tile's
			// quarter), and still loading.
			leadWanting = Math.max(leadWanting, images.filter((i) => i.sw === 128).length);
			expect(stats.at(-1)?.pending).toBe(0);
		}
		expect(leadWanting).toBeGreaterThan(0);
	});

	it('anchors the no-data dither to the map under a lead', async () => {
		const m = await mount({ bare: true });
		const b = corners(m);
		// Every level-11 tile failed: the whole extent dithers.
		for (let y = Math.floor(b.min.y / 256) - 3; y <= Math.floor(b.max.y / 256) + 3; y++) {
			for (let x = Math.floor(b.min.x / 256) - 4; x <= Math.floor(b.max.x / 256) + 4; x++) {
				T.failed.add(`11/${x}/${y}`);
			}
		}
		setTerrainReference(320);
		await tick();
		const phase = (): [number, number] => {
			const c = canvas(m);
			const fills = c.ctx.fills.filter((f) => f.after === c.ctx.clears.length);
			expect(fills.length).toBeGreaterThan(0);
			const p = fills[0].style as FakePattern;
			const t = p.transform as { e: number; f: number };
			const at = (c as unknown as { _leaflet_pos: Point })._leaflet_pos;
			const o = m.getPixelOrigin();
			// The pattern's cell starts on a multiple of 8 projected pixels.
			return [(((o.x + at.x + t.e) % 8) + 8) % 8, (((o.y + at.y + t.f) % 8) + 8) % 8];
		};
		expect(phase()).toEqual([0, 0]);
		expect(stats.at(-1)?.failed).toBeGreaterThan(0);
		startDrag(m);
		for (let f = 0; f < 6; f++) {
			await frame(m, -11);
			expect(phase()).toEqual([0, 0]);
		}
	});

	it('makes every bitmap in reach again for a new reference, which the motion gate leaves out', async () => {
		const m = await mount();
		// A cheap repaint at rest: the average is 0.
		m.fire('moveend');
		await tick();
		// A new reference, each peek now 4 ms: a paint of some 60 ms, at rest
		// (the canvas keeps its size, so only the reference sets it aside).
		peekMs = 4;
		setTerrainReference(500);
		await tick();
		peekMs = 0;
		// Left out of the average: a drag paints ahead. (Counted, it would have
		// taken the average past 8 ms, and the view past what was painted.)
		startDrag(m);
		const clears = canvas(m).ctx.clears.length;
		for (let f = 0; f < 24; f++) {
			await frame(m, 12);
			expect(uncovered(view(m), newest(m).rects)).toBe(0);
		}
		expect(canvas(m).ctx.clears.length - clears).toBeGreaterThan(1);
		// Mid-drag, another reference makes the bitmap of every tile in reach
		// again, the lead's included.
		const puts = FakeContext2D.puts;
		setTerrainReference(700);
		await tick();
		const { images } = newest(m);
		expect(FakeContext2D.puts - puts).toBe(images.length);
		expect(images.length).toBeGreaterThan(12);
		await endDrag(m);
	});

	it('paints at the settles only once its own paints are dear', async () => {
		const m = await mount();
		// Repaints of the same view and reference: some 40 ms each.
		peekMs = 2;
		for (let i = 0; i < 3; i++) {
			m.fire('moveend');
			await tick();
		}
		peekMs = 0;
		const clears = canvas(m).ctx.clears.length;
		startDrag(m);
		for (let f = 0; f < 12; f++) {
			await frame(m, 12);
		}
		expect(canvas(m).ctx.clears.length).toBe(clears);
		await endDrag(m);
		expect(canvas(m).ctx.clears.length).toBe(clears + 1);
	});

	it('asks for the view, the ground two levels up and the ring, in that order, and draws that ground past the ring', async () => {
		const m = await mount({ bare: true });
		vi.advanceTimersByTime(300);
		const asked = T.asked.at(-1) ?? [];
		const zs = asked.map((t) => t.z);
		const first = zs.indexOf(9);
		const last = zs.lastIndexOf(9);
		expect(first).toBeGreaterThan(0);
		expect(zs.slice(0, first).every((z) => z === 11)).toBe(true);
		expect(zs.slice(first, last + 1).every((z) => z === 9)).toBe(true);
		expect(zs.slice(last + 1).every((z) => z === 11)).toBe(true);
		expect(zs.length).toBeGreaterThan(last + 1);
		// What was asked lands, and nothing else: level 11 ends a tile past
		// the view.
		for (const t of asked) {
			T.tiles.set(`${t.z}/${t.x}/${t.y}`, tileOf(t.z, t.x, t.y));
		}
		m.fire('moveend');
		await tick();
		expect(uncovered(view(m), newest(m).rects)).toBe(0);
		startDrag(m);
		let standIns = 0;
		// 720 px east, past the ring.
		for (let f = 0; f < 60; f++) {
			await frame(m, 12);
			const { images, rects } = newest(m);
			expect(uncovered(view(m), rects), `frame ${f}`).toBe(0);
			// A level-11 tile drawn from the level-9 one: a quarter of a quarter.
			standIns = Math.max(standIns, images.filter((i) => i.sw === 64).length);
		}
		expect(standIns).toBeGreaterThan(0);
		await endDrag(m);
	});

	it('paints a re-centre at its settle only while the map follows the aircraft', async () => {
		const m = await mount();
		setDrawOverscan(96);
		const clears = canvas(m).ctx.clears.length;
		startDrag(m);
		for (let f = 0; f < 8; f++) {
			await frame(m, 2);
		}
		expect(canvas(m).ctx.clears.length).toBe(clears);
		await endDrag(m);
		expect(canvas(m).ctx.clears.length).toBe(clears + 1);
		expect([canvas(m).width, canvas(m).height]).toEqual([800, 600]);
	});
});
