/* METAR stations for the map overlay: a viewport-tiled cache over the AWC
 * bbox endpoint, feeding the metarLayer canvas and the Weather tab's
 * status line.
 *
 * The proxy caps a METAR bbox at 4 degrees per axis, so the viewport is
 * tiled into 4-degree INTEGER-ALIGNED cells (exact under the proxy's
 * .toFixed(2) cache key, so every viewport shares tile keys and the 60 s
 * edge/browser cache does its job). One coherent zoom gate: at most
 * MAX_TILES tiles in view, else status 'zoom-in' and the layer empties.
 * Per-tile TTL matches the METAR cadence; per-tile failures leave the
 * other tiles drawn. Tiles are content-addressed, so no abort machinery:
 * a late response is never wrong.
 *
 * Reactivity contract (the windAloft one): ensure-path writes happen
 * inside untrack(); the tile cache itself is a plain Map and consumers
 * re-derive through the reactive `seq` counter bumped per tile arrival.
 * stationFeed() also reads notamState.tick so ages re-tint each minute.
 * Everything is gated on display.liveWeather (the network kill switch)
 * AND the show-on-map toggle; hidden costs nothing. */

import { untrack } from 'svelte';
import { readItem, removeItem, writeItem } from './persist';
import { isFresh } from './asyncCache';
import { display } from './display.svelte';
import { t } from './i18n.svelte';
import { notamState } from './notam.svelte';
import { ui, type DetailTarget } from './ui.svelte';
import { fetchMetarsByBbox, type AwcMetar, type WxBbox } from '$lib/weather/awc';
import {
	flightCategory,
	formatAge,
	formatClouds,
	formatVisib,
	formatWind,
	latestByStation,
	metarAgeMin,
	metarFreshness,
	qnhFromMetar,
	stationName,
	type FlightCategory,
	type MetarFreshness,
} from '$lib/weather/metar';

const SHOW_KEY = 'loxodrome:metar-map';

const TILE_DEG = 4;
/** Tile budget per view: the default z6 country view on a wide screen
 *  needs ~40 tiles (~7.5 KB each, AWC is un-metered), a continent view
 *  (z5 and out) is refused with the "zoom in" status. */
const MAX_TILES = 45;
/** Per-tile refetch cadence (the METAR cycle; weather.svelte.ts's TTL). */
const TILE_TTL_MS = 5 * 60_000;

export interface MetarTile {
	key: string;
	bbox: WxBbox;
}

/** The 4-degree integer-aligned tiles covering the bounds, or null when the
 *  view needs more than maxTiles (the tab shows "zoom in"). Latitudes clamp
 *  to world bounds; an antimeridian-crossing view splits into two spans
 *  (the proxy requires minLon < maxLon inside [-180, 180]). Pure. */
export function metarTiles(
	bounds: { west: number; south: number; east: number; north: number },
	maxTiles = MAX_TILES,
): MetarTile[] | null {
	const south = Math.max(-90, bounds.south);
	const north = Math.min(90, bounds.north);
	if (!(north > south)) {
		return [];
	}
	const wrap = (x: number): number => ((((x + 180) % 360) + 360) % 360) - 180;
	const w = wrap(bounds.west);
	const e = wrap(bounds.east);
	const spans: [number, number][] =
		bounds.east - bounds.west >= 360 ? [[-180, 180]] : w <= e ? [[w, e]] : [[w, 180], [-180, e]];
	const rows = Math.ceil((north - Math.floor(south / TILE_DEG) * TILE_DEG) / TILE_DEG);
	const cols = spans.reduce(
		(n, [lo, hi]) => n + Math.ceil((hi - Math.floor(lo / TILE_DEG) * TILE_DEG) / TILE_DEG),
		0,
	);
	if (rows * cols > maxTiles) {
		return null;
	}
	const tiles: MetarTile[] = [];
	for (const [lo0, hi0] of spans) {
		for (let lo = Math.floor(lo0 / TILE_DEG) * TILE_DEG; lo < hi0; lo += TILE_DEG) {
			for (let la = Math.floor(south / TILE_DEG) * TILE_DEG; la < north; la += TILE_DEG) {
				tiles.push({
					key: `${la},${lo}`,
					bbox: {
						minLat: Math.max(-90, la),
						minLon: Math.max(-180, lo),
						maxLat: Math.min(90, la + TILE_DEG),
						maxLon: Math.min(180, lo + TILE_DEG),
					},
				});
			}
		}
	}
	return tiles;
}

export const metarStations = $state<{
	showOnMap: boolean;
	status: 'idle' | 'zoom-in' | 'loading' | 'ok' | 'error';
	error: string | null;
	/** Newest tile arrival (the tab's data-age line). */
	fetchedAtMs: number;
	/** Bumped per tile arrival / refresh; consumers re-derive through it. */
	seq: number;
}>({
	showOnMap: readItem(SHOW_KEY) === 'on',
	status: 'idle',
	error: null,
	fetchedAtMs: 0,
	seq: 0,
});

export function setShowStationsOnMap(on: boolean): void {
	metarStations.showOnMap = on;
	if (on) {
		writeItem(SHOW_KEY, 'on');
	} else {
		removeItem(SHOW_KEY);
	}
}

