/* The stretches the route sampler steps over (route/airspaces.ts
 * stretchesBetweenSamples): a zone narrower than the 1 NM step, or a corner
 * the route clips between two samples, is read from each leg's exact
 * crossings and added by every walk, the profile's bands, the strip's, the
 * schedules and the route-only map filter, where the samples alone missed
 * it. A crossing the samples see keeps the sampler's distances. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { AlertVolume } from '$lib/nav/alertVolumes';
import { segmentRingCrossings } from '$lib/notam/geometry';
import type { Notam } from '$lib/notam/types';
import {
	computeAirspaceCorridorSpans,
	computeAirspaceSchedule,
	routeAirspaceKeysAtAltitude,
	sampleRoute,
	temporaryZoneSchedule,
	type ScheduleZone,
} from '$lib/route/airspaces';
import { computeNotamProfileBands } from '$lib/route/notamProfile';
import { computeSupProfileBands } from '$lib/route/supProfile';
import type { Waypoint } from '$lib/state/route.svelte';
import { fromTriple, type VLimit } from '$lib/vertical/limits';

const wp = (lat: number, lon: number, alt = 2000): Waypoint => ({ id: `${lat},${lon}`, lat, lon, kind: 'free', alt, altAuto: false });

/** A box on the equator, so its crossings along a level route read off its
 *  longitudes: 1 degree of longitude is the route's whole length here. */
function box(key: string, lon0: number, lon1: number, ceilingFt = 5000): Airspace {
	const ring: [number, number][] = [
		[-0.01, lon0],
		[-0.01, lon1],
		[0.01, lon1],
		[0.01, lon0],
	];
	const upper: [string, string, string] = ['ALT', String(ceilingFt), 'FT'];
	const lower: [string, string, string] = ['SFC', '', ''];
	return {
		id: key,
		key,
		type: 'R',
		name: key,
		airClass: '',
		upper,
		lower,
		vUpper: fromTriple(upper),
		vLower: fromTriple(lower),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring,
		bbox: { minLat: -0.01, maxLat: 0.01, minLon: lon0, maxLon: lon1 },
		category: 'restricted',
	} as unknown as Airspace;
}

/** One leg along the equator, 60.1 NM, 61 samples about a mile apart: a
 *  longitude is a fraction of the leg. */
const ROUTE = [wp(0, 0), wp(0, 1)];
const SAMPLES = sampleRoute(ROUTE, 0);
const TOTAL = SAMPLES.at(-1)!.cumNM;
const [S30, S31] = [SAMPLES[30].lon, SAMPLES[31].lon];
/** A sliver 0.6 NM wide, between the 31st sample and the 32nd. */
const [LON0, LON1] = [S30 + 0.2 * (S31 - S30), S30 + 0.8 * (S31 - S30)];
const SLIVER = box('SLIVER', LON0, LON1);

