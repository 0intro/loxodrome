/* A route's crossings as the profile's strip judges them for the planned
 * flight (components/profileOverlays.svelte.ts), computed apart from the
 * profile surface: the route's profile document over its terrain
 * (route/routeProfile.ts buildRouteProfileDoc, memoised per route), the
 * NOTAM and supplement bands over the verdict window, and each zone's
 * state at its crossing. The Overview names the zones to confirm from it.
 * The band recipes live here once, for the profile surface and the
 * dossier too. */

import type { KnownUnit } from '$lib/data/knownFrom';
import type { TerrainSample } from '$lib/map/terrain';
import { supaipVolumes } from '$lib/nav/alertVolumes';
import { isActivationQCode } from '$lib/notam/qcode';
import type { Notam } from '$lib/notam/types';
import { computeNotamProfileBands, placeNotamBands, type PlacedNotamBand } from '$lib/route/notamProfile';
import { bandCrossings, buildRouteProfileDoc, type BandCrossing, type RouteProfileDocData } from '$lib/route/routeProfile';
import { computeSupProfileBands, placeSupBands, type PlacedSupBand } from '$lib/route/supProfile';
import { zsmProfileBands, type PlacedZsmBand } from '$lib/route/zsmProfile';
import { bandKnownFrom, bandNote, bandStates, crossingClock, crossingRanges } from './activity.svelte';
import { effectiveClimbGradFtPerNM, effectiveCruiseSpeedKt, effectiveDescentGradFtPerNM } from './aircraft.svelte';
import { briefingActivityUnknown } from './briefing.svelte';
import { airportByIdent, dataState, getAirspaces, getSupaips } from './data.svelte';
import { t } from './i18n.svelte';
import { activeEvalWindow, rawNotamsDuring, type IndexedNotam } from './notam.svelte';
import { activatedAirspaceIds } from './notamLinks.svelte';
import { planScope } from './planScope.svelte';
import { routeSettings, type Route, type Waypoint } from './route.svelte';
import { routeEndpointsLabel } from './routeNotamFetch';
import { routeTerrainSamples } from './routeTerrain.svelte';
import { validityOverlaps } from './supaip.svelte';
import type { ZoneNote } from './zoneNotes.svelte';
import { zsmActiveZones } from './zsm.svelte';

/** An activation NOTAM whose zone the profile draws: that zone's band
 *  carries it, its own geometry, the coarse Q circle, drawing none. */
export function activationRepresented(n: Notam): boolean {
	return isActivationQCode(n.qCode) && activatedAirspaceIds(n).length > 0;
}

/** The NOTAM bands of a route over `notams`, placed on its terrain: the
 *  track's crossings of their published restriction and warning geometry
 *  (route/notamProfile.ts). Null where none crosses. */
export function routeNotamBands(
	waypoints: Waypoint[],
	notams: IndexedNotam[],
	terrain: TerrainSample[],
): PlacedNotamBand[] | null {
	const raw = computeNotamProfileBands(waypoints, notams, activationRepresented);
	return raw.length > 0 ? placeNotamBands(raw, terrain) : null;
}

/** The supplements' zones a route crosses (route/supProfile.ts), of those
 *  in force over `from` to `to`, placed on its terrain. Null where none
 *  crosses. */
