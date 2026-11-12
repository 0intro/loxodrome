/* Unit tests for classAFloorAt / classACeilingLabel: the per-point VFR ceiling
 * (lowest Class A floor whose ring laterally contains the point) and its label,
 * which keeps a flight-level floor as "FL 065" rather than collapsing to feet. */

import { describe, it, expect } from 'vitest';
import { classAFloorAt, classACeilingLabel } from '$lib/route/airspaces';
import type { Airspace, VerticalLimit } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';

function bboxOf(ring: [number, number][]): Airspace['bbox'] {
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
	return { minLat, minLon, maxLat, maxLon };
}

const alt = (ft: number): VerticalLimit => ['ALT', String(ft), 'FT'];
const fl = (level: string): VerticalLimit => ['STD', level, 'FL'];

function mk(ring: [number, number][], airClass: string, lower: VerticalLimit): Airspace {
	return {
		id: 'a',
		key: 'a',
		type: 'TMA',
		name: 'a',
		airClass,
		upper: null,
		lower,
		vUpper: null,
		vLower: fromTriple(lower, { legacyFl999Unl: true }),
		vMax: null,
		vMnm: null,
		workHr: '',
		rmkWorkHr: '',
		rmk: '',
		radio: [],
		ring,
		subtype: '',
		category: 'controlled',
		source: 'fr',
		area: 1,
		bbox: bboxOf(ring),
	} as unknown as Airspace;
}

const sq = (s: number): [number, number][] => [
	[0, 0],
	[0, s],
	[s, s],
	[s, 0],
];

function label(lat: number, lon: number, list: Airspace[]): string | null {
	const lower = classAFloorAt(lat, lon, list);
	return lower ? classACeilingLabel(lower) : null;
}

describe('classAFloorAt / classACeilingLabel', () => {
	it('labels an altitude floor as "Classe A 1500"', () => {
		expect(label(5, 5, [mk(sq(10), 'A', alt(1500))])).toBe('Classe A 1500');
	});

	it('keeps a flight-level floor as "Classe A FL 065"', () => {
		expect(label(5, 5, [mk(sq(10), 'A', fl('065'))])).toBe('Classe A FL 065');
	});

	it('returns null for a point outside the ring', () => {
		expect(classAFloorAt(50, 50, [mk(sq(10), 'A', alt(1500))])).toBeNull();
	});

	it('picks the lowest of overlapping Class A by feet (FL065 = 6500 > 1500)', () => {
		const list = [mk(sq(10), 'A', fl('065')), mk(sq(10), 'A', alt(1500))];
		expect(label(5, 5, list)).toBe('Classe A 1500');
	});

	it('ignores non-Class-A airspace over the point', () => {
		expect(classAFloorAt(5, 5, [mk(sq(10), 'D', alt(1500))])).toBeNull();
	});

	it('ignores surface-based Class A (floor <= 0)', () => {
		expect(classAFloorAt(5, 5, [mk(sq(10), 'A', alt(0))])).toBeNull();
	});
});
