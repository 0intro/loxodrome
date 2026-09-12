/* Semicircular cruising levels (src/lib/route/cruisingLevels.ts): the table
 * of cruising levels (ICAO Annex 2 / SERA Appendix 3), the SERA.5005(g) VFR
 * and SERA.5025(a) + FRA.5025 a) IFR applicability floors, the FL 195 VFR
 * ceiling, the ENR 1.7.5 UTA parity above FL 195 and the AIP France
 * ENR 1.7.2.3 transition level. The transitionLevelFt pins reproduce the
 * published French QNH tables for TA 5000 ft (FL 60 for 1013-1048, FL 70
 * for 977-1012). */

import { describe, it, expect } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import {
	applicabilityFloorFt,
	compliantLevels,
	computeCruiseAltitudes,
	EU_REGIME,
	inTransitionLayer,
	isCompliantLevel,
	oddHemicycle,
	snapToLevel,
	transitionLevelFt,
	US_REGIME,
	violatesSemicircular,
} from '$lib/route/cruisingLevels';
import {
	computeAutoAltitudes,
	cruisingRegimeForRoutes,
	derivedTransitionAltFt,
	transitionAltitudesInForce,
} from '$lib/route/airspaces';
import { fmtLevel, isFlightLevelAt } from '$lib/route/format';
import type { Waypoint } from '$lib/state/route.svelte';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';

let nextId = 0;
function wp(lat: number, lon: number, alt = 3000, altAuto = true): Waypoint {
	return { id: `t${nextId++}`, lat, lon, kind: 'free', alt, altAuto };
}

/** A Class A box over the test legs (the routePlanning.spec.ts idiom). */
function mkClassA(key: string, ring: [number, number][], lower: VerticalLimit): Airspace {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const [lat, lon] of ring) {
		minLat = Math.min(minLat, lat);
		maxLat = Math.max(maxLat, lat);
		minLon = Math.min(minLon, lon);
		maxLon = Math.max(maxLon, lon);
	}
	return {
		id: key,
		key,
		type: 'TMA',
		name: key,
		airClass: 'A',
		upper: ['STD', '195', 'FL'],
		lower,
		vUpper: fromTriple(['STD', '195', 'FL']),
		vLower: fromTriple(lower),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [],
		ring,
		subtype: '',
		category: 'controlled',
		source: 'fr',
		area: 1,
		bbox: { minLat, minLon, maxLat, maxLon },
	};
}

/** A FIR ring for the transition-layer scope test (category 'fir' drives
 *  firIdent, the id's first four letters are the indicator). */
function mkFir(id: string, ring: [number, number][]): Airspace {
	return { ...mkClassA(id, ring, ['HEI', '0', 'FT']), type: 'FIR', airClass: '', category: 'fir' };
}

/** A controlled terminal volume (TMA / CTR / DLG-ATS...) with its own band. */
function mkControlled(
	type: string,
	ring: [number, number][],
	lower: VerticalLimit,
	upper: VerticalLimit,
): Airspace {
	const base = mkClassA(`${type}-vol`, ring, lower);
	return { ...base, type, airClass: 'D', upper, vUpper: fromTriple(upper) };
}

describe('oddHemicycle', () => {
	it('splits the table at 180 with half-open ranges', () => {
		expect(oddHemicycle(0)).toBe(true);
		expect(oddHemicycle(90)).toBe(true);
		expect(oddHemicycle(179.9)).toBe(true);
		expect(oddHemicycle(180)).toBe(false);
		expect(oddHemicycle(270)).toBe(false);
		expect(oddHemicycle(359.9)).toBe(false);
		expect(oddHemicycle(360)).toBe(true);
		expect(oddHemicycle(-90)).toBe(false);
	});
});

