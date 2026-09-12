/* The meteo annex's TEMSI / WINTEM prefetch recipe, shared by the dossier
 * pack print (FlightPrepModal.printPack) and the Weather tab's standalone
 * briefing print (WxPrintHost): the flight window off the dossier timeline
 * (falling back to the printed winds' own departure anchor + 2 h, so charts
 * and forecast winds agree on when the flight happens), the zones off the
 * French-FIR presence of the printed routes, the WINTEM altitude range off
 * their planned legs, and the catalogs through the state cache's single
 * SOFIA pacing authority. Callers gate on display.liveWeather and await the
 * airspace ensure first (a missing dataset degrades the zone pick to
 * FRANCE). Reads reactive state; never rejects. */

import { fuelComputation, mbComputation, dossierComputation } from './shared';
import { computeDossierTimeline, parseClock, timelineWindowMin } from '$lib/aircraft/dossier';
import { dossierFlightDate, flightPrep } from '$lib/state/flightPrep.svelte';
import { firstDepartureMs } from '$lib/state/routeWind.svelte';
import { frenchFirPresence } from '$lib/route/airspaces';
import { getAirspaces } from '$lib/state/data.svelte';
import { routeSettings, type Route } from '$lib/state/route.svelte';
import { proxyBase } from '$lib/autorouter/state.svelte';
import { sofiaChartsFor } from '$lib/state/sofiaCharts.svelte';
import {
	altRange,
	chartZones,
	fetchTripCharts,
	type TripChartsDoc,
} from '$lib/weather/tripCharts';

/** Fallback window length when the dossier timeline can't resolve. */
const DEFAULT_WINDOW_MIN = 120;

/** The flight window for chart selection: the dossier timeline (ETD plus
 *  with-wind arrivals, alternates included) when it resolves, else the
 *  departure anchor + 2 h. */
export function chartWindowMs(): { startMs: number; endMs: number } {
	const departureMin = parseClock(flightPrep.dossier.departureTime ?? '');
	if (departureMin != null) {
		const fuel = fuelComputation();
		const dossier = dossierComputation(fuel, mbComputation(fuel));
		if (dossier.trips.length > 0) {
			const win = timelineWindowMin(
				computeDossierTimeline(dossier.trips, {
					departureMin,
					fuelOnBoardMin: dossier.fuelOnBoardMin,
					finalReserveMin: dossier.finalReserveMin,
				}),
			);
			if (win) {
				const base = Date.parse(dossierFlightDate() + 'T00:00:00Z');
				return { startMs: base + win.startMin * 60_000, endMs: base + win.endMin * 60_000 };
			}
		}
	}
	const dep = firstDepartureMs();
	return { startMs: dep, endMs: dep + DEFAULT_WINDOW_MIN * 60_000 };
}

/** Fetch and rasterize the charts relevant to the printed routes' flight.
 *  `signal` stops the per-chart download loop (the catalog fetch itself is
 *  never aborted: sofiaChartsFor is the single SOFIA pacing authority);
 *  `onProgress` relays the download counter + current chart token. */
export async function fetchChartsForPrint(
	printableRoutes: Route[],
	opts: {
		signal?: AbortSignal;
		onProgress?: (done: number, total: number, current: string | null) => void;
	} = {},
): Promise<TripChartsDoc> {
	const { startMs, endMs } = chartWindowMs();
	const wpsList = printableRoutes.map((r) => r.waypoints);
	const zones = chartZones(frenchFirPresence(wpsList, getAirspaces()), wpsList);
	const range = altRange(
		printableRoutes.map((r) =>
			r.waypoints
				.slice(0, -1)
				.map((w) => (Number.isFinite(w.alt) ? w.alt : routeSettings.defaultAltitudeFt)),
		),
	);
	const entries = await sofiaChartsFor(zones);
	if (opts.signal?.aborted) {
		return { fetchedAtMs: Date.now(), entries: [], notes: [], failedCount: 0, catalogError: false };
	}
	return fetchTripCharts({
		proxyBase: proxyBase(),
		catalogs: zones.map((zone) => {
			const e = entries[zone];
			return { zone, charts: e && e.status === 'ok' ? [...e.temsi, ...e.wintem] : null };
		}),
		windowStartMs: startMs,
		windowEndMs: endMs,
		altRangeFt: range,
		...(opts.signal ? { signal: opts.signal } : {}),
		...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
	});
}
