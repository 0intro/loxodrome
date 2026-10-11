/* The radar's canvas (map/radarLayer.ts over map/directDrawLayer.ts), on
 * Leaflet itself in Node with a recording canvas (tests/helpers/leafletNode.ts)
 * and a frame of synthetic tiles. What it pins:
 *   - the image is anchored to projected space: two paintings agree pixel for
 *     pixel where they overlap, wherever the canvas stood, a pane a drag left
 *     between two pixels included;
 *   - a pan builds only the index squares it brings in, and a painting of the
 *     same feed keeps the image before it, moved along, painting and putting
 *     only the bands the pan brought in: the image is, pixel for pixel, a
 *     whole paint of its rectangle; a new feed is painted whole;
 *   - the hover reads the projected pixel under the cursor: the class it
 *     names is the colour drawn there, on a pane between two pixels too;
 *   - the no-coverage labels sit on a lattice of projected pixels;
 *   - while the map moves, every painting is a whole paint of its rectangle
 *     and holds the view, the hover reads it mid-drag and after a settle it
 *     covers; the gate closes on dear paintings made while the map moves,
 *     those made for a settle or a new feed left out, and opens again a
 *     minute after the last painting in motion;
 *     the pooling is held through a drag and
 *     taken afresh at the settle; a new feed mid-drag paints whole; a hidden
 *     radar paints nothing. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap, Point } from 'leaflet';
import { BLENDED, FakeCanvas, installLeafletNode } from './helpers/leafletNode';

/* The index maps built, by size: the squares a painting reads, the single
 * pixels a hover reads. */
const B = vi.hoisted(() => ({ built: [] as { w: number; h: number }[] }));
vi.mock('$lib/weather/radarDecode', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/weather/radarDecode')>();
	return {
		...real,
		buildIndexMap: (...a: Parameters<typeof real.buildIndexMap>) => {
			B.built.push({ w: a[0].w, h: a[0].h });
			return real.buildIndexMap(...a);
		},
	};
});

const env = installLeafletNode({ any3d: true, raster: true });
const L = (await import('leaflet')).default;
const { buildRadarLayer, clearRadarLayer, radarSampleAtPixel, setRadarData, syncRadarLayer } = await import('$lib/map/radarLayer');
const { poolingAt } = await import('$lib/weather/opera');
const { rectMinus } = await import('$lib/map/canvasPlacement');
const { LUT_OFFSET, NODATA, OPERA_PRODUCT_INFO, buildPaint, hexRgba, NO_COVERAGE_COLOR } = await import('$lib/weather/opera');
const { buildIndexMap, paintFrame } = await import('$lib/weather/radarDecode');
type RadarCells = Int8Array | Int16Array;

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

const PAINT = buildPaint('DBZH');

/** A DBZH frame whose pooled cells hold 20 to 49 dBZ, neighbours
 *  differing, under the Level 6 texture, one in 17 no coverage (the hatch:
 *  translucent pixels and clear ones); `blank` makes it all no coverage, and
 *  `shift` moves every value along (another frame). */
function frame(blank = false, shift = 0): (t: string, tile: number, p: number) => RadarCells {
	const kept = new Map<string, Int8Array>();
	return (_t, tile, p) => {
		extra += readMs;
		const key = `${tile}|${p}`;
		let a = kept.get(key);
		if (!a) {
			const w = 512 / p;
			a = new Int8Array(w * w);
			for (let i = 0; i < a.length; i++) {
				a[i] = blank || i % 17 === 0 ? NODATA : 20 + ((tile * 7 + (i % w) * 13 + Math.floor(i / w) * 5 + shift) % 30);
			}
			kept.set(key, a);
		}
		return a;
	};
}

const tick = (): Promise<void> => Promise.resolve();

let map: LeafletMap | null = null;

/** The feed the layer is handed: a new one is a new feed. */
let tiles = frame();
function feed(): void {
	setRadarData({ product: 'DBZH', frameKey: 'f', tileAt: tiles, opacity: 0.7, coverage: true, noCoverageLabel: 'none here' });
}

/** Each tile read costs this much, ms, on the clock a paint is timed by. */
let readMs = 0;
let extra = 0;

