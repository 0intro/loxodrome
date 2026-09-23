/* Pure (Leaflet type-only) hit-test for NOTAM areas; kept out of notamLayer.ts
 * so vitest can import it in Node without triggering Leaflet's `window`-using
 * module side effects.
 *
 * Two answers over one index: notamAreaAt, the single shape a left click
 * resolves to (interactions.ts ranks its m² against the other area kinds), and
 * notamAreasAt, the smallest-first list the right-click menu shows. Both read
 * visibleNotams(), the set the map DRAWS, so what is on screen is what answers.
 *
 * The index is an rbush over drawn SHAPES rather than the linear walk this
 * started as. A pasted briefing is never viewport-limited (computeFilteredNotams
 * applies fetchScope only to a region fetch), so visibleNotams() holds the
 * whole thing -- over 11 000 entries for a European briefing -- and notamAreaAt
 * runs on MapView's per-frame cursor loop. Same lesson and same answer as the
 * airspace layer's own index; a bbox prefilter is not enough here, the map
 * lookup costing more than the four multiplies of the circle test it skips.
 *
 * The set it is built from moves whenever the window does, so under the default
 * period it is rebuilt about once a minute. That is affordable because most of
 * a briefing draws nothing: the 11 041 entries of tests/fixtures/Europe-
 * 20260203.txt yield 1 845 shapes and 3 to 8 ms of build, the rest being pins
 * and Q-line-only entries. Should a corpus ever make that hurt, the fix is to
 * key the index on filteredNotams() instead and test the window per hit. */

import RBush from 'rbush';
import type L from 'leaflet';
import {
	notamShapes,
	shapeContainsPoint,
	type NotamShape,
} from '$lib/notam/geometry';
import { visibleNotams, type IndexedNotam } from './notam.svelte';

/** One drawn shape in the index, with the entry that drew it. */
interface ShapeEntry {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	it: IndexedNotam;
	shape: NotamShape;
}

/** A NOTAM area under the point, carrying the footprint of the SHAPE that
 *  contained it, not of the entry: an entry drawing a 1 NM circle far away and
 *  a 30 NM circle over the cursor must rank as the circle you are in. */
export interface NotamAreaHit {
	it: IndexedNotam;
	areaM2: number;
}

// Keyed on the visibleNotams() array IDENTITY, which partitionByWindow holds
// stable while the filters and the window hold (notam.svelte.ts) and which
// renderNotams already diffs on.
let indexedItems: IndexedNotam[] | null = null;
let shapeTree: RBush<ShapeEntry> | null = null;

function shapeIndex(): RBush<ShapeEntry> {
	// Read unconditionally, ahead of the cache check: a caller inside a
	// $derived / $effect tracks the briefing and the window exactly as a
	// linear walk did.
	const items = visibleNotams();
	if (shapeTree && indexedItems === items) {
		return shapeTree;
	}
	const entries: ShapeEntry[] = [];
	for (const it of items) {
		for (const shape of notamShapes(it.notam)) {
			entries.push({
				minX: shape.bbox.minLon,
				minY: shape.bbox.minLat,
				maxX: shape.bbox.maxLon,
				maxY: shape.bbox.maxLat,
				it,
				shape,
			});
		}
	}
	const tree = new RBush<ShapeEntry>();
	tree.load(entries);
	shapeTree = tree;
	indexedItems = items;
	return tree;
}

/** Every drawn shape containing the point, smallest first. */
function shapeHitsAt(lat: number, lon: number): NotamAreaHit[] {
	const candidates = shapeIndex().search({
		minX: lon,
		minY: lat,
		maxX: lon,
		maxY: lat,
	});
	const out: NotamAreaHit[] = [];
	for (const c of candidates) {
		if (shapeContainsPoint(c.shape, lat, lon)) {
			out.push({ it: c.it, areaM2: c.shape.areaM2 });
		}
	}
	out.sort((a, b) => a.areaM2 - b.areaM2);
	return out;
}

/** The smallest drawn NOTAM shape under the point, or null.
 *
 *  Returns the ENTRY, not a row deduped by id: selectNotam / highlightNotam
 *  are per-entry, so a multi-area NOTAM highlights the area actually clicked.
 *
 *  Deliberately without notamAreasAt's low-zoom bail: renderNotams has no zoom
 *  gate, so the polygon is on screen at zoom 3, and drawn ink that cannot be
 *  clicked is the one thing featureAt promises never happens. A list of
 *  everything at that scale is useless; one answer is not. */
export function notamAreaAt(lat: number, lon: number): NotamAreaHit | null {
	return shapeHitsAt(lat, lon)[0] ?? null;
}

/** Visible NOTAM areas (polygons + point-plus-radius circles) that contain the
 *  given lat/lon, smallest first, so the most specific feature appears at the
 *  top of the right-click context menu. Multi-area source NOTAMs collapse to
 *  one row per id, keeping the SMALLEST containing entry, so the menu row and
 *  a left click cannot land on different rings of one NOTAM; the user opens the
 *  source NOTAM and the detail panel groups its areas internally.
 *
 *  Bails at very low zoom (<= 3), like airspaceAt's zoom bail; at that scale
 *  every feature overlaps every click and the menu is useless. */
export function notamAreasAt(
	map: L.Map,
	lat: number,
	lon: number,
): IndexedNotam[] {
	if (map.getZoom() <= 3) {
		return [];
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const seen = new Set<string>();
	const out: IndexedNotam[] = [];
	for (const hit of shapeHitsAt(lat, lon)) {
		if (seen.has(hit.it.notam.id)) {
			continue;
		}
		seen.add(hit.it.notam.id);
		out.push(hit.it);
	}
	return out;
}
