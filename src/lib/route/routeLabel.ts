/* Tab label for a drawn route: the custom name if the user set one, otherwise the
 * first -> last waypoint labels, otherwise a single waypoint or the caller's
 * placeholder (t.route.newRoute; a parameter keeps this module locale-free).
 * Pure; reuses waypointLabel so labels read the same as the nav log. */

import { waypointLabel } from './navlog';
import { fileToken } from '$lib/files/fileName';
import type { Waypoint } from '$lib/state/route.svelte';

export function routeEndpointLabel(
	route: { name: string | null; waypoints: Waypoint[] },
	emptyLabel: string,
): string {
	if (route.name && route.name.trim() !== '') {
		return route.name;
	}
	const wps = route.waypoints;
	if (wps.length >= 2) {
		return `${waypointLabel(wps[0])} → ${waypointLabel(wps[wps.length - 1])}`;
	}
	if (wps.length === 1) {
		return waypointLabel(wps[0]);
	}
	return emptyLabel;
}

/* Title of a printed nav-log / schedule card, shared by the kneeboard and
 * dossier packs and by the print-prep measuring mount (whose measured
 * header must be the printed one): always the first -> last waypoint
 * labels; a custom route name stays the switcher's label
 * (routeEndpointLabel above). Callers print routes with >= 2 waypoints;
 * an empty route degrades to its name. */
export function routeTitle(route: { name: string | null; waypoints: Waypoint[] }): string {
	const wps = route.waypoints;
	if (wps.length === 0) {
		return route.name ?? '';
	}
	return `${waypointLabel(wps[0])} → ${waypointLabel(wps[wps.length - 1])}`;
}

/* The whole plan as ONE filename field: the SUBJECT of every file a plan
 * produces (files/fileName.ts, docs/file-names.md). It chains every trip's
 * aerodrome chain (the airport waypoints' idents in order) across all
 * non-alternate routes, collapsing the airport shared between consecutive
 * legs: three legs LFPL-LFPU, LFPU-LFGO, LFGO-LFPL give
 * "LFPL-LFPU-LFGO-LFPL". Alternates are excluded. Falls back to the first
 * trip's endpoint labels when no trip names an airport, and to '' when
 * nothing usable remains: an EMPTY field, which the grammar then omits, so a
 * nameless plan saves as "plan.yaml" rather than "routes_plan.yaml". Pure;
 * reuses waypointLabel so the fallback reads like the nav log. */
export function routesFileBaseName(
	list: readonly { waypoints: Waypoint[]; alternate?: boolean | undefined }[],
): string {
	const trips = list.filter((r) => !r.alternate);
	const chain: string[] = [];
	for (const trip of trips) {
		for (const ident of airportIdents(trip.waypoints)) {
			// Drop a repeat of the previous airport, so the arrival of one leg and the
			// departure of the next collapse to a single junction (a genuine
			// there-and-back like LFGO-LFPL after LFPL-... still prints both).
			if (chain[chain.length - 1] !== ident) {
				chain.push(ident);
			}
		}
	}
	let tokens = chain;
	if (tokens.length === 0 && trips.length > 0) {
		tokens = endpointTokens(trips[0].waypoints);
	}
	return fileToken(tokens.join('-'));
}

/** The SUBJECT field of a file the PLAN itself produces (docs/file-names.md):
 *  the plan's own descriptive name when it has one, else the aerodrome chain.
 *  A name the user typed is theirs and nothing else can restate it, which is
 *  the reason the grammar already gives for an imported trace keeping its own
 *  name. The chain stays the answer for an unnamed plan, for a name that folds
 *  to nothing (fileToken keeps ASCII alone), and for every PRINTED document,
 *  whose subject is the flight rather than its caption. */
export function planFileSubject(
	planName: string | null | undefined,
	list: readonly { waypoints: Waypoint[]; alternate?: boolean | undefined }[],
): string {
	const named = planName ? fileToken(planName) : '';
	return named !== '' ? named : routesFileBaseName(list);
}

/** The airport waypoints' idents in order (a trip's aerodrome chain). */
function airportIdents(wps: Waypoint[]): string[] {
	return wps.filter((w) => w.kind === 'airport' && w.ident).map((w) => w.ident ?? '');
}

/** First/last waypoint labels (or the lone one), for a trip naming no airport. */
function endpointTokens(wps: Waypoint[]): string[] {
	if (wps.length >= 2) {
		return [waypointLabel(wps[0]), waypointLabel(wps[wps.length - 1])];
	}
	if (wps.length === 1) {
		return [waypointLabel(wps[0])];
	}
	return [];
}
