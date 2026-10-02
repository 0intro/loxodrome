/* Unit tests for the fleet search / grouping helpers
 * (src/lib/aircraft/fleetSearch.ts). */

import { describe, it, expect } from 'vitest';
import { groupFleet, matchesFleetQuery, normalizeFleetText } from '$lib/aircraft/fleetSearch';
import type { Aircraft } from '$lib/aircraft/schema';

function plane(
	registration: string,
	type: string,
	name?: string,
	operator?: string,
): Aircraft {
	return { identity: { registration, type, name, operator } };
}

const FLEET: Aircraft[] = [
	plane('F-GORQ', 'DR400/120', 'Dauphin 2+2', 'Aéroclub Bleu'),
	plane('F-GJQK', 'DR400/120', 'Dauphin 912iSc', 'Aéroclub Bleu'),
	plane('F-GIRV', 'PA28-181', 'Archer II', 'Les Ailes'),
	plane('F-GIEQ', 'PA28-161', 'Cadet'),
	plane('F-GIKP', 'DR400/100', 'Sport', '  '), // blank operator = none
];

function regs(g: { planes: Aircraft[] }): (string | undefined)[] {
	return g.planes.map((p) => p.identity.registration);
}

describe('normalizeFleetText', () => {
	it('folds case and accents', () => {
		expect(normalizeFleetText('Aéroclub')).toBe('aeroclub');
		expect(normalizeFleetText('LES AILES')).toBe('les ailes');
	});
});

describe('matchesFleetQuery', () => {
	it('empty query matches everything', () => {
		expect(matchesFleetQuery(FLEET[0], '')).toBe(true);
		expect(matchesFleetQuery(FLEET[0], '   ')).toBe(true);
	});

	it('every token must match one of the fields (AND across tokens)', () => {
		expect(matchesFleetQuery(FLEET[0], 'dr400 bleu')).toBe(true);
		expect(matchesFleetQuery(FLEET[0], 'dr400 ailes')).toBe(false);
		expect(matchesFleetQuery(FLEET[2], 'pa28 archer')).toBe(true);
	});

	it('matches registration, type, name and operator, accent-insensitively', () => {
		expect(matchesFleetQuery(FLEET[1], 'f-gjqk')).toBe(true);
		expect(matchesFleetQuery(FLEET[1], '912isc')).toBe(true);
		expect(matchesFleetQuery(FLEET[1], 'aeroclub')).toBe(true);
		expect(matchesFleetQuery(FLEET[1], 'AÉROCLUB')).toBe(true);
	});
});

describe('groupFleet', () => {
	it('groups by operator, named groups sorted, the operator-less last', () => {
		const groups = groupFleet(FLEET, '');
		expect(groups.map((g) => g.operator)).toEqual(['Aéroclub Bleu', 'Les Ailes', null]);
		expect(regs(groups[0])).toEqual(['F-GJQK', 'F-GORQ']); // same type, sorted by key
		expect(regs(groups[1])).toEqual(['F-GIRV']);
		// Blank operator lands here; the DR400 sorts before the PA28 (type first).
		expect(regs(groups[2])).toEqual(['F-GIKP', 'F-GIEQ']);
	});

	it('orders planes by type, then registration', () => {
		const groups = groupFleet(
			[plane('F-AAAA', 'PA28-181'), plane('F-ZZZZ', 'DR400/120'), plane('F-BBBB', 'DR400/120')],
			'',
		);
		expect(regs(groups[0])).toEqual(['F-BBBB', 'F-ZZZZ', 'F-AAAA']);
	});

	it('an empty query keeps the whole fleet', () => {
		const total = groupFleet(FLEET, '').reduce((n, g) => n + g.planes.length, 0);
		expect(total).toBe(FLEET.length);
	});

	it('searching filters planes and drops emptied groups', () => {
		const groups = groupFleet(FLEET, 'pa28');
		expect(groups.map((g) => g.operator)).toEqual(['Les Ailes', null]);
		expect(regs(groups[1])).toEqual(['F-GIEQ']);
	});

	it('a no-match query yields no groups', () => {
		expect(groupFleet(FLEET, 'zzz')).toEqual([]);
	});
});
