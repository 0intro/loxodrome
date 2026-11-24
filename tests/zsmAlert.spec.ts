/* The raptor zones in the alerts (nav/alertVolumes.ts zsmVolumes,
 * nav/alertRules.ts, components/alertText.ts): a zone the STAC marks active
 * is a volume from the surface to the height to overfly it at, graded a
 * caution while its season holds, silent above that height and outside the
 * season, and its line asks to avoid it or overfly it at that height. */

import { describe, expect, it } from 'vitest';
import { emptyAlertPrev, evaluateAlerts, type AlertInput } from '$lib/nav/airspaceAlert';
import { zsmVolumes } from '$lib/nav/alertVolumes';
import { classifyVolume } from '$lib/nav/alertRules';
import { ringAreaM2, ringBbox } from '$lib/notam/geometry';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';
import type { Zsm } from '$lib/data/zsm';

const ring: [number, number][] = [
	[-0.05, -0.05],
	[-0.05, 0.05],
	[0.05, 0.05],
	[0.05, -0.05],
	[-0.05, -0.05],
];
const ZONE: Zsm = {
	id: 'zsm:5991',
	name: 'Le Rompeau',
	species: 'Gypaète barbu',
	taxon: '2852',
	active: true,
	topM: 2110,
	overflyM: 3110,
	modified: '2026-10-31',
	ring,
	bbox: ringBbox(ring),
	areaM2: ringAreaM2(ring),
};
const NOV = Date.parse('2026-11-23T10:00:00Z');
const SEPT = Date.parse('2027-09-10T10:00:00Z');

function input(mslFt: number, nowMs: number, zone: Zsm = ZONE): AlertInput {
	return {
		nowMs,
		pose: { lat: 0, lon: 0, mslFt, altTrusted: true, trackDeg: 90, speedKt: 100, vsFpm: 0 },
		volumes: zsmVolumes([zone]),
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
}

describe('a raptor zone in the alerts', () => {
	it('is a volume from the surface to its overflight height, named ZSM', () => {
		const [v] = zsmVolumes([ZONE]);
		expect(v.name).toBe('ZSM Le Rompeau');
		expect(v.vLower?.ft).toBe(0);
		expect(v.vUpper?.ref).toBe('AMSL');
		expect(v.vUpper?.value).toBe(3110);
		expect(v.vUpper?.unit).toBe('m');
		expect(Math.round(v.vUpper?.ft ?? 0)).toBe(10203);
		expect(classifyVolume(v, 'active', { vfr: true })).toBe('caution');
		expect(classifyVolume(v, 'inactive', { vfr: true })).toBe('none');
	});

	it('alerts a caution inside its band in season, and nothing above it or out of season', () => {
		const inside = evaluateAlerts(input(8000, NOV), emptyAlertPrev());
		expect(inside.dominant?.severity).toBe('inside');
		expect(inside.dominant?.action).toBe('caution');
		expect(evaluateAlerts(input(12000, NOV), emptyAlertPrev()).dominant).toBeNull();
		expect(evaluateAlerts(input(8000, SEPT), emptyAlertPrev()).dominant).toBeNull();
		expect(evaluateAlerts(input(8000, NOV, { ...ZONE, active: false }), emptyAlertPrev()).dominant).toBeNull();
	});

	it('asks to avoid it or overfly it at its height, in both languages', () => {
		expect(en.navigation.alertZsm('10 200 ft (3 110 m)')).toBe('avoid or overfly above 10 200 ft (3 110 m)');
		expect(fr.navigation.alertZsm('X')).toBe('à contourner ou survoler au-dessus de X');
	});
});
