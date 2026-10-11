/* What each trip's legs fly with: the Overview's weather box states it, the
 * fuel page states what its wind allowance was computed with. The plan's
 * wind source decides (the Route tab's Forecast | Manual switch); each leg's
 * own wind (its W/V chip) counts beside it. Data only: each page words it
 * from its catalog (docs/i18n.md). */

import { display } from '$lib/state/display.svelte';
import { routeSettings, type Route } from '$lib/state/route.svelte';
import {
	effectiveRouteWinds,
	routeForecastMissedLegs,
	routeForecastSource,
	routeWindEteMin,
} from '$lib/state/routeWind.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';
import type { WindVec } from '$lib/route/legWind';
import type { FuelComputation } from './shared';

export type WindBasis =
	/** The forecast flies the legs: where it comes from (null while nothing
	 *  is held), the legs it misses (numbered from 1) and the manual wind
	 *  they fly instead, if one is typed. */
	| {
			kind: 'forecast';
			source: string | null;
			missed: number[];
			missedWind: WindVec | null;
			legs: number;
			overrides: number;
	  }
	/** The plan's manual wind flies every leg. `forecastDeltaMin` is what
	 *  the Forecast source would change on the trip's time (+ longer), null
	 *  while no leg would fly a forecast wind. */
	| { kind: 'manual'; wind: WindVec; forecastDeltaMin: number | null; legs: number; overrides: number }
	/** No wind at all: still air (a Manual source with nothing typed, or a
	 *  forecast that serves no leg with no manual wind for them). */
	| { kind: 'none'; legs: number; overrides: number };

function planWind(): WindVec | null {
	return routeSettings.windDirDeg != null && routeSettings.windSpeedKt != null
		? { dirDeg: routeSettings.windDirDeg, speedKt: routeSettings.windSpeedKt }
		: null;
}

/** One route's basis. Tracked: call it inside a $derived. */
export function routeWindBasis(route: Route): WindBasis {
	const winds = effectiveRouteWinds(route);
	const legs = winds.length;
	const overrides = winds.filter((w) => w?.source === 'override').length;
	const wind = planWind();
	if (display.liveWeather && windAloft.useForecastForLegs) {
		const missed = routeForecastMissedLegs(route);
		// Served nowhere, and nothing typed to fly instead: still air.
		if (legs > 0 && missed.length === legs && wind === null) {
			return { kind: 'none', legs, overrides };
		}
		return {
			kind: 'forecast',
			source: routeForecastSource(route),
			missed,
			missedWind: missed.length > 0 ? wind : null,
			legs,
			overrides,
		};
	}
	if (wind === null) {
		return { kind: 'none', legs, overrides };
	}
	let forecastDeltaMin: number | null = null;
	if (display.liveWeather && effectiveRouteWinds(route, { source: 'forecast' }).some((w) => w?.source === 'forecast')) {
		const now = routeWindEteMin(route);
		const forecast = routeWindEteMin(route, { source: 'forecast' });
		forecastDeltaMin = now !== null && forecast !== null ? forecast - now : null;
	}
	return { kind: 'manual', wind, forecastDeltaMin, legs, overrides };
}

/** The trips' bases in the fuel plan's order, each with its route's
 *  endpoints; trips without a flyable leg are left out. Tracked. */
export function tripWindBases(fuel: FuelComputation): { route: Route; basis: WindBasis }[] {
	return fuel.columns
		.filter((c) => c.trip.route.waypoints.length >= 2)
		.map((c) => ({ route: c.trip.route, basis: routeWindBasis(c.trip.route) }));
}
