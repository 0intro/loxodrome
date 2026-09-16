/* Unit tests for airspacesOver: the pure point-in-stack lookup that feeds the
 * altitude profile on the airport / airspace detail panels. */

import { describe, it, expect } from 'vitest';
import { airspacesOver, type Airspace, type VerticalLimit } from '$lib/data/airspaces';
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

function mk(
	key: string,
	ring: [number, number][],
	area: number,
	lower: VerticalLimit | null = null,
	upper: VerticalLimit | null = null,
): Airspace {
	return {
		id: key,
		key,
		type: 'TMA',
		name: key,
		airClass: '',
		upper,
		lower,
		vUpper: fromTriple(upper),
		vLower: fromTriple(lower),
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
		area,
		bbox: bboxOf(ring),
	} as unknown as Airspace;
}

// lat/lon squares; rings are [lat, lon] pairs, matching pointInRing.
const big: [number, number][] = [[0, 0], [0, 10], [10, 10], [10, 0]];
const small: [number, number][] = [[0, 0], [0, 4], [4, 4], [4, 0]];
const far: [number, number][] = [[50, 50], [50, 60], [60, 60], [60, 50]];

describe('airspacesOver', () => {
	it('returns every airspace whose ring contains the point', () => {
		const list = [mk('big', big, 100), mk('small', small, 16), mk('far', far, 100)];
		const keys = airspacesOver(list, 2, 2).map((a) => a.key);
		expect(keys).toContain('big');
		expect(keys).toContain('small');
		expect(keys).not.toContain('far');
	});

	it('rejects a point inside the bbox but outside the ring', () => {
		// Lower-left triangle; (9, 9) sits in the [0,10] bbox but past the
		// hypotenuse, while (1, 1) is genuinely inside.
		const tri: [number, number][] = [[0, 0], [10, 0], [0, 10]];
		const list = [mk('tri', tri, 50)];
		expect(airspacesOver(list, 9, 9)).toHaveLength(0);
		expect(airspacesOver(list, 1, 1).map((a) => a.key)).toEqual(['tri']);
	});

	it('skips airspaces whose bbox does not contain the point', () => {
		expect(airspacesOver([mk('far', far, 100)], 0, 0)).toHaveLength(0);
	});

	it('orders results highest-band first (compareAirspaceByBand)', () => {
		const high = mk('high', big, 100, ['', '100', 'FL'], ['', '200', 'FL']);
		const low = mk('low', big, 100, ['', '0', ''], ['', '50', '']);
		expect(airspacesOver([low, high], 2, 2).map((a) => a.key)).toEqual(['high', 'low']);
	});
});