describe('isCompliantLevel', () => {
	it('accepts VFR odd thousands + 500 on easterly tracks', () => {
		expect(isCompliantLevel(3500, 90, true)).toBe(true);
		expect(isCompliantLevel(5500, 90, true)).toBe(true);
		expect(isCompliantLevel(4500, 90, true)).toBe(false);
		expect(isCompliantLevel(4000, 90, true)).toBe(false);
		expect(isCompliantLevel(3000, 90, true)).toBe(false);
	});
	it('accepts VFR even thousands + 500 on westerly tracks', () => {
		expect(isCompliantLevel(4500, 270, true)).toBe(true);
		expect(isCompliantLevel(6500, 270, true)).toBe(true);
		expect(isCompliantLevel(5500, 270, true)).toBe(false);
	});
	it('accepts IFR whole thousands by parity', () => {
		expect(isCompliantLevel(3000, 90, false)).toBe(true);
		expect(isCompliantLevel(5000, 90, false)).toBe(true);
		expect(isCompliantLevel(4000, 90, false)).toBe(false);
		expect(isCompliantLevel(4000, 270, false)).toBe(true);
		expect(isCompliantLevel(3500, 90, false)).toBe(false);
	});
	it('caps VFR at FL 195 (SERA.5005(d)(2))', () => {
		expect(isCompliantLevel(19500, 90, true)).toBe(true);
		expect(isCompliantLevel(21500, 90, true)).toBe(false);
	});
	it('flips IFR parity above FL 195 (ENR 1.7.5 UTA: 090-269 odd, 270-089 even)', () => {
		// Lower airspace: eastbound odd thousands, up to FL 190.
		expect(isCompliantLevel(19000, 90, false)).toBe(true);
		// UTA: track 090 sits in the odd band (FL 210, 230, ...).
		expect(isCompliantLevel(21000, 90, false)).toBe(true);
		expect(isCompliantLevel(22000, 90, false)).toBe(false);
		// UTA: track 270 sits in the even band (FL 200, 220, ...).
		expect(isCompliantLevel(20000, 270, false)).toBe(true);
		expect(isCompliantLevel(21000, 270, false)).toBe(false);
		// Due north flips odd -> even in the UTA, due south even -> odd.
		expect(isCompliantLevel(20000, 0, false)).toBe(true);
		expect(isCompliantLevel(21000, 0, false)).toBe(false);
		expect(isCompliantLevel(21000, 180, false)).toBe(true);
	});
});

describe('cruising-level regime (US vs Europe)', () => {
	it('caps US VFR at 17 500 ft (Class A begins at 18 000, 14 CFR 91.135)', () => {
		// 17 500 is the highest legal US VFR eastbound level; 19 500 (a legal
		// eastbound level) is above the US ceiling but fine in Europe (FL 195).
		expect(isCompliantLevel(17500, 90, true, US_REGIME)).toBe(true);
		expect(isCompliantLevel(19500, 90, true, US_REGIME)).toBe(false);
		expect(isCompliantLevel(19500, 90, true, EU_REGIME)).toBe(true);
	});
	it('compliantLevels tops US VFR at 17 500 and Europe at 19 500', () => {
		const us = compliantLevels(90, true, { floorFt: 3000, capFt: 25000 }, US_REGIME);
		const eu = compliantLevels(90, true, { floorFt: 3000, capFt: 25000 }, EU_REGIME);
		expect(Math.max(...us)).toBe(17500);
		expect(Math.max(...eu)).toBe(19500);
	});
	it('uses standard hemispheric parity above FL 195 in the US (no UTA flip)', () => {
		// Eastbound (090) above FL 195: standard rule keeps odd thousands, so
		// FL 210 is legal and FL 200 is not; Europe's UTA flip is the opposite.
		expect(isCompliantLevel(21000, 90, false, US_REGIME)).toBe(true);
		expect(isCompliantLevel(20000, 90, false, US_REGIME)).toBe(false);
		expect(isCompliantLevel(21000, 90, false, EU_REGIME)).toBe(true);
		expect(isCompliantLevel(20000, 90, false, EU_REGIME)).toBe(false);
		// Westbound (270) above FL 195: US even thousands (FL 200); the European
		// UTA also puts 270 in the even band here, so this level agrees. The
		// distinguishing case is northbound: US keeps 270-089 even -> FL 200 at
		// track 0 illegal (odd band), while Europe's UTA makes it legal.
		expect(isCompliantLevel(20000, 0, false, US_REGIME)).toBe(false);
		expect(isCompliantLevel(21000, 0, false, US_REGIME)).toBe(true);
		expect(isCompliantLevel(20000, 0, false, EU_REGIME)).toBe(true);
	});
	it('violatesSemicircular flags an illegal US VFR level, clears in Europe', () => {
		expect(violatesSemicircular(19500, 90, true, 3000, US_REGIME)).toBe(true);
		expect(violatesSemicircular(19500, 90, true, 3000, EU_REGIME)).toBe(false);
	});
	it('snapToLevel keeps US VFR at or below 17 500', () => {
		// 19 500 is above the US VFR ceiling, so it snaps down to 17 500; in
		// Europe the same target is itself a legal level and stays.
		expect(snapToLevel(19500, 90, true, { floorFt: 3000 }, US_REGIME)).toBe(17500);
		expect(snapToLevel(19500, 90, true, { floorFt: 3000 }, EU_REGIME)).toBe(19500);
	});
	it('defaults to EU_REGIME when the regime argument is omitted', () => {
		expect(isCompliantLevel(19500, 90, true)).toBe(isCompliantLevel(19500, 90, true, EU_REGIME));
	});
});

