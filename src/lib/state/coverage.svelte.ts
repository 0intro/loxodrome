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
 *   - the flight plan's own areas (planScope.extent): every route's extent
 *     and each aerodrome the performance page adds, so a plan loads its
 *     countries while the map looks elsewhere, from the moment the plan
 *     exists rather than from the next pan (a boot onto a view of Italy
 *     with a French plan in store never loaded France);
 *   - the publishers a loaded NOTAM points at, because "linked lists
 *     always show" (docs/notam-relationships.md): a NOTAM panel must be
 *     able to list its affected airspaces wherever the map happens to be.
 *
 * The areas stay separate rectangles, never one envelope: a French plan
 * with an Italian aerodrome on its performance page would otherwise span
 * Switzerland, Austria and southern Germany, megabytes nobody asked for.
 * The flight app's plan areas include the aircraft's own position wherever
 * a pose exists, the live fix or any loaded trace's playhead
 * (state/flightScope.ts), so a diversion flown out of the view and the plan
 * keeps its alerts' data.
 *
 * A dataset whose sidecar carries no envelope is always loaded: absent
 * means "unknown", never "empty". Whether its FAILURE matters is then read
 * from where its publisher is (publisherInCoverage). */

import type { DatasetBBox, DatasetBBoxes } from '$lib/data/meta';
import { publisherArea } from '$lib/data/publishers';
import type { Publisher } from '$lib/state/layers.svelte';
import { planScope } from '$lib/state/planScope.svelte';

/** A lat/lon area of interest, in degrees. The gate holds its longitudes
 *  within [-180, 180] (wrapArea), an area straddling the antimeridian as
 *  two. */
export interface CoverageArea {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

export const coverage = $state<{
	/** The map viewport, null until the map reports its first view. */
	viewport: CoverageArea | null;
	/** Publishers that load regardless of the area. */
	forced: Publisher[];
}>({ viewport: null, forced: [] });

/** Degrees of slack added around the area before testing. Reference data
 *  is drawn slightly outside the viewport (a CTR whose centre is off
 *  screen still has an edge on it), and it lets a slow pan cross a border
 *  with the data already in hand. */
const MARGIN_DEG = 1.5;

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

function sameArea(a: CoverageArea | null, b: CoverageArea | null): boolean {
	return (
		a === b ||
		(a !== null &&
			b !== null &&
			a.minLat === b.minLat &&
			a.minLon === b.minLon &&
			a.maxLat === b.maxLat &&
			a.maxLon === b.maxLon)
	);
}

function finiteArea(a: CoverageArea): boolean {
	return [a.minLat, a.minLon, a.maxLat, a.maxLon].every(Number.isFinite);
}

/** Bring an area's longitudes into [-180, 180], splitting one that
 *  straddles the antimeridian. A map panned across the dateline reports
 *  longitudes past 180, neither map copying the world back, and compared
 *  raw, Tahiti seen at 209.5 E loaded nothing French. */
export function wrapArea(a: CoverageArea): CoverageArea[] {
	if (a.maxLon - a.minLon >= 360) {
		return [{ ...a, minLon: -180, maxLon: 180 }];
	}
	const k = Math.floor((a.minLon + 180) / 360);
	const minLon = a.minLon - 360 * k;
	const maxLon = a.maxLon - 360 * k;
	if (maxLon <= 180) {
		return [{ ...a, minLon, maxLon }];
	}
	return [
		{ ...a, minLon, maxLon: 180 },
		{ ...a, minLon: -180, maxLon: maxLon - 360 },
	];
}

/* The stamp moves whenever the areas or the forced publishers do, so a
   dataset can ask "has anything changed since I judged the gate?" without
   judging it again (state/data.svelte.ts, fillStore). A plain counter: the
   areas it follows are the reactive part. */
let stamp = 0;
let lastAreas: readonly CoverageArea[] = [];

/* The areas, in one list, with a stable identity: the same array comes back
   while the rectangles are the same, so an effect reading it wakes only when
   something moved (an altitude edit rebuilds the routes and changes no
   rectangle). */
const areas = $derived.by((): readonly CoverageArea[] => {
	const next: CoverageArea[] = [];
	if (coverage.viewport) {
		next.push(...wrapArea(coverage.viewport));
	}
	for (const a of planScope.extent?.() ?? []) {
		if (finiteArea(a)) {
			next.push(...wrapArea(a));
		}
	}
	if (next.length === lastAreas.length && next.every((a, i) => sameArea(a, lastAreas[i]))) {
		return lastAreas;
	}
	lastAreas = next;
	stamp++;
	return next;
});

/** Every area the reference datasets must cover: the viewport, then the
 *  plan's. Reactive, and the same array while nothing moves. */
export function coverageAreas(): readonly CoverageArea[] {
	return areas;
}

/** A number that changes whenever the areas or the forced publishers do. */
export function coverageStamp(): number {
	void areas;
	return stamp;
}

/** Publish the map viewport. Called from the map on every settled view; a
 *  view with no finite bounds (a map not laid out yet) is ignored. */
export function setCoverageViewport(area: CoverageArea | null): void {
	if (area && !finiteArea(area)) {
		return;
	}
	if (sameArea(coverage.viewport, area)) {
		return;
	}
	coverage.viewport = area;
}

/** Publish the publishers a loaded briefing points at. */
export function setForcedPublishers(list: readonly Publisher[]): void {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedup, the assignment below carries the reactivity
	const next = [...new Set(list)].sort();
	if (next.length === coverage.forced.length && next.every((p, i) => p === coverage.forced[i])) {
		return;
	}
	coverage.forced = next;
	stamp++;
}

/** Does the current coverage need this dataset?
 *
 *  `bboxes`, when the sidecar carries it, is the set of pieces the rows
 *  really occupy and is tested INSTEAD of the single envelope: a
 *  publisher whose territory is not connected (France, Portugal, the FIR
 *  rings) has an envelope that is true of almost any viewport, which
 *  would silently disable the gate for the largest datasets.
 *
 *  Reading the areas and `coverage.forced` here is what makes a caller
 *  inside an $effect re-run when the map pans, the plan changes or a
 *  briefing lands. */
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
	const list = areas;
	if (list.length === 0) {
		return false;
	}
	const boxes = bboxes && bboxes.length > 0 ? bboxes : [bbox];
	return boxes.some((b) => list.some((area) => overlaps(b, area)));
}

