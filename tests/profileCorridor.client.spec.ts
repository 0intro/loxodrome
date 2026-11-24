/* The route profile's corridor ground belongs to its geometry
 * (components/profileCorridor.svelte.ts). The MSA line folds the ground by
 * leg index and the chart draws it as the corridor's envelope, so while the
 * pass for another route or a moved waypoint runs, the old ground must
 * answer nothing: folded onto the new legs it would draw the old geometry's
 * MSA, and a leg past its end an MSA of the obstacles alone. The same
 * coordinates handed back as new objects (an undo) keep their ground. The
 * effects really run (tests/env/webnode.ts), and each pass is a deferred
 * promise per geometry. */

import { flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CorridorGround } from '$lib/route/minAltitude';

const passes = vi.hoisted(() => new Map<string, (g: CorridorGround) => void>());
vi.mock('$lib/route/minAltitude', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/route/minAltitude')>()),
	computeCorridorGround: (
		pts: { lat: number; lon: number }[],
		opts: { halfWidthNM?: number },
	): Promise<CorridorGround> =>
		new Promise((resolve) => passes.set(`${pts.map((p) => `${p.lat},${p.lon}`).join(' ')}|${opts.halfWidthNM}`, resolve)),
}));

import { mountCorridor } from './helpers/profileCorridorHost.svelte';

function ground(legMaxFt: number[]): CorridorGround {
	return { cells: [], stations: [], legMaxFt, legMinFt: legMaxFt.map(() => 0), legZ: legMaxFt.map(() => 10) };
}

/** Answer the pass for a geometry, then let its settle land. */
async function land(key: string, g: CorridorGround): Promise<void> {
	const resolve = passes.get(key);
	expect(resolve, `a pass for ${key}`).toBeDefined();
	resolve?.(g);
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
	}
	flushSync();
}

const A = [
	{ lat: 48.75, lon: 2.1 },
	{ lat: 48.6, lon: 2.6 },
];
const B = [A[0], { lat: 48.7, lon: 2.35 }, A[1]];

afterEach(() => {
	passes.clear();
});

describe('the route profile’s corridor ground', () => {
	it('answers nothing for a new geometry until its own pass lands', async () => {
		const h = mountCorridor({ pts: A, halfWidthNM: 5 });
		flushSync();
		expect(h.settled()).toBe(false);
		await land('48.75,2.1 48.6,2.6|5', ground([1200]));
		expect(h.ground()?.legMaxFt).toEqual([1200]);
		expect(h.settled()).toBe(true);
		// A waypoint inserted: the old leg's ground is no answer for either new leg.
		h.s.ask = { pts: B, halfWidthNM: 5 };
		flushSync();
		expect(h.ground()).toBeNull();
		expect(h.settled()).toBe(false);
		await land('48.75,2.1 48.7,2.35 48.6,2.6|5', ground([900, 1500]));
		expect(h.ground()?.legMaxFt).toEqual([900, 1500]);
		// A wider corridor is another pass too.
		h.s.ask = { pts: B, halfWidthNM: 10 };
		flushSync();
		expect(h.ground()).toBeNull();
		h.stop();
	});

	it('keeps its ground when the same coordinates come back', async () => {
		const h = mountCorridor({ pts: A, halfWidthNM: 5 });
		flushSync();
		await land('48.75,2.1 48.6,2.6|5', ground([1200]));
		// An undo hands back new waypoint objects at the same places.
		h.s.ask = { pts: A.map((p) => ({ ...p })), halfWidthNM: 5 };
		flushSync();
		expect(h.ground()?.legMaxFt).toEqual([1200]);
		h.stop();
	});

	it('is the pass RouteProfileModal folds and draws', () => {
		const src = readFileSync('src/lib/components/RouteProfileModal.svelte', 'utf8');
		expect(src).toContain('useCorridorGround(');
		expect(src).not.toContain('computeCorridorGround(');
	});
});