describe('a zone between two samples', () => {
	it('LF-R 174 is crossed by every line across it', () => {
		const raw = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] };
		const r174 = raw.rows.map((r) => rowToAirspace(r, 'fr')).find((a) => a?.id === 'LFR174')!;
		let crossing = 0;
		let found = 0;
		for (let lat = 47.907; lat <= 47.936; lat += 0.001) {
			for (let west = 7; west < 7.1; west += 0.01) {
				if (segmentRingCrossings(lat, west, lat, 7.8, r174.ring).length === 0) {
					continue;
				}
				crossing++;
				found += computeAirspaceCorridorSpans([wp(lat, west), wp(lat, 7.8)], [r174]).some((b) => b.id === 'LFR174') ? 1 : 0;
			}
		}
		expect(crossing).toBeGreaterThan(250);
		expect(found).toBe(crossing);
	});

	it('enters and leaves where the leg crosses its edges', () => {
		const [band] = computeAirspaceCorridorSpans(ROUTE, [SLIVER]);
		expect(band.spans).toHaveLength(1);
		expect(band.spans[0].enterNM).toBeCloseTo(LON0 * TOTAL, 6);
		expect(band.spans[0].leaveNM).toBeCloseTo(LON1 * TOTAL, 6);
	});

	it('leaves a crossing the samples see on the samples, the distances every walk shares', () => {
		const [band] = computeAirspaceCorridorSpans(ROUTE, [box('WIDE', 0.4, 0.6)]);
		const nms = sampleRoute(ROUTE, 0).map((s) => s.cumNM);
		expect(band.spans).toHaveLength(1);
		expect(nms).toContain(band.spans[0].enterNM);
		expect(nms).toContain(band.spans[0].leaveNM);
	});

	it('takes its place in the schedule, at the level the leg flies', () => {
		const events = computeAirspaceSchedule(ROUTE, [box('WIDE', 0.4, 0.6), SLIVER], null, 2000);
		expect(events.map((e) => `${e.kind} ${e.key}`)).toEqual(['enter WIDE', 'enter SLIVER', 'leave SLIVER', 'leave WIDE']);
		expect(events[1].atNM).toBeCloseTo(LON0 * TOTAL, 6);
		// Flown over: the leg's level clears its ceiling.
		const high = [wp(0, 0, 6000), wp(0, 1, 6000)];
		expect(computeAirspaceSchedule(high, [SLIVER], null, 2000)).toEqual([]);
	});

	it('shows on the route-only map at the level flown', () => {
		expect(routeAirspaceKeysAtAltitude(ROUTE, [SLIVER], 2000)).toEqual(new Set(['SLIVER']));
		expect(routeAirspaceKeysAtAltitude([wp(0, 0, 6000), wp(0, 1, 6000)], [SLIVER], 2000)).toEqual(new Set());
	});
});

describe('a small circle between two samples', () => {
	// 0.15 NM of radius, centred half-way between the 31st sample and the 32nd.
	const at = { lat: 0, lon: (S30 + S31) / 2, radiusM: 0.15 * 1852 };
	const bbox = { minLat: -0.003, maxLat: 0.003, minLon: at.lon - 0.003, maxLon: at.lon + 0.003 };
	const limit = (triple: [string, string, string]): VLimit => fromTriple(triple)!;

	it('crosses the temporary zones schedule', () => {
		const zone: ScheduleZone = { key: 'sup:x#0', name: 'ZRT', rings: [], circles: [at], bbox, vLower: limit(['SFC', '', '']), vUpper: limit(['ALT', '3000', 'FT']) };
		const events = temporaryZoneSchedule(ROUTE, [zone], null, 2000);
		expect(events.map((e) => e.kind)).toEqual(['enter', 'leave']);
	});

	it('is a supplement band', () => {
		const volume = { id: 'metropole-2026-001#0', name: 'ZRT', vLower: null, vUpper: null, knownExtent: false, rings: [], circles: [at], bbox } as unknown as AlertVolume;
		const bands = computeSupProfileBands(ROUTE, [volume]);
		expect(bands.map((b) => b.spans.length)).toEqual([1]);
	});

	it('is a NOTAM band', () => {
		const notam = {
			id: 'R0001/26',
			fullContent: '',
			coordinates: [{ lat: at.lat, lon: at.lon, original: '', type: 'psn', radius: 0.15, radiusUnit: 'NM' }],
			icaoCodes: ['LFFF'],
			isPolygon: false,
			startDate: new Date('2026-11-23T00:00:00Z'),
			endDate: new Date('2026-11-30T00:00:00Z'),
			permanent: false,
			estimated: false,
			qCode: 'QRRCA',
			obstacleType: '',
			serviceStatus: '',
			qualifier: null,
			fgLower: null,
			fgUpper: null,
			replaces: null,
		} as unknown as Notam;
		const bands = computeNotamProfileBands(ROUTE, [{ notam, index: 0 }], () => false);
		expect(bands.map((b) => b.spans.length)).toEqual([1]);
	});
});
