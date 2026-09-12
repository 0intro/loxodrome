/* Unit tests for the batch importer's pure plan matcher (nav/planMatch):
 * the candidate builder over parsed route files, the bbox prefilter, the
 * lateral and coverage gates, the ranking and the tie rule. Equator
 * geometry like tests/navRouteAssign.spec.ts: one degree of longitude is
 * 60 NM, so distances read directly. */

import { describe, expect, it } from 'vitest';
import {
	BBOX_MARGIN_NM,
	buildCandidatePlan,
	matchTraceToPlans,
	MIN_COVERAGE,
	planBounds,
	traceTouchEvidence,
	type CandidatePlan,
	type CandidateRoute,
} from '$lib/nav/planMatch';
import { extendMotion, newMotionFold, type MotionFold } from '$lib/nav/navlogLive';
import type { TrackPoint } from '$lib/nav/trace';
import { parseRoutesDoc } from '$lib/route/yaml';
import type { Waypoint, WaypointAnchor } from '$lib/state/route.svelte';

let nextId = 0;
function wp(lon: number, lat = 0): Waypoint {
	return { id: `w${nextId++}`, lat, lon, kind: 'free', alt: 0, altAuto: true };
}

function croute(id: string, waypoints: Waypoint[], alternate?: true): CandidateRoute {
	return { id, name: null, waypoints, alternate };
}

function plan(name: string, routes: CandidateRoute[]): CandidatePlan {
	return { name, yaml: `# ${name}`, aircraftKey: null, routes };
}

/** One fix a minute along a list of longitudes (lat 0 unless paired), at
 *  `kt`; chain legs to vary the speed (a stopover is a 0 kt leg). */
function leg(
	lons: (number | [number, number])[],
	kt: number,
	startMs = 0,
): TrackPoint[] {
	return lons.map((v, i) => {
		const [lon, lat] = Array.isArray(v) ? v : [v, 0];
		return { lat, lon, altFt: null, timeMs: startMs + i * 60_000, speedKt: kt };
	});
}

function chain(...parts: ((start: number) => TrackPoint[])[]): TrackPoint[] {
	const out: TrackPoint[] = [];
	for (const part of parts) {
		const startMs = out.length === 0 ? 0 : out[out.length - 1].timeMs + 60_000;
		out.push(...part(startMs));
	}
	return out;
}

function motionOf(points: TrackPoint[]): MotionFold {
	return extendMotion(newMotionFold(), points);
}

/** Fixes every minute from lonA to lonB inclusive, one per 0.05 degrees
 *  (3 NM/min = 180 kt over the ground; speedKt stamps the given value). */
function flight(lonA: number, lonB: number, kt = 100): (start: number) => TrackPoint[] {
	return (startMs) => {
		const step = lonB >= lonA ? 0.05 : -0.05;
		const n = Math.round(Math.abs(lonB - lonA) / 0.05) + 1;
		return leg(
			Array.from({ length: n }, (_, i) => lonA + i * step),
			kt,
			startMs,
		);
	};
}

/** `minutes` parked fixes at lon (the stopover). */
function parked(lon: number, minutes: number): (start: number) => TrackPoint[] {
	return (startMs) => leg(Array.from({ length: minutes }, () => lon), 0, startMs);
}

const planAB = () => plan('ab', [croute('t1', [wp(0), wp(1)])]);
const planABC = () =>
	plan('abc', [croute('t1', [wp(0), wp(1)]), croute('t2', [wp(1), wp(2)])]);

