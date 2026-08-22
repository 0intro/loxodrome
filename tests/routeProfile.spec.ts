/* Pure-logic coverage for the route vertical profile: the lateral airspace
 * corridor sampler (src/lib/route/airspaces.ts) and the chart builders
 * (src/lib/route/routeProfile.ts). No DOM / network: the terrain sampler needs
 * a browser and is exercised manually. */

import { describe, it, expect } from 'vitest';
import { NO_ENTRY, type EntryConditions } from '$lib/data/airspaceEntry';
import {
	computeAirspaceCorridorSpans,
	routeAirspaceKeysAtAltitude,
	type AirspaceCorridorBand,
} from '$lib/route/airspaces';
import {
	bandCrossings,
	bandPenetrations,
	clipSpanToRange,
	cloudLayerBands,
	fmtRangeNM,
	isForbiddenCrossing,
	computeCeilingFt,
	buildBands,
	buildAltitudePath,
	buildRouteProfileDoc,
	fmtNMTick,
	sampleAltitudePathAt,
	stackByOverlap,
	stepLineRuns,
	terrainTintRuns,
	zoomWindow,
	panWindow,
	FT_PER_NM_3DEG,
	type AltitudeVertex,
	type TerrainSample,
	xOf,
	yOf,
	xTicks,
	yTicks,
	PAD_L,
	PAD_T,
} from '$lib/route/routeProfile';
import { AIRSPACE_TYPE_LABELS, type Airspace, type VerticalLimit } from '$lib/data/airspaces';
import { fr } from '$lib/i18n/fr';
import { fromTriple } from '$lib/vertical/limits';
import type { Waypoint } from '$lib/state/route.svelte';
import type { AirspaceCategory } from '$lib/state/layers.svelte';

/** The canonical English type dictionary, standing in for the
 *  t.data.airspaceTypes vocab pack the UI passes (docs/i18n.md rule 6). */
const EN_TYPE_LABELS: Record<string, string> = AIRSPACE_TYPE_LABELS;

function wp(id: string, lat: number, lon: number, alt = 3000): Waypoint {
	return { id, lat, lon, kind: 'free', alt, altAuto: true };
}

/** An axis-aligned rectangular airspace covering [latMin,latMax] x [lonMin,lonMax]. */
function box(opts: {
	key: string;
	latMin: number;
	lonMin: number;
	latMax: number;
	lonMax: number;
	type?: string;
	category?: AirspaceCategory;
	airClass?: string;
	lower?: VerticalLimit | null;
	upper?: VerticalLimit | null;
}): Airspace {
	const { latMin, lonMin, latMax, lonMax } = opts;
	const ring: [number, number][] = [
		[latMin, lonMin],
		[latMin, lonMax],
		[latMax, lonMax],
		[latMax, lonMin],
	];
	return {
		id: opts.key,
		key: opts.key,
		type: opts.type ?? 'CTR',
		name: opts.key,
		airClass: opts.airClass ?? '',
		upper: opts.upper ?? null,
		lower: opts.lower ?? null,
		// Mirror the loader (source 'fr' normalizes legacy FL999 to UNL).
		vUpper: fromTriple(opts.upper ?? null, { legacyFl999Unl: true }),
		vLower: fromTriple(opts.lower ?? null, { legacyFl999Unl: true }),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring,
		subtype: '',
		category: opts.category ?? 'controlled',
		source: 'fr',
		area: 1,
		bbox: { minLat: latMin, minLon: lonMin, maxLat: latMax, maxLon: lonMax },
	};
}

describe('computeAirspaceCorridorSpans', () => {
	const b = box({ key: 'BOX', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2 });

	it('one lateral crossing -> one band with one span (~60..180 NM)', () => {
		// A 4-degree east-west run at the equator: ~240 NM, crossing lon 0..2.
		const bands = computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [b]);
		expect(bands).toHaveLength(1);
		// The band carries the airspace id (the activation-hatch join key)
		// beside its addressing key.
		expect(bands[0].id).toBe('BOX');
		expect(bands[0].spans).toHaveLength(1);
		expect(bands[0].spans[0].enterNM).toBeGreaterThan(55);
		expect(bands[0].spans[0].enterNM).toBeLessThan(65);
		expect(bands[0].spans[0].leaveNM).toBeGreaterThan(175);
		expect(bands[0].spans[0].leaveNM).toBeLessThan(185);
	});

	it('leaving and re-entering laterally yields two spans', () => {
		// Start inside, exit east, return: two disjoint crossings of one ring.
		const bands = computeAirspaceCorridorSpans(
			[wp('a', 0, 1), wp('b', 0, 3), wp('c', 0, 1)],
			[b],
		);
		expect(bands).toHaveLength(1);
		expect(bands[0].spans).toHaveLength(2);
	});

	it('a span open at the route end closes at totalNM (flight ends inside)', () => {
		// (0,-1) -> (0,1): ends inside the box. ~120 NM total.
		const bands = computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 1)], [b]);
		expect(bands).toHaveLength(1);
		const span = bands[0].spans[0];
		expect(span.leaveNM).toBeGreaterThan(115);
		expect(span.leaveNM).toBeLessThan(125);
	});

	it('excludes FIR/UIR (always-enclosing, not a useful band)', () => {
		const fir = box({ key: 'FIR1', latMin: -5, lonMin: -5, latMax: 5, lonMax: 5, category: 'fir' });
		const bands = computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [fir]);
		expect(bands).toHaveLength(0);
	});

	it('excludes aerial-activity zones (profile clutter)', () => {
		const glider = box({ key: 'GLD', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2, category: 'activity' });
		expect(computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [glider])).toHaveLength(0);
	});

	it('excludes class G airspace', () => {
		const g = box({ key: 'G1', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2, airClass: 'G' });
		expect(computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [g])).toHaveLength(0);
	});

	it('excludes SIV sectors', () => {
		const siv = box({ key: 'SIV1', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2, category: 'siv' });
		expect(computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [siv])).toHaveLength(0);
	});

	it('keeps an airspace with an unbounded ceiling (upper = null)', () => {
		const open = box({ key: 'OPEN', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2, upper: null });
		const bands = computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [open]);
		expect(bands).toHaveLength(1);
		expect(bands[0].vUpper).toBeNull();
	});

	it('< 2 waypoints -> no bands', () => {
		expect(computeAirspaceCorridorSpans([wp('a', 0, 0)], [b])).toEqual([]);
	});

	it('carries the R/D/P badge', () => {
		const danger = box({ key: 'D1', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2, type: 'D' });
		const bands = computeAirspaceCorridorSpans([wp('a', 0, -1), wp('b', 0, 3)], [danger]);
		expect(bands[0].badge).toEqual({ text: 'D', kind: 'zone' });
	});
});

