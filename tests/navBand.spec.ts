/* Pins the in-flight band's pure cells (nav/bandCells.ts): the live heading
 * to steer and its honest fallback, the plog-shared DTK, the AGL, the ETA
 * suffix, the compact cross-track, and the tap-to-cycle ring rules. */

import { describe, expect, it } from 'vitest';
import {
	RING_ENTRIES,
	advanceRing,
	aglFt,
	dtkMagDeg,
	liveHeadingMagDeg,
	planDeltaSuffix,
	resolveRingPos,
	ringHasAlternate,
	xtkCompact,
} from '$lib/nav/bandCells';
import { initialBearingDeg } from '$lib/notam/geometry';
import { legMagneticTrackDeg, magneticFromTrue } from '$lib/route/magnetic';

const YEAR = 2026.7;
/** Flying west near Paris: the bearing to the target is about 270 true. */
const POSE = { lat: 48.5, lon: 2.5 };
const WEST = { lat: 48.5, lon: 1.5 };

describe('liveHeadingMagDeg', () => {
	it('reads the magnetic bearing to the target in calm wind, labelled MH', () => {
		const h = liveHeadingMagDeg({ pose: POSE, target: WEST, wind: { dirDeg: 90, speedKt: 0 }, tasKt: 100, timeYears: YEAR });
		const brgTrue = initialBearingDeg(POSE.lat, POSE.lon, WEST.lat, WEST.lon);
		expect(h.kind).toBe('mh');
		expect(h.wcaDeg).toBeCloseTo(0, 6);
		expect(h.deg).toBeCloseTo(magneticFromTrue(brgTrue, POSE.lat, POSE.lon, YEAR), 6);
	});

	it('corrects INTO a wind from the right, so the heading lies right of the bearing', () => {
		// Heading west, the north is to the right: a northerly wind asks for a
		// heading right of the bearing by asin(20/100) ≈ 11.5 degrees.
		const h = liveHeadingMagDeg({ pose: POSE, target: WEST, wind: { dirDeg: 360, speedKt: 20 }, tasKt: 100, timeYears: YEAR });
		const brgTrue = initialBearingDeg(POSE.lat, POSE.lon, WEST.lat, WEST.lon);
		expect(h.kind).toBe('mh');
		expect(h.wcaDeg).toBeGreaterThan(11);
		expect(h.wcaDeg).toBeLessThan(12);
		expect(h.deg).toBeCloseTo(magneticFromTrue(brgTrue + h.wcaDeg, POSE.lat, POSE.lon, YEAR), 6);
	});

	it('falls back to the bare bearing, labelled BRG, without a wind or a TAS', () => {
		const brgTrue = initialBearingDeg(POSE.lat, POSE.lon, WEST.lat, WEST.lon);
		const want = magneticFromTrue(brgTrue, POSE.lat, POSE.lon, YEAR);
		expect(liveHeadingMagDeg({ pose: POSE, target: WEST, wind: null, tasKt: 100, timeYears: YEAR })).toEqual({ kind: 'brg', deg: want, wcaDeg: 0 });
		expect(liveHeadingMagDeg({ pose: POSE, target: WEST, wind: { dirDeg: 360, speedKt: 20 }, tasKt: null, timeYears: YEAR })).toEqual({ kind: 'brg', deg: want, wcaDeg: 0 });
	});

	it('falls back to the bearing when the triangle has no solution', () => {
		// A 120 kt crosswind at 100 kt TAS cannot be held.
		const h = liveHeadingMagDeg({ pose: POSE, target: WEST, wind: { dirDeg: 360, speedKt: 120 }, tasKt: 100, timeYears: YEAR });
		expect(h.kind).toBe('brg');
	});

	it('takes the variation at the POSE, not at the target', () => {
		const far = { lat: 48.5, lon: -5 };
		const h = liveHeadingMagDeg({ pose: POSE, target: far, wind: null, tasKt: null, timeYears: YEAR });
		const brgTrue = initialBearingDeg(POSE.lat, POSE.lon, far.lat, far.lon);
		expect(h.deg).toBeCloseTo(magneticFromTrue(brgTrue, POSE.lat, POSE.lon, YEAR), 6);
		expect(h.deg).not.toBeCloseTo(magneticFromTrue(brgTrue, far.lat, far.lon, YEAR), 1);
	});
});

