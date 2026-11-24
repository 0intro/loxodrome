/* The SUP AIP zone activations the airspace alerts read come from the RAW
 * NOTAM array, as the airspace activations do: a list filter, the
 * briefing period or the wall clock under a replay must not take an
 * activation NOTAM away from the evaluator, or a zone whose own schedule
 * misses the slot reads cold while the NOTAM holds it active. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupAip } from '$lib/data/supaip';
import type { TrackPoint } from '$lib/nav/trace';
import { parseNotams } from '$lib/notam';
import { fromTriple } from '$lib/vertical/limits';

// The flight: 7 July 2026 at 10:00 UTC, inside ZRT TEST at 800 ft.
const T = Date.parse('2026-07-07T10:00:00Z');

const RING: [number, number][] = [
	[48.6, 2.4],
	[48.6, 2.8],
	[49.0, 2.8],
	[49.0, 2.4],
];

// 100/2026 creates ZRT TEST, scheduled on 1 July alone and valid all July.
const SUP: SupAip = {
	id: 'metropole-2026-100',
	title: '100/2026',
	number: 100,
	year: 2026,
	region: 'metropole',
	descriptionFr: '',
	descriptionEn: '',
	lieu: '',
	urlPdf: '',
	urlPdfEn: '',
	validFrom: '2026-07-01',
	validTo: '2026-07-31',
	ifr: true,
	vfr: true,
	airac: false,
	fir: ['LFFF'],
	adhp: [],
	zones: [
		{
			name: 'ZRT TEST',
			geometry: { type: 'polygon', ring: RING },
			bbox: { minLat: 48.6, minLon: 2.4, maxLat: 49.0, maxLon: 2.8 },
			lower: ['HEI', '0', 'FT'],
			upper: ['ALT', '5500', 'FT'],
			vLower: fromTriple(['HEI', '0', 'FT']),
			vUpper: fromTriple(['ALT', '5500', 'FT']),
			geometrySource: 'pdf-polygon',
			sameAs: '',
			exclusions: [],
			excluded: [],
			standing: [],
			activations: [{ date: '2026-07-01', from: '08:00', to: '10:00' }],
		},
	],
	bbox: { minLat: 48.6, minLon: 2.4, maxLat: 49.0, maxLon: 2.8 },
	geometrySource: 'pdf-polygon',
	parseConfidence: 'high',
	warnings: [],
	contacts: [],
	penetration: { kind: 'conditional', text: '' },
	manager: '',
	phones: [],
};

// The activation NOTAM, in force over the flight.
const ACT = parseNotams(`R1234/26
Q) LFFF/QRTCA/IV/BO/AW/000/055/4848N00236E010
A) LFFF
B) 2607070800 C) 2607071200
E) AIP SUP 100/26 : 'ZRT TEST' ACT
F) SFC
G) 5500FT AMSL
`)[0];

vi.mock('$lib/map/terrain', () => ({
	elevationFtAt: () => Promise.resolve(300),
	peekElevationFtAt: () => undefined,
}));
vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false, supaipLoaded: true },
	getAirspaces: () => [],
	getSupaips: () => [SUP],
	supaipByRef: (number: number, year: number) => (number === 100 && year === 2026 ? SUP : null),
	getAirports: () => [],
	getNavaids: () => [],
	airportByIdent: () => null,
	airportLookup: () => null,
	firIdentSet: () => new Set(),
	navaidById: () => null,
	ensureAirports: () => Promise.resolve([]),
	ensureAirspaces: () => Promise.resolve(null),
	ensureNavaids: () => Promise.resolve([]),
	ensureSupaip: () => Promise.resolve([SUP]),
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

type FilterModule = typeof import('$lib/state/filter.svelte');

/** The zone's alert at T, after `setup` has set the filters. */
async function zoneAlert(setup: (f: FilterModule) => void) {
	const { importTrace } = await import('$lib/state/navRecording.svelte');
	const { notamState } = await import('$lib/state/notam.svelte');
	const filters = await import('$lib/state/filter.svelte');
	const { airspaceAlerts } = await import('$lib/state/airspaceAlert.svelte');
	notamState.notams = [ACT];
	setup(filters);
	importTrace(trace(), 'msl');
	return airspaceAlerts()?.alerts.find((a) => a.volume.id === 'metropole-2026-100#0') ?? null;
}

describe('SUP zone activations reach the alerts unfiltered', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('activates the zone over its NOTAM', async () => {
		const a = await zoneAlert(() => {});
		expect(a?.activityState).toBe('active');
	});

	it('keeps the activation under a search the NOTAM does not match', async () => {
		const a = await zoneAlert((f) => {
			f.filter.query = 'nothing like it';
		});
		expect(a?.activityState).toBe('active');
	});

	it('keeps the activation under a period ending before the flight', async () => {
		const a = await zoneAlert((f) => {
			f.filter.window = {
				mode: 'custom',
				horizonH: null,
				fromDate: '2026-07-01',
				fromTime: '00:00',
				toDate: '2026-07-02',
				toTime: '23:59',
			};
		});
		expect(a?.activityState).toBe('active');
	});

	it('keeps the activation in a replay months later', async () => {
		vi.setSystemTime(Date.parse('2026-11-17T09:00:00Z'));
		const a = await zoneAlert(() => {});
		expect(a?.activityState).toBe('active');
	});
});