describe('routeAirspaceKeysAtAltitude', () => {
	// LOW spans 0..FL100; HIGH spans FL195..FL245.
	const low = box({
		key: 'LOW', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2,
		lower: ['', '0', ''], upper: ['', '100', 'FL'],
	});
	const high = box({
		key: 'HIGH', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2,
		lower: ['', '195', 'FL'], upper: ['', '245', 'FL'],
	});

	it('includes an airspace the route crosses within its vertical band', () => {
		const route = [wp('a', 0, -1, 3000), wp('b', 0, 3, 3000)];
		expect([...routeAirspaceKeysAtAltitude(route, [low, high], 3000)]).toEqual(['LOW']);
	});

	it('excludes an airspace the route passes under (below its floor)', () => {
		const route = [wp('a', 0, -1, 3000), wp('b', 0, 3, 3000)];
		expect(routeAirspaceKeysAtAltitude(route, [high], 3000).has('HIGH')).toBe(false);
	});

	it('includes a high airspace once the route is flown at its level', () => {
		const route = [wp('a', 0, -1, 20000), wp('b', 0, 3, 20000)];
		expect([...routeAirspaceKeysAtAltitude(route, [low, high], 3000)]).toEqual(['HIGH']);
	});

	it('keeps an airspace with no vertical limits at any altitude', () => {
		const open = box({ key: 'OPEN', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2 });
		const route = [wp('a', 0, -1, 3000), wp('b', 0, 3, 3000)];
		expect([...routeAirspaceKeysAtAltitude(route, [open], 3000)]).toEqual(['OPEN']);
	});

	it('excludes a crossed FIR (always-enclosing background)', () => {
		const fir = box({ key: 'FIR1', latMin: -5, lonMin: -5, latMax: 5, lonMax: 5, category: 'fir' });
		const route = [wp('a', 0, -1, 3000), wp('b', 0, 3, 3000)];
		expect(routeAirspaceKeysAtAltitude(route, [fir], 3000).size).toBe(0);
	});

	it('keeps in-band activity / SIV / class G zones (overrides categories, unlike the profile)', () => {
		const activity = box({
			key: 'GLD', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2,
			category: 'activity', lower: ['', '0', ''], upper: ['', '100', 'FL'],
		});
		const siv = box({
			key: 'SIV1', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2,
			category: 'siv', lower: ['', '0', ''], upper: ['', '100', 'FL'],
		});
		const g = box({
			key: 'G1', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2,
			airClass: 'G', lower: ['', '0', ''], upper: ['', '100', 'FL'],
		});
		const route = [wp('a', 0, -1, 3000), wp('b', 0, 3, 3000)];
		expect([...routeAirspaceKeysAtAltitude(route, [activity, siv, g], 3000)].sort()).toEqual([
			'G1',
			'GLD',
			'SIV1',
		]);
	});

	it('< 2 waypoints -> empty set', () => {
		expect(routeAirspaceKeysAtAltitude([wp('a', 0, 0, 3000)], [low], 3000).size).toBe(0);
	});
});

const FL = (n: number): VerticalLimit => ['STD', String(n), 'FL'];

describe('computeCeilingFt', () => {
	it('floors at ~15000 for a low VFR plan', () => {
		expect(computeCeilingFt([3000], [], [])).toBe(15000);
	});
	it('rises to clear high terrain', () => {
		expect(computeCeilingFt([3000], [12000], [])).toBe(15000);
		expect(computeCeilingFt([3000], [22000], [])).toBe(25000);
	});
	it('includes a bounded airspace ceiling', () => {
		const placed = buildBands([mkBand({ key: 'x', type: 'TMA', lower: FL(45), upper: FL(195), airClass: 'C' })], [], EN_TYPE_LABELS);
		expect(computeCeilingFt([3000], [], placed)).toBe(25000);
	});
	it('excludes unbounded ceilings (missing and UNL alike)', () => {
		const open = buildBands([mkBand({ key: 'x', type: 'R', lower: ['SFC', '0', ''], upper: null })], [], EN_TYPE_LABELS);
		expect(computeCeilingFt([3000], [], open)).toBe(15000); // unchanged by the open top
		const unl = buildBands([mkBand({ key: 'y', lower: FL(195), upper: ['UNL', '', ''] })], [], EN_TYPE_LABELS);
		expect(computeCeilingFt([3000], [], unl)).toBe(25000); // the FL195 floor is drawn, the UNL top is not counted
	});
	it('counts an AGL ceiling at its terrain-resolved top', () => {
		const terrain: TerrainSample[] = [
			{ distNM: 0, elevFt: 2500 },
			{ distNM: 1, elevFt: 2500 },
		];
		const placed = buildBands(
			[mkBand({ key: 'z', lower: ['HEI', '0', 'FT'], upper: ['HEI', '17000', 'FT'] })],
			terrain,
			EN_TYPE_LABELS,
		);
		// 17000 ft ASFC over 2500 ft ground = 19500 ft drawn top.
		expect(computeCeilingFt([3000], [], placed)).toBe(25000);
	});
	it('clamps to 66000', () => {
		expect(computeCeilingFt([3000], [80000], [])).toBe(66000);
	});
});

interface MkBandOver {
	key: string;
	name?: string;
	type?: string;
	category?: AirspaceCategory;
	lower?: VerticalLimit | null;
	upper?: VerticalLimit | null;
	airClass?: string;
	entry?: EntryConditions;
	badge?: AirspaceCorridorBand['badge'];
	spans?: AirspaceCorridorBand['spans'];
}
function mkBand(over: MkBandOver): AirspaceCorridorBand {
	return {
		key: over.key,
		id: over.key,
		name: over.name ?? over.key,
		type: over.type ?? 'CTR',
		category: over.category ?? 'controlled',
		vLower: fromTriple(over.lower ?? null),
		vUpper: fromTriple(over.upper ?? null),
		airClass: over.airClass ?? '',
		entry: over.entry ?? NO_ENTRY,
		badge: over.badge ?? null,
		spans: over.spans ?? [{ enterNM: 0, leaveNM: 1 }],
	};
}

describe('buildBands', () => {
	it('sorts lowest-floor first and maps colour / feet / extent', () => {
		const placed = buildBands(
			[
				mkBand({ key: 'high', lower: FL(100), upper: FL(195) }),
				mkBand({ key: 'low', lower: ['SFC', '0', ''], upper: FL(45) }),
			],
			[],
			EN_TYPE_LABELS,
		);
		expect(placed.map((p) => p.key)).toEqual(['low', 'high']);
		expect(placed[1].lowerFt).toBe(10000);
		expect(placed[1].maxFt).toBe(19500);
		expect(placed[1].color).toBe('var(--airspace-controlled)');
		expect(placed[1].category).toBe('controlled');
		expect(placed[1].rtba).toBe(false);
		expect(placed[1].limitsText).toBe('FL 100 – FL 195');
		expect(placed[1].knownExtent).toBe(true);
		// Flat (FL) limits keep two-point edges.
		expect(placed[1].spans[0].upperPts).toEqual([
			{ distNM: 0, altFt: 19500 },
			{ distNM: 1, altFt: 19500 },
		]);
	});

	it('follows the terrain for AGL/ASFC edges and flags RTBA ids for the pecked outline', () => {
		const terrain: TerrainSample[] = [
			{ distNM: 0, elevFt: 1000 },
			{ distNM: 0.5, elevFt: 2500 },
			{ distNM: 1, elevFt: 1500 },
		];
		// The RTBA shape: SFC to 800 ft ASFC, under a real RTBA id.
		const [p] = buildBands(
			[mkBand({ key: 'LFR45S2', type: 'R', lower: ['HEI', '0', 'FT'], upper: ['HEI', '800', 'FT'] })],
			terrain,
			EN_TYPE_LABELS,
		);
		expect(p.spans[0].upperPts).toEqual([
			{ distNM: 0, altFt: 1800 },
			{ distNM: 0.5, altFt: 3300 },
			{ distNM: 1, altFt: 2300 },
		]);
		// The SFC floor follows the ground line itself.
		expect(p.spans[0].lowerPts).toEqual([
			{ distNM: 0, altFt: 1000 },
			{ distNM: 0.5, altFt: 2500 },
			{ distNM: 1, altFt: 1500 },
		]);
		expect(p.minFt).toBe(1000);
		expect(p.maxFt).toBe(3300);
		// isRtba on the id: LFR45* is the RTBA network, pecked on the chart.
		expect(p.rtba).toBe(true);
	});

	it('marks an UNL ceiling open-topped with no upper edge', () => {
		const [p] = buildBands([mkBand({ key: 'u', lower: FL(195), upper: ['UNL', '', ''] })], [], EN_TYPE_LABELS);
		expect(p.topOpen).toBe(true);
		expect(p.maxFt).toBe(Infinity);
		expect(p.spans[0].upperPts).toEqual([]);
		expect(p.knownExtent).toBe(true);
	});

	it('marks unknown extent when a limit is missing', () => {
		const [p] = buildBands([mkBand({ key: 'u', lower: null, upper: null })], [], EN_TYPE_LABELS);
		expect(p.knownExtent).toBe(false);
	});

	it('passes the badge through', () => {
		const [p] = buildBands([mkBand({ key: 'r', type: 'R', badge: { text: 'R', kind: 'zone' } })], [], EN_TYPE_LABELS);
		expect(p.badge).toBe('R');
		expect(p.badgeKind).toBe('zone');
	});

	it('tooltips head with the caller-passed type labels (both locales pin)', () => {
		const mk = (): AirspaceCorridorBand[] => [
			mkBand({ key: 'tma', type: 'TMA', name: 'RENNES 4', airClass: 'C', lower: FL(45), upper: FL(195) }),
		];
		const [enBand] = buildBands(mk(), [], EN_TYPE_LABELS);
		expect(enBand.tooltip).toContain('Terminal Control Area');
		const [frBand] = buildBands(mk(), [], fr.data.airspaceTypes);
		expect(frBand.tooltip).toContain('Région de contrôle terminale');
		// An unknown type falls back to the raw code.
		const [bare] = buildBands([mkBand({ key: 'x', type: 'XYZ' })], [], {});
		expect(bare.tooltip.startsWith('XYZ (')).toBe(true);
	});

	it('labels the band with its type prefix, skipping the R/D/P chip designator', () => {
		const placed = buildBands(
			[
				mkBand({ key: 'tma', type: 'TMA', name: 'RENNES 4', badge: { text: 'D', kind: 'class' } }),
				mkBand({ key: 'r', type: 'R', name: '212', badge: { text: 'R', kind: 'zone' } }),
				mkBand({ key: 'tmz', type: 'TMZ', name: 'SEINE' }),
			],
			[],
			EN_TYPE_LABELS,
		);
		const label = Object.fromEntries(placed.map((p) => [p.key, p.label]));
		expect(label.tma).toBe('TMA RENNES 4'); // class-kind: type prefixed
		expect(label.r).toBe('212'); // zone-kind: chip shows R, bare name kept
		expect(label.tmz).toBe('TMZ SEINE'); // no chip: type prefixed
	});
});

