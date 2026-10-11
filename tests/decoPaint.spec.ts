/* The airspace decorations' paint (map/decoPaint.ts), with no map and no
 * DOM: a recording 2d context, a recording Path2D, scratch canvases that
 * record too. What it pins:
 *   - the prologue: the whole canvas cleared, then the ratio and the margin
 *     in one transform; nothing more at the low-zoom floor;
 *   - determinism: the same arguments paint the same operations, whatever
 *     painter and whatever it painted before;
 *   - the projection is containerProjection's (a ring's first vertex);
 *   - twin suppression: two SIV sectors sharing a border stamp its dashes
 *     once, not twice;
 *   - the highlighted label always places, and wins the cell it shares;
 *   - the labels flag;
 *   - the tint bands composite through the scratch canvas;
 *   - the line pass: nothing of it with the lines off and the rest of the
 *     paint unchanged with them on, drawn first; each resting line in
 *     stacking order as Leaflet strokes one, weight and dash with the zoom,
 *     none for the strokeless types nor a FIR with arcs; the emphasis stroke
 *     over all of them, never scaled; a tiny zone's line beside its cross;
 *     a pan that moves every line by the pan exactly;
 *   - a ring carrying more vertices than it shows: Leaflet's line at the
 *     zoom (simplified at 1 px, made once and held), for its band as for its
 *     line, the same after a pan and from a warm cache as from a cold one,
 *     the cache held to its budget; a long dashed ring stroked as the runs
 *     that reach the canvas, each dashed from its own place on the ring;
 *   - the band budget goes to the zones on screen before those in the margin
 *     a painting made ahead of a moving view carries, a highlighted zone's
 *     band always drawn. */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import { SIA } from '$lib/map/airspaceSymbology';
import { containerProjector, mercatorX, mercatorY, zoomScale } from '$lib/map/containerProjection';
import { simplifyLine } from '$lib/map/decoGeometry';
import { DecoPainter, withinBandBudget, type DecoFrame, type Scratch } from '$lib/map/decoPaint';
import { decoZoneOf, type DecoZone } from '$lib/map/decoZone';
import { DARK } from '$lib/map/palette';
import { FakePath, fmt, recorder } from './helpers/paint2d';

beforeAll(() => {
	vi.stubGlobal('Path2D', FakePath);
});

/** Scratch canvases that record into one shared log. */
function scratches(log: string[]): (w: number, h: number) => Scratch {
	return (w, h) => {
		const r = recorder();
		const s = {
			ctx: new Proxy(r.ctx, {
				get(t, p: string) {
					const v = Reflect.get(t, p) as unknown;
					return typeof v === 'function'
						? (...a: unknown[]) => {
								log.push(`scratch.${p}(${a.map(fmt).join(',')})`);
								return (v as (...x: unknown[]) => unknown)(...a);
							}
						: v;
				},
			}),
			image: { scratch: true } as unknown as CanvasImageSource,
			width: w,
			height: h,
			resize(nw: number, nh: number) {
				s.width = nw;
				s.height = nh;
			},
		};
		return s;
	};
}

const SIZE = { x: 800, y: 600 };

/** A view over Paris at `zoom`, the viewport centred on it, no pan. */
function frameAt(zoom: number, over: Partial<DecoFrame> = {}): DecoFrame {
	const scale = zoomScale(zoom);
	return {
		view: {
			zoom,
			originX: Math.round(mercatorX(2.3, scale) - SIZE.x / 2),
			originY: Math.round(mercatorY(48.8, scale) - SIZE.y / 2),
			paneX: 0,
			paneY: 0,
		},
		topLeft: { x: 0, y: 0 },
		size: SIZE,
		margin: { left: 0, top: 0, right: 0, bottom: 0 },
		dpr: 1,
		labels: true,
		lines: false,
		...over,
	};
}

function square(lat0: number, lon0: number, lat1: number, lon1: number): [number, number][] {
	return [
		[lat0, lon0],
		[lat0, lon1],
		[lat1, lon1],
		[lat1, lon0],
	];
}

function zone(over: Partial<Airspace> & { ring: [number, number][]; key: string }): DecoZone {
	const lats = over.ring.map((v) => v[0]);
	const lons = over.ring.map((v) => v[1]);
	return decoZoneOf({
		id: over.key,
		name: over.key,
		type: 'R',
		airClass: '',
		subtype: '',
		source: 'fr',
		upper: null,
		workHr: '',
		area: (Math.max(...lats) - Math.min(...lats)) * (Math.max(...lons) - Math.min(...lons)),
		bbox: { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) },
		...over,
	} as unknown as Airspace);
}

