/* The forward-looking terrain and obstacle alert (nav/terrainAlert.ts,
 * docs/terrain-awareness.md): TSO-C151c's clearance table by phase, the
 * stateless phase rules, the rise gate that keeps a legal low leg and a
 * landing quiet, the 60 s caution and 30 s warning, the vertical-speed
 * credit and its cap, Garmin's runway inhibit and the pilot's own, the
 * obstacles, the corridor that could not be read, and the airspace engine's
 * presentation memory (the demotion hold, acknowledgement with escalation,
 * the sound edges and their re-arm). The airspace spec's helper idiom: the
 * aircraft flies east at 120 kt, 61.7 m/s, so a 200 m bin is 3.24 s. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	AERODROME_SURROUND_FT,
	CAUTION_S,
	DEMOTE_HOLD_MS,
	RISE_FT,
	RTC_FT,
	SOUND_REARM_MS,
	VFR_CLEARANCE_FT,
	emptyTerrainPrev,
	evaluateTerrain,
	flightPhase,
	obstacleThreat,
	requiredClearanceFt,
	type TerrainField,
	type TerrainGround,
	type TerrainInput,
	type TerrainObstacle,
	type TerrainPose,
	type TerrainPrevState,
} from '$lib/nav/terrainAlert';
import {
	binMax,
	metresToFeet,
	peekCapsuleGround,
	reduceCapsuleFromTiles,
	tileColLon,
	tileRowLat,
	type DecodedTile,
} from '$lib/map/terrain';
import { decodeTerrainTile } from '$lib/map/terrainTile';
import { destinationPoint } from '$lib/notam/geometry';

const T0 = Date.parse('2026-07-08T13:40:00Z');
const MPS = (120 * 1852) / 3600;
const BIN_S = 200 / MPS;

function pose(over: Partial<TerrainPose> = {}): TerrainPose {
	return { lat: 46, lon: 6, mslFt: 3000, altTrusted: true, trackDeg: 90, speedKt: 120, vsFpm: 0, ...over };
}

/** The corridor's ground from a function of the bin index, 20 bins (65 s). */
function ground(fn: (i: number) => number | null, missing = 0, bins = 20): TerrainGround {
	return { binM: 200, maxFt: Array.from({ length: bins + 1 }, (_, i) => fn(i)), missing, nearField: null };
}

/** Flat ground everywhere, then a wall of `topFt` from bin `from` on. */
function wall(from: number, topFt: number, baseFt = 1000): TerrainGround {
	return ground((i) => (i >= from ? topFt : baseFt));
}

function input(over: Partial<TerrainInput> = {}): TerrainInput {
	return {
		nowMs: T0,
		pose: pose(),
		// The grading mechanics below run under the TSO table (IFR); the VFR
		// clearance has its own block.
		vfr: false,
		airborne: true,
		departureEnded: true,
		field: null,
		ground: ground(() => 1000),
		obstacles: [],
		acks: new Map(),
		tiers: { terrain: true, obstacle: true },
		inhibited: false,
		...over,
	};
}

const run = (over: Partial<TerrainInput>, prev?: TerrainPrevState) => evaluateTerrain(input(over), prev ?? emptyTerrainPrev());

/** A mast `alongM` ahead (2 400 m: 39 s, a caution) standing to `topFt`. */
function mast(id: string, topFt: number, alongM = 2400): TerrainObstacle {
	return { id, name: id.toUpperCase(), type: 'mast', lat: 46, lon: 6.02, alongM, topFt, nearField: false };
}

function field(over: Partial<TerrainField> = {}): TerrainField {
	return { distNM: 10, bearingDeg: 90, elevFt: 300, ends: [{ lat: 46, lon: 6.2 }], ...over };
}

