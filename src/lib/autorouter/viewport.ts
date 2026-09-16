/* Viewport-to-ICAO derivation and the live "what would a fetch cover?"
 * summary that drives the NotamLoader coverage line. Pure reads; no network. */

import { t } from '$lib/state/i18n.svelte';
import type { ErrorText } from '$lib/i18n/errorText';
import {
	bboxContainsLon,
	bboxIntersectsRing,
	bboxesOverlap,
	pointToPolylineDistanceM,
	type Bbox,
} from '$lib/notam/geometry';
import { corridorIntersectsRing, routeCorridorBbox } from '$lib/route/notamCorridor';
import { NM_TO_METERS } from '$lib/notam/units';
import { mapState } from '$lib/state/map.svelte';
import { getAirports, getAirspaces } from '$lib/state/data.svelte';

// Cap on the ICAO list a single fetch can produce. France (the densest
// covered region) has 487 LF civilian airports; 1000 leaves room for
// equally-dense regions elsewhere. The autorouter /notam call is chunked
// separately in fetch.ts; this number caps the per-fetch budget.
const MAX_ICAOS = 1000;

// Refuse fetches whose (padded) viewport is larger than this on either
// side. World-wide FIR coverage (pruatlas + FAA) makes a continent-sized
// fetch viable, but the /notam call count and the proxy's free-tier
// latency budget cap us well below planet scale. 60° comfortably covers
// all of CONUS or all of Europe in one fetch.
const MAX_VIEWPORT_DEG = 60;

// Pad the viewport on each side so a NOTAM at an airfield just off-screen
// still shows up after a fetch.
const VIEWPORT_PAD = 0.1;

/** Exported so NotamLoader can format messages referring to these caps. */
export const MAX_ICAOS_PER_FETCH = MAX_ICAOS;
export const MAX_VIEWPORT_DEG_PER_SIDE = MAX_VIEWPORT_DEG;

// Matches OurAirports' synthetic "XX-NNNN" placeholder idents. autorouter's
// /notam rejects any non-ICAO entry in the itemas list with HTTP 400 and
// fails the whole batch, so anything that isn't a clean 4-letter ICAO has
// to be filtered out before we send.
const ICAO_PATTERN = /^[A-Z]{4}$/;

const CIVILIAN_AIRPORT_TYPES = new Set([
	'large_airport',
	'medium_airport',
	'small_airport',
	'heliport',
]);

/** Padded bounding box of the current viewport, or null when the map
 *  isn't ready. Normalises longitudes after horizontal pans (Leaflet
 *  returns un-normalised values once you cross the dateline). */
export function viewportBbox(): Bbox | null {
	const map = mapState.map;
	if (!map) {
		return null;
	}
	const b = map.getBounds();
	const minLat = Math.max(-90, b.getSouth());
	const maxLat = Math.min(90, b.getNorth());
	let minLon = b.getWest();
	let maxLon = b.getEast();
	const lonWidth = maxLon - minLon;
	if (lonWidth >= 360) {
		minLon = -180;
		maxLon = 180;
	} else {
		const centre = (minLon + maxLon) / 2;
		const shift = Math.round(centre / 360) * 360;
		minLon -= shift;
		maxLon -= shift;
	}
	const padLat = (maxLat - minLat) * VIEWPORT_PAD;
	const padLon = (maxLon - minLon) * VIEWPORT_PAD;
	return {
		minLat: minLat - padLat,
		maxLat: maxLat + padLat,
		minLon: minLon - padLon,
		maxLon: maxLon + padLon,
	};
}

/** True iff the viewport exceeds MAX_VIEWPORT_DEG on either axis. */
export function viewportTooLarge(bbox: Bbox): boolean {
	return (
		bbox.maxLat - bbox.minLat > MAX_VIEWPORT_DEG ||
		bbox.maxLon - bbox.minLon > MAX_VIEWPORT_DEG
	);
}

