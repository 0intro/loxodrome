/* Which airspace rows the map shows, and which the painting of a rectangle
 * draws (map/airspaceLayer.ts). The boundaries are painted with their
 * decorations (airspaceDecoLayer.ts), so there is no Leaflet polygon per row
 * and no cull: what must hold is what the painting is handed and when it is
 * told to paint again.
 *
 *   - airspacesToPaint answers exactly the rows the filters and the
 *     categories show whose bbox meets the window, largest first and equal
 *     areas in dataset order, none at the zoom floor nor a world past the
 *     seam: held to a brute-force reading of the same rules over random
 *     filter states and windows;
 *   - it hands back the same array while nothing changed and the window
 *     stays near, a new one when a filter changes the rows;
 *   - the hit-test asks the filters and the category toggle, never where
 *     the map happens to be pointing ("left-click stays visibility-gated");
 *   - every emphasised key has its clone, drawn or not, re-cloned when a
 *     republished dataset replaces its row; a dashed clone is stroked whole
 *     and unsimplified, as the painting strokes it over the clone;
 *   - the repaint listener is told when what is drawn changes other than by
 *     the view: a filter that changes the rows of the rectangle last
 *     painted, an emphasis, a NOTAM's linked set, a republished dataset; and
 *     never of a pan, a zoom, a resize, or a change that leaves the rows as
 *     they were.
 *
 * Vitest runs in `environment: 'node'`: Leaflet is stood in by the handful
 * of calls the clones make, and the map by a viewport, a zoom and its panes. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import type { AirspaceCategory, Publisher } from '$lib/state/layers.svelte';
import { bandIntersects, fromTriple } from '$lib/vertical/limits';

interface FakePoly {
	ring: [number, number][];
	opts: Record<string, unknown>;
	onMap: boolean;
}

let polys: FakePoly[] = [];

vi.mock('leaflet', () => {
	// A real class, because emphasisClones tests `instanceof L.Path` before
	// re-fronting a clone.
	class Path {
		fake: FakePoly;
		constructor(ring: [number, number][], opts: Record<string, unknown>) {
			this.fake = { ring, opts, onMap: false };
			polys.push(this.fake);
		}
		addTo(): this {
			this.fake.onMap = true;
			return this;
		}
		bringToFront(): this {
			return this;
		}
		getElement(): null {
			return null;
		}
	}
	const L = {
		// emphasisClones pulls in directDrawLayer, which subclasses L.Layer at
		// module scope.
		Layer: class {},
		Path,
		svg: () => ({}),
		polygon: (ring: [number, number][], opts: Record<string, unknown>) => new Path(ring, opts),
	};
	return { default: L, ...L };
});

vi.mock('$lib/map/activationLayer', () => ({ isActivationDrawn: () => false }));
vi.mock('$lib/map/navContactLayer', () => ({ navContactKeys: () => new Set<string>() }));
vi.mock('$lib/map/navAlertLayer', () => ({ navAlertKeys: () => new Set<string>() }));

const {
	CATEGORIES,
	airspaceAt,
	airspacesToPaint,
	buildAirspaceLayer,
	clearAirspaceLayer,
	highlightAirspace,
	highlightAirspaces,
	linkedAirspaceKeys,
	setAirspaceAltitudeFilter,
	setAirspaceCategory,
	setAirspacePublisher,
	setAirspaceRepaintListener,
	setLinkedAirspaces,
	setRouteAirspaceFilter,
	updateAirspaceViewport,
} = await import('$lib/map/airspaceLayer');

/** A square zone of `size` degrees centred on (lat, lon). */
function zone(id: string, lat: number, lon: number, size = 0.2, over: Partial<Airspace> = {}): Airspace {
	const h = size / 2;
	return {
		id,
		key: id,
		name: id,
		type: 'CTR',
		airClass: 'D',
		subtype: '',
		category: 'controlled',
		source: 'fr',
		upper: null,
		ring: [
			[lat - h, lon - h],
			[lat - h, lon + h],
			[lat + h, lon + h],
			[lat + h, lon - h],
		],
		bbox: { minLat: lat - h, maxLat: lat + h, minLon: lon - h, maxLon: lon + h },
		area: size * size,
		vLower: null,
		vUpper: null,
		...over,
	} as unknown as Airspace;
}

