/* The vertical profiles' airspace gate (route/airspaceFilter.ts): which of
 * the bands the walk produced the chart actually draws, once the pilot's
 * filter rows and the toolbar's level band are applied and every forbidden
 * crossing is rescued back in. */

import { describe, it, expect } from 'vitest';
import {
	AIRSPACE_FILTER_GROUPS,
	airspaceCategory,
	type AirspaceFilterGroup,
} from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import type { VerticalLimit } from '$lib/data/airspaces';
import { NO_ENTRY } from '$lib/data/airspaceEntry';
import type { AltitudeVertex, PlacedBand } from '$lib/route/routeProfile';
import {
	gatedAirspaceBandKeys,
	rescuedBandKeys,
	type AirspaceBandRow,
} from '$lib/route/airspaceFilter';

const ALL_ON = Object.fromEntries(AIRSPACE_FILTER_GROUPS.map((g) => [g, true])) as Record<
	AirspaceFilterGroup,
	boolean
>;
const ALL_OFF = Object.fromEntries(AIRSPACE_FILTER_GROUPS.map((g) => [g, false])) as Record<
	AirspaceFilterGroup,
	boolean
>;
const off = (...gs: AirspaceFilterGroup[]): Record<AirspaceFilterGroup, boolean> => {
	const o = { ...ALL_ON };
	for (const g of gs) {
		o[g] = false;
	}
	return o;
};

function band(
	key: string,
	type: string,
	airClass = '',
	lower: VerticalLimit | null = null,
	upper: VerticalLimit | null = null,
): AirspaceBandRow {
	return {
		key,
		type,
		airClass,
		category: airspaceCategory(type),
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
	};
}

const ft = (n: number): VerticalLimit => ['ALT', String(n), 'FT'] as unknown as VerticalLimit;

describe('gatedAirspaceBandKeys', () => {
	const tma = band('TMA|D', 'TMA', 'D', ft(1500), ft(3500));
	const zone = band('R|1', 'R', '', ft(0), ft(2500));
	const upper = band('FRA|C', 'FRA', 'C', ft(30500), ft(66000));

	it('answers null ONLY when every row is on and no level band is set', () => {
		// Null is the identity gate: the caller keeps its arrays untouched
		// and never reaches the penetration walk. It must therefore turn on
		// the CONTROLS, not on what the bands happen to be.
		expect(gatedAirspaceBandKeys([tma, zone], { groups: ALL_ON, band: null })).toBeNull();
		expect(gatedAirspaceBandKeys([tma, zone], { groups: off('classD'), band: null })).not.toBeNull();
		expect(
			gatedAirspaceBandKeys([tma, zone], { groups: ALL_ON, band: { floor: 0, ceiling: 60000 } }),
		).not.toBeNull();
	});

	it('drops the rows the pilot turned off, and only those', () => {
		const keys = gatedAirspaceBandKeys([tma, zone, upper], {
			groups: off('classD'),
			band: null,
		});
		expect(keys).not.toBeNull();
		expect(keys?.shown.has('TMA|D')).toBe(false);
		expect(keys?.shown.has('R|1')).toBe(true);
		expect(keys?.shown.has('FRA|C')).toBe(true);
	});

	it('drops a band the level band cannot reach, and keeps a straddling one', () => {
		const keys = gatedAirspaceBandKeys([tma, upper], {
			groups: ALL_ON,
			band: { floor: 0, ceiling: 10000 },
		});
		// The FL305-FL660 upper cell is the whole point of the level band.
		expect(keys?.shown.has('FRA|C')).toBe(false);
		expect(keys?.shown.has('TMA|D')).toBe(true);
		// A volume that starts inside the band and runs past its top stays:
		// it is an overlap test, not containment.
		const tall = band('TMA|1', 'TMA', 'E', ft(3500), ft(19500));
		expect(
			gatedAirspaceBandKeys([tall], { groups: ALL_ON, band: { floor: 0, ceiling: 10000 } })?.shown.has(
				'TMA|1',
			),
		).toBe(true);
	});

	it('FAILS OPEN on a vertical side the publisher did not state', () => {
		// docs/vertical-limits.md: a MISSING side reads as unbounded, so a
		// band stated on neither side can never be dropped and one stated on
		// a single side is tested on that side alone. The bands you most
		// need are the ones nobody fully stated.
		const unknown = band('D|UK', 'D');
		const noFloor = band('D|NOFLOOR', 'D', '', null, ft(30000));
		const noTop = band('D|NOTOP', 'D', '', ft(500), null);
		const keys = gatedAirspaceBandKeys([unknown, noFloor, noTop], {
			groups: ALL_ON,
			band: { floor: 0, ceiling: 1000 },
		});
		expect(keys?.shown.has('D|UK')).toBe(true);
		expect(keys?.shown.has('D|NOFLOOR')).toBe(true);
		expect(keys?.shown.has('D|NOTOP')).toBe(true);
		// The side that IS stated still bites: an open-topped zone based at
		// FL200 is not "unknown", it is high.
		const high = band('D|HIGH', 'D', '', ft(20000), null);
		expect(
			gatedAirspaceBandKeys([high], { groups: ALL_ON, band: { floor: 0, ceiling: 1000 } })?.shown.has(
				'D|HIGH',
			),
		).toBe(false);
	});

	it('never lets the ROWS hide a prohibited area', () => {
		// Garmin's rule: "Airspace alerts for Prohibited airspace cannot be
		// disabled". It is about the rows, which are this feature's own new
		// control. The LEVEL BAND may still hide a P that lies outside the
		// levels the pilot asked to see, exactly as it does on the map and
		// on the column profiles today; and a P the flight would actually
		// enter is at the flight's level, so the band cannot reach it, and
		// the rescue below covers it if it somehow could.
		const p = band('P|1', 'P', '', ft(1500), ft(2500));
		const keys = gatedAirspaceBandKeys([p], {
			groups: ALL_OFF,
			band: null,
		});
		expect(keys?.shown.has('P|1')).toBe(true);
		const high = band('P|HIGH', 'P', '', ft(30000), ft(40000));
		expect(
			gatedAirspaceBandKeys([high], { groups: ALL_ON, band: { floor: 0, ceiling: 3000 } })?.shown.has(
				'P|HIGH',
			),
		).toBe(false);
	});

	it('reports what it dropped, which is all the rescue can ever concern', () => {
		const keys = gatedAirspaceBandKeys([tma, zone, upper], {
			groups: off('classD'),
			band: { floor: 0, ceiling: 10000 },
		});
		expect([...(keys?.shown ?? [])].sort()).toEqual(['R|1']);
		expect([...(keys?.hidden ?? [])].sort()).toEqual(['FRA|C', 'TMA|D']);
	});
});