/** Diagnostic used when viewportIcaos() returns empty; surfaces which input
 *  (map / airports / airspaces / bbox) is at zero so we can tell a
 *  wrong-viewport user from a not-yet-loaded dataset. Returns a deferred
 *  ErrorText so the message re-renders on a locale switch; the captured
 *  values are data. */
export function describeEmptyViewport(): ErrorText {
	const map = mapState.map;
	if (!map) {
		return () => t.errors.mapNotReady;
	}
	const bbox = viewportBbox();
	const aps = getAirports();
	const asp = getAirspaces();
	const fmt = (n: number) => n.toFixed(2);
	const bboxStr = bbox
		? `${fmt(bbox.minLat)},${fmt(bbox.minLon)} -> ${fmt(bbox.maxLat)},${fmt(bbox.maxLon)}`
		: 'unknown';
	if (!aps || aps.length === 0) {
		return () => t.errors.datasetLoading({ file: 'airports.json', bbox: bboxStr });
	}
	if (!asp || asp.length === 0) {
		return () => t.errors.datasetLoading({ file: 'airspaces.json', bbox: bboxStr });
	}
	const airports = aps.length;
	const airspaces = asp.length;
	return () => t.errors.viewportEmpty({ bbox: bboxStr, airports, airspaces });
}

/** ICAO codes for the airports + FIRs the current viewport covers.
 *  Civilian airport types only, capped at MAX_ICAOS by proximity to the
 *  viewport centre. */
export function viewportIcaos(): { airports: string[]; firs: string[] } {
	const bbox = viewportBbox();
	if (!bbox) {
		return { airports: [], firs: [] };
	}
	return {
		airports: airportIcaosIn(bbox),
		firs: firIcaosIn(bbox, (ring) => bboxIntersectsRing(bbox, ring)),
	};
}

function airportIcaosIn(bbox: Bbox): string[] {
	const all = getAirports();
	if (!all) return [];
	const visible = all.filter(
		(a) =>
			CIVILIAN_AIRPORT_TYPES.has(a.type) &&
			ICAO_PATTERN.test(a.ident.toUpperCase()) &&
			a.lat >= bbox.minLat &&
			a.lat <= bbox.maxLat &&
			// Wrap-aware: a dateline-straddling viewport keeps its lon range
			// contiguous past +/-180 while the dataset stays in [-180, 180].
			bboxContainsLon(bbox, a.lon),
	);
	const cx = (bbox.minLat + bbox.maxLat) / 2;
	const cy = (bbox.minLon + bbox.maxLon) / 2;
	visible.sort((a, b) => {
		const da = (a.lat - cx) ** 2 + (a.lon - cy) ** 2;
		const db = (b.lat - cx) ** 2 + (b.lon - cy) ** 2;
		return da - db;
	});
	return visible.slice(0, MAX_ICAOS).map((a) => a.ident.toUpperCase());
}

function firIcaosIn(bbox: Bbox, hits: (ring: [number, number][]) => boolean): string[] {
	const airspaces = getAirspaces();
	if (!airspaces) return [];
	const firs: string[] = [];
	const seen = new Set<string>();
	for (const sp of airspaces) {
		if (sp.category !== 'fir') continue;
		// Cheap bbox reject, then the exact polygon test: a lopsided FIR (e.g.
		// London, whose Western-Approaches arm drops its bounding box to ~48.8N)
		// must not be fetched by a route or viewport that merely clips that
		// rectangle without entering the FIR itself.
		if (!bboxesOverlap(bbox, sp.bbox)) continue;
		if (!hits(sp.ring)) continue;
		const id = sp.id.toUpperCase();
		if (!ICAO_PATTERN.test(id)) continue;
		if (!seen.has(id)) {
			seen.add(id);
			firs.push(id);
		}
	}
	return firs;
}

