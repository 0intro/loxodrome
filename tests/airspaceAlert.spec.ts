import { describe, it, expect } from 'vitest';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import {
	DEMOTE_HOLD_MS,
	SEVERITY_RANK,
	SOUND_REARM_MS,
	emptyAlertPrev,
	evaluateAlerts,
	type AlertInput,
	type AlertPose,
	type AlertPrevState,
} from '$lib/nav/airspaceAlert';
import type { AlertVolume } from '$lib/nav/alertVolumes';
import { ringBbox } from '$lib/notam/geometry';
import { vExtent, type VLimit } from '$lib/vertical/limits';

const T0 = Date.parse('2026-07-10T10:00:00Z');

/** Rectangle ring [latMin, latMax] x [lonMin, lonMax]. */
function rect(latMin: number, latMax: number, lonMin: number, lonMax: number): [number, number][] {
	return [
		[latMin, lonMin],
		[latMin, lonMax],
		[latMax, lonMax],
		[latMax, lonMin],
	];
}

function L(ft: number, ref: VLimit['ref'] = 'AMSL'): VLimit {
	return { ft, ref, value: ft, unit: 'ft' };
}

function vol(over: Partial<AlertVolume>): AlertVolume {
	const rings = over.rings ?? [rect(-0.1, 0.1, 0.05, 0.3)];
	return {
		key: 'k',
		id: 'k',
		name: 'X',
		source: 'airspace',
		rings,
		circles: [],
		bbox: ringBbox(rings[0] ?? rect(-0.1, 0.1, 0.05, 0.3)),
		vLower: L(1500),
		vUpper: L(6500),
		knownExtent: true,
		extent: 'known',
		// (the two extent fields are re-derived from the limits below, so
		// a case that overrides vLower / vUpper stays consistent)
		type: 'TMA',
		airClass: 'D',
		category: 'controlled',
		entry: NO_ENTRY,
		rtba: false,
		qSubject: '',
		supKind: '',
		supIfrOnly: false,
		radios: [],
		activity: { kind: 'permanent' },
		...over,
		...extentOf(over),
	};
}

/** Keep knownExtent / extent in step with whatever limits a case set. */
function extentOf(over: Partial<AlertVolume>): Partial<AlertVolume> {
	if (!('vLower' in over) && !('vUpper' in over)) {
		return {};
	}
	const extent = vExtent(over.vLower ?? null, over.vUpper ?? null);
	return { extent, knownExtent: extent !== 'unknown' };
}

/** Eastbound at 120 kt (2 NM/min); the 5 min lookahead segment spans 10 NM. */
function pose(over: Partial<AlertPose> = {}): AlertPose {
	return {
		lat: 0,
		lon: 0,
		mslFt: 3000,
		altTrusted: true,
		trackDeg: 90,
		speedKt: 120,
		vsFpm: 0,
		...over,
	};
}

function input(over: Partial<AlertInput> = {}): AlertInput {
	return {
		nowMs: T0,
		pose: pose(),
		volumes: [],
		notamWindows: new Map(),
		// The default posture of every existing case: a briefing IS loaded, so
		// a NOTAM-activated zone the windows do not list is genuinely cold.
		notamBriefingLoaded: true,
		plannedKeys: new Set(),
		acks: new Map(),
		profile: { vfr: true },
		params: { lookaheadMin: 5, imminentMin: 2, proximityNM: 0.5, verticalBufferFt: 200 },
		airborne: true,
		groundFt: 0,
		groundKnown: true,
		tiers: { avoid: true, clearance: true, equipment: true, caution: true },
		...over,
	};
}

const run = (over: Partial<AlertInput>, prev?: AlertPrevState) =>
	evaluateAlerts(input(over), prev ?? emptyAlertPrev());