const CANVAS = { width: 800, height: 600 };

function paint(
	zones: DecoZone[],
	highlighted: DecoZone[] = [],
	frame = frameAt(10),
	painter = new DecoPainter(scratches([])),
	outlined: DecoZone[] = [],
): string[] {
	const r = recorder();
	painter.paint(r.ctx, CANVAS, frame, zones, highlighted, outlined);
	return r.ops;
}

const SIV_A = zone({ key: 'SIVA', type: 'SIV', ring: square(48.7, 2.15, 48.9, 2.3) });
const SIV_B = zone({ key: 'SIVB', type: 'SIV', ring: square(48.7, 2.3, 48.9, 2.45) });
const R_BIG = zone({ key: 'R1', name: '1', ring: square(48.75, 2.25, 48.85, 2.35) });
const R_SMALL = zone({ key: 'R2', name: '2', ring: square(48.78, 2.28, 48.82, 2.32) });
const TMA = zone({ key: 'TMA1', type: 'TMA', airClass: 'D', name: 'PARIS 1', ring: square(48.6, 2.0, 49.0, 2.6) });

describe('the paint', () => {
	it('clears the whole canvas, then draws in container points at the ratio and margin', () => {
		const ops = paint([SIV_A], [], frameAt(10, { dpr: 2, margin: { left: 96, top: 50, right: 12, bottom: 0 } }));
		expect(ops.slice(0, 3)).toEqual([
			'setTransform(1,0,0,1,0,0)',
			'clearRect(0,0,800,600)',
			'setTransform(2,0,0,2,192,100)',
		]);
	});

	it('paints a zone within one side\'s margin, and not past it, each side its own', () => {
		// Zones just past the viewport's right and left edges: some 20 px out.
		const scale = zoomScale(10);
		const view = frameAt(10).view;
		const lonAt = (x: number) => ((x + view.originX) / scale - 0.5) * 360;
		const east = zone({ key: 'RE', name: 'E', ring: square(48.79, lonAt(815), 48.81, lonAt(830)) });
		const west = zone({ key: 'RW', name: 'W', ring: square(48.79, lonAt(-30), 48.81, lonAt(-15)) });
		const drawn = (m: DecoFrame['margin']) => strokes(linePass(paint([east, west], [], frameAt(10, { lines: true, margin: m }))));
		// Within the paint's cull pad: both, whatever the margins.
		expect(drawn({ left: 0, top: 0, right: 0, bottom: 0 }).length).toBe(2);
		expect(drawn({ left: 0, top: 0, right: 64, bottom: 0 }).length).toBe(2);
		const far = (x0: number, x1: number) => zone({ key: `F${x0}`, name: 'F', ring: square(48.79, lonAt(x0), 48.81, lonAt(x1)) });
		const eastFar = far(900, 920);
		const westFar = far(-120, -100);
		const only = (m: DecoFrame['margin']) =>
			strokes(linePass(paint([eastFar, westFar], [], frameAt(10, { lines: true, margin: m })))).map((x) => x.path);
		expect(only({ left: 0, top: 0, right: 0, bottom: 0 })).toHaveLength(0);
		// A right margin reaches the east zone alone; a left one the west alone.
		expect(only({ left: 0, top: 0, right: 128, bottom: 0 })).toHaveLength(1);
		expect(only({ left: 96, top: 0, right: 0, bottom: 0 })).toHaveLength(1);
		expect(only({ left: 96, top: 0, right: 128, bottom: 0 })).toHaveLength(2);
	});

	it('draws nothing more at the low-zoom floor', () => {
		expect(paint([SIV_A, R_BIG], [R_SMALL], frameAt(4))).toHaveLength(3);
	});

	it('paints the same operations for the same arguments, whatever painted before', () => {
		const painter = new DecoPainter(scratches([]));
		const first = paint([TMA, SIV_A, SIV_B, R_BIG, R_SMALL], [R_BIG], frameAt(10), painter);
		paint([SIV_B], [], frameAt(11), painter);
		const again = paint([TMA, SIV_A, SIV_B, R_BIG, R_SMALL], [R_BIG], frameAt(10), painter);
		const fresh = paint([TMA, SIV_A, SIV_B, R_BIG, R_SMALL], [R_BIG]);
		expect(again).toEqual(first);
		expect(fresh).toEqual(first);
	});

	it('projects through containerProjection', () => {
		const frame = frameAt(10, { view: { ...frameAt(10).view, paneX: 37, paneY: -12 } });
		// An R zone's hatch band is masked on the scratch canvas.
		const log: string[] = [];
		paint([R_BIG], [], frame, new DecoPainter(scratches(log)));
		const pr = containerProjector(frame.view);
		const clip = log.find((o) => o.startsWith('scratch.clip(path('));
		expect(clip).toBeDefined();
		expect(clip).toContain(`M${pr.x(2.25)},${pr.y(48.75)}`);
	});

	it('stamps the dashes of a border two SIV sectors share once, not twice', () => {
		const dashes = (ops: string[]): number => ops.filter((o) => o.startsWith('moveTo(')).length;
		const a = dashes(paint([SIV_A]));
		const b = dashes(paint([SIV_B]));
		const both = dashes(paint([SIV_A, SIV_B]));
		expect(a).toBeGreaterThan(20);
		expect(both).toBeLessThan(a + b);
		// The shared border is a quarter of each ring: about that many go.
		expect(a + b - both).toBeGreaterThan((a + b) / 8);
	});

	it('places the highlighted label first, and it wins the cell it shares', () => {
		const labels = (ops: string[]): string[] =>
			ops.filter((o) => o.startsWith('fillText(')).map((o) => o.slice(9, o.indexOf(',')));
		const big = JSON.stringify(R_BIG.label?.text);
		const small = JSON.stringify(R_SMALL.label?.text);
		// At rest the smaller zone takes the cell.
		expect(labels(paint([R_BIG, R_SMALL]))).toEqual([small]);
		// Highlighted, the larger one does, and the smaller one yields.
		expect(labels(paint([R_BIG, R_SMALL], [R_BIG]))).toEqual([big]);
	});

	it('names two zones of one ring by the one drawn on top', () => {
		const labels = (ops: string[]): string[] =>
			ops.filter((o) => o.startsWith('fillText(')).map((o) => o.slice(9, o.indexOf(',')));
		const ring = square(48.78, 2.28, 48.82, 2.32);
		const tma = zone({ key: 'TMA4', type: 'TMA', airClass: 'A', name: 'PARIS 4', ring });
		const r = zone({ key: 'R2054', name: '205 /4', ring });
		expect(labels(paint([tma, r]))).toEqual([JSON.stringify(r.label?.text)]);
		// The TMA's label, and its class chip's letter.
		const other = labels(paint([r, tma]));
		expect(other.some((t) => t.includes('PARIS 4'))).toBe(true);
		expect(other.some((t) => t.includes('205'))).toBe(false);
	});

	it('draws no label with the labels off', () => {
		const ops = paint([R_BIG, R_SMALL, SIV_A], [R_BIG], frameAt(10, { labels: false }));
		expect(ops.some((o) => o.startsWith('fillText('))).toBe(false);
	});

	it('composites the tint bands through the scratch canvas', () => {
		const log: string[] = [];
		const ops = paint([TMA], [], frameAt(10), new DecoPainter(scratches(log)));
		expect(log.some((o) => o.startsWith('scratch.stroke(path('))).toBe(true);
		expect(ops.some((o) => o.startsWith('drawImage(scratch,'))).toBe(true);
	});
});

