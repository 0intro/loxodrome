/* The radio and airspace schedule's rows in route order: the schedule's
 * own events (state/navlogSchedule.ts cachedAirspaceSchedule), which the
 * live overlay reads by index, merged with the temporary zones' events
 * (route/airspaces.ts temporaryZoneSchedule), which it reads none of. Pure. */

import type { RouteAirspaceEvent } from '$lib/route/airspaces';

export interface ScheduleRow {
	ev: RouteAirspaceEvent;
	/** The event's index in the schedule, null for a temporary zone's. */
	raw: number | null;
}

/** Both lists merged by distance, each in its own order, a leave before an
 *  enter at one point as the schedule writes them (you leave one airspace to
 *  enter the next), and a schedule event before a temporary zone's event of
 *  the same kind. */
export function mergeScheduleRows(
	schedule: readonly RouteAirspaceEvent[],
	zones: readonly RouteAirspaceEvent[],
): ScheduleRow[] {
	const rank = (ev: RouteAirspaceEvent) => (ev.kind === 'leave' ? 0 : 1);
	const out: ScheduleRow[] = [];
	let i = 0;
	let j = 0;
	while (i < schedule.length || j < zones.length) {
		const a = schedule[i];
		const b = zones[j];
		if (a && (!b || a.atNM < b.atNM || (a.atNM === b.atNM && rank(a) <= rank(b)))) {
			out.push({ ev: a, raw: i });
			i++;
		} else {
			out.push({ ev: b, raw: null });
			j++;
		}
	}
	return out;
}
