/* The SUP AIP display window (state/supaip.svelte visibleSupaipZones). A zone
 * draws while its supplement is in force during the evaluation window,
 * narrowed to the zone's own schedule where the supplement's PDF published
 * one. With no date filter that window is now onwards (activeEvalWindow), so
 * an expired supplement stops drawing while an upcoming or open-ended one
 * still does; setting the date filter's range moves the window in both
 * directions, which is how a past period is looked at.
 *
 * The seasonal pair is the real SUP 188/2025 shape: one supplement valid a
 * whole year carrying a HIVER zone and an ETE zone, plus a third zone whose
 * schedule did not parse, which falls back to the supplement's validity. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSupaip } from '$lib/state/data.svelte';
import { filter, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';
import { visibleSupaipZones, supaipsInForce, supaipZonesAt } from '$lib/state/supaip.svelte';

const NOW = '2026-07-31T12:00:00Z';

/** A small square around (lat, lon), so every fixture zone has geometry
 *  (visibleSupaipZones skips zones without one) at a distinct place. */
function square(lat: number, lon: number): [number, number][] {
	return [
		[lat - 0.1, lon - 0.1],
		[lat - 0.1, lon + 0.1],
		[lat + 0.1, lon + 0.1],
		[lat + 0.1, lon - 0.1],
	];
}

type Activation = {
	date: string;
	dateTo?: string;
	from?: string;
	to?: string;
	sunFrom?: string;
	sunTo?: string;
};
type ZoneSpec = {
	name: string;
	at: [number, number];
	activations?: Activation[];
	lower?: [string, string, string];
	upper?: [string, string, string];
};

/** One supplement in the positional row layout of fr-supaip.json
 *  (cmd/supaip/api.go outputFields); validFrom / validTo are fields 7 / 8. */
function rawRow(
	id: string,
	title: string,
	validFrom: string | null,
	validTo: string | null,
	specs: ZoneSpec[],
): unknown[] {
	const zones = specs.map((z) => {
		const ring = square(z.at[0], z.at[1]);
		return {
			name: z.name,
			geometry: { type: 'polygon', ring },
			bbox: [
				Math.min(...ring.map((p) => p[0])),
				Math.min(...ring.map((p) => p[1])),
				Math.max(...ring.map((p) => p[0])),
				Math.max(...ring.map((p) => p[1])),
			],
			lower: z.lower ?? null,
			upper: z.upper ?? null,
			geometrySource: 'pdf-polygon',
			activations: z.activations ?? [],
		};
	});
	return [
		id, title, id.startsWith('be-') ? 'be' : 'metropole', '', '', '', '',
		validFrom, validTo,
		false, false, false, [], [], zones, null, 'pdf-polygon', 'none', [], '',
		[], null, '',
	];
}

const EXPIRED_AT: [number, number] = [44.0, 1.0];
const IN_FORCE_AT: [number, number] = [45.0, 1.0];