describe('the required clearance', () => {
	it('is the TSO-C151c table, descending from -300 fpm', () => {
		expect(RTC_FT).toEqual({
			enroute: { level: 700, descending: 500 },
			terminal: { level: 350, descending: 300 },
			approach: { level: 150, descending: 100 },
			departure: { level: 100, descending: 100 },
		});
		expect(requiredClearanceFt('enroute', 0, false)).toBe(700);
		expect(requiredClearanceFt('enroute', null, false)).toBe(700);
		expect(requiredClearanceFt('enroute', -299, false)).toBe(700);
		expect(requiredClearanceFt('enroute', -300, false)).toBe(500);
		expect(requiredClearanceFt('terminal', -800, false)).toBe(300);
		expect(requiredClearanceFt('approach', 0, false)).toBe(150);
	});

	it('is the terrain layer\'s red under VFR, in every phase', () => {
		for (const phase of ['enroute', 'terminal', 'approach', 'departure'] as const) {
			expect(requiredClearanceFt(phase, 0, true)).toBe(VFR_CLEARANCE_FT);
			expect(requiredClearanceFt(phase, -900, true)).toBe(VFR_CLEARANCE_FT);
		}
		expect(VFR_CLEARANCE_FT).toBe(100);
	});

	it('follows the phase, which needs no memory', () => {
		const base = { airborne: true, departureEnded: true, mslFt: 2500, trackDeg: 90 };
		expect(flightPhase({ ...base, departureEnded: false, field: null })).toBe('departure');
		expect(flightPhase({ ...base, field: null })).toBe('enroute');
		// Approach: within 5 NM, at or under 1 900 ft above, closing.
		expect(flightPhase({ ...base, mslFt: 2000, field: field({ distNM: 4 }) })).toBe('approach');
		expect(flightPhase({ ...base, mslFt: 2000, field: field({ distNM: 4, bearingDeg: 270 }) })).toBe('enroute');
		// Terminal: within 15 NM under the 3 500 ft (15 NM) to 1 900 ft (5 NM) line.
		expect(flightPhase({ ...base, mslFt: 2900, field: field({ distNM: 10 }) })).toBe('terminal'); // 2 600 above, line 2 700
		expect(flightPhase({ ...base, mslFt: 3100, field: field({ distNM: 10 }) })).toBe('enroute'); // 2 800 above
		expect(flightPhase({ ...base, mslFt: 2900, field: field({ distNM: 4 }) })).toBe('enroute'); // above 1 900 inside 5 NM
		expect(flightPhase({ ...base, field: field({ distNM: 16 }) })).toBe('enroute');
	});
});

describe('under VFR', () => {
	// The corpus case: out of the Marne valley at Lognes toward the Brie
	// plateau, 1 200 ft over 290 ft ground, the plateau edge at 495 ft.
	const plateau = ground((i) => (i >= 8 ? 495 : 290));

	it('leaves 700 ft over a plateau edge alone, which the IFR table warns about', () => {
		const at = { pose: pose({ mslFt: 1200, speedKt: 120, vsFpm: -200 }), ground: plateau };
		expect(run({ ...at, vfr: false }).alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['terrain:warning']);
		expect(run({ ...at, vfr: true }).alerts).toEqual([]);
	});

	it('alerts where the terrain layer shows red on the path', () => {
		// 1 200 ft over 800 ft ground, a ridge at 1 150 ft: 50 ft of clearance.
		const r = run({ vfr: true, pose: pose({ mslFt: 1200 }), ground: wall(12, 1150, 800) });
		expect(r.alerts[0]).toMatchObject({ kind: 'terrain', level: 'caution', rtcFt: 100, rules: 'vfr' });
		const w = run({ vfr: true, pose: pose({ mslFt: 1200 }), ground: wall(8, 1150, 800) });
		expect(w.alerts[0].level).toBe('warning');
		// 150 ft over the ridge top is yellow on the map, and silent here.
		expect(run({ vfr: true, pose: pose({ mslFt: 1300 }), ground: wall(8, 1150, 800) }).alerts).toEqual([]);
	});

	it('passes a pylon 560 ft below and alerts on a turbine at the path', () => {
		const at1500 = (id: string, type: TerrainObstacle['type'], topFt: number): TerrainObstacle => ({
			id,
			name: id,
			type,
			lat: 46,
			lon: 6.02,
			alongM: 1500,
			topFt,
			nearField: false,
		});
		const pylon = at1500('py', 'pylon', 640);
		const turbine = at1500('wt', 'windturbine', 1150);
		const at = { vfr: true, pose: pose({ mslFt: 1200 }), ground: ground(() => 400) };
		expect(run({ ...at, obstacles: [pylon] }).alerts).toEqual([]);
		expect(run({ ...at, obstacles: [turbine] }).alerts[0]).toMatchObject({ kind: 'obstacle', level: 'warning' });
	});
});

