/* The nav log's frequency cell, built once for every surface that prints it:
 * NavLogSheet on screen and on paper, the saved snapshot
 * (route/navlogExport.ts) and the kneeboard's no-DOM card estimator
 * (components/navlogCards.ts), which prices a waypoint's banner by the lines
 * built here. Each waypoint gets its aerodrome's lines and the airspace
 * lines under it: the shared schedule memo, the frequency-override and
 * hours resolution, one line per channel (route/airspaces.ts
 * enrouteFreqsByLeg). A leg meeting two channels (SIV SEINE 3 then SEINE 4)
 * prints two lines, and priced at one the card overran its budget. An
 * aerodrome at either end of the route also lists the airspaces its climb
 * or descent crosses below the leg's level (endpointColumns). */

import type { Airport } from '$lib/data/airports';
import { contactRadios } from '$lib/data/airports';
import type { Airspace } from '$lib/data/airspaces';
import { aerodromeRadioLines, ownStationRadios } from '$lib/format/radio';
import type { TerrainSample } from '$lib/map/terrain';
import {
	airspaceCallsAt,
	endpointColumns,
	endpointFreqLines,
	enrouteFreqsByLeg,
	type EnrouteFreqLine,
} from '$lib/route/airspaces';
import { computeNavLog } from '$lib/route/navlog';
import { effectiveCruiseSpeedKt } from './aircraft.svelte';
import { airportByIdent, dataState, getAirspaces } from './data.svelte';
import { freqChangeIdents, resolveAirportRadios } from './freqOverride.svelte';
import { cachedAirspaceSchedule } from './navlogSchedule';
import { routeSettings, type Route, type Waypoint } from './route.svelte';
import { routeTerrainSamples } from './routeTerrain.svelte';
import { resolveScheduleRadios } from './scheduleRadios.svelte';
import { plannedFlightAt } from './timeWindow.svelte';

/** One waypoint's automatic frequency cell. */
export interface WaypointFreqs {
	/** The aerodrome's lines ("TWR / A/A: 118.605"), for an aerodrome
	 *  waypoint while the airport column is on and the field is open. While
	 *  the airspace lines are on too, the field's own stations: an
	 *  approach or FIS unit an airspace over the field publishes is named
	 *  among the airspace lines instead, on each sector's channel. */
	aerodrome: { label: string; freq: string }[];
	/** The airspace lines under the waypoint, while the enroute column is
	 *  on: those of the leg leaving it, after the climb's at an aerodrome
	 *  departure, and the descent's at an aerodrome destination. */
	airspace: EnrouteFreqLine[];
}

/** What the cell is built from. The sheet and the estimator read it from
 *  the session (routeNavlogFreqs); the saved snapshot passes the settings
 *  it was asked to save with. */
export interface NavlogFreqInputs {
	/** The airspace rows, null while they load. */
	airspaces: Airspace[] | null;
	/** The aerodrome an ident names, null while the airports load. */
	airport: ((ident: string) => Airport | null) | null;
	terrain: TerrainSample[] | null | undefined;
	airportFreqs: boolean;
	enrouteFreqs: boolean;
	vfr: boolean;
	defaultAltFt: number;
	cruiseKt: number | null;
}

/** The frequency cell of every waypoint, in route order. Reads the
 *  frequency NOTAMs and the planned flight's span, so call it inside a
 *  $derived to follow them. */