describe('dtkMagDeg', () => {
	it('is the nav-log recipe: variation at the leg midpoint', () => {
		expect(dtkMagDeg(268.3, POSE, WEST, YEAR)).toBe(legMagneticTrackDeg(268.3, POSE, WEST, YEAR));
	});
});

describe('aglFt', () => {
	it('subtracts the ground and rounds', () => {
		expect(aglFt(1971.4, 341.2)).toBe(1630);
	});
	it('is null without either reading, and negative rather than clamped', () => {
		expect(aglFt(null, 300)).toBeNull();
		expect(aglFt(1000, null)).toBeNull();
		expect(aglFt(100, 300)).toBe(-200);
	});
});

describe('planDeltaSuffix', () => {
	it('signs the minutes behind or ahead of the plan and stays silent on time', () => {
		expect(planDeltaSuffix(1.2)).toBe('+1');
		expect(planDeltaSuffix(-2.6)).toBe('-3');
		expect(planDeltaSuffix(0.4)).toBe('');
		expect(planDeltaSuffix(null)).toBe('');
	});
});

describe('xtkCompact', () => {
	it('fits the cross-track into five characters with its side', () => {
		expect(xtkCompact(0.34, 1)).toBe('0.3R');
		expect(xtkCompact(12.4, -1)).toBe('12L');
		expect(xtkCompact(0.04, 1)).toBe('0');
		expect(xtkCompact(2, 0)).toBe('0');
		expect(xtkCompact(null, 1)).toBe('');
	});
});

describe('rings', () => {
	const all = [true, true, true];

	it('lists the primary reading first for every ring', () => {
		expect(RING_ENTRIES.freq[0]).toBe('current');
		expect(RING_ENTRIES.next[0]).toBe('wpt');
		expect(RING_ENTRIES.mh[0]).toBe('mh');
		expect(RING_ENTRIES.trk[0]).toBe('trk');
		expect(RING_ENTRIES.alt[0]).toBe('gps');
		expect(RING_ENTRIES.eta[0]).toBe('eta');
	});

	it('advances to the next reading with data and wraps', () => {
		expect(advanceRing('alt', 0, all)).toBe(1);
		expect(advanceRing('alt', 2, all)).toBe(0);
		expect(advanceRing('alt', 0, [true, false, true])).toBe(2);
	});

	it('stays put when nothing else has data, and says so', () => {
		expect(advanceRing('alt', 0, [true, false, false])).toBe(0);
		expect(ringHasAlternate('alt', 0, [true, false, false])).toBe(false);
		expect(ringHasAlternate('alt', 0, all)).toBe(true);
	});

	it('keeps a tap while its subject stands', () => {
		expect(resolveRingPos('mh', { pos: 1, key: 'r1|leg3' }, 'r1|leg3', [true, true])).toBe(1);
	});

	it('returns to the primary when the subject changes', () => {
		expect(resolveRingPos('mh', { pos: 1, key: 'r1|leg3' }, 'r1|leg4', [true, true])).toBe(0);
		expect(resolveRingPos('freq', { pos: 1, key: 'SIV SEINE|FIC PARIS' }, 'FIC PARIS|', [true, false, false])).toBe(0);
	});

	it('returns to the primary when the remembered reading lost its data', () => {
		expect(resolveRingPos('alt', { pos: 1, key: 'k' }, 'k', [true, false, true])).toBe(0);
	});

	it('shows the first reading with data when the primary has none', () => {
		// No route contact, an overflown field: the frequency cell shows it.
		expect(resolveRingPos('freq', null, 'k', [false, false, true])).toBe(2);
		expect(resolveRingPos('freq', null, 'k', [false, false, false])).toBe(0);
	});
});