describe("the aerodrome's surroundings", () => {
	// A plateau field at 450 ft over a 300 ft valley: descending onto it, the
	// plateau edge rises into the projection 25 s ahead.
	const edge = (nearField: boolean[] | null, top = 455): TerrainGround => ({
		...ground((i) => (i >= 8 ? top : 300)),
		nearField,
	});
	const zone = Array.from({ length: 21 }, (_, i) => i >= 6);
	const approach = {
		vfr: true,
		pose: pose({ mslFt: 700, speedKt: 80, vsFpm: -600 }),
		field: field({ distNM: 1.5, elevFt: 450 }),
	};

	it('never alerts on ground under 500 ft above the field, near its runways', () => {
		expect(run({ ...approach, ground: edge(null) }).alerts.map((a) => a.kind)).toEqual(['terrain']);
		expect(run({ ...approach, ground: edge(zone) }).alerts).toEqual([]);
		// The tree line a surface model carries at a runway end, 200 ft up.
		expect(run({ ...approach, ground: edge(zone, 650) }).alerts).toEqual([]);
	});

	it('keeps relief standing higher near the field a threat', () => {
		expect(
			run({ ...approach, ground: edge(zone, 450 + AERODROME_SURROUND_FT + 50) }).alerts.map((a) => a.kind),
		).toEqual(['terrain']);
	});

	it('leaves the charted obstacles of the circuit out, and not a taller one', () => {
		// Lognes' water towers: 238 ft above the field, 1 NM from it.
		const tower = (topFt: number, nearField: boolean): TerrainObstacle => ({
			id: 'wt',
			name: '77014',
			type: 'watertower',
			lat: 48.8388,
			lon: 2.6155,
			alongM: 1500,
			topFt,
			nearField,
		});
		const circuit = {
			vfr: true,
			pose: pose({ mslFt: 600 }),
			ground: ground(() => 360),
			field: field({ distNM: 0.7, elevFt: 359 }),
		};
		expect(run({ ...circuit, obstacles: [tower(597, true)] }).alerts).toEqual([]);
		expect(run({ ...circuit, obstacles: [tower(597, false)] }).alerts.map((a) => a.kind)).toEqual(['obstacle']);
		expect(run({ ...circuit, obstacles: [tower(359 + AERODROME_SURROUND_FT + 10, true)] }).alerts).toHaveLength(1);
	});
});

describe('the rise gate', () => {
	it('keeps a legal 500 ft leg over flat country quiet', () => {
		const r = run({ pose: pose({ mslFt: 1500 }), ground: ground(() => 1000) });
		expect(r.alerts).toEqual([]);
		expect(r.idle).toBeNull();
		expect(r.phase).toBe('enroute');
	});

	it('keeps a descent onto flat ground quiet, the landing at an unlisted strip', () => {
		const r = run({ pose: pose({ mslFt: 1150, vsFpm: -500 }), ground: ground(() => 1000) });
		expect(r.alerts).toEqual([]);
	});

	it('lets rising ground through from RISE_FT above the ground here', () => {
		// 3 000 ft, flat 1 000 ft then 2 400 ft ahead: 600 ft of clearance.
		const within = run({ ground: wall(12, 1000 + RISE_FT + 1300) });
		expect(within.alerts.map((a) => a.kind)).toEqual(['terrain']);
		// The same clearance off ground that does not rise: a plateau under
		// the aircraft already.
		const plateau = run({ ground: ground(() => 2400) });
		expect(plateau.alerts).toEqual([]);
	});

	it('gives way to ground on the track standing above the aircraft', () => {
		// In a valley at 3 000 ft, its wall 3 400 ft high inside the corridor
		// beside the aircraft and all along: the corridor's highest ground
		// never rises, so the gate holds.
		const valley = { vfr: true, ground: ground(() => 3400) };
		expect(run(valley).alerts).toEqual([]);
		// A spur across the track 26 s on, 3 300 ft high: under the wall, over
		// the aircraft. Gated against the wall, it went silent.
		const spur = { ...valley.ground, trackFt: valley.ground.maxFt.map((_, i) => (i >= 8 ? 3300 : 2000)) };
		expect(run({ ...valley, ground: spur }).alerts[0]).toMatchObject({
			kind: 'terrain',
			level: 'warning',
			threatFt: 3300,
		});
		// The same spur 100 ft under the aircraft: the gate decides again.
		const under = { ...valley.ground, trackFt: valley.ground.maxFt.map((_, i) => (i >= 8 ? 2900 : 2000)) };
		expect(run({ ...valley, ground: under }).alerts).toEqual([]);
	});

	it('grades ground on the track above the aircraft with the ground under it unknown', () => {
		const g = ground((i) => (i >= 12 ? 3300 : i < 3 ? null : 2000), 1);
		const r = run({ vfr: true, ground: { ...g, trackFt: g.maxFt } });
		expect(r.alerts[0]).toMatchObject({ kind: 'terrain', threatFt: 3300 });
		// Rising ground under the aircraft, with the ground under it unknown,
		// cannot be measured against it: unread.
		const low = run({ vfr: true, ground: { ...g, trackFt: g.maxFt.map((v) => (v == null ? null : v - 800)) } });
		expect(low.alerts).toEqual([]);
		expect(low.unread).toBe(true);
	});
});