export function routeSupBands(
	waypoints: Waypoint[],
	from: number,
	to: number,
	terrain: TerrainSample[],
): PlacedSupBand[] | null {
	void dataState.supaipLoaded;
	const sups = (getSupaips() ?? []).filter((s) => validityOverlaps(s, from, to));
	const bands = sups.length > 0 ? computeSupProfileBands(waypoints, supaipVolumes(sups)) : [];
	if (bands.length === 0) {
		return null;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup local to one placement
	const titles = new Map(sups.map((s) => [s.id, s.title]));
	return placeSupBands(bands, terrain, titles);
}

/** The raptor zones a route crosses (route/zsmProfile.ts), of those active
 *  over `from` to `to`, placed on its terrain. Null where none crosses. */
export function routeZsmBands(
	waypoints: Waypoint[],
	from: number,
	to: number,
	terrain: TerrainSample[],
): PlacedZsmBand[] | null {
	const zones = zsmActiveZones(from, to);
	const bands = zones.length > 0 ? zsmProfileBands(waypoints, zones, terrain) : [];
	return bands.length > 0 ? bands : null;
}

interface DocEntry {
	key: string;
	airspaces: ReturnType<typeof getAirspaces> | null;
	terrain: TerrainSample[] | null;
	labels: Record<string, string>;
	doc: RouteProfileDocData;
}

// One document per route, the last asked for: the Overview's two mounts,
// the screen's and the dossier's, share it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a memo, never read reactively
const docMemo = new Map<string, DocEntry>();

/** The route's profile document over its terrain (routeTerrainSamples), the
 *  profile surface's recipe less the drawn corridor ground. The key reads
 *  every input before the cache check, so a reader's derived tracks an edit
 *  made in place. */
export function routeProfileDocFor(route: Route): RouteProfileDocData {
	const airspaces = dataState.airspacesLoaded ? getAirspaces() : null;
	const terrain = routeTerrainSamples(route.id, route.waypoints);
	const labels = t.data.airspaceTypes as Record<string, string>;
	const key = [
		effectiveCruiseSpeedKt() ?? '',
		effectiveClimbGradFtPerNM() ?? '',
		effectiveDescentGradFtPerNM() ?? '',
		dataState.airportsLoaded,
		route.waypoints.map((w) => `${w.lat},${w.lon},${w.alt},${w.ident ?? ''}`).join(';'),
	].join('|');
	const hit = docMemo.get(route.id);
	if (hit && hit.key === key && hit.airspaces === airspaces && hit.terrain === terrain && hit.labels === labels) {
		return hit.doc;
	}
	const doc = buildRouteProfileDoc({
		waypoints: route.waypoints,
		cruiseSpeedKt: effectiveCruiseSpeedKt(),
		airspaces,
		terrain: terrain ?? [],
		airportElevFt: (ident) => airportByIdent(ident)?.elevFt ?? null,
		typeLabels: labels,
		climbGradFtPerNM: effectiveClimbGradFtPerNM(),
		descentGradFtPerNM: effectiveDescentGradFtPerNM(),
	});
	docMemo.set(route.id, { key, airspaces, terrain, labels, doc });
	return doc;
}

/** The route's crossings as its profile's strip reads them: every volume
 *  the planned path penetrates, the airspace, NOTAM, supplement and raptor
 *  zone bands of the verdict window, each zone's state at its crossing
 *  (crossingClock), the briefing asked per route. */
export function routeCrossings(route: Route): BandCrossing[] {
	const doc = routeProfileDocFor(route);
	if (doc.totalNM <= 0) {
		return [];
	}
	const window = planScope.flight?.briefingWindow() ?? activeEvalWindow();
	const terrain = routeTerrainSamples(route.id, route.waypoints) ?? [];
	const bands = [
		...doc.placedBands,
		...(routeNotamBands(route.waypoints, rawNotamsDuring(window), terrain) ?? []),
		...(routeSupBands(route.waypoints, window.from, window.to, terrain) ?? []),
		...(routeZsmBands(route.waypoints, window.from, window.to, terrain) ?? []),
	];
	const clock = crossingClock(route);
	const states = bandStates(
		bands,
		{ fromMs: window.from, toMs: window.to },
		briefingActivityUnknown(routeEndpointsLabel(route)),
		clock ? crossingRanges(bands, clock) : null,
	);
	return bandCrossings(bands, doc.altitudePath.vertices, { vfr: routeSettings.vfr, states });
}

/** A zone to confirm before the flight: a crossing its strip reads as may
 *  be active, with the route crossing it first and who knows its activity. */
export interface ZoneToConfirm {
	routeId: string;
	key: string;
	name: string;
	known: readonly KnownUnit[];
}

/** A zone the pilot's note settles at its crossings, with the note. */
export interface ZoneNoted {
	routeId: string;
	key: string;
	name: string;
	note: ZoneNote;
}

/** The zones over `routes` whose activity a unit gives, in flight order,
 *  each once with the route crossing it first: those to confirm before the
 *  flight, which may be active at a crossing, and those the pilot's note
 *  settles at every crossing, a zone still to confirm on any route being
 *  one to confirm. `crossingsOf` is each route's crossings, its profile
 *  strip's (routeCrossings). */
export function zonesToAsk(
	routes: readonly Route[],
	crossingsOf: (r: Route) => readonly BandCrossing[] = routeCrossings,
): { confirm: ZoneToConfirm[]; noted: ZoneNoted[] } {
	const confirm: ZoneToConfirm[] = [];
	const noted: ZoneNoted[] = [];
	for (const r of routes) {
		const crossings = [...crossingsOf(r)].sort((a, b) => a.firstNM - b.firstNM);
		for (const c of crossings) {
			const name = c.badge ? `${c.badge} ${c.label}` : c.label;
			if (c.unknown && !confirm.some((z) => z.key === c.key)) {
				confirm.push({ routeId: r.id, key: c.key, name, known: bandKnownFrom(c.key) });
			}
			const note = c.reason === 'noted' ? bandNote(c.key) : null;
			if (note && !noted.some((z) => z.key === c.key)) {
				noted.push({ routeId: r.id, key: c.key, name, note });
			}
		}
	}
	return { confirm, noted: noted.filter((z) => !confirm.some((c) => c.key === z.key)) };
}
