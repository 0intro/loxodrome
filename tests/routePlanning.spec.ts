/* Unit tests for the pure route-planning logic: geodesy helpers, the nav-log
 * computation, the corridor bbox, and the airspace-traversal schedule. */

import { describe, it, expect } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import {
	initialBearingDeg,
	pointToSegmentDistanceM,
	pointToPolylineDistanceM,
} from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { computeNavLog } from '$lib/route/navlog';
import {
	computeAirspaceSchedule,
	enrouteFreqsByLeg,
	classAFloorForLeg,
	computeAutoAltitudes,
	type EnrouteFreqLine,
} from '$lib/route/airspaces';
import { routeCorridorBbox } from '$lib/autorouter/viewport';
import { freqSeedText, freqDisplayLines } from '$lib/route/format';
import {
	routeSettings,
	activeRoute,
	clearRoute,
	addWaypoint,
	setWaypointAltitude,
	setWaypointFreqs,
	clearWaypointFreqs,
	applyAutoAltitudes,
	MAX_LEG_ALT_FT,
	type Waypoint,
} from '$lib/state/route.svelte';
import type { Airspace, AirspaceRadio, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';

let nextId = 0;
function wp(lat: number, lon: number, alt = 3000, altAuto = true): Waypoint {
	return { id: `t${nextId++}`, lat, lon, kind: 'free', alt, altAuto };
}

/** A Class A airspace: like mkAirspace (which hard-codes class D) but airClass 'A'. */
function mkClassA(
	key: string,
	ring: [number, number][],
	lower: VerticalLimit | null,
	upper: VerticalLimit | null = ['STD', '195', 'FL'],
): Airspace {
	return { ...mkAirspace(key, ring, lower, upper), airClass: 'A' };
}

function mkAirspace(
	key: string,
	ring: [number, number][],
	lower: VerticalLimit | null = null,
	upper: VerticalLimit | null = null,
): Airspace {
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
		type: 'CTR',
		name: key,
		airClass: 'D',
		upper,
		lower,
		// Mirror the loader (source 'fr' normalizes legacy FL999 to UNL).
		vUpper: fromTriple(upper, { legacyFl999Unl: true }),
		vLower: fromTriple(lower, { legacyFl999Unl: true }),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		entry: NO_ENTRY,
		radio: [{ freq: '120.500', unit: 'TEST TWR', call: 'TEST Tower' }],
		ring,
		subtype: '',
		category: 'controlled',
		source: 'fr',
		area: 1,
		bbox: { minLat, minLon, maxLat, maxLon },
	};
}

describe('initialBearingDeg', () => {
	it('is 090 due east, 000 due north, 180 south, 270 west', () => {
		expect(initialBearingDeg(0, 0, 0, 1)).toBeCloseTo(90, 3);
		expect(initialBearingDeg(0, 0, 1, 0)).toBeCloseTo(0, 3);
		expect(initialBearingDeg(0, 0, -1, 0)).toBeCloseTo(180, 3);
		expect(initialBearingDeg(0, 0, 0, -1)).toBeCloseTo(270, 3);
	});

	it('returns 0 for coincident points', () => {
		expect(initialBearingDeg(48.5, 2.3, 48.5, 2.3)).toBe(0);
	});

	it('normalises into [0, 360)', () => {
		const b = initialBearingDeg(45, 5, 46, 4);
		expect(b).toBeGreaterThanOrEqual(0);
		expect(b).toBeLessThan(360);
	});
});

describe('pointToSegmentDistanceM', () => {
	it('is 0 for a point on the segment', () => {
		expect(pointToSegmentDistanceM(0, 0.5, 0, 0, 0, 1)).toBeCloseTo(0, 6);
	});

	it('is the perpendicular distance off the segment', () => {
		// 0.01° of latitude off a along-equator segment.
		expect(pointToSegmentDistanceM(0.01, 0.5, 0, 0, 0, 1)).toBeCloseTo(1113.2, 1);
	});

	it('clamps past an endpoint', () => {
		// Point one degree of longitude beyond the segment's far end.
		expect(pointToSegmentDistanceM(0, 2, 0, 0, 0, 1)).toBeCloseTo(111320, 0);
	});
});

describe('pointToPolylineDistanceM', () => {
	it('returns the minimum over the segments', () => {
		const line = [
			{ lat: 0, lon: 0 },
			{ lat: 0, lon: 1 },
			{ lat: 1, lon: 1 },
		];
		// On the first segment.
		expect(pointToPolylineDistanceM(0, 0.5, line)).toBeCloseTo(0, 6);
		// Near the second (vertical) segment, 0.01° of longitude away.
		expect(pointToPolylineDistanceM(0.5, 1.01, line)).toBeLessThan(1200);
	});

	it('is Infinity for fewer than two points', () => {
		expect(pointToPolylineDistanceM(0, 0, [{ lat: 0, lon: 0 }])).toBe(Infinity);
	});
});

