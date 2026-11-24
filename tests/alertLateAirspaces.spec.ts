/* The airspace alerts' NOTAM windows outlive no airspace dataset. The SIA
 * writes a zone's sub-lettering apart from its number ("LF-R368 A B C1
 * C2"), and activatedAirspaceIds confirms each letter against the loaded
 * rows, so windows built while the rows were still loading lack those
 * zones. The window map must be rebuilt when the rows land, or an
 * activated zone reads cold for the rest of the flight, whatever reference
 * the SUP AIP links keep. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rowToAirspace, type Airspace } from '$lib/data/airspaces';
import { parseNotams } from '$lib/notam';
import type { TrackPoint } from '$lib/nav/trace';

// The flight: 18 September 2026 at 10:00 UTC, inside LF-R 368 B at 800 ft.
const T = Date.parse('2026-09-18T10:00:00Z');

// LF-R 368 B, activated by NOTAM, avoidance mandatory, SFC to 2000 ft.
const R368B = rowToAirspace(
	[
		'LFR368B',
		'R',
		'368 B',
		'',
		['ALT', '2000', 'FT'],
		['HEI', '0', 'FT'],
		null,
		null,
		'ACTIVABLE PAR NOTAM',
		'',
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
) as Airspace;

// Item E) verbatim from R2617/26 (LFMM, 2026-09-18), which activates 368 A,
// B, C1 and C2.
const ACT = parseNotams(`R2617/26 NOTAMN
Q) LFMM/QRRCA/IV/BO/W/000/065/4415N00530E010
A) LFMM B) 2609180000 C) 2609192359
E) LF-R368 A B C1 C2 ACTIVATED.
F) SFC
G) FL065
`)[0];

// The airspace rows, null while the dataset loads.
let rows: Airspace[] | null = null;

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(300),
	peekElevationFtAt: () => undefined,
}));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: {
		get airspacesLoaded() {
			return rows != null;
		},
		airportsLoaded: false,
		supaipLoaded: false,
	},
	getAirspaces: () => rows,
	// No SUP AIP: the SUP links stay the one empty map throughout.
	getSupaips: () => null,
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

/** A short airborne trace inside the zone ending at T. */
function trace(): TrackPoint[] {
	const pts: TrackPoint[] = [];
	for (let i = 0; i < 20; i++) {
		pts.push({
			lat: 48.8 + i * 0.001,
			lon: 2.6,
			altFt: 800,
			timeMs: T - (19 - i) * 1000,
			speedKt: 60,
			trackDeg: 0,
		});
	}
	return pts;
}

describe('the NOTAM windows follow the airspace dataset', () => {
	beforeEach(() => {
		vi.resetModules();
		rows = null;
	});

	it('activates a sub-lettered zone whose rows land after the first evaluation', async () => {
		const { importTrace, setPlayhead } = await import('$lib/state/navRecording.svelte');
		const { notamState } = await import('$lib/state/notam.svelte');
		const { airspaceAlerts } = await import('$lib/state/airspaceAlert.svelte');
		notamState.notams = [ACT];
		importTrace(trace(), 'msl');
		setPlayhead(T);
		expect(airspaceAlerts()?.alerts).toEqual([]);

		rows = [R368B];
		const alert = airspaceAlerts()?.alerts.find((a) => a.volume.id === 'LFR368B');
		expect(alert?.activityState).toBe('active');
		expect(alert?.action).toBe('avoid');
	});
});