describe('the horizons', () => {
	it('grades a ridge inside 60 s a caution and inside 30 s a warning', () => {
		// 3 000 ft, a 2 800 ft ridge: 200 ft of clearance, under 700.
		const caution = run({ ground: wall(10, 2800) }); // 32.4 s
		expect(caution.alerts).toHaveLength(1);
		expect(caution.alerts[0]).toMatchObject({ kind: 'terrain', level: 'caution', rtcFt: 700, threatFt: 2800 });
		expect(caution.alerts[0].etaSec).toBeCloseTo(10 * BIN_S, 6);
		expect(caution.alerts[0].clearanceFt).toBeCloseTo(200, 6);
		const warning = run({ ground: wall(9, 2800) }); // 29.2 s
		expect(warning.alerts[0].level).toBe('warning');
		// Past the minute: nothing.
		const far = run({ ground: wall(Math.ceil(CAUTION_S / BIN_S) + 1, 2800) });
		expect(far.alerts).toEqual([]);
	});

	it('names the stretch the ridge covers and the worst clearance in it', () => {
		const g = ground((i) => (i >= 10 && i <= 12 ? 2600 + (i - 10) * 150 : 1000));
		const r = run({ ground: g });
		// The EDGES of the bins, bin i spanning (i -/+ 0.5) * 200 m: the map's
		// patch once started half a bin past the ground it outlines.
		expect(r.alerts[0].alongM).toBe(1900);
		expect(r.alerts[0].toM).toBe(2500);
		expect(r.alerts[0].clearanceFt).toBeCloseTo(3000 - 2900, 6);
	});

	it('reads a path into the ground as a warning, the clearance negative', () => {
		const r = run({ ground: wall(5, 3400) });
		expect(r.alerts[0]).toMatchObject({ level: 'warning' });
		expect(r.alerts[0].clearanceFt).toBeCloseTo(-400, 6);
	});
});

describe('the vertical speed', () => {
	it('credits a climb that clears the ridge', () => {
		// +2 000 fpm over 30 s: +1 000 ft at the ridge, 1 200 ft of clearance.
		expect(run({ pose: pose({ vsFpm: 2000 }), ground: wall(10, 2800) }).alerts).toEqual([]);
	});

	it('charges a descent, and reads the descending clearance', () => {
		// -1 000 fpm: 500 ft lower by 30 s, and 500 ft required, descending.
		const r = run({ pose: pose({ mslFt: 3400, vsFpm: -1000 }), ground: wall(10, 2500) });
		expect(r.alerts[0].rtcFt).toBe(500);
		expect(r.alerts[0].clearanceFt).toBeCloseTo(3400 - 500 - 2500, 6);
		// Exactly the required clearance is enough.
		expect(run({ pose: pose({ mslFt: 3400, vsFpm: -1000 }), ground: wall(10, 2400) }).alerts).toEqual([]);
	});

	it('credits it over at most 30 s', () => {
		// 45 s ahead at -600 fpm: 300 ft, not 450.
		const i = Math.round(45 / BIN_S);
		const r = run({ pose: pose({ vsFpm: -600 }), ground: wall(i, 2300) });
		expect(r.alerts[0].clearanceFt).toBeCloseTo(3000 - 300 - 2300, 6);
	});
});