describe('matchTraceToPlans', () => {
	it('matches the flown plan cleanly', () => {
		const points = chain(flight(0, 1));
		const m = matchTraceToPlans(points, motionOf(points), [planAB()]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.plan.name).toBe('ab');
			expect(m.segments.map((s) => s.routeId)).toEqual(['t1']);
		}
	});

	it('rejects a plan flown 20 NM off (the lateral gate)', () => {
		// Same longitudes, a third of a degree of latitude away.
		const points = chain((s) =>
			leg(Array.from({ length: 21 }, (_, i) => [i * 0.05, 0.33] as [number, number]), 100, s),
		);
		const m = matchTraceToPlans(points, motionOf(points), [planAB()]);
		expect(m.kind).toBe('none');
	});

	it('rejects a plan whose destination the flight overflew', () => {
		// Flown 0 -> 2 nonstop; the plan's route ends at 1, arrived en
		// route, but the flight ends 60 NM past it (the nearby-field case:
		// a shared corridor must not claim the wrong destination).
		const points = chain(flight(0, 2));
		const m = matchTraceToPlans(points, motionOf(points), [planAB()]);
		expect(m.kind).toBe('none');
	});

	it('matches a partial out-and-back on the plan its corridor belongs to', () => {
		// The lesson case: out along an aller-retour route, turn back before
		// the far waypoint, land home. The progress watermark never arrives,
		// but the flight ends on the plan's own endpoint, tight on the
		// corridor, well ranged out.
		const ar = plan('ar', [croute('t1', [wp(0), wp(1), wp(0)])]);
		const points = chain(flight(0, 0.6), flight(0.6, 0));
		const m = matchTraceToPlans(points, motionOf(points), [ar]);
		expect(m.kind).toBe('match');
		// A one-way plan never admits it: the flight does not end at its end.
		const oneWay = plan('ow', [croute('t1', [wp(0), wp(1)])]);
		expect(matchTraceToPlans(points, motionOf(points), [oneWay]).kind).toBe('none');
	});

	it('follows the flown option through a junction, not the file order', () => {
		// The saved workspaces list several onward options from a junction
		// as plain routes; the file-order chain forced the unflown option
		// and its offset killed the file (the real Compiegne day). The
		// junction-graph paths fold the flown chain.
		const tree = plan('tree', [
			croute('t1', [wp(0), wp(1)]),
			croute('optA', [wp(1), wp(1.4, 0.5)]),
			croute('optB', [wp(1), wp(2)]),
			croute('back', [wp(2), wp(0)]),
		]);
		const points = chain(flight(0, 1), flight(1, 2), flight(2, 0));
		const m = matchTraceToPlans(points, motionOf(points), [tree]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.segments.map((s) => s.routeId)).toEqual(['t1', 'optB', 'back']);
		}
	});

	it('a closed route may end at the plan home the file does not chain to', () => {
		// The real chartres return: the route closes 15 NM short of home
		// (the file carries the last hop only reversed) and the flight
		// continues to the plan's own departure aerodrome.
		const wk = plan('wk', [
			croute('r0', [wp(0), wp(0.8, -0.5)]),
			croute('r1', [wp(1), wp(0.25)]),
		]);
		const points = chain(flight(1, 0.25), flight(0.25, 0));
		const m = matchTraceToPlans(points, motionOf(points), [wk]);
		expect(m.kind).toBe('match');
		// Without the home-owning trip in the file, the same trace stays
		// refused: the flight overflew the plan's destination.
		const lone = plan('lone', [croute('r1', [wp(1), wp(0.25)])]);
		expect(matchTraceToPlans(points, motionOf(points), [lone]).kind).toBe('none');
	});

	it('matches an abridged multi-trip day that skips a stop', () => {
		// Out on trip 1, turn back BEFORE its far waypoint (every route
		// stays open), home to the plan's own final destination. The real
		// Brienne day: LFPL-LFFN-LFQH-LFGP-LFPL flown with the LFQH corner
		// cut.
		const day = plan('day3', [
			croute('t1', [wp(0), wp(1)]),
			croute('t2', [wp(1), wp(1.5)]),
			croute('t3', [wp(1.5), wp(0)]),
		]);
		const points = chain(flight(0, 0.9), flight(0.9, 0));
		const m = matchTraceToPlans(points, motionOf(points), [day]);
		expect(m.kind).toBe('match');
		// The same trace against trip 1 alone stays refused: an
		// out-and-back must not claim a one-way plan.
		const oneWay = plan('ow2', [croute('t1', [wp(0), wp(1)])]);
		expect(matchTraceToPlans(points, motionOf(points), [oneWay]).kind).toBe('none');
	});

	it('rejects a route the flight only JOINED halfway (the start gate)', () => {
		// The real 2025-10-16 LFQA -> LFPL flight: it began beside the Sedan
		// plan's Rethel-Sezanne leg, flew it home inside the lateral gate and
		// was filed as "LFSJ -> LFPL", a departure 40 NM away that never
		// happened. Here: the plan runs 0 -> 2, the flight starts at 1.
		const long = plan('long', [croute('t1', [wp(0), wp(1), wp(2)])]);
		const points = chain(flight(1, 2));
		expect(matchTraceToPlans(points, motionOf(points), [long]).kind).toBe('none');
		// Departing the route's own start, the same geometry matches.
		const whole = chain(flight(0, 2));
		expect(matchTraceToPlans(whole, motionOf(whole), [long]).kind).toBe('match');
	});

	it('rejects a closed route whose destination was never visited', () => {
		// assignRouteSegments closes a segment on the PROJECTED distance, so
		// a flight that leaves the corridor before the last waypoint still
		// "arrives" from miles abeam: the real 2025-07-17 LFPL -> LFLA flight
		// flew the Moret plan's first leg to the metre, turned for Auxerre
		// and claimed two aerodromes it never saw. Here the route doglegs
		// 0 -> 0.5 -> 1 at the equator while the flight runs straight past it
		// 18 NM north, tight enough on the first half to keep the median
		// offset inside the lateral gate. The flight comes HOME, so the end
		// gate's home alternative is satisfied and only the new one can
		// refuse it.
		const dogleg = plan('dogleg', [
			croute('t1', [wp(0), wp(0.5), wp(1)]),
			croute('t2', [wp(1), wp(0)]),
		]);
		const away = (s: number): TrackPoint[] =>
			leg([[0.55, 0.05], [0.7, 0.15], [0.9, 0.25], [1.2, 0.3]], 100, s);
		const home = (s: number): TrackPoint[] =>
			leg([[1, 0.25], [0.7, 0.18], [0.4, 0.1], [0.1, 0.02], [0, 0]], 100, s);
		const points = chain(flight(0, 0.5), away, home);
		expect(matchTraceToPlans(points, motionOf(points), [dogleg]).kind).toBe('none');
		// The same plan, flown through its own turning point, matches.
		const flown = chain(flight(0, 1), flight(1, 0));
		expect(matchTraceToPlans(flown, motionOf(flown), [dogleg]).kind).toBe('match');
	});

	it('rejects a local flight that never arrives anywhere (the circuit case)', () => {
		// Hovering around the departure: inside the open first leg of every
		// plan departing this field, small offset, full coverage. Without
		// the arrival gate a circuit ties them all.
		const points = chain((s) =>
			leg([0, 0.02, 0.04, 0.02, 0, 0.02, 0.04, 0.02, 0, 0.02], 100, s),
		);
		const m = matchTraceToPlans(points, motionOf(points), [planAB()]);
		expect(m.kind).toBe('none');
	});

	it('rejects a plan covering too little of the airborne time', () => {
		// Out to 1 (the plan, arrived), then an unplanned excursion to 2 and
		// back: ends at the plan's end, but the plan covers about a third.
		expect(MIN_COVERAGE).toBeGreaterThan(0.5);
		const points = chain(flight(0, 1), flight(1, 2), flight(2, 1));
		const m = matchTraceToPlans(points, motionOf(points), [planAB()]);
		expect(m.kind).toBe('none');
	});

	it('accepts a two-leg plan around a ground stop (the denominator rule)', () => {
		// 0 -> 1, one hour parked, 1 -> 2. The stop belongs to neither
		// segment; counting it against the plan would reject the match.
		const points = chain(flight(0, 1), parked(1, 60), flight(1, 2));
		const m = matchTraceToPlans(points, motionOf(points), [planABC()]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.segments.map((s) => s.routeId)).toEqual(['t1', 't2']);
		}
	});

	it('picks the tighter plan; a same-fit twin resolves, a near fit flags', () => {
		const points = chain(flight(0, 1));
		// A materially offset sibling loses on the offNM key...
		const offset = plan('off', [croute('t1', [wp(0, 0.05), wp(1, 0.05)])]);
		const m1 = matchTraceToPlans(points, motionOf(points), [offset, planAB()]);
		expect(m1.kind).toBe('match');
		if (m1.kind === 'match') {
			expect(m1.plan.name).toBe('ab');
		}
		// ...an equal twin under a different yaml fits the SAME geometry:
		// the route claim is established either way, so the ranking picks
		// deterministically instead of flagging (the user's workspaces
		// byte-copy common legs across files).
		const twinA = planAB();
		const twinB = { ...planAB(), name: 'ab2', yaml: '# ab2' };
		const m2 = matchTraceToPlans(points, motionOf(points), [twinB, twinA]);
		expect(m2.kind).toBe('match');
		if (m2.kind === 'match') {
			expect(m2.plan.name).toBe('ab'); // name order, deterministic
		}
		// ...and a close-but-DIFFERENT fit (inside the tie window, outside
		// the same-fit window) is a real doubt: ambiguous.
		const near = plan('near', [croute('t1', [wp(0, 0.0012), wp(1, 0.0012)])]);
		const m3 = matchTraceToPlans(points, motionOf(points), [near, planAB()]);
		expect(m3.kind).toBe('ambiguous');
		if (m3.kind === 'ambiguous') {
			expect(m3.candidates.map((c) => c.name).sort()).toEqual(['ab', 'near']);
		}
	});

	it('dedupes byte-equal plan texts before scoring', () => {
		const points = chain(flight(0, 1));
		const a = planAB();
		const b = { ...planAB(), name: 'copy' }; // same yaml text
		const m = matchTraceToPlans(points, motionOf(points), [a, b]);
		expect(m.kind).toBe('match');
	});

	it('follows a diversion onto the alternate', () => {
		// The navRouteAssign diversion shape: trip 2 carries on east, its
		// alternate runs due south from the junction; flown decisively south.
		const p = plan('div', [
			croute('t1', [wp(0), wp(1)]),
			croute('t2', [wp(1), wp(2)]),
			croute('a2', [wp(1), wp(1, -0.5)], true),
		]);
		const points = chain(flight(0, 1), (s) =>
			leg(
				Array.from({ length: 10 }, (_, i) => [1, -(i + 1) * 0.05] as [number, number]),
				100,
				s,
			),
		);
		const m = matchTraceToPlans(points, motionOf(points), [p]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.segments.map((s) => s.routeId)).toEqual(['t1', 'a2']);
		}
	});

	it('matches one trip of a multi-route file, marked or not', () => {
		// The user's per-flight GPX case: an aerogest trace covers ONE trip
		// of a workspace file. Two routes share the departure at lon 1; the
		// whole-file fold seeds the EARLIEST one, so only the trip's own
		// suffix variant matches a trace flying the second.
		const day = plan('day', [
			croute('t1', [wp(0), wp(1)]),
			croute('x', [wp(1), wp(1.5, -0.8)]),
			croute('t2', [wp(1), wp(2)]),
		]);
		const points = chain(flight(1, 2));
		const m = matchTraceToPlans(points, motionOf(points), [day]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.segments.map((s) => s.routeId)).toEqual(['t2']);
		}
		// The first trip alone matches through the full variant (arrival at
		// its end, the open next trip left at the junction).
		const first = chain(flight(0, 1));
		const m2 = matchTraceToPlans(first, motionOf(first), [day]);
		expect(m2.kind).toBe('match');
		if (m2.kind === 'match') {
			expect(m2.segments[0].routeId).toBe('t1');
		}
	});

	it('one file never ties with itself across variants', () => {
		// The whole-plan variant and the winning suffix both fit; the plan
		// reports ONE match, never ambiguous.
		const day = plan('day2', [croute('t1', [wp(0), wp(1)]), croute('t2', [wp(1), wp(2)])]);
		const points = chain(flight(0, 1), parked(1, 30), flight(1, 2));
		const m = matchTraceToPlans(points, motionOf(points), [day]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.segments.map((s) => s.routeId)).toEqual(['t1', 't2']);
		}
	});

	it('prefilters far plans by bounding box', () => {
		const far = plan('far', [croute('t1', [wp(10), wp(11)])]);
		const points = chain(flight(0, 1));
		expect(matchTraceToPlans(points, motionOf(points), [far]).kind).toBe('none');
		// And the margin keeps a plan just off the trace box in play.
		const b = planBounds(planAB());
		expect(b).toEqual({ minLat: 0, maxLat: 0, minLon: 0, maxLon: 1 });
		expect(BBOX_MARGIN_NM).toBeGreaterThan(0);
	});

	it('returns none for an empty trace or no candidates', () => {
		const points = chain(flight(0, 1));
		expect(matchTraceToPlans([], motionOf([]), [planAB()]).kind).toBe('none');
		expect(matchTraceToPlans(points, motionOf(points), []).kind).toBe('none');
	});
});