const CTR = zone({ key: 'CTR1', type: 'CTR', airClass: 'D', name: 'PARIS', ring: square(48.72, 2.18, 48.88, 2.42) });
const ATZ = zone({ key: 'ATZ1', type: 'ATZ', airClass: 'G', name: 'LOGNES', ring: square(48.8, 2.55, 48.84, 2.62) });
const TRA = zone({ key: 'TRA1', type: 'TRA', name: 'VEXIN', ring: square(48.95, 1.9, 49.1, 2.1) });
const FIC = zone({ key: 'FIC1', type: 'FIC', name: 'PARIS INFO', ring: square(48.0, 1.0, 49.5, 3.5) });
const DLG = zone({ key: 'DLG1', type: 'DLG-ATS', name: 'DLG', ring: square(48.6, 2.4, 48.7, 2.5) });
const FIR_RING = square(47.5, 1.0, 50.0, 3.6);
const FIR = zone({ key: 'FIR1', type: 'FIR', name: 'PARIS', ring: FIR_RING });
const FIR_ARCS = zone({ key: 'FIR2', type: 'FIR', name: 'PARIS', ring: FIR_RING, arcs: [[FIR_RING[0], FIR_RING[1]]] });
// Under TINY_PX at z10: its cross draws, and its line.
const TINY = zone({ key: 'R3', name: '3', ring: square(48.8, 2.3, 48.804, 2.305) });