/** The radar on a map at zoom 8 over Germany, 400 x 300 unless named. */
async function mount(blank = false, [w, h] = [400, 300], at: [number, number, number] = [51, 10, 8]): Promise<LeafletMap> {
	const m = L.map(env.container(w, h) as unknown as HTMLElement, MAP_OPTIONS).setView([at[0], at[1]], at[2]);
	map = m;
	buildRadarLayer(m);
	tiles = frame(blank);
	feed();
	syncRadarLayer(m, true);
	await tick();
	return m;
}

interface Layer {
	_canvas: FakeCanvas;
	_radarFront: FakeCanvas;
	painted(): { x: number; y: number; w: number; h: number; zoom: number; p: number };
}

function layerOf(m: LeafletMap): Layer {
	const all = Object.values((m as unknown as { _layers: Record<string, { paneName?: string }> })._layers);
	return all.find((l) => l.paneName === 'radar') as unknown as Layer;
}

/** The newest image, the canvas in front: its pixels (a copy) and its
 *  rectangle of projected pixels. */
function image(m: LeafletMap): { px: Uint32Array; x: number; y: number; w: number; h: number } {
	const l = layerOf(m);
	const r = l.painted();
	return { px: (l._radarFront.pixels ?? new Uint32Array(0)).slice(), x: r.x, y: r.y, w: r.w, h: r.h };
}

/** A whole paint of the newest image's rectangle, from nothing: what the
 *  image must be pixel for pixel. */
function reference(m: LeafletMap): Uint32Array {
	const r = layerOf(m).painted();
	const index = buildIndexMap({ ...r }, r.p, OPERA_PRODUCT_INFO.DBZH.grid);
	const out = { data: new Uint32Array(r.w * r.h), x: r.x, y: r.y, w: r.w, h: r.h };
	paintFrame(out, index, r, (i) => tiles('f', i, r.p), PAINT, hexRgba(NO_COVERAGE_COLOR, 110));
	return out.data;
}

/** Pixels of the newest image differing from a whole paint of it. */
function wrong(m: LeafletMap): number {
	const img = image(m);
	const ref = reference(m);
	let n = 0;
	for (let i = 0; i < ref.length; i++) {
		if (img.px[i] !== ref[i] || img.px[i] === BLENDED) {
			n++;
		}
	}
	return n;
}

/** The area put on the canvas in front by its newest painting. */
function putArea(m: LeafletMap, from: number): number {
	return layerOf(m)._radarFront.ctx.putData.slice(from).reduce((a, p) => a + p.dirty.w * p.dirty.h, 0);
}

/** Pixels of `a` and `b` disagreeing where both hold them, and how many
 *  both hold. */
function disagreeing(a: ReturnType<typeof image>, b: ReturnType<typeof image>): { bad: number; both: number } {
	let bad = 0;
	let both = 0;
	for (let y = Math.max(a.y, b.y); y < Math.min(a.y + a.h, b.y + b.h); y++) {
		for (let x = Math.max(a.x, b.x); x < Math.min(a.x + a.w, b.x + b.w); x++) {
			both++;
			if (a.px[(y - a.y) * a.w + (x - a.x)] !== b.px[(y - b.y) * b.w + (x - b.x)]) {
				bad++;
			}
		}
	}
	return { bad, both };
}

/** The view in projected pixels. */
function viewRect(m: LeafletMap): { x: number; y: number; w: number; h: number } {
	const o = m.getPixelOrigin();
	const tl = m.containerPointToLayerPoint([0, 0]);
	const s = m.getSize();
	return { x: o.x + tl.x, y: o.y + tl.y, w: s.x, h: s.y };
}

/** Whether the newest painting holds the view. */
function holds(m: LeafletMap): boolean {
	const r = layerOf(m).painted();
	const v = viewRect(m);
	return v.x >= r.x && v.y >= r.y && v.x + v.w <= r.x + r.w && v.y + v.h <= r.y + r.h;
}

/** Hover reads checked against the colour under the cursor: how many. */
function hoverReads(m: LeafletMap): number {
	const img = image(m);
	const o = m.getPixelOrigin();
	let read = 0;
	for (let cy = 3.25; cy < m.getSize().y; cy += 19.7) {
		for (let cx = 1.5; cx < m.getSize().x; cx += 13.3) {
			const s = radarSampleAtPixel(cx, cy);
			if (s?.kind !== 'echo' || s.value === null) {
				continue;
			}
			const at = m.containerPointToLayerPoint([cx, cy]);
			const x = Math.floor(o.x + at.x);
			const y = Math.floor(o.y + at.y);
			expect(img.px[(y - img.y) * img.w + (x - img.x)], `${cx}, ${cy}`).toBe(PAINT.lut[s.value + LUT_OFFSET]);
			read++;
		}
	}
	return read;
}

