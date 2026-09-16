/* The overflown aerodrome, resolved from the POSE: navigation mode's one
 * position-based answer (everything else projects onto the planned route;
 * docs/nav-live.md). The nearest open field with a usable published frequency
 * within OVERFLIGHT_RADIUS_NM of the aircraft, served as a contact unit for
 * the in-flight strip, with a route, without one, and in replay alike. The
 * flown route's departure and destination are excluded: the contact chain
 * already brackets the flight with those two fields, and repeating the
 * departure on the apron or the destination on arrival would say nothing.
 * Reads reactive state (call inside $derived / $effect); the gates run first
 * so everything stays untracked while the checkbox is off, and the selection
 * itself is pure per pose (nav/overflight.ts), so scrubbing is deterministic. */

import { navStrip } from './navStrip.svelte';
import { currentPose } from './navRecording.svelte';
import { dataState, getAirports } from './data.svelte';
import { activeRoute, routes } from './route.svelte';
import { navRouteId } from './navRoute.svelte';
import { airportContactUnit } from './navLive.svelte';
import type { NavContactUnit } from '$lib/nav/contactChain';
import { nearestOverflown, overflightCandidates, OVERFLIGHT_RADIUS_NM } from '$lib/nav/overflight';
import type { Airport } from '$lib/data/airports';

export interface OverflightInfo {
	/** The field as a contact unit (effective radios, ident, flag state): the
	 *  strip renders it with the same cell as the chain's units. */
	unit: NavContactUnit;
	/** Lateral distance from the aircraft to the field (NM). */
	distNM: number;
}

/** Candidates memo, keyed on the airports array ref (assigned once per
 *  session): the merged dataset shrinks once to the fields with a usable
 *  frequency, and the per-pose scan reads the short list. */
let candidatesMemo: { airports: readonly Airport[]; candidates: Airport[] } | null = null;

function candidatesFor(airports: Airport[]): Airport[] {
	if (!candidatesMemo || candidatesMemo.airports !== airports) {
		candidatesMemo = { airports, candidates: overflightCandidates(airports) };
	}
	return candidatesMemo.candidates;
}

const NO_IDENTS: ReadonlySet<string> = new Set();

/** The flown route's endpoint idents, upper-cased. Static on purpose (the
 *  route's own first and last airport waypoints, not the chain's live units):
 *  the chain hands the departure over at 3 NM, and keying on that would pop
 *  the just-departed field straight back into the cell; and the chain waits
 *  for the airspace dataset, which the overflight answer does not. Only a
 *  flyable route excludes anything, exactly when the chain exists to
 *  duplicate. The route resolution is the navLiveFor guard, so a dangling
 *  flown id falls back to the active route with it. */
function excludedIdents(): ReadonlySet<string> {
	const route = routes.list.find((r) => r.id === navRouteId()) ?? activeRoute();
	const wps = route.waypoints;
	if (wps.length < 2) {
		return NO_IDENTS;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- built and returned per call, never mutated after
	const out = new Set<string>();
	for (const wp of [wps[0], wps[wps.length - 1]]) {
		if (wp.kind === 'airport' && wp.ident) {
			out.add(wp.ident.toUpperCase());
		}
	}
	return out;
}

/** The overflown aerodrome at the current pose, or null: checkbox off, no
 *  pose, dataset not loaded, nothing within radius, or a nearest field whose
 *  effective radios lost their last usable frequency. */
export function overflownAirport(): OverflightInfo | null {
	if (!navStrip.overflight || !dataState.airportsLoaded) {
		return null;
	}
	const pose = currentPose();
	const airports = pose ? getAirports() : null;
	if (!pose || !airports) {
		return null;
	}
	const hit = nearestOverflown(
		candidatesFor(airports),
		pose.lat,
		pose.lon,
		OVERFLIGHT_RADIUS_NM,
		excludedIdents(),
	);
	if (!hit) {
		return null;
	}
	const unit = airportContactUnit(hit.airport);
	return unit ? { unit, distNM: hit.distNM } : null;
}
