/* A route's crossings computed apart from the profile surface
 * (state/routeCrossings.svelte.ts), which the Overview names its zones to
 * confirm from: the rows the profile's strip reads for the same route
 * (components/profileOverlays.svelte.ts), a supplement's zone published
 * activable among them, each zone once in flight order. The deriveds run in
 * the client runtime (tests/env/webnode.ts). */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// The data store before the NOTAM state, as tests/profileOverlays.client.spec.ts
// explains.
import '$lib/state/data.svelte';
import type { ProfileOverlaySource } from '$lib/components/profileOverlays.svelte';
import type { SupAip } from '$lib/data/supaip';
import { ringBbox } from '$lib/notam/geometry';
import { crossingClock } from '$lib/state/activity.svelte';
import { briefingActivityUnknown } from '$lib/state/briefing.svelte';
import { i18n, t } from '$lib/state/i18n.svelte';
import { activeEvalWindow } from '$lib/state/notam.svelte';
import { routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';
import { planScope } from '$lib/state/planScope.svelte';
import { routeCrossings, routeProfileDocFor, zonesToAsk } from '$lib/state/routeCrossings.svelte';
import type { ZoneNote } from '$lib/state/zoneNotes.svelte';
import { routeEndpointsLabel } from '$lib/state/routeNotamFetch';
import { fromTriple } from '$lib/vertical/limits';
import { mountOverlays } from './helpers/profileOverlaysHost.svelte';

// A supplement's zone from 48.0 to 48.2 N, 2.0 to 2.2 E, SFC to 3000 ft
// AMSL, activable throughout its validity.
const RING: [number, number][] = [
	[48.0, 2.0],
	[48.0, 2.2],
	[48.2, 2.2],
	[48.2, 2.0],
];
const SUP = {
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
	validFrom: '2026-11-01',
	validTo: '2026-12-31',
	ifr: true,
	vfr: true,
	airac: false,
	fir: [],
	adhp: [],
	zones: [
		{
			name: 'ZRT TEST',
			geometry: { type: 'polygon', ring: RING },
			bbox: ringBbox(RING),
			lower: ['HEI', '0', 'FT'],
			upper: ['ALT', '3000', 'FT'],
			vLower: fromTriple(['HEI', '0', 'FT']),
			vUpper: fromTriple(['ALT', '3000', 'FT']),
			geometrySource: 'pdf-polygon',
			sameAs: '',
			exclusions: [],
			excluded: [],
			standing: [{ mode: 'activable' }],
			activations: [],
		},
	],
	bbox: ringBbox(RING),
	geometrySource: 'pdf-polygon',
	parseConfidence: 'high',
	warnings: [],
	contacts: [{ unit: 'BLOIS INFO', freqs: ['118.455'], users: false }],
	penetration: { kind: 'circumvent', text: '' },
	manager: '',
	phones: [],
} as unknown as SupAip;

vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return { ...actual, getSupaips: () => [SUP] };
});

const wp = (id: string, lon: number): Waypoint => ({ id, lat: 48.1, lon, kind: 'free', alt: 2000, altAuto: false });
// West to east across the zone at 2000 ft, and back.
const OUT: Route = { id: 'out', name: null, selectedWaypointId: null, waypoints: [wp('a', 1.8), wp('b', 2.4)] };
const BACK: Route = { id: 'back', name: null, selectedWaypointId: null, waypoints: [wp('c', 2.4), wp('d', 1.8)] };

