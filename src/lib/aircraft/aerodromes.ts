/* Trip-chain aerodrome helpers: which aerodromes a flight touches (trip
 * endpoints + alternates' destinations, deduped; the performance page's
 * ident list and the printed dossier's weather stops) and each airport's
 * runway ENDS (QFU) with their per-direction declared distances. "Grass"
 * follows the workbook's "piste herbe = non revêtue": any non-hard surface
 * gets the grass factor. */

import type { Airport, Runway } from '$lib/data/airports';
import { isHardSurface } from '$lib/map/airportSymbols';
import { declaredDistancesM, type DeclaredDistancesM } from './performance';
import type { Trip } from './trips';

/** The waypoint slice this module needs (Route.waypoints fits). */
export interface WaypointForPerf {
	kind: string;
	ident?: string | undefined;
}

export interface RouteForPerf {
	waypoints: WaypointForPerf[];
}

function airportWaypoints<W extends WaypointForPerf>(wps: readonly W[]): W[] {
	return wps.filter((w) => w.kind === 'airport' && w.ident);
}

function airportIdents(wps: readonly WaypointForPerf[]): string[] {
	return airportWaypoints(wps).map((w) => w.ident!);
}

/** The performance page's aerodrome list: each trip's departure + arrival,
 *  each alternate's destination, then the manual adds; deduped in first-seen
 *  order (a round trip's return = the departure, as in the workbook). */
export function perfIcaos(
	trips: readonly Trip<RouteForPerf>[],
	manualIcaos: readonly string[],
): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (icao: string): void => {
		if (!seen.has(icao)) {
			seen.add(icao);
			out.push(icao);
		}
	};
	for (const t of trips) {
		const idents = airportIdents(t.route.waypoints);
		if (idents.length > 0) {
			push(idents[0]);
			push(idents[idents.length - 1]);
		}
		if (t.alternate) {
			const alt = airportIdents(t.alternate.waypoints);
			if (alt.length > 0) {
				push(alt[alt.length - 1]);
			}
		}
	}
	for (const icao of manualIcaos) {
		push(icao);
	}
	return out;
}

/** The waypoint slice the weather stop list needs (Route.waypoints fits:
 *  airport waypoints copy their anchor's position at snap time). */
export interface WaypointForWx extends WaypointForPerf {
	lat: number;
	lon: number;
}

export interface RouteForWx {
	waypoints: WaypointForWx[];
}

/** One trip-chain aerodrome with its position, for the nearest-station
 *  weather lookup. */
export interface TripWxStop {
	icao: string;
	lat: number;
	lon: number;
}

/** The printed dossier's weather-sheet aerodromes: perfIcaos' walk (each
 *  trip's departure + arrival, each alternate's destination), then the
 *  orphan alternates' destinations (the dossier prints their cards too),
 *  deduped in first-seen order. Coordinates come from the contributing
 *  waypoint itself, so no dataset lookup is needed. */
export function tripWxStops(
	trips: readonly Trip<RouteForWx>[],
	orphans: readonly RouteForWx[],
): TripWxStop[] {
	const out: TripWxStop[] = [];
	const seen = new Set<string>();
	const push = (w: WaypointForWx): void => {
		const icao = w.ident!;
		if (!seen.has(icao)) {
			seen.add(icao);
			out.push({ icao, lat: w.lat, lon: w.lon });
		}
	};
	for (const t of trips) {
		const wps = airportWaypoints(t.route.waypoints);
		if (wps.length > 0) {
			push(wps[0]);
			push(wps[wps.length - 1]);
		}
		if (t.alternate) {
			const alt = airportWaypoints(t.alternate.waypoints);
			if (alt.length > 0) {
				push(alt[alt.length - 1]);
			}
		}
	}
	for (const o of orphans) {
		const alt = airportWaypoints(o.waypoints);
		if (alt.length > 0) {
			push(alt[alt.length - 1]);
		}
	}
	return out;
}

/** The performance grid's aerodromes as weather stops: perfIcaos' idents with
 *  a position each, so the print prefetch can fetch their nearest observation
 *  in the same pass as the printed annex. Unlike tripWxStops the position
 *  cannot come from a waypoint (a manually added ICAO has none), so the caller
 *  injects the dataset lookup; an ident the dataset does not know is dropped,
 *  its column having no elevation to compute with either. */
export function perfWxStops(
	icaos: readonly string[],
	pos: (icao: string) => { lat: number; lon: number } | null,
): TripWxStop[] {
	const out: TripWxStop[] = [];
	for (const icao of icaos) {
		const p = pos(icao);
		if (p) {
			out.push({ icao, lat: p.lat, lon: p.lon });
		}
	}
	return out;
}

export interface RunwayEnd {
	/** The QFU designator, e.g. '08L'. */
	id: string;
	runway: Runway;
	end: 'le' | 'he';
	surface: string;
	/** Non-hard surface (the workbook's "piste herbe"). */
	grass: boolean;
	distances: DeclaredDistancesM;
	/** Physical length, metres (null when unknown). */
	lengthM: number | null;
}

/** Both ends of every runway, in dataset order (le then he). */
export function runwayEnds(airport: Airport): RunwayEnd[] {
	const out: RunwayEnd[] = [];
	for (const r of airport.runways) {
		for (const end of ['le', 'he'] as const) {
			const id = end === 'le' ? r.le : r.he;
			if (!id) {
				continue;
			}
			out.push({
				id,
				runway: r,
				end,
				surface: r.surface,
				grass: !isHardSurface(r.surface),
				distances: declaredDistancesM(r, end),
				lengthM: r.lengthFt == null ? null : r.lengthFt * 0.3048,
			});
		}
	}
	return out;
}

/** A runway end weighed for the default-runway choice. */
export interface RunwayPick<E> {
	end: E;
	/** Non-hard surface (the workbook's "piste herbe"). */
	grass: boolean;
	/** Signed headwind along the end, kt (negative = tailwind). */
	headwindKt: number;
	/** Long enough for the phase (the runway verdict is not limiting). */
	longEnough: boolean;
}

/** The default runway end: the long-enough paved runway most into wind, then
 *  long-enough grass, then the least-bad; ties go to the earliest end (dataset
 *  order = the main runway as listed). Returns null for an empty list. With no
 *  wind every headwind is 0, so the rule collapses to tier then dataset order,
 *  i.e. the first long-enough paved runway. */
export function bestRunwayEnd<E>(picks: readonly RunwayPick<E>[]): E | null {
	// Tier (lower is better): long-enough paved < long-enough grass <
	// too-short paved < too-short grass. One key encodes both "long enough"
	// and "paved wins, grass only when no paved is long enough".
	const tier = (p: RunwayPick<E>): number => (p.longEnough ? 0 : 2) + (p.grass ? 1 : 0);
	let best: RunwayPick<E> | null = null;
	for (const p of picks) {
		// Replace only on a strict improvement, so the earliest end wins ties
		// (dataset order, the main runway).
		if (best === null || tier(p) < tier(best) || (tier(p) === tier(best) && p.headwindKt > best.headwindKt)) {
			best = p;
		}
	}
	return best === null ? null : best.end;
}