export interface ViewportCoverage {
	/** Civilian airports in view with a valid 4-letter ICAO. */
	airports: number;
	/** Airports in view whose ident OurAirports filled with a placeholder
	 *  (XX-NNNN); informational only, the fetch filters them out. */
	skippedAirports: number;
	/** Distinct 4-letter FIR/OCA ICAOs whose polygon intersects the view. */
	firs: number;
	/** Non-FIR airspaces (CTR/TMA/CLASS/ARTCC/SUA/...) intersecting the view.
	 *  Zero here means the visible region has FIR-only coverage. */
	richAirspaces: number;
	viewportTooLarge: boolean;
	/** Airport count exceeds the per-fetch cap; only the closest will go. */
	overCap: boolean;
	/** True once both airports.json and airspaces.json have finished loading. */
	dataReady: boolean;
}

/** Live summary of what fetchNotamsForViewport would fetch right now and
 *  what it would skip. Wrap in $derived; the mapState reads inside drive
 *  re-evaluation on every pan/zoom. */
export function viewportCoverage(): ViewportCoverage {
	// Read mapState.zoom / center so $derived consumers re-evaluate on
	// each moveend / zoomend (the values themselves aren't used; the
	// actual bounds come from map.getBounds()).
	void mapState.zoom;
	void mapState.center;

	const aps = getAirports();
	const asp = getAirspaces();
	const dataReady = aps !== null && asp !== null;

	const bbox = viewportBbox();
	if (!bbox || !dataReady) {
		return {
			airports: 0, skippedAirports: 0, firs: 0, richAirspaces: 0,
			viewportTooLarge: false, overCap: false, dataReady,
		};
	}

	let airports = 0;
	let skippedAirports = 0;
	if (aps) {
		for (const a of aps) {
			if (!CIVILIAN_AIRPORT_TYPES.has(a.type)) continue;
			if (a.lat < bbox.minLat || a.lat > bbox.maxLat) continue;
			if (!bboxContainsLon(bbox, a.lon)) continue;
			if (ICAO_PATTERN.test(a.ident.toUpperCase())) {
				airports++;
			} else {
				skippedAirports++;
			}
		}
	}

	let firs = 0;
	let richAirspaces = 0;
	const seenFirs = new Set<string>();
	if (asp) {
		for (const sp of asp) {
			if (!bboxesOverlap(bbox, sp.bbox)) continue;
			if (sp.category === 'fir') {
				// Match firIcaosIn: count only a FIR the viewport polygon reaches,
				// not one whose bounding box it merely clips.
				if (!bboxIntersectsRing(bbox, sp.ring)) continue;
				const id = sp.id.toUpperCase();
				if (ICAO_PATTERN.test(id) && !seenFirs.has(id)) {
					seenFirs.add(id);
					firs++;
				}
			} else {
				richAirspaces++;
			}
		}
	}
	return {
		airports,
		skippedAirports,
		firs,
		richAirspaces,
		viewportTooLarge: viewportTooLarge(bbox),
		overCap: airports > MAX_ICAOS,
		dataReady,
	};
}

/** Route-corridor bbox (drives firIcaosIn and notamState.fetchBbox); the
 *  pure math lives in $lib/route/notamCorridor, re-exported here for the
 *  fetch plumbing. */
export { routeCorridorBbox };

/** Civil 4-letter-ICAO airports within `radiusNM` of the route polyline,
 *  sorted by ascending polyline distance (so a later cap keeps the closest).
 *  Uncapped; routeIcaos applies MAX_ICAOS. The bbox is a cheap pre-filter so
 *  the worldwide airport scan only runs the per-segment distance on nearby
 *  candidates. */
function routeAirportIdents(
	waypoints: { lat: number; lon: number }[],
	radiusNM: number,
	bbox: Bbox,
): string[] {
	const all = getAirports();
	if (!all) {
		return [];
	}
	const radiusM = radiusNM * NM_TO_METERS;
	const matched: Array<{ ident: string; d: number }> = [];
	for (const a of all) {
		if (!CIVILIAN_AIRPORT_TYPES.has(a.type)) continue;
		const ident = a.ident.toUpperCase();
		if (!ICAO_PATTERN.test(ident)) continue;
		if (
			a.lat < bbox.minLat ||
			a.lat > bbox.maxLat ||
			a.lon < bbox.minLon ||
			a.lon > bbox.maxLon
		) {
			continue;
		}
		const d = pointToPolylineDistanceM(a.lat, a.lon, waypoints);
		if (d > radiusM) continue;
		matched.push({ ident, d });
	}
	matched.sort((x, y) => x.d - y.d);
	return matched.map((m) => m.ident);
}

