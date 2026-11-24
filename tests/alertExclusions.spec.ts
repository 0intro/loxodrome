// A SUP zone's exclusion sectors in the alerts: the zone alerts as its most
// severe piece, the zone with its sectors taken out while they hold, and
// each sector's footprint with the band the zone keeps there
// (nav/alertVolumes.ts exclusionPieces, nav/airspaceAlert.ts pieceGeometry).
import { describe, expect, it } from 'vitest';
import {
	emptyAlertPrev,
	evaluateAlerts,
	type AlertInput,
	type AlertPose,
} from '$lib/nav/airspaceAlert';
import { supaipVolumes } from '$lib/nav/alertVolumes';
import type { SupAip, SupAipExclusion, SupAipHours } from '$lib/data/supaip';
import { ringBbox } from '$lib/notam/geometry';
import { fromTriple, type VerticalLimit } from '$lib/vertical/limits';

const SFC: VerticalLimit = ['HEI', '0', 'FT'];
const ASFC_1500: VerticalLimit = ['HEI', '1500', 'FT'];
const FL115: VerticalLimit = ['STD', '115', 'FL'];

const RING: [number, number][] = [
	[-0.2, -0.2],
	[-0.2, 0.4],
	[0.2, 0.4],
	[0.2, -0.2],
];

/** A circular sector of 5 km about (0, 0), inside the zone. */
function sector(lower: VerticalLimit, upper: VerticalLimit, hours: SupAipHours[] = []): SupAipExclusion {
	return {
		name: 'CONDOM',
		geometry: { type: 'circle', center: [0, 0], radiusM: 5000 },
		bbox: { minLat: -0.05, minLon: -0.05, maxLat: 0.05, maxLon: 0.05 },
		lower,
		upper,
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
		hours,
	};
}

function sup(exclusions: SupAipExclusion[], lower = SFC, upper = FL115): SupAip {
	return {
		id: 'metropole-2026-228',
		title: '228/2026',
		number: 228,
		year: 2026,
		region: 'metropole',
		descriptionFr: '',
		descriptionEn: '',
		lieu: '',
		urlPdf: '',
		urlPdfEn: '',
		validFrom: '2026-07-01',
		validTo: '2026-07-31',
		ifr: false,
		vfr: true,
		airac: false,
		fir: [],
		adhp: [],
		zones: [
			{
				name: 'ZRT CONDOM ALPHA',
				geometry: { type: 'polygon', ring: RING },
				bbox: ringBbox(RING),
				lower,
				upper,
				vLower: fromTriple(lower),
				vUpper: fromTriple(upper),
				geometrySource: 'pdf-polygon',
				sameAs: '',
				activations: [],
				exclusions,
				excluded: [],
				standing: [],
			},
		],
		bbox: ringBbox(RING),
		geometrySource: 'pdf-polygon',
		parseConfidence: 'high',
		warnings: [],
		contacts: [],
		penetration: null,
		manager: '',
		phones: [],
	};
}

const NOON = Date.parse('2026-07-10T12:00:00Z');
const NIGHT = Date.parse('2026-07-10T22:00:00Z');

/** Parked over a point at an altitude, ground at sea level: no projection. */
function at(lat: number, lon: number, mslFt: number, over: Partial<AlertPose> = {}): AlertPose {
	return { lat, lon, mslFt, altTrusted: true, trackDeg: 90, speedKt: 0, vsFpm: 0, ...over };
}

function alerts(s: SupAip, pose: AlertPose, nowMs = NOON) {
	const input: AlertInput = {
		nowMs,
		pose,
		volumes: supaipVolumes([s]),
		notamWindows: new Map(),
		briefed: { notam: true, rtba: true },
		plannedKeys: new Set(),
		acks: new Map(),
		profile: { vfr: true },
		params: { lookaheadMin: 5, imminentMin: 2, proximityNM: 0.5, verticalBufferFt: 200 },
		airborne: true,
		groundFt: 0,
		groundKnown: true,
		tiers: { avoid: true, clearance: true, equipment: true, caution: true },
	};
	return evaluateAlerts(input, emptyAlertPrev()).alerts.map((a) => [a.key, a.severity]);
}

const KEY = 'metropole-2026-228#0';

describe('a SUP zone its exclusion sectors cut', () => {
	it('keeps the sector clear below its top and the zone around it', () => {
		const s = sup([sector(SFC, ASFC_1500)]);
		expect(supaipVolumes([s])[0].pieces).toHaveLength(2);
		// In the circuit, under 1500 ft above the surface.
		expect(alerts(s, at(0, 0, 1000))).toEqual([]);
		// Over the sector, above its top: inside the ZRT.
		expect(alerts(s, at(0, 0, 2500))).toEqual([[KEY, 'inside']]);
		// Clear of the sector, at circuit height: inside the ZRT.
		expect(alerts(s, at(0, 0.3, 1000))).toEqual([[KEY, 'inside']]);
	});

	it('warns of the zone where the track leaves the sector', () => {
		// Eastbound at 120 kt from the sector's centre: its 5 km edge is
		// 81 s ahead, where the ZRT starts at the same height.
		const got = alerts(sup([sector(SFC, ASFC_1500)]), at(0, 0, 1000, { speedKt: 120 }));
		expect(got).toEqual([[KEY, 'imminent']]);
	});

	it('takes a sector out only in its hours', () => {
		const s = sup([sector(SFC, ASFC_1500, [{ sunFrom: 'SR', sunTo: 'SS' }])]);
		expect(alerts(s, at(0, 0, 1000), NOON)).toEqual([]);
		expect(alerts(s, at(0, 0, 1000), NIGHT)).toEqual([[KEY, 'inside']]);
	});

	it('keeps the zone floor over a sector topping out below it', () => {
		const s = sup([sector(SFC, ASFC_1500)], ['STD', '075', 'FL'], ['STD', '195', 'FL']);
		expect(alerts(s, at(0, 0, 3000))).toEqual([]);
		expect(alerts(s, at(0, 0, 9000))).toEqual([[KEY, 'inside']]);
	});

	it('keeps the band under a sector above the surface', () => {
		const s = sup([sector(['ALT', '1000', 'FT'], ['ALT', '2000', 'FT'])]);
		expect(supaipVolumes([s])[0].pieces).toHaveLength(3);
		expect(alerts(s, at(0, 0, 500))).toEqual([[KEY, 'inside']]);
		expect(alerts(s, at(0, 0, 1500))).toEqual([]);
		expect(alerts(s, at(0, 0, 2500))).toEqual([[KEY, 'inside']]);
	});
});
