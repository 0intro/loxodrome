/* The temporary zones on the radio and airspace schedule: their entries and
 * exits along the route at its planned levels (route/airspaces.ts
 * temporaryZoneSchedule, the schedule's own walk over a zone's ring or
 * circle and its limits), and the rows merged with the schedule's in route
 * order, each schedule row keeping its index for the live overlay
 * (components/scheduleRows.ts mergeScheduleRows). */

import { describe, expect, it } from 'vitest';
import { mergeScheduleRows } from '$lib/components/scheduleRows';
import { ringBbox } from '$lib/notam/geometry';
import { temporaryZoneSchedule, type RouteAirspaceEvent, type ScheduleZone } from '$lib/route/airspaces';
import type { Waypoint } from '$lib/state/route.svelte';
import { fromTriple } from '$lib/vertical/limits';

// A square from 48.0 to 48.2 N, 2.0 to 2.2 E, SFC to 3000 ft AMSL.
const RING: [number, number][] = [
	[48.0, 2.0],
	[48.0, 2.2],
	[48.2, 2.2],
	[48.2, 2.0],
];

function zone(key: string, over: Partial<ScheduleZone> = {}): ScheduleZone {
	return {
		key,
		name: key,
		rings: [RING],
		circles: [],
		bbox: ringBbox(RING),
		vLower: fromTriple(['HEI', '0', 'FT']),
		vUpper: fromTriple(['ALT', '3000', 'FT']),
		...over,
	};
}

// West to east across the square at 48.1 N, flown at `alt` ft.
function route(alt: number): Waypoint[] {
	return [
		{ id: 'a', lat: 48.1, lon: 1.8, kind: 'free', alt, altAuto: false },
		{ id: 'b', lat: 48.1, lon: 2.4, kind: 'free', alt, altAuto: false },
	] as Waypoint[];
}

describe('temporaryZoneSchedule', () => {
	it('enters and leaves a zone the route flies through at its level', () => {
		const ev = temporaryZoneSchedule(route(2000), [zone('sup:x#0')], 100, 2000);
		expect(ev.map((e) => [e.kind, e.key, e.category, e.type])).toEqual([
			['enter', 'sup:x#0', 'restricted', ''],
			['leave', 'sup:x#0', 'restricted', ''],
		]);
		// The square spans 0.2 degrees of longitude, about 8 NM at 48.1 N.
		expect(ev[0].atNM).toBeGreaterThan(7);
		expect(ev[0].atNM).toBeLessThan(9);
		expect(ev[1].atNM).toBeGreaterThan(15);
		expect(ev[1].atNM).toBeLessThan(17);
		expect(ev[0].eteMin).toBeCloseTo((ev[0].atNM / 100) * 60, 6);
	});

	it('lists nothing flown over the zone, and reads a circle as a ring', () => {
		expect(temporaryZoneSchedule(route(4500), [zone('sup:x#0')], 100, 2000)).toEqual([]);
		const circle = zone('notam:R1234/26', {
			rings: [],
			circles: [{ lat: 48.1, lon: 2.1, radiusM: 3704 }],
		});
		const ev = temporaryZoneSchedule(route(2000), [circle], 100, 2000);
		expect(ev.map((e) => [e.kind, e.key])).toEqual([
			['enter', 'notam:R1234/26'],
			['leave', 'notam:R1234/26'],
		]);
		// A 2 NM radius: about 4 NM of the route inside it.
		expect(ev[1].atNM - ev[0].atNM).toBeGreaterThan(3);
		expect(ev[1].atNM - ev[0].atNM).toBeLessThan(5);
	});
});

function at(kind: 'enter' | 'leave', atNM: number, key: string): RouteAirspaceEvent {
	return {
		kind,
		atNM,
		eteMin: null,
		key,
		name: key,
		type: 'R',
		airClass: '',
		category: 'restricted',
		vLower: null,
		vUpper: null,
		radio: [],
		workHr: '',
		rmkWorkHr: '',
	};
}

describe('mergeScheduleRows', () => {
	it('merges by distance, a leave before an enter at one point, the schedule first', () => {
		const schedule = [at('enter', 3, 'A'), at('leave', 10, 'A'), at('enter', 10, 'B')];
		const zones = [at('enter', 5, 'Z'), at('leave', 10, 'Z'), at('enter', 10, 'Y')];
		const rows = mergeScheduleRows(schedule, zones);
		expect(rows.map((r) => [r.ev.kind, r.ev.key, r.raw])).toEqual([
			['enter', 'A', 0],
			['enter', 'Z', null],
			['leave', 'A', 1],
			['leave', 'Z', null],
			['enter', 'B', 2],
			['enter', 'Y', null],
		]);
	});

	it('keeps the schedule whole with no zone, and the zones with no schedule', () => {
		const schedule = [at('enter', 3, 'A'), at('leave', 10, 'A')];
		expect(mergeScheduleRows(schedule, []).map((r) => r.raw)).toEqual([0, 1]);
		expect(mergeScheduleRows([], schedule).map((r) => r.raw)).toEqual([null, null]);
		expect(mergeScheduleRows([], [])).toEqual([]);
	});
});