describe('computeNavLog', () => {
	it('computes legs, cumulative distance, true track and ETE', () => {
		const log = computeNavLog([wp(0, 0), wp(0, 1)], 100);
		expect(log.legs).toHaveLength(1);
		const leg = log.legs[0];
		// 1° of longitude at the equator is ~60.1 NM.
		expect(leg.legNM).toBeCloseTo(60.1, 1);
		expect(leg.cumNM).toBeCloseTo(60.1, 1);
		expect(leg.trackTrueDeg).toBeCloseTo(90, 1);
		expect(leg.eteMin).toBeCloseTo((leg.legNM / 100) * 60, 4);
		expect(log.totalNM).toBeCloseTo(60.1, 1);
		expect(log.totalEteMin).toBeCloseTo((log.totalNM / 100) * 60, 4);
	});

	it('is empty for fewer than two waypoints', () => {
		const log = computeNavLog([wp(0, 0)], 100);
		expect(log.legs).toHaveLength(0);
		expect(log.totalNM).toBe(0);
		// No legs sums to 0 NM / 0 min when a cruise speed is set; null is
		// reserved for "no cruise speed" (covered by the test above).
		expect(log.totalEteMin).toBe(0);
	});

	it('omits ETE when the cruise speed is unset', () => {
		const log = computeNavLog([wp(0, 0), wp(0, 1)], null);
		expect(log.legs[0].eteMin).toBeNull();
		expect(log.totalEteMin).toBeNull();
	});

	it('handles a zero-length leg without NaN', () => {
		const log = computeNavLog([wp(1, 1), wp(1, 1)], 100);
		expect(log.legs[0].legNM).toBeCloseTo(0, 6);
		expect(log.legs[0].trackTrueDeg).toBe(0);
		expect(log.legs[0].eteMin).toBeCloseTo(0, 6);
	});
});

describe('routeCorridorBbox', () => {
	it('pads the route bbox by the corridor half-width', () => {
		const bbox = routeCorridorBbox([wp(0, 0), wp(0, 1)], 25);
		expect(bbox).not.toBeNull();
		if (!bbox) return;
		// 25 NM in degrees of latitude.
		const padLat = (25 * NM_TO_METERS) / 111320;
		expect(bbox.minLat).toBeCloseTo(-padLat, 4);
		expect(bbox.maxLat).toBeCloseTo(padLat, 4);
		expect(bbox.minLon).toBeLessThan(0);
		expect(bbox.maxLon).toBeGreaterThan(1);
	});

	it('is null for fewer than two waypoints', () => {
		expect(routeCorridorBbox([wp(0, 0)], 25)).toBeNull();
	});
});

describe('computeAirspaceSchedule', () => {
	// A box CTR over lon 0.2..0.8, lat -0.5..0.5, from the surface to FL100.
	const ring: [number, number][] = [
		[-0.5, 0.2],
		[-0.5, 0.8],
		[0.5, 0.8],
		[0.5, 0.2],
	];
	const ctr = mkAirspace(
		'A',
		ring,
		['HEI', '0', 'FT'],
		['STD', '100', 'FL'],
	);
	// A west-to-east route along the equator, crossing the CTR.
	const routeWps = [wp(0, -0.5, 3000), wp(0, 1.5, 3000)];

	it('emits an enter then a leave crossing an airspace within its band', () => {
		const events = computeAirspaceSchedule(routeWps, [ctr], 100, 3000);
		const enters = events.filter((e) => e.kind === 'enter' && e.key === 'A');
		const leaves = events.filter((e) => e.kind === 'leave' && e.key === 'A');
		expect(enters).toHaveLength(1);
		expect(leaves).toHaveLength(1);
		expect(enters[0].atNM).toBeLessThan(leaves[0].atNM);
		// Carries the airspace radio for the frequency schedule.
		expect(enters[0].radio[0].freq).toBe('120.500');
	});

	it('lists a leave before an enter at a shared boundary', () => {
		// Two boxes abutting at lon 0.5; a route from inside A into B leaves A and
		// enters B at the same point.
		const ringA: [number, number][] = [
			[-0.5, 0.0],
			[-0.5, 0.5],
			[0.5, 0.5],
			[0.5, 0.0],
		];
		const ringB: [number, number][] = [
			[-0.5, 0.5],
			[-0.5, 1.0],
			[0.5, 1.0],
			[0.5, 0.5],
		];
		const aA = mkAirspace('A', ringA, ['HEI', '0', 'FT'], ['STD', '100', 'FL']);
		const aB = mkAirspace('B', ringB, ['HEI', '0', 'FT'], ['STD', '100', 'FL']);
		const events = computeAirspaceSchedule(
			[wp(0, 0.41, 3000), wp(0, 0.6, 3000)],
			[aA, aB],
			100,
			3000,
		);
		const leaveA = events.findIndex((e) => e.kind === 'leave' && e.key === 'A');
		const enterB = events.findIndex((e) => e.kind === 'enter' && e.key === 'B');
		expect(leaveA).toBeGreaterThanOrEqual(0);
		expect(enterB).toBeGreaterThanOrEqual(0);
		// Same point; the leave is listed first (you leave A to enter B).
		expect(events[leaveA].atNM).toBeCloseTo(events[enterB].atNM, 5);
		expect(leaveA).toBeLessThan(enterB);
	});

	it('omits aerial-activity zones (recreational clutter)', () => {
		const glider: Airspace = {
			...mkAirspace('G', ring, ['HEI', '0', 'FT'], ['STD', '100', 'FL']),
			category: 'activity',
		};
		const events = computeAirspaceSchedule(routeWps, [ctr, glider], 100, 3000);
		expect(events.some((e) => e.key === 'A')).toBe(true); // the CTR is listed
		expect(events.some((e) => e.key === 'G')).toBe(false); // the activity zone is not
	});

	it('excludes an airspace the route overflies above its band', () => {
		const high = [wp(0, -0.5, 30000), wp(0, 1.5, 30000)];
		const events = computeAirspaceSchedule(high, [ctr], 100, 3000);
		expect(events.filter((e) => e.key === 'A')).toHaveLength(0);
	});

	it('is empty for fewer than two waypoints', () => {
		expect(computeAirspaceSchedule([wp(0, 0)], [ctr], 100, 3000)).toHaveLength(0);
	});
});