describe('cruisingRegimeForRoutes', () => {
	// A US ARTCC-family ring: category 'fir' -> firIdent reads the id, which
	// begins with 'K' (the US blanket-TA prefix), so a waypoint inside it
	// selects US_REGIME.
	const kzab = mkFir('KZAB', [
		[34, -108],
		[34, -104],
		[36, -104],
		[36, -108],
	]);
	// A French FIR ring (LF prefix) for the European default.
	const lfff = mkFir('LFFF', [
		[47, 2],
		[47, 4],
		[49, 4],
		[49, 2],
	]);
	it('selects US_REGIME for a waypoint inside a K-prefix FIR', () => {
		expect(cruisingRegimeForRoutes([[wp(35, -106)]], [kzab, lfff])).toBe(US_REGIME);
	});
	it('selects EU_REGIME for a French / non-US route', () => {
		expect(cruisingRegimeForRoutes([[wp(48, 3)]], [kzab, lfff])).toBe(EU_REGIME);
	});
	it('defaults to EU_REGIME before the airspace dataset loads', () => {
		expect(cruisingRegimeForRoutes([[wp(35, -106)]], null)).toBe(EU_REGIME);
	});
});

describe('applicabilityFloorFt', () => {
	it('is 3000 ft above the minimum ground for VFR, sea level when unknown', () => {
		expect(applicabilityFloorFt(null, true)).toBe(3000);
		expect(applicabilityFloorFt(0, true)).toBe(3000);
		expect(applicabilityFloorFt(4200, true)).toBe(7200);
	});
	it('binds IFR from the lowest usable level: max(3000 AMSL, ground + 1000)', () => {
		// One foot below the boundary level, so the shared strictly-above
		// comparisons include the boundary itself (FRA.5025 a) is >=).
		expect(applicabilityFloorFt(null, false)).toBe(2999);
		expect(applicabilityFloorFt(0, false)).toBe(2999);
		expect(applicabilityFloorFt(1500, false)).toBe(2999);
		expect(applicabilityFloorFt(4200, false)).toBe(5199);
	});
});