describe('the gates and inhibits', () => {
	it('says why nothing was graded', () => {
		expect(run({ airborne: false }).idle).toBe('ground');
		expect(run({ pose: pose({ mslFt: null }) }).idle).toBe('noAltitude');
		expect(run({ pose: pose({ altTrusted: false }) }).idle).toBe('noAltitude');
		expect(run({ pose: pose({ trackDeg: null }) }).idle).toBe('noTrack');
		expect(run({ pose: pose({ speedKt: 3 }) }).idle).toBe('noTrack');
		expect(run({ inhibited: true, ground: wall(5, 3400) })).toMatchObject({ idle: 'inhibited', alerts: [] });
	});

	it('inhibits close to the ground at a known aerodrome, Garmin automatic inhibit', () => {
		const onFinal = field({ distNM: 0.8, elevFt: 900, ends: [{ lat: 46, lon: 6.01 }] });
		const low = run({ pose: pose({ mslFt: 1050 }), field: onFinal, ground: wall(5, 3400) });
		expect(low.idle).toBe('runway');
		// Two hundred feet or more above it, the alert runs.
		const high = run({ pose: pose({ mslFt: 1100 }), field: onFinal, ground: wall(5, 3400) });
		expect(high.idle).toBeNull();
		expect(high.alerts).toHaveLength(1);
		// And beyond a mile of every runway end, the height does not inhibit.
		const away = run({ pose: pose({ mslFt: 1050 }), field: field({ elevFt: 900, ends: [{ lat: 46.1, lon: 6 }] }), ground: wall(5, 3400) });
		expect(away.idle).toBeNull();
	});

	it('uses the departure clearance until 1 500 ft above the departure', () => {
		const r = run({ departureEnded: false, ground: wall(10, 2800) });
		// 200 ft of clearance is more than the 100 ft the departure asks.
		expect(r.alerts).toEqual([]);
		expect(r.phase).toBe('departure');
	});
});

describe('obstacles', () => {
	function obstacle(alongM: number, topFt: number, id = 'o1'): TerrainObstacle {
		return { id, name: 'MAST', type: 'mast', lat: 46, lon: 6.02, alongM, topFt, nearField: false };
	}

	it('grade against the same clearance, without a rise gate', () => {
		const r = run({ obstacles: [obstacle(1500, 2500)] }); // 24.3 s, 500 ft clear
		expect(r.alerts).toHaveLength(1);
		expect(r.alerts[0]).toMatchObject({ kind: 'obstacle', level: 'warning', threatFt: 2500 });
		expect(r.alerts[0].obstacle?.id).toBe('o1');
	});

	it('name the sooner threat, ignore what is behind or clear', () => {
		const r = run({
			obstacles: [obstacle(3000, 2600, 'late'), obstacle(2000, 2500, 'soon'), obstacle(-200, 2900, 'behind'), obstacle(1000, 1500, 'low')],
		});
		expect(r.alerts[0].obstacle?.id).toBe('soon');
	});

	it('stay silent with their row off', () => {
		expect(run({ obstacles: [obstacle(1500, 2500)], tiers: { terrain: true, obstacle: false } }).alerts).toEqual([]);
	});
});

describe('a corridor not fully read', () => {
	it('grades nothing it cannot see, and says so', () => {
		const r = run({ ground: ground(() => null, 2) });
		expect(r.alerts).toEqual([]);
		expect(r.unread).toBe(true);
	});

	it('still grades the ground it has', () => {
		const r = run({ ground: ground((i) => (i >= 10 ? 2800 : i < 3 ? 1000 : null), 1) });
		expect(r.alerts[0]?.kind).toBe('terrain');
		expect(r.unread).toBe(false);
	});

	it('says so beside an obstacle row too', () => {
		// The caveat is about the ground: a mast's row once hid it.
		const r = run({ ground: ground(() => null, 2), obstacles: [mast('m', 3300)] });
		expect(r.alerts.map((a) => a.kind)).toEqual(['obstacle']);
		expect(r.unread).toBe(true);
	});

	it('reads empty bins as the sea once every tile is in', () => {
		// Over the sea at 300 ft, a 600 ft cliff ahead.
		const r = run({ pose: pose({ mslFt: 300 }), ground: ground((i) => (i >= 12 ? 600 : null), 0) });
		expect(r.alerts[0]).toMatchObject({ kind: 'terrain', threatFt: 600 });
		expect(run({ pose: pose({ mslFt: 300 }), ground: ground(() => null, 0) }).alerts).toEqual([]);
	});
});