/** A drawn band the line can be tested against: one span over the whole
 *  leg between a floor and a ceiling. */
function placed_(
	key: string,
	type: string,
	airClass: string,
	botFt: number,
	topFt: number,
): PlacedBand {
	const edge = (ft: number): AltitudeVertex[] => [
		{ distNM: 0, altFt: ft },
		{ distNM: 10, altFt: ft },
	];
	return {
		key,
		type,
		airClass,
		entry: NO_ENTRY,
		rtba: false,
		prohibited: false,
		spans: [{ enterNM: 0, leaveNM: 10, lowerPts: edge(botFt), upperPts: edge(topFt), botFt, topFt }],
	} as unknown as PlacedBand;
}

describe('rescuedBandKeys', () => {
	const path: AltitudeVertex[] = [
		{ distNM: 0, altFt: 2000 },
		{ distNM: 10, altFt: 2000 },
	];
	const NONE: ReadonlySet<string> = new Set();

	it('carries a penetrated prohibited area back over both gates', () => {
		const p = placed_('P|1', 'P', '', 1500, 2500);
		expect([...rescuedBandKeys([p], path, { vfr: true, activeKeys: NONE })]).toEqual(['P|1']);
	});

	it('carries a class A crossing back under VFR, and not under IFR', () => {
		const a = placed_('TMA|A', 'TMA', 'A', 1500, 2500);
		expect([...rescuedBandKeys([a], path, { vfr: true, activeKeys: NONE })]).toEqual(['TMA|A']);
		expect([...rescuedBandKeys([a], path, { vfr: false, activeKeys: NONE })]).toEqual([]);
	});

	it('leaves a band the line passes under or over hidden', () => {
		// Forbidden in kind, but not crossed: a filter may drop it.
		const over = placed_('P|HIGH', 'P', '', 30000, 40000);
		const under = placed_('P|LOW', 'P', '', 0, 500);
		expect([...rescuedBandKeys([over, under], path, { vfr: true, activeKeys: NONE })]).toEqual([]);
	});

	it('leaves an ordinary crossing hidden: the tier is the contract', () => {
		// Class D is crossed here, and is exactly what "uncheck Class D"
		// means. Only the NO-GO tier overrides the pilot.
		const d = placed_('TMA|D', 'TMA', 'D', 1500, 2500);
		expect([...rescuedBandKeys([d], path, { vfr: true, activeKeys: NONE })]).toEqual([]);
	});

	it('answers nothing without a drawn line', () => {
		const p = placed_('P|1', 'P', '', 1500, 2500);
		expect([...rescuedBandKeys([p], [{ distNM: 0, altFt: 2000 }], { vfr: true, activeKeys: NONE })]).toEqual([]);
		expect([...rescuedBandKeys([p], [], { vfr: true, activeKeys: NONE })]).toEqual([]);
	});
});

