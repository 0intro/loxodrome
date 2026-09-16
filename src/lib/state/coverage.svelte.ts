/* Which publishers' reference data the app currently needs.
 *
 * Reference datasets are large and there are a lot of publishers, so
 * loading every country on every visit costs tens of megabytes for a
 * pilot who never leaves one FIR. Each dataset's .meta.json carries the
 * lat/lon envelope of its own rows (internal/aip/bbox.go), and the
 * sidecar is already fetched to pick the AIRAC slot, so gating the
 * dataset fetch on that envelope costs nothing extra.
 *
 * The gate is the union of three things, and all three are load-bearing:
 *
 *   - the map viewport, so what is on screen is always backed by data;
 *   - every route's extent, so a plan crossing a country loads it even
 *     while the map looks elsewhere;
 *   - the publishers a loaded NOTAM points at, because "linked lists
 *     always show" (docs/notam-relationships.md): a NOTAM panel must be
 *     able to list its affected airspaces wherever the map happens to be.
 *
 * A dataset whose sidecar carries no envelope is always loaded: absent
 * means "unknown", never "empty". */

import type { DatasetBBox, DatasetBBoxes } from '$lib/data/meta';
import type { Publisher } from '$lib/state/layers.svelte';

/** A lat/lon area of interest. Degrees, no antimeridian wrapping: the
 *  gate is a coarse test and a view spanning the dateline degrades to
 *  loading more, never less. */
export interface CoverageArea {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

export const coverage = $state<{
	/** Map viewport unioned with every route's extent. Null until the map
	 *  reports its first view; nothing but `forced` loads before then. */
	area: CoverageArea | null;
	/** Publishers that load regardless of the area. */
	forced: Publisher[];
}>({ area: null, forced: [] });

/** Degrees of slack added around the area before testing. Reference data
 *  is drawn slightly outside the viewport (a CTR whose centre is off
 *  screen still has an edge on it), and it lets a slow pan cross a border
 *  with the data already in hand. */
const MARGIN_DEG = 1.5;

/** Widen an area to the union with another. */
export function unionArea(a: CoverageArea | null, b: CoverageArea | null): CoverageArea | null {
	if (!a) return b;
	if (!b) return a;
	return {
		minLat: Math.min(a.minLat, b.minLat),
		minLon: Math.min(a.minLon, b.minLon),
		maxLat: Math.max(a.maxLat, b.maxLat),
		maxLon: Math.max(a.maxLon, b.maxLon),
	};
}

/** The area enclosing a set of points, or null when there are none. */
export function areaOfPoints(points: readonly { lat: number; lon: number }[]): CoverageArea | null {
	let out: CoverageArea | null = null;
	for (const p of points) {
		if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
		out = out
			? {
					minLat: Math.min(out.minLat, p.lat),
					minLon: Math.min(out.minLon, p.lon),
					maxLat: Math.max(out.maxLat, p.lat),
					maxLon: Math.max(out.maxLon, p.lon),
				}
			: { minLat: p.lat, minLon: p.lon, maxLat: p.lat, maxLon: p.lon };
	}
	return out;
}

/** Publish the area of interest. Called from the map, which owns the
 *  viewport and knows every route's extent. */
export function setCoverageArea(area: CoverageArea | null): void {
	const prev = coverage.area;
	if (
		prev &&
		area &&
		prev.minLat === area.minLat &&
		prev.minLon === area.minLon &&
		prev.maxLat === area.maxLat &&
		prev.maxLon === area.maxLon
	) {
		return;
	}
	coverage.area = area;
}

/** Publish the publishers a loaded briefing points at. */
export function setForcedPublishers(list: readonly Publisher[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedup, the assignment below carries the reactivity
	const next = [...new Set(list)].sort();
	if (next.length === coverage.forced.length && next.every((p, i) => p === coverage.forced[i])) {
		return;
	}
	coverage.forced = next;
}

/** Does the current coverage need this dataset?
 *
 *  `bboxes`, when the sidecar carries it, is the set of pieces the rows
 *  really occupy and is tested INSTEAD of the single envelope: a
 *  publisher whose territory is not connected (France, Portugal, the FIR
 *  rings) has an envelope that is true of almost any viewport, which
 *  would silently disable the gate for the largest datasets.
 *
 *  Reading `coverage.area` and `coverage.forced` here is what makes a
 *  caller inside an $effect re-run when the map pans or a briefing
 *  lands. */
export function coverageWants(
	publisher: Publisher,
	bbox: DatasetBBox | undefined,
	bboxes?: DatasetBBoxes,
): boolean {
	if (coverage.forced.includes(publisher)) {
		return true;
	}
	// No envelope: the dataset predates the field or holds no coordinates.
	// Either way we cannot judge it, so it loads.
	if (!bbox || bbox.length < 4) {
		return true;
	}
	const area = coverage.area;
	if (!area) {
		return false;
	}
	const boxes = bboxes && bboxes.length > 0 ? bboxes : [bbox];
	return boxes.some((b) => overlaps(b, area));
}

function overlaps(box: DatasetBBox, area: CoverageArea): boolean {
	const [minLon, minLat, maxLon, maxLat] = box;
	return (
		minLon - MARGIN_DEG <= area.maxLon &&
		maxLon + MARGIN_DEG >= area.minLon &&
		minLat - MARGIN_DEG <= area.maxLat &&
		maxLat + MARGIN_DEG >= area.minLat
	);
}
