/* Shared airspace-schedule memo for NavLogSheet + NavLogSchedule + the
 * navigation-mode live selector (state/navLive.svelte.ts). The two
 * nav-log components mount side by side everywhere (nav-log modal,
 * kneeboard print, dossier print), the contact selector reads the same
 * briefed sequence live, and all need the same heavy
 * computeAirspaceSchedule walk for the same route; this keyed memo
 * dedupes the recompute. Only the walk is memoized: the cheap
 * resolveScheduleRadios stage stays per-consumer so it keeps tracking
 * the frequency-override state. */
import { computeAirspaceSchedule, type RouteAirspaceEvent } from '$lib/route/airspaces';
import type { Airspace } from '$lib/data/airspaces';
import type { TerrainSample } from '$lib/map/terrain';
import type { Waypoint } from '$lib/state/route.svelte';

interface ScheduleMemoEntry {
	airspaces: Airspace[];
	terrain: TerrainSample[] | null | undefined;
	out: RouteAirspaceEvent[];
}

const MEMO_MAX = 16;
const scheduleMemo = new Map<string, ScheduleMemoEntry>();

/** computeAirspaceSchedule behind a keyed memo. The key reads every
 *  waypoint input the walk consumes (lat / lon / alt plus the two
 *  scalars) BEFORE the cache check, the notamCorridor idiom, so a
 *  caller's $derived still tracks in-place waypoint edits on a hit; the
 *  airspaces / terrain references guard the rest. Keyed rather than
 *  single-entry because the kneeboard renders all sheets before all
 *  schedules. */
export function cachedAirspaceSchedule(
	waypoints: Waypoint[],
	airspaces: Airspace[],
	cruiseSpeedKt: number | null,
	defaultAltFt: number,
	terrain?: TerrainSample[] | null,
): RouteAirspaceEvent[] {
	const key = `${cruiseSpeedKt ?? ''}|${defaultAltFt}|${waypoints
		.map((w) => `${w.lat},${w.lon},${w.alt}`)
		.join(';')}`;
	const hit = scheduleMemo.get(key);
	if (hit && hit.airspaces === airspaces && hit.terrain === terrain) {
		return hit.out;
	}
	const out = computeAirspaceSchedule(waypoints, airspaces, cruiseSpeedKt, defaultAltFt, terrain);
	if (scheduleMemo.size >= MEMO_MAX) {
		scheduleMemo.clear(); // tiny bound; at most the printable-route count is live
	}
	scheduleMemo.set(key, { airspaces, terrain, out });
	return out;
}
