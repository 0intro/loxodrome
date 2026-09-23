import { describe, it, expect } from 'vitest';
import { legMidpoints, legSegments } from '$lib/route/legWind';
import type { Waypoint } from '$lib/state/route.svelte';

const wp = (id: string, lat: number, lon: number) => ({ id, lat, lon }) as Waypoint;

describe('legMidpoints and legSegments across the antimeridian', () => {
	const wps = [wp('a', 0, 179.5), wp('b', 0, -179.5)];

	it('midpoint sits on the dateline, not at 0 longitude', () => {
		const [mid] = legMidpoints(wps);
		expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(1e-9);
	});

	it('the center segment lands on the legMidpoints point', () => {
		const segs = legSegments(wps);
		const [mid] = legMidpoints(wps);
		const center = segs[Math.floor(segs.length / 2)];
		expect(center.lon).toBeCloseTo(mid.lon, 9);
		for (const s of segs) {
			expect(Math.abs(s.lon)).toBeGreaterThan(179.4);
		}
	});

	it('in-range legs keep the exact arithmetic mean', () => {
		const [mid] = legMidpoints([wp('a', 48.1, 2.5678), wp('b', 48.9, 3.4321)]);
		expect(mid.lon).toBe((2.5678 + 3.4321) / 2);
	});
});