// A box over lon 0.2..0.8, lat -0.5..0.5; a west-east leg along the equator
// (wp(0,-0.5) -> wp(0,1.5)) crosses it. Shared by the Class A altitude tests.
const classAring: [number, number][] = [
	[-0.5, 0.2],
	[-0.5, 0.8],
	[0.5, 0.8],
	[0.5, 0.2],
];

describe('classAFloorForLeg', () => {
	const a = wp(0, -0.5);
	const b = wp(0, 1.5);

	it('returns the floor (ft) of a crossed Class A (FL base)', () => {
		expect(classAFloorForLeg(a, b, [mkClassA('A', classAring, ['STD', '155', 'FL'])])).toBe(15500);
	});

	it('returns an ALT/FT floor verbatim', () => {
		expect(classAFloorForLeg(a, b, [mkClassA('A', classAring, ['ALT', '5000', 'FT'])])).toBe(5000);
	});

	it('ignores a non-Class-A airspace on track', () => {
		// mkAirspace is class D.
		const d = mkAirspace('D', classAring, ['ALT', '3000', 'FT'], ['STD', '195', 'FL']);
		expect(classAFloorForLeg(a, b, [d])).toBeNull();
	});

	it('returns the lowest floor of several crossed Class A', () => {
		const hi = mkClassA('HI', classAring, ['STD', '155', 'FL']); // 15500
		const lo = mkClassA('LO', classAring, ['STD', '95', 'FL']); // 9500
		expect(classAFloorForLeg(a, b, [hi, lo])).toBe(9500);
	});

	it('is null when the leg misses all Class A laterally', () => {
		const far: [number, number][] = [
			[5, 0.2],
			[5, 0.8],
			[6, 0.8],
			[6, 0.2],
		];
		expect(classAFloorForLeg(a, b, [mkClassA('A', far, ['STD', '95', 'FL'])])).toBeNull();
	});

	it('ignores surface-based Class A (floor 0), never returns 0', () => {
		expect(classAFloorForLeg(a, b, [mkClassA('A', classAring, ['HEI', '0', 'FT'])])).toBeNull();
	});
});

describe('computeAutoAltitudes', () => {
	const routeWps = [wp(0, -0.5), wp(0, 1.5)];

	it('caps a leg down to a Class A floor below the default', () => {
		const ca = mkClassA('A', classAring, ['STD', '95', 'FL']); // 9500
		expect(computeAutoAltitudes(routeWps, true, 12000, [ca])).toEqual([9500]);
	});

	it('leaves a leg already below the floor at the default (cap only)', () => {
		const ca = mkClassA('A', classAring, ['STD', '195', 'FL']); // 19500
		expect(computeAutoAltitudes(routeWps, true, 2000, [ca])).toEqual([2000]);
	});

	it('uses the default for every leg when VFR is off', () => {
		const ca = mkClassA('A', classAring, ['STD', '95', 'FL']);
		expect(computeAutoAltitudes(routeWps, false, 12000, [ca])).toEqual([12000]);
	});

	it('uses the default when airspace data is not loaded (null)', () => {
		expect(computeAutoAltitudes(routeWps, true, 12000, null)).toEqual([12000]);
	});

	it('caps only the legs that cross Class A', () => {
		const ca = mkClassA('A', classAring, ['STD', '95', 'FL']); // 9500, over lon 0.2..0.8
		// Leg 0 crosses the box; leg 1 runs north at lon 1.5, away from it.
		const wps = [wp(0, -0.5), wp(0, 1.5), wp(3, 1.5)];
		expect(computeAutoAltitudes(wps, true, 12000, [ca])).toEqual([9500, 12000]);
	});
});

