/* Build the saved-only nav-log snapshot for each route at Save time, reusing the
 * exact computations the on-screen nav log uses so the file matches the modal:
 * magnetic course (Rm) and wind-corrected heading (Cm), leg / remaining distance,
 * ETE (wind-corrected when a wind is set), per-leg safety altitude, per-waypoint
 * frequencies, and the controlling Class A floor ("Classe A 1500"). These are
 * written for a readable document and ignored on load. */

import { computeNavLog } from '$lib/route/navlog';
import { legMagneticTrackDeg, decimalYearFromDate } from '$lib/route/magnetic';
import { windTriangle } from '$lib/route/wind';
import { computeMinAltitudes } from '$lib/route/minAltitude';
import {
	classAFloorAt,
	classACeilingLabel,
	computeAirspaceSchedule,
	enrouteFreqsByLeg,
	type EnrouteFreqLine,
} from '$lib/route/airspaces';
import { coalesceRadioLines } from '$lib/format/radio';
import { fmtWind } from '$lib/route/format';
import { legTasKt } from '$lib/route/legWind';
import { resolveAirportRadios, resolveScheduleRadios } from '$lib/state/freqOverride.svelte';
import { routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
import { effectiveRouteWinds, ensureRouteWindFor } from '$lib/state/routeWind.svelte';
import { windAloft } from '$lib/state/windAloft.svelte';
import { ON_FIELD_VOR_RADIUS_NM, isVor, nearestVor, waypointRadialEntries } from '$lib/route/radial';
import {
	ensureAirports,
	ensureAirspaces,
	ensureNavaids,
	ensureObstacles,
	getAirports,
	getAirspaces,
	getNavaids,
	navaidById,
} from '$lib/state/data.svelte';
import type { Route, Waypoint } from '$lib/state/route.svelte';
import { contactRadios, type Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import type { LegNavlog, RouteForSave, WaypointInfo } from '$lib/route/yaml';

/** Multi-line airport frequency block ("TWR / A/A : 118.605"), or the navaid's
 *  frequency label, for a waypoint; undefined when there is nothing to show. */
function frequenciesFor(w: Waypoint, airportByIdent: Map<string, Airport>): string | undefined {
	if (w.kind === 'airport' && w.ident) {
		const ap = airportByIdent.get(w.ident.toUpperCase());
		// contactRadios is the gate the on-screen column applies, so a closed
		// field's channels stay out of the saved snapshot the same way.
		if (ap && contactRadios(ap).length > 0) {
			// Apply any active frequency-change NOTAM so the saved doc reports the
			// same current value as the on-screen nav log.
			const radios = resolveAirportRadios(ap).radios;
			if (radios.length > 0) {
				return coalesceRadioLines(radios)
					.map((e) => `${e.label} : ${e.freq}`)
					.join('\n');
			}
		}
	}
	if (w.kind === 'navaid' && w.freq) {
		return w.freq;
	}
	return undefined;
}

/** The waypoint's saved frequency block: the airport / navaid lines first, then the
 *  enroute lines for the leg leaving this waypoint (each "LABEL: freq"), newline-
 *  joined - the user's "airport, newline, enroute". Undefined when both are empty. */
function combineFreqs(
	airport: string | undefined,
	enroute: EnrouteFreqLine[] | undefined,
): string | undefined {
	const lines: string[] = [];
	if (airport) {
		lines.push(airport);
	}
	// A line whose frequency a service-closure NOTAM withdrew is skipped: the
	// snapshot is "the value to use", and the working substitute (the FIC
	// underneath) is already its own line. The DISPLAY keeps closed lines,
	// struck.
	for (const e of enroute ?? []) {
		if (!e.closed) {
			lines.push(`${e.label}: ${e.freq}`);
		}
	}
	return lines.length > 0 ? lines.join('\n') : undefined;
}

/** "Classe A <floor>" for the upper Class A over the waypoint (the VFR ceiling),
 *  VFR only, else undefined. Matches the nav-log notes banner exactly. */
function airspaceFor(w: Waypoint, airspaces: ReturnType<typeof getAirspaces>, vfr: boolean): string | undefined {
	if (!vfr || !airspaces) {
		return undefined;
	}
	const floor = classAFloorAt(w.lat, w.lon, airspaces);
	return floor != null ? classACeilingLabel(floor) : undefined;
}

/** The VOR a waypoint is (its own navaid) or sits on field of (a VOR within
 *  ON_FIELD_VOR_RADIUS_NM, for an airport); null otherwise. */
function vorForWaypoint(w: Waypoint, vors: readonly Navaid[]): Navaid | null {
	if (w.kind === 'navaid' && w.refId) {
		const n = navaidById(w.refId);
		return n && isVor(n.type) ? n : null;
	}
	if (w.kind === 'airport') {
		return nearestVor(w.lat, w.lon, vors, ON_FIELD_VOR_RADIUS_NM);
	}
	return null;
}

/** The VOR radial line(s) for the leg leaving waypoint `w` (QDR from its own VOR,
 *  QDM to the next waypoint's VOR), joined for the saved doc; undefined when
 *  none. Mirrors the nav-log notes banner (see $lib/route/radial). */
function radialFor(
	w: Waypoint,
	ownVor: Navaid | null,
	nextWp: Waypoint | null,
	nextVor: Navaid | null,
	year: number,
): string | undefined {
	const entries = waypointRadialEntries(w, ownVor, nextWp, nextVor, year);
	if (entries.length === 0) {
		return undefined;
	}
	return entries.map((e) => `${e.stationLine} ${e.bearingLine}`).join(' / ');
}

/** Assemble the per-route saved nav-log. Loads the datasets it needs (airports
 *  for frequencies, airspaces for the Class A floor, obstacles + terrain for the
 *  safety altitude); the terrain fetch is best-effort (a failure just omits the
 *  safety altitudes). Returns the routes shaped for buildRoutesDoc. */
export async function buildSaveRoutes(
	routes: Route[],
	settings: {
		cruiseSpeedKt: number | null;
		// No wind fields here: the per-leg wind comes from the shared
		// effectiveRouteWinds resolver (override -> forecast -> the global
		// routeSettings wind), never from this parameter.
		vfr: boolean;
		defaultAltitudeFt: number;
		airportFreqsInNavlog: boolean;
		enrouteFreqsInNavlog: boolean;
		vorRadialsInNavlog: boolean;
		minAltCorridorRadiusNM: number;
	},
): Promise<RouteForSave[]> {
	await Promise.all([ensureAirports(), ensureAirspaces(), ensureNavaids()]);
	let obstacles: Awaited<ReturnType<typeof ensureObstacles>>;
	try {
		obstacles = await ensureObstacles();
	} catch {
		obstacles = [];
	}
	const airports = getAirports();
	const airspaces = getAirspaces();
	const vors = (getNavaids() ?? []).filter((n) => isVor(n.type));
	const year = decimalYearFromDate(new Date());

	const airportByIdent = new Map<string, Airport>();
	for (const a of airports ?? []) {
		airportByIdent.set(a.ident.toUpperCase(), a);
	}

	const {
		cruiseSpeedKt,
		vfr,
		defaultAltitudeFt,
		airportFreqsInNavlog,
		enrouteFreqsInNavlog,
		vorRadialsInNavlog,
		minAltCorridorRadiusNM,
	} = settings;
	const out: RouteForSave[] = [];
	for (const r of routes) {
		const wps = r.waypoints;
		const nav = computeNavLog(wps, cruiseSpeedKt);
		// Per-leg effective winds through the shared resolver (awaiting the
		// forecast warm), so the saved snapshot matches the on-screen modal.
		await ensureRouteWindFor(r);
		const ews = effectiveRouteWinds(r);

		// Per-leg safety altitude (async terrain + obstacle scan); best-effort.
		let mins: (number | null)[] = [];
		if (wps.length >= 2) {
			try {
				mins = await computeMinAltitudes(
					wps.map((w) => ({ lat: w.lat, lon: w.lon })),
					obstacles,
					{ halfWidthNM: minAltCorridorRadiusNM, vfr },
				);
			} catch {
				mins = [];
			}
		}

		const legs: LegNavlog[] = nav.legs.map((leg, i) => {
			const a = wps[i];
			const b = wps[i + 1];
			const ew = ews[i] ?? null;
			const tas =
				cruiseSpeedKt != null && cruiseSpeedKt > 0
					? legTasKt(cruiseSpeedKt, ew?.forecast?.tempC ?? null, a.alt, windAloft.tempTas)
					: null;
			const wind = tas != null && ew ? windTriangle(leg.trackTrueDeg, tas, ew.dirDeg, ew.speedKt) : null;
			const ete = wind ? (leg.legNM / wind.gsKt) * 60 : leg.eteMin;
			return {
				course: legMagneticTrackDeg(leg.trackTrueDeg, a, b, year),
				heading: wind
					? legMagneticTrackDeg(leg.trackTrueDeg + wind.wcaDeg, a, b, year)
					: undefined,
				distance: leg.legNM,
				// Remaining to destination, measured from this leg's start waypoint.
				distanceRemaining: nav.totalNM - (leg.cumNM - leg.legNM),
				safetyAltitude: mins[i] ?? null,
				ete: ete ?? undefined,
				wind: ew ? fmtWind(ew.dirDeg, ew.speedKt) : undefined,
			};
		});

		// Per-leg enroute contact frequencies (opt-in), built exactly as the modal:
		// the airspace schedule with any frequency-change NOTAM applied and narrowed
		// to the RAI, via the shared resolveScheduleRadios, grouped by leg.
		let enrouteByLeg: EnrouteFreqLine[][] = [];
		if (enrouteFreqsInNavlog && airspaces) {
			// Whatever the shared terrain cache holds at save time (null falls
			// back to the conservative AGL endpoints); saved YAML fields are
			// unchanged either way.
			const schedule = computeAirspaceSchedule(
				wps,
				airspaces,
				cruiseSpeedKt,
				defaultAltitudeFt,
				routeTerrainSamples(r.id, wps),
			);
			const resolved = resolveScheduleRadios(schedule, airspaces);
			enrouteByLeg = enrouteFreqsByLeg(
				resolved,
				nav.legs.map((l) => l.cumNM),
				!vfr,
			);
		}

		const vorOf = wps.map((w) => vorForWaypoint(w, vors));
		const info: WaypointInfo[] = wps.map((w, i) => ({
			// Manual frequencies replace the automatic block: the snapshot is the
			// effective text the nav-log cell shows (frequencies_manual reads back).
			frequencies:
				w.freqsManual ??
				combineFreqs(
					airportFreqsInNavlog ? frequenciesFor(w, airportByIdent) : undefined,
					enrouteByLeg[i],
				),
			airspace: airspaceFor(w, airspaces, vfr),
			radial: vorRadialsInNavlog
				? radialFor(w, vorOf[i], wps[i + 1] ?? null, vorOf[i + 1] ?? null, year)
				: undefined,
		}));

		out.push({ name: r.name, waypoints: wps, legs, info, alternate: r.alternate });
	}
	return out;
}