/** The line pass of a paint with the lines on: from its save to its restore. */
function linePass(ops: string[]): string[] {
	const from = ops.indexOf('save()');
	const to = ops.indexOf('restore()');
	expect(ops[from + 1]).toBe('lineJoin="round"');
	return ops.slice(from + 1, to + 1);
}

/** Each stroke of a line pass: the style it was drawn with and its path. */
function strokes(pass: string[]): { dash: string; width: string; color: string; cap: string; path: string }[] {
	const out = [];
	for (let i = 0; i < pass.length; i++) {
		if (pass[i].startsWith('stroke(path(')) {
			out.push({ dash: pass[i - 4], width: pass[i - 3], color: pass[i - 2], cap: pass[i - 1], path: pass[i] });
		}
	}
	return out;
}

describe('the line pass', () => {
	const lit = (zoom = 10, over: Partial<DecoFrame> = {}) => frameAt(zoom, { lines: true, ...over });

	it('paints nothing of it with the lines off, and leaves the rest as it was with them on', () => {
		const all = [TMA, CTR, SIV_A, R_BIG, R_SMALL, TINY, ATZ, TRA];
		for (const labels of [true, false]) {
			const off = paint(all, [R_BIG], frameAt(10, { labels }));
			const on = paint(all, [R_BIG], lit(10, { labels }));
			expect(off.some((o) => o.startsWith('setLineDash('))).toBe(false);
			// The prologue, then the line pass, then exactly what the paint
			// drew without it.
			expect(on.slice(0, 3)).toEqual(off.slice(0, 3));
			const rest = off.slice(3);
			expect(on.slice(on.length - rest.length)).toEqual(rest);
			const pass = on.slice(3, on.length - rest.length);
			expect(pass[0]).toBe('save()');
			expect(pass.at(-1)).toBe('restore()');
		}
	});

	it('strokes each resting line in stacking order as Leaflet does, then the emphasis over them', () => {
		const pass = linePass(paint([TMA, CTR, SIV_A, R_BIG, R_SMALL], [R_SMALL], lit()));
		// Chart-faithful: a boundary is a line, never a filled interior.
		expect(pass.some((o) => o.startsWith('fill('))).toBe(false);
		const s = strokes(pass);
		expect(s.map((x) => [x.color, x.width, x.dash, x.cap])).toEqual([
			[`strokeStyle="${SIA.ctl}"`, 'lineWidth=0.85', 'setLineDash([])', 'lineCap="round"'],
			[`strokeStyle="${SIA.ctl}"`, 'lineWidth=3', 'setLineDash([21,4])', 'lineCap="round"'],
			[`strokeStyle="${SIA.zone}"`, 'lineWidth=1.2', 'setLineDash([])', 'lineCap="round"'],
			// R_SMALL is emphasised: its resting line gives way to the emphasis,
			// drawn over every other line.
			[`strokeStyle="${DARK[SIA.zone]}"`, 'lineWidth=3', 'setLineDash([])', 'lineCap="round"'],
		]);
	});

	it('strokes an outlined zone in the emphasis, over the resting lines and under the highlighted, and nothing else of it changes', () => {
		const zones = [TMA, CTR, R_BIG, R_SMALL];
		const ops = paint(zones, [R_SMALL], lit(), undefined, [CTR]);
		const s = strokes(linePass(ops));
		expect(s.map((x) => [x.color, x.width, x.dash])).toEqual([
			[`strokeStyle="${SIA.ctl}"`, 'lineWidth=0.85', 'setLineDash([])'],
			[`strokeStyle="${SIA.zone}"`, 'lineWidth=1.2', 'setLineDash([])'],
			[`strokeStyle="${DARK[SIA.ctl]}"`, 'lineWidth=3', 'setLineDash([21,4])'],
			[`strokeStyle="${DARK[SIA.zone]}"`, 'lineWidth=3', 'setLineDash([])'],
		]);
		const plain = paint(zones, [R_SMALL], lit());
		const after = (o: string[]) => o.slice(o.indexOf('restore()') + 1);
		expect(after(ops)).toEqual(after(plain));
		// Outlined but not shown: nothing of it is painted.
		expect(strokes(linePass(paint([TMA], [], lit(), undefined, [CTR])))).toHaveLength(1);
	});

	it('scales a resting line with the zoom, never the emphasis', () => {
		const z9 = strokes(linePass(paint([CTR], [], lit(9))));
		expect([z9[0].width, z9[0].dash]).toEqual(['lineWidth=1.8', 'setLineDash([12.6,2.4])']);
		const hl = strokes(linePass(paint([CTR], [CTR], lit(9))));
		expect(hl.map((x) => [x.color, x.width, x.dash])).toEqual([[`strokeStyle="${DARK[SIA.ctl]}"`, 'lineWidth=3', 'setLineDash([21,4])']]);
		// The ATZ's dots at z8: zero-length dashes, round caps.
		const atz = strokes(linePass(paint([ATZ], [], lit(8))));
		expect([atz[0].width, atz[0].dash, atz[0].cap]).toEqual(['lineWidth=1.17', 'setLineDash([0.045,3.15])', 'lineCap="round"']);
	});

	it('leaves the strokeless types and a FIR with arcs to their marks, and strokes them emphasised', () => {
		expect(strokes(linePass(paint([SIV_A, FIC, DLG, FIR_ARCS], [], lit(8))))).toEqual([]);
		const fir = strokes(linePass(paint([FIR], [], lit(8))));
		expect(fir.map((x) => [x.color, x.width])).toEqual([[`strokeStyle="${SIA.ink}"`, 'lineWidth=0.63']]);
		for (const z of [SIV_A, FIC, DLG, FIR_ARCS]) {
			const hl = strokes(linePass(paint([z], [z], lit(8))));
			expect(hl.map((x) => x.width), z.key).toEqual(['lineWidth=3']);
		}
	});

	it('keeps a tiny zone\'s line beside its cross', () => {
		const ops = paint([TINY], [], lit());
		expect(strokes(linePass(ops))).toHaveLength(1);
		// The cross is still drawn, after the line pass.
		const cross = paint([TINY], [], frameAt(10));
		expect(cross.length).toBeGreaterThan(3);
		expect(ops.slice(ops.indexOf('restore()') + 1)).toEqual(cross.slice(3));
	});

	it('moves every line by a pan, exactly', () => {
		const coords = (path: string): number[] => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
		const at = strokes(linePass(paint([TMA, CTR, R_BIG, ATZ], [R_BIG], lit())));
		const view = frameAt(10).view;
		const panned = strokes(linePass(paint([TMA, CTR, R_BIG, ATZ], [R_BIG], lit(10, { view: { ...view, paneX: 37, paneY: -12 } }))));
		expect(panned).toHaveLength(at.length);
		for (let i = 0; i < at.length; i++) {
			const a = coords(at[i].path);
			const b = coords(panned[i].path);
			expect(b.length).toBe(a.length);
			expect(b.map((v, k) => v - a[k])).toEqual(a.map((_, k) => (k % 2 === 0 ? 37 : -12)));
		}
	});
});