describe('proximity grading', () => {
	it('grades approaching then imminent by projected entry time', () => {
		// Entry 6 NM ahead at 120 kt = 3 min: approaching.
		const far = run({ volumes: [vol({ rings: [rect(-0.1, 0.1, 0.1, 0.3)] })] });
		expect(far.dominant?.severity).toBe('approaching');
		expect(far.dominant?.etaSec).toBeCloseTo(180, 0);
		expect(far.dominant?.distNM).toBeCloseTo(6.0, 1);
		// Entry 3 NM ahead = 90 s: imminent.
		const near = run({ volumes: [vol({})] });
		expect(near.dominant?.severity).toBe('imminent');
		expect(near.dominant?.etaSec).toBeCloseTo(90, 0);
		expect(near.dominant?.action).toBe('clearance');
	});

	it('grades inside, with no entry figures', () => {
		const r = run({ pose: pose({ lon: 0.1 }), volumes: [vol({})] });
		expect(r.dominant?.severity).toBe('inside');
		expect(r.dominant?.etaSec).toBeNull();
		expect(r.dominant?.distNM).toBeNull();
	});

	it('catches a sliver the 1 NM samplers would step over', () => {
		const sliver = vol({ rings: [rect(-0.1, 0.1, 0.1, 0.102)] });
		const r = run({ volumes: [sliver] });
		expect(r.dominant?.severity).toBe('approaching');
		expect(r.dominant?.distNM).toBeCloseTo(6.0, 1);
	});

	it('grades a parallel track by lateral proximity, vertically gated', () => {
		const abeam = vol({ rings: [rect(0.007, 0.2, -0.1, 0.1)] });
		const r = run({ volumes: [abeam] });
		expect(r.dominant?.severity).toBe('proximity');
		expect(r.dominant?.distNM).toBeCloseTo(0.42, 2);
		const farther = vol({ rings: [rect(0.01, 0.2, -0.1, 0.1)] });
		expect(run({ volumes: [farther] }).dominant).toBeNull();
	});

	it('needs a coherent track for the lookahead', () => {
		const r = run({ pose: pose({ trackDeg: null }), volumes: [vol({})] });
		expect(r.dominant).toBeNull();
	});
});

describe('vertical test', () => {
	const inside = (p: Partial<AlertPose>, v: Partial<AlertVolume> = {}) =>
		run({ pose: pose({ lon: 0.1, ...p }), volumes: [vol(v)] });

	it('is strict at the floor, inclusive at the ceiling (inBand parity)', () => {
		// 300 ft under the 1500 floor: outside even with the 200 ft buffer.
		expect(inside({ mslFt: 1200 }).dominant).toBeNull();
		// 100 ft under, level: within the buffer, laterally inside: the
		// QUIET vertical-gap form, riding a shelf is normal ops.
		const gap = inside({ mslFt: 1400 });
		expect(gap.dominant?.severity).toBe('proximity');
		expect(gap.dominant?.verticalGap).toBe(true);
		expect(gap.dominant?.gapSide).toBe('below');
		expect(gap.fired).toHaveLength(0);
		// Exactly at the floor is NOT inside (strict), still the gap case.
		const at = inside({ mslFt: 1500 });
		expect(at.dominant?.severity).toBe('proximity');
		expect(at.dominant?.gapSide).toBe('below');
		// Exactly at the ceiling IS inside (inclusive).
		expect(inside({ mslFt: 6500 }).dominant?.severity).toBe('inside');
	});

	it('escalates the gap only when the vertical speed closes it', () => {
		// 100 ft below the floor, climbing 200 fpm: 30 s to the shelf.
		const climb = inside({ mslFt: 1400, vsFpm: 200 });
		expect(climb.dominant?.severity).toBe('imminent');
		expect(climb.dominant?.gapClosing).toBe(true);
		expect(climb.fired).toEqual([{ key: 'k', action: 'clearance', severity: 'imminent' }]);
		// 40 fpm closes 100 ft in 2.5 min, beyond the imminent horizon.
		expect(inside({ mslFt: 1400, vsFpm: 40 }).dominant?.severity).toBe('proximity');
		// Descending away from the floor: quiet.
		expect(inside({ mslFt: 1400, vsFpm: -300 }).dominant?.severity).toBe('proximity');
		// Above the ceiling, descending onto it.
		const desc = inside({ mslFt: 6600, vsFpm: -300 });
		expect(desc.dominant?.severity).toBe('imminent');
		expect(desc.dominant?.gapSide).toBe('above');
		expect(desc.dominant?.gapClosing).toBe(true);
		// An unknown vertical speed reads level.
		expect(inside({ mslFt: 1400, vsFpm: null }).dominant?.severity).toBe('proximity');
	});

	it('degrades to lateral-only when the altitude is unknown', () => {
		const r = inside({ mslFt: null });
		expect(r.dominant?.severity).toBe('inside');
		expect(r.dominant?.altUnknown).toBe(true);
	});

	it('treats an unknown extent as overlapping, flagged', () => {
		const r = inside({ mslFt: 20000 }, { vLower: null, vUpper: null });
		expect(r.dominant?.severity).toBe('inside');
		expect(r.dominant?.extentUnknown).toBe(true);
	});

	// A published floor with no ceiling is judged as reaching to
	// infinity, which the AIP never said. The evaluation stands; the
	// caveat must be shown with it.
	it('flags a half-published extent too', () => {
		const r = inside({ mslFt: 20000 }, { vLower: L(1500), vUpper: null });
		expect(r.dominant?.severity).toBe('inside');
		expect(r.dominant?.extentUnknown).toBe(true);
	});

	it('holds the verdict of an ASFC volume while terrain is pending', () => {
		const winch = (over: Partial<AlertInput>) =>
			run({
				pose: pose({ lon: 0.1, mslFt: 4500 }),
				volumes: [
					vol({
						type: 'GLIDER',
						category: 'activity',
						vLower: { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true },
						vUpper: L(3300, 'AGL'),
					}),
				],
				...over,
			});
		expect(winch({ groundKnown: false, groundFt: null }).dominant).toBeNull();
		// Ground 500 ft: real ceiling 3800 < 4300, confidently clear.
		expect(winch({ groundFt: 500 }).dominant).toBeNull();
		// Lookup failed: conservative endpoints alert.
		expect(winch({ groundFt: null }).dominant?.severity).toBe('inside');
	});
});