describe('cloudLayerBands', () => {
	it('degenerates a single cloudy level to the old half-gap slab', () => {
		expect(cloudLayerBands([{ altFt: 1000, coverPct: 100 }])).toEqual([
			{ botFt: 700, topFt: 1300, amount: 'ovc' },
		]);
	});

	it('places the amount edges at the interpolated threshold crossings', () => {
		// 0% at 1000 ft ramping to 100% at 2000 ft: each amount starts where
		// the linear cover crosses its okta threshold ((k - 0.5) x 12.5),
		// and the top sample's cover holds over the mirrored half-gap.
		const bands = cloudLayerBands([
			{ altFt: 1000, coverPct: 0 },
			{ altFt: 2000, coverPct: 100 },
		]);
		expect(bands.map((b) => b.amount)).toEqual(['few', 'sct', 'bkn', 'ovc']);
		expect(bands.map((b) => b.botFt)).toEqual([1062.5, 1312.5, 1562.5, 1937.5]);
		expect(bands[3].topFt).toBe(2500);
	});

	it('grades a layer with clear air on both sides into collars', () => {
		const bands = cloudLayerBands([
			{ altFt: 1000, coverPct: 0 },
			{ altFt: 2000, coverPct: 80 },
			{ altFt: 3000, coverPct: 0 },
		]);
		expect(bands.map((b) => b.amount)).toEqual(['few', 'sct', 'bkn', 'sct', 'few']);
		expect(bands[2].botFt).toBeCloseTo(1703.125, 6);
		expect(bands[2].topFt).toBeCloseTo(2296.875, 6);
		expect(bands[4].topFt).toBeCloseTo(2921.875, 6);
	});

	it('merges a uniform stack into one band and drops sub-FEW profiles', () => {
		expect(
			cloudLayerBands([
				{ altFt: 1000, coverPct: 50 },
				{ altFt: 2000, coverPct: 50 },
			]),
		).toEqual([{ botFt: 500, topFt: 2500, amount: 'sct' }]);
		expect(
			cloudLayerBands([
				{ altFt: 1000, coverPct: 0 },
				{ altFt: 2000, coverPct: 4 },
			]),
		).toEqual([]);
		expect(cloudLayerBands([])).toEqual([]);
	});
});

describe('yOf (altitude window)', () => {
	it('maps the ceiling to the top and the floor to the bottom', () => {
		expect(yOf(5000, 0, 5000, 100)).toBe(PAD_T); // ceiling -> top
		expect(yOf(0, 0, 5000, 100)).toBe(PAD_T + 100); // floor -> bottom
		expect(yOf(2500, 0, 5000, 100)).toBe(PAD_T + 50); // middle
	});
	it('extends linearly beyond the window (the chart clip crops, not yOf)', () => {
		expect(yOf(10000, 0, 5000, 100)).toBe(PAD_T - 100); // one span above the ceiling
		expect(yOf(-5000, 0, 5000, 100)).toBe(PAD_T + 200); // one span below the floor
	});
	it('works for a non-zero floor (a zoomed-in window)', () => {
		expect(yOf(8000, 3000, 8000, 100)).toBe(PAD_T);
		expect(yOf(3000, 3000, 8000, 100)).toBe(PAD_T + 100);
		expect(yOf(5500, 3000, 8000, 100)).toBe(PAD_T + 50);
	});
});

describe('yTicks (altitude window)', () => {
	it('uses a fine 1000 ft step for a low/narrow window, plain feet with no TA', () => {
		const t = yTicks(0, 5000, null);
		expect(t.map((x) => x.ft)).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
		expect(t.map((x) => x.label)).toEqual(['0', '1000', '2000', '3000', '4000', '5000']);
	});
	it('switches to FL strictly above the TA (a level equal to the TA stays feet)', () => {
		// AIP France ENR 1.7.2.2: at the TA one still flies an altitude.
		const t = yTicks(3000, 8000, 5000);
		expect(t.map((x) => x.ft)).toEqual([3000, 4000, 5000, 6000, 7000, 8000]);
		expect(t.map((x) => x.label)).toEqual(['3000', '4000', '5000', 'FL 060', 'FL 070', 'FL 080']);
	});
	it('keeps every tick in feet when the whole window sits at or below the TA', () => {
		const t = yTicks(0, 5000, 5000);
		expect(t.map((x) => x.label)).toEqual(['0', '1000', '2000', '3000', '4000', '5000']);
	});
	it('widens the step for a tall window, FL above the TA', () => {
		const t = yTicks(0, 50000, 18000);
		expect(t.map((x) => x.ft)).toEqual([0, 10000, 20000, 30000, 40000, 50000]);
		expect(t.map((x) => x.label)).toEqual(['0', '10000', 'FL 200', 'FL 300', 'FL 400', 'FL 500']);
	});
	it('drops to a 500 ft step when the window span is 3000 ft or less', () => {
		const t = yTicks(1000, 4000, null);
		expect(t.map((x) => x.ft)).toEqual([1000, 1500, 2000, 2500, 3000, 3500, 4000]);
		expect(yTicks(1000, 4100, null).map((x) => x.ft)).toEqual([1000, 2000, 3000, 4000]);
	});
});