/** A map that is only a viewport, a zoom and its panes. */
function fakeMap(lat: number, lon: number, zoom = 9, span = 1) {
	const panes: Record<string, { style: Record<string, string> }> = {};
	const map = {
		lat,
		lon,
		zoom,
		span,
		getZoom: () => map.zoom,
		getPane: (n: string) => panes[n],
		createPane: (n: string) => (panes[n] ??= { style: {} }),
		removeLayer: (l: { fake?: FakePoly }) => {
			if (l.fake) {
				l.fake.onMap = false;
			}
			return map;
		},
	};
	return map as unknown as L.Map & { lat: number; lon: number; zoom: number; span: number };
}

/** The viewport of a fake map as the window a painting asks for. */
function viewWindow(m: { lat: number; lon: number; span: number }) {
	return { minLat: m.lat - m.span / 2, maxLat: m.lat + m.span / 2, minLon: m.lon - m.span / 2, maxLon: m.lon + m.span / 2 };
}

/** Whether a row's bbox meets a window. */
function meets(a: Airspace, w: ReturnType<typeof viewWindow>): boolean {
	return a.bbox.maxLon >= w.minLon && a.bbox.minLon <= w.maxLon && a.bbox.maxLat >= w.minLat && a.bbox.minLat <= w.maxLat;
}

const ids = (rows: readonly Airspace[]): string[] => rows.map((a) => a.id);
const inView = (rows: readonly Airspace[], w: ReturnType<typeof viewWindow>): string[] => ids(rows.filter((a) => meets(a, w)));

/** Every filter back to its default, every category off but `on`. */
function defaults(on: AirspaceCategory[] = ['controlled']): void {
	for (const c of CATEGORIES) {
		setAirspaceCategory(c, on.includes(c));
	}
	setAirspaceAltitudeFilter(null);
	for (const p of ['fr', 'uk', 'es'] as Publisher[]) {
		setAirspacePublisher(p, true);
	}
	setRouteAirspaceFilter(null);
}

// Paris, and a zone far enough east that a z9 viewport never sees both.
const NEAR = zone('LFPARIS', 48.8, 2.3);
const FAR = zone('LFSTRAS', 48.6, 7.8);
// FL 115 to FL 195 beside LFPARIS: the one row a low level band hides.
const HIGH = zone('LFHIGH', 48.8, 2.45, 0.1, { vLower: fromTriple(['STD', '115', 'FL']), vUpper: fromTriple(['STD', '195', 'FL']) });
const SIV = zone('LFSIV', 48.9, 2.2, 0.3, { type: 'SIV', category: 'siv' });
const UK = zone('EGUK', 48.7, 2.1, 0.05, { source: 'uk' });

