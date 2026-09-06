/* Reactive accessor for the effective transition altitude.
 *
 * Bridges the pure derivation (route/airspaces.ts derivedTransitionAltFt)
 * into the display surfaces without an import cycle (the notamCorridor
 * pattern): this module reads the route + dataset state; RouteTab,
 * NavLogSheet, RouteProfileModal, WeatherTab and the flight-prep print call
 * the accessors inside their $derived contexts. Memoised per the
 * state/memoSelector.ts contract, so the FIR point tests rerun only when an
 * input actually changed (the accessors are called per leg row). */

import { derivedTransitionAltFt, type DerivedTransitionAlt } from '$lib/route/airspaces';
import { airportByIdent, dataState, getAirspaces } from './data.svelte';
import { memoised } from './memoSelector';
import { routes, routeSettings } from './route.svelte';

const memo = memoised(
	() => {
		// Reading every waypoint's anchor + position both tracks route edits
		// and keys the memo; airportByIdent's index is non-reactive, so the
		// load flag stands in for the dataset (getAirspaces tracks its own).
		getAirspaces();
		return (
			`${dataState.airportsLoaded}|${dataState.airspacesLoaded}|` +
			routes.list
				.map((r) =>
					r.waypoints.map((w) => `${w.kind}:${w.refId ?? ''}:${w.lat},${w.lon}`).join(';'),
				)
				.join('#')
		);
	},
	() =>
		derivedTransitionAltFt(
			routes.list.map((r) => r.waypoints),
			(refId) => airportByIdent(refId)?.transitionAltFt ?? null,
			getAirspaces(),
		),
);

/** The automatic transition altitude: the lowest AIP TA among the aerodromes
 *  any route touches, else the containing FIRs' blanket value, else 5000 ft.
 *  Read-only: it never triggers a dataset load (airports load by default and
 *  RouteTab already ensures airspaces), it only sharpens once one lands. */
export function autoTransitionAlt(): DerivedTransitionAlt {
	return memo();
}

/** The transition altitude every display surface uses: the manual override
 *  when set (routeSettings.transitionAltitudeFt), else the automatic value.
 *  While overridden the derivation never runs (and its inputs go untracked);
 *  clearing the override re-subscribes callers through the ?? branch. */
export function effectiveTransitionAltFt(): number {
	return routeSettings.transitionAltitudeFt ?? autoTransitionAlt().valueFt;
}
