/* Pins the shared per-leg MSA memo (state/routeMsa.svelte.ts): computed once
 * per (coordinates, corridor width, flight rules) signature by the nav log's
 * recipe, never for an altitude edit, aborted by a coordinate change, and
 * shared by the sheet's MSA column and the band's "MSA leg" reading. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { pts: { lat: number; lon: number }[]; halfWidthNM: number; vfr: boolean; signal: AbortSignal }[] = [];
let hold: Promise<void> | null = null;

vi.mock('$lib/state/data.svelte', () => ({
	ensureObstacles: () => Promise.resolve([]),
}));
vi.mock('$lib/route/minAltitude', () => ({
	computeMinAltitudes: async (
		pts: { lat: number; lon: number }[],
		_obstacles: unknown[],
		opts: { signal: AbortSignal; halfWidthNM: number; vfr: boolean },
	): Promise<(number | null)[]> => {
		calls.push({ pts, halfWidthNM: opts.halfWidthNM, vfr: opts.vfr, signal: opts.signal });
		if (hold) {
			await hold;
		}
		if (opts.signal.aborted) {
			return [];
		}
		return pts.slice(1).map((p) => Math.round(p.lat * 100) + (opts.vfr ? 500 : 1000));
	},
}));

import { ensureRouteMsa, pruneRouteMsa, routeMsa, routeMsaLegs, routeMsaLoading } from '$lib/state/routeMsa.svelte';

const settle = async (): Promise<void> => {
	for (let i = 0; i < 4; i += 1) {
		await new Promise((r) => setTimeout(r, 0));
	}
};

const WPS = [
	{ lat: 48.8, lon: 2.6, alt: 1500 },
	{ lat: 48.5, lon: 2.7, alt: 2500 },
	{ lat: 48.4, lon: 2.1, alt: 2000 },
];
const VFR = { halfWidthNM: 5, vfr: true };

beforeEach(() => {
	calls.length = 0;
	hold = null;
	pruneRouteMsa(new Set());
});

describe('routeMsa', () => {
	it('computes once and serves the legs under the same signature', async () => {
		ensureRouteMsa('r1', WPS, VFR);
		expect(routeMsaLoading('r1')).toBe(true);
		expect(routeMsaLegs('r1', WPS, VFR)).toBeNull();
		await settle();
		expect(calls).toHaveLength(1);
		expect(routeMsaLegs('r1', WPS, VFR)).toEqual([4850 + 500, 4840 + 500]);
	});

	it('never recomputes for an altitude edit', async () => {
		ensureRouteMsa('r1', WPS, VFR);
		await settle();
		const edited = WPS.map((w) => ({ ...w, alt: w.alt + 1000 }));
		ensureRouteMsa('r1', edited, VFR);
		expect(calls).toHaveLength(1);
		expect(routeMsaLegs('r1', edited, VFR)).toEqual(routeMsaLegs('r1', WPS, VFR));
	});

	it('recomputes for a flight-rules or corridor change, the stale answer withheld meanwhile', async () => {
		ensureRouteMsa('r1', WPS, VFR);
		await settle();
		const ifr = { halfWidthNM: 5, vfr: false };
		ensureRouteMsa('r1', WPS, ifr);
		// The VFR answer is not served under the IFR signature while the
		// IFR run is still out.
		expect(routeMsaLegs('r1', WPS, ifr)).toBeNull();
		expect(routeMsaLegs('r1', WPS, VFR)).toBeNull();
		await settle();
		expect(calls).toHaveLength(2);
		expect(routeMsaLegs('r1', WPS, ifr)).toEqual([4850 + 1000, 4840 + 1000]);
		ensureRouteMsa('r1', WPS, { halfWidthNM: 10, vfr: false });
		await settle();
		expect(calls).toHaveLength(3);
	});

	it('aborts the run in flight when the coordinates change and keeps only the current answer', async () => {
		let release!: () => void;
		hold = new Promise((r) => (release = r));
		ensureRouteMsa('r1', WPS, VFR);
		const moved = [WPS[0], { lat: 48.6, lon: 2.9, alt: 2500 }, WPS[2]];
		ensureRouteMsa('r1', moved, VFR);
		// Both runs reach the computation (the obstacles resolve first); the
		// first was aborted by the second before it could commit.
		await settle();
		expect(calls).toHaveLength(2);
		expect(calls[0].signal.aborted).toBe(true);
		release();
		await settle();
		expect(routeMsaLegs('r1', WPS, VFR)).toBeNull();
		expect(routeMsaLegs('r1', moved, VFR)).toEqual([4860 + 500, 4840 + 500]);
	});

	it('keeps one entry per route and prunes the deleted ones', async () => {
		ensureRouteMsa('r1', WPS, VFR);
		ensureRouteMsa('r2', WPS, VFR);
		await settle();
		expect(Object.keys(routeMsa.byRoute).sort()).toEqual(['r1', 'r2']);
		pruneRouteMsa(new Set(['r2']));
		expect(Object.keys(routeMsa.byRoute)).toEqual(['r2']);
		expect(routeMsaLegs('r1', WPS, VFR)).toBeNull();
	});
});