describe('the rows a painting draws', () => {
	let map: ReturnType<typeof fakeMap>;

	beforeEach(() => {
		clearAirspaceLayer();
		polys = [];
		map = fakeMap(48.8, 2.3);
		defaults();
		buildAirspaceLayer(map, [NEAR, FAR, HIGH, SIV, UK]);
	});

	it('are the rows the filters and the categories show in the window, in stacking order', () => {
		const w = viewWindow(map);
		// Largest first: NEAR (0.04) then HIGH (0.01) then UK (0.0025); the SIV
		// category is off, and FAR is out of the window.
		expect(inView(airspacesToPaint(9, w), w)).toEqual(['LFPARIS', 'LFHIGH', 'EGUK']);
		setAirspaceCategory('siv', true);
		expect(inView(airspacesToPaint(9, w), w)).toEqual(['LFSIV', 'LFPARIS', 'LFHIGH', 'EGUK']);
		setAirspacePublisher('uk', false);
		setAirspaceAltitudeFilter({ floor: 0, ceiling: 5000 });
		expect(inView(airspacesToPaint(9, w), w)).toEqual(['LFSIV', 'LFPARIS']);
		// The route filter shows its rows whatever their category, and gives
		// the categories back as they were when it clears.
		setAirspaceCategory('siv', false);
		setAirspaceAltitudeFilter(null);
		setRouteAirspaceFilter(new Set(['LFSIV', 'LFHIGH']));
		expect(inView(airspacesToPaint(9, w), w)).toEqual(['LFSIV', 'LFHIGH']);
		setRouteAirspaceFilter(null);
		expect(inView(airspacesToPaint(9, w), w)).toEqual(['LFPARIS', 'LFHIGH']);
	});

	it('are none at the zoom floor, none a world past the seam, and this side of it astride', () => {
		expect(airspacesToPaint(4, viewWindow(map))).toEqual([]);
		const w = viewWindow(map);
		expect(airspacesToPaint(9, { ...w, minLon: w.minLon + 360, maxLon: w.maxLon + 360 })).toEqual([]);
		buildAirspaceLayer(map, [NEAR, zone('NZZCH', -43.5, 179.8, 0.2)]);
		expect(ids(airspacesToPaint(9, { minLat: -44, maxLat: -43, minLon: 179.5, maxLon: 180.5 }))).toEqual(['NZZCH']);
	});

	it('stack rows of one area in dataset order, whatever order the index returns', () => {
		// Enough of them for the index's bulk load to shuffle equal boxes.
		const same = Array.from({ length: 40 }, (_, i) => zone(`LF${String(i).padStart(2, '0')}`, 48.8, 2.3, 0.1));
		buildAirspaceLayer(map, same);
		expect(ids(airspacesToPaint(9, viewWindow(map)))).toEqual(ids(same));
		const reversed = [...same].reverse();
		buildAirspaceLayer(map, reversed);
		expect(ids(airspacesToPaint(9, viewWindow(map)))).toEqual(ids(reversed));
	});

	it('are the same array while the rows stand and the window stays near, a new one otherwise', () => {
		const w = viewWindow(map);
		const first = airspacesToPaint(9, w);
		// A pan of a quarter of the window: within the rectangle queried.
		expect(airspacesToPaint(9, { ...w, minLon: w.minLon + map.span / 4, maxLon: w.maxLon + map.span / 4 })).toBe(first);
		// A setter that leaves the rows as they were keeps the array.
		setAirspacePublisher('es', false);
		expect(airspacesToPaint(9, w)).toBe(first);
		// One that changes them makes a new one.
		setAirspacePublisher('uk', false);
		const second = airspacesToPaint(9, w);
		expect(second).not.toBe(first);
		expect(ids(second)).toEqual(['LFPARIS', 'LFHIGH']);
		// A window past the rectangle queries again.
		expect(airspacesToPaint(9, { ...w, minLon: w.minLon + 2 * map.span, maxLon: w.maxLon + 2 * map.span })).not.toBe(second);
	});

	it('are exactly what the rules show, whatever the filters and the window', () => {
		let seed = 7;
		const rnd = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const cats = ['controlled', 'restricted', 'activity', 'siv', 'fir'] as const;
		const field: Airspace[] = [];
		for (let i = 0; i < 160; i++) {
			const high = rnd() < 0.3;
			field.push(
				zone(`Z${i}`, 48 + rnd() * 2, 1.5 + rnd() * 2, 0.02 + rnd() * 0.3, {
					category: cats[i % cats.length],
					source: rnd() < 0.2 ? 'uk' : 'fr',
					vLower: high ? fromTriple(['STD', '115', 'FL']) : null,
					vUpper: high ? fromTriple(['STD', '195', 'FL']) : null,
				}),
			);
		}
		buildAirspaceLayer(map, field);
		// The rules, read over every row by brute force.
		const state = { cats: new Set<string>(['controlled']), pubs: { fr: true, uk: true } as Record<string, boolean>, band: null as { floor: number; ceiling: number } | null, route: null as Set<string> | null };
		const shown = (a: Airspace): boolean =>
			(!state.band || bandIntersects(a.vLower, a.vUpper, state.band)) &&
			state.pubs[a.source] &&
			(!state.route || state.route.has(a.key)) &&
			(state.route !== null || state.cats.has(a.category));
		for (let step = 0; step < 300; step++) {
			const r = rnd();
			if (r < 0.3) {
				const c = cats[Math.floor(rnd() * cats.length)];
				const on = rnd() < 0.5;
				setAirspaceCategory(c, on);
				if (on) {
					state.cats.add(c);
				} else {
					state.cats.delete(c);
				}
			} else if (r < 0.45) {
				const p = rnd() < 0.5 ? 'fr' : 'uk';
				const on = rnd() < 0.6;
				setAirspacePublisher(p, on);
				state.pubs[p] = on;
			} else if (r < 0.6) {
				state.band = rnd() < 0.5 ? null : { floor: 0, ceiling: 3000 + rnd() * 10000 };
				setAirspaceAltitudeFilter(state.band);
			} else if (r < 0.7) {
				state.route = rnd() < 0.5 ? null : new Set(field.filter(() => rnd() < 0.3).map((a) => a.key));
				setRouteAirspaceFilter(state.route);
			} else {
				map.lat = 48 + rnd() * 2;
				map.lon = 1.5 + rnd() * 2;
				map.span = 0.3 + rnd() * 1.2;
			}
			const w = viewWindow(map);
			const want = field
				.map((a, i) => ({ a, i }))
				.filter(({ a }) => shown(a) && meets(a, w))
				.sort((x, y) => y.a.area - x.a.area || x.i - y.i)
				.map(({ a }) => a.id);
			expect(inView(airspacesToPaint(9, w), w), `step ${step}`).toEqual(want);
		}
	});

	it('hit-test a row the filters and the toggle allow, wherever the map is', () => {
		expect(airspaceAt(map, 48.8, 2.3)?.id).toBe('LFPARIS');
		// Far from the view: the hit-test never asks where the map points.
		expect(airspaceAt(map, 48.6, 7.8)?.id).toBe('LFSTRAS');
		setAirspaceCategory('controlled', false);
		expect(airspaceAt(map, 48.8, 2.3)).toBeNull();
		map.zoom = 4;
		setAirspaceCategory('controlled', true);
		expect(airspaceAt(map, 48.8, 2.3)).toBeNull();
	});
});

