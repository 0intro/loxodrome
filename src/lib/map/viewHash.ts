/* Shareable map-view URL hash, OpenStreetMap's slippy-map convention:
 *   #map=<zoom>/<lat>/<lon>[&layer=<id>][&charts=<id,id,…>]
 * The hash carries the map center + zoom, the non-default base layer, and the
 * aeronautical chart stack as an ORDERED id list (`charts=us500,fr500` = us500
 * checked first, fr500 stacked above it; order is meaningful, later ids draw
 * on top). Legacy flags from the boolean era (`oaci=1`, `oaci_250=1`,
 * `oaci_ch=1`) are still parsed (mapped to fr500 / fr250 / swissIcao, in that
 * stack order) but never emitted. Kept in sync with history.replaceState
 * (adds no history entry, fires no popstate), so it never pollutes the back
 * stack nor disturbs backClose.ts. Pure parse/build here; the component owns
 * the read-at-boot and the write-on-move. No user-visible text, so this stays
 * clear of the i18n catalogs like the rest of src/lib/map. */

import type { BaseLayerId, ChartLayerId } from '$lib/state/layers.svelte';

/* Known chart layer ids, in no particular order (the stack order comes from
 * the hash value itself). Kept local (not imported from chartOverlays) to
 * keep this module Leaflet-free, mirroring the local BASE_LAYER_IDS list;
 * the `satisfies` record keeps the list compiler-checked against the
 * ChartLayerId union, so a new chart id cannot be silently dropped from
 * shared links. */
const CHART_ID_SET = {
	fr500: 1,
	fr250: 1,
	nl500: 1,
	cz500: 1,
	dk500: 1,
	dk250: 1,
	no250: 1,
	si250: 1,
	ee500: 1,
	is500: 1,
	hu500: 1,
	es500: 1,
	us1000: 1,
	us500: 1,
	us250: 1,
	us125: 1,
	swissIcao: 1,
} as const satisfies Record<ChartLayerId, 1>;
const CHART_LAYER_IDS = Object.keys(CHART_ID_SET) as readonly ChartLayerId[];

/* Boolean-era flags -> layer ids; parse order fixes their stack order. */
const LEGACY_CHART_FLAGS: readonly [string, ChartLayerId][] = [
	['oaci', 'fr500'],
	['oaci_250', 'fr250'],
	['oaci_ch', 'swissIcao'],
];

/** Whether a raw string is a known chart-layer id (shared with the
 *  flight-mode workspace restore). */
export function isChartLayerId(v: string): v is ChartLayerId {
	return (CHART_LAYER_IDS as readonly string[]).includes(v);
}

/** A restored view. `layer` is absent when the hash omits it (the OSM
 *  default); `charts` is the ordered chart stack (empty when none). */
export interface ParsedView {
	center: [number, number]; // [lat, lng], Leaflet order
	zoom: number;
	layer?: BaseLayerId | undefined;
	charts: ChartLayerId[];
}

const BASE_LAYER_IDS: readonly BaseLayerId[] = ['osm', 'topo', 'ign', 'google', 'bing'];

/** Whether a raw string is a known base-layer id. */
export function isBaseLayerId(v: string | null): v is BaseLayerId {
	return v !== null && (BASE_LAYER_IDS as readonly string[]).includes(v);
}

/**
 * Build the `#map=z/lat/lon[&layer=id][&charts=a,b]` fragment (leading `#`
 * included). Hand-built rather than URLSearchParams.toString(), which would
 * percent-encode the slashes and commas. Optional keys are omitted at their
 * default (base layer `osm`, empty chart stack), keeping bare URLs clean.
 */
export function buildViewHash(
	zoom: number,
	lat: number,
	lng: number,
	layer: BaseLayerId,
	charts: readonly ChartLayerId[],
): string {
	let hash = `#map=${Math.round(zoom)}/${lat.toFixed(5)}/${lng.toFixed(5)}`;
	if (layer !== 'osm') {
		hash += `&layer=${layer}`;
	}
	if (charts.length > 0) {
		hash += `&charts=${charts.join(',')}`;
	}
	return hash;
}

/**
 * Parse a `location.hash` into a view, or null when it carries no usable
 * `map=` value. Zoom is clamped to 0..20; out-of-range or malformed
 * coordinates are rejected; an unknown base `layer` is dropped; unknown ids
 * and duplicates in `charts=` are dropped (first occurrence wins).
 */
export function parseViewHash(hash: string): ParsedView | null {
	const raw = hash.replace(/^#/, '');
	if (!raw) {
		return null;
	}
	const params = new URLSearchParams(raw);
	const map = params.get('map');
	if (!map) {
		return null;
	}
	const parts = map.split('/');
	if (parts.length !== 3 || parts.some((p) => p.trim() === '')) {
		return null;
	}
	const zoom = Number(parts[0]);
	const lat = Number(parts[1]);
	const lng = Number(parts[2]);
	if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return null;
	}
	if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
		return null;
	}
	const layer = params.get('layer');
	const charts: ChartLayerId[] = [];
	const chartsParam = params.get('charts');
	if (chartsParam !== null) {
		for (const id of chartsParam.split(',')) {
			if (isChartLayerId(id) && !charts.includes(id)) {
				charts.push(id);
			}
		}
	} else {
		// Boolean-era links: each flag appends its layer in the legacy order.
		for (const [flag, id] of LEGACY_CHART_FLAGS) {
			if (params.get(flag) === '1') {
				charts.push(id);
			}
		}
	}
	return {
		center: [lat, lng],
		zoom: Math.min(20, Math.max(0, Math.round(zoom))),
		layer: isBaseLayerId(layer) ? layer : undefined,
		charts,
	};
}

/**
 * Replace the current URL's hash with a prebuilt view hash (buildViewHash),
 * preserving the path and query (so `?file=` survives) and the history state
 * object (so backClose's marker survives; it reads only entry counts, which
 * replaceState never changes). Taking the string, not the view, lets the
 * caller build synchronously (dependency tracking) and write throttled.
 */
export function writeViewHash(hash: string): void {
	const url = location.pathname + location.search + hash;
	history.replaceState(history.state, '', url);
}
