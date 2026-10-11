/* The vertical profiles' airspace filter rows: which row a volume answers
 * to (data/airspaces.ts airspaceFilterGroup), and which answer to none and
 * so can never be hidden. The resolution ORDER is the contract, so most of
 * these cases are pairs that actually occur in the shipped datasets and
 * would bucket differently under a different order. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
	AIRSPACE_FILTER_GROUPS,
	PROFILE_BAND_FILTER_GROUPS,
	TRACE_BAND_FILTER_GROUPS,
	airspaceCategory,
	airspaceFilterGroup,
	airspaceGroupShown,
	type AirspaceFilterGroup,
} from '$lib/data/airspaces';

/** A row as the loader stamps it: the category is derived from the type,
 *  never hand-written, so these cases exercise the real pairing. */
function row(type: string, airClass = '') {
	return { type, airClass, category: airspaceCategory(type) };
}

const ALL_ON = Object.fromEntries(AIRSPACE_FILTER_GROUPS.map((g) => [g, true])) as Record<
	AirspaceFilterGroup,
	boolean
>;
const ALL_OFF = Object.fromEntries(AIRSPACE_FILTER_GROUPS.map((g) => [g, false])) as Record<
	AirspaceFilterGroup,
	boolean
>;

describe('airspaceFilterGroup', () => {
	it('gives a prohibited area NO row, so nothing can hide it', () => {
		// Garmin's own rule, both pilot's guides: "Airspace alerts for
		// Prohibited airspace cannot be disabled."
		expect(airspaceFilterGroup(row('P'))).toBeNull();
		expect(airspaceFilterGroup(row('P', 'A'))).toBeNull();
		expect(airspaceGroupShown(row('P'), ALL_OFF)).toBe(true);
	});

	it('gives every aerial-activity kind the activity row', () => {
		for (const t of ['ACTIVITY', 'GLIDER', 'PARACHUTE', 'PARAGLIDER', 'BALLOON', 'TOWING',
			'FBZ', 'MODEL', 'AEROBATIC', 'UAS']) {
			expect(airspaceFilterGroup(row(t)), t).toBe('activity');
		}
	});

	it('gives the structural background its OWN row, never a class row', () => {
		// A class-A FIR must not vanish from a column profile when Class A is
		// unticked: the frame would go with the picture. It answers to the
		// FIR row instead, which only the column profiles offer.
		for (const t of ['FIR', 'UIR', 'OCA', 'ARTCC', 'ACC']) {
			expect(airspaceFilterGroup(row(t, 'A'))).toBe('fir');
		}
		expect(airspaceFilterGroup(row('SIV'))).toBe('siv');
		expect(airspaceFilterGroup(row('FIC'))).toBe('siv');
	});

	it('buckets controlled airspace by its ICAO class', () => {
		expect(airspaceFilterGroup(row('TMA', 'A'))).toBe('classA');
		expect(airspaceFilterGroup(row('CTA', 'B'))).toBe('classB');
		expect(airspaceFilterGroup(row('TMA', 'C'))).toBe('classC');
		expect(airspaceFilterGroup(row('CTR', 'D'))).toBe('classD');
		expect(airspaceFilterGroup(row('LTA', 'E'))).toBe('classE');
		expect(airspaceFilterGroup(row('DLG-ATS', 'D'))).toBe('classD');
		// Free Route Airspace carries a class, so the FL195+ upper cells are
		// classed rows: the LEVEL BAND is what removes them, not a kind row.
		expect(airspaceFilterGroup(row('FRA', 'C'))).toBe('classC');
		expect(airspaceFilterGroup(row('UTA', 'C'))).toBe('classC');
	});

	it('lets a special-use TYPE outrank any class it carries', () => {
		// Type A is an Alert Area, NOT class A: order alone separates them.
		expect(airspaceFilterGroup(row('A'))).toBe('military');
		expect(airspaceFilterGroup(row('TMA', 'A'))).toBe('classA');
		// Belgium files warning areas with a class; two ADIZ rows carry
		// class A; five danger areas carry class G.
		expect(airspaceFilterGroup(row('W', 'C'))).toBe('military');
		expect(airspaceFilterGroup(row('W', 'E'))).toBe('military');
		expect(airspaceFilterGroup(row('ADIZ', 'A'))).toBe('other');
		expect(airspaceFilterGroup(row('D', 'G'))).toBe('restricted');
		expect(airspaceFilterGroup(row('TMZ', 'E'))).toBe('trafficmgmt');
		expect(airspaceFilterGroup(row('RMZ', 'D'))).toBe('trafficmgmt');
	});

	it('gives the radio-mandatory family its own row', () => {
		// SERA.6005(a): an RMZ wants a continuous watch and an initial call
		// BEFORE entering. It is the one airspace the regulation makes you
		// call, so one tick on a catch-all row must not be able to hide it.
		expect(airspaceFilterGroup(row('RMZ'))).toBe('trafficmgmt');
		expect(airspaceFilterGroup(row('TMZ'))).toBe('trafficmgmt');
		expect(airspaceFilterGroup(row('TMZ-RMZ'))).toBe('trafficmgmt');
	});

	it('files a temporary flight restriction with the restrictions', () => {
		// A TFR restricts entry; it is not an "other".
		expect(airspaceFilterGroup(row('TFR'))).toBe('restricted');
	});

	it('buckets the zone and military families by type', () => {
		expect(airspaceFilterGroup(row('R'))).toBe('restricted');
		expect(airspaceFilterGroup(row('D'))).toBe('restricted');
		expect(airspaceFilterGroup(row('CBA'))).toBe('restricted');
		expect(airspaceFilterGroup(row('MOA'))).toBe('military');
		expect(airspaceFilterGroup(row('TRA'))).toBe('military');
		expect(airspaceFilterGroup(row('TSA'))).toBe('military');
	});

	it('calls controlled airspace with no A-E class Other', () => {
		// The field is '', 'G' or the FAA rows' literal 'Other'; all three
		// mean the same thing here.
		expect(airspaceFilterGroup(row('DLG-ATS'))).toBe('other');
		expect(airspaceFilterGroup(row('ATZ'))).toBe('other');
		expect(airspaceFilterGroup(row('CTA', 'Other'))).toBe('other');
		expect(airspaceFilterGroup(row('SATA', 'G'))).toBe('other');
		expect(airspaceFilterGroup(row('TRSA'))).toBe('other');
		// An unknown future type categorises as controlled, so it lands here
		// rather than escaping every row.
		expect(airspaceFilterGroup(row('WHATSIT'))).toBe('other');
	});

	it('fails open for anything that names no row', () => {
		// A prohibited area, and nothing else.
		expect(airspaceGroupShown(row('P'), ALL_OFF)).toBe(true);
		expect(airspaceGroupShown(row('GLIDER'), ALL_OFF)).toBe(false);
		// Everything that DOES name a row is hideable through it, the FIR
		// included - that is what the fir row is for on a column profile.
		expect(airspaceGroupShown(row('FIR', 'A'), ALL_OFF)).toBe(false);
		expect(airspaceGroupShown(row('TMA', 'D'), ALL_OFF)).toBe(false);
		expect(airspaceGroupShown(row('TMA', 'D'), ALL_ON)).toBe(true);
	});

	it('AIRSPACE_FILTER_GROUPS lists every row exactly once', () => {
		expect(new Set(AIRSPACE_FILTER_GROUPS).size).toBe(AIRSPACE_FILTER_GROUPS.length);
		expect(AIRSPACE_FILTER_GROUPS).toEqual([
			'classA',
			'classB',
			'classC',
			'classD',
			'classE',
			'restricted',
			'military',
			'trafficmgmt',
			'other',
			'activity',
			'fir',
			'siv',
		]);
	});

	it('the CHART profiles offer every row but FIR', () => {
		// A FIR is one slab across a whole leg with no vertical structure a
		// VFR flight meets, so that row would be inert there: absent, never
		// disabled. A FIS sector is the opposite and keeps its row.
		expect(PROFILE_BAND_FILTER_GROUPS).toEqual(
			AIRSPACE_FILTER_GROUPS.filter((g) => g !== 'fir'),
		);
		expect(PROFILE_BAND_FILTER_GROUPS).not.toContain('fir');
		expect(PROFILE_BAND_FILTER_GROUPS).toContain('siv');
	});

	it('the TRACE profile offers no FIS row: it cannot draw one honestly', () => {
		// The sectors nest, so they need the in-force emphasis to say which
		// one a pilot calls, and the trace cannot compute it (its waypoints
		// carry alt 0, so the altitude-aware walk answers nothing).
		expect(TRACE_BAND_FILTER_GROUPS).not.toContain('siv');
		expect(TRACE_BAND_FILTER_GROUPS).toEqual(
			PROFILE_BAND_FILTER_GROUPS.filter((g) => g !== 'siv'),
		);
	});
});

