/* The VAC panel georeference: lazily loaded, slot-picked, fail-soft.
 *
 * The adCharts.svelte.ts chartSet pattern, with two differences the data
 * forces: an ident carries several panels rather than one row, and the map
 * layer asks by AREA rather than by ident. The set is 724 rows, so the area
 * query is a scan; an index would be machinery for a list that fits in a
 * cache line's worth of cache lines.
 *
 * Nothing here fetches a plate. This module knows only WHERE each panel
 * goes; offline/docFetch.ts gets the bytes and state/vacPanels renders
 * them. */

import {
	FR_VACGEO_NEXT_URL,
	FR_VACGEO_URL,
	loadFrVacGeo,
	type VacPanel,
	type VacPanelKind,
} from '$lib/data/vacgeo';
import { loadFrVacGeoMeta, loadFrVacGeoNextMeta, pickActiveDataset } from '$lib/data/meta';

export const vacGeoState = $state<{
	loaded: boolean;
	loading: boolean;
	error: string | null;
	/** Aerodromes with at least one placed panel, for the Layers tab. */
	aerodromes: number;
}>({ loaded: false, loading: false, error: null, aerodromes: 0 });

// Plain, non-reactive: the load flag above is the reactive signal, the
// house idiom for a dataset whose rows never change after they arrive.
let panels: VacPanel[] | null = null;
let promise: Promise<VacPanel[]> | null = null;

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Load the dataset once. Idempotent; a failure clears the promise so a
 *  later toggle retries rather than leaving the layer permanently empty. */
export function ensureVacGeo(): Promise<VacPanel[]> {
	if (panels) {
		return Promise.resolve(panels);
	}
	if (promise) {
		return promise;
	}
	vacGeoState.loading = true;
	vacGeoState.error = null;
	promise = (async () => {
		const [meta, nextMeta] = await Promise.all([
			loadFrVacGeoMeta().catch(() => null),
			loadFrVacGeoNextMeta().catch(() => null),
		]);
		const { url } = pickActiveDataset(
			meta?.effective ?? null,
			nextMeta?.effective ?? null,
			FR_VACGEO_URL,
			FR_VACGEO_NEXT_URL,
			// A one-shot timestamp passed by value, the chartSet idiom.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
			new Date(),
		);
		const rows = await loadFrVacGeo(url);
		panels = rows;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- counted once, discarded
		const idents = new Set(rows.map((p) => p.ident));
		vacGeoState.aerodromes = idents.size;
		vacGeoState.loaded = true;
		vacGeoState.loading = false;
		return rows;
	})().catch((e: unknown) => {
		vacGeoState.error = message(e);
		vacGeoState.loading = false;
		promise = null;
		throw e;
	});
	return promise;
}

/** Every placed panel of one aerodrome, which the detail panel can say so. */
export function vacPanelsForIdent(ident: string): VacPanel[] {
	void vacGeoState.loaded;
	const key = ident.toUpperCase();
	return panels?.filter((p) => p.ident === key) ?? [];
}

export interface VacArea {
	south: number;
	west: number;
	north: number;
	east: number;
}

