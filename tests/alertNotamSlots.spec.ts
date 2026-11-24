/* An activation NOTAM holds its zone in the windows of its D) item.
 * R2724/26 activates LF-R 174 "MON-FRI H24" from 28 SEP to 27 NOV 2026:
 * the zone is active on a Friday, and on the Saturday between it reads its
 * published hours again ("Possible activation by NOTAM except SAT, SUN and
 * HOL"), inactive. The NOTAM is the 2026-09 corpus's, verbatim, the row the
 * shipped one, joined by the alerts' own state (data/activity.ts, the
 * confirmed rung). */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import type { TrackPoint } from '$lib/nav/trace';
import { parseNotams } from '$lib/notam';

const ROWS = (JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { rows: unknown[][] }).rows;
const R174 = rowToAirspace(ROWS.find((r) => r[0] === 'LFR174') ?? [], 'fr') as Airspace;

const R2724 = parseNotams(`R2724/26
Q) LFEE/QRRCA/IV/BO/W/000/017/4755N00724E002
A) LFEE
B) 2609280000 C) 2611272359
D) MON-FRI H24
E) RESTRICTED AREA LF-R 174 'MEYENHEIM' ACTIVE
F) SFC
G) 1700FT AMSL
`)[0];

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(300),
	peekElevationFtAt: () => undefined,
}));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false, supaipLoaded: true },
	getAirspaces: () => [R174],
	getSupaips: () => [],
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
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

/** A short airborne trace through the zone's centre, at 1200 ft, ending at `t`. */
function trace(t: number): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({
			lat: 47.91 + i * 0.001,
			lon: 7.398,
			altFt: 1200,
			timeMs: t - (19 - i) * 1000,
			speedKt: 60,
			trackDeg: 0,
		});
	}
	return pts;
}

/** LF-R 174's alert at `iso`, R2724/26 loaded. */
async function r174Alert(iso: string) {
	const t = Date.parse(iso);
	vi.setSystemTime(t);
	const { importTrace } = await import('$lib/state/navRecording.svelte');
	const { notamState } = await import('$lib/state/notam.svelte');
	const { airspaceAlerts } = await import('$lib/state/airspaceAlert.svelte');
	notamState.notams = [R2724];
	importTrace(trace(t), 'msl');
	return airspaceAlerts()?.alerts.find((a) => a.volume.id === 'LFR174') ?? null;
}

describe('an activation NOTAM holds in the windows of its D) item', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers({ toFake: ['Date'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('activates LF-R 174 on a Friday, over its run of weekdays', async () => {
		const a = await r174Alert('2026-11-20T10:00:00Z');
		expect(a?.activityState).toBe('active');
		// Monday to Friday H24 is one stretch, each day opening the
		// millisecond after the one before closes.
		expect(a?.window).toEqual({ startMs: Date.parse('2026-11-16T00:00:00Z'), endMs: Date.parse('2026-11-21T00:00:00Z') - 1 });
	});

	it('leaves LF-R 174 to its published hours on the Saturday', async () => {
		expect(await r174Alert('2026-11-21T10:00:00Z')).toBeNull();
	});
});
