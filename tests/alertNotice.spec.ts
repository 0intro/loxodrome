/* A briefing's silence on a zone activated by NOTAM holds up to its time
 * plus the zone's notice. 076/2026 prints its twelve Cotentin zones
 * activable by NOTAM at 30 minutes' notice: a bulletin loaded ten minutes
 * before the flight answers for ZRT VAUVILLE, one loaded an hour before no
 * longer does (data/activity.ts, the by-NOTAM rung). The supplement is the
 * shipped one, the briefing's time the bulletin's loading, read by the
 * alerts' own state. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSupAip, SUPAIP_URL, type SupAip } from '$lib/data/supaip';
import type { TrackPoint } from '$lib/nav/trace';

let SUPS: SupAip[] = [];

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(0),
	peekElevationFtAt: () => undefined,
}));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false, supaipLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => SUPS,
	supaipByRef: () => null,
	getAirports: () => [],
	getNavaids: () => [],
	airportByIdent: () => null,
	airportLookup: () => null,
	firIdentSet: () => new Set(),
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve(SUPS),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

// Monday 23 November 2026 at 10:00 UTC, inside ZRT VAUVILLE at 1000 ft.
const T = Date.parse('2026-11-23T10:00:00Z');

// A bulletin by hand: one NOTAM far from the Cotentin.
const BULLETIN = `R2724/26
Q) LFEE/QRRCA/IV/BO/W/000/017/4755N00724E002
A) LFEE
B) 2609280000 C) 2611272359
D) MON-FRI H24
E) RESTRICTED AREA LF-R 174 'MEYENHEIM' ACTIVE
F) SFC
G) 1700FT AMSL
`;

function trace(): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({ lat: 49.57 + i * 0.001, lon: -1.944, altFt: 1000, timeMs: T - (19 - i) * 1000, speedKt: 60, trackDeg: 0 });
	}
	return pts;
}

/** ZRT VAUVILLE's alert at T, the bulletin loaded `agoMin` before. */
async function vauvilleAlert(agoMin: number) {
	const { importTrace } = await import('$lib/state/navRecording.svelte');
	const { notamState, parseInput } = await import('$lib/state/notam.svelte');
	const { airspaceAlerts } = await import('$lib/state/airspaceAlert.svelte');
	vi.setSystemTime(T - agoMin * 60_000);
	notamState.rawText = BULLETIN;
	parseInput();
	vi.setSystemTime(T);
	importTrace(trace(), 'msl');
	return airspaceAlerts()?.alerts.find((a) => a.volume.id === 'metropole-2026-076#4') ?? null;
}

describe('a zone activated by NOTAM at 30 minutes notice', () => {
	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: string) =>
			Promise.resolve(
				new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		try {
			SUPS = (await loadSupAip(SUPAIP_URL)).filter((s) => s.title === '076/2026');
		} finally {
			vi.unstubAllGlobals();
		}
	});
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('is silent under a bulletin loaded ten minutes before', async () => {
		expect(SUPS[0]?.zones[4]?.name).toBe('ZRT VAUVILLE');
		expect(await vauvilleAlert(10)).toBeNull();
	});

	it('may be active under one loaded an hour before', async () => {
		const a = await vauvilleAlert(60);
		expect([a?.activityState, a?.action]).toEqual(['activable', 'caution']);
	});
});
