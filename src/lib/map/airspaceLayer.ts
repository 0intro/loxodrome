import L from 'leaflet';
import RBush from 'rbush';
import { pointInRing, type Airspace } from '$lib/data/airspaces';
import { degAreaToM2 } from '$lib/notam/geometry';
import { bandIntersects } from '$lib/vertical/limits';
import { everyPublisher } from '$lib/data/publishers';
import type { AirspaceCategory, Publisher } from '$lib/state/layers.svelte';
import { isActivationDrawn } from './activationLayer';
import { polygonHighlightStyle } from './airspaceSymbology';
import { createCloneLayer } from './emphasisClones';
import { navContactKeys } from './navContactLayer';
import { navAlertKeys } from './navAlertLayer';
import { airspaceClosureKeys } from './airspaceClosureLayer';

/* airspaceLayer.ts: the airspace rows on the map, as data. Which rows the
 * map shows (the per-row filters and the category toggles, one chokepoint,
 * entryShown), which the painting of a rectangle draws and in what order
 * (airspacesToPaint), which are emphasised (hovered, selected, linked to a
 * selected NOTAM) and the clones that show those at once, and the hit-test.
 * The boundaries themselves are PAINTED, with their decorations, by
 * airspaceDecoLayer.ts (decoPaint.ts's line pass): no Leaflet polygon is
 * built for a row, so nothing is re-projected on a view reset, and the line
 * and its band are one painting, never one arriving after the other. That
 * layer is told whenever what it draws changes other than by the view
 * (setAirspaceRepaintListener).
 *
 * Styling is per FEATURE, not per category: airspaceSymbology.ts resolves
 * each row's SIA 1:500 000 chart symbol (chart-faithful: boundaries only,
 * never a resting interior fill; SIV / DLG-ATS rest strokeless because the
 * chart marks those boundaries with the square dots / comb the paint draws,
 * and FIC draws nothing at all). */

// rbush entry: the airspace's lat/lon bbox plus a back-reference to the
// Entry, so the queries run the per-row visibility checks without a lookup.
interface AirspaceIndexEntry {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	entry: Entry;
}

export const CATEGORIES: AirspaceCategory[] = [
	'controlled',
	'restricted',
	'activity',
	'trafficmgmt',
	'transit',
	'siv',
	'fir',
];

/** An emphasis clone (hover / selection / NOTAM-linked): always stroked,
 *  interior tinted, in the airspace's SIA family colour. A dashed one is
 *  stroked whole from the ring's first vertex, unsimplified, as the paint
 *  strokes the same line over it: the clone's dashes must fall under the
 *  painted ones, never between them. */
function cloneOf(a: Airspace, opts: L.PathOptions): L.Polygon {
	const dashed = typeof opts.dashArray === 'string';
	return L.polygon(a.ring, dashed ? { ...opts, noClip: true, smoothFactor: 0 } : opts);
}

interface Entry {
	airspace: Airspace;
	/** The row's place in the dataset array: the stacking order's tie-break
	 *  between two rows of the same area, so equal rings always stack the
	 *  same way whatever order the index hands them back in. */
	rank: number;
}