/** A ring of `n` vertices round (lat, lon), its radius wobbling by `wobble`
 *  of itself from one vertex to the next. */
function roundRing(lat: number, lon: number, radiusDeg: number, n: number, wobble = 0): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		const a = (2 * Math.PI * i) / n;
		const r = radiusDeg * (1 + (i % 2 === 0 ? wobble : -wobble));
		out.push([lat + r * Math.sin(a) * 0.66, lon + r * Math.cos(a)]);
	}
	return out;
}

// 4000 vertices on a ring some 150 px across at z10: the stride would thin it.
const HUGE = zone({ key: 'TMA9', type: 'TMA', airClass: 'D', name: 'HUGE', ring: roundRing(48.8, 2.3, 0.1, 4000, 0.004) });

/** The ring's line as Leaflet draws it at `frame`: rounded, simplified, moved. */
function leafletLine(z: DecoZone, frame: DecoFrame): number[] {
	const scale = zoomScale(frame.view.zoom);
	const world: number[] = [];
	for (let o = 0; o < z.ring.length; o += 2) {
		world.push(Math.round(mercatorX(z.ring[o + 1], scale)), Math.round(mercatorY(z.ring[o], scale)));
	}
	const { originX, originY, paneX, paneY } = frame.view;
	return [...simplifyLine(world, 1)].map((v, i) => (i % 2 === 0 ? v - originX + paneX : v - originY + paneY));
}