describe('bandPenetrations / clipSpanToRange', () => {
	const terrain: TerrainSample[] = [];
	/** Flat CTR 1000..3000 ft AMSL over 10..30 NM. */
	const flat = () =>
		buildBands(
			[
				mkBand({
					key: 'C',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 10, leaveNM: 30 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		)[0];

	// A publisher that states neither limit still states an OUTLINE, and
	// a route through it is a crossing. Returning [] instead kept 279 UK
	// danger areas and 103 control areas out of the strip for good.
	it('crosses a band whose extent the publisher did not state', () => {
		const unknown = buildBands(
			[mkBand({ key: 'D', type: 'D', category: 'restricted', spans: [{ enterNM: 5, leaveNM: 12 }] })],
			terrain,
			EN_TYPE_LABELS,
		)[0];
		expect(unknown.knownExtent).toBe(false);
		expect(unknown.extent).toBe('unknown');
		const path = [
			{ distNM: 0, altFt: 3000 },
			{ distNM: 40, altFt: 3000 },
		];
		expect(bandPenetrations(unknown, path)).toEqual([{ fromNM: 5, toNM: 12 }]);
		const [cx] = bandCrossings([unknown], path);
		expect(cx?.extentUnknown).toBe(true);
	});

	// A floor with no ceiling reads as unbounded above, which is how the
	// map filter and the alert evaluator read it; the ceiling at sea
	// level it used to get made the test fail on the wrong side.
	it('crosses an open-topped band above its published floor', () => {
		const open = buildBands(
			[
				mkBand({
					key: 'O',
					lower: ['ALT', '2000', 'FT'],
					upper: null,
					spans: [{ enterNM: 0, leaveNM: 10 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		)[0];
		expect(open.extent).toBe('open');
		const above = [
			{ distNM: 0, altFt: 5000 },
			{ distNM: 10, altFt: 5000 },
		];
		expect(bandPenetrations(open, above)).toEqual([{ fromNM: 0, toNM: 10 }]);
		// Under the published floor is still outside it.
		const below = [
			{ distNM: 0, altFt: 1000 },
			{ distNM: 10, altFt: 1000 },
		];
		expect(bandPenetrations(open, below)).toEqual([]);
		expect(bandCrossings([open], above)[0]?.extentUnknown).toBe(true);
	});

	it('solves ramp crossings exactly (linear roots, no sampling)', () => {
		// Path climbs 0 -> 4000 ft over 0..20 NM (200 ft/NM), then holds.
		const path = [
			{ distNM: 0, altFt: 0 },
			{ distNM: 20, altFt: 4000 },
			{ distNM: 40, altFt: 4000 },
		];
		// Enters above 1000 ft at 5 NM (outside the span -> clamped to 10);
		// exits above 3000 ft at 15 NM exactly.
		expect(bandPenetrations(flat(), path)).toEqual([{ fromNM: 10, toNM: 15 }]);
	});

	it('at-floor is NOT inside (strict lower), at-ceiling IS (inclusive upper)', () => {
		const atFloor = [
			{ distNM: 0, altFt: 1000 },
			{ distNM: 40, altFt: 1000 },
		];
		expect(bandPenetrations(flat(), atFloor)).toEqual([]);
		const atCeiling = [
			{ distNM: 0, altFt: 3000 },
			{ distNM: 40, altFt: 3000 },
		];
		expect(bandPenetrations(flat(), atCeiling)).toEqual([{ fromNM: 10, toNM: 30 }]);
	});

	it('follows a terrain-hugging ASFC floor: penetrated only over LOW ground', () => {
		// Floor 1000 ft ASFC; ground rises 500 -> 1500 -> 500 over 0..2 NM, so
		// the floor runs 1500/2500/1500 while the path holds 2000 ft: the path
		// is inside where the floor sits below it (over the low ground), the
		// high-ground middle pushing the floor above the path. Crossings at
		// the exact 2000-roots of the floor line: 0.5 and 1.5 NM.
		const hilly: TerrainSample[] = [
			{ distNM: 0, elevFt: 500 },
			{ distNM: 1, elevFt: 1500 },
			{ distNM: 2, elevFt: 500 },
		];
		const [band] = buildBands(
			[
				mkBand({
					key: 'R5B',
					type: 'R',
					lower: ['HEI', '1000', 'FT'],
					upper: ['ALT', '5500', 'FT'],
					spans: [{ enterNM: 0, leaveNM: 2 }],
				}),
			],
			hilly,
			EN_TYPE_LABELS,
		);
		const path = [
			{ distNM: 0, altFt: 2000 },
			{ distNM: 2, altFt: 2000 },
		];
		const pens = bandPenetrations(band, path);
		expect(pens).toHaveLength(2);
		expect(pens[0].fromNM).toBeCloseTo(0, 9);
		expect(pens[0].toNM).toBeCloseTo(0.5, 9);
		expect(pens[1].fromNM).toBeCloseTo(1.5, 9);
		expect(pens[1].toNM).toBeCloseTo(2, 9);
	});

	it('class E flags IFR only (SERA.6001: no VFR radio / clearance in E)', () => {
		const [e] = buildBands(
			[
				mkBand({
					key: 'TMAE',
					airClass: 'E',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 0, leaveNM: 10 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		);
		expect(e.airClass).toBe('E');
		const path = [
			{ distNM: 0, altFt: 2000 },
			{ distNM: 10, altFt: 2000 },
		];
		expect(bandPenetrations(e, path, { vfr: true })).toEqual([]);
		expect(bandPenetrations(e, path, { vfr: false })).toEqual([{ fromNM: 0, toNM: 10 }]);
		expect(bandPenetrations(e, path)).toEqual([{ fromNM: 0, toNM: 10 }]);
		expect(bandCrossings([e], path, { vfr: true })).toEqual([]);
		// A class D volume flags under both flight rules (VFR needs clearance
		// and two-way contact in D).
		const [d] = buildBands(
			[
				mkBand({
					key: 'CTRD',
					airClass: 'D',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 0, leaveNM: 10 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		);
		expect(bandPenetrations(d, path, { vfr: true })).toEqual([{ fromNM: 0, toNM: 10 }]);
	});

	it('open-topped bands test the floor only; an unstated extent is crossed laterally', () => {
		const [unl] = buildBands(
			[mkBand({ key: 'U', lower: ['ALT', '1000', 'FT'], upper: ['UNL', '', ''], spans: [{ enterNM: 0, leaveNM: 10 }] })],
			terrain,
			EN_TYPE_LABELS,
		);
		const high = [
			{ distNM: 0, altFt: 99000 },
			{ distNM: 10, altFt: 99000 },
		];
		expect(bandPenetrations(unl, high)).toEqual([{ fromNM: 0, toNM: 10 }]);
		const [unk] = buildBands(
			[mkBand({ key: 'X', lower: null, upper: null, spans: [{ enterNM: 0, leaveNM: 10 }] })],
			terrain,
			EN_TYPE_LABELS,
		);
		expect(unk.knownExtent).toBe(false);
		// Unbounded on both sides: the outline is the whole statement, so
		// the lateral span IS the crossing, and bandCrossings labels it.
		expect(bandPenetrations(unk, high)).toEqual([{ fromNM: 0, toNM: 10 }]);
	});

	it('isForbiddenCrossing: the verified no-go taxonomy', () => {
		const base = { type: '', airClass: '', rtba: false, prohibited: false, entry: NO_ENTRY };
		// Prohibited area: both rules, active or not.
		expect(isForbiddenCrossing({ ...base, type: 'P' }, { vfr: true, active: false })).toBe(true);
		expect(isForbiddenCrossing({ ...base, type: 'P' }, { vfr: false, active: false })).toBe(true);
		// Class A: IFR only per SERA.6001(a), so forbidden under VFR alone.
		expect(isForbiddenCrossing({ ...base, airClass: 'A' }, { vfr: true, active: false })).toBe(true);
		expect(isForbiddenCrossing({ ...base, airClass: 'A' }, { vfr: false, active: false })).toBe(false);
		// RTBA: forbidden only while hot (SIA ENR 5.1); cold it is class G.
		expect(isForbiddenCrossing({ ...base, type: 'R', rtba: true }, { vfr: true, active: true })).toBe(true);
		expect(isForbiddenCrossing({ ...base, type: 'R', rtba: true }, { vfr: true, active: false })).toBe(false);
		// Ordinary R with nothing readable in its remark: forbidden while
		// active, free cold.
		expect(isForbiddenCrossing({ ...base, type: 'R' }, { vfr: false, active: true })).toBe(true);
		expect(isForbiddenCrossing({ ...base, type: 'R' }, { vfr: false, active: false })).toBe(false);
		// An active R whose published condition is a call or a clearance is a
		// crossing, not a no-go: LF-R 204's "GAT VFR and OAT V: entry after
		// radio contact with AQUITAINE INFO" beside "GAT IFR and OAT A, B, C:
		// avoidance mandatory".
		const r204 = { vfr: 'radio', ifr: 'forbidden', permanent: false } as const;
		expect(isForbiddenCrossing({ ...base, type: 'R', entry: r204 }, { vfr: true, active: true })).toBe(false);
		expect(isForbiddenCrossing({ ...base, type: 'R', entry: r204 }, { vfr: false, active: true })).toBe(true);
		// TSA / TFR: segregated for their user while active, so no transit
		// clearance exists; cold they are ordinary airspace. The be / at / es
		// datasets carry 76 TSA rows, so this tier is reached in practice.
		expect(isForbiddenCrossing({ ...base, type: 'TSA' }, { vfr: true, active: true })).toBe(true);
		expect(isForbiddenCrossing({ ...base, type: 'TSA' }, { vfr: true, active: false })).toBe(false);
		expect(isForbiddenCrossing({ ...base, type: 'TFR' }, { vfr: false, active: true })).toBe(true);
		// TRA stays a clearance crossing even active (transit is obtainable).
		expect(isForbiddenCrossing({ ...base, type: 'TRA' }, { vfr: true, active: true })).toBe(false);
		// D stays advisory even active; CTR stays a plain clearance crossing.
		expect(isForbiddenCrossing({ ...base, type: 'D' }, { vfr: true, active: true })).toBe(false);
		expect(isForbiddenCrossing({ ...base, type: 'CTR', airClass: 'D' }, { vfr: true, active: false })).toBe(false);
		// Prohibited-area NOTAM band (Q subject RP).
		expect(isForbiddenCrossing({ ...base, prohibited: true }, { vfr: false, active: false })).toBe(true);
		// LF-R 275: permanently in force, so it grades with no activation in
		// sight, and only VFR must avoid; IFR entry stays an ordinary crossing
		// (allowed on radio contact with one of the administrators).
		const r275 = { vfr: 'forbidden', ifr: 'radio', permanent: true } as const;
		expect(
			isForbiddenCrossing({ ...base, type: 'R', entry: r275 }, { vfr: true, active: false }),
		).toBe(true);
		expect(
			isForbiddenCrossing({ ...base, type: 'R', entry: r275 }, { vfr: false, active: false }),
		).toBe(false);
		// The permanence rides the band, not the caller's activation model:
		// without it the profile would call LF-R 275 free on a day with no
		// NOTAM while the live banner called it forbidden.
		expect(
			isForbiddenCrossing(
				{ ...base, type: 'R', entry: { ...r275, permanent: false } },
				{ vfr: true, active: false },
			),
		).toBe(false);
	});

	it('bandCrossings flags forbidden rows and lists them first', () => {
		const path = [
			{ distNM: 0, altFt: 2000 },
			{ distNM: 40, altFt: 2000 },
		];
		const bands = buildBands(
			[
				mkBand({
					key: 'ctr',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 5, leaveNM: 10 }],
				}),
				mkBand({
					key: 'LFR45S2',
					type: 'R',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 20, leaveNM: 30 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		);
		expect(bands.find((b) => b.key === 'LFR45S2')!.rtba).toBe(true);
		// Hot RTBA: forbidden, listed FIRST despite entering later.
		const hot = bandCrossings(bands, path, { vfr: true, activeKeys: new Set(['LFR45S2']) });
		expect(hot.map((r) => r.key)).toEqual(['LFR45S2', 'ctr']);
		expect(hot[0].forbidden).toBe(true);
		expect(hot[0].active).toBe(true);
		expect(hot[1].forbidden).toBe(false);
		// Cold: plain distance order, nothing forbidden.
		const cold = bandCrossings(bands, path, { vfr: true });
		expect(cold.map((r) => r.key)).toEqual(['ctr', 'LFR45S2']);
		expect(cold.every((r) => !r.forbidden)).toBe(true);
	});

	it('bandCrossings orders penetrated bands by first entry, skips the rest', () => {
		const path = [
			{ distNM: 0, altFt: 2000 },
			{ distNM: 40, altFt: 2000 },
		];
		const bands = buildBands(
			[
				mkBand({
					key: 'far',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 20, leaveNM: 30 }],
				}),
				mkBand({
					key: 'near',
					lower: ['ALT', '1000', 'FT'],
					upper: ['ALT', '3000', 'FT'],
					spans: [{ enterNM: 5, leaveNM: 10 }],
				}),
				mkBand({
					key: 'above',
					lower: ['ALT', '4000', 'FT'],
					upper: ['ALT', '6000', 'FT'],
					spans: [{ enterNM: 0, leaveNM: 40 }],
				}),
			],
			terrain,
			EN_TYPE_LABELS,
		);
		const rows = bandCrossings(bands, path);
		expect(rows.map((r) => r.key)).toEqual(['near', 'far']);
		expect(rows[0].pens).toEqual([{ fromNM: 5, toNM: 10 }]);
		expect(rows[0].limitsText).toBe('1000 ft AMSL – 3000 ft AMSL');
		expect(fmtRangeNM(5, 10)).toBe('5.0–10.0');
		expect(fmtRangeNM(104.8, 105.2)).toBe('105'); // sliver: one figure, not "105–105"
	});

	it('clipSpanToRange interpolates the cut points on both edges', () => {
		const span = flat().spans[0];
		const cut = clipSpanToRange(span, 15, 25);
		expect(cut.enterNM).toBe(15);
		expect(cut.leaveNM).toBe(25);
		expect(cut.lowerPts[0]).toEqual({ distNM: 15, altFt: 1000 });
		expect(cut.upperPts[cut.upperPts.length - 1]).toEqual({ distNM: 25, altFt: 3000 });
	});
});

describe('stackByOverlap', () => {
	it('stacks overlapping single-line items onto successive lines', () => {
		const items = [
			{ x1: 0, x2: 50, y: 10 },
			{ x1: 10, x2: 60, y: 12 },
		];
		stackByOverlap(items, 13);
		expect(items[1].y).toBe(23);
	});
	it('pushes past a two-line item by its full height', () => {
		const items: { x1: number; x2: number; y: number; h?: number }[] = [
			{ x1: 0, x2: 50, y: 10, h: 26 },
			{ x1: 10, x2: 60, y: 12 },
		];
		stackByOverlap(items, 13);
		expect(items[1].y).toBe(36); // 10 + the blocker's own 26
	});
	it('leaves non-overlapping items alone', () => {
		const items = [
			{ x1: 0, x2: 20, y: 10 },
			{ x1: 30, x2: 60, y: 10 },
		];
		stackByOverlap(items, 13);
		expect(items.map((i) => i.y)).toEqual([10, 10]);
	});
});

describe('stepLineRuns', () => {
	const dists = [0, 10, 25, 40];
	it('groups contiguous legs into one run, each leg keeping its own value', () => {
		const runs = stepLineRuns([2000, 2500, 2500], dists);
		expect(runs).toEqual([
			[
				{ fromNM: 0, toNM: 10, ft: 2000 },
				{ fromNM: 10, toNM: 25, ft: 2500 },
				{ fromNM: 25, toNM: 40, ft: 2500 },
			],
		]);
	});
	it('a null leg breaks the chain into separate runs', () => {
		const runs = stepLineRuns([2000, null, 3000], dists);
		expect(runs).toEqual([
			[{ fromNM: 0, toNM: 10, ft: 2000 }],
			[{ fromNM: 25, toNM: 40, ft: 3000 }],
		]);
	});
	it('null input, all-null legs and a short value array yield no runs', () => {
		expect(stepLineRuns(null, dists)).toEqual([]);
		expect(stepLineRuns([null, null, null], dists)).toEqual([]);
		// values shorter than the legs: missing entries read as null
		expect(stepLineRuns([1000], dists)).toEqual([[{ fromNM: 0, toNM: 10, ft: 1000 }]]);
	});
});

describe('terrainTintRuns', () => {
	const flat = (elevFt: number, n = 5, stepNM = 10): TerrainSample[] =>
		Array.from({ length: n }, (_, i) => ({ distNM: i * stepNM, elevFt }));
	const level = (altFt: number, toNM = 40): AltitudeVertex[] => [
		{ distNM: 0, altFt },
		{ distNM: toNM, altFt },
	];

	it('one full run when the whole line is under the margin, none above', () => {
		const terrain = flat(1000);
		expect(terrainTintRuns(terrain, level(1400))).toEqual([
			{
				points: [
					{ distNM: 0, elevFt: 1000 },
					{ distNM: 10, elevFt: 1000 },
					{ distNM: 20, elevFt: 1000 },
					{ distNM: 30, elevFt: 1000 },
					{ distNM: 40, elevFt: 1000 },
				],
			},
		]);
		expect(terrainTintRuns(terrain, level(1600))).toEqual([]);
		// The margin boundary itself is NOT inside (strict <).
		expect(terrainTintRuns(terrain, level(1500))).toEqual([]);
	});

	it('interpolates the threshold crossing between two samples', () => {
		// Level line at 2000 ft over ground climbing 1000 -> 2000 between
		// 10 and 20 NM: AGL crosses 500 exactly midway (ground 1500 ft).
		const terrain: TerrainSample[] = [
			{ distNM: 0, elevFt: 1000 },
			{ distNM: 10, elevFt: 1000 },
			{ distNM: 20, elevFt: 2000 },
			{ distNM: 30, elevFt: 2000 },
		];
		const runs = terrainTintRuns(terrain, level(2000, 30));
		expect(runs).toHaveLength(1);
		expect(runs[0].points[0]).toEqual({ distNM: 15, elevFt: 1500 });
		expect(runs[0].points.slice(1)).toEqual([
			{ distNM: 20, elevFt: 2000 },
			{ distNM: 30, elevFt: 2000 },
		]);
	});

	it('a failed-tile gap splits the run and never interpolates across it', () => {
		const terrain: TerrainSample[] = [
			{ distNM: 0, elevFt: 1000 },
			{ distNM: 10, elevFt: 1000 },
			{ distNM: 20, elevFt: null },
			{ distNM: 30, elevFt: 1000 },
			{ distNM: 40, elevFt: 1000 },
		];
		const runs = terrainTintRuns(terrain, level(1200));
		expect(runs).toHaveLength(2);
		expect(runs[0].points.map((p) => p.distNM)).toEqual([0, 10]);
		expect(runs[1].points.map((p) => p.distNM)).toEqual([30, 40]);
	});

	it('clips to the path extent and honors a custom margin', () => {
		// Path only covers 10..30 NM: samples outside never tint.
		const path: AltitudeVertex[] = [
			{ distNM: 10, altFt: 1300 },
			{ distNM: 30, altFt: 1300 },
		];
		const runs = terrainTintRuns(flat(1000), path);
		expect(runs).toHaveLength(1);
		expect(runs[0].points.map((p) => p.distNM)).toEqual([10, 20, 30]);
		// Same geometry, tighter margin: AGL 300 is not under 250.
		expect(terrainTintRuns(flat(1000), path, 250)).toEqual([]);
	});

	it('an empty or single-vertex path yields nothing', () => {
		expect(terrainTintRuns(flat(1000), [])).toEqual([]);
		expect(terrainTintRuns(flat(1000), [{ distNM: 0, altFt: 1200 }])).toEqual([]);
	});
});

describe('zoomWindow / panWindow', () => {
	it('keeps the anchor at the same relative position (pixel invariance)', () => {
		const [lo, hi] = zoomWindow(0, 100, 25, 0.5, 0, 200, 1);
		expect(hi - lo).toBeCloseTo(50, 9);
		expect((25 - lo) / (hi - lo)).toBeCloseTo(0.25, 9); // same r as (25-0)/100
	});
	it('factor 1 is a pure re-clamp', () => {
		expect(zoomWindow(10, 60, 35, 1, 0, 100, 5)).toEqual([10, 60]);
		expect(zoomWindow(80, 130, 105, 1, 0, 100, 5)).toEqual([50, 100]); // shifted inside
	});
	it('clamps the span at minSpan and at the full range', () => {
		const [lo, hi] = zoomWindow(40, 44, 42, 0.01, 0, 100, 4);
		expect(hi - lo).toBeCloseTo(4, 9);
		const [flo, fhi] = zoomWindow(20, 80, 50, 100, 0, 100, 4);
		expect([flo, fhi]).toEqual([0, 100]);
	});
	it('shifts back inside the bounds when a zoom-out crosses them', () => {
		const [lo, hi] = zoomWindow(0, 40, 4, 2, 0, 100, 4);
		expect(lo).toBe(0);
		expect(hi - lo).toBeCloseTo(80, 9);
	});
	it('survives a degenerate range smaller than minSpan', () => {
		const [lo, hi] = zoomWindow(0, 500, 250, 0.5, 0, 800, 1000);
		expect(lo).toBeGreaterThanOrEqual(0);
		expect(hi).toBeLessThanOrEqual(800);
		expect(hi - lo).toBeGreaterThan(0);
	});
	it('pans with the span preserved and clamps at both ends', () => {
		expect(panWindow(10, 30, 5, 0, 100)).toEqual([15, 35]);
		expect(panWindow(10, 30, -50, 0, 100)).toEqual([0, 20]);
		expect(panWindow(10, 30, 500, 0, 100)).toEqual([80, 100]);
	});
});

describe('sampleAltitudePathAt', () => {
	const v = [
		{ distNM: 0, altFt: 0 },
		{ distNM: 10, altFt: 2000 },
		{ distNM: 20, altFt: 2000 },
	];
	it('interpolates between vertices and clamps outside the path', () => {
		expect(sampleAltitudePathAt(v, 5)).toBe(1000);
		expect(sampleAltitudePathAt(v, 15)).toBe(2000);
		expect(sampleAltitudePathAt(v, -5)).toBe(0);
		expect(sampleAltitudePathAt(v, 99)).toBe(2000);
		expect(sampleAltitudePathAt([], 5)).toBe(0);
	});
});

describe('xOf (distance window)', () => {
	it('maps from -> left gutter, to -> right of the inner width', () => {
		expect(xOf(0, 0, 100, 200)).toBe(PAD_L);
		expect(xOf(100, 0, 100, 200)).toBe(PAD_L + 200);
		expect(xOf(50, 0, 100, 200)).toBe(PAD_L + 100);
	});
	it('works for a non-zero from and extends linearly past the ends', () => {
		expect(xOf(50, 50, 70, 200)).toBe(PAD_L);
		expect(xOf(70, 50, 70, 200)).toBe(PAD_L + 200);
		expect(xOf(80, 50, 70, 200)).toBe(PAD_L + 300); // past `to`
	});
});

describe('xTicks (distance window)', () => {
	it('spans the window with nice intervals, including both ends', () => {
		const t = xTicks(0, 100, 1000);
		expect(t[0]).toBe(0);
		expect(t[t.length - 1]).toBe(100);
		expect(t).toContain(50);
	});
	it('uses a finer interval for a zoomed-in window', () => {
		const t = xTicks(50, 60, 1000);
		expect(t[0]).toBe(50);
		expect(t[t.length - 1]).toBe(60);
		expect(t).toContain(55);
	});
	it('drops a regular tick crowding the window-end tick, keeping the end', () => {
		// 0..113 at 1000 px: the 110 tick sits 26.5 px from the end label.
		const t = xTicks(0, 113, 1000);
		expect(t[t.length - 1]).toBe(113);
		expect(t).toContain(100);
		expect(t).not.toContain(110);
	});
	it('drops a regular tick crowding the window-start tick symmetrically', () => {
		const t = xTicks(7, 120, 1000);
		expect(t[0]).toBe(7);
		expect(t).not.toContain(10);
		expect(t).toContain(20);
		expect(t).toContain(110);
	});
});

describe('fmtNMTick', () => {
	it('prints near-integer ticks as plain integers', () => {
		expect(fmtNMTick(0)).toBe('0');
		expect(fmtNMTick(10)).toBe('10');
		expect(fmtNMTick(110)).toBe('110');
		expect(fmtNMTick(99.98)).toBe('100');
	});
	it('keeps one decimal on a genuinely fractional window end', () => {
		expect(fmtNMTick(112.9)).toBe('112.9');
		expect(fmtNMTick(42.14)).toBe('42.1');
	});
});

/** Ramp distance (NM) for an altitude change at the 3-degree gradient. */
const ramp = (dFt: number): number => dFt / FT_PER_NM_3DEG;
/** Assert a polyline never steps backward in distance. */
const expectMonotonic = (vs: AltitudeVertex[]): void => {
	for (let i = 1; i < vs.length; i++) {
		expect(vs[i].distNM).toBeGreaterThanOrEqual(vs[i - 1].distNM);
	}
};

describe('buildAltitudePath (per leg)', () => {
	it('single leg: trapezoid up to the leg altitude', () => {
		const { vertices, markers } = buildAltitudePath([2000], [0, 10], 500, 500);
		expect(vertices).toHaveLength(4);
		expect(vertices[1].altFt).toBe(2000);
		expect(vertices[1].distNM).toBeCloseTo(ramp(1500), 2); // ~4.71
		expect(vertices[2].altFt).toBe(2000);
		expect(markers).toEqual([
			{ distNM: 0, altFt: 500 },
			{ distNM: 10, altFt: 500 },
		]);
	});

	it('single leg too short: triangle peaking below the leg altitude', () => {
		const { vertices } = buildAltitudePath([2000], [0, 6], 500, 500);
		expect(vertices).toHaveLength(3);
		expect(vertices[1].distNM).toBeCloseTo(3, 6); // symmetric apex
		expect(vertices[1].altFt).toBeGreaterThan(500);
		expect(vertices[1].altFt).toBeLessThan(2000);
	});

	it('two legs: climbs from ground, holds each leg flat, transitions AFTER the fix, descends to ground', () => {
		const { vertices, markers } = buildAltitudePath([3000, 6000], [0, 40, 80], 500, 500);
		expect(markers).toHaveLength(3);
		expect(markers[0]).toEqual({ distNM: 0, altFt: 500 });
		expect(markers[2]).toEqual({ distNM: 80, altFt: 500 });
		// at the fix the line is still on the arriving leg: the change is after it
		expect(markers[1].altFt).toBe(3000);
		// climb from the ground reaches leg 0's level after one ramp
		expect(vertices[0]).toEqual({ distNM: 0, altFt: 500 });
		expect(vertices[1].distNM).toBeCloseTo(ramp(2500), 2);
		expect(vertices[1].altFt).toBe(3000);
		// leg 0 holds 3000 all the way to the fix, then leg 1 ramps to 6000 after it
		const atFix = vertices.find((v) => v.altFt === 3000 && v.distNM > 20);
		expect(atFix?.distNM).toBeCloseTo(40, 6);
		const reached = vertices.find((v) => v.altFt === 6000);
		expect(reached?.distNM).toBeCloseTo(40 + ramp(3000), 2);
		// descent to the ground begins one ramp before the destination
		const last = vertices[vertices.length - 1];
		const last2 = vertices[vertices.length - 2];
		expect(last).toEqual({ distNM: 80, altFt: 500 });
		expect(last2.altFt).toBe(6000);
		expect(last2.distNM).toBeCloseTo(80 - ramp(5500), 2);
		expectMonotonic(vertices);
	});

	it('adjacent legs at the same altitude hold level across the fix', () => {
		const { vertices, markers } = buildAltitudePath([5000, 5000], [0, 30, 60], 0, 0);
		expect(markers[1].altFt).toBe(5000);
		expect(vertices).toContainEqual({ distNM: 30, altFt: 5000 });
		// no transition: nothing dips/peaks away from 5000 between the climb and descent
		const mid = vertices.filter((v) => v.distNM > ramp(5000) + 0.1 && v.distNM < 60 - ramp(5000) - 0.1);
		expect(mid.every((v) => v.altFt === 5000)).toBe(true);
	});

	it('short interior leg: ramps cross with no overshoot, stays monotonic', () => {
		const { vertices } = buildAltitudePath([1000, 9000, 1000], [0, 50, 53, 103], 0, 0);
		for (const v of vertices) {
			expect(v.altFt).toBeGreaterThanOrEqual(0);
			expect(v.altFt).toBeLessThanOrEqual(9000); // never above the highest leg
		}
		const midV = vertices.filter((v) => v.distNM >= 50 - 1e-6 && v.distNM <= 53 + 1e-6);
		for (const v of midV) {
			expect(v.altFt).toBeGreaterThanOrEqual(1000);
			expect(v.altFt).toBeLessThanOrEqual(9000);
		}
		expectMonotonic(vertices);
	});

	it('big step on a short start leg: single steeper segment from the ground', () => {
		const { vertices, markers } = buildAltitudePath([8000, 2000], [0, 4, 40], 0, 0);
		expect(vertices[0]).toEqual({ distNM: 0, altFt: 0 });
		// leg 0 climbs to 8000 by the fix (steeper than 3 deg on the short 4 NM leg)
		expect(markers[1].altFt).toBe(8000);
		expectMonotonic(vertices);
	});

	it('markers: one per waypoint, ends on the ground regardless of leg altitudes', () => {
		const { markers } = buildAltitudePath([8000, 8000], [0, 50, 100], 1000, 300);
		expect(markers).toHaveLength(3);
		expect(markers[0].altFt).toBe(1000);
		expect(markers[2].altFt).toBe(300);
	});

	it('< 2 waypoints -> empty', () => {
		expect(buildAltitudePath([], [0], 0, 0)).toEqual({ vertices: [], markers: [] });
		expect(buildAltitudePath([], [], 0, 0)).toEqual({ vertices: [], markers: [] });
	});

	it('mixed climbs and descents stay monotonic; markers track the waypoint distances', () => {
		const { vertices, markers } = buildAltitudePath([4000, 7000, 3000], [0, 20, 35, 70], 500, 500);
		expectMonotonic(vertices);
		expect(markers.map((m) => m.distNM)).toEqual([0, 20, 35, 70]);
	});

	it('zero-length leg: finite vertices, monotonic, no divide-by-zero', () => {
		const { vertices, markers } = buildAltitudePath([3000, 5000], [0, 0, 40], 0, 0);
		for (const v of vertices) {
			expect(Number.isFinite(v.distNM)).toBe(true);
			expect(Number.isFinite(v.altFt)).toBe(true);
		}
		expectMonotonic(vertices);
		expect(markers[1].distNM).toBe(0);
	});

	it('coincident ends (total distance 0): a single ground vertex', () => {
		const { vertices } = buildAltitudePath([2000], [0, 0], 100, 100);
		expect(vertices).toEqual([{ distNM: 0, altFt: 100 }]);
	});

	it('distinct gradients: rising ramps at the climb slope, falling at the descent slope', () => {
		// climb 500 ft/NM, descent 250 ft/NM.
		const { vertices } = buildAltitudePath([3000, 6000, 2000], [0, 40, 80, 130], 500, 500, 500, 250);
		// departure climb: 2500 ft / 500 = 5 NM after the first fix
		expect(vertices[1].distNM).toBeCloseTo(5, 9);
		expect(vertices[1].altFt).toBe(3000);
		// interior climb 3000 -> 6000 after the fix at 40: 3000 / 500 = 6 NM
		const up = vertices.find((v) => v.altFt === 6000);
		expect(up?.distNM).toBeCloseTo(46, 9);
		// interior descent 6000 -> 2000 after the fix at 80: 4000 / 250 = 16 NM
		const down = vertices.find((v) => v.altFt === 2000);
		expect(down?.distNM).toBeCloseTo(96, 9);
		// arrival descent 1500 ft / 250 = 6 NM before the destination
		const last2 = vertices[vertices.length - 2];
		expect(last2.altFt).toBe(2000);
		expect(last2.distNM).toBeCloseTo(124, 9);
		expectMonotonic(vertices);
	});

	it('too-short single leg with distinct gradients: apex at the crossover', () => {
		// x = (dGrad D + gE - gS) / (cGrad + dGrad) = (250 * 10) / 1250 = 2 NM.
		const { vertices } = buildAltitudePath([9000], [0, 10], 0, 0, 1000, 250);
		expect(vertices).toHaveLength(3);
		expect(vertices[1].distNM).toBeCloseTo(2, 9);
		expect(vertices[1].altFt).toBeCloseTo(2000, 9);
	});

	it('default gradients stay the symmetric 3 degrees (4-arg calls unchanged)', () => {
		const symmetric = buildAltitudePath([2000], [0, 10], 500, 500);
		const explicit = buildAltitudePath([2000], [0, 10], 500, 500, FT_PER_NM_3DEG, FT_PER_NM_3DEG);
		expect(explicit).toEqual(symmetric);
	});
});

describe('buildRouteProfileDoc', () => {
	/** An airport-anchored waypoint (the chart ends ground on field elevation). */
	const awp = (id: string, lat: number, lon: number, ident: string, alt = 3000): Waypoint => ({
		...wp(id, lat, lon, alt),
		kind: 'airport',
		refId: ident,
		ident,
	});
	const terrain: TerrainSample[] = [
		{ distNM: 0, elevFt: 200 },
		{ distNM: 120, elevFt: 1200 },
		{ distNM: 240, elevFt: 100 },
	];
	const elev = (ident: string): number | null =>
		ident === 'LFAA' ? 350 : ident === 'LFBB' ? 800 : null;

	it('builds the full document for an anchored route crossing a box airspace', () => {
		// 4-degree east-west run at the equator (~240 NM) through lon 0..2.
		const route = [awp('a', 0, -1, 'LFAA'), wp('b', 0, 1, 4000), awp('c', 0, 3, 'LFBB')];
		const b = box({ key: 'BOX', latMin: -1, lonMin: 0, latMax: 1, lonMax: 2 });
		const doc = buildRouteProfileDoc({
			waypoints: route,
			cruiseSpeedKt: 120,
			airspaces: [b],
			terrain,
			airportElevFt: elev,
			typeLabels: EN_TYPE_LABELS,
		});
		expect(doc.totalNM).toBeGreaterThan(235);
		expect(doc.totalNM).toBeLessThan(245);
		expect(doc.totalEteMin).toBeCloseTo((doc.totalNM / 120) * 60, 6);
		expect(doc.wpPoints.map((w) => w.label)).toEqual(['LFAA', '', 'LFBB']);
		expect(doc.wpPoints[0].distNM).toBe(0);
		expect(doc.wpPoints[2].distNM).toBeCloseTo(doc.totalNM, 6);
		expect(doc.corridorBands).toHaveLength(1);
		expect(doc.placedBands).toHaveLength(1);
		expect(doc.legAltsFt).toEqual([3000, 4000]);
		// The route line grounds on the charted field elevations.
		const v = doc.altitudePath.vertices;
		expect(v[0]).toEqual({ distNM: 0, altFt: 350 });
		expect(v[v.length - 1].altFt).toBe(800);
		// Fit ceiling: the route peak (4000 ft, above the 1200 ft terrain) 3/4 up.
		expect(doc.fitCeilingFt).toBeCloseTo(4000 / 0.75, 6);
	});

	it('grounds on terrain when the end is free or the field elevation is unknown', () => {
		const free = buildRouteProfileDoc({
			waypoints: [wp('a', 0, -1), wp('b', 0, 3)],
			cruiseSpeedKt: 120,
			airspaces: null,
			terrain,
			airportElevFt: elev,
			typeLabels: EN_TYPE_LABELS,
		});
		expect(free.altitudePath.vertices[0].altFt).toBe(200); // nearest sample at 0 NM
		expect(free.placedBands).toEqual([]); // no airspaces loaded -> no bands

		const unknown = buildRouteProfileDoc({
			waypoints: [awp('a', 0, -1, 'XXXX'), awp('b', 0, 3, 'YYYY')],
			cruiseSpeedKt: 120,
			airspaces: null,
			terrain,
			airportElevFt: () => null,
			typeLabels: EN_TYPE_LABELS,
		});
		expect(unknown.altitudePath.vertices[0].altFt).toBe(200);

		const bare = buildRouteProfileDoc({
			waypoints: [wp('a', 0, -1), wp('b', 0, 3)],
			cruiseSpeedKt: 120,
			airspaces: null,
			terrain: [],
			airportElevFt: () => null,
			typeLabels: EN_TYPE_LABELS,
		});
		expect(bare.altitudePath.vertices[0].altFt).toBe(0); // no terrain at all -> sea level
	});

	it('threads the aircraft climb / descent gradients into the altitude path', () => {
		// Flat 200 ft terrain end, one 3000 ft leg over ~120 NM: with a 500 ft/NM
		// climb the cruise is reached 2800 / 500 = 5.6 NM out; the 3-degree
		// default would need ~8.8 NM.
		const doc = buildRouteProfileDoc({
			waypoints: [wp('a', 0, -1), wp('b', 0, 1)],
			cruiseSpeedKt: 120,
			airspaces: null,
			terrain,
			airportElevFt: () => null,
			typeLabels: EN_TYPE_LABELS,
			climbGradFtPerNM: 500,
			descentGradFtPerNM: 250,
		});
		const v = doc.altitudePath.vertices;
		expect(v[0].altFt).toBe(200);
		expect(v[1].altFt).toBe(3000);
		expect(v[1].distNM).toBeCloseTo((3000 - 200) / 500, 6);
		// null gradients fall back to the 3-degree default.
		const fallback = buildRouteProfileDoc({
			waypoints: [wp('a', 0, -1), wp('b', 0, 1)],
			cruiseSpeedKt: 120,
			airspaces: null,
			terrain,
			airportElevFt: () => null,
			typeLabels: EN_TYPE_LABELS,
			climbGradFtPerNM: null,
			descentGradFtPerNM: null,
		});
		expect(fallback.altitudePath.vertices[1].distNM).toBeCloseTo(ramp(2800), 6);
	});

	it('degenerate routes: empty document, fit ceiling floored at 1000 ft', () => {
		for (const route of [[], [wp('a', 0, 0)]]) {
			const doc = buildRouteProfileDoc({
				waypoints: route,
				cruiseSpeedKt: null,
				airspaces: null,
				terrain: [],
				airportElevFt: () => null,
				typeLabels: EN_TYPE_LABELS,
			});
			expect(doc.wpPoints).toEqual([]);
			expect(doc.altitudePath).toEqual({ vertices: [], markers: [] });
			expect(doc.totalNM).toBe(0);
			expect(doc.totalEteMin).toBeNull();
			expect(doc.fitCeilingFt).toBe(1000);
		}
	});
});