describe('activation at traversal', () => {
	const rtba = vol({
		key: 'LFR45C|R 45 C',
		id: 'LFR45C',
		type: 'R',
		category: 'restricted',
		rtba: true,
		activity: { kind: 'notam' },
	});
	const windows = (startS: number, endS: number) =>
		new Map([['LFR45C', [{ startMs: T0 + startS * 1000, endMs: T0 + endS * 1000 }]]]);

	it('alerts a cold zone whose window opens while still inside it', () => {
		// Entry at ~90 s, exit past the horizon; hot from T+180 s.
		const r = run({ volumes: [rtba], notamWindows: windows(180, 3600) });
		expect(r.dominant?.action).toBe('avoid');
		expect(r.dominant?.severity).toBe('imminent');
		expect(r.dominant?.window).toEqual({ startMs: T0 + 180_000, endMs: T0 + 3_600_000 });
	});

	it('stays silent when the window closes before arrival', () => {
		expect(run({ volumes: [rtba], notamWindows: windows(-3600, 60) }).dominant).toBeNull();
		expect(run({ volumes: [rtba] }).dominant).toBeNull();
	});

	// Silence above is earned by a briefing that does not list the zone.
	// With no briefing there is no authority to be silent on: the whole
	// RTBA network and every "activable par NOTAM" zone (469 rows across
	// fr / uk / be) used to grade cold, and so silent, for a pilot who had
	// simply not loaded one.
	it('grades a NOTAM-activated zone unknown, not cold, with no briefing', () => {
		const r = run({ volumes: [rtba], notamBriefingLoaded: false });
		expect(r.dominant?.action).toBe('caution');
		expect(r.dominant?.activityState).toBe('unknown');
	});

	it('keeps a briefed cold zone silent and a briefed hot zone forbidden', () => {
		expect(run({ volumes: [rtba], notamBriefingLoaded: true }).dominant).toBeNull();
		expect(
			run({ volumes: [rtba], notamBriefingLoaded: true, notamWindows: windows(-60, 3600) })
				.dominant?.action,
		).toBe('avoid');
	});
});