/** The vertices of a recorded path, flat. */
function pathCoords(op: string): number[] {
	return (op.match(/[ML]-?\d+(\.\d+)?,-?\d+(\.\d+)?/g) ?? []).flatMap((m) => m.slice(1).split(',').map(Number));
}

describe('a ring with more vertices than it shows', () => {
	const lit = (over: Partial<DecoFrame> = {}) => frameAt(10, { lines: true, ...over });

	it('takes Leaflet\'s line at the zoom, for its band as for its line', () => {
		const log: string[] = [];
		const ops = paint([HUGE], [], lit(), new DecoPainter(scratches(log)));
		const want = leafletLine(HUGE, lit());
		expect(want.length / 2).toBeLessThan(4000 / 4);
		const line = strokes(linePass(ops));
		expect(line).toHaveLength(1);
		expect(pathCoords(line[0].path)).toEqual(want);
		// The tint band is clipped and stroked along the very same line.
		const band = log.find((o) => o.startsWith('scratch.clip(path('));
		expect(band).toBeDefined();
		expect(pathCoords(band ?? '')).toEqual(want);
	});

	it('moves it by a pan exactly, and paints it the same from a warm cache as from a cold one', () => {
		const painter = new DecoPainter(scratches([]));
		const first = paint([HUGE, TMA, R_BIG], [R_BIG], lit(), painter);
		const view = frameAt(10).view;
		const panned = paint([HUGE, TMA, R_BIG], [R_BIG], lit({ view: { ...view, paneX: 37, paneY: -12 } }), painter);
		const a = pathCoords(strokes(linePass(first))[0].path);
		const b = pathCoords(strokes(linePass(panned))[0].path);
		expect(b).toEqual(a.map((v, i) => v + (i % 2 === 0 ? 37 : -12)));
		const again = paint([HUGE, TMA, R_BIG], [R_BIG], lit(), painter);
		expect(again).toEqual(first);
		expect(paint([HUGE, TMA, R_BIG], [R_BIG], lit())).toEqual(first);
	});

	it('keeps what it holds to its budget, and lets go of a zone it is told to forget', () => {
		const painter = new DecoPainter(scratches([]));
		// Wobbling rings keep most of their vertices: 60 of them are twice the
		// budget.
		const zones = Array.from({ length: 60 }, (_, i) =>
			zone({ key: `Z${i}`, type: 'TMA', airClass: 'D', name: `Z${i}`, ring: roundRing(48.8, 2.3, 0.05 + i * 0.002, 20_000, 0.02) }),
		);
		let largest = 0;
		for (const z of zones) {
			paint([z], [], lit(), painter);
			largest = Math.max(largest, leafletLine(z, lit()).length / 2);
		}
		expect(largest).toBeGreaterThan(10_000);
		expect(painter.heldLineVertices).toBeGreaterThan(400_000 - largest);
		expect(painter.heldLineVertices).toBeLessThanOrEqual(400_000 + largest);
		const last = zones[zones.length - 1];
		const before = painter.heldLineVertices;
		painter.forget(last);
		expect(painter.heldLineVertices).toBe(before - leafletLine(last, lit()).length / 2);
		painter.release();
		expect(painter.heldLineVertices).toBe(0);
	});

	it('lets go of the least recently painted first', () => {
		const painter = new DecoPainter(scratches([]));
		const kept = zone({ key: 'KEPT', type: 'TMA', airClass: 'D', name: 'KEPT', ring: roundRing(48.8, 2.3, 0.04, 20_000, 0.02) });
		for (let i = 0; i < 60; i++) {
			// Painted before every other one: never the one to go, so never
			// simplified twice.
			paint([kept], [], lit(), painter);
			const z = zone({ key: `Y${i}`, type: 'TMA', airClass: 'D', name: `Y${i}`, ring: roundRing(48.8, 2.3, 0.05 + i * 0.002, 20_000, 0.02) });
			paint([z], [], lit(), painter);
		}
		expect(painter.linesMade).toBe(61);
		const before = painter.heldLineVertices;
		painter.forget(kept);
		expect(painter.heldLineVertices).toBe(before - leafletLine(kept, lit()).length / 2);
	});
});

