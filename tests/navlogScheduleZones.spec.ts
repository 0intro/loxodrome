/* The radio and airspace schedule (NavLogSchedule.svelte) lists the
 * temporary zones the plan crosses beside the airspaces, in route order: a
 * supplement's zone wears its source and the strip's word for its state, a
 * raptor zone its chip and the height to overfly it at, and a restricted
 * area that may be active, naming no radio, gives its Frequency cell the
 * unit that knows its activity. Rendered on the server
 * over a schedule the memo is mocked to answer, the zones' states and
 * known units stood in for (tests/zoneActivity.spec.ts reads them on the
 * shipped zones). */

import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityAnswer } from '$lib/data/activity';
import type { SupAip } from '$lib/data/supaip';
import type { Zsm } from '$lib/data/zsm';
import { ringAreaM2, ringBbox } from '$lib/notam/geometry';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';
import { fromTriple } from '$lib/vertical/limits';

import { installLeafletNode } from './helpers/leafletNode';

// R 99 from 3 to 6 NM along the route, naming no radio.
function event(kind: 'enter' | 'leave', atNM: number): RouteAirspaceEvent {
	return {
		kind,
		atNM,
		eteMin: null,
		key: 'LFR99|R 99',
		name: '99',
		type: 'R',
		airClass: '',
		category: 'restricted',
		vLower: fromTriple(['HEI', '0', 'FT']),
		vUpper: fromTriple(['ALT', '3000', 'FT']),
		radio: [],
		workHr: '',
		rmkWorkHr: '',
	};
}

// A supplement's zone from 48.0 to 48.2 N, 2.0 to 2.2 E, SFC to 3000 ft
// AMSL, crossed from about 8 to 16 NM.
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
			standing: [],
			activations: [],
		},
	],
	bbox: ringBbox(RING),
	geometrySource: 'pdf-polygon',
	parseConfidence: 'high',
	warnings: [],
	contacts: [],
	penetration: null,
	manager: '',
	phones: [],
} as unknown as SupAip;

// A raptor zone from 48.0 to 48.2 N, 2.25 to 2.35 E, its height 950 m,
// crossed from about 18 to 22 NM.
const ZSM_RING: [number, number][] = [
	[48.0, 2.25],
	[48.0, 2.35],
	[48.2, 2.35],
	[48.2, 2.25],
	[48.0, 2.25],
];
const ZSM: Zsm = {
	id: 'zsm:1',
	name: 'Mont Test',
	species: 'Gypaète barbu',
	taxon: '2852',
	active: true,
	topM: 0,
	overflyM: 950,
	modified: '2026-10-31',
	ring: ZSM_RING,
	bbox: ringBbox(ZSM_RING),
	areaM2: ringAreaM2(ZSM_RING),
};
vi.mock('$lib/state/zsm.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/zsm.svelte')>();
	return { ...actual, zsmActiveZones: () => [ZSM], zsmById: (id: string) => (id === ZSM.id ? ZSM : null) };
});

vi.mock('$lib/state/navlogSchedule', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/navlogSchedule')>();
	return { ...actual, cachedAirspaceSchedule: () => [event('enter', 3), event('leave', 6)] };
});
vi.mock('$lib/state/scheduleRadios.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/scheduleRadios.svelte')>();
	return { ...actual, resolveScheduleRadios: (events: RouteAirspaceEvent[]) => events };
});
vi.mock('$lib/state/data.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/data.svelte')>();
	return {
		...actual,
		getAirspaces: () => [],
		getSupaips: () => [SUP],
		dataState: { ...actual.dataState, airspacesLoaded: true, airspacesError: null, supaipLoaded: true },
	};
});
// R 99 active at its crossing and known to BLOIS INFO, the supplement's
// zone published activable.
vi.mock('$lib/state/activity.svelte', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/activity.svelte')>();
	return {
		...actual,
		bandStates: (bands: readonly { key: string }[]) =>
			new Map<string, ActivityAnswer>(
				bands.map((b) => [
					b.key,
					b.key.startsWith('sup:')
						? { state: 'activable', reason: 'activable', period: null }
						: { state: 'active', reason: 'published', period: null },
				]),
			),
		bandKnownFrom: (key: string) => (key === 'LFR99|R 99' ? [{ unit: 'BLOIS INFO', freq: '118.455', phone: null }] : []),
	};
});

installLeafletNode();
const { default: NavLogSchedule } = await import('$lib/components/NavLogSchedule.svelte');

type Route = import('$lib/state/route.svelte').Route;

const route: Route = {
	id: 'schedule-zones',
	name: null,
	selectedWaypointId: null,
	waypoints: [1.8, 2.4].map((lon, i) => ({
		id: `schedule-zones-${i}`,
		lat: 48.1,
		lon,
		kind: 'free' as const,
		alt: 2000,
		altAuto: false,
	})),
};

/** Each row's cells, their text alone. */
function rows(): string[][] {
	const { body } = render(NavLogSchedule, { props: { route } });
	return [...body.matchAll(/<tr class="ev[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
		[...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
			m[1]
				.replace(/<!--[\s\S]*?-->/g, '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/\s+/g, ' ')
				.trim(),
		),
	);
}

describe('the schedule lists the temporary zones the plan crosses', () => {
	beforeAll(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 10, 23, 10));
	});
	afterAll(() => {
		vi.useRealTimers();
	});

	it('merges them in route order, each with its state and the unit to ask', () => {
		const r = rows();
		expect(r.map((cells) => cells[3])).toEqual([
			'R 99 SFC – 3000 ft AMSL ACTIVE',
			'R 99 SFC – 3000 ft AMSL',
			'SUP ZRT TEST SFC – 3000 ft AMSL may be active',
			'SUP ZRT TEST SFC – 3000 ft AMSL',
			'ZSM Mont Test SFC – 950 m AMSL overfly above 3 120 ft',
			'ZSM Mont Test SFC – 950 m AMSL',
		]);
		// R 99 names no radio: its entry asks BLOIS INFO, its exit nobody.
		expect(r.map((cells) => cells[4])).toEqual(['BLOIS INFO 118.455', '–', '–', '–', '–', '–']);
	});
});