/** Airports (within the corridor of the polyline) + FIRs (overlapping the
 *  corridor bbox) the route covers. Airports capped at MAX_ICAOS by proximity
 *  to the route, like the viewport path. */
export function routeIcaos(
	waypoints: { lat: number; lon: number }[],
	radiusNM: number,
): { airports: string[]; firs: string[] } {
	const bbox = routeCorridorBbox(waypoints, radiusNM);
	if (!bbox) {
		return { airports: [], firs: [] };
	}
	const halfWidthM = radiusNM * NM_TO_METERS;
	return {
		airports: routeAirportIdents(waypoints, radiusNM, bbox).slice(0, MAX_ICAOS),
		firs: firIcaosIn(bbox, (ring) => corridorIntersectsRing(waypoints, halfWidthM, ring)),
	};
}

/** Envelope of several bounding boxes (nulls skipped), or null when all are
 *  null. Used to gate the NOTAM display to the union of every route's corridor. */
export function unionBboxes(boxes: (Bbox | null)[]): Bbox | null {
	let out: Bbox | null = null;
	for (const b of boxes) {
		if (!b) {
			continue;
		}
		out = out
			? {
					minLat: Math.min(out.minLat, b.minLat),
					minLon: Math.min(out.minLon, b.minLon),
					maxLat: Math.max(out.maxLat, b.maxLat),
					maxLon: Math.max(out.maxLon, b.maxLon),
				}
			: { ...b };
	}
	return out;
}

/** Merge several routes' ICAO sets into one fetch list: dedup airports + FIRs
 *  across routes (first-seen order kept) and cap the combined airport list at
 *  MAX_ICAOS. FIRs are few, left whole. A NOTAM returned twice (an airport on
 *  two routes, or a shared FIR) collapses downstream at the parse-dedup step. */
export function unionRouteIcaos(
	per: { airports: string[]; firs: string[] }[],
): { airports: string[]; firs: string[] } {
	const airportSet = new Set<string>();
	const firSet = new Set<string>();
	for (const r of per) {
		for (const a of r.airports) {
			airportSet.add(a);
		}
		for (const f of r.firs) {
			firSet.add(f);
		}
	}
	return {
		airports: [...airportSet].slice(0, MAX_ICAOS),
		firs: [...firSet],
	};
}

export interface RouteCoverage {
	airports: number;
	firs: number;
	/** Airport matches exceed the per-fetch cap; only the closest are queried. */
	overCap: boolean;
	/** True once airports.json and airspaces.json have finished loading. */
	dataReady: boolean;
}

/** Live summary of what fetchNotamsForRoute would fetch for the given route,
 *  for the RouteTab status line. Wrap in $derived. */
export function routeCoverage(
	waypoints: { lat: number; lon: number }[],
	radiusNM: number,
): RouteCoverage {
	const aps = getAirports();
	const asp = getAirspaces();
	const dataReady = aps !== null && asp !== null;
	const bbox = routeCorridorBbox(waypoints, radiusNM);
	if (!bbox || !dataReady) {
		return { airports: 0, firs: 0, overCap: false, dataReady };
	}
	const idents = routeAirportIdents(waypoints, radiusNM, bbox);
	const halfWidthM = radiusNM * NM_TO_METERS;
	return {
		airports: Math.min(idents.length, MAX_ICAOS),
		firs: firIcaosIn(bbox, (ring) => corridorIntersectsRing(waypoints, halfWidthM, ring)).length,
		overCap: idents.length > MAX_ICAOS,
		dataReady,
	};
}
