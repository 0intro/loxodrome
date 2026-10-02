/* The decoration worker's logic (map/decoWorkerCore.ts), in Node with its
 * canvases stood in by recording ones (tests/helpers/paint2d.ts):
 *   - it says ready only where the platform paints what is needed, and names
 *     what is missing otherwise (Path2D, text that reaches the pixels);
 *   - a painting of zones it was sent comes back as a transferred bitmap,
 *     painted exactly as the page's painter paints it;
 *   - a painting naming a zone it was never sent fails, whole;
 *   - forgotten zones are let go, with the lines simplified for them. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import { mercatorX, mercatorY, zoomScale } from '$lib/map/containerProjection';
import { DecoPainter, type DecoFrame } from '$lib/map/decoPaint';
import type { FromWorker, WireZone } from '$lib/map/decoProtocol';
import { DecoWorkerCore, type WorkerEnv } from '$lib/map/decoWorkerCore';
import { SIA } from '$lib/map/airspaceSymbology';
import { DARK } from '$lib/map/palette';
import { decoZoneOf } from '$lib/map/decoZone';
import { FakePath, recorder } from './helpers/paint2d';

class Bitmap {
	constructor(
		readonly width: number,
		readonly height: number,
	) {}
	close(): void {}
}

/** An OffscreenCanvas over a recording context; `blankText` has its text
 *  reach no pixel, as in a worker with no font. */
function canvasOf(width: number, height: number, blankText = false) {
	const r = recorder();
	const ctx = blankText
		? new Proxy(r.ctx, {
				get(t, p: string) {
					return p === 'getImageData'
						? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
						: (Reflect.get(t, p) as unknown);
				},
			})
		: r.ctx;
	return {
		width,
		height,
		ops: r.ops,
		getContext: (kind: string) => (kind === '2d' ? ctx : null),
		transferToImageBitmap(): Bitmap {
			return new Bitmap(this.width, this.height);
		},
	};
}

type FakeCanvas = ReturnType<typeof canvasOf>;

function env(opts: { blankText?: boolean } = {}): { env: WorkerEnv; posted: { msg: FromWorker; transfer: Transferable[] }[]; canvases: FakeCanvas[] } {
	const posted: { msg: FromWorker; transfer: Transferable[] }[] = [];
	const canvases: FakeCanvas[] = [];
	return {
		posted,
		canvases,
		env: {
			post: (msg, transfer) => posted.push({ msg, transfer }),
			canvas: (w, h) => {
				const c = canvasOf(w, h, opts.blankText);
				canvases.push(c);
				return c as unknown as OffscreenCanvas;
			},
		},
	};
}