describe('gates and softening', () => {
	it('suppresses everything but the avoid tier before takeoff', () => {
		const ctr = vol({ key: 'ctr', airClass: 'D', type: 'CTR' });
		const p = vol({ key: 'p', type: 'P', category: 'restricted' });
		const r = run({ pose: pose({ lon: 0.1 }), volumes: [ctr, p], airborne: false });
		expect(r.alerts.map((a) => a.key)).toEqual(['p']);
	});

	it('grades a parked aircraft at the ground elevation, never lateral-only', () => {
		// The start-of-flight case: a cached startup fix with an untrusted
		// altitude. Lateral-only put the desk "inside" the FL 115-195
		// sector stacked overhead; on the ground the terrain elevation IS
		// the altitude.
		const high = vol({ key: 'high', type: 'P', category: 'restricted', vLower: L(11500), vUpper: L(19500) });
		// The R 275 shape: a TRUE surface floor, whose resolved value IS the
		// ground elevation. The strict-floor convention (stacked-airspace
		// data) must not grade the parked aircraft as merely at-the-floor of
		// the surface volume it is standing inside.
		const sfc = vol({
			key: 'sfc',
			type: 'P',
			category: 'restricted',
			vLower: { ft: 0, ref: 'AGL', value: 0, unit: 'ft', sfc: true },
			vUpper: L(2000),
		});
		const r = run({
			pose: pose({ lon: 0.1, mslFt: null, altTrusted: false, speedKt: 0, trackDeg: null }),
			volumes: [high, sfc],
			airborne: false,
			groundFt: 300,
			groundKnown: true,
		});
		expect(r.alerts.map((a) => a.key)).toEqual(['sfc']);
		expect(r.dominant?.severity).toBe('inside');
		// The substituted altitude is a solid inference, not a caveat.
		expect(r.dominant?.altUnknown).toBe(false);
	});

	it('holds pre-takeoff with no altitude and no terrain rather than crying wolf', () => {
		const high = vol({ key: 'high', type: 'P', category: 'restricted', vLower: L(11500), vUpper: L(19500) });
		const sfc = vol({ key: 'sfc', type: 'P', category: 'restricted', vLower: L(0), vUpper: L(2000) });
		const r = run({
			pose: pose({ lon: 0.1, mslFt: null, altTrusted: false, speedKt: 0, trackDeg: null }),
			volumes: [high, sfc],
			airborne: false,
			groundFt: null,
			groundKnown: false,
		});
		expect(r.alerts).toHaveLength(0);
	});

	it('keeps the conservative lateral-only judgement airborne', () => {
		const high = vol({ key: 'high', type: 'P', category: 'restricted', vLower: L(11500), vUpper: L(19500) });
		const r = run({
			pose: pose({ lon: 0.1, mslFt: null, altTrusted: false }),
			volumes: [high],
			airborne: true,
		});
		expect(r.dominant?.key).toBe('high');
		expect(r.dominant?.altUnknown).toBe(true);
	});

	it('softens a planned clearance-tier traversal and never sounds it', () => {
		const r = run({ volumes: [vol({})], plannedKeys: new Set(['k']) });
		expect(r.dominant?.planned).toBe(true);
		expect(r.fired).toHaveLength(0);
		// An unplanned clearance volume outranks the planned one.
		const other = vol({ key: 'k2', rings: [rect(-0.1, 0.1, 0.04, 0.3)] });
		const both = run({ volumes: [vol({}), other], plannedKeys: new Set(['k']) });
		expect(both.dominant?.key).toBe('k2');
	});

	it('honours the tier toggles', () => {
		const act = vol({ type: 'PARACHUTE', category: 'activity' });
		const r = run({
			pose: pose({ lon: 0.1 }),
			volumes: [act],
			tiers: { avoid: true, clearance: true, equipment: true, caution: false },
		});
		expect(r.dominant).toBeNull();
	});

	it('ranks avoid over clearance, and unacked over acked', () => {
		const p = vol({ key: 'p', type: 'P', category: 'restricted' });
		const r = run({ pose: pose({ lon: 0.1 }), volumes: [vol({}), p] });
		expect(r.dominant?.key).toBe('p');
		const acked = run({
			pose: pose({ lon: 0.1 }),
			volumes: [vol({}), p],
			acks: new Map([['p', SEVERITY_RANK.inside]]),
		});
		expect(acked.dominant?.key).toBe('k');
		expect(acked.alerts.find((a) => a.key === 'p')?.acked).toBe(true);
	});
});