/* The composition components/profileOverlays.svelte.ts performs, pinned
 * here because it is where the safety rule actually lives: the two halves
 * are each correct on their own, and dropping the second one silently
 * turns "a NO-GO is never hidden" back into "the pilot can hide anything".
 * The overlay passes the CORRIDOR rows to the gate and only the HIDDEN
 * placed bands to the rescue; this mirrors that exactly. */
function overlayGate(
	rows: AirspaceBandRow[],
	placed: PlacedBand[],
	path: AltitudeVertex[],
	groups: Record<AirspaceFilterGroup, boolean>,
	levelBand: { floor: number; ceiling: number } | null,
): Set<string> | null {
	const gate = gatedAirspaceBandKeys(rows, { groups, band: levelBand });
	if (!gate || gate.hidden.size === 0) {
		return null;
	}
	const hidden = placed.filter((b) => gate.hidden.has(b.key));
	for (const k of rescuedBandKeys(hidden, path, { vfr: true, activeKeys: new Set() })) {
		gate.shown.add(k);
	}
	return gate.shown;
}

describe('the gate as the profiles compose it', () => {
	const path: AltitudeVertex[] = [
		{ distNM: 0, altFt: 2000 },
		{ distNM: 10, altFt: 2000 },
	];
	// One plan through a class A TMA (VFR-forbidden, flown), an ordinary
	// class D CTR (flown), a prohibited area well above, and an upper cell.
	const rows = [
		band('TMA|A', 'TMA', 'A', ft(1500), ft(2500)),
		band('CTR|D', 'CTR', 'D', ft(0), ft(2500)),
		band('P|HIGH', 'P', '', ft(30000), ft(40000)),
		band('FRA|C', 'FRA', 'C', ft(30500), ft(66000)),
	];
	const placed = [
		placed_('TMA|A', 'TMA', 'A', 1500, 2500),
		placed_('CTR|D', 'CTR', 'D', 0, 2500),
		placed_('P|HIGH', 'P', '', 30000, 40000),
		placed_('FRA|C', 'FRA', 'C', 30500, 66000),
	];

	it('every row on, no level band: the identity gate', () => {
		expect(overlayGate(rows, placed, path, ALL_ON, null)).toBeNull();
	});

	it('nothing hidden on THIS route is also the identity gate', () => {
		// The rows are set but drop none of these four: the caller must keep
		// its own arrays rather than rebuild them from a set that says "all".
		expect(overlayGate(rows, placed, path, off('classB'), null)).toBeNull();
	});

	it('keeps the class A crossing when its own row is off', () => {
		const keys = overlayGate(rows, placed, path, off('classA'), null);
		expect(keys?.has('TMA|A')).toBe(true);
	});

	it('drops the ordinary crossing when its row is off', () => {
		const keys = overlayGate(rows, placed, path, off('classD'), null);
		expect(keys?.has('CTR|D')).toBe(false);
		expect(keys?.has('TMA|A')).toBe(true);
	});

	it('the level band takes the upper cell AND the P it cannot reach', () => {
		const keys = overlayGate(rows, placed, path, ALL_ON, { floor: 0, ceiling: 10000 });
		expect(keys?.has('FRA|C')).toBe(false);
		// A prohibited area 28 000 ft above the flight is not a NO-GO this
		// flight can bust, so the level band may hide it like any other.
		expect(keys?.has('P|HIGH')).toBe(false);
		expect([...(keys ?? [])].sort()).toEqual(['CTR|D', 'TMA|A']);
	});

	it('keeps a prohibited area the flight WOULD enter, past every gate', () => {
		const rows2 = [...rows, band('P|1', 'P', '', ft(1500), ft(2500))];
		const placed2 = [...placed, placed_('P|1', 'P', '', 1500, 2500)];
		const keys = overlayGate(rows2, placed2, path, ALL_OFF, { floor: 40000, ceiling: 50000 });
		expect(keys?.has('P|1')).toBe(true);
		expect(keys?.has('TMA|A')).toBe(true);
		expect(keys?.has('CTR|D')).toBe(false);
	});
});