// Keyed by airspace.key (not id) so MOA parent + exclusion rows that share
// the same designation each get their own per-row entry. Complete over the
// dataset: the selection lookup and the emphasis clones need every row.
const byKey = new Map<string, Entry>();
// The emphasised airspaces (hovered or selected). A SET because one nav-log
// enroute frequency line can name several sectors sharing that frequency
// (SEINE - INFORMATION 134.300 over SIV SEINE 1 / 2 / 3); a selection and
// every other hover pass exactly one.
let highlightedKeys: readonly string[] = [];
// The map, captured at build time so the emphasis clones can be drawn
// without every caller (detail-panel rows, context menu, selection) threading
// the map through.
let layerMap: L.Map | null = null;
// A clone of each emphasised airspace, drawn at once whatever its category /
// publisher / altitude filter (a highlight from a detail-panel row, the
// context menu, a nav-log frequency line or the vertical profile is always
// visible on the map), on the 'airspaces' pane UNDER the painting: its tint
// shows through, and its stroke until the painting that draws the emphasis
// over it lands. Deliberately NOT in airspaceAt's hit-test exception chain: a
// highlighted airspace has never been clickable through its clone. Rebuilt
// when a republished dataset replaces the row object (geomRefOf).
const highlightClones = createCloneLayer<Airspace>({
	pane: 'airspaces',
	paneZ: '350',
	keyOf: (a) => a.key,
	geomRefOf: (a) => a,
	geometryOf: cloneOf,
	styleOf: (a) => polygonHighlightStyle(a),
	sharedPaneRenderer: true,
	frontOnSync: true,
});
// Clones of the airspaces a selected NOTAM affects (its named TMA / CTA / CTR
// or SIV sectors), drawn regardless of category / publisher / altitude so the
// set shows even with the airspace layers off; decoupled from the emphasis
// above so the two never fight. The same pane and its IMPLICIT renderer (one
// SVG, so bringToFront interleaves them), re-fronted on every sync. The
// painting strokes these rows' boundaries in the emphasis stroke too
// (linkedAirspaceKeys), where it draws them.
let linkedAirspaces: Airspace[] = [];
const linkedClones = createCloneLayer<Airspace>({
	pane: 'airspaces',
	paneZ: '350',
	keyOf: (a) => a.key,
	geomRefOf: (a) => a,
	geometryOf: cloneOf,
	styleOf: (a) => polygonHighlightStyle(a),
	sharedPaneRenderer: true,
	frontOnSync: true,
});
// R-tree over per-row ring bboxes: the hit-test's point query, and the
// window query the painting asks. Built at buildAirspaceLayer time and
// rebuilt whenever the dataset array is republished (a late country).
let spatialIndex: RBush<AirspaceIndexEntry> | null = null;
// The dataset array the index was built from: a different identity handed
// to buildAirspaceLayer means the rows changed under the layer.
let indexedRows: Airspace[] | null = null;
// At or below this zoom the painting draws nothing (decoPaint's own floor),
// the clones' pane is hidden (updateAirspaceViewport) and the hit-test
// returns nothing: at a continental view the boundaries carry no detail.
const LOW_ZOOM_HIDE = 4;
let altitudeBand: { floor: number; ceiling: number } | null = null;
// Default: every publisher visible. setAirspacePublisher flips entries
// off as the user toggles individual publishers in the Layers tab;
// mirrors the default in layers.svelte.ts.
const publisherVisible: Record<Publisher, boolean> = everyPublisher(true);
// Route-airspaces-only filter (the Route tab "Route airspaces only" toggle).
// When active, the map shows ONLY the airspaces the routes cross (routeKeys),
// across every category: the toggle overrides the Layers-tab category
// toggles (entryShown). Null restores them.
let routeOnly = false;
let routeKeys: Set<string> | null = null;
// Per-category visibility from the Layers tab. Recorded whatever the route
// filter says, so its choice comes back when the filter clears. Effective
// visibility is `routeOnly || categoryOn[cat]`.
const categoryOn: Record<AirspaceCategory, boolean> = {
	controlled: false,
	restricted: false,
	activity: false,
	trafficmgmt: false,
	transit: false,
	siv: false,
	fir: false,
};