describe('applyAutoAltitudes (route state)', () => {
	it('never overwrites a manually-set leg', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 12000;
		routeSettings.vfr = true;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		setWaypointAltitude(w1.id, 4500); // manual -> altAuto false
		applyAutoAltitudes(routeSettings.vfr, [mkClassA('A', classAring, ['STD', '95', 'FL'])]); // floor 9500
		expect(activeRoute().waypoints[0].alt).toBe(4500); // untouched
		expect(activeRoute().waypoints[0].altAuto).toBe(false);
		clearRoute();
	});

	it('re-seeds an auto leg when the default altitude changes', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		routeSettings.vfr = true;
		addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		applyAutoAltitudes(routeSettings.vfr, []); // no Class A: auto leg follows the default
		expect(activeRoute().waypoints[0].alt).toBe(2000);
		routeSettings.defaultAltitudeFt = 5500;
		applyAutoAltitudes(routeSettings.vfr, []);
		expect(activeRoute().waypoints[0].alt).toBe(5500);
		clearRoute();
	});

	it('snaps auto legs to semicircular levels when the option is on, manual legs never', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 4500;
		routeSettings.vfr = true;
		routeSettings.semicircular = true;
		addWaypoint(0, -0.5); // eastbound leg (odd + 500): 4500 ties down to 3500
		const w2 = addWaypoint(0, 1.5);
		addWaypoint(0, 3.5);
		setWaypointAltitude(w2.id, 4600); // second leg pinned manual
		applyAutoAltitudes(routeSettings.vfr, [], undefined, 2026.0);
		expect(activeRoute().waypoints[0].alt).toBe(3500);
		expect(activeRoute().waypoints[0].altAuto).toBe(true);
		expect(activeRoute().waypoints[1].alt).toBe(4600); // untouched
		expect(activeRoute().waypoints[1].altAuto).toBe(false);
		routeSettings.semicircular = false;
		clearRoute();
	});

	it('leaves auto legs at or below the applicability floor unsnapped', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		routeSettings.vfr = true;
		routeSettings.semicircular = true;
		addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		applyAutoAltitudes(routeSettings.vfr, [], undefined, 2026.0);
		expect(activeRoute().waypoints[0].alt).toBe(2000); // 2000 <= 3000: free level
		routeSettings.semicircular = false;
		clearRoute();
	});
});

// The reset cue (RouteTab's ↺) shows exactly when a leg is off its auto altitude.
// setWaypointAltitude takes that leg's auto target so it locks manual only when
// the value differs from it: typing the auto altitude hands the leg back to auto
// (no lingering cue), matching the reset control.
describe('setWaypointAltitude (auto-target reconciliation)', () => {
	it('locks a leg manual when the value differs from its auto target', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		setWaypointAltitude(w1.id, 4500, 2000); // 4500 != auto 2000 -> manual
		expect(activeRoute().waypoints[0].alt).toBe(4500);
		expect(activeRoute().waypoints[0].altAuto).toBe(false);
		clearRoute();
	});

	it('keeps a leg auto when the value equals its auto target', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		setWaypointAltitude(w1.id, 4500, 2000); // pin it first
		expect(activeRoute().waypoints[0].altAuto).toBe(false);
		setWaypointAltitude(w1.id, 2000, 2000); // typing the auto value hands it back
		expect(activeRoute().waypoints[0].alt).toBe(2000);
		expect(activeRoute().waypoints[0].altAuto).toBe(true);
		clearRoute();
	});

	it('clamps typed levels into [0, MAX_LEG_ALT_FT]', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		// Feet typed into an FL-mode input arrive x100: 21000 -> 2 100 000.
		setWaypointAltitude(w1.id, 2_100_000);
		expect(activeRoute().waypoints[0].alt).toBe(MAX_LEG_ALT_FT);
		setWaypointAltitude(w1.id, -500);
		expect(activeRoute().waypoints[0].alt).toBe(0);
		// The auto-target comparison runs on the clamped value.
		setWaypointAltitude(w1.id, 2_100_000, MAX_LEG_ALT_FT);
		expect(activeRoute().waypoints[0].altAuto).toBe(true);
		clearRoute();
	});

	it('locks manual at the plain default above a VFR cap, auto only at the capped value', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		routeSettings.vfr = true;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		const classA = [mkClassA('A', classAring, ['STD', '15', 'FL'])]; // floor 1500
		const target = computeAutoAltitudes(activeRoute().waypoints, true, 2000, classA)[0];
		expect(target).toBe(1500); // the leg's auto altitude is the cap, not the default
		setWaypointAltitude(w1.id, 2000, target); // the default sits above the cap -> manual
		expect(activeRoute().waypoints[0].altAuto).toBe(false);
		setWaypointAltitude(w1.id, 1500, target); // the capped auto value -> auto
		expect(activeRoute().waypoints[0].altAuto).toBe(true);
		clearRoute();
	});

	it('locks manual on any value when no auto target is supplied', () => {
		clearRoute();
		routeSettings.defaultAltitudeFt = 2000;
		const w1 = addWaypoint(0, -0.5);
		addWaypoint(0, 1.5);
		setWaypointAltitude(w1.id, 2000); // no target (e.g. the profile drag) -> manual
		expect(activeRoute().waypoints[0].altAuto).toBe(false);
		clearRoute();
	});
});