describe('snapToLevel', () => {
	const floor = { floorFt: 3000 };
	it('snaps to the nearest compliant level', () => {
		expect(snapToLevel(6400, 90, true, floor)).toBe(5500);
		expect(snapToLevel(6600, 90, true, floor)).toBe(7500);
		expect(snapToLevel(4500, 90, true, floor)).toBe(3500);
		expect(snapToLevel(4500, 270, true, floor)).toBe(4500);
		expect(snapToLevel(6000, 90, false, floor)).toBe(5000);
	});
	it('resolves exact half-way ties down', () => {
		expect(snapToLevel(6500, 90, true, floor)).toBe(5500);
		expect(snapToLevel(5500, 270, true, floor)).toBe(4500);
	});
	it('keeps the result strictly above the applicability floor', () => {
		// Floor 7200 (ground 4200 ft): 6400 cannot stay near 5500, the first
		// level above the floor is 7500.
		expect(snapToLevel(6400, 90, true, { floorFt: 7200 })).toBe(7500);
		// A floor exactly on a level excludes it (strictly above).
		expect(snapToLevel(5500, 90, true, { floorFt: 5500 })).toBe(7500);
	});
	it('clamps below a Class A cap by whole level steps', () => {
		expect(snapToLevel(6000, 270, true, { floorFt: 3000, capFt: 6000 })).toBe(4500);
		expect(snapToLevel(6500, 270, true, { floorFt: 3000, capFt: 6500 })).toBe(6500);
	});
	it('returns null when no level fits the band', () => {
		expect(snapToLevel(8200, 90, true, { floorFt: 8000, capFt: 8400 })).toBe(null);
	});
	it('applies the VFR FL 195 ceiling and the IFR UTA parity above it', () => {
		expect(snapToLevel(22000, 90, true, floor)).toBe(19500);
		// IFR above FL 195: track-090 UTA levels are odd; 22000 ties DOWN.
		expect(snapToLevel(22000, 90, false, floor)).toBe(21000);
		// Track 270: even UTA levels; FL 220 is exact.
		expect(snapToLevel(22000, 270, false, floor)).toBe(22000);
	});
	it('snaps across the FL 195 boundary to the nearest of the two grids', () => {
		// Track 090: FL 190 tops the lower grid, FL 210 opens the UTA one.
		expect(snapToLevel(19600, 90, false, floor)).toBe(19000);
		expect(snapToLevel(20500, 90, false, floor)).toBe(21000);
		// Equidistant between the grids: the tie resolves DOWN.
		expect(snapToLevel(20000, 90, false, floor)).toBe(19000);
	});
});

describe('violatesSemicircular', () => {
	it('flags a non-compliant level only when the rule binds', () => {
		expect(violatesSemicircular(4600, 90, true, 3000)).toBe(true);
		expect(violatesSemicircular(4500, 270, true, 3000)).toBe(false);
		// At or below the floor: free level, never flagged.
		expect(violatesSemicircular(2900, 90, true, 3000)).toBe(false);
		expect(violatesSemicircular(3000, 90, true, 3000)).toBe(false);
		// Degenerate leg (no track): never flagged.
		expect(violatesSemicircular(4600, null, true, 3000)).toBe(false);
	});
	it('binds IFR at the lowest usable level and flips parity in the UTA', () => {
		const floor = applicabilityFloorFt(null, false);
		// Westbound at exactly 3000 ft AMSL: a usable level, wrong parity.
		expect(violatesSemicircular(3000, 270, false, floor)).toBe(true);
		expect(violatesSemicircular(3000, 90, false, floor)).toBe(false);
		// Below the lowest usable IFR level: not this badge's problem.
		expect(violatesSemicircular(2900, 270, false, floor)).toBe(false);
		// UTA: eastbound stays odd across FL 195 (the flip spares 090-179).
		expect(violatesSemicircular(22000, 90, false, floor)).toBe(true);
		expect(violatesSemicircular(21000, 90, false, floor)).toBe(false);
		// Northbound flips: odd below, even in the UTA.
		expect(violatesSemicircular(21000, 0, false, floor)).toBe(true);
		expect(violatesSemicircular(20000, 0, false, floor)).toBe(false);
	});
});

describe('transitionLevelFt', () => {
	it('is TA + 1000 ft without a QNH (standard band)', () => {
		expect(transitionLevelFt(5000, null)).toBe(6000);
		expect(transitionLevelFt(4000, null)).toBe(5000);
	});
	it('matches the published French table for TA 5000 ft', () => {
		expect(transitionLevelFt(5000, 1013)).toBe(6000);
		expect(transitionLevelFt(5000, 1048)).toBe(6000);
		expect(transitionLevelFt(5000, 1012)).toBe(7000);
		expect(transitionLevelFt(5000, 977)).toBe(7000);
		expect(transitionLevelFt(5000, 976)).toBe(8000);
		expect(transitionLevelFt(5000, 1049)).toBe(5000);
	});
});

