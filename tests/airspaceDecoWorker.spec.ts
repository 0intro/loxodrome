/* The airspace decorations with their worker (map/airspaceDecoLayer.ts over
 * map/decoWorkerClient.ts), end to end on Leaflet itself in Node: a stood-in
 * Worker whose messages go through a real structured clone, handing their
 * arrays over as the browser does, and OffscreenCanvas / bitmaprenderer stand-
 * ins (tests/helpers/leafletNode.ts, paint2d.ts). What it pins:
 *   - the first painting is the page's, made while the worker starts;
 *   - once the worker says ready, paintings go to it, the zones ahead of the
 *     painting that first names them, and what it hands back is what the
 *     canvas shows; the page lets go of the canvases it painted with;
 *   - when it fails a painting, the page paints from then on, from zones made
 *     afresh (those sent took their arrays with them), and the canvas shows
 *     the page's painting;
 *   - a layer taken down and built again hands its next worker the zones
 *     whole, never the emptied ones the last worker took;
 *   - the page, painting on the main thread, paints a drag at its settle
 *     only; once the worker is ready, the layer paints as the map moves,
 *     each painting reaching ahead of the view;
 *   - the shown rows a selected NOTAM affects go out as outlined, those it
 *     does not show do not;
 *   - with no airspace shown, a settle and a drag make no painting at all
 *     (no message, no page paint, the canvas hidden), and a hovered one is
 *     painted whatever the categories. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Map as LeafletMap, Point } from 'leaflet';
import type { Airspace } from '$lib/data/airspaces';
import { transfersOf, type FromWorker, type ToWorker } from '$lib/map/decoProtocol';
import { FakeBitmap, FakeCanvas, FakeElement, installLeafletNode } from './helpers/leafletNode';
import { FakePath, recorder } from './helpers/paint2d';

const env = installLeafletNode({ any3d: true, bitmap: true });

/** The page's OffscreenCanvas: a recording context, and bitmaps to hand. */
class Offscreen {
	static made: Offscreen[] = [];
	readonly r = recorder();
	constructor(
		public width: number,
		public height: number,
	) {
		Offscreen.made.push(this);
	}
	getContext(kind: string): unknown {
		return kind === '2d' ? this.r.ctx : null;
	}
	transferToImageBitmap(): FakeBitmap {
		return new FakeBitmap(this.width, this.height);
	}
}

class FakeWorker {
	static made: FakeWorker[] = [];
	/** What reached the worker: each message as the structured clone made it. */
	readonly sent: ToWorker[] = [];
	terminated = false;
	onmessage: ((e: { data: FromWorker }) => void) | null = null;
	onerror: unknown = null;
	onmessageerror: unknown = null;
	constructor() {
		FakeWorker.made.push(this);
	}
	postMessage(msg: ToWorker, transfer: Transferable[]): void {
		// As postMessage does: a detached array in the list throws, and the
		// page's own arrays are emptied by the handover.
		expect(transfer).toEqual(transfersOf(msg));
		this.sent.push(structuredClone(msg, { transfer }));
	}
	terminate(): void {
		this.terminated = true;
	}
	answer(data: FromWorker): void {
		this.onmessage?.({ data });
	}
}

vi.stubGlobal('OffscreenCanvas', Offscreen);
vi.stubGlobal('Worker', FakeWorker);
vi.stubGlobal('Path2D', FakePath);

const L = (await import('leaflet')).default;
const { buildAirspaceLayer, clearAirspaceLayer, highlightAirspace, setAirspaceCategory, setLinkedAirspaces } = await import('$lib/map/airspaceLayer');
const { airspaceDecoIdle, buildAirspaceDecoLayer, clearAirspaceDecoLayer } = await import('$lib/map/airspaceDecoLayer');