// The nav-log frequencies cell: manual text pins it; blank text, or the cell's
// automatic content as the sheet renders it (`autoText`), hands it back to
// auto, the setWaypointAltitude reconciliation above.
describe('setWaypointFreqs (manual nav-log frequencies)', () => {
	it('stores manual text trimmed of trailing whitespace', () => {
		clearRoute();
		const w1 = addWaypoint(0, -0.5);
		setWaypointFreqs(w1.id, 'TWR: 118.605\nGLIDER: 123.500\n\n', 'TWR: 118.605');
		expect(activeRoute().waypoints[0].freqsManual).toBe('TWR: 118.605\nGLIDER: 123.500');
		clearRoute();
	});

	it('reverts to automatic on blank text or the automatic content', () => {
		clearRoute();
		const w1 = addWaypoint(0, -0.5);
		setWaypointFreqs(w1.id, 'FIS: 120.325', 'TWR: 118.605');
		expect(activeRoute().waypoints[0].freqsManual).toBe('FIS: 120.325');
		// Typing the automatic text back (a trailing Enter included) re-autos.
		setWaypointFreqs(w1.id, 'TWR: 118.605\n', 'TWR: 118.605');
		expect(activeRoute().waypoints[0].freqsManual).toBeUndefined();
		setWaypointFreqs(w1.id, 'FIS: 120.325', 'TWR: 118.605');
		setWaypointFreqs(w1.id, '  \n ', 'TWR: 118.605'); // blank
		expect(activeRoute().waypoints[0].freqsManual).toBeUndefined();
		clearRoute();
	});

	it('clearWaypointFreqs hands the cell back to automatic', () => {
		clearRoute();
		const w1 = addWaypoint(0, -0.5);
		setWaypointFreqs(w1.id, 'FIS: 120.325');
		expect(activeRoute().waypoints[0].freqsManual).toBe('FIS: 120.325');
		clearWaypointFreqs(w1.id);
		expect(activeRoute().waypoints[0].freqsManual).toBeUndefined();
		clearRoute();
	});
});

// The manual-frequencies text form of the cell's airport / enroute split: the
// editor seed joins the blocks with a blank line, the display maps a blank
// line back to the dotted separator rule on the following line.
describe('freqSeedText / freqDisplayLines', () => {
	it('joins the blocks with a blank line only when both are present', () => {
		expect(freqSeedText(['TWR: 118.605', 'ATIS: 125.030'], ['SIV: 126.100'])).toBe(
			'TWR: 118.605\nATIS: 125.030\n\nSIV: 126.100',
		);
		expect(freqSeedText(['TWR: 118.605'], [])).toBe('TWR: 118.605');
		expect(freqSeedText([], ['SIV: 126.100'])).toBe('SIV: 126.100');
		expect(freqSeedText([], [])).toBe('');
	});

	it('renders a blank line as the separator on the next line', () => {
		expect(freqDisplayLines('TWR: 118.605\n\nSIV: 126.100')).toEqual([
			{ text: 'TWR: 118.605', sep: false },
			{ text: 'SIV: 126.100', sep: true },
		]);
	});

	it('draws nothing for leading blanks, one rule for consecutive blanks', () => {
		expect(freqDisplayLines('\nTWR: 118.605\n \n\nSIV: 126.100')).toEqual([
			{ text: 'TWR: 118.605', sep: false },
			{ text: 'SIV: 126.100', sep: true },
		]);
	});
});