describe('inTransitionLayer', () => {
	it('is strictly between TA and TL', () => {
		expect(inTransitionLayer(5500, 5000, 6000)).toBe(true);
		expect(inTransitionLayer(5000, 5000, 6000)).toBe(false);
		expect(inTransitionLayer(6000, 5000, 6000)).toBe(false);
	});
});

describe('fmtLevel / isFlightLevelAt', () => {
	it('switches to flight levels strictly above the transition altitude', () => {
		expect(isFlightLevelAt(4500, 5000)).toBe(false);
		expect(isFlightLevelAt(5000, 5000)).toBe(false);
		expect(isFlightLevelAt(5500, 5000)).toBe(true);
		expect(fmtLevel(4500, 5000)).toBe('4500');
		expect(fmtLevel(5000, 5000)).toBe('5000');
		expect(fmtLevel(6500, 5000)).toBe('FL 065');
		expect(fmtLevel(19500, 5000)).toBe('FL 195');
	});
});

describe('computeCruiseAltitudes', () => {
	// Due-east and due-west legs near Paris: the small local declination keeps
	// the magnetic track well inside the same hemicycle as the true track.
	const east = () => [wp(48, 2), wp(48, 3)];
	const west = () => [wp(48, 3), wp(48, 2)];
	const noElev = [null];
	const opts = (o: Partial<Parameters<typeof computeCruiseAltitudes>[1]>) => ({
		vfr: true,
		defaultFt: 4500,
		classA: null,
		semicircular: true,
		legMinElevFt: noElev,
		timeYears: 2026.0,
		...o,
	});

	it('is identical to computeAutoAltitudes with the option off', () => {
		const wps = east();
		const a = mkClassA('A1', [[47.5, 1.5], [48.5, 1.5], [48.5, 3.5], [47.5, 3.5]], ['ALT', '3400', 'FT']);
		expect(computeCruiseAltitudes(wps, opts({ semicircular: false, classA: [a] }))).toEqual(
			computeAutoAltitudes(wps, true, 4500, [a]),
		);
	});
	it('snaps auto targets to the leg parity, ties down', () => {
		// Eastbound (odd + 500): 4500 ties between 3500 and 5500, down to 3500.
		expect(computeCruiseAltitudes(east(), opts({}))).toEqual([3500]);
		// Westbound (even + 500): 4500 is already a cruising level.
		expect(computeCruiseAltitudes(west(), opts({}))).toEqual([4500]);
	});
	it('leaves legs at or below the applicability floor free', () => {
		expect(computeCruiseAltitudes(east(), opts({ defaultFt: 2000 }))).toEqual([2000]);
		expect(computeCruiseAltitudes(east(), opts({ defaultFt: 3000 }))).toEqual([3000]);
	});
	it('raises the floor with the leg minimum ground elevation', () => {
		// Ground 4200 ft: rule binds above 7200 ft only.
		expect(
			computeCruiseAltitudes(east(), opts({ defaultFt: 6400, legMinElevFt: [4200] })),
		).toEqual([6400]);
		expect(
			computeCruiseAltitudes(east(), opts({ defaultFt: 8400, legMinElevFt: [4200] })),
		).toEqual([7500]);
	});
	it('binds IFR down to the lowest usable level (FRA.5025 a))', () => {
		// Westbound at 3000 ft over the sea: wrong parity AT the boundary
		// level, snapped up to the even 4000 (2000 is below the usable band).
		expect(computeCruiseAltitudes(west(), opts({ vfr: false, defaultFt: 3000 }))).toEqual([4000]);
		// VFR at the same level stays free (binds strictly above 3000 ft AGL).
		expect(computeCruiseAltitudes(west(), opts({ defaultFt: 3000 }))).toEqual([3000]);
		// Ground 4200 ft: the IFR band starts at 5200 (1000 ft ASFC), so 4300
		// stays free while 6500 snaps to the even 6000.
		expect(
			computeCruiseAltitudes(west(), opts({ vfr: false, defaultFt: 4300, legMinElevFt: [4200] })),
		).toEqual([4300]);
		expect(
			computeCruiseAltitudes(west(), opts({ vfr: false, defaultFt: 6500, legMinElevFt: [4200] })),
		).toEqual([6000]);
	});
	it('keeps the Class A floor as the hard cap', () => {
		const a = mkClassA('A1', [[47.5, 1.5], [48.5, 1.5], [48.5, 3.5], [47.5, 3.5]], ['ALT', '4500', 'FT']);
		// Base is capped to 4500, which snaps down to the odd 3500.
		expect(computeCruiseAltitudes(east(), opts({ defaultFt: 6500, classA: [a] }))).toEqual([3500]);
	});
	it('keeps the unsnapped cap when no level fits between floor and cap', () => {
		const a = mkClassA('A1', [[47.5, 1.5], [48.5, 1.5], [48.5, 3.5], [47.5, 3.5]], ['ALT', '3400', 'FT']);
		// Cap 3400, floor 3000: the first eastbound level (3500) is above the
		// cap, so the leg keeps min(default, cap) = 3400.
		expect(computeCruiseAltitudes(east(), opts({ defaultFt: 6500, classA: [a] }))).toEqual([3400]);
	});
	it('never snaps a degenerate leg (no track)', () => {
		const a = wp(48, 2);
		const b = { ...wp(48, 2), lat: a.lat, lon: a.lon };
		expect(computeCruiseAltitudes([a, b], opts({}))).toEqual([4500]);
	});
});