describe('hysteresis and sound edges', () => {
	it('promotes instantly, demotes only after the hold', () => {
		const near = vol({});
		const far = vol({ rings: [rect(-0.1, 0.1, 0.1, 0.3)] });
		const r1 = run({ volumes: [near] });
		expect(r1.dominant?.severity).toBe('imminent');
		// The zone recedes (approaching raw): the shown state holds...
		const r2 = run({ nowMs: T0 + 1000, volumes: [far] }, r1.prev);
		expect(r2.dominant?.severity).toBe('imminent');
		// ...until the demotion hold elapses.
		const r3 = run({ nowMs: T0 + 1000 + DEMOTE_HOLD_MS + 1000, volumes: [far] }, r2.prev);
		expect(r3.dominant?.severity).toBe('approaching');
	});

	it('fires the avoid tier on approach, once, refiring only on escalation', () => {
		const p = vol({ key: 'p', type: 'P', category: 'restricted', rings: [rect(-0.1, 0.1, 0.1, 0.3)] });
		const r1 = run({ volumes: [p] });
		expect(r1.fired).toEqual([{ key: 'p', action: 'avoid', severity: 'approaching' }]);
		const r2 = run({ nowMs: T0 + 1000, volumes: [p] }, r1.prev);
		expect(r2.fired).toHaveLength(0);
		const r3 = run(
			{ nowMs: T0 + 2000, pose: pose({ lon: 0.09 }), volumes: [p] },
			r2.prev,
		);
		expect(r3.fired).toEqual([{ key: 'p', action: 'avoid', severity: 'imminent' }]);
	});

	it('re-arms a sounded volume only after the clear hold', () => {
		const p = vol({ key: 'p', type: 'P', category: 'restricted', rings: [rect(-0.1, 0.1, 0.1, 0.3)] });
		const away = pose({ lat: 5, lon: 5 });
		const a1 = run({ volumes: [p] });
		expect(a1.fired).toHaveLength(1);
		// Departing: the demotion hold keeps the banner briefly...
		const a2 = run({ nowMs: T0 + 60_000, pose: away, volumes: [p] }, a1.prev);
		expect(a2.alerts).toHaveLength(1);
		// ...then it clears, and the sound stays armed against re-fire.
		const t3 = T0 + 60_000 + DEMOTE_HOLD_MS + 1000;
		const a3 = run({ nowMs: t3, pose: away, volumes: [p] }, a2.prev);
		expect(a3.alerts).toHaveLength(0);
		const a4 = run({ nowMs: t3 + 30_000, volumes: [p] }, a3.prev);
		expect(a4.alerts).toHaveLength(1);
		expect(a4.fired).toHaveLength(0);
		// Away past the re-arm hold: the next approach fires again.
		const a5 = run({ nowMs: t3 + 40_000, pose: away, volumes: [p] }, a4.prev);
		const t6 = t3 + 40_000 + DEMOTE_HOLD_MS + 1000;
		const a6 = run({ nowMs: t6, pose: away, volumes: [p] }, a5.prev);
		expect(a6.alerts).toHaveLength(0);
		const a7 = run(
			{ nowMs: t6 + SOUND_REARM_MS + 1000, pose: away, volumes: [p] },
			a6.prev,
		);
		const a8 = run({ nowMs: t6 + SOUND_REARM_MS + 2000, volumes: [p] }, a7.prev);
		expect(a8.fired).toHaveLength(1);
	});

	it('does not sound the clearance tier before imminent, and respects acks', () => {
		const far = vol({ rings: [rect(-0.1, 0.1, 0.1, 0.3)] });
		expect(run({ volumes: [far] }).fired).toHaveLength(0);
		const r = run({ volumes: [vol({})], acks: new Map([['k', SEVERITY_RANK.imminent]]) });
		expect(r.fired).toHaveLength(0);
		expect(r.dominant?.acked).toBe(true);
		// Escalation past the ack re-alerts and re-sounds.
		const r2 = run(
			{ nowMs: T0 + 1000, pose: pose({ lon: 0.1 }), acks: new Map([['k', SEVERITY_RANK.imminent]]), volumes: [vol({})] },
			r.prev,
		);
		expect(r2.dominant?.acked).toBe(false);
		expect(r2.fired).toEqual([{ key: 'k', action: 'clearance', severity: 'inside' }]);
	});
});