describe('the emphasis clones', () => {
	let map: ReturnType<typeof fakeMap>;
	const CTR = zone('LFCTR', 48.75, 2.4, 0.1, { type: 'CTR' });
	const TMA = zone('LFTMA', 48.7, 2.2, 0.4, { type: 'TMA' });

	beforeEach(() => {
		clearAirspaceLayer();
		polys = [];
		map = fakeMap(48.8, 2.3);
		defaults();
		buildAirspaceLayer(map, [NEAR, FAR, CTR, TMA, SIV]);
	});

	const live = (): FakePoly[] => polys.filter((p) => p.onMap);

	it('clone every emphasised key, drawn or not, and let each go with its emphasis', () => {
		// NEAR is drawn, FAR out of view, SIV's category off: each is cloned.
		highlightAirspaces(['LFPARIS', 'LFSTRAS', 'LFSIV']);
		expect(live().map((p) => p.ring)).toEqual([NEAR.ring, FAR.ring, SIV.ring]);
		highlightAirspace('LFPARIS');
		expect(live().map((p) => p.ring)).toEqual([NEAR.ring]);
		highlightAirspace(null);
		expect(live()).toEqual([]);
	});

	it('stroke a dashed clone whole and unsimplified, as the painting strokes it', () => {
		highlightAirspaces(['LFCTR', 'LFTMA']);
		const [ctr, tma] = live();
		expect(ctr.opts).toMatchObject({ dashArray: '21 4', noClip: true, smoothFactor: 0 });
		expect(tma.opts.noClip).toBeUndefined();
		expect(tma.opts.smoothFactor).toBeUndefined();
	});

	it('re-clone an emphasised row a republished dataset replaces', () => {
		highlightAirspace('LFPARIS');
		const moved = zone('LFPARIS', 48.9, 2.3);
		buildAirspaceLayer(map, [moved, FAR]);
		expect(live().map((p) => p.ring)).toEqual([moved.ring]);
	});

	it('draw the linked set requested before the build, and name it to the painting', () => {
		clearAirspaceLayer();
		polys = [];
		setLinkedAirspaces([NEAR, SIV]);
		expect(linkedAirspaceKeys().size).toBe(0);
		buildAirspaceLayer(map, [NEAR, FAR, SIV]);
		expect(live().map((p) => p.ring)).toEqual([NEAR.ring, SIV.ring]);
		expect([...linkedAirspaceKeys()].sort()).toEqual(['LFPARIS', 'LFSIV']);
		setLinkedAirspaces(null);
		expect(live()).toEqual([]);
		expect(linkedAirspaceKeys().size).toBe(0);
	});

	it('hide with their pane at the zoom floor', () => {
		updateAirspaceViewport(map);
		expect(map.getPane('airspaces')?.style.display).toBe('');
		map.zoom = 4;
		updateAirspaceViewport(map);
		expect(map.getPane('airspaces')?.style.display).toBe('none');
	});
});