describe('a long dashed ring', () => {
	// An ADIZ reaching thousands of kilometres east of Paris, its west side
	// through the view, a vertex every 0.02 degree along it.
	const WEST: [number, number][] = [];
	for (let lat = 40; lat <= 60; lat += 0.02) {
		WEST.push([lat, 2.3]);
	}
	const ADIZ = zone({ key: 'ADIZ1', type: 'ADIZ', name: 'ADIZ', ring: [...WEST, [60, 32.3], [40, 32.3]] });

	it('strokes only the runs that reach the canvas, each dashed from its own place on the ring', () => {
		const frame = frameAt(10, { lines: true });
		const pass = linePass(paint([ADIZ], [], frame));
		const pr = containerProjector(frame.view);
		const pts: number[] = [];
		for (let o = 0; o < ADIZ.ring.length; o += 2) {
			pts.push(pr.x(ADIZ.ring[o + 1]), pr.y(ADIZ.ring[o]));
		}
		const n = pts.length / 2;
		const along: number[] = [0];
		for (let i = 1; i <= n; i++) {
			const a = i - 1;
			const b = i % n;
			along.push(along[i - 1] + Math.hypot(pts[2 * b] - pts[2 * a], pts[2 * b + 1] - pts[2 * a + 1]));
		}
		// '12 4 2 4 2 4' at z10.
		const period = 28;
		const offsets = pass.filter((o) => o.startsWith('lineDashOffset=')).map((o) => Number(o.slice(15)));
		const starts = pass.filter((o) => o.startsWith('moveTo(')).map((o) => o.slice(7, -1).split(',').map(Number));
		const lineTos = pass.filter((o) => o.startsWith('lineTo(')).length;
		// One run through the view (the last offset resets the state to 0).
		expect(starts).toHaveLength(1);
		expect(offsets.slice(0, -1)).toHaveLength(1);
		expect(offsets.at(-1)).toBe(0);
		// Far fewer segments than the ring has.
		expect(lineTos).toBeLessThan(n / 10);
		// The run starts on a vertex of the ring, dashed as the whole ring
		// would be there.
		const v = pts.findIndex((_, i) => i % 2 === 0 && pts[i] === starts[0][0] && pts[i + 1] === starts[0][1]) / 2;
		expect(v).toBeGreaterThanOrEqual(0);
		expect(offsets[0]).toBeCloseTo(along[v] % period, 6);
		// The whole ring is far longer than eight canvases round.
		expect(along[n]).toBeGreaterThan(8 * 2 * (800 + 600 + 64));
	});

	it('strokes a dashed ring near the canvas whole', () => {
		const pass = linePass(paint([CTR], [], frameAt(10, { lines: true })));
		expect(pass.some((o) => o.startsWith('lineDashOffset='))).toBe(false);
		expect(strokes(pass)).toHaveLength(1);
	});
});

describe('withinBandBudget', () => {
	const size = { x: 800, y: 600 };
	/** A zone's box in container points, x0 to x0 + 20. */
	const box = (x0: number, highlighted = false): { highlighted: boolean; x0: number; y0: number; x1: number; y1: number } => ({
		highlighted,
		x0,
		y0: 100,
		x1: x0 + 20,
		y1: 120,
	});

	it('keeps every band within the budget, in stacking order', () => {
		const all = [box(900), box(100), box(-300)];
		expect(withinBandBudget(all, 3, size)).toEqual(all);
		expect(withinBandBudget(all, 3, size)).not.toBe(all);
	});

	it('gives the budget to the zones on screen first, then to the margin in stacking order', () => {
		const ahead = [box(900), box(950), box(-300)];
		// One straddles the viewport's edge: it shows.
		const shown = [box(100), box(790)];
		const hl = box(990, true);
		const all = [ahead[0], shown[0], ahead[1], hl, shown[1], ahead[2]];
		expect(withinBandBudget(all, 3, size)).toEqual([ahead[0], shown[0], hl, shown[1]]);
		expect(withinBandBudget(all, 2, size)).toEqual([shown[0], hl, shown[1]]);
		expect(withinBandBudget(all, 1, size)).toEqual([shown[0], hl]);
		expect(withinBandBudget(all, 0, size)).toEqual([hl]);
	});
});