describe('cumulative conditions (covered volumes)', () => {
	const r275 = (over: Partial<AlertVolume> = {}) =>
		vol({
			key: 'r',
			id: 'r',
			name: 'R X',
			type: 'R',
			airClass: '',
			category: 'restricted',
			// LF-R 275's own shape: permanently in force, VFR must avoid.
			entry: { vfr: 'forbidden', ifr: 'radio', permanent: true },
			...over,
		});
	const ctr = (over: Partial<AlertVolume> = {}) =>
		vol({ key: 'c', id: 'c', name: 'CTR X', type: 'CTR', category: 'controlled', ...over });

	it('stamps the covering prohibition on a coextensive clearance boundary', () => {
		const res = run({ volumes: [ctr(), r275()] });
		expect(res.dominant?.key).toBe('r');
		expect(res.dominant?.action).toBe('avoid');
		expect(res.dominant?.coveredBy).toBeNull();
		const c = res.alerts.find((a) => a.key === 'c');
		expect(c?.action).toBe('clearance');
		expect(c?.coveredBy).toBe('R X');
	});

	it('covers nobody once the zone permits this flight (the R 275 IFR case)', () => {
		// LF-R 275's IFR clause allows entry on radio contact, so under IFR it
		// is not an avoid volume and has no prohibition to lend; the CTR it is
		// coextensive with is silent under IFR anyway (the class-driven tier
		// is IFR-suppressed), which is why this pair is a VFR mechanism.
		const res = run({ volumes: [ctr(), r275()], profile: { vfr: false } });
		expect(res.alerts.find((a) => a.key === 'r')?.action).toBe('radio');
		expect(res.alerts.find((a) => a.key === 'c')).toBeUndefined();
	});

	it('survives the covering volume being acknowledged (the CTR PARIS case)', () => {
		const res = run({
			volumes: [ctr(), r275()],
			acks: new Map([['r', SEVERITY_RANK.imminent]]),
		});
		expect(res.dominant?.key).toBe('c');
		expect(res.dominant?.coveredBy).toBe('R X');
	});

	it('survives the avoid tier being off', () => {
		const res = run({
			volumes: [ctr(), r275()],
			tiers: { avoid: false, clearance: true, equipment: true, caution: true },
		});
		expect(res.alerts.map((a) => a.key)).toEqual(['c']);
		expect(res.dominant?.coveredBy).toBe('R X');
	});

	it('composes only when the projected entry point is inside the cover', () => {
		// The R starts 6 NM past the CTR boundary: the entry at lon 0.05 is
		// outside it, so the CTR line keeps its own contact form.
		const rings: [number, number][][] = [rect(-0.1, 0.1, 0.2, 0.3)];
		const res = run({ volumes: [ctr(), r275({ rings, bbox: ringBbox(rings[0]) })] });
		expect(res.alerts.find((a) => a.key === 'c')?.coveredBy).toBeNull();
	});

	it('needs the cover vertically in at the pose altitude', () => {
		// R ceiling 2500 under the 3000 ft pose: vertically out, skipped.
		const res = run({ volumes: [ctr(), r275({ vLower: L(0), vUpper: L(2500) })] });
		expect(res.alerts.find((a) => a.key === 'c')?.coveredBy).toBeNull();
	});

	it('a cold R covers nobody', () => {
		const cold = r275({ entry: NO_ENTRY, activity: { kind: 'notam' } });
		const res = run({ volumes: [ctr(), cold] });
		expect(res.alerts.map((a) => a.key)).toEqual(['c']);
		expect(res.dominant?.coveredBy).toBeNull();
	});

	it('composes the inside form from the pose', () => {
		const res = run({ pose: pose({ lon: 0.1 }), volumes: [ctr(), r275()] });
		const c = res.alerts.find((a) => a.key === 'c');
		expect(c?.severity).toBe('inside');
		expect(c?.coveredBy).toBe('R X');
	});

	it('keeps the planned flag beside the composition', () => {
		// Rank demotion and sound suppression stay planned semantics; the
		// phrasing precedence (covered over planned) is the surface rule.
		const res = run({ volumes: [ctr(), r275()], plannedKeys: new Set(['c']) });
		const c = res.alerts.find((a) => a.key === 'c');
		expect(c?.planned).toBe(true);
		expect(c?.coveredBy).toBe('R X');
	});
});