interface IndexRect {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

// The rows last handed to the painting (airspacesToPaint), with the rectangle
// they were queried for: the window asked for widened by half its size on
// every side, so the same array serves every window that stays inside it.
let paintRows: { rect: IndexRect; rows: Airspace[] } | null = null;
const NO_ROWS: readonly Airspace[] = Object.freeze([]);

/** Does the airspace's vertical extent overlap the active altitude band?
 *  Datum-aware and conservative: a missing side is unbounded (a row with
 *  one published limit still filters on it) and an AGL/ASFC limit uses
 *  its conservative endpoint, so a terrain-hugging zone (RTBA, ZRT) is
 *  never hidden by a raised floor. */
function entryPassesAltitude(e: Entry): boolean {
	if (!altitudeBand) {
		return true;
	}
	return bandIntersects(e.airspace.vLower, e.airspace.vUpper, altitudeBand);
}

/** Combined per-entry visibility: passes the altitude band AND its publisher
 *  is enabled in the Layers tab AND, when the route filter is active, the
 *  airspace is one the routes cross. */
function entryPasses(e: Entry): boolean {
	return (
		entryPassesAltitude(e) &&
		publisherVisible[e.airspace.source] &&
		(!routeOnly || (routeKeys?.has(e.airspace.key) ?? false))
	);
}

/** Would this row be DRAWN if the map were looking at it: it passes the
 *  per-row filters AND its category is shown, by its Layers-tab toggle or by
 *  the route filter, which forces every category on.
 *
 *  Never where the map happens to be pointing, which no caller should see:
 *  the hit-test and the painting's rows ask this, so "left-click stays
 *  visibility-gated" keeps meaning the filters and the toggle. */
function entryShown(e: Entry): boolean {
	return entryPasses(e) && (routeOnly || categoryOn[e.airspace.category]);
}

/** Stacking order: largest ring first, so the smallest zones paint last and
 *  stay readable on top; equal areas in dataset order. */
function stackOrder(x: Entry, y: Entry): number {
	return y.airspace.area - x.airspace.area || x.rank - y.rank;
}

/** The shown rows whose bbox meets `rect`, in stacking order. */
function queryRows(rect: IndexRect): Airspace[] {
	if (!spatialIndex) {
		return [];
	}
	const want: Entry[] = [];
	for (const c of spatialIndex.search(rect)) {
		if (entryShown(c.entry)) {
			want.push(c.entry);
		}
	}
	want.sort(stackOrder);
	return want.map((e) => e.airspace);
}

function sameRows(a: readonly Airspace[], b: readonly Airspace[]): boolean {
	return a.length === b.length && a.every((row, i) => row === b[i]);
}

/** A filter, a category or the route filter changed: the painting's rows are
 *  asked again for the rectangle it last asked for, and the painting is told
 *  if they differ. Rows that come back the same keep their array, which the
 *  decoration layer and the worker client key their own caches on. Nothing
 *  asked yet, nothing known: told. */
function filtersChanged(): void {
	const held = paintRows;
	if (!held || !spatialIndex) {
		paintRows = null;
		onRepaint?.();
		return;
	}
	const rows = queryRows(held.rect);
	if (sameRows(rows, held.rows)) {
		return;
	}
	paintRows = { rect: held.rect, rows };
	onRepaint?.();
}

/** Build the airspace layer from the loaded dataset, or, built already and
 *  handed a DIFFERENT array (the dataset re-merged after a late country
 *  arrived: state/coverage loads publishers by area, docs/data-coverage.md),
 *  re-index the rows under it. Without the re-index the painting, the
 *  hit-test and the selection lookup would all stay bound to the first array
 *  for the session while every other reader saw the new one. */
export function buildAirspaceLayer(map: L.Map, airspaces: Airspace[]): void {
	if (layerMap && airspaces === indexedRows) {
		return;
	}
	const republished = layerMap !== null;
	layerMap = map;
	if (!map.getPane('airspaces')) {
		// The clones' pane, below the painting (airspaces-deco, 355).
		map.createPane('airspaces').style.zIndex = '350';
	}
	byKey.clear();
	const indexEntries: AirspaceIndexEntry[] = new Array<AirspaceIndexEntry>(airspaces.length);
	for (let i = 0; i < airspaces.length; i++) {
		const airspace = airspaces[i];
		const entry: Entry = { airspace, rank: i };
		byKey.set(airspace.key, entry);
		const b = airspace.bbox;
		indexEntries[i] = {
			minX: b.minLon,
			minY: b.minLat,
			maxX: b.maxLon,
			maxY: b.maxLat,
			entry,
		};
	}
	spatialIndex = new RBush<AirspaceIndexEntry>();
	spatialIndex.load(indexEntries);
	indexedRows = airspaces;
	paintRows = null;
	// The emphasis requested before the build, or re-cloned from republished
	// rows: a highlighted key may now name a replaced row.
	refreshHighlightOverlay();
	reconcileLinkedOverlay();
	if (republished) {
		onRepaint?.();
	}
}

/** Drop every module-level Leaflet handle so a rebuilt map starts clean. The
 *  Layers-tab preferences (publisherVisible, categoryOn, altitudeBand)
 *  survive; the views re-apply them after the rebuild. Called from the
 *  views' teardown, as the map itself goes. */
export function clearAirspaceLayer(): void {
	byKey.clear();
	spatialIndex = null;
	indexedRows = null;
	paintRows = null;
	layerMap = null;
	highlightedKeys = [];
	highlightClones.reset();
	linkedAirspaces = [];
	linkedClones.reset();
	onRepaint = null;
	routeOnly = false;
	routeKeys = null;
}

/** Update the altitude filter applied to airspaces; pass null to clear. */
export function setAirspaceAltitudeFilter(band: { floor: number; ceiling: number } | null): void {
	if (band?.floor === altitudeBand?.floor && band?.ceiling === altitudeBand?.ceiling) {
		return;
	}
	altitudeBand = band;
	filtersChanged();
}

/** Show or hide every airspace from a single publisher (SIA France, NATS UK,
 *  ENAIRE Spain, pruatlas, FAA). */
export function setAirspacePublisher(publisher: Publisher, visible: boolean): void {
	if (publisherVisible[publisher] === visible) {
		return;
	}
	publisherVisible[publisher] = visible;
	filtersChanged();
}

/** Show or hide a single airspace category (the Layers-tab toggle). Recorded
 *  even under the route filter, which restores it when it clears. */
export function setAirspaceCategory(cat: AirspaceCategory, visible: boolean): void {
	if (categoryOn[cat] === visible) {
		return;
	}
	categoryOn[cat] = visible;
	filtersChanged();
}

/** Restrict the airspaces shown to those the routes cross (an override: every
 *  category shows, each row gated to `keys`), or pass null to clear the filter
 *  and restore the Layers-tab category toggles. A route edit that leaves the
 *  same keys changes nothing. */
export function setRouteAirspaceFilter(keys: Set<string> | null): void {
	const held = routeKeys;
	const same = keys === null ? held === null : held !== null && keys.size === held.size && [...keys].every((k) => held.has(k));
	if (same) {
		return;
	}
	routeOnly = keys !== null;
	routeKeys = keys;
	filtersChanged();
}

/** Hide the clones' pane at very low zoom, where the painting draws nothing
 *  either. Called on every settled view change. */
export function updateAirspaceViewport(map: L.Map): void {
	const pane = map.getPane('airspaces');
	if (pane) {
		pane.style.display = map.getZoom() <= LOW_ZOOM_HIDE ? 'none' : '';
	}
}

/** The rows a painting of `window` draws at `zoom`: every row the filters
 *  and the categories show (entryShown) whose bbox meets the window, in
 *  stacking order, none at or below the zoom floor. The window is the
 *  painted canvas as latitudes and longitudes, unwrapped (Leaflet drew a
 *  vector at its raw longitude, never on a world copy, and the painting does
 *  as it did), clipped to the world here.
 *
 *  Queried from the index for the window widened by half its size on every
 *  side, and the same array handed back for every window inside that, until
 *  a filter, a category, the route filter or the dataset changes what it
 *  holds: a pan costs a query only once it has gone that far (the search and
 *  the sort take 2 ms over a continental view), and the caller can tell an
 *  unchanged set by its identity. */
export function airspacesToPaint(
	zoom: number,
	window: { minLat: number; minLon: number; maxLat: number; maxLon: number },
): readonly Airspace[] {
	if (!spatialIndex || zoom <= LOW_ZOOM_HIDE) {
		return NO_ROWS;
	}
	const minX = Math.max(-180, window.minLon);
	const maxX = Math.min(180, window.maxLon);
	const minY = Math.max(-90, window.minLat);
	const maxY = Math.min(90, window.maxLat);
	if (minX > maxX || minY > maxY) {
		return NO_ROWS;
	}
	const held = paintRows;
	if (held && minX >= held.rect.minX && maxX <= held.rect.maxX && minY >= held.rect.minY && maxY <= held.rect.maxY) {
		return held.rows;
	}
	const w = (window.maxLon - window.minLon) / 2;
	const h = (window.maxLat - window.minLat) / 2;
	const rect = {
		minX: Math.max(-180, window.minLon - w),
		minY: Math.max(-90, window.minLat - h),
		maxX: Math.min(180, window.maxLon + w),
		maxY: Math.min(90, window.maxLat + h),
	};
	const rows = queryRows(rect);
	paintRows = { rect, rows };
	return rows;
}

/** The hovered / selected airspaces, for the painting's unconditional
 *  highlight pass (same invariant as the other canvas layers: a selection
 *  draws even when its category / publisher / altitude filter hides it).
 *  Usually one; several when a nav-log frequency line names several sectors. */
export function highlightedAirspaces(): Airspace[] {
	const out: Airspace[] = [];
	for (const key of highlightedKeys) {
		const a = byKey.get(key)?.airspace;
		if (a) {
			out.push(a);
		}
	}
	return out;
}

/** The keys of the airspaces a selected NOTAM affects: the painting strokes
 *  their boundaries in the emphasis stroke, where it draws them, over the
 *  tint of their clones. */
export function linkedAirspaceKeys(): ReadonlySet<string> {
	return linkedClones.keys();
}

// Tells airspaceDecoLayer.ts (registered at its build) that what it draws
// changed other than by the view: the emphasis (hover, selection, a NOTAM's
// linked set), a filter or category that changed the rows of the rectangle it
// last painted, or a republished dataset. The views then never thread a
// repaint through their own effects, which is how the viewer's altitude band
// came to leave the decorations stale. A view change never comes through
// here: the layer repaints on its own view events, and a forced repaint would
// defeat its follow-mode overscan skip.
let onRepaint: (() => void) | null = null;

export function setAirspaceRepaintListener(fn: (() => void) | null): void {
	onRepaint = fn;
}

function visibleEntriesAt(map: L.Map, lat: number, lon: number): Entry[] {
	if (!spatialIndex || map.getZoom() <= LOW_ZOOM_HIDE) {
		return [];
	}
	// Point query: rbush returns only entries whose bbox contains the click.
	// Down from ~3.5 k linear bbox checks per call to O(log n + k) where k
	// is the handful of overlapping bboxes -- a meaningful win for the
	// per-rAF cursor-hover loop in MapView.
	const candidates = spatialIndex.search({
		minX: lon,
		minY: lat,
		maxX: lon,
		maxY: lat,
	});
	const out: Entry[] = [];
	for (const c of candidates) {
		const e = c.entry;
		const inVisibleCategory = entryShown(e);
		// Activated airspaces (stripe overlay), the airspaces a selected
		// NOTAM references (linkedClones), the sectors whose radio a NOTAM
		// has withdrawn (airspaceClosureLayer clones), the navigation-mode
		// contact emphasis (navContactLayer clones) AND the live alert
		// emphasis (navAlertLayer clones) stay hit-testable even with their
		// category toggle off: the user sees them drawn and expects to click
		// them. The linked, closed, contact and alert clones are keyed by row
		// `key`, activated by shared `id`.
		//
		// Every one of the five asks the DRAWN layer, never a fresh
		// derivation: this runs per pointer move, and re-deriving the
		// activation set here re-scanned the whole briefing and re-parsed
		// each NOTAM's text on every frame.
		if (
			!inVisibleCategory &&
			!isActivationDrawn(e.airspace.id) &&
			!linkedClones.keys().has(e.airspace.key) &&
			!airspaceClosureKeys().has(e.airspace.key) &&
			!navContactKeys().has(e.airspace.key) &&
			!navAlertKeys().has(e.airspace.key)
		) {
			continue;
		}
		if (!pointInRing(lat, lon, e.airspace.ring)) {
			continue;
		}
		out.push(e);
	}
	return out;
}

/** An airspace under the point, with the footprint of its ring: what the click
 *  resolver ranks against the other area kinds (docs/map-hit-testing.md). */
export interface AirspaceAreaHit {
	airspace: Airspace;
	areaM2: number;
}

/** The smallest visible airspace containing the point, or null. Picked on the
 *  row's own degree² `area` as it always was, and converted to the metres the
 *  cross-kind ranking needs from that precomputed number rather than by
 *  walking the ring again: this runs on the per-frame cursor loop, and the
 *  largest ring in the datasets carries 21 131 vertices. The cosine is taken
 *  at the bbox's mid-latitude, which for a ring that contains the query point
 *  is the same answer to far better than the resolver's tie threshold. */
export function airspaceAreaAt(
	map: L.Map,
	lat: number,
	lon: number,
): AirspaceAreaHit | null {
	let hit: Entry | null = null;
	for (const e of visibleEntriesAt(map, lat, lon)) {
		if (!hit || e.airspace.area < hit.airspace.area) {
			hit = e;
		}
	}
	if (!hit) {
		return null;
	}
	const { bbox, area } = hit.airspace;
	return {
		airspace: hit.airspace,
		areaM2: degAreaToM2(area, (bbox.minLat + bbox.maxLat) / 2),
	};
}

/** The same answer without the footprint, for callers that only need the row. */
export function airspaceAt(map: L.Map, lat: number, lon: number): Airspace | null {
	return airspaceAreaAt(map, lat, lon)?.airspace ?? null;
}

/** Highlight one airspace's outline: the hovered detail-panel / context-menu
 *  row, or the selected airspace. Takes the per-row `key`, not the shared
 *  `id`. Pass null to clear. */
export function highlightAirspace(key: string | null): void {
	highlightAirspaces(key ? [key] : []);
}

/** Highlight a SET of airspaces at once, for a row that names several: a
 *  nav-log enroute frequency line merges every sector sharing that frequency.
 *  Their clones show at once, whatever their filters; the painting follows
 *  with the emphasis stroke and the highlighted decorations. Pass an empty
 *  list to clear. */
export function highlightAirspaces(keys: readonly string[]): void {
	if (keys.length === highlightedKeys.length && keys.every((k, i) => highlightedKeys[i] === k)) {
		return;
	}
	highlightedKeys = [...keys];
	refreshHighlightOverlay();
	onRepaint?.();
}

/** Reconcile the emphasis clones against the emphasised airspaces: one per
 *  highlighted key the dataset knows. Idempotent: the shared keyed reconcile
 *  rebuilds only what changed and keeps the clones on top. */
function refreshHighlightOverlay(): void {
	if (!layerMap) {
		return;
	}
	highlightClones.sync(layerMap, highlightedAirspaces());
}

/** Highlight every airspace a selected NOTAM affects (its named TMA / CTA / CTR
 *  or SIV sectors), drawn as clones so they show even with the airspace layers
 *  off, and stroked in the emphasis by the painting where it draws them. Pass
 *  null to clear. Decoupled from highlightAirspace's hover / selection
 *  emphasis, so the two never fight. */
export function setLinkedAirspaces(airspaces: Airspace[] | null): void {
	const next = airspaces ?? [];
	if (sameRows(next, linkedAirspaces)) {
		return;
	}
	linkedAirspaces = next;
	reconcileLinkedOverlay();
	onRepaint?.();
}

/** Reconcile the NOTAM-linked clones against the requested set: remove stale
 *  clones, clone any missing ones, keep them on top. Idempotent, so the build
 *  re-runs it (and so realises a set requested before the layer existed). */
function reconcileLinkedOverlay(): void {
	if (!layerMap) {
		return;
	}
	linkedClones.sync(layerMap, linkedAirspaces);
}