/** The VAC panels to draw for a view: the sheets of ONE aerodrome, the one
 * the middle of the view is on.
 *
 * The obvious rule, "draw every sheet whose own scale suits this zoom",
 * makes a quilt. Over the Paris basin at zoom 10 it tiles a dozen approach
 * sheets across the whole screen, each cut off at its own frame, at
 * different scales and orientations, with the base map showing through the
 * gaps and the aerodrome actually being looked at buried among the others.
 * It is unreadable, and it is not what a VAC is for: the chart answers a
 * question about one aerodrome, not about a region.
 *
 * So the view's own centre picks the aerodrome. In flight with follow mode
 * on that is the aircraft, which is exactly right; planning, it is the
 * middle of what is being looked at, which is also right. Nothing draws
 * when the centre is on no sheet at all, and moving off an aerodrome puts
 * the map back rather than leaving a chart hanging.
 *
 * Within that aerodrome, at most one sheet per family, and the family
 * whose scale is nearest this zoom always draws. The others join it only
 * while the zoom is inside their own window, which is what makes the
 * approach sheet hand over to the landing sheet and then to the ground
 * chart as the aircraft closes.
 *
 * The floor below sits a zoom level under printed size. A sheet arriving
 * at half its engraved size is not yet a chart to read: its 5 pt lettering
 * is four pixels tall. It is a chart to SEE COMING, which is the thing a
 * floor at printed size took away, since an overlay that appears only once
 * you are on top of the aerodrome cannot tell you the aerodrome is there.
 * The map underneath stays the better answer for the detail until a level
 * later, and it shows through nothing: the sheet is opaque, so what the
 * floor really decides is when the chart is worth covering the map with.
 *
 * The ceiling moves with the floor, and by the same level, so that
 * widening the window cannot take a sheet AWAY. The two interact through
 * the nearest-scale rule: admitting the ground chart a level earlier makes
 * it the nearest sheet at that zoom, and with the old ceiling that evicted
 * the landing sheet, replacing four kilometres of chart with a patch a
 * kilometre wide. Both bounds move together, and every sheet that draws at
 * a given zoom today still draws there.
 *
 * Reading vacGeoState.loaded makes a caller in a $derived or an $effect
 * re-run when the dataset lands. */
export function vacPanelsIn(
	area: VacArea,
	kinds: readonly VacPanelKind[],
	zoom: number,
	nativeZoomOf: (p: VacPanel) => number,
	zoomSlack = 1.3,
	zoomCeiling = 2.6,
): VacPanel[] {
	void vacGeoState.loaded;
	if (!panels || kinds.length === 0) {
		return [];
	}
	const cLat = (area.south + area.north) / 2;
	const cLon = (area.west + area.east) / 2;
	const kx = Math.cos((cLat * Math.PI) / 180);

	const under = panels.filter(
		(p) =>
			kinds.includes(p.kind) &&
			p.south <= cLat &&
			cLat <= p.north &&
			p.west <= cLon &&
			cLon <= p.east,
	);
	if (under.length === 0) {
		return [];
	}

	// The aerodrome is chosen BEFORE any zoom test, and the zoom then only
	// decides which of its sheets to draw. Filtering by zoom first would
	// let the choice fall through to whichever neighbour's sheet happens
	// to be legible: over Lognes at zoom 11, where Lognes' own sheets are
	// all too small to read, that put Orly's approach chart across the
	// screen. The answer there is no chart, not another aerodrome's.
	const offset = (p: VacPanel): number =>
		Math.hypot((p.south + p.north) / 2 - cLat, ((p.west + p.east) / 2 - cLon) * kx);
	let chosen = under[0];
	for (const p of under) {
		const d = offset(p) - offset(chosen);
		if (d < 0 || (d === 0 && nativeZoomOf(p) > nativeZoomOf(chosen))) {
			chosen = p;
		}
	}

	// One sheet per family: a large aerodrome files a plate in both Atlas
	// products, and two editions of its landing sheet drawn over each
	// other is the quilt again in miniature.
	const picks: VacPanel[] = [];
	for (const p of under) {
		if (p.ident !== chosen.ident || zoom < nativeZoomOf(p) - zoomSlack) {
			continue;
		}
		const i = picks.findIndex((q) => q.kind === p.kind);
		if (i < 0) {
			picks.push(p);
		} else if (
			Math.abs(nativeZoomOf(p) - zoom) < Math.abs(nativeZoomOf(picks[i]) - zoom)
		) {
			picks[i] = p;
		}
	}
	if (picks.length === 0) {
		return [];
	}
	let nearest = picks[0];
	for (const p of picks) {
		if (Math.abs(nativeZoomOf(p) - zoom) < Math.abs(nativeZoomOf(nearest) - zoom)) {
			nearest = p;
		}
	}
	return picks.filter((p) => p === nearest || zoom <= nativeZoomOf(p) + zoomCeiling);
}

/** Reset for tests. */
export function resetVacGeoForTest(): void {
	panels = null;
	promise = null;
	vacGeoState.loaded = false;
	vacGeoState.loading = false;
	vacGeoState.error = null;
	vacGeoState.aerodromes = 0;
}