describe('transitionAltitudesInForce', () => {
	// One leg near Paris at 5500 ft; the FIR box covers it, the volume boxes
	// cover the leg laterally.
	const leg = () => [wp(48, 2, 5500), wp(48, 3, 5500)];
	const firRing: [number, number][] = [[47, 1], [49, 1], [49, 4], [47, 4]];
	const volRing: [number, number][] = [[47.5, 1.5], [48.5, 1.5], [48.5, 3.5], [47.5, 3.5]];
	const lfff = () => mkFir('LFFF', firRing);

	it('keeps the advisory without airspace data or French FIR rows', () => {
		expect(transitionAltitudesInForce(leg(), null)).toEqual([true]);
		expect(transitionAltitudesInForce(leg(), [])).toEqual([true]);
		expect(
			transitionAltitudesInForce(leg(), [
				mkControlled('TMA', volRing, ['ALT', '1500', 'FT'], ['STD', '115', 'FL']),
			]),
		).toEqual([true]);
	});
	it('suppresses en route inside a French FIR with no volume at the level', () => {
		expect(transitionAltitudesInForce(leg(), [lfff()])).toEqual([false]);
	});
	it('keeps the advisory inside a TMA band at the leg level', () => {
		const tma = mkControlled('TMA', volRing, ['ALT', '1500', 'FT'], ['STD', '115', 'FL']);
		expect(transitionAltitudesInForce(leg(), [lfff(), tma])).toEqual([true]);
	});
	it('keeps the advisory inside a DLG-ATS delegated area (Geneva, Basel)', () => {
		const dlg = mkControlled('DLG-ATS', volRing, ['ALT', '1500', 'FT'], ['STD', '115', 'FL']);
		expect(transitionAltitudesInForce(leg(), [lfff(), dlg])).toEqual([true]);
	});
	it('suppresses under a shelf and exactly at a floor (en-route side)', () => {
		const shelf = mkControlled('TMA', volRing, ['STD', '085', 'FL'], ['STD', '115', 'FL']);
		expect(transitionAltitudesInForce(leg(), [lfff(), shelf])).toEqual([false]);
		const atFloor = mkControlled('TMA', volRing, ['ALT', '5500', 'FT'], ['STD', '115', 'FL']);
		expect(transitionAltitudesInForce(leg(), [lfff(), atFloor])).toEqual([false]);
	});
	it('ignores a low CTR far beneath the leg level', () => {
		const ctr = mkControlled('CTR', volRing, ['SFC', '', ''], ['ALT', '2500', 'FT']);
		expect(transitionAltitudesInForce(leg(), [lfff(), ctr])).toEqual([false]);
	});
	it('keeps the advisory when the leg leaves the French FIRs', () => {
		const westHalf = mkFir('LFFF', [[47, 1], [49, 1], [49, 2.5], [47, 2.5]]);
		expect(transitionAltitudesInForce(leg(), [westHalf])).toEqual([true]);
	});
	it('does not treat a foreign FIR as the French regime', () => {
		expect(transitionAltitudesInForce(leg(), [mkFir('EGTT', firRing)])).toEqual([true]);
	});
});