// Plain (non-reactive) bookkeeping; see the contract in the header.
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- module cache, published through `seq`
const tileCache = new Map<string, { metars: AwcMetar[]; atMs: number }>();
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- in-flight dedup bookkeeping, not state
const inflight = new Map<string, Promise<void>>();

/** Start (or keep) the tile fetches for the current viewport. Cheap when
 *  every tile is fresh; safe from host effects (untracked writes). */
export function ensureMetarStations(
	bounds: { west: number; south: number; east: number; north: number },
	nowMs = Date.now(),
): void {
	if (!display.liveWeather || !metarStations.showOnMap) {
		untrack(() => {
			if (metarStations.status !== 'idle') {
				metarStations.status = 'idle';
				metarStations.error = null;
			}
		});
		return;
	}
	const tiles = metarTiles(bounds);
	if (!tiles) {
		untrack(() => {
			metarStations.status = 'zoom-in';
			metarStations.error = null;
		});
		return;
	}
	const missing = tiles.filter((t) => {
		if (inflight.has(t.key)) {
			return false;
		}
		const e = tileCache.get(t.key);
		return !e || !isFresh(e.atMs, TILE_TTL_MS, nowMs);
	});
	if (missing.length === 0) {
		untrack(() => {
			if (inflight.size === 0 && metarStations.status !== 'error') {
				metarStations.status = 'ok';
			}
		});
		return;
	}
	untrack(() => {
		metarStations.status = 'loading';
	});
	for (const tile of missing) {
		const p = fetchMetarsByBbox(tile.bbox)
			.then((metars) => {
				tileCache.set(tile.key, { metars, atMs: Date.now() });
				metarStations.fetchedAtMs = Date.now();
				metarStations.status = 'ok';
				metarStations.error = null;
				metarStations.seq++;
			})
			.catch((err: unknown) => {
				// Per-tile tolerance: the failed tile keeps its previous metars
				// (or stays empty), the rest draw. Stamping the failure into the
				// cache paces retries at the tile TTL; without it the minute
				// tick would re-try every failed tile every minute through an
				// outage. The Refresh button clears the cache for an immediate
				// manual retry.
				tileCache.set(tile.key, {
					metars: tileCache.get(tile.key)?.metars ?? [],
					atMs: Date.now(),
				});
				metarStations.status = 'error';
				metarStations.error = err instanceof Error ? err.message : String(err);
			})
			.finally(() => {
				inflight.delete(tile.key);
			});
		inflight.set(tile.key, p);
	}
}

/** Drop the tiles and refetch on the next ensure pass (the MapView effect
 *  tracks `seq`). The 60 s proxy/browser cache bounds how fresh a refresh
 *  can get; the tab's status line shows the data age for that reason. */
export function refreshStations(): void {
	tileCache.clear();
	metarStations.fetchedAtMs = 0;
	metarStations.seq++;
}

export interface MapStation {
	metar: AwcMetar;
	cat: FlightCategory | null;
	ageMin: number;
	freshness: MetarFreshness;
}

/** The stations of every cached tile (deduped, newest per station), with
 *  their category and freshness. Reading tracks `seq` (tile arrivals) and
 *  notamState.tick (ages re-tint each minute). */
export function stationFeed(): MapStation[] {
	void metarStations.seq;
	void notamState.tick;
	const nowMs = Date.now();
	const all: AwcMetar[] = [];
	for (const e of tileCache.values()) {
		all.push(...e.metars);
	}
	return latestByStation(all).map((m) => {
		const ageMin = metarAgeMin(m, nowMs);
		return { metar: m, cat: flightCategory(m), ageMin, freshness: metarFreshness(ageMin) };
	});
}

/** Hover-badge lines for a station (the .wind-tip readout). Reads t at call
 *  time, so a template caller re-renders on a locale switch (MapView keeps
 *  the hovered DATUM in state, never these lines). */
export function stationTipLines(st: MapStation): string[] {
	const words = t.weather;
	const m = st.metar;
	const name = stationName(m.name);
	const lines = [
		`${m.icaoId}${name ? ` ${name}` : ''}`,
		`${st.cat ?? words.station.noCategory}, ${formatAge(st.ageMin, words.metar)}`,
	];
	const wind = formatWind(m, words.metar);
	if (wind) {
		lines.push(words.station.wind(wind));
	}
	const vis = formatVisib(m.visib, words.metar);
	if (vis) {
		lines.push(words.station.visibility(vis));
	}
	const clouds = formatClouds(m.clouds);
	if (clouds) {
		lines.push(clouds);
	}
	const qnh = qnhFromMetar(m);
	if (qnh != null) {
		lines.push(`QNH ${qnh}`);
	}
	return lines;
}

/** The selected METAR station target (ident + geometry), or null when the
 *  detail panel is showing something else. Mirrors selectedSigmet: reading
 *  ui.detail is reactive, so MetarStationDetail re-renders on selection; it
 *  resolves the live METAR / TAF by ident itself. */
export function selectedStation(): Extract<DetailTarget, { kind: 'station' }> | null {
	return ui.detail?.kind === 'station' ? ui.detail : null;
}
