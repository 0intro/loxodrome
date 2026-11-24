/* The alerts' caveat names its cause where the evaluator finds it: a zone
 * activated by NOTAM reads cold only where the briefing covers the pose
 * AND the lookahead's end (state/airspaceAlert.svelte.ts briefedAlong).
 * A pose inside a briefed corridor whose lookahead leaves it is graded
 * unknown, and the caveat says why, where the pose alone said nothing. */

import { describe, expect, it, vi } from 'vitest';
import type { TrackPoint } from '$lib/nav/trace';

const T = Date.parse('2026-09-18T10:00:00Z');
const H = 3_600_000;

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(300),
	peekElevationFtAt: () => undefined,
}));
vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

/** Twenty seconds at 60 kt on `trackDeg`, ending at 48.819 N 2.6 E at T. */
function trace(trackDeg: number): TrackPoint[] {
	const pts: TrackPoint[] = [];
	const step = 60 / 3600 / 60;
	for (let i = 0; i < 20; i++) {
		const back = 19 - i;
		pts.push({
			lat: 48.819 - (trackDeg === 0 ? back * step : 0),
			lon: 2.6 - (trackDeg === 90 ? (back * step) / Math.cos((48.819 * Math.PI) / 180) : 0),
			altFt: 800,
			timeMs: T - back * 1000,
			speedKt: 60,
			trackDeg,
		});
	}
	return pts;
}

describe('the caveat at the pose and the lookahead', () => {
	it('names the position when the lookahead leaves the briefed corridor', async () => {
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { commitBriefing } = await import('$lib/state/notam.svelte');
		const { alertInputGaps } = await import('$lib/state/airspaceAlert.svelte');
		// A corridor 2 NM each side of 48.819 N, from 2.4 E to 2.8 E.
		commitBriefing(['W0001/26 NOTAMN', 'Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003', 'A) LFFF B) 2601010000 C) PERM', 'E) PJE.'].join('\n'), {
			source: 'sofia',
			kind: 'route',
			briefed: { from: T - H, to: T + 20 * H },
			asked: {
				region: {
					kind: 'tracks',
					tracks: [{ label: 'A-B', path: [{ lat: 48.819, lon: 2.4 }, { lat: 48.819, lon: 2.8 }], landed: true, ends: null }],
					halfWidthNM: 2,
				},
				aim: 'flight',
			},
		});
		importTrace(trace(90), 'msl');
		setPlayhead(T);
		expect(alertInputGaps()?.briefingMiss ?? null).toBeNull();
		importTrace(trace(0), 'msl');
		setPlayhead(T);
		expect(alertInputGaps()?.briefingMiss).toBe('position');
	});
});