describe('derivedTransitionAltFt', () => {
	const ta =
		(m: Record<string, number>) =>
		(refId: string): number | null =>
			m[refId] ?? null;
	const apWp = (refId: string, lat = 48, lon = 2): Waypoint => ({
		...wp(lat, lon),
		kind: 'airport',
		refId,
		ident: refId,
	});
	const box: [number, number][] = [[47, 1], [49, 1], [49, 4], [47, 4]];

	it('takes the lowest published TA across all routes, ties to the first ident', () => {
		const lists = [[apWp('LFSB'), wp(48, 3)], [apWp('LFQB'), apWp('LFPG')]];
		expect(derivedTransitionAltFt(lists, ta({ LFSB: 7000, LFQB: 5000, LFPG: 5000 }), null)).toEqual({
			valueFt: 5000,
			source: { kind: 'aip', ident: 'LFPG' },
		});
	});
	it('prefers an aerodrome TA over any blanket', () => {
		expect(derivedTransitionAltFt([[apWp('EGTE')]], ta({ EGTE: 6000 }), [mkFir('EGTT', box)])).toEqual({
			valueFt: 6000,
			source: { kind: 'aip', ident: 'EGTE' },
		});
	});
	it('falls back to the containing FIR blanket (suffixed ids resolve)', () => {
		expect(derivedTransitionAltFt([[wp(48, 2)]], ta({}), [mkFir('EGTT001', box)])).toEqual({
			valueFt: 3000,
			source: { kind: 'blanket', region: 'UK' },
		});
	});
	it('applies the Brussels FIR blanket (4500 ft, joint Belgium + Luxembourg)', () => {
		expect(derivedTransitionAltFt([[wp(48, 2)]], ta({}), [mkFir('EBBU', box)])).toEqual({
			valueFt: 4500,
			source: { kind: 'blanket', region: 'Belgium' },
		});
	});
	it('accepts a UIR-typed FIR-family row (the deduped LECB shadow)', () => {
		const lecb = { ...mkFir('LECB', box), type: 'UIR' };
		expect(derivedTransitionAltFt([[wp(48, 2)]], ta({}), [lecb])).toEqual({
			valueFt: 6000,
			source: { kind: 'blanket', region: 'Spain' },
		});
	});
	it('takes the lowest blanket when several FIRs contain waypoints', () => {
		const kzny = mkFir('KZNY', [[40, -75], [42, -75], [42, -70], [40, -70]]);
		expect(
			derivedTransitionAltFt([[wp(48, 2)], [wp(41, -72)]], ta({}), [mkFir('EGTT', box), kzny]),
		).toEqual({ valueFt: 3000, source: { kind: 'blanket', region: 'UK' } });
	});
	it('defaults to 5000 inside France (per-TMA TAs only), on unresolved anchors and without data', () => {
		const dflt = { valueFt: 5000, source: { kind: 'default' } };
		expect(derivedTransitionAltFt([[wp(48, 2)]], ta({}), [mkFir('LFFF', box)])).toEqual(dflt);
		expect(derivedTransitionAltFt([[apWp('XXXX'), wp(48, 2)]], ta({}), null)).toEqual(dflt);
		expect(derivedTransitionAltFt([], ta({}), null)).toEqual(dflt);
	});
});