describe('touch evidence', () => {
	it('rejects a plan explaining none of the wheels-down evidence', () => {
		// The 2026-05-28 class: the corridor fits, but the wheels came down
		// 30 NM from anywhere the plan goes.
		const points = chain(flight(0, 1));
		const off = { lat: 0.5, lon: 0.5 };
		expect(matchTraceToPlans(points, motionOf(points), [planAB()]).kind).toBe('match');
		expect(matchTraceToPlans(points, motionOf(points), [planAB()], [off]).kind).toBe('none');
	});

	it('one explained touch keeps the plan (the improvised extra)', () => {
		// The 2025-05-27 class: a bonus touch off the plan on the way home
		// must not unmatch the plan that was flown.
		const points = chain(flight(0, 1));
		const touches = [
			{ lat: 0, lon: 0.5 }, // on the plan's own leg
			{ lat: 0.5, lon: 0.5 }, // improvised, 30 NM off
		];
		const m = matchTraceToPlans(points, motionOf(points), [planAB()], touches);
		expect(m.kind).toBe('match');
	});

	it('the touch picks between two symmetric corridor claims', () => {
		// Two mirror aller-retour files whose turn points sit 4.8 NM either
		// side of the flown turn: both pass every geometric gate with
		// IDENTICAL scores, so the same-fit collapse picks alphabetically, a
		// coin flip. The wheels came down on b-up's turn point: evidence
		// gates the mirror out and the pick becomes deterministic.
		const mirror = (name: string, lat: number): CandidatePlan =>
			plan(name, [
				croute('t1', [wp(0), wp(1, lat)]),
				croute('t2', [wp(1, lat), wp(0)]),
			]);
		const down = mirror('a-down', -0.08);
		const up = mirror('b-up', 0.08);
		const points = chain(flight(0, 1), flight(1, 0));
		const motion = motionOf(points);
		const before = matchTraceToPlans(points, motion, [down, up]);
		expect(before.kind).toBe('match');
		if (before.kind === 'match') {
			expect(before.plan.name).toBe('a-down');
		}
		const after = matchTraceToPlans(points, motion, [down, up], [{ lat: 0.08, lon: 1 }]);
		expect(after.kind).toBe('match');
		if (after.kind === 'match') {
			expect(after.plan.name).toBe('b-up');
		}
	});
});