describe('enrouteFreqsByLeg', () => {
	// A box over lon 0.2..0.8, surface to FL100, crossed by a west-east equator leg
	// from lon -0.5 to 1.5. mkAirspace seeds a class-D CTR (radio TEST TWR).
	const box: [number, number][] = [
		[-0.5, 0.2],
		[-0.5, 0.8],
		[0.5, 0.8],
		[0.5, 0.2],
	];
	const oneLeg = [wp(0, -0.5, 3000), wp(0, 1.5, 3000)];

	/** A zone over `ring` (default `box`) with field overrides on the class-D seed. */
	function zone(
		key: string,
		over: Partial<Pick<Airspace, 'type' | 'name' | 'airClass' | 'category' | 'radio'>> = {},
		ring: [number, number][] = box,
	): Airspace {
		return { ...mkAirspace(key, ring, ['HEI', '0', 'FT'], ['STD', '100', 'FL']), name: key, ...over };
	}

	/** The per-leg enroute lines for a route, each formatted "label: freq". */
	function run(route: Waypoint[], airspaces: Airspace[], ifr: boolean): string[][] {
		const schedule = computeAirspaceSchedule(route, airspaces, 100, 3000);
		const legCumNM = computeNavLog(route, 100).legs.map((l) => l.cumNM);
		return enrouteFreqsByLeg(schedule, legCumNM, ifr).map((leg) =>
			leg.map((e: EnrouteFreqLine) => `${e.label}: ${e.freq}`),
		);
	}

	const app = (freq: string, call = 'SEINE - APPROCHE') => [{ freq, unit: 'APP', call }];
	const fis = (freq: string, call = 'PARIS - INFORMATION') => [{ freq, unit: 'INFO', call }];

	// The line names the UNIT, the way the chart labels an airspace box
	// ("SEINE App. 118.050") and the way ENR 2.1 hangs the frequency off the
	// call sign. The airspace keeps its own column in the radio schedule.
	it('names the unit to call, not the airspace it works, VFR and IFR alike', () => {
		const d = zone('D', { type: 'TMA', name: 'SEINE 5', radio: app('120.500') });
		expect(run(oneLeg, [d], false)[0]).toEqual(['SEINE - APPROCHE: 120.500']);
		expect(run(oneLeg, [d], true)[0]).toEqual(['SEINE - APPROCHE: 120.500']);
	});

	it('lists Class A and Class E only under IFR', () => {
		const a = zone('A', { type: 'TMA', name: 'PARIS A', airClass: 'A', radio: app('121.300', 'PARIS - CONTROLE') });
		const e = zone('E', { type: 'TMA', name: 'PARIS E', airClass: 'E', radio: app('128.000') });
		expect(run(oneLeg, [a, e], false)[0]).toEqual([]); // VFR: neither
		expect(run(oneLeg, [a, e], true)[0]).toEqual(['PARIS - CONTROLE: 121.300', 'SEINE - APPROCHE: 128.000']);
	});

	it('always lists SIV and RMZ, never plain TMZ or R/D/P', () => {
		const siv = zone('SIV', { type: 'SIV', name: 'PARIS SUD', category: 'siv', airClass: 'G', radio: fis('135.225', 'SEINE - INFORMATION') });
		const rmz = zone('RMZ', { type: 'RMZ', name: 'RMZX', category: 'trafficmgmt', airClass: '', radio: fis('119.700', 'MELUN - TOUR') });
		const tmz = zone('TMZ', { type: 'TMZ', name: 'TMZX', category: 'trafficmgmt', airClass: '', radio: fis('130.000', 'TMZ - INFORMATION') });
		const r = zone('R', { type: 'R', name: 'R123', category: 'restricted', airClass: '', radio: fis('131.000', 'R123 - CONTROLE') });
		const out = run(oneLeg, [siv, rmz, tmz, r], false)[0];
		expect(out).toContain('SEINE - INFORMATION: 135.225');
		expect(out).toContain('MELUN - TOUR: 119.700');
		expect(out.some((l) => l.includes('130.000') || l.includes('131.000'))).toBe(false);
	});

	it('skips a zone with no radio', () => {
		expect(run(oneLeg, [zone('NR', { type: 'TMA', name: 'NORADIO', radio: [] })], false)[0]).toEqual([]);
	});

	it('offers only a channel a light aircraft can work', () => {
		// The AIXM lumps a military approach's whole set onto the airspace, UHF
		// and guard included; Villacoublay's is on CTR PARIS this way. The
		// schedule still lists the filtered set; the line offers one channel.
		const mil = zone('MIL', {
			type: 'CTR',
			name: 'VILLACOUBLAY',
			radio: [
				{ freq: '123.75', unit: 'APP', call: 'VILLA - APPROCHE' },
				{ freq: '142.45', unit: 'APP', call: 'VILLA - APPROCHE' },
				{ freq: '243', unit: 'APP', call: 'VILLA - APPROCHE' },
				{ freq: '362.3', unit: 'APP', call: 'VILLA - APPROCHE' },
				{ freq: '119.425', unit: 'APP', call: 'VILLA - APPROCHE' },
			],
		});
		expect(run(oneLeg, [mil], false)[0]).toEqual(['VILLA - APPROCHE: 123.750']);
	});

	it('keeps a UHF-only zone as published rather than dropping it', () => {
		const uhf = zone('UHF', {
			type: 'CTR',
			name: 'UHFONLY',
			radio: [{ freq: '257.8', unit: 'TWR', call: 'SOLENZARA - TOUR' }],
		});
		expect(run(oneLeg, [uhf], false)[0]).toEqual(['SOLENZARA - TOUR: 257.800']);
	});

	// The FIR-level FIS blanket (type FIC: PARIS Information) cedes to an APP-run
	// SIV by its own AIP remark, "excluding areas where the flight information
	// service is provided by an approach control unit". Whole-leg cover only: a
	// leg running out of SIV cover still needs the FIC frequency.
	describe('the FIR-level FIS blanket', () => {
		/** Wide enough for the whole oneLeg route (lon -0.5 to 1.5 at lat 0). */
		const wide: [number, number][] = [
			[-0.5, -1],
			[-0.5, 2],
			[0.5, 2],
			[0.5, -1],
		];
		const fic = (ring = wide) =>
			zone('FIC', { type: 'FIC', name: 'PARIS SUD', category: 'siv', airClass: '', radio: fis('126.100') }, ring);
		const siv = (ring = wide, radio: AirspaceRadio[] = fis('134.300', 'SEINE - INFORMATION')) =>
			zone('SIV', { type: 'SIV', name: 'SEINE 1', category: 'siv', airClass: '', radio }, ring);

		it('drops the FIC where an APP SIV covers the whole leg', () => {
			expect(run(oneLeg, [fic(), siv()], false)[0]).toEqual(['SEINE - INFORMATION: 134.300']);
		});

		it('keeps the FIC where the SIV cover runs out mid-leg', () => {
			// box spans lon 0.2..0.8 only, so the leg leaves SIV cover both sides.
			expect(run(oneLeg, [fic(), siv(box)], false)[0]).toEqual([
				'PARIS - INFORMATION: 126.100',
				'SEINE - INFORMATION: 134.300',
			]);
		});

		it('keeps the FIC when the only covering SIV publishes no frequency', () => {
			expect(run(oneLeg, [fic(), siv(wide, [])], false)[0]).toEqual(['PARIS - INFORMATION: 126.100']);
		});

		// The service-closure family (docs/notam-relationships.md): a SIV whose
		// frequency a NOTAM withdrew stops suppressing the FIC (which is the
		// very unit the NOTAM designates), and its own line survives struck.
		it('restores the FIC line when the covering SIV is NOTAM-closed', () => {
			const closedSiv = siv(wide, [
				{ freq: '119.8', unit: 'LFOB', call: 'BEAUVAIS - INFORMATION', closed: true },
			]);
			const leg = enrouteFreqsByLeg(
				computeAirspaceSchedule(oneLeg, [fic(), closedSiv], 100, 3000),
				computeNavLog(oneLeg, 100).legs.map((l) => l.cumNM),
				false,
			)[0];
			expect(leg.map((e) => [`${e.label}: ${e.freq}`, e.closed ?? false])).toEqual([
				['PARIS - INFORMATION: 126.100', false],
				['BEAUVAIS - INFORMATION: 119.800', true],
			]);
		});

		it('never coalesces a closed line into an open co-frequency one', () => {
			// Two units share 130.000; one is closed. The bidirectional merge
			// would fold them into "A / B: 130.000", half of it dead; the
			// partition keeps the working line clean and the closed one struck.
			const open = zone('OPEN', {
				type: 'SIV',
				name: 'OPEN 1',
				category: 'siv',
				airClass: '',
				radio: [{ freq: '130.000', unit: 'INFO', call: 'ALPHA - INFORMATION' }],
			});
			const closed = zone('CLOSED', {
				type: 'SIV',
				name: 'CLOSED 1',
				category: 'siv',
				airClass: '',
				radio: [{ freq: '130.000', unit: 'INFO', call: 'BRAVO - INFORMATION', closed: true }],
			});
			const leg = enrouteFreqsByLeg(
				computeAirspaceSchedule(oneLeg, [open, closed], 100, 3000),
				computeNavLog(oneLeg, 100).legs.map((l) => l.cumNM),
				false,
			)[0];
			expect(leg.map((e) => [e.label, e.closed ?? false])).toEqual([
				['ALPHA - INFORMATION', false],
				['BRAVO - INFORMATION', true],
			]);
		});

		it('keeps the FIC alone above the SIV ceiling', () => {
			// The schedule walk is altitude-aware, so a flight over the SIV's
			// FL050 top never puts it on the timeline: nothing to supersede.
			const low: Airspace = {
				...mkAirspace('SIV', wide, ['HEI', '0', 'FT'], ['STD', '050', 'FL']),
				type: 'SIV',
				name: 'SEINE 1',
				category: 'siv',
				airClass: '',
				radio: fis('134.300', 'SEINE - INFORMATION'),
			};
			const high = [wp(0, -0.5, 8000), wp(0, 1.5, 8000)];
			expect(run(high, [fic(), low], false)[0]).toEqual(['PARIS - INFORMATION: 126.100']);
		});
	});

	it('repeats a zone on every leg it stays active across', () => {
		const wide: [number, number][] = [
			[-0.5, 0.2],
			[-0.5, 2.2],
			[0.5, 2.2],
			[0.5, 0.2],
		];
		const d = zone('D', { type: 'TMA', name: 'SEINE 5', radio: app('120.500') }, wide);
		const out = run([wp(0, -0.5, 3000), wp(0, 1.0, 3000), wp(0, 2.5, 3000)], [d], false);
		expect(out).toHaveLength(2);
		expect(out[0]).toContain('SEINE - APPROCHE: 120.500');
		expect(out[1]).toContain('SEINE - APPROCHE: 120.500');
	});

	it('gives one unit one line however many of its sectors the leg crosses', () => {
		const s = (n: number) =>
			zone(`S${n}`, { type: 'SIV', name: `SEINE ${n}`, category: 'siv', airClass: 'G', radio: fis('135.225', 'SEINE - INFORMATION') });
		expect(run(oneLeg, [s(1), s(2), s(3)], false)[0]).toEqual(['SEINE - INFORMATION: 135.225']);
	});

	it('carries the merged airspaces\' keys on each line', () => {
		const legCumNM = computeNavLog(oneLeg, 100).legs.map((l) => l.cumNM);
		const lines = (airspaces: Airspace[]): EnrouteFreqLine[] =>
			enrouteFreqsByLeg(computeAirspaceSchedule(oneLeg, airspaces, 100, 3000), legCumNM, false)[0];
		// Three prefix-merged sectors keep all three keys, entry order.
		const s = (n: number) =>
			zone(`S${n}`, { type: 'SIV', name: `SEINE ${n}`, category: 'siv', airClass: 'G', radio: fis('135.225', 'SEINE - INFORMATION') });
		expect(lines([s(1), s(2), s(3)])[0].keys).toEqual(['S1', 'S2', 'S3']);
		// One airspace on two of its unit's channels keeps its single key.
		const p = zone('P1', {
			type: 'TMA',
			name: 'PARIS 1',
			radio: [
				{ freq: '120.500', unit: 'APP', call: 'SEINE - APPROCHE' },
				{ freq: '121.300', unit: 'APP', call: 'SEINE - APPROCHE' },
			],
		});
		expect(lines([p])[0].keys).toEqual(['P1']);
		// Two units sharing a channel keep both airspaces' keys.
		const ctr = zone('CTR', { type: 'CTR', name: 'MELUN', radio: app('121.105', 'MELUN - TOUR') });
		const rmz = zone('RMZ', { type: 'RMZ', name: 'MELUN', category: 'trafficmgmt', airClass: '', radio: fis('121.105', 'SEINE - INFORMATION') });
		expect(lines([ctr, rmz])[0].keys).toEqual(['CTR', 'RMZ']);
	});

	it('merges two units on one channel, factoring the shared service word', () => {
		const ctr = zone('CTR', { type: 'CTR', name: 'MELUN', radio: app('121.105', 'MELUN - APPROCHE') });
		const tma = zone('TMA', { type: 'TMA', name: 'SEINE 5', radio: app('121.105', 'SEINE - APPROCHE') });
		expect(run(oneLeg, [ctr, tma], false)[0]).toEqual(['MELUN / SEINE - APPROCHE: 121.105']);
	});

	it("reduces a unit's several channels to the one to set", () => {
		// A unit publishes a channel per sector and the chart prints one per
		// box, so the line offers the first civil VHF one, not all of them.
		const p = zone('P1', {
			type: 'TMA',
			name: 'PARIS 1',
			radio: [
				{ freq: '120.500', unit: 'APP', call: 'SEINE - APPROCHE' },
				{ freq: '121.300', unit: 'APP', call: 'SEINE - APPROCHE' },
			],
		});
		expect(run(oneLeg, [p], false)[0]).toEqual(['SEINE - APPROCHE: 120.500']);
	});

	it('falls back to full labels when co-frequency units share no word', () => {
		const x = zone('X', { type: 'TMA', name: 'LYON', radio: app('118.000', 'LYON - APPROCHE') });
		const y = zone('Y', { type: 'CTR', name: 'SACONNEX', radio: app('118.000', 'GENEVE - ARRIVEE') });
		expect(run(oneLeg, [x, y], false)[0]).toEqual(['LYON - APPROCHE / GENEVE - ARRIVEE: 118.000']);
	});

	it('orders the lines by where the route meets each airspace (enter order)', () => {
		// ALPHA spans the whole leg; BRAVO is entered later but left earlier (nested in
		// ALPHA). The flight meets ALPHA first, so it is listed first even though it is
		// left last (a leave-ordered list would invert them).
		const outer: [number, number][] = [
			[-0.5, -0.5],
			[-0.5, 1.5],
			[0.5, 1.5],
			[0.5, -0.5],
		];
		const inner: [number, number][] = [
			[-0.5, 0.0],
			[-0.5, 1.0],
			[0.5, 1.0],
			[0.5, 0.0],
		];
		const a = zone('A', { type: 'TMA', name: 'ALPHA', radio: app('120.000', 'ALPHA - APPROCHE') }, outer);
		const b = zone('B', { type: 'TMA', name: 'BRAVO', radio: app('121.000', 'BRAVO - APPROCHE') }, inner);
		expect(run([wp(0, -1, 3000), wp(0, 2, 3000)], [a, b], false)[0]).toEqual([
			'ALPHA - APPROCHE: 120.000',
			'BRAVO - APPROCHE: 121.000',
		]);
	});
});