describe('trajectory-projected entry', () => {
	// Default geometry: entry 3 NM ahead at 120 kt = 90 s; pose 3000 ft.
	it('a descent passing under a floor ahead stays silent (the R 205/3 case)', () => {
		// 100 ft under the 3100 floor now (buffer overlap), descending away:
		// projected entry altitude 3000 - 400 * 1.5 = 2400, clear of the band.
		const r = run({ pose: pose({ vsFpm: -400 }), volumes: [vol({ vLower: L(3100) })] });
		expect(r.dominant).toBeNull();
	});

	it('level just under a floor ahead is the quiet note, without the chime', () => {
		const forbidden = vol({
			type: 'R',
			airClass: '',
			category: 'restricted',
			entry: { vfr: 'forbidden', ifr: 'forbidden', permanent: true },
			vLower: L(3100),
		});
		const r = run({ volumes: [forbidden] });
		expect(r.dominant?.severity).toBe('proximity');
		expect(r.dominant?.verticalGap).toBe(true);
		expect(r.dominant?.gapSide).toBe('below');
		expect(r.dominant?.etaSec).toBeNull();
		expect(r.fired).toHaveLength(0);
	});

	it('a climb reaching a shelf ahead alerts, out of vertical reach at the pose', () => {
		// Floor 3800 is beyond the 200 ft buffer at 3000; the widened gate
		// (pad 600 * 2) keeps the volume, and the projected entry altitude
		// 3000 + 600 * 1.5 = 3900 is strictly in the band.
		const r = run({ pose: pose({ vsFpm: 600 }), volumes: [vol({ vLower: L(3800) })] });
		expect(r.dominant?.severity).toBe('imminent');
		expect(r.dominant?.verticalGap).toBe(false);
		expect(r.dominant?.etaSec).toBeCloseTo(90, 0);
	});

	it('laterally inside, a climb closing a beyond-buffer gap escalates', () => {
		// 800 ft under the shelf, 600 fpm up: the gap closes in 80 s.
		const r = run({
			pose: pose({ lon: 0.1, vsFpm: 600 }),
			volumes: [vol({ vLower: L(3800) })],
		});
		expect(r.dominant?.severity).toBe('imminent');
		expect(r.dominant?.gapClosing).toBe(true);
		expect(r.dominant?.gapSide).toBe('below');
	});

	it('laterally inside, level beyond the buffer stays silent', () => {
		const r = run({ pose: pose({ lon: 0.1 }), volumes: [vol({ vLower: L(3800) })] });
		expect(r.dominant).toBeNull();
	});

	it('an underivable vertical speed reads level', () => {
		const r = run({ pose: pose({ vsFpm: null }), volumes: [vol({ vLower: L(3100) })] });
		expect(r.dominant?.severity).toBe('proximity');
		expect(r.dominant?.verticalGap).toBe(true);
	});

	it('credits the vertical speed over at most the imminent horizon', () => {
		// Entry 8 NM = 240 s out, climbing 150 fpm toward a 3400 floor: the
		// capped credit (120 s) projects 3300, buffer only; the full 240 s
		// would reach 3600, strictly in.
		const r = run({
			pose: pose({ vsFpm: 150 }),
			volumes: [vol({ vLower: L(3400), rings: [rect(-0.1, 0.1, 0.1333, 0.3)] })],
		});
		expect(r.dominant?.severity).toBe('proximity');
		expect(r.dominant?.verticalGap).toBe(true);
		expect(r.dominant?.gapSide).toBe('below');
	});
});

describe('projection terrain clamp', () => {
	it('a steep descent at low height cannot project underground', () => {
		// 500 ft over 300 ft terrain, 600 fpm down toward a surface volume:
		// the raw projection (-700 ft) clamps at the terrain, in the band.
		const r = run({
			pose: pose({ mslFt: 500, vsFpm: -600 }),
			groundFt: 300,
			volumes: [vol({ vLower: L(0), vUpper: L(2000) })],
		});
		expect(r.dominant?.severity).toBe('imminent');
		expect(r.dominant?.verticalGap).toBe(false);
	});
});