beforeEach(() => {
	vi.stubGlobal('Path2D', FakePath);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function square(key: string, lat0: number, lon0: number, lat1: number, lon1: number, type = 'R'): Airspace {
	return {
		id: key,
		key,
		name: key,
		type,
		airClass: '',
		subtype: '',
		source: 'fr',
		upper: null,
		workHr: '',
		area: (lat1 - lat0) * (lon1 - lon0),
		bbox: { minLat: lat0, minLon: lon0, maxLat: lat1, maxLon: lon1 },
		ring: [
			[lat0, lon0],
			[lat0, lon1],
			[lat1, lon1],
			[lat1, lon0],
		],
	} as unknown as Airspace;
}

function frame(): DecoFrame {
	const scale = zoomScale(10);
	return {
		view: { zoom: 10, originX: Math.round(mercatorX(2.3, scale) - 400), originY: Math.round(mercatorY(48.8, scale) - 300), paneX: 0, paneY: 0 },
		topLeft: { x: 0, y: 0 },
		size: { x: 800, y: 600 },
		margin: { left: 0, top: 0, right: 0, bottom: 0 },
		dpr: 1,
		labels: true,
		lines: false,
	};
}

/** The zone as the page would send it: a fresh copy, since sending hands the
 *  arrays over. */
function wire(a: Airspace, gid: number): WireZone {
	const z = decoZoneOf(a);
	return {
		...z,
		gid,
		ring: z.ring.slice(),
		arcs: z.arcs?.map((l) => l.slice()) ?? null,
		internal: z.internal?.map((l) => l.slice()) ?? null,
	};
}

describe('DecoWorkerCore', () => {
	it('says ready where the platform paints what is needed', () => {
		const e = env();
		new DecoWorkerCore(e.env).start();
		expect(e.posted.map((p) => p.msg)).toEqual([{ type: 'ready' }]);
	});

	it('names what is missing: Path2D, or text that reaches the pixels', () => {
		vi.stubGlobal('Path2D', undefined);
		const a = env();
		new DecoWorkerCore(a.env).start();
		expect(a.posted[0].msg).toEqual({ type: 'unsupported', reason: 'path2d' });
		vi.stubGlobal('Path2D', FakePath);
		const b = env({ blankText: true });
		new DecoWorkerCore(b.env).start();
		expect(b.posted[0].msg).toEqual({ type: 'unsupported', reason: 'text' });
	});

	it('paints the zones it was sent as the page would, and hands the bitmap back', () => {
		const e = env();
		const core = new DecoWorkerCore(e.env);
		const tma = square('TMA1', 48.6, 2.0, 49.0, 2.6, 'TMA');
		const r = square('R1', 48.75, 2.25, 48.85, 2.35);
		core.handle({ type: 'zones', zones: [wire(tma, 1), wire(r, 2)] });
		expect(core.held).toBe(2);
		const f = frame();
		core.handle({ type: 'paint', seq: 7, frame: f, width: 800, height: 600, zones: new Uint32Array([1, 2]), highlighted: new Uint32Array([2]), outlined: new Uint32Array([]) });
		const done = e.posted.at(-1);
		expect(done?.msg.type).toBe('frame');
		if (done?.msg.type !== 'frame') {
			throw new Error('no frame');
		}
		expect(done.msg.seq).toBe(7);
		expect(done.transfer).toEqual([done.msg.bitmap]);
		expect([done.msg.bitmap.width, done.msg.bitmap.height]).toEqual([800, 600]);
		// The worker's surface is the first canvas it made; the page paints the
		// same zones with the same kind of scratch, and must log the same.
		const surface = e.canvases[0];
		const page = recorder();
		new DecoPainter((w, h) => {
			const c = canvasOf(w, h);
			const ctx = c.getContext('2d');
			if (!ctx) {
				return null;
			}
			return {
				ctx,
				image: c as unknown as CanvasImageSource,
				get width() {
					return c.width;
				},
				get height() {
					return c.height;
				},
				resize(nw: number, nh: number) {
					c.width = nw;
					c.height = nh;
				},
			};
		}).paint(page.ctx, { width: 800, height: 600 }, f, [decoZoneOf(tma), decoZoneOf(r)], [decoZoneOf(r)]);
		expect(page.ops.length).toBeGreaterThan(20);
		expect(surface.ops).toEqual(page.ops);
	});

	it('strokes the outlined zones in the emphasis, as the page would', () => {
		const e = env();
		const core = new DecoWorkerCore(e.env);
		const tma = square('TMA1', 48.6, 2.0, 49.0, 2.6, 'TMA');
		const r = square('R1', 48.75, 2.25, 48.85, 2.35);
		core.handle({ type: 'zones', zones: [wire(tma, 1), wire(r, 2)] });
		const f = { ...frame(), lines: true };
		core.handle({ type: 'paint', seq: 1, frame: f, width: 800, height: 600, zones: new Uint32Array([1, 2]), highlighted: new Uint32Array([]), outlined: new Uint32Array([2]) });
		core.handle({ type: 'paint', seq: 2, frame: f, width: 800, height: 600, zones: new Uint32Array([1, 2]), highlighted: new Uint32Array([]), outlined: new Uint32Array([]) });
		expect(e.posted.map((p) => p.msg.type)).toEqual(['frame', 'frame']);
		// The same surface, twice: the outlined R takes its family's dark ink
		// the first time only.
		const emphasis = e.canvases[0].ops.filter((o) => o === `strokeStyle=${JSON.stringify(DARK[SIA.zone])}`);
		expect(emphasis).toHaveLength(1);
	});

	it('fails a painting that names a zone it was never sent, whole', () => {
		const e = env();
		const core = new DecoWorkerCore(e.env);
		core.handle({ type: 'zones', zones: [wire(square('R2', 48.7, 2.2, 48.8, 2.3), 1)] });
		core.handle({ type: 'paint', seq: 3, frame: frame(), width: 800, height: 600, zones: new Uint32Array([1, 9]), highlighted: new Uint32Array([]), outlined: new Uint32Array([]) });
		expect(e.posted.map((p) => p.msg)).toEqual([{ type: 'failed', seq: 3, reason: 'Error: zone 9 unknown' }]);
	});

	it('lets go of the zones it is told to forget, with the lines simplified for them', () => {
		const e = env();
		const core = new DecoWorkerCore(e.env);
		// A ring with far more vertices than it shows: its line is simplified
		// and held.
		const ring: [number, number][] = [];
		for (let i = 0; i < 4000; i++) {
			const a = (2 * Math.PI * i) / 4000;
			ring.push([48.8 + 0.05 * Math.sin(a), 2.3 + 0.08 * Math.cos(a)]);
		}
		const round: Airspace = { ...square('R3', 48.75, 2.22, 48.85, 2.38), ring };
		core.handle({ type: 'zones', zones: [wire(round, 1), wire(square('R4', 48.7, 2.4, 48.8, 2.5), 2)] });
		core.handle({ type: 'paint', seq: 1, frame: { ...frame(), lines: true }, width: 800, height: 600, zones: new Uint32Array([1, 2]), highlighted: new Uint32Array([]), outlined: new Uint32Array([]) });
		expect(core.heldLineVertices).toBeGreaterThan(0);
		core.handle({ type: 'forget', gids: new Uint32Array([1]) });
		expect(core.held).toBe(1);
		expect(core.heldLineVertices).toBe(0);
	});
});