describe('traceTouchEvidence', () => {
	it('collects touch-and-goes and stopover landings, never the final landing', () => {
		// Out with a touch-and-go at 0.5, stopover at 1, home to 0: the
		// evidence is the TG and the stopover, the final landing excluded
		// (where the trace ends is the ends-there gate's own judgement).
		const points = chain(
			flight(0, 0.5),
			(s) => leg([0.5], 35, s), // one slow fix: the touch
			flight(0.5, 1),
			parked(1, 8),
			flight(1, 0),
			parked(0, 8),
		);
		const ev = traceTouchEvidence(
			points,
			motionOf(points),
			() => 0,
			() => 0,
		);
		const lons = ev.map((t) => Math.round(t.lon * 100) / 100).sort((a, b) => a - b);
		expect(lons).toEqual([0.5, 1]);
	});

	it('is empty when the lookups resolve nothing (offline)', () => {
		const points = chain(
			flight(0, 0.5),
			(s) => leg([0.5], 35, s),
			flight(0.5, 1),
			parked(1, 8),
		);
		expect(
			traceTouchEvidence(points, motionOf(points), () => null, () => null),
		).toEqual([]);
	});
});

describe('buildCandidatePlan', () => {
	const resolve = (tok: string): WaypointAnchor | null => {
		const db: Record<string, WaypointAnchor> = {
			LFPL: { lat: 48.6, lon: 2.62, kind: 'airport', refId: 'LFPL', ident: 'LFPL', label: 'Lognes' },
			MLN: { lat: 48.61, lon: 2.79, kind: 'navaid', refId: 'mln', ident: 'MLN', freq: '113.600' },
		};
		return db[tok.toUpperCase()] ?? null;
	};

	it('resolves idents, keeps free points, reads flight_prep aircraft', () => {
		const text = [
			'version: 1',
			'flight_prep:',
			'  aircraft: F-GORQ',
			'routes:',
			'  - name: Sortie',
			'    waypoints:',
			'      - ident: LFPL',
			'      - lat: 48.59',
			'        lon: 2.45',
			'        name: Obélisque',
			'      - ident: MLN',
			'',
		].join('\n');
		const p = buildCandidatePlan('sortie.yaml', text, parseRoutesDoc(text), resolve, 2026.0);
		expect(p).not.toBeNull();
		expect(p!.aircraftKey).toBe('F-GORQ');
		expect(p!.yaml).toBe(text);
		const wps = p!.routes[0].waypoints;
		expect(wps.map((w) => w.kind)).toEqual(['airport', 'free', 'navaid']);
		expect(wps[0].ident).toBe('LFPL');
		expect(wps[1].label).toBe('Obélisque');
	});

	it('drops unresolvable idents and reconstructs name-only waypoints', () => {
		const text = [
			'version: 1',
			'routes:',
			'  - name: null',
			'    waypoints:',
			'      - ident: LFPL',
			'        leg:',
			'          course: 90',
			'          distance: 10',
			'      - name: Point E',
			'      - ident: NOPE',
			'',
		].join('\n');
		const p = buildCandidatePlan('r.yaml', text, parseRoutesDoc(text), resolve, 2026.0);
		// NOPE drops; LFPL + the dead-reckoned Point E keep the route usable.
		expect(p).not.toBeNull();
		const wps = p!.routes[0].waypoints;
		expect(wps.length).toBe(2);
		expect(wps[1].kind).toBe('free');
		expect(wps[1].lon).toBeGreaterThan(2.62); // 10 NM roughly east
	});

	it('returns null when no route keeps two waypoints', () => {
		const text = [
			'version: 1',
			'routes:',
			'  - name: null',
			'    waypoints:',
			'      - ident: NOPE',
			'      - ident: NADA',
			'',
		].join('\n');
		expect(buildCandidatePlan('r.yaml', text, parseRoutesDoc(text), resolve, 2026.0)).toBeNull();
	});
});