function startDrag(m: LeafletMap): void {
	vi.advanceTimersByTime(500);
	m.fire('movestart');
}

/** One frame of a drag: the pane moved and a `move`, as Leaflet's drag does. */
async function frameStep(m: LeafletMap, dx: number, dy = 0): Promise<void> {
	vi.advanceTimersByTime(16);
	(m as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, dy));
	m.fire('move');
	await tick();
}

/** Move the map pane by `dx`, `dy` (fractions allowed, as a drag does) and
 *  settle there. */
async function pan(m: LeafletMap, dx: number, dy: number): Promise<void> {
	(m as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(dx, dy));
	m.fire('moveend');
	await tick();
}

beforeEach(() => {
	B.built.length = 0;
	readMs = 0;
});
afterEach(() => {
	if (map) {
		clearRadarLayer(map);
		map.remove();
	}
	map = null;
	env.window.devicePixelRatio = 1;
});

describe('what a painting still has to paint', () => {
	it('is the bands of the new rectangle outside the old, without overlap', () => {
		const a = { x: 10, y: 20, w: 100, h: 50 };
		expect(rectMinus(a, a)).toEqual([]);
		expect(rectMinus(a, { x: 500, y: 20, w: 10, h: 10 })).toEqual([a]);
		// Moved right and down: a band below across, a band right beside.
		expect(rectMinus(a, { x: -5, y: 5, w: 100, h: 50 })).toEqual([
			{ x: 10, y: 55, w: 100, h: 15 },
			{ x: 95, y: 20, w: 15, h: 35 },
		]);
		// Inside: four bands, their areas summing to what is left.
		const bands = rectMinus(a, { x: 30, y: 30, w: 20, h: 10 });
		expect(bands).toHaveLength(4);
		expect(bands.reduce((s, r) => s + r.w * r.h, 0)).toBe(100 * 50 - 20 * 10);
	});
});