const FR_ROWS = [
	// Validity ended before NOW, no schedule: the case that used to draw.
	rawRow('metropole-2026-010', '010/2026', '2026-01-05', '2026-06-30', [
		{ name: 'ZRT EXPIREE', at: EXPIRED_AT },
	]),
	rawRow('metropole-2026-020', '020/2026', '2026-02-16', '2026-12-31', [
		{ name: 'ZRT EN VIGUEUR', at: IN_FORCE_AT },
	]),
	// Not yet effective: still drawn, as an upcoming NOTAM is still listed.
	rawRow('metropole-2026-030', '030/2026', '2026-10-01', '2026-12-31', [
		{ name: 'ZRT A VENIR', at: [46.0, 1.0] },
	]),
	// Vertically limited, for the altitude-filter composition.
	rawRow('metropole-2026-040', '040/2026', '2026-01-01', '2026-12-31', [
		{
			name: 'ZRT EN ALTITUDE',
			at: [47.0, 1.0],
			lower: ['ALT', '5000', 'FT'],
			upper: ['ALT', '8000', 'FT'],
		},
	]),
	// The seasonal supplement: valid a whole year, one zone per season.
	rawRow('metropole-2025-188', '188/2025', '2025-11-13', '2026-11-10', [
		{
			name: 'ZRT CESA SUD HIVER',
			at: [45.0, -1.0],
			activations: [{ date: '2025-11-13', dateTo: '2026-04-30' }],
		},
		{
			name: 'ZRT CESA SUD ETE',
			at: [45.2, -1.0],
			activations: [{ date: '2026-05-04', dateTo: '2026-11-10' }],
		},
		{ name: 'ZRT CESA NORD HIVER', at: [45.4, -1.0] },
	]),
	// The 240/2026 shape: listed to end before it begins, the SIA's form for
	// a supplement cancelled before it came into force, while its PDF still
	// schedules the zone well past the cancellation.
	rawRow('metropole-2026-050', '050/2026', '2026-08-20', '2026-08-12', [
		{
			name: 'ZRT ANNULEE',
			at: [43.0, 3.0],
			activations: [{ date: '2026-08-20', dateTo: '2027-12-31' }],
		},
	]),
	// The 133/2026 shape: listed to the day a successor replaced it, its
	// PDF scheduling the zone to the end of the year.
	rawRow('metropole-2026-060', '060/2026', '2026-06-22', '2026-08-14', [
		{
			name: 'ZRT REMPLACEE',
			at: [43.0, 4.0],
			activations: [{ date: '2026-06-22', dateTo: '2026-12-31' }],
		},
	]),
	// The 241/2026 shape: active every night of its validity, the last
	// night opening on its final day.
	rawRow('metropole-2026-070', '070/2026', '2026-07-01', '2026-07-31', [
		{
			name: 'ZRT NOCTURNE',
			at: [43.0, 5.0],
			activations: [{ date: '2026-07-01', dateTo: '2026-07-31', from: '22:00', to: '05:00' }],
		},
	]),
	// A window printed "0800-2400", which cmd/supaip keeps as 24:00.
	rawRow('metropole-2026-080', '080/2026', '2026-07-01', '2026-07-31', [
		{
			name: 'ZRT JUSQUA MINUIT',
			at: [43.0, 6.0],
			activations: [{ date: '2026-07-20', from: '08:00', to: '24:00' }],
		},
	]),
	// The 185/2026 shape: active from sunset plus 30 minutes to sunrise
	// minus 30, the last night opening on its final day.
	rawRow('metropole-2026-090', '090/2026', '2026-09-01', '2026-12-31', [
		{
			name: 'ZRT NUIT',
			at: [45.3, 6.1],
			activations: [{ date: '2026-09-14', dateTo: '2026-09-25', sunFrom: 'SS+30', sunTo: 'SR-30' }],
		},
	]),
	// The 108/2026 shape: active by day alone.
	rawRow('metropole-2026-100', '100/2026', '2026-08-01', '2026-12-31', [
		{
			name: 'ZRT DE JOUR',
			at: [45.3, 6.3],
			activations: [{ date: '2026-08-03', dateTo: '2026-08-07', sunFrom: 'SR', sunTo: 'SS' }],
		},
	]),
];

// The Belgian shape: no schedules at all, and an open-ended validity.
const BE_ROWS = [rawRow('be-2022-001', '001/2022', '2022-01-27', null, [
	{ name: 'EBR ZONE', at: [50.8, 4.4] },
])];

/** The visible zones as sorted "<supplement id>#<zone index>" keys. */
function keys(): string[] {
	return visibleSupaipZones()
		.map((it) => `${it.sup.id}#${it.zoneIndex}`)
		.sort();
}

