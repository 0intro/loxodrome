/* Unit tests for the trace -> vertical-profile adapter: arc-length thinning,
 * closest-approach feature detection (with dedup + clutter exclusion), and the
 * replay time <-> distance mapping. */

import { describe, it, expect } from 'vitest';
import {
	thinTrace,
	detectFeatures,
	buildTraceProfileDoc,
	distNMAtTime,
	timeMsAtDistNM,
} from '$lib/nav/traceProfile';
import type { TrackPoint } from '$lib/nav/trace';
import type { Navaid, NavaidType } from '$lib/data/navaids';
import type { Waypoint } from '$lib/state/route.svelte';

function navaid(ident: string, lat: number, lon: number, type: NavaidType = 'VOR'): Navaid {
	return {
		id: ident,
		type,
		ident,
		name: `${ident} VOR`,
		lat,
		lon,
		freq: '',
		channel: '',
		elev: null,
		source: 'fr',
	};
}

function wp(ident: string, lat: number, lon: number): Waypoint {
	return { id: ident, lat, lon, kind: 'navaid', refId: ident, ident, alt: 0, altAuto: false };
}

// A straight west -> east track at 48N, 0..3 deg longitude, one fix per second.
const track: TrackPoint[] = [
	{ lat: 48, lon: 0, altFt: 1000, timeMs: 0 },
	{ lat: 48, lon: 1, altFt: 2000, timeMs: 1000 },
	{ lat: 48, lon: 2, altFt: 3000, timeMs: 2000 },
	{ lat: 48, lon: 3, altFt: 4000, timeMs: 3000 },
];

describe('thinTrace', () => {
	it('keeps first and last, with cumNM monotonic from 0', () => {
		const th = thinTrace(track, 600);
		expect(th).toHaveLength(4);
		expect(th[0].cumNM).toBe(0);
		for (let i = 1; i < th.length; i++) {
			expect(th[i].cumNM).toBeGreaterThan(th[i - 1].cumNM);
		}
		// ~40 NM per degree of longitude at 48N.
		expect(th[3].cumNM).toBeGreaterThan(115);
		expect(th[3].cumNM).toBeLessThan(125);
	});

	it('decimates a dense trace but keeps the ends', () => {
		const dense: TrackPoint[] = Array.from({ length: 500 }, (_, i) => ({
			lat: 48,
			lon: i / 100,
			altFt: null,
			timeMs: i * 1000,
		}));
		const th = thinTrace(dense, 50);
		expect(th.length).toBeLessThanOrEqual(60);
		expect(th[0].lon).toBe(0);
		expect(th[th.length - 1].lon).toBeCloseTo(4.99, 5);
	});
});

describe('detectFeatures', () => {
	const thinned = thinTrace(track);

	it('places a nearby navaid at its closest-approach distance', () => {
		const { features, refs } = detectFeatures(thinned, null, null, [navaid('ABC', 48, 1.5)]);
		expect(features).toHaveLength(1);
		expect(features[0].label).toBe('ABC');
		expect(features[0].name).toBe('ABC VOR');
		// Abeam at lon 1.5, about 60 NM along the track.
		expect(features[0].distNM).toBeGreaterThan(55);
		expect(features[0].distNM).toBeLessThan(65);
		// The identity rides the parallel refs array (same index).
		expect(refs).toHaveLength(1);
		expect(refs[0]).toEqual({ kind: 'navaid', id: 'ABC' });
	});

	it('excludes a far navaid and RNAV waypoints', () => {
		const { features, refs } = detectFeatures(thinned, null, null, [
			navaid('FAR', 50, 1.5), // ~120 NM north of the track
			navaid('RNAV', 48, 1.5, 'WAYPOINT'), // clutter type
		]);
		expect(features).toHaveLength(0);
		expect(refs).toHaveLength(0);
	});

	it('dedupes a route waypoint against a same-ident navaid (route wins)', () => {
		const { features, refs } = detectFeatures(thinned, [wp('ABC', 48, 1.5)], null, [
			navaid('ABC', 48, 1.5),
		]);
		expect(features.filter((f) => f.label === 'ABC')).toHaveLength(1);
		// The winning route waypoint is navaid-kind with a refId: navaid ref.
		expect(refs[features.findIndex((f) => f.label === 'ABC')]).toEqual({
			kind: 'navaid',
			id: 'ABC',
		});
	});

	it('keeps refs index-parallel across the distance sort', () => {
		// A free route waypoint early on the track + an airport-kind waypoint
		// later: refs must follow their features through the sort.
		const free: Waypoint = { id: 'f1', lat: 48, lon: 0.2, kind: 'free', alt: 0, altAuto: false };
		const apt: Waypoint = {
			id: 'a1',
			lat: 48,
			lon: 2.5,
			kind: 'airport',
			refId: 'lfxx',
			ident: 'LFXX',
			alt: 0,
			altAuto: false,
		};
		const { features, refs } = detectFeatures(thinned, [apt, free], null, null);
		expect(features).toHaveLength(2);
		expect(features[0].distNM).toBeLessThan(features[1].distNM);
		expect(refs[features.findIndex((f) => f.label === 'LFXX')]).toEqual({
			kind: 'airport',
			id: 'LFXX', // upper-cased for the airport panel target
		});
		const freeIdx = features.findIndex((f) => f.label === '');
		expect(refs[freeIdx]).toEqual({ kind: 'point', lat: 48, lon: 0.2 });
		expect(features[freeIdx].distNM).toBeLessThan(10);
	});
});

describe('buildTraceProfileDoc + playhead mapping', () => {
	const doc = buildTraceProfileDoc({
		thinned: thinTrace(track),
		airspaces: null,
		terrain: [],
		route: null,
		airports: null,
		navaids: null,
		typeLabels: {},
	});

	it('draws the recorded altitude with no waypoint markers', () => {
		expect(doc.altitudePath.markers).toHaveLength(0);
		expect(doc.altitudePath.vertices.length).toBeGreaterThanOrEqual(2);
		expect(doc.altitudePath.vertices[0].altFt).toBe(1000);
	});

	it('maps replay time to distance and back', () => {
		const nm = distNMAtTime(doc.timeline, 1500);
		expect(nm).toBeGreaterThan(0);
		expect(nm).toBeLessThan(doc.totalNM);
		expect(timeMsAtDistNM(doc.timeline, nm)).toBeCloseTo(1500, 0);
	});

	it('clamps the playhead to the ends', () => {
		expect(distNMAtTime(doc.timeline, -100)).toBe(0);
		expect(distNMAtTime(doc.timeline, 9_999_999)).toBeCloseTo(doc.totalNM, 6);
	});
});