describe('the presentation memory', () => {
	it('holds a demotion for 10 s with the last threat named', () => {
		const a = run({ ground: wall(9, 2800) });
		expect(a.alerts[0].level).toBe('warning');
		expect(a.alerts[0].held).toBe(false);
		const held = run({ nowMs: T0 + 1000, ground: ground(() => 1000) }, a.prev);
		expect(held.alerts[0]).toMatchObject({ level: 'warning', threatFt: 2800, held: true });
		const still = run({ nowMs: T0 + 1000 + DEMOTE_HOLD_MS - 1, ground: ground(() => 1000) }, held.prev);
		expect(still.alerts).toHaveLength(1);
		const gone = run({ nowMs: T0 + 1000 + DEMOTE_HOLD_MS, ground: ground(() => 1000) }, still.prev);
		expect(gone.alerts).toEqual([]);
	});

	it('fires a sound once per level, and again on an escalation', () => {
		const caution = run({ ground: wall(12, 2800) });
		expect(caution.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
		const again = run({ nowMs: T0 + 1000, ground: wall(11, 2800) }, caution.prev);
		expect(again.fired).toEqual([]);
		const warning = run({ nowMs: T0 + 2000, ground: wall(8, 2800) }, again.prev);
		expect(warning.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
	});

	it("re-arms an obstacle's sound only after five quiet minutes", () => {
		const at = run({ ground: ground(() => 1000), obstacles: [mast('m', 3300)] });
		expect(at.fired).toEqual([{ kind: 'obstacle', level: 'caution' }]);
		// The demotion hold starts at the first clear tick and runs out.
		const held = run({ nowMs: T0 + 1000 }, at.prev);
		const goneAt = T0 + 1000 + DEMOTE_HOLD_MS;
		const gone = run({ nowMs: goneAt }, held.prev);
		expect(gone.alerts).toEqual([]);
		// The same mast back within the five minutes: shown, silent.
		const soon = run({ nowMs: goneAt + 60_000, obstacles: [mast('m', 3300)] }, gone.prev);
		expect(soon.alerts).toHaveLength(1);
		expect(soon.fired).toEqual([]);
		// Back after them: it sounds, with or without a clear tick between.
		const later = run({ nowMs: goneAt + SOUND_REARM_MS, obstacles: [mast('m', 3300)] }, gone.prev);
		expect(later.fired).toEqual([{ kind: 'obstacle', level: 'caution' }]);
	});

	it('sounds for the next ridge, and not again for the same one within five minutes', () => {
		// A ground threat is named by where its threatening stretch lies: the
		// next ridge, 7.7 km on, is a new threat, where the one constant
		// "ground" key once kept it silent (and acknowledged) on the memory of
		// the first.
		const first = run({ ground: wall(12, 2800) });
		expect(first.fired).toHaveLength(1);
		const held = run({ nowMs: T0 + 1000, ground: ground(() => 1000) }, first.prev);
		const goneAt = T0 + 1000 + DEMOTE_HOLD_MS;
		const gone = run({ nowMs: goneAt, ground: ground(() => 1000) }, held.prev);
		expect(gone.alerts).toEqual([]);
		const same = run({ nowMs: goneAt + 1000, ground: wall(12, 2800) }, gone.prev);
		expect(same.fired).toEqual([]);
		expect(same.alerts[0].threat).toBe(first.alerts[0].threat);
		const next = run({ nowMs: goneAt + 2000, pose: pose({ lon: 6.1 }), ground: wall(12, 2800) }, same.prev);
		expect(next.alerts[0].threat).not.toBe(first.alerts[0].threat);
		expect(next.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
	});

	it('names a new ridge afresh inside the hold, after a gap, and with the row never letting go', () => {
		// The three ways one ridge's acknowledgement once reached the next.
		const a = run({ ground: wall(8, 2800) });
		const acks = new Map([[a.alerts[0].threat, 2]]);
		const ackedA = run({ nowMs: T0 + 1000, ground: wall(8, 2800), acks }, a.prev);
		expect(ackedA.alerts[0].acked).toBe(true);
		// Inside the hold: A's row held, a ridge 7.7 km on comes up.
		const hold = run({ nowMs: T0 + 2000, ground: ground(() => 1000), acks }, ackedA.prev);
		expect(hold.alerts[0].held).toBe(true);
		const b = run({ nowMs: T0 + 3000, pose: pose({ lon: 6.1 }), ground: wall(8, 2800), acks }, hold.prev);
		expect(b.alerts[0]).toMatchObject({ level: 'warning', acked: false, held: false });
		expect(b.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
		// The row never letting go: A becomes B from one fix to the next.
		const c = run({ nowMs: T0 + 2000, pose: pose({ lon: 6.1 }), ground: wall(8, 2800), acks }, ackedA.prev);
		expect(c.alerts[0]).toMatchObject({ acked: false });
		expect(c.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
		// After a gap longer than the hold.
		const d = run({ nowMs: T0 + 60_000, pose: pose({ lon: 6.1 }), ground: wall(8, 2800), acks }, ackedA.prev);
		expect(d.alerts[0]).toMatchObject({ acked: false });
		expect(d.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
	});

	it('keeps one threat, and one sound, as higher ground comes into the look-ahead', () => {
		// A threat named by its crest was renamed whenever a higher summit
		// entered the minute ahead, and sounded again each time: seven times
		// in 38 s on one corpus flight.
		const binDeg = 200 / (111_320 * Math.cos((46 * Math.PI) / 180));
		let prev = emptyTerrainPrev();
		const threats = new Set<string>();
		let fired = 0;
		for (let k = 0; k < 12; k++) {
			// One bin further on each second over fixed ground: a massif from
			// bin 16 of the first fix on, a summit every fifth bin, each higher
			// than the last, so the highest ground ahead jumps 1 km each time
			// another comes into view.
			const r = run(
				{
					nowMs: T0 + k * 1000,
					pose: pose({ lon: 6 + k * binDeg }),
					ground: ground((i) => (i + k >= 16 ? 3200 + 50 * Math.floor((i + k) / 5) : 1000)),
				},
				prev,
			);
			for (const a of r.alerts) {
				threats.add(a.threat);
			}
			fired += r.fired.length;
			prev = r.prev;
		}
		expect(threats.size).toBe(1);
		expect(fired).toBe(2); // the caution, then the warning
	});

	it('treats a different obstacle as a new threat', () => {
		// Mast A acknowledged at its warning; mast B then comes inside the
		// clearance. B arrived already acknowledged and silent while the
		// ledger and the sound memory were keyed by kind.
		const a = run({ obstacles: [mast('a', 3300, 1500)] });
		expect(a.alerts[0]).toMatchObject({ kind: 'obstacle', level: 'warning', threat: obstacleThreat('a') });
		const acks = new Map([[obstacleThreat('a'), 2]]);
		const ackedA = run({ nowMs: T0 + 1000, obstacles: [mast('a', 3300, 1500)], acks }, a.prev);
		expect(ackedA.alerts[0].acked).toBe(true);
		const b = run({ nowMs: T0 + 2000, obstacles: [mast('b', 3300, 3000)], acks }, ackedA.prev);
		expect(b.alerts[0]).toMatchObject({ threat: obstacleThreat('b'), level: 'caution', acked: false, held: false });
		expect(b.fired).toEqual([{ kind: 'obstacle', level: 'caution' }]);
	});

	it("shows a new threat at its own level, never under the last one's hold", () => {
		const a = run({ obstacles: [mast('a', 3300, 1500)] });
		expect(a.alerts[0].level).toBe('warning');
		const b = run({ nowMs: T0 + 1000, obstacles: [mast('b', 3300, 3000)] }, a.prev);
		expect(b.alerts[0]).toMatchObject({ threat: obstacleThreat('b'), level: 'caution' });
	});

	it('holds nothing across a gap longer than the hold', () => {
		// Ten minutes without an evaluation (a lost position, a forward
		// scrub): a new caution once came back as the old WARNING, held, and
		// silent, the sound having never seen a clear tick.
		const warn = run({ ground: wall(8, 2800) });
		expect(warn.alerts[0].level).toBe('warning');
		const later = run({ nowMs: T0 + 600_000, ground: wall(13, 2800) }, warn.prev);
		expect(later.alerts[0]).toMatchObject({ level: 'caution', held: false });
		expect(later.fired).toEqual([{ kind: 'terrain', level: 'caution' }]);
		// And an obstacle's memory counts its quiet from the last evaluation.
		const m = run({ obstacles: [mast('m', 3300)] });
		const back = run({ nowMs: T0 + SOUND_REARM_MS, obstacles: [mast('m', 3300)] }, m.prev);
		expect(back.fired).toEqual([{ kind: 'obstacle', level: 'caution' }]);
	});

	it('keeps an acknowledged caution quiet until it escalates', () => {
		const seen = run({ ground: wall(12, 2800) });
		const acks = new Map([[seen.alerts[0].threat, 1]]);
		const caution = run({ nowMs: T0 + 1000, ground: wall(12, 2800), acks }, seen.prev);
		expect(caution.alerts[0].acked).toBe(true);
		expect(caution.fired).toEqual([]);
		// The same ridge, nearer: its stretch lies where it lay.
		const warning = run({ nowMs: T0 + 2000, pose: pose({ lon: 6 + 800 / (111_320 * Math.cos((46 * Math.PI) / 180)) }), ground: wall(8, 2800), acks }, caution.prev);
		expect(warning.alerts[0].threat).toBe(seen.alerts[0].threat);
		expect(warning.alerts[0].acked).toBe(false);
		expect(warning.fired).toEqual([{ kind: 'terrain', level: 'warning' }]);
	});

	it('orders the rows: unacknowledged, warning, then the sooner', () => {
		const obs: TerrainObstacle = {
			id: 'm',
			name: 'MAST',
			type: 'mast',
			lat: 46,
			lon: 6.02,
			alongM: 1500,
			topFt: 2500,
			nearField: false,
		};
		const r = run({ ground: wall(12, 2800), obstacles: [obs] });
		expect(r.alerts.map((a) => `${a.kind}:${a.level}`)).toEqual(['obstacle:warning', 'terrain:caution']);
		const acked = run({ ground: wall(12, 2800), obstacles: [obs], acks: new Map([[obstacleThreat('m'), 2]]) });
		expect(acked.alerts.map((a) => a.kind)).toEqual(['terrain', 'obstacle']);
	});
});

describe('over real ground', () => {
	it('warns of Mont Blanc from its own tile, read through the capsule', async () => {
		const decoded = await decodeTerrainTile(readFileSync('tests/fixtures/terrain-alps-12-2126-1459.tile'));
		const tile: DecodedTile = {
			z: decoded!.z,
			tx: decoded!.x,
			ty: decoded!.y,
			mean: decoded!.mean,
			max: decoded!.max ?? decoded!.mean,
			min: decoded!.min ?? decoded!.mean,
		};
		let top = 0;
		for (let i = 1; i < tile.max.length; i++) {
			if (tile.max[i] > tile.max[top]) {
				top = i;
			}
		}
		const summit = {
			lat: tileRowLat(tile.z, tile.ty, Math.floor(top / 256)),
			lon: tileColLon(tile.z, tile.tx, top % 256),
		};
		const summitFt = metresToFeet(tile.max[top]);
		expect(summitFt).toBeGreaterThan(15000);
		// 1.5 km short of it, heading straight at it, 500 ft under the top.
		const start = destinationPoint(summit.lat, summit.lon, 45, 1500);
		const lookup = (z: number, x: number, y: number): DecodedTile | undefined =>
			z === tile.z && x === tile.tx && y === tile.ty ? tile : undefined;
		const lenM = MPS * CAUTION_S + 200;
		const dest = destinationPoint(start.lat, start.lon, 225, lenM);
		const alongBins = Math.round(lenM / 200);
		const opts = { halfWidthM: 0.25 * 1852, alongBins, crossMax: 0 };
		const peek = reduceCapsuleFromTiles(start, dest, { ...opts, z: 12 }, lookup);
		// The summit sits in the tile's south-west corner: past it the
		// corridor leaves the one tile the lookup holds, and the ground
		// there is unknown rather than clear.
		expect(peek.missing.length).toBeGreaterThan(0);
		const maxFt = Array.from({ length: alongBins + 1 }, (_, i) => {
			const m = binMax(peek.bins, i);
			return m == null ? null : metresToFeet(m);
		});
		expect(maxFt[0]).not.toBeNull();
		const r = run({
			pose: pose({ lat: start.lat, lon: start.lon, mslFt: summitFt - 500, trackDeg: 225 }),
			ground: { binM: peek.frame.alongBinM, maxFt, missing: peek.missing.length, nearField: null },
		});
		expect(r.alerts).toHaveLength(1);
		expect(r.alerts[0]).toMatchObject({ kind: 'terrain', level: 'warning' });
		expect(r.alerts[0].threatFt).toBeCloseTo(summitFt, 0);
		expect(r.alerts[0].etaSec).toBeLessThan(1500 / MPS + 5);
	});

	it('falls back a level when the preferred tiles are not in hand', () => {
		const flat = (z: number, tx: number, ty: number, v: number): DecodedTile => {
			const band = new Int16Array(256 * 256).fill(v);
			return { z, tx, ty, mean: band, max: band, min: band };
		};
		const a = { lat: 45.9, lon: 6.9 };
		const b = destinationPoint(a.lat, a.lon, 90, 3000);
		const opts = { halfWidthM: 463, alongBins: 15, crossMax: 0 };
		// Only level 10 answers, and with every tile it needs.
		const lookup = (z: number, x: number, y: number): DecodedTile | undefined =>
			z === 10 ? flat(z, x, y, 1500) : undefined;
		const peek = peekCapsuleGround(a, b, opts, lookup);
		expect(peek.z).toBe(10);
		expect(peek.missing).toEqual([]);
		expect(binMax(peek.bins, 5)).toBe(1500);
		// Nothing anywhere: the preferred level's missing list, to be warmed.
		const none = peekCapsuleGround(a, b, opts, () => undefined);
		expect(none.z).toBe(12);
		expect(none.missing.length).toBeGreaterThan(0);
	});
});
