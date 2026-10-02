/* Trip-chain aerodrome helpers: which aerodromes a flight touches (trip
 * endpoints + alternates' destinations, deduped; the performance page's
 * ident list and the printed dossier's weather stops) and each airport's
 * runway ENDS (QFU) with their per-direction declared distances. "Grass"
 * follows the workbook's "piste herbe = non revêtue": any runway not KNOWN to
 * be paved gets the grass factor, a mixed or unreadable surface included
 * (classifySurface, data/runwaySurface.ts). */

import type { Airport, Runway } from '$lib/data/airports';
import { occurrenceKeys } from '$lib/data/dedup';
import { classifySurface, type SurfaceClass } from '$lib/data/runwaySurface';
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
	/** The QFU designator, e.g. '08L': what a NOTAM names, so what closures and
	 *  declared-distance overrides match on. */
	id: string;
	/** The end's identity at its aerodrome: the designator, and where two
	 *  runways carry it (LIAF's glider strip 17/35GLD beside its 17/35) the
	 *  designator AT its runway, `17@17/35GLD`, which a dataset release
	 *  reordering the runways cannot move; an occurrence suffix (`#2`) only
	 *  for what is still repeated (one runway published twice). What the
	 *  performance page keys its options on and stores as the pick; equal to
	 *  `id` wherever the designators are unique, so a pick stored before it
	 *  existed reads as it always did. */
	key: string;
	/** The designator as the page shows it: alone, or with its runway ("17
	 *  (17/35GLD)") where the aerodrome repeats it, so the two read apart. */
	label: string;
	runway: Runway;
	end: 'le' | 'he';
	surface: string;
	/** What the surface string says (hard / mixed / soft / unknown). */
	surfaceClass: SurfaceClass;
	/** Not known to be paved (the workbook's "piste herbe"): soft, mixed or
	 *  unknown, all of which take the grass factor. */
	grass: boolean;
	distances: DeclaredDistancesM;
	/** Physical length, metres (null when unknown). */
	lengthM: number | null;
}

/** A NOTAM's restatement of an end's declared distances, METRES, keyed by the
 *  end designator exactly as `RunwayEnd.id` spells it. Supplied by the caller
 *  rather than read here, so this module stays free of app state. */
export type DistanceOverrides = ReadonlyMap<string, Partial<Record<'tora' | 'toda' | 'asda' | 'lda', number>>>;

/** Both ends of every runway, in dataset order (le then he).
 *
 *  `overrides` is what a declared-distance NOTAM restates (mechanism 18). It
 *  replaces the published figure per distance rather than per end, because a
 *  NOTAM routinely restates three of the four and leaves the last alone, and
 *  the one it leaves is still the AIP's own. */
export function runwayEnds(airport: Airport, overrides?: DistanceOverrides): RunwayEnd[] {
	const out: RunwayEnd[] = [];
	// A designator two runways carry takes no restated figure: the NOTAM
	// names neither runway, and the resolver contests it rather than state
	// one (state/runwayOverride.svelte.ts). Counted per RUNWAY: a pad
	// published H1 / H1 names itself twice and is still one surface.
	const twice = designatorsOnTwoRunways(airport);
	for (const r of distinctRunways(airport)) {
		for (const end of ['le', 'he'] as const) {
			const id = endDesignator(end === 'le' ? r.le : r.he);
			// A pad published H1 / H1 is one direction-less surface: listed
			// once, where it offered two options that read the same.
			if (!id || (end === 'he' && r.he === r.le)) {
				continue;
			}
			const published = declaredDistancesM(r, end);
			const o = twice.has(id) ? undefined : overrides?.get(id);
			out.push({
				id,
				key: id,
				label: id,
				runway: r,
				end,
				surface: r.surface,
				surfaceClass: classifySurface(r.surface),
				grass: classifySurface(r.surface) !== 'hard',
				distances: o
					? {
							...published,
							toraM: o.tora ?? published.toraM,
							todaM: o.toda ?? published.todaM,
							asdaM: o.asda ?? published.asdaM,
							ldaM: o.lda ?? published.ldaM,
						}
					: published,
				lengthM: r.lengthFt == null ? null : r.lengthFt * 0.3048,
			});
		}
	}
	for (const e of out) {
		if (twice.has(e.id)) {
			e.key = `${e.id}@${e.runway.le}/${e.runway.he}`;
			// The pair as published, less an end it does not have: "H1 (H1/)"
			// read as a slash.
			const pair = [endDesignator(e.runway.le), endDesignator(e.runway.he)].filter(Boolean).join('/');
			e.label = `${e.id} (${pair})`;
		}
	}
	// Two labels the pair cannot tell apart (one designator, one pair, two
	// surfaces) say which surface.
	const labelCount = new Map<string, number>();
	for (const e of out) {
		labelCount.set(e.label, (labelCount.get(e.label) ?? 0) + 1);
	}
	for (const e of out) {
		if ((labelCount.get(e.label) ?? 0) > 1 && e.label.endsWith(')')) {
			e.label = `${e.label.slice(0, -1)}, ${e.surface})`;
		}
	}
	const keys = occurrenceKeys(out, (e) => e.key);
	for (const [i, e] of out.entries()) {
		e.key = keys[i];
	}
	return out;
}

