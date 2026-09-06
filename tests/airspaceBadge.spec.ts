/* Unit tests for the airspace chip helpers: airspaceBadge (the vertical
 * profile's class / zone chip, whose outputs are pinned bit-compatible) and
 * airspaceScheduleBadge (the nav-log schedule's TOTAL sibling: one chip for
 * every schedule-relevant category, null only for the FIR family). */

import { describe, it, expect } from 'vitest';
import {
	airspaceBadge,
	airspaceScheduleBadge,
	airspaceCategory,
	AIRSPACE_TYPE_LABELS,
} from '$lib/data/airspaces';
import type { AirspaceCategory } from '$lib/state/layers.svelte';

function row(type: string, airClass = '') {
	return { type, airClass, category: airspaceCategory(type) };
}

describe('airspaceBadge (profile chip, unchanged)', () => {
	it('keeps the R / D / P zone chip bit-compatible', () => {
		expect(airspaceBadge(row('R'))).toEqual({ text: 'R', kind: 'zone' });
		expect(airspaceBadge(row('D'))).toEqual({ text: 'D', kind: 'zone' });
		expect(airspaceBadge(row('P'))).toEqual({ text: 'P', kind: 'zone' });
	});

	it('keeps the ICAO class chip bit-compatible', () => {
		expect(airspaceBadge(row('TMA', 'D'))).toEqual({ text: 'D', kind: 'class' });
		expect(airspaceBadge(row('CTR', 'A'))).toEqual({ text: 'A', kind: 'class' });
	});

	it('stays null for classless non-zone types (no new profile chips)', () => {
		expect(airspaceBadge(row('TMA'))).toBeNull();
		expect(airspaceBadge(row('MOA'))).toBeNull();
		expect(airspaceBadge(row('TMZ'))).toBeNull();
		expect(airspaceBadge(row('SIV'))).toBeNull();
	});
});

describe('airspaceScheduleBadge', () => {
	it('chips a classed controlled airspace with its ICAO class letter', () => {
		expect(airspaceScheduleBadge(row('TMA', 'D'))).toEqual({
			text: 'D',
			kind: 'class',
			category: 'controlled',
		});
		expect(airspaceScheduleBadge(row('CLASS', 'B'))).toEqual({
			text: 'B',
			kind: 'class',
			category: 'controlled',
		});
	});

	it('chips a classless controlled airspace with its type code (never chipless)', () => {
		expect(airspaceScheduleBadge(row('TMA'))).toEqual({
			text: 'TMA',
			kind: 'category',
			category: 'controlled',
		});
		expect(airspaceScheduleBadge(row('DLG-ATS'))).toEqual({
			text: 'DLG-ATS',
			kind: 'category',
			category: 'controlled',
		});
	});

	it('keeps the R / D / P zone chip, matching airspaceBadge exactly', () => {
		for (const type of ['R', 'D', 'P']) {
			const chip = airspaceScheduleBadge(row(type));
			expect(chip).toEqual({ text: type, kind: 'zone', category: 'restricted' });
			const profile = airspaceBadge(row(type));
			expect(chip).toMatchObject(profile!);
		}
	});

	it('chips the other restricted types with their designator / type code', () => {
		for (const type of ['W', 'A', 'MOA', 'ADIZ', 'TFR']) {
			expect(airspaceScheduleBadge(row(type))).toEqual({
				text: type,
				kind: 'category',
				category: 'restricted',
			});
		}
	});

	it('chips CBA as a red zone-style chip (Legende2026: the R / D family)', () => {
		expect(airspaceScheduleBadge(row('CBA'))).toEqual({
			text: 'CBA',
			kind: 'zone',
			category: 'restricted',
		});
	});

	it('a restricted zone never takes a class chip, even with a class', () => {
		expect(airspaceScheduleBadge(row('R', 'A'))).toEqual({
			text: 'R',
			kind: 'zone',
			category: 'restricted',
		});
		expect(airspaceScheduleBadge(row('MOA', 'E'))).toEqual({
			text: 'MOA',
			kind: 'category',
			category: 'restricted',
		});
	});

	it('chips transit and trafficmgmt types with their type code', () => {
		for (const type of ['TRA', 'TSA']) {
			expect(airspaceScheduleBadge(row(type))).toEqual({
				text: type,
				kind: 'category',
				category: 'transit',
			});
		}
		for (const type of ['TMZ', 'RMZ', 'TMZ-RMZ']) {
			expect(airspaceScheduleBadge(row(type))).toEqual({
				text: type,
				kind: 'category',
				category: 'trafficmgmt',
			});
		}
	});

	it('chips SIV and activity zones as the empty filled square', () => {
		expect(airspaceScheduleBadge(row('SIV'))).toEqual({
			text: '',
			kind: 'category',
			category: 'siv',
		});
		for (const type of ['PARACHUTE', 'GLIDER', 'BALLOON', 'PARAGLIDER', 'TOWING', 'ACTIVITY', 'FBZ']) {
			expect(airspaceScheduleBadge(row(type))).toEqual({
				text: '',
				kind: 'category',
				category: 'activity',
			});
		}
	});

	it('returns null for the FIR family (excluded from the schedule)', () => {
		for (const type of ['FIR', 'UIR', 'OCA', 'ARTCC', 'ACC']) {
			expect(airspaceScheduleBadge(row(type))).toBeNull();
		}
	});

	it('is total: every schedule-relevant type yields a chip (classed or not)', () => {
		const cats = new Set<AirspaceCategory>();
		for (const type of Object.keys(AIRSPACE_TYPE_LABELS)) {
			const category = airspaceCategory(type);
			cats.add(category);
			for (const airClass of ['', 'D']) {
				const chip = airspaceScheduleBadge({ type, airClass, category });
				if (category === 'fir') {
					expect(chip, type).toBeNull();
				} else {
					expect(chip, type).not.toBeNull();
					expect(chip!.category).toBe(category);
				}
			}
		}
		// The sweep exercised every category (guards against a new category
		// silently falling through chipless).
		expect([...cats].sort()).toEqual(
			['activity', 'controlled', 'fir', 'restricted', 'siv', 'trafficmgmt', 'transit'].sort(),
		);
	});
});