export function navlogFreqs(waypoints: Waypoint[], i: NavlogFreqInputs): WaypointFreqs[] {
	const airspaces = i.enrouteFreqs && waypoints.length >= 2 ? i.airspaces : null;
	const aerodrome = aerodromeCells(waypoints, i, airspaces);
	if (!airspaces) {
		return aerodrome.map((a) => ({ aerodrome: a, airspace: [] }));
	}
	const ifr = !i.vfr;
	const legs = enrouteFreqsByLeg(
		resolveScheduleRadios(
			cachedAirspaceSchedule(waypoints, airspaces, i.cruiseKt, i.defaultAltFt, i.terrain),
			airspaces,
		),
		computeNavLog(waypoints, i.cruiseKt).legs.map((l) => l.cumNM),
		ifr,
	);
	const ends = endpointColumns(waypoints, airspaces, i.defaultAltFt, i.terrain);
	const last = waypoints.length - 1;
	// The block prints coalesced lines ("TWR: 118.105 / 121.405"), each a
	// channel the column must leave to it.
	const channels = (k: number): string[] => aerodrome[k].flatMap((l) => l.freq.split(' / '));
	const climb = endpointFreqLines(resolveScheduleRadios(ends.departure, airspaces), ifr, legs[0], channels(0));
	const descent = endpointFreqLines(
		resolveScheduleRadios(ends.destination, airspaces),
		ifr,
		legs[last - 1],
		channels(last),
	);
	return aerodrome.map((a, k) => ({
		aerodrome: a,
		airspace: k === 0 ? [...climb, ...legs[0]] : k === last ? descent : legs[k],
	}));
}

/** Every waypoint's aerodrome lines, in route order: empty for a waypoint
 *  that is no aerodrome, and for all of them while the airport column is
 *  off or the airports load. With `airspaces`, the airspace lines are on
 *  and an aerodrome keeps its own stations. */
function aerodromeCells(
	waypoints: Waypoint[],
	i: NavlogFreqInputs,
	airspaces: Airspace[] | null,
): { label: string; freq: string }[][] {
	const lookup = i.airportFreqs ? i.airport : null;
	if (!lookup) {
		return waypoints.map(() => []);
	}
	// Over the planned flight, the range the airspace lines read: which
	// frequency to set is a question about the flight, never about the
	// briefing window's unbounded look-ahead.
	const at = plannedFlightAt();
	const moved = freqChangeIdents();
	return waypoints.map((w) => aerodromeLines(w, lookup, at, moved, airspaces));
}

/** An aerodrome waypoint's lines, with any frequency-change NOTAM in force
 *  over the flight applied. `contactRadios` is the gate: a closed field's
 *  published channels are no frequency to set, so the cell stays empty under
 *  it (the waypoint keeps its row, only the radio goes). */
function aerodromeLines(
	w: Waypoint,
	airport: (ident: string) => Airport | null,
	at: ReturnType<typeof plannedFlightAt>,
	moved: ReadonlySet<string>,
	airspaces: Airspace[] | null,
): { label: string; freq: string }[] {
	if (w.kind !== 'airport' || !w.ident) {
		return [];
	}
	const a = airport(w.ident);
	if (!a || contactRadios(a).length === 0) {
		return [];
	}
	const radios = moved.has(a.ident.toUpperCase()) ? resolveAirportRadios(a, at).radios : a.radios;
	return aerodromeRadioLines(airspaces ? ownStationRadios(radios, airspaceCallsAt(a.lat, a.lon, airspaces)) : radios);
}

/** The session's inputs for a route: what the interactive sheet, the print
 *  mounts and the estimator all read. */
function sessionInputs(route: Route): NavlogFreqInputs {
	return {
		airspaces: dataState.airspacesLoaded ? getAirspaces() : null,
		airport: dataState.airportsLoaded ? airportByIdent : null,
		terrain: routeTerrainSamples(route.id, route.waypoints),
		airportFreqs: routeSettings.airportFreqsInNavlog,
		enrouteFreqs: routeSettings.enrouteFreqsInNavlog,
		vfr: routeSettings.vfr,
		defaultAltFt: routeSettings.defaultAltitudeFt,
		cruiseKt: effectiveCruiseSpeedKt(),
	};
}

/** A route's frequency cells under the session's settings. */
export function routeNavlogFreqs(route: Route): WaypointFreqs[] {
	return navlogFreqs(route.waypoints, sessionInputs(route));
}

/** How many lines each waypoint's cell prints, its aerodrome's and its
 *  airspace lines apart: what the kneeboard estimator prices. */
export function routeNavlogLineCounts(route: Route): { aerodrome: number; airspace: number }[] {
	return routeNavlogFreqs(route).map((f) => ({ aerodrome: f.aerodrome.length, airspace: f.airspace.length }));
}
