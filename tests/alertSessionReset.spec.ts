/* The alert session memory belongs to ONE trace: replacing the trace (an
 * import, a restored outing) clears the acknowledgements and the
 * presentation memory even when the new trace's stamps sit LATER than the
 * old one's, which the backward-playhead reset alone never sees. Array
 * identity is the trace identity (the airWm idiom): a live recording
 * appends in place, importTrace hands a fresh array. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';
import type { TrackPoint } from '$lib/nav/trace';

// One permanently active R zone around the pose, avoid-graded ("Avoidance
// mandatory"), SFC to 2000 ft: any fix inside it at 800 ft alerts.
const ZONE = rowToAirspace(
	[
		'LFR999',
		'R',
		'TEST',
		'',
		['ALT', '2000', 'FT'],
		['HEI', '0', 'FT'],
		null,
		null,
		'H24',
		'H24',
		'Avoidance mandatory.',
		[],
		[
			[48.6, 2.4],
			[48.6, 2.8],
			[49.0, 2.8],
			[49.0, 2.4],
		],
		'',
	],
	'fr',
);

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(300),
}));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false },
	getAirspaces: () => [ZONE],
	getSupaips: () => [],
	getAirports: () => [],
	getNavaids: () => [],
	airportByIdent: () => null,
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([]),
}));
vi.mock('$lib/state/routeTerrain.svelte', () => ({ routeTerrainSamples: () => null }));

/** A short airborne trace inside the zone starting at `t0`, on a fresh
 *  array each call. */
function trace(t0: number): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({
			lat: 48.8 + i * 0.001,
			lon: 2.6,
			altFt: 800,
			timeMs: t0 + i * 1000,
			speedKt: 60,
			trackDeg: 0,
		});
	}
	return pts;
}

describe('the alert session resets with the trace', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('a later-stamped replacement trace does not inherit the acks', async () => {
		const { importTrace } = await import('$lib/state/navRecording.svelte');
		const { airspaceAlerts, acknowledgeAlert } = await import('$lib/state/airspaceAlert.svelte');

		const t0 = Date.parse('2026-07-07T10:00:00Z');
		importTrace(trace(t0), 'msl');
		const r1 = airspaceAlerts();
		expect(r1).not.toBeNull();
		const alert = r1?.alerts.find((a) => a.volume.id === 'LFR999');
		expect(alert).toBeDefined();
		expect(alert?.acked).toBe(false);

		acknowledgeAlert(alert!.key);
		const r2 = airspaceAlerts();
		expect(r2?.alerts.find((a) => a.volume.id === 'LFR999')?.acked).toBe(true);

		// The same flight two hours later, as its own imported trace: a
		// FORWARD time jump, which the backward-jump reset never sees.
		importTrace(trace(t0 + 2 * 3600_000), 'msl');
		const r3 = airspaceAlerts();
		expect(r3?.alerts.find((a) => a.volume.id === 'LFR999')?.acked).toBe(false);
	});
});