/* Every (type, class) pair the SHIPPED datasets actually contain must land
 * somewhere deliberate. This is the sweep that caught the pairs a synthetic
 * fixture would never have: a Warning Area carrying a class, an ADIZ
 * carrying class A, a danger area carrying class G, and the FAA rows whose
 * class field is the literal string 'Other'. It reads the committed data,
 * so a dataset refresh that introduces a new pair fails here rather than
 * silently hiding a volume. */
describe('airspaceFilterGroup over the shipped datasets', () => {
	const pairs = new Map<string, number>();
	for (const f of fs.readdirSync('public/data')) {
		if (!f.endsWith('-airspaces.json') || f.includes('.next.')) {
			continue;
		}
		const d = JSON.parse(fs.readFileSync(`public/data/${f}`, 'utf8')) as {
			fields: string[];
			rows: unknown[][];
		};
		const ti = d.fields.indexOf('type');
		const ci = d.fields.indexOf('class');
		for (const r of d.rows) {
			const k = `${(r[ti] as string) ?? ''}|${(r[ci] as string) ?? ''}`;
			pairs.set(k, (pairs.get(k) ?? 0) + 1);
		}
	}

	it('reads a real corpus', () => {
		expect(pairs.size).toBeGreaterThan(40);
	});

	it('buckets every pair, and only ever into a declared row', () => {
		const groups = new Set<string>(AIRSPACE_FILTER_GROUPS);
		for (const k of pairs.keys()) {
			const [type, airClass] = k.split('|');
			const g = airspaceFilterGroup({ type, airClass, category: airspaceCategory(type) });
			if (g !== null) {
				expect(groups.has(g), `${k} -> ${g}`).toBe(true);
			}
		}
	});

	it('leaves only prohibited areas row-less', () => {
		for (const k of pairs.keys()) {
			const [type, airClass] = k.split('|');
			const category = airspaceCategory(type);
			if (airspaceFilterGroup({ type, airClass, category }) !== null) {
				continue;
			}
			expect(type, `${k} should name a row`).toBe('P');
		}
	});
});