describe('the last-resort ordering key', () => {
	/** The mirror pair from the touch test: two files whose turn points sit
	 *  either side of the flown one, scoring IDENTICALLY. Nothing separates
	 *  them but the determinism key, which is exactly the case that used to
	 *  differ between the two code paths. */
	const mirror = (name: string, catalogId: string | undefined, lat: number): CandidatePlan => ({
		...plan(name, [croute('t1', [wp(0), wp(1, lat)]), croute('t2', [wp(1, lat), wp(0)])]),
		catalogId,
	});

	it('is the catalog id, so both call paths pick the same plan', () => {
		const points = chain(flight(0, 1), flight(1, 0));
		const motion = motionOf(points);
		// The batch importer names a candidate after the picked FILE; the
		// background link pass names it after the catalog ID. Ranking on the
		// name let the primed link and its own recomputation disagree about
		// which plan a trace flew.
		const asImported = [
			mirror('zulu.yaml', 'p-alpha', -0.08),
			mirror('alpha.yaml', 'p-zulu', 0.08),
		];
		const asRelinked = [mirror('p-alpha', 'p-alpha', -0.08), mirror('p-zulu', 'p-zulu', 0.08)];
		const a = matchTraceToPlans(points, motion, asImported);
		const b = matchTraceToPlans(points, motion, asRelinked);
		expect(a.kind).toBe('match');
		expect(b.kind).toBe('match');
		if (a.kind === 'match' && b.kind === 'match') {
			expect(a.plan.catalogId).toBe('p-alpha');
			expect(b.plan.catalogId).toBe(a.plan.catalogId);
		}
	});

	it('falls back to the name for a candidate the catalog does not hold', () => {
		const points = chain(flight(0, 1), flight(1, 0));
		const m = matchTraceToPlans(points, motionOf(points), [
			mirror('b.yaml', undefined, 0.08),
			mirror('a.yaml', undefined, -0.08),
		]);
		expect(m.kind).toBe('match');
		if (m.kind === 'match') {
			expect(m.plan.name).toBe('a.yaml');
		}
	});
});