describe('visibleSupaipZones (evaluation window)', () => {
	beforeAll(async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn((url: unknown) =>
				Promise.resolve(
					new Response(
						JSON.stringify(
							String(url).includes('fr-supaip')
								? { fields: [], rows: FR_ROWS }
								: String(url).includes('be-supaip')
									? { fields: [], rows: BE_ROWS }
									: { fields: [], rows: [] },
						),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
				),
			),
		);
		// Load before faking the clock, so the fetch promises settle normally.
		await ensureSupaip();
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
	});

	afterAll(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		filter.altitude.enabled = true;
	});

	beforeEach(() => {
		filter.altitude.enabled = false;
	});

	afterEach(() => {
		filter.window.mode = 'now';
		filter.window.horizonH = DEFAULT_HORIZON_H;
		filter.window.fromDate = '';
		filter.window.fromTime = '';
		filter.window.toDate = '';
		filter.window.toTime = '';
	});

	it('draws what is in force from now on', () => {
		expect(keys()).toEqual([
			// Open-ended validity: in force until a supplement withdraws it.
			'be-2022-001#0',
			// The summer zone and the one whose schedule did not parse.
			'metropole-2025-188#1',
			'metropole-2025-188#2',
			'metropole-2026-020#0',
			// Effective in October: upcoming, not expired, and the unbounded
			// default withholds nothing that is scheduled.
			'metropole-2026-030#0',
			'metropole-2026-040#0',
			'metropole-2026-060#0',
			// Its last night opens tonight.
			'metropole-2026-070#0',
			'metropole-2026-090#0',
			'metropole-2026-100#0',
		]);
	});

	function at(date: string, time: string): void {
		const [h, m] = time.split(':').map(Number);
		filter.window.mode = 'custom';
		filter.window.fromDate = date;
		filter.window.fromTime = time;
		filter.window.toDate = date;
		filter.window.toTime = `${String(h).padStart(2, '0')}:${String(m + 1).padStart(2, '0')}`;
	}

	it('draws a window the sun bounds from sunrise or sunset at the zone', () => {
		// At 45.3N 6.1E sunset falls near 17:55 UTC on 14 September and
		// sunrise near 05:35 on the 26th: the first night opens near 18:25
		// and the last one closes near 05:05.
		at('2026-09-14', '12:00');
		expect(keys()).not.toContain('metropole-2026-090#0');
		at('2026-09-26', '03:00');
		expect(keys()).toContain('metropole-2026-090#0');
		at('2026-09-26', '07:00');
		expect(keys()).not.toContain('metropole-2026-090#0');
		// Sunrise near 04:20 UTC on 3 August, sunset near 18:55 on the 7th.
		at('2026-08-03', '02:00');
		expect(keys()).not.toContain('metropole-2026-100#0');
		at('2026-08-05', '12:00');
		expect(keys()).toContain('metropole-2026-100#0');
		at('2026-08-07', '21:00');
		expect(keys()).not.toContain('metropole-2026-100#0');
	});

	it('keeps a night window drawn to the morning after its last day', () => {
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-07-31';
		filter.window.fromTime = '22:30';
		filter.window.toDate = '2026-07-31';
		filter.window.toTime = '22:31';
		expect(keys()).toContain('metropole-2026-070#0');
		expect(supaipsInForce().map((s) => s.id)).toContain('metropole-2026-070');
		filter.window.fromDate = '2026-08-01';
		filter.window.fromTime = '04:30';
		filter.window.toDate = '2026-08-01';
		filter.window.toTime = '04:31';
		expect(keys()).toContain('metropole-2026-070#0');
		filter.window.fromTime = '06:00';
		filter.window.toTime = '06:01';
		expect(keys()).not.toContain('metropole-2026-070#0');
	});

	it('draws a window ending at 24:00 to the end of its day', () => {
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-07-20';
		filter.window.fromTime = '23:30';
		filter.window.toDate = '2026-07-20';
		filter.window.toTime = '23:31';
		expect(keys()).toContain('metropole-2026-080#0');
		expect(supaipsInForce().map((s) => s.id)).toContain('metropole-2026-080');
		filter.window.fromDate = '2026-07-21';
		filter.window.fromTime = '01:00';
		filter.window.toDate = '2026-07-21';
		filter.window.toTime = '01:01';
		expect(keys()).not.toContain('metropole-2026-080#0');
	});

	it('never draws a supplement cancelled before it came into force', () => {
		expect(keys()).not.toContain('metropole-2026-050#0');
		expect(supaipsInForce().map((s) => s.id)).not.toContain('metropole-2026-050');
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-09-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-09-02';
		filter.window.toTime = '00:00';
		expect(keys()).not.toContain('metropole-2026-050#0');
		expect(supaipsInForce().map((s) => s.id)).not.toContain('metropole-2026-050');
	});

	it('ends a zone schedule with its supplement', () => {
		expect(supaipsInForce().map((s) => s.id)).toContain('metropole-2026-060');
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-09-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-09-02';
		filter.window.toTime = '00:00';
		expect(keys()).not.toContain('metropole-2026-060#0');
		expect(supaipsInForce().map((s) => s.id)).not.toContain('metropole-2026-060');
	});

	it('drops a supplement beyond a chosen look-ahead', () => {
		// 030/2026 takes effect on 2026-10-01, months ahead: decluttered away
		// only once the pilot asks for a nearer horizon.
		filter.window.horizonH = 24;
		expect(keys()).not.toContain('metropole-2026-030#0');
		expect(keys()).toContain('metropole-2026-020#0');
	});

	it('drops a supplement whose validity has ended', () => {
		expect(keys()).not.toContain('metropole-2026-010#0');
	});

	it('drops the zone whose own season has ended, keeping its siblings', () => {
		// 188/2025 is valid to 2026-11-10, so the supplement is in force; only
		// the winter zone's schedule has run out.
		expect(keys()).not.toContain('metropole-2025-188#0');
		expect(keys()).toContain('metropole-2025-188#1');
	});

	it('falls back to the supplement validity for a zone with no schedule', () => {
		expect(keys()).toContain('metropole-2025-188#2');
	});

	it('follows the date filter back into the past', () => {
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-06-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-06-02';
		filter.window.toTime = '00:00';
		expect(keys()).toEqual([
			'be-2022-001#0',
			'metropole-2025-188#1',
			'metropole-2025-188#2',
			// Back on screen: its validity covers the selected range.
			'metropole-2026-010#0',
			'metropole-2026-020#0',
			'metropole-2026-040#0',
		]);
	});

	it('swaps the seasonal pair when the range moves to winter', () => {
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-02-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-02-02';
		filter.window.toTime = '00:00';
		const k = keys();
		expect(k).toContain('metropole-2025-188#0');
		expect(k).not.toContain('metropole-2025-188#1');
		// 020/2026 takes effect on 2026-02-16: a range narrows both ends.
		expect(k).not.toContain('metropole-2026-020#0');
	});

	it('composes with the altitude filter', () => {
		expect(keys()).toContain('metropole-2026-040#0');
		filter.altitude.enabled = true;
		filter.altitude.floor = 0;
		filter.altitude.ceiling = 1000;
		// 5000 to 8000 ft AMSL is clear of the band; the unlimited zones stay.
		expect(keys()).not.toContain('metropole-2026-040#0');
		expect(keys()).toContain('metropole-2026-020#0');
	});

	it('keeps the right-click stack in step with the window', () => {
		expect(supaipZonesAt(EXPIRED_AT[0], EXPIRED_AT[1])).toEqual([]);
		expect(supaipZonesAt(IN_FORCE_AT[0], IN_FORCE_AT[1])).toHaveLength(1);
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-06-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-06-02';
		filter.window.toTime = '00:00';
		expect(supaipZonesAt(EXPIRED_AT[0], EXPIRED_AT[1]).map((it) => it.zone.name)).toEqual([
			'ZRT EXPIREE',
		]);
	});
});
