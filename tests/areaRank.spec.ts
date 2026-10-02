/* map/areaRank.ts: which of several overlapping AREAS a click selects.
 *
 * The rule half of docs/map-hit-testing.md's tier 2, extracted from the gather
 * so that a second map can reuse it without restating it. The gather is pinned
 * through featureAt in interactions.spec.ts; this file pins the rule alone,
 * which is the part that must not be allowed to differ between two maps.
 */

import { describe, expect, it } from 'vitest';
import { AREA_PANE_Z, AREA_TIE, bestArea, rankArea } from '$lib/map/areaRank';

type Hit = string;
const c = (hit: Hit, areaM2: number, z: number) => ({ hit, areaM2, z });

describe('rankArea', () => {
	it('ranks a measureless shape as the largest', () => {
		// Drawn ink must never become unclickable: it loses to anything
		// measured and still wins when it is the only thing under the point.
		expect(rankArea(NaN)).toBe(Infinity);
		expect(rankArea(Infinity)).toBe(Infinity);
		expect(rankArea(0)).toBe(0);
		expect(rankArea(1234)).toBe(1234);
	});
});

describe('bestArea', () => {
	it('answers null on nothing', () => {
		expect(bestArea([])).toBeNull();
	});

	it('takes the smallest, whatever kind drew it and whatever order', () => {
		const big = c('fir', 1e10, AREA_PANE_Z.airspace);
		const small = c('zrt', 1e6, AREA_PANE_Z.airspace);
		expect(bestArea([big, small])).toBe('zrt');
		expect(bestArea([small, big])).toBe('zrt');
	});

	it('prefers the smaller even when the larger draws on top', () => {
		// The NOTAM pane is the highest of the four, and a NOTAM area that
		// contains an airspace still loses to it. The pane is a TIE-break,
		// never a priority: that distinction is why a NOTAM area stopped
		// swallowing the SUP AIP zone it activates.
		const notam = c('notam', 1e10, AREA_PANE_Z.notam);
		const airspace = c('airspace', 1e6, AREA_PANE_Z.airspace);
		expect(bestArea([notam, airspace])).toBe('airspace');
	});

	it('breaks an exact tie by pane, highest first', () => {
		const a = c('airspace', 5e6, AREA_PANE_Z.airspace);
		const n = c('notam', 5e6, AREA_PANE_Z.notam);
		expect(bestArea([a, n])).toBe('notam');
		expect(bestArea([n, a])).toBe('notam');
	});

	it('treats a near-tie as a tie, which is what a republished ring is', () => {
		// A French ZRT activation routinely republishes the exact ring of the
		// zone it activates, and two code paths measuring one ring differ in
		// the last bits. Inside the tolerance the pane decides; outside it the
		// size does.
		const base = 5e6;
		const inside = c('airspace', base * (1 - AREA_TIE / 2), AREA_PANE_Z.airspace);
		const notam = c('notam', base, AREA_PANE_Z.notam);
		expect(bestArea([notam, inside])).toBe('notam');

		const outside = c('airspace', base * (1 - AREA_TIE * 10), AREA_PANE_Z.airspace);
		expect(bestArea([notam, outside])).toBe('airspace');
	});

	it('keeps a measureless candidate when it is the only one', () => {
		expect(bestArea([c('unmeasured', rankArea(NaN), AREA_PANE_Z.supaip)])).toBe('unmeasured');
		// ... and drops it the moment anything measured is under the point.
		expect(
			bestArea([
				c('unmeasured', rankArea(NaN), AREA_PANE_Z.notam),
				c('measured', 9e12, AREA_PANE_Z.airspace),
			]),
		).toBe('measured');
	});
});