/** Does a publisher's own territory (its registry area) meet the areas the
 *  app is asked about? The judgement for a country whose sidecar did not
 *  answer: its envelope is unknown, so it loads, and whether its failure
 *  matters to the pilot (the banner naming it, the alert caveats, the
 *  prints, the detail panel) is read from where the publisher is. Before,
 *  it was never counted, and a blip that took France's sidecar and its data
 *  file together left the alerts over Paris with no caveat. */
export function publisherInCoverage(publisher: Publisher): boolean {
	if (coverage.forced.includes(publisher)) {
		return true;
	}
	const list = areas;
	return publisherArea(publisher).some((b) => list.some((area) => overlaps(b, area)));
}

/** Does a publisher's own territory meet one area, within the gate's
 *  margin? What a surface about one ROUTE asks of a part still missing (the
 *  MSA note), where publisherInCoverage asks it of every area the app is
 *  asked about. */
export function publisherMeetsArea(publisher: Publisher, area: CoverageArea): boolean {
	const wrapped = wrapArea(area);
	return publisherArea(publisher).some((b) => wrapped.some((a) => overlaps(b, a)));
}

/** Does a box, widened by the margin, meet an area? The areas are wrapped
 *  into [-180, 180] (wrapArea) and the boxes are published there, so the
 *  box is also tried a world east and a world west: the margin then reaches
 *  across the antimeridian, where a piece ending at 180 meets an area just
 *  past it at -179.8, and a pose snapped onto 180 (wrapped to -180) sees
 *  the pieces on both sides. */
function overlaps(box: DatasetBBox | readonly [number, number, number, number], area: CoverageArea): boolean {
	return boxNearArea(box, area, MARGIN_DEG, MARGIN_DEG);
}

/** Does a box come within a margin of an area, in degrees of latitude and
 *  of longitude, across the antimeridian as the gate's own test does? What
 *  a surface about one route asks with the route's own corridor for a
 *  margin (routeMsaIncomplete), where the gate's 1.5 degrees are six times
 *  the widest MSA corridor. */
export function boxNearArea(
	box: DatasetBBox | readonly [number, number, number, number],
	area: CoverageArea,
	latDeg: number,
	lonDeg: number,
): boolean {
	const [minLon, minLat, maxLon, maxLat] = box;
	if (minLat - latDeg > area.maxLat || maxLat + latDeg < area.minLat) {
		return false;
	}
	return [0, -360, 360].some((shift) => minLon + shift - lonDeg <= area.maxLon && maxLon + shift + lonDeg >= area.minLon);
}