describe('the radar canvas', () => {
	it('paints the same pixels where two paintings overlap, wherever the canvas stood', async () => {
		const m = await mount();
		const first = image(m);
		expect([first.w, first.h]).toEqual([400, 300]);
		await pan(m, 37, -23);
		const second = image(m);
		const a = disagreeing(first, second);
		expect(a.both).toBeGreaterThan(80_000);
		expect(a.bad).toBe(0);
		// A pane between two pixels: the image starts at the one before the
		// canvas's corner, a pixel wider and taller, drawn the fraction back.
		await pan(m, 10.6, 5.7);
		const third = image(m);
		expect([third.w, third.h]).toEqual([401, 301]);
		const b = disagreeing(first, third);
		expect(b.both).toBeGreaterThan(80_000);
		expect(b.bad).toBe(0);
		// The view moved 10.6 and 5.7 px: its corner is that far into a pixel.
		const c = layerOf(m)._canvas.ctx.images.at(-1);
		expect(c?.dx).toBeCloseTo(-0.6, 9);
		expect(c?.dy).toBeCloseTo(-0.7, 9);
	});

	it('keeps the image before it, painting only the bands a pan brings in, and a new feed whole', async () => {
		const m = await mount();
		expect(wrong(m)).toBe(0);
		// Whole pixels twice (the canvas behind is reused at its size, holding
		// the painting before last), then a fraction (it is resized).
		for (const [dx, dy] of [
			[37, -23],
			[12, 9],
			[-120.6, 41.3],
			[0, 90],
		]) {
			const before = layerOf(m).painted();
			// The canvas the painting is made in is the one behind: count its
			// puts from now.
			const back = (layerOf(m) as unknown as { _radarBack: FakeCanvas | null })._radarBack;
			const from = back ? back.ctx.putData.length : 0;
			await pan(m, dx, dy);
			const after = layerOf(m).painted();
			expect(wrong(m), `${dx}, ${dy}`).toBe(0);
			const bands = rectMinus(after, before).reduce((a, r) => a + r.w * r.h, 0);
			if (back) {
				expect(putArea(m, from)).toBe(bands);
				expect(bands).toBeLessThan((after.w * after.h) / 2);
			}
		}
		// A new feed: the image painted whole, and still right.
		tiles = frame(false, 3);
		const from = ((layerOf(m) as unknown as { _radarBack: FakeCanvas | null })._radarBack?.ctx.putData.length) ?? 0;
		feed();
		await tick();
		const r = layerOf(m).painted();
		expect(putArea(m, from)).toBe(r.w * r.h);
		expect(wrong(m)).toBe(0);
	});

	it('builds only the index squares a pan brings in', async () => {
		const m = await mount();
		const squares = B.built.filter((b) => b.w === 64).length;
		// 400 x 300 from wherever it starts: 7 or 8 columns, 5 or 6 rows.
		expect(squares).toBeGreaterThanOrEqual(35);
		B.built.length = 0;
		await pan(m, 30, 0);
		// One more column at most.
		expect(B.built.filter((b) => b.w === 64).length).toBeLessThanOrEqual(6);
	});

	it('names in the hover the colour drawn under the cursor, on a pane between two pixels too', async () => {
		const m = await mount();
		for (const [dx, dy] of [
			[0, 0],
			[12.6, -7.3],
		]) {
			await pan(m, dx, dy);
			const img = image(m);
			const o = m.getPixelOrigin();
			let read = 0;
			for (let cy = 3.25; cy < 300; cy += 9.7) {
				for (let cx = 1.5; cx < 400; cx += 7.3) {
					const s = radarSampleAtPixel(cx, cy);
					if (s?.kind !== 'echo' || s.value === null) {
						continue;
					}
					const at = m.containerPointToLayerPoint([cx, cy]);
					const x = Math.floor(o.x + at.x);
					const y = Math.floor(o.y + at.y);
					expect(img.px[(y - img.y) * img.w + (x - img.x)], `${cx}, ${cy}`).toBe(PAINT.lut[s.value + LUT_OFFSET]);
					read++;
				}
			}
			expect(read).toBeGreaterThan(1000);
		}
	});

	it('labels no coverage on a lattice of projected pixels', async () => {
		// 800 x 600: the 360 px lattice has points in view wherever it stands.
		const m = await mount(true, [800, 600]);
		const where = (): number[][] => {
			const c = layerOf(m)._canvas;
			const at = (c as unknown as { _leaflet_pos: Point })._leaflet_pos;
			const o = m.getPixelOrigin();
			return c.ctx.texts.filter((t) => t.after === c.ctx.clears.length && t.how === 'fill').map((t) => [o.x + at.x + t.x - 0.5, o.y + at.y + t.y - 0.5]);
		};
		await pan(m, 0, 0);
		const before = where();
		expect(before.length).toBeGreaterThan(0);
		await pan(m, 151, 77);
		const after = where();
		expect(after.length).toBeGreaterThan(0);
		for (const [x, y] of [...before, ...after]) {
			expect(((x % 360) + 360) % 360).toBe(180);
			expect(((y % 360) + 360) % 360).toBe(180);
		}
	});
});