/** The placeholders the OurAirports baseline writes for an end nobody
 *  knows: "-" for the end a heliport's pad does not have (46 of them),
 *  "XX" (FNCX, NZFG, WA19, WA98), "unknown" (MZMF, CN-0359), "error"
 *  (WAJO), "0" (SIIR) and "00" (KG-0002): none of them an end a pilot can
 *  pick or a NOTAM can name, and each was offered as a runway to pick. */
const PLACEHOLDER_ENDS = new Set(['-', 'XX', 'UNKNOWN', 'ERROR', '0', '00']);

/** A runway end's designator as published, '' for a placeholder
 *  (PLACEHOLDER_ENDS). */
export function endDesignator(d: string | null | undefined): string {
	return d && !PLACEHOLDER_ENDS.has(d.trim().toUpperCase()) ? d : '';
}

/** The aerodrome's runways, a row published twice over (KY68, MI75, SJS2
 *  repeat one exactly) counted once: two options read the same and the
 *  second was keyed by position, and a NOTAM naming one of its ends read as
 *  naming two runways. */
export function distinctRunways(airport: Airport): Runway[] {
	const seen = new Set<string>();
	return airport.runways.filter((r) => {
		const sig = JSON.stringify(r);
		if (seen.has(sig)) {
			return false;
		}
		seen.add(sig);
		return true;
	});
}

/** The designators two different runways of this aerodrome carry. */
export function designatorsOnTwoRunways(airport: Airport): Set<string> {
	const seen = new Set<string>();
	const out = new Set<string>();
	for (const r of distinctRunways(airport)) {
		for (const d of new Set([endDesignator(r.le), endDesignator(r.he)])) {
			if (!d) {
				continue;
			}
			if (seen.has(d)) {
				out.add(d);
			}
			seen.add(d);
		}
	}
	return out;
}

/** The end a stored pick names, by its key. A pick keyed at its runway
 *  (`17@17/35`) is that end wherever the runway is listed, its ends either
 *  way round, and whether or not another runway still carries the
 *  designator: keyed bare once the glider strip was withdrawn, it resolved
 *  to nothing and the automatic choice took over, possibly the opposite
 *  end. It is never moved onto another runway: the strip picked gone, the
 *  pick is. A pick stored before keys existed is the bare designator, the
 *  FIRST end carrying it, the one it always resolved to; one stored by
 *  position in the development builds that keyed a repeat `17#2` is that
 *  occurrence. Null for no pick, or one this aerodrome no longer
 *  publishes. */
export function pickedRunwayEnd(
	ends: readonly RunwayEnd[],
	stored: string | null | undefined,
): RunwayEnd | null {
	if (!stored) {
		return null;
	}
	const exact = ends.find((e) => e.key === stored);
	if (exact) {
		return exact;
	}
	const atRunway = /^(.+)@(.*)\/(.*)$/.exec(stored);
	if (atRunway) {
		const [, id, a, b] = atRunway;
		return (
			ends.find(
				(e) =>
					e.id === id &&
					((e.runway.le === a && e.runway.he === b) || (e.runway.le === b && e.runway.he === a)),
			) ?? null
		);
	}
	const occurrence = /^(.+)#(\d+)$/.exec(stored);
	if (occurrence) {
		return ends.filter((e) => e.id === occurrence[1])[Number(occurrence[2]) - 1] ?? null;
	}
	return ends.find((e) => e.id === stored) ?? null;
}

/** A runway end weighed for the default-runway choice. */
export interface RunwayPick<E> {
	end: E;
	/** Not known to be paved (the workbook's "piste herbe"). */
	grass: boolean;
	/** Signed headwind along the end, kt (negative = tailwind). */
	headwindKt: number;
	/** Whether the declared distances suffice, WITH the margin: 0 with the
	 *  normal take-off (or any landing), 1 only with a short-field take-off,
	 *  2 not at all, or unknown (pickRank, aircraft/performance.ts). */
	rank: 0 | 1 | 2;
}

/** The default runway end: the one needing the least, then paved before
 *  grass, then the most into wind. The rank comes first and the surface
 *  second (user decision, 2026-10-02): an end where the normal take-off fits
 *  beats one asking for the short-field procedure and its checklist, even
 *  paved, and the pilot can still pick that end. Ties go to the earliest end
 *  (dataset order = the main runway as listed). Returns null for an empty
 *  list. With no wind every headwind is 0, so the rule collapses to tier
 *  then dataset order. */
export function bestRunwayEnd<E>(picks: readonly RunwayPick<E>[]): E | null {
	// Tier (lower is better): normal-fit paved < normal-fit grass <
	// short-field-only paved < short-field-only grass < too-short paved <
	// too-short grass.
	const tier = (p: RunwayPick<E>): number => p.rank * 2 + (p.grass ? 1 : 0);
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
