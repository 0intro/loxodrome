/* The radio schedule's frequency cell (NavLogSchedule.svelte) names a
 * channel no station is published for after its zone, as the nav log's
 * enroute lines, the band, the alert banner and the prints do
 * (format/radio.ts zoneLabel). NATS files CTA PEPZE 9, 11 and 12 with
 * 133.600 and no call sign or unit: labelled by its station alone, the line
 * had no label, the summary dropped it, and the cell printed "–" where every
 * other surface named 133.600. Rendered on the server over a schedule the
 * memo is mocked to answer. */

import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { RouteAirspaceEvent } from '$lib/route/airspaces';

import { installLeafletNode } from './helpers/leafletNode';

function event(radio: RouteAirspaceEvent['radio']): RouteAirspaceEvent {
	return {
		kind: 'enter',
		atNM: 12,
		eteMin: 7,
		key: 'EGPEPZE011|PEPZE CTA 11',
		name: 'PEPZE CTA 11',
		type: 'CTA',
		airClass: 'D',
		category: 'controlled',
		vLower: null,
		vUpper: null,
		radio,
		workHr: '',
		rmkWorkHr: '',
	};
}

let schedule: RouteAirspaceEvent[] = [];

vi.mock('$lib/state/navlogSchedule', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/state/navlogSchedule')>();
	return { ...actual, cachedAirspaceSchedule: () => schedule };
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
		dataState: { ...actual.dataState, airspacesLoaded: true, airspacesError: null },
	};
});

// The schedule's import graph reaches the map layers, which extend Leaflet's
// classes as they load.
installLeafletNode();
const { default: NavLogSchedule } = await import('$lib/components/NavLogSchedule.svelte');

type Route = import('$lib/state/route.svelte').Route;

const route: Route = {
	id: 'schedule-zone-label',
	name: null,
	selectedWaypointId: null,
	waypoints: [54, 55].map((lat, i) => ({
		id: `schedule-zone-label-${i}`,
		lat,
		lon: -3,
		kind: 'free' as const,
		alt: 3000,
		altAuto: true,
	})),
};

/** The frequency cell of the schedule's one row, its text alone. */
function frequencyCell(): string {
	const { body } = render(NavLogSchedule, { props: { route } });
	const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
		m[1].replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim(),
	);
	return cells[cells.length - 1] ?? '';
}

describe('the radio schedule names a channel with no station after its zone', () => {
	it('prints the channel NATS files with no call sign or unit', () => {
		schedule = [event([{ freq: '133.600', unit: '', call: '' }])];
		expect(frequencyCell()).toBe('CTA PEPZE CTA 11: 133.600');
	});

	it('keeps a station name where one is published', () => {
		schedule = [event([{ freq: '133.600', unit: 'LONDON CONTROL', call: 'LONDON CONTROL' }])];
		expect(frequencyCell()).toBe('LONDON CONTROL: 133.600');
	});

	it('names a withdrawn nameless channel after its zone too, struck', () => {
		schedule = [event([{ freq: '133.600', unit: '', call: '', closed: true }])];
		expect(frequencyCell()).toBe('CTA PEPZE CTA 11: 133.600');
	});
});