describe('the repaint listener', () => {
	let map: ReturnType<typeof fakeMap>;
	let told = 0;

	/** What the painting does: ask for the rows of the rectangle it covers. */
	const paint = (): readonly Airspace[] => airspacesToPaint(map.zoom, viewWindow(map));

	beforeEach(() => {
		clearAirspaceLayer();
		polys = [];
		map = fakeMap(48.8, 2.3);
		defaults();
		buildAirspaceLayer(map, [NEAR, FAR, HIGH]);
		told = 0;
		setAirspaceRepaintListener(() => told++);
		paint();
	});

	/** How many times the listener was told since the last ask. */
	const sinceLast = (): number => {
		const n = told;
		told = 0;
		return n;
	};

	it('is told once per filter change that changes what is drawn, and not otherwise', () => {
		setAirspaceAltitudeFilter({ floor: 0, ceiling: 5000 });
		expect(ids(paint())).toEqual(['LFPARIS']);
		expect(sinceLast()).toBe(1);
		// The same band again, as a new object: nothing drawn changes.
		setAirspaceAltitudeFilter({ floor: 0, ceiling: 5000 });
		expect(sinceLast()).toBe(0);
		setAirspaceAltitudeFilter(null);
		expect(sinceLast()).toBe(1);

		setAirspacePublisher('fr', false);
		expect(sinceLast()).toBe(1);
		setAirspacePublisher('fr', false);
		expect(sinceLast()).toBe(0);
		setAirspacePublisher('fr', true);
		expect(sinceLast()).toBe(1);
		// A publisher with nothing in view changes nothing drawn.
		setAirspacePublisher('uk', false);
		expect(sinceLast()).toBe(0);

		setAirspaceCategory('controlled', false);
		expect(sinceLast()).toBe(1);
		setAirspaceCategory('controlled', false);
		expect(sinceLast()).toBe(0);
		setAirspaceCategory('controlled', true);
		expect(sinceLast()).toBe(1);

		// Every row in view is on the route: nothing drawn changes.
		setRouteAirspaceFilter(new Set(['LFPARIS', 'LFHIGH']));
		expect(ids(paint())).toEqual(['LFPARIS', 'LFHIGH']);
		expect(sinceLast()).toBe(0);
		setRouteAirspaceFilter(new Set(['LFPARIS']));
		expect(sinceLast()).toBe(1);
		// A route edit that leaves the same keys: a new set, nothing drawn changes.
		setRouteAirspaceFilter(new Set(['LFPARIS']));
		expect(sinceLast()).toBe(0);
		setRouteAirspaceFilter(null);
		expect(sinceLast()).toBe(1);
	});

	it('is told of a change when nothing has been painted yet', () => {
		clearAirspaceLayer();
		buildAirspaceLayer(map, [NEAR, FAR, HIGH]);
		setAirspaceRepaintListener(() => told++);
		sinceLast();
		setAirspacePublisher('uk', false);
		expect(sinceLast()).toBe(1);
	});

	it('is never told of a pan, a zoom or a resize, which the painting repaints on by itself', () => {
		map.lon = 7.8;
		map.lat = 48.6;
		updateAirspaceViewport(map);
		expect(ids(paint())).toEqual(['LFSTRAS']);
		map.zoom = 4;
		updateAirspaceViewport(map);
		expect(paint()).toEqual([]);
		map.zoom = 9;
		map.span = 3;
		updateAirspaceViewport(map);
		expect(sinceLast()).toBe(0);
	});

	it('is told of a change of emphasis, and not of the same one again', () => {
		highlightAirspace('LFPARIS');
		expect(sinceLast()).toBe(1);
		highlightAirspace('LFPARIS');
		expect(sinceLast()).toBe(0);
		// A row out of view still paints, unconditionally.
		highlightAirspace('LFSTRAS');
		expect(sinceLast()).toBe(1);
		highlightAirspace(null);
		expect(sinceLast()).toBe(1);
	});

	it('is told of a change of the linked set, and not of the same set again', () => {
		setLinkedAirspaces([NEAR]);
		expect(sinceLast()).toBe(1);
		setLinkedAirspaces([NEAR]);
		expect(sinceLast()).toBe(0);
		setLinkedAirspaces([NEAR, HIGH]);
		expect(sinceLast()).toBe(1);
		setLinkedAirspaces(null);
		expect(sinceLast()).toBe(1);
		setLinkedAirspaces([]);
		expect(sinceLast()).toBe(0);
	});

	it('is told of a republished dataset, and not of the same array again', () => {
		const rows = [NEAR, FAR, HIGH, zone('LFNEW', 48.8, 2.35, 0.1)];
		buildAirspaceLayer(map, rows);
		expect(sinceLast()).toBe(1);
		buildAirspaceLayer(map, rows);
		expect(sinceLast()).toBe(0);
		expect(ids(paint())).toEqual(['LFPARIS', 'LFHIGH', 'LFNEW']);
	});

	it('is dropped with the layer, so a rebuilt one notifies nobody until a new listener registers', () => {
		clearAirspaceLayer();
		buildAirspaceLayer(fakeMap(48.8, 2.3), [NEAR, FAR, HIGH]);
		setAirspacePublisher('fr', false);
		highlightAirspace('LFPARIS');
		expect(sinceLast()).toBe(0);
	});
});
