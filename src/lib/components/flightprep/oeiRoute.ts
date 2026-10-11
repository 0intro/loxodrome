/* The en-route one-engine check over a route as the surfaces show it (the
 * Route tab's leg cue, the nav log's MSA mark and note, the profile's
 * ceiling line): the selected twin's climb table, the trip's take-off mass
 * off the workbook's own chain (shared.ts, so the check and the M&B page
 * read one mass), each leg's air from the forecast (live weather alone,
 * route/oeiCeiling.ts) and its MSA. Reactive: call inside a $derived. A
 * single, or a twin without a climb table, costs nothing: the chain is read
 * only for a sheet the check applies to. */

import { t } from '$lib/state/i18n.svelte';
import { selectedAircraft } from '$lib/state/aircraft.svelte';
import { routes, type Route } from '$lib/state/route.svelte';
import { routeLegAirs } from '$lib/state/routeWind.svelte';
import { isMultiEngine, type OneEngineInoperative } from '$lib/aircraft/schema';
import { orderedTrips } from '$lib/aircraft/trips';
import { fmtIsaDev } from '$lib/weather/openMeteo';
import { fmtAlt } from '$lib/route/format';
import { oeiLegCeilings, oeiLegChecks, shownCeilingFt, type OeiLegCheck } from '$lib/route/oeiCeiling';
import { fuelComputation, tripLoadsComputation } from './shared';

/** The selected aircraft's one-engine data when the check applies: a twin
 *  whose sheet holds the climb table. */
export function oeiCheckable(): OneEngineInoperative | null {
	const a = selectedAircraft();
	return a && isMultiEngine(a) && a.oneEngineInoperative?.climb ? a.oneEngineInoperative : null;
}

/** The mass a route's check assumes. */
export interface OeiRouteMass {
	massKg: number;
	/** 'trip': the take-off mass of the route's trip (an alternate's, the
	 *  trip it diverts from); 'max': that mass unknown, the maximum take-off
	 *  mass (the envelope's top, else the climb table's heaviest). */
	source: 'trip' | 'max';
}

function routeMass(route: Route, oei: OneEngineInoperative): OeiRouteMass {
	const a = selectedAircraft();
	const top = a?.massBalance ? Math.max(...a.massBalance.envelope.map((p) => p.massKg)) : null;
	const max: OeiRouteMass = { massKg: top ?? oei.climb?.massMaxKg ?? 0, source: 'max' };
	const trip = orderedTrips(routes.list).find((tr) => tr.route.id === route.id || tr.alternate?.id === route.id);
	const loads = trip ? tripLoadsComputation(fuelComputation()) : null;
	const k = trip && loads ? loads.tripIndex.indexOf(trip.index) : -1;
	const kg = loads && k >= 0 ? (loads.loads.trips[k]?.mb?.result.takeoff.massKg ?? null) : null;
	return kg === null ? max : { massKg: kg, source: 'trip' };
}

/** A route's check: the mass assumed and every leg's verdict. */
export interface OeiRouteCheck {
	mass: OeiRouteMass;
	legs: (OeiLegCheck | null)[];
}

/** The check over a route, its legs' MSAs given (the nav log's own, or the
 *  shared memo's); null where the check does not apply. */
export function oeiRouteCheck(route: Route, msaFt: readonly (number | null)[]): OeiRouteCheck | null {
	const oei = oeiCheckable();
	if (!oei || route.waypoints.length < 2) {
		return null;
	}
	const mass = routeMass(route, oei);
	return { mass, legs: oeiLegChecks(oei, mass.massKg, msaFt, routeLegAirs(route)) };
}

/** The net ceiling over each leg as the profile draws it, shown (rounded
 *  down to 100 ft), whatever the MSA: the line reads against the MSA line
 *  beside it. Null where the check does not apply. */
export function oeiRouteCeilingsFt(route: Route): (number | null)[] | null {
	const oei = oeiCheckable();
	if (!oei || route.waypoints.length < 2) {
		return null;
	}
	const mass = routeMass(route, oei);
	return oeiLegCeilings(oei, mass.massKg, routeLegAirs(route)).map((c) => (c ? shownCeilingFt(c.altFt) : null));
}

function massText(m: OeiRouteMass): string {
	const kg = Math.round(m.massKg);
	return m.source === 'trip' ? t.route.oeiMassTrip(kg) : t.route.oeiMassMax(kg);
}

/** The air a check was judged in: the forecast's deviation, or ISA. */
function airText(isaDevC: number | null, short: boolean): string {
	if (isaDevC === null) {
		return short ? 'ISA' : t.route.oeiAirIsa;
	}
	return short ? `ISA ${fmtIsaDev(isaDevC)}` : t.route.oeiAirForecast(fmtIsaDev(isaDevC));
}

/** One flagged leg in words: its ceiling, its MSA, the mass and the air. */
export function oeiLegText(c: OeiLegCheck, mass: OeiRouteMass): string {
	const p = {
		ceiling: fmtAlt(shownCeilingFt(c.ceiling.altFt)),
		msa: fmtAlt(c.msaFt),
		basis: `${massText(mass)}, ${airText(c.isaDevC, false)}`,
	};
	return c.ceiling.kind === 'below'
		? t.route.warnOeiNoClimb(p)
		: c.ceiling.kind === 'above'
			? t.route.warnOeiTableTop(p)
			: t.route.warnOei(p);
}

/** The flagged leg that tells the most: one with no net climb at all, else
 *  the lowest ceiling; null when no leg is flagged. */
export function oeiWorstLeg(check: OeiRouteCheck | null): OeiLegCheck | null {
	let worst: OeiLegCheck | null = null;
	for (const c of check?.legs ?? []) {
		if (!c?.below) {
			continue;
		}
		const rank = (x: OeiLegCheck): number => (x.ceiling.kind === 'below' ? -Infinity : x.ceiling.altFt);
		if (worst === null || rank(c) < rank(worst)) {
			worst = c;
		}
	}
	return worst;
}

/** The nav log's note, beside its title on screen and paper: the worst
 *  flagged leg's ceiling, the mass and the air, the marked MSAs pointing at
 *  the legs. */
export function oeiNoteText(check: OeiRouteCheck, worst: OeiLegCheck): string {
	const p = {
		ceiling: fmtAlt(shownCeilingFt(worst.ceiling.altFt)),
		basis: `${Math.round(check.mass.massKg)} kg, ${airText(worst.isaDevC, true)}`,
	};
	return worst.ceiling.kind === 'below'
		? t.navlog.oeiNoteNoClimb(p)
		: worst.ceiling.kind === 'above'
			? t.navlog.oeiNoteTableTop(p)
			: t.navlog.oeiNote(p);
}

/** The note's tip: what the mark means and the mass it assumed. */
export function oeiNoteTip(check: OeiRouteCheck): string {
	return t.navlog.oeiNoteTip(massText(check.mass));
}