function zone(key: string, type: string, category: string, airClass: string, lat0: number, lon0: number, lat1: number, lon1: number): Airspace {
	return {
		id: key,
		key,
		name: key,
		type,
		airClass,
		subtype: '',
		category,
		source: 'fr',
		upper: null,
		lower: null,
		vLower: null,
		vUpper: null,
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

const tick = (): Promise<void> => Promise.resolve();

/** How many calls the page's paintings have made so far. */
const pageCalls = (): number => Offscreen.made.reduce((n, o) => n + o.r.ops.length, 0);

let map: LeafletMap | null = null;

const ROWS = [
	zone('SIVA', 'SIV', 'siv', '', 48.7, 2.15, 48.9, 2.3),
	zone('SIVB', 'SIV', 'siv', '', 48.7, 2.3, 48.9, 2.45),
	zone('R1', 'R', 'restricted', '', 48.75, 2.2, 48.85, 2.28),
	zone('TMA1', 'TMA', 'controlled', 'D', 48.72, 2.32, 48.88, 2.42),
	// Its category is never on: not shown.
	zone('PJE9', 'PARACHUTE', 'activity', '', 48.6, 2.0, 48.62, 2.02),
];

/** Two SIV sectors, a restricted area (a hatch) and a class D TMA (a tint
 *  band) over Paris at z10, drawn, with the decorations built. */
function mount(): { canvas: FakeCanvas; worker: FakeWorker } {
	FakeWorker.made = [];
	Offscreen.made = [];
	map = L.map(env.container(800, 600) as unknown as HTMLElement, {
		zoomControl: false,
		attributionControl: false,
		zoomAnimation: false,
		fadeAnimation: false,
		markerZoomAnimation: false,
		trackResize: false,
		// Node has no SVG: the emphasis clones take a canvas instead.
		preferCanvas: true,
	}).setView([48.8, 2.3], 10);
	buildAirspaceLayer(map, ROWS);
	for (const category of ['siv', 'restricted', 'controlled'] as const) {
		setAirspaceCategory(category, true);
	}
	setAirspaceCategory('activity', false);
	buildAirspaceDecoLayer(map);
	const pane = map.getPane('airspaces-deco') as unknown as FakeElement;
	expect(FakeWorker.made).toHaveLength(1);
	return { canvas: pane.childNodes[0] as FakeCanvas, worker: FakeWorker.made[0] };
}

afterEach(() => {
	clearAirspaceLayer();
	clearAirspaceDecoLayer();
	map?.remove();
	map = null;
	vi.restoreAllMocks();
});

describe('the airspace decorations with their worker', () => {
	it('paints on the page while the worker starts, then through it, then on the page again when it fails', async () => {
		const { canvas, worker } = mount();
		await tick();
		await tick();
		// The page's own first painting, the worker not ready yet.
		expect(worker.sent).toEqual([]);
		expect(canvas.renderer?.shown).toBeInstanceOf(FakeBitmap);
		const firstPainting = pageCalls();
		expect(firstPainting).toBeGreaterThan(0);

		worker.answer({ type: 'ready' });
		highlightAirspace('SIVA');
		await tick();
		const [zones, paint] = worker.sent;
		if (zones?.type !== 'zones' || paint?.type !== 'paint') {
			throw new Error('expected the zones, then the painting');
		}
		expect(zones.zones.map((z) => z.key).sort()).toEqual(['R1', 'SIVA', 'SIVB', 'TMA1']);
		for (const z of zones.zones) {
			expect(z.ring.length).toBe(8);
		}
		expect(paint.highlighted).toHaveLength(1);
		// The page lets go of what it painted with: its painting canvas and
		// its scratches, the stores freed.
		expect(Offscreen.made.length).toBeGreaterThanOrEqual(3);
		expect(Offscreen.made.map((o) => [o.width, o.height])).toEqual(Offscreen.made.map(() => [0, 0]));
		const fromWorker = new FakeBitmap(paint.width, paint.height);
		worker.answer({ type: 'frame', seq: paint.seq, bitmap: fromWorker as unknown as ImageBitmap });
		expect(canvas.renderer?.shown).toBe(fromWorker);
		await airspaceDecoIdle();

		// The worker fails the next painting: the page takes over for good.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		highlightAirspace('SIVB');
		await tick();
		const again = worker.sent.at(-1);
		if (again?.type !== 'paint') {
			throw new Error('no second painting');
		}
		expect(worker.sent).toHaveLength(3);
		const before = pageCalls();
		worker.answer({ type: 'failed', seq: again.seq, reason: 'zone 9 unknown' });
		expect(worker.terminated).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		await airspaceDecoIdle();
		const fromPage = canvas.renderer?.shown;
		expect(fromPage).toBeInstanceOf(FakeBitmap);
		expect(fromPage).not.toBe(fromWorker);
		// Painted on the page, from zones made afresh: the ones sent are
		// empty now, and painting those would draw next to nothing.
		expect(pageCalls() - before).toBeGreaterThan(firstPainting / 2);
		highlightAirspace(null);
		await airspaceDecoIdle();
		expect(worker.sent).toHaveLength(3);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it('hands a rebuilt layer’s worker the zones whole, not the emptied ones the last one took', async () => {
		const { worker: first } = mount();
		first.answer({ type: 'ready' });
		highlightAirspace('SIVA');
		await tick();
		expect(first.sent[0]?.type).toBe('zones');

		const live = map;
		if (!live) {
			throw new Error('no map');
		}
		clearAirspaceDecoLayer();
		expect(first.terminated).toBe(true);
		buildAirspaceDecoLayer(live);
		const second = FakeWorker.made.at(-1);
		if (!second || second === first) {
			throw new Error('no second worker');
		}
		second.answer({ type: 'ready' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		highlightAirspace('SIVB');
		await tick();
		expect(warn).not.toHaveBeenCalled();
		const zones = second.sent[0];
		if (zones?.type !== 'zones') {
			throw new Error('expected the zones first');
		}
		expect(zones.zones.map((z) => z.key).sort()).toEqual(['R1', 'SIVA', 'SIVB', 'TMA1']);
		for (const z of zones.zones) {
			expect(z.ring.length).toBe(8);
		}
	});

	it('paints a drag as it goes once the worker paints, ahead of the view, and at its settle before', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		try {
			const { worker } = mount();
			await tick();
			await tick();
			const live = map;
			if (!live) {
				throw new Error('no map');
			}
			// Eastward at 1 px per ms, a frame at a time, as Leaflet's drag.
			const drag = async (frames: number): Promise<void> => {
				for (let i = 0; i < frames; i++) {
					vi.advanceTimersByTime(16);
					(live as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(16, 0));
					live.fire('move');
					await tick();
					await tick();
				}
			};
			// The page paints: nothing until the drag settles.
			const before = pageCalls();
			await drag(10);
			expect(pageCalls()).toBe(before);
			live.fire('moveend');
			await tick();
			await tick();
			expect(pageCalls()).toBeGreaterThan(before);
			// The worker paints: the drag paints as it goes, ahead of the view.
			worker.answer({ type: 'ready' });
			vi.advanceTimersByTime(500);
			await drag(10);
			const paint = worker.sent.find((m) => m.type === 'paint');
			if (paint?.type !== 'paint') {
				throw new Error('no painting while the map moved');
			}
			const { margin } = paint.frame;
			expect(margin.right).toBeGreaterThan(0);
			expect([margin.left, margin.top, margin.bottom]).toEqual([0, 0, 0]);
			expect([paint.width, paint.height]).toEqual([800 + margin.right, 600]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('sends the shown rows a selected NOTAM affects as outlined, and no other', async () => {
		const { worker } = mount();
		worker.answer({ type: 'ready' });
		// TMA1 is shown; PJE9 is not, and its clone stands in for it alone.
		setLinkedAirspaces([ROWS[3], ROWS[4]]);
		await tick();
		const zones = worker.sent.find((m) => m.type === 'zones');
		const paint = worker.sent.findLast((m) => m.type === 'paint');
		if (zones?.type !== 'zones' || paint?.type !== 'paint') {
			throw new Error('expected the zones and a painting');
		}
		const gidOf = (key: string) => zones.zones.find((z) => z.key === key)?.gid;
		expect([...paint.outlined]).toEqual([gidOf('TMA1')]);
		worker.answer({ type: 'frame', seq: paint.seq, bitmap: new FakeBitmap(paint.width, paint.height) as unknown as ImageBitmap });
		setLinkedAirspaces(null);
		await tick();
		const cleared = worker.sent.findLast((m) => m.type === 'paint');
		expect(cleared !== paint && cleared?.type === 'paint' ? [...cleared.outlined] : null).toEqual([]);
	});

	it('makes no painting while no airspace is shown, and paints a hovered one', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
		try {
			const { canvas, worker } = mount();
			await tick();
			await tick();
			worker.answer({ type: 'ready' });
			for (const category of ['siv', 'restricted', 'controlled'] as const) {
				setAirspaceCategory(category, false);
			}
			await tick();
			await tick();
			const live = map;
			if (!live) {
				throw new Error('no map');
			}
			const page = pageCalls();
			const sent = worker.sent.length;
			// A drag, eastward at 1 px per ms, and its settle.
			vi.advanceTimersByTime(500);
			for (let i = 0; i < 20; i++) {
				vi.advanceTimersByTime(16);
				(live as unknown as { _rawPanBy(offset: Point): void })._rawPanBy(L.point(16, 0));
				live.fire('move');
				await tick();
				await tick();
			}
			live.fire('moveend');
			await tick();
			await tick();
			expect(worker.sent.slice(sent).filter((m) => m.type === 'paint')).toEqual([]);
			expect(pageCalls()).toBe(page);
			expect(canvas.style.visibility).toBe('hidden');
			expect([canvas.width, canvas.height]).toEqual([1, 1]);
			// Hovered, an airspace is painted whatever the categories say.
			highlightAirspace('SIVA');
			await tick();
			const paint = worker.sent.findLast((m) => m.type === 'paint');
			if (paint?.type !== 'paint') {
				throw new Error('no painting for the hovered airspace');
			}
			expect([paint.zones.length, paint.highlighted.length]).toEqual([0, 1]);
			const bitmap = new FakeBitmap(paint.width, paint.height);
			worker.answer({ type: 'frame', seq: paint.seq, bitmap: bitmap as unknown as ImageBitmap });
			expect(canvas.renderer?.shown).toBe(bitmap);
			expect(canvas.style.visibility).toBe('');
			highlightAirspace(null);
		} finally {
			vi.useRealTimers();
		}
	});
});