describe('the radar canvas while the map moves', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		const now = performance.now.bind(performance);
		extra = 0;
		vi.spyOn(performance, 'now').mockImplementation(() => now() + extra);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('paints ahead of a drag either way, every painting a whole paint of its rectangle holding the view', async () => {
		for (const [dx, dy] of [
			[11, 0],
			[-11, 0],
			[0, 9],
		]) {
			const m = await mount();
			const before = layerOf(m)._canvas.ctx.clears.length;
			startDrag(m);
			let wider = false;
			for (let f = 0; f < 30; f++) {
				await frameStep(m, dx, dy);
				expect(holds(m), `frame ${f} of ${dx}, ${dy}`).toBe(true);
				expect(wrong(m), `frame ${f} of ${dx}, ${dy}`).toBe(0);
				const r = layerOf(m).painted();
				wider ||= r.w > 401 || r.h > 301;
			}
			expect(layerOf(m)._canvas.ctx.clears.length - before).toBeGreaterThan(2);
			expect(wider).toBe(true);
			// The hover reads the painting mid-drag.
			expect(hoverReads(m)).toBeGreaterThan(200);
			// A settle the painting covers paints nothing; the hover still reads it.
			const clears = layerOf(m)._canvas.ctx.clears.length;
			m.fire('moveend');
			await tick();
			expect(layerOf(m)._canvas.ctx.clears.length).toBe(clears);
			expect(hoverReads(m)).toBeGreaterThan(200);
			clearRadarLayer(m);
			m.remove();
			map = null;
		}
	});

	it('paints at the settles only once its paintings in motion are dear, the others left out, and tries again a minute on', async () => {
		const m = await mount();
		/** A drag of `n` frames: how many paintings it made. */
		const drag = async (n: number, dx: number): Promise<number> => {
			startDrag(m);
			const before = layerOf(m)._canvas.ctx.clears.length;
			for (let f = 0; f < n; f++) {
				await frameStep(m, dx);
			}
			return layerOf(m)._canvas.ctx.clears.length - before;
		};
		const settle = async (): Promise<void> => {
			m.fire('moveend');
			await tick();
		};
		// A cheap drag: paintings in motion, the newest a moment ago.
		expect(await drag(10, 11)).toBeGreaterThan(0);
		await settle();
		// Dear, and left out, none painted for a move: a new feed painted
		// whole, a settle repainting most of its image (250 px of 400, what a
		// drag the radar did not follow leaves), a settle repainting a band,
		// and a new feed mid-drag.
		readMs = 30;
		tiles = frame(false, 1);
		feed();
		await tick();
		await pan(m, 250, 0);
		await pan(m, 30, 0);
		startDrag(m);
		await frameStep(m, 11);
		tiles = frame(false, 2);
		feed();
		await tick();
		readMs = 0;
		await settle();
		// The gate is open: a drag paints.
		expect(await drag(10, -11)).toBeGreaterThan(0);
		await settle();
		// Paintings in motion, dear: the gate closes (once the lead has stopped
		// growing, a painting sizing the canvas being left out too).
		readMs = 30;
		await drag(30, 11);
		expect((layerOf(m) as unknown as { _paintAvgMs: number | null })._paintAvgMs).toBeGreaterThan(8);
		expect(await drag(10, 11)).toBe(0);
		readMs = 0;
		const held = layerOf(m)._canvas.ctx.clears.length;
		await settle();
		expect(layerOf(m)._canvas.ctx.clears.length).toBe(held + 1);
		expect(wrong(m)).toBe(0);
		// Closed, it stays closed: a drag half a minute on paints at its settle.
		vi.advanceTimersByTime(30_000);
		expect(await drag(10, -11)).toBe(0);
		await settle();
		// A minute after its last painting in motion, it tries again.
		vi.advanceTimersByTime(61_000);
		expect(await drag(10, 11)).toBeGreaterThan(0);
		expect(holds(m)).toBe(true);
	});

	it('holds its pooling through a drag where the view would read another, and takes the view\'s at the settle', async () => {
		// Zoom 6: the view reads the 1 km grid pooled by 4 until its southern
		// edge passes 54.68 N, by 2 past it.
		const m = await mount(false, [400, 300], [55.3, 10, 6]);
		const view = (): number => poolingAt(6, m.getBounds().getSouth(), m.getBounds().getNorth(), 1000);
		expect(view()).toBe(4);
		expect(layerOf(m).painted().p).toBe(4);
		startDrag(m);
		let crossed = false;
		for (let f = 0; f < 30; f++) {
			await frameStep(m, 0, -9);
			crossed ||= view() === 2;
			expect(layerOf(m).painted().p).toBe(4);
			expect(wrong(m)).toBe(0);
		}
		expect(crossed).toBe(true);
		const clears = layerOf(m)._canvas.ctx.clears.length;
		m.fire('moveend');
		await tick();
		expect(layerOf(m)._canvas.ctx.clears.length).toBe(clears + 1);
		expect(layerOf(m).painted().p).toBe(2);
		expect(wrong(m)).toBe(0);
	});

	it('paints a new feed whole mid-drag and goes on moving the image along', async () => {
		const m = await mount();
		startDrag(m);
		for (let f = 0; f < 6; f++) {
			await frameStep(m, 11);
		}
		const back = (layerOf(m) as unknown as { _radarBack: FakeCanvas | null })._radarBack;
		const from = back?.ctx.putData.length ?? 0;
		tiles = frame(false, 2);
		feed();
		await tick();
		const r = layerOf(m).painted();
		expect(putArea(m, from)).toBe(r.w * r.h);
		expect(wrong(m)).toBe(0);
		for (let f = 0; f < 20; f++) {
			await frameStep(m, 11);
			expect(holds(m)).toBe(true);
			expect(wrong(m)).toBe(0);
		}
	});

	it('paints nothing hidden', async () => {
		const m = await mount();
		syncRadarLayer(m, false);
		const c = layerOf(m) as Layer | undefined;
		expect(c).toBeUndefined();
		expect(radarSampleAtPixel(200, 150)).toBeNull();
	});
});