describe('a route crossings apart from its profile', () => {
	beforeAll(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 10, 23, 10));
	});
	afterAll(() => {
		vi.useRealTimers();
		i18n.locale = 'en';
	});

	it('reads the supplement zone as may be active', () => {
		const rows = routeCrossings(OUT).map((c) => [c.key, c.unknown, c.reason]);
		expect(rows).toEqual([['sup:metropole-2026-100#0', true, 'activable']]);
	});

	it('gives the rows the profile strip reads for the route', () => {
		const doc = routeProfileDocFor(OUT);
		const src: ProfileOverlaySource = {
			enough: () => true,
			pts: () => OUT.waypoints,
			cumNM: () => doc.wpPoints.map((w) => w.distNM),
			bandWaypoints: () => OUT.waypoints,
			terrain: () => [],
			corridorBands: () => doc.corridorBands,
			placedBands: () => doc.placedBands,
			pathVertices: () => doc.altitudePath.vertices,
			vfr: () => routeSettings.vfr,
			verdictWindow: () => activeEvalWindow(),
			activityUnknown: () => briefingActivityUnknown(routeEndpointsLabel(OUT)),
			crossingClock: () => crossingClock(OUT),
		};
		const { overlays, stop } = mountOverlays(src);
		const row = (c: { key: string; forbidden: boolean; active: boolean; unknown: boolean; reason: unknown }) => [
			c.key,
			c.forbidden,
			c.active,
			c.unknown,
			c.reason,
		];
		expect(overlays.crossings.map(row)).toEqual(routeCrossings(OUT).map(row));
		stop();
	});

	it('names each zone to confirm once, in flight order', () => {
		const zones = zonesToAsk([OUT, BACK]).confirm;
		expect(zones.map((z) => [z.routeId, z.key, z.name])).toEqual([['out', 'sup:metropole-2026-100#0', 'ZRT TEST']]);
		expect(zones[0].known.map((k) => `${k.unit} ${k.freq}`)).toEqual(['BLOIS INFO 118.455']);
	});

	it('takes a zone the pilot noted out of those to confirm', () => {
		// The flight app's scope: a flight from 10:00Z to 12:00Z, and an
		// in-memory note, inactive from 09:00Z to 13:00Z, over the whole
		// verdict window.
		const notes = new Map<string, ZoneNote>([
			[
				'metropole-2026-100#0',
				{
					state: 'inactive',
					notedAtMs: Date.UTC(2026, 10, 23, 9),
					untilMs: Date.UTC(2026, 10, 23, 13),
					unit: 'BLOIS INFO',
					name: 'ZRT TEST',
				},
			],
		]);
		const w = { from: Date.UTC(2026, 10, 23, 10), to: Date.UTC(2026, 10, 23, 12) };
		planScope.flight = { window: () => w, flyable: () => true, etdStated: () => true, timed: () => true, briefingWindow: () => w };
		planScope.zoneNotes = {
			note: (id) => notes.get(id) ?? null,
			all: () => Object.fromEntries(notes),
			set: () => {},
			clear: () => {},
		};
		try {
			const row = routeCrossings(OUT).find((c) => c.key === 'sup:metropole-2026-100#0');
			expect([row?.reason, row?.unknown]).toEqual(['noted', false]);
			const { confirm, noted } = zonesToAsk([OUT, BACK]);
			expect(confirm).toEqual([]);
			expect(noted.map((z) => [z.routeId, z.key, z.name, z.note.unit])).toEqual([
				['out', 'sup:metropole-2026-100#0', 'ZRT TEST', 'BLOIS INFO'],
			]);
			// A zone noted on the way out and still to confirm on the way back
			// is one to confirm, counted once, under the route crossing it so.
			const part = zonesToAsk([OUT, BACK], (r) =>
				routeCrossings(r).map((c) => (r.id === 'out' ? c : { ...c, unknown: true, reason: 'activable' as const })),
			);
			expect([part.confirm.map((z) => [z.routeId, z.key]), part.noted]).toEqual([[['back', 'sup:metropole-2026-100#0']], []]);
		} finally {
			planScope.flight = null;
			planScope.zoneNotes = null;
		}
	});

	it('words the Overview line in both languages', () => {
		expect(t.flightprep.confirmZones('ZRT TEST (BLOIS INFO 118.455)', 2, 0)).toBe(
			'To confirm before the flight: ZRT TEST (BLOIS INFO 118.455) and 2 more.',
		);
		expect(t.flightprep.confirmZones('ZRT TEST (BLOIS INFO 118.455)', 1, 1)).toBe(
			'To confirm before the flight: ZRT TEST (BLOIS INFO 118.455) and 1 more, 1 noted.',
		);
		expect(t.flightprep.notedZones('ZRT TEST (inactive until 16:00Z, BLOIS INFO)', 0)).toBe(
			'Noted before the flight: ZRT TEST (inactive until 16:00Z, BLOIS INFO).',
		);
		i18n.locale = 'fr';
		expect(t.flightprep.confirmZones('ZRT TEST (BLOIS INFO 118.455)', 0, 0)).toBe(
			'À confirmer avant le vol : ZRT TEST (BLOIS INFO 118.455).',
		);
		expect(t.flightprep.confirmZones('ZRT TEST', 2, 2)).toBe('À confirmer avant le vol : ZRT TEST et 2 autres, 2 notées.');
		expect(t.flightprep.notedZones('ZRT TEST (inactive jusqu’à 16:00Z, BLOIS INFO)', 1)).toBe(
			'Noté avant le vol : ZRT TEST (inactive jusqu’à 16:00Z, BLOIS INFO) et 1 autre.',
		);
	});
});
