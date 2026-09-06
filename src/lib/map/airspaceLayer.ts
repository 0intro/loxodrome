import L from 'leaflet';
import RBush from 'rbush';
import { pointInRing, type Airspace } from '$lib/data/airspaces';
import { bandIntersects } from '$lib/vertical/limits';
import type { AirspaceCategory, Publisher } from '$lib/state/layers.svelte';
import { isActivationDrawn } from './activationLayer';
import { lineZoomFactor, polygonStyle, polygonHighlightStyle } from './airspaceSymbology';
import { createCloneLayer } from './emphasisClones';
import { navContactKeys } from './navContactLayer';
import { navAlertKeys } from './navAlertLayer';

// rbush entry: the airspace's lat/lon bbox plus a back-reference to the
// Entry (poly + airspace) so hit-tests can run the per-row visibility
// checks without an extra Map lookup.
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

/* Styling is per FEATURE, not per category: airspaceSymbology.ts resolves
 * each row's SIA 1:500 000 chart symbol (chart-faithful: boundaries only,
 * never a resting interior fill; CTR / SIV / DLG-ATS rest strokeless because
 * the chart marks those boundaries with the canvas band / dots / comb that
 * airspaceDecoLayer.ts draws). */

/** Resting style for an airspace polygon (the SIA boundary stroke). */
// Stroke weights follow the chart's zoom scaling (chart-true at z10);
// applied on attach and refreshed by updateAirspaceViewport on bucket changes.
let lineFactor = 1;

function baseStyle(a: Airspace): L.PathOptions {
	const style = polygonStyle(a);
	if (a.arcs && a.category === 'fir') {
		// Metro FIR with external arcs: BOTH boundary renditions live on
		// the deco canvas (bold ink + comb along the arcs, the grey
		// FIR-limit form along the internal chains, drawn ABOVE the
		// airspace strokes so the grey line stays visible where sector
		// edges ride the same boundary); the polygon strokes nothing.
		// Hit-test and highlight are unaffected.
		style.stroke = false;
	}
	if (lineFactor !== 1) {
		if (typeof style.weight === 'number') {
			style.weight *= lineFactor;
		}
		if (typeof style.dashArray === 'string') {
			style.dashArray = style.dashArray
				.split(' ')
				.map((v) => String(Number(v) * lineFactor))
				.join(' ');
		}
	}
	return style;
}

/** Emphasised (hover / selected) style: always stroked, interior tinted, in
 *  the airspace's SIA family colour; also used for the standalone clones
 *  drawn when the layer is off. */
function highlightStyle(a: Airspace): L.PathOptions {
	return polygonHighlightStyle(a);
}

interface Entry {
	airspace: Airspace;
	/** Materialised the first time the row is attached, and kept for reuse.
	 *  Null until then, and again after clearAirspaceLayer. A row the viewport
	 *  never reaches this session never allocates one, which is most of them:
	 *  at a phone viewport, 0.5 to 2 % of the loaded ring vertices are on
	 *  screen between z9 and z11. Dropping it on cull-out would make every
	 *  re-entry re-run _convertLatLngs over the whole ring for nothing. */
	poly: L.Polygon | null;
}

let groups: Record<AirspaceCategory, L.LayerGroup> | null = null;
// Keyed by airspace.key (not id) so MOA parent + exclusion rows that share
// the same designation each get their own per-row entry.
const byKey = new Map<string, Entry>();
// The emphasised airspaces (hovered or selected). A SET because one nav-log
// enroute frequency line can name several sectors sharing that frequency
// ("SIV SEINE 1 / 2 / 3"); a selection and every other hover pass exactly one.
let highlightedKeys: readonly string[] = [];
// The map, captured at build time so highlightAirspace can manage its overlay
// clone without every caller (detail-panel rows, context menu, selection)
// threading the map through.
let layerMap: L.Map | null = null;
// Standalone clones of the emphasised airspaces, drawn for those whose own
// polygon is hidden (category / publisher / altitude filter) so a highlight
// from a detail-panel row, the context menu, a nav-log frequency line or the
// vertical profile is always visible on the map. The keyed want-set reconcile
// is the shared emphasis-clone one, same pane and renderer as linkedClones
// below. Deliberately NOT in airspaceAt's hit-test exception chain: a
// highlighted airspace has never been clickable through its clone.
const highlightClones = createCloneLayer<Airspace>({
	pane: 'airspaces',
	paneZ: '350',
	keyOf: (a) => a.key,
	geometryOf: (a, opts) => L.polygon(a.ring, opts),
	styleOf: (a) => highlightStyle(a),
	sharedPaneRenderer: true,
	frontOnSync: true,
});
// Standalone clones of the airspaces a selected NOTAM affects (its named
// TMA / CTA / CTR or SIV sectors). Drawn regardless of category / publisher /
// altitude so the set shows even with the airspace layers off; decoupled from
// the single highlightedKey above so the two never fight over a polygon style.
// The keyed want-set reconcile is the shared emphasis-clone one; these clones
// live in the 'airspaces' pane on its IMPLICIT renderer (shared with the
// highlight clone above, one SVG so bringToFront interleaves them) and are
// re-fronted on every sync so a base-polygon reorder never buries them.
let linkedAirspaces: Airspace[] = [];
const linkedClones = createCloneLayer<Airspace>({
	pane: 'airspaces',
	paneZ: '350',
	keyOf: (a) => a.key,
	geometryOf: (a, opts) => L.polygon(a.ring, opts),
	styleOf: (a) => highlightStyle(a),
	sharedPaneRenderer: true,
	frontOnSync: true,
});
// R-tree over per-row ring bboxes: the hit-test's point query, and the
// viewport query the cull runs. Built at buildAirspaceLayer time and rebuilt
// whenever the dataset array is republished (a late country arriving).
let spatialIndex: RBush<AirspaceIndexEntry> | null = null;
// The dataset array the index was built from: a different identity handed
// to buildAirspaceLayer means the rows changed under the layer.
let indexedRows: Airspace[] | null = null;
// Set by applyCategory when it puts a group back on the map: Leaflet appends
// the group's members to the canvas draw list in their own order, so the
// next reconcile must restack even if the viewport did not move.
let stackDirty = false;
// The canvas renderer every polygon shares, kept so a lazily materialised
// polygon lands on the same one.
let renderer: L.Canvas | null = null;
// The entries currently in their category group, ordered largest ring area
// first (the smallest-on-top stacking order). This IS the drawn set, so
// visibleDecoratedAirspaces hands it to the decoration layer directly rather
// than computing a second set that has to agree with it.
let attached: Entry[] = [];
// Leaflet's own canvas padding: the renderer covers the viewport plus this
// fraction on every side, and a drag reveals that halo before moveend lands.
// The cull window must be at least as wide or a drag exposes a strip with no
// boundary in it.
const RENDERER_PAD = 0.1;
// Cull window, >= RENDERER_PAD. The extra width is hysteresis: a quarter of a
// viewport of panning re-attaches nothing.
const CULL_PAD = 0.25;
// Below this zoom the pane is hidden (updateAirspaceViewport), the hit-test
// returns nothing and the decoration layer draws nothing, so nothing should
// be attached either. It is also the worst case for the cull: at a
// continental view every row is inside the viewport.
const LOW_ZOOM_HIDE = 4;
let altitudeBand: { floor: number; ceiling: number } | null = null;
// Default: every publisher visible. setAirspacePublisher flips entries
// off as the user toggles individual publishers in the Layers tab;
// mirrors the default in layers.svelte.ts.
const publisherVisible: Record<Publisher, boolean> = {
	fr: true,
	uk: true,
	es: true,
	be: true,
	de: true,
	at: true,
	pruatlas: true,
	faa: true,
	sk: true,
	ie: true,
	rs: true,
	xk: true,
	ge: true,
	nl: true,
	ch: true,
	fi: true,
	it: true,
};
// Route-airspaces-only filter (the Route tab "Route airspaces only" toggle).
// When active, the layer shows ONLY the airspaces the active route crosses
// (routeKeys), across every category: setRouteAirspaceFilter forces all category
// groups onto the map and entryPasses gates each polygon to the set, so the
// toggle overrides the Layers-tab category toggles. Null/false restores them.
let routeOnly = false;
let routeKeys: Set<string> | null = null;
// Desired per-category visibility from the Layers tab, recorded so the route
// filter can force every group on and then restore the user's choice when it
// clears. Effective group membership is `routeOnly || categoryOn[cat]`.
const categoryOn: Record<AirspaceCategory, boolean> = {
	controlled: false,
	restricted: false,
	activity: false,
	trafficmgmt: false,
	transit: false,
	siv: false,
	fir: false,
};

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

/** Combined per-entry visibility: passes the altitude band AND its publisher is
 *  enabled in the Layers tab AND, when the route filter is active, the airspace
 *  is one the active route crosses. Category visibility is handled at the
 *  LayerGroup level (whole group added/removed from the map). */
function entryPasses(e: Entry): boolean {
	return (
		entryPassesAltitude(e) &&
		publisherVisible[e.airspace.source] &&
		(!routeOnly || (routeKeys?.has(e.airspace.key) ?? false))
	);
}

/** Would this row be DRAWN if the map were looking at it: it passes the
 *  per-row filters AND its category group is on the map.
 *
 *  This is what `group.hasLayer(entry.poly)` used to mean. Since the viewport
 *  cull, group membership ALSO encodes "in the cull window", which is a
 *  rendering detail no caller should see: the hit-test and the decoration set
 *  ask this instead, so "left-click stays visibility-gated" keeps meaning the
 *  filters and the toggle, never where the map happens to be pointing. */
function entryShown(map: L.Map, e: Entry): boolean {
	return !!groups && entryPasses(e) && map.hasLayer(groups[e.airspace.category]);
}

/** The rbush rectangle covering the padded viewport, or null below the
 *  pane's zoom floor, where nothing draws.
 *
 *  The query is the map's UNWRAPPED bounds, clipped to the world, because
 *  that is Leaflet's drawing space for vectors: SphericalMercator projects a
 *  polygon at its raw longitude and never onto a world copy, so a viewport
 *  panned a world past the seam (centre at 172 + 360) shows the wrapped
 *  TILES of New Zealand and none of its airspaces, whatever is attached.
 *  Wrapping the window to match those rows would attach polygons that
 *  project 360 degrees off screen: work for nothing. */
function cullWindow(map: L.Map): { minX: number; minY: number; maxX: number; maxY: number } | null {
	if (map.getZoom() <= LOW_ZOOM_HIDE) {
		return null;
	}
	const b = map.getBounds().pad(CULL_PAD);
	const minX = Math.max(-180, b.getWest());
	const maxX = Math.min(180, b.getEast());
	if (minX > maxX) {
		return null;
	}
	return {
		minX,
		minY: Math.max(-90, b.getSouth()),
		maxX,
		maxY: Math.min(90, b.getNorth()),
	};
}

/** Reconcile which entries are attached to their category group: those that
 *  pass the per-row filters and lie in the padded viewport.
 *
 *  Runs over ALL seven groups, on or off the map. LayerGroup.addLayer only
 *  forwards to the map while the group itself is on it, so an off category's
 *  membership is still the record the toggle re-attaches in bulk; leaving it
 *  stale would put the whole dataset back on the map at the first checkbox
 *  click, which is the long task this cull exists to remove. */
function reconcileViewport(map: L.Map): void {
	if (!groups || !spatialIndex) {
		return;
	}
	const g = groups;
	const want: Entry[] = [];
	const wantSet = new Set<Entry>();
	const rect = cullWindow(map);
	if (rect) {
		for (const c of spatialIndex.search(rect)) {
			const e = c.entry;
			if (!wantSet.has(e) && entryPasses(e)) {
				wantSet.add(e);
				want.push(e);
			}
		}
	}
	const had = new Set<Entry>(attached);
	for (const e of attached) {
		if (!wantSet.has(e) && e.poly) {
			g[e.airspace.category].removeLayer(e.poly);
		}
	}
	let added = 0;
	for (const e of want) {
		if (had.has(e)) {
			continue;
		}
		const poly =
			e.poly ??
			// interactive:false; the airspace pane sits below the NOTAM canvas;
			// clicks are hit-tested manually (airspaceAt) so airspaces never
			// shadow NOTAM or airport clicks.
			L.polygon(e.airspace.ring, {
				pane: 'airspaces',
				renderer: renderer ?? undefined,
				interactive: false,
			});
		e.poly = poly;
		// Styled on every attach, and highlight-aware. Both halves matter: the
		// zoom line-weight factor may have moved while the row was off screen,
		// and a SELECTED row that panned out (drawn as a clone meanwhile) must
		// come back wearing its emphasis, or refreshHighlightOverlay would drop
		// the clone as redundant and the highlight would be gone for good
		// (highlightAirspaces early-returns on an unchanged key set).
		poly.setStyle(
			highlightedKeys.includes(e.airspace.key)
				? highlightStyle(e.airspace)
				: baseStyle(e.airspace),
		);
		g[e.airspace.category].addLayer(poly);
		added++;
	}
	want.sort((x, y) => y.airspace.area - x.airspace.area);
	attached = want;
	// Removals preserve the relative order of what stays, so only an addition
	// can break the smallest-on-top stack: Leaflet's canvas draw order is a
	// linked list whose only public mutator appends at the end. A category
	// group coming back onto the map is such an addition too (applyCategory
	// marks it), whether or not the viewport moved.
	if (added > 0 || stackDirty) {
		stackDirty = false;
		restack(map);
	}
	refreshHighlightOverlay();
	reconcileLinkedOverlay();
}

function ensurePane(map: L.Map): void {
	if (!map.getPane('airspaces')) {
		// Below the NOTAM areas (overlayPane z 400) and airports pane (400) so
		// airspaces read as background context.
		map.createPane('airspaces').style.zIndex = '350';
	}
}

/** Build the airspace layer from the loaded dataset, or, built already and
 *  handed a DIFFERENT array (the dataset re-merged after a late country
 *  arrived: state/coverage loads publishers by area, docs/data-coverage.md),
 *  re-index the rows under it. Without the re-index the boundary layer, the
 *  decorations, the hit-test and the selection lookup would all stay bound to
 *  the first array for the session while every other reader saw the new one. */
export function buildAirspaceLayer(map: L.Map, airspaces: Airspace[]): void {
	if (groups) {
		if (airspaces !== indexedRows) {
			reindex(map, airspaces);
		}
		return;
	}
	layerMap = map;
	ensurePane(map);
	// padding stated rather than defaulted, because the cull window is pinned
	// to it (CULL_PAD >= RENDERER_PAD).
	renderer = L.canvas({ pane: 'airspaces', padding: RENDERER_PAD });
	groups = {
		controlled: L.layerGroup(),
		restricted: L.layerGroup(),
		activity: L.layerGroup(),
		trafficmgmt: L.layerGroup(),
		transit: L.layerGroup(),
		siv: L.layerGroup(),
		fir: L.layerGroup(),
	};
	// Index every row; materialise no polygon. byKey stays complete over the
	// whole dataset (the selection lookup and the decoration layer's
	// unconditional highlight pass both need every row, drawn or not), and the
	// rbush is built from the row's own bbox, so neither needs geometry.
	const indexEntries: AirspaceIndexEntry[] = new Array<AirspaceIndexEntry>(airspaces.length);
	for (let i = 0; i < airspaces.length; i++) {
		const airspace = airspaces[i];
		const entry: Entry = { airspace, poly: null };
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
	// A resize fires immediately while its moveend is debounced 200 ms behind
	// (Map._onResize -> invalidateSize({ debounceMoveend: true })), so the
	// decoration layer would repaint against the new viewport with the cull
	// still on the old one. Registered HERE, before MapView builds the
	// decoration layer, so Leaflet's registration-order dispatch guarantees
	// the cull runs first for that event too.
	map.on('resize', onMapResize);
	// Attach whatever the current viewport and the pre-build filter choices
	// ask for, and draw any NOTAM-linked highlight requested before the build.
	reconcileViewport(map);
}

function onMapResize(): void {
	if (layerMap) {
		reconcileViewport(layerMap);
	}
}

/** Rebuild byKey and the rbush from a republished dataset array. An entry
 *  whose row object survived (same key, same reference) keeps its polygon
 *  and its attachment; every other attached polygon is detached, since its
 *  row is gone or replaced. The reconcile that follows attaches whatever
 *  the new rows owe the viewport, restacked. */
function reindex(map: L.Map, airspaces: Airspace[]): void {
	if (!groups) {
		return;
	}
	const g = groups;
	const prev = new Map(byKey);
	byKey.clear();
	const indexEntries: AirspaceIndexEntry[] = new Array<AirspaceIndexEntry>(airspaces.length);
	const kept = new Set<Entry>();
	for (let i = 0; i < airspaces.length; i++) {
		const airspace = airspaces[i];
		const old = prev.get(airspace.key);
		const entry: Entry = old && old.airspace === airspace ? old : { airspace, poly: null };
		if (entry === old) {
			kept.add(entry);
		}
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
	for (const e of attached) {
		if (!kept.has(e) && e.poly) {
			g[e.airspace.category].removeLayer(e.poly);
		}
	}
	attached = attached.filter((e) => kept.has(e));
	spatialIndex = new RBush<AirspaceIndexEntry>();
	spatialIndex.load(indexEntries);
	indexedRows = airspaces;
	stackDirty = true;
	reconcileViewport(map);
}

/** Drop every module-level Leaflet handle so a rebuilt map starts clean:
 *  buildAirspaceLayer early-returns on the stale `groups` after an HMR /
 *  test remount, leaving every polygon bound to the destroyed map (the new
 *  map then renders no airspaces). The Layers-tab preferences
 *  (publisherVisible, categoryOn, altitudeBand) survive; MapView's effects
 *  re-apply them after the rebuild. Called from MapView's teardown. */
export function clearAirspaceLayer(): void {
	// Before layerMap goes: the resize handler is the one listener this module
	// owns, and leaving it bound would pin a remounted component to the dead map.
	layerMap?.off('resize', onMapResize);
	groups = null;
	attached = [];
	renderer = null;
	byKey.clear();
	spatialIndex = null;
	indexedRows = null;
	stackDirty = false;
	layerMap = null;
	highlightedKeys = [];
	highlightClones.reset();
	linkedAirspaces = [];
	linkedClones.reset();
	onHighlightChange = null;
	routeOnly = false;
	routeKeys = null;
	lineFactor = 1;
}

/** Update the altitude filter applied to airspaces; pass null to clear. */
export function setAirspaceAltitudeFilter(
	map: L.Map,
	band: { floor: number; ceiling: number } | null,
): void {
	altitudeBand = band;
	reconcileViewport(map);
}

/** Show or hide every airspace from a single publisher (SIA France, NATS UK,
 *  ENAIRE Spain, pruatlas, FAA). The category LayerGroup membership stays the
 *  same; only which rows sit in it changes. */
export function setAirspacePublisher(
	map: L.Map,
	publisher: Publisher,
	visible: boolean,
): void {
	publisherVisible[publisher] = visible;
	reconcileViewport(map);
}

/** Reconcile one category's LayerGroup membership against its effective
 *  visibility: the route filter (when active) forces every group on; otherwise
 *  the Layers-tab choice recorded in categoryOn decides. */
function applyCategory(map: L.Map, cat: AirspaceCategory): void {
	if (!groups) {
		return;
	}
	const g = groups[cat];
	const on = routeOnly || categoryOn[cat];
	if (on && !map.hasLayer(g)) {
		// LayerGroup.onAdd adds its members in THEIR order (first
		// materialised first), not largest-first: the next reconcile must
		// restack even when the viewport stands still, or the newly shown
		// category paints over every other one and over a selection's fill.
		g.addTo(map);
		stackDirty = true;
	} else if (!on && map.hasLayer(g)) {
		g.remove();
	}
}

/** Show or hide a single airspace category (the Layers-tab toggle). Records the
 *  choice so the route filter can later restore it, then applies the effective
 *  visibility. */
export function setAirspaceCategory(
	map: L.Map,
	cat: AirspaceCategory,
	visible: boolean,
): void {
	if (!groups) {
		return;
	}
	categoryOn[cat] = visible;
	applyCategory(map, cat);
	reconcileViewport(map);
}

/** Restrict the airspace layer to the airspaces the active route crosses (an
 *  override: forces every category group on and gates each polygon to `keys`),
 *  or pass null to clear the filter and restore the Layers-tab category toggles.
 *  Mirrors setAirspaceAltitudeFilter / setAirspacePublisher: flip the module
 *  state and reconcile. */
export function setRouteAirspaceFilter(map: L.Map, keys: Set<string> | null): void {
	routeOnly = keys !== null;
	routeKeys = keys;
	for (const c of CATEGORIES) {
		applyCategory(map, c);
	}
	reconcileViewport(map);
}

/** Re-stack the attached airspaces so the smallest outline stays on top.
 *  `attached` is already ordered largest area first, and a newly added path
 *  always lands at the end of the canvas renderer's draw list, so one pass of
 *  bringToFront in that order restores the stack. Bounded by the viewport
 *  rather than the dataset: at a planning zoom that is a couple of hundred
 *  rows, not ten thousand. */
function restack(map: L.Map): void {
	if (!groups) {
		return;
	}
	const g = groups;
	for (const e of attached) {
		if (e.poly && map.hasLayer(g[e.airspace.category])) {
			e.poly.bringToFront();
		}
	}
	for (const key of highlightedKeys) {
		byKey.get(key)?.poly?.bringToFront();
	}
}

/** Hide the whole airspace pane at very low zoom, reconcile which rows the
 *  viewport wants, and re-stroke when the zoom crosses a line-weight bucket
 *  (the chart look is pinned at z10; below it boundary strokes thin with the
 *  map). Called on every settled view change. */
export function updateAirspaceViewport(map: L.Map): void {
	const pane = map.getPane('airspaces');
	if (pane) {
		pane.style.display = map.getZoom() <= LOW_ZOOM_HIDE ? 'none' : '';
	}
	// The factor is set BEFORE the cull, so a row attaching in this same pass
	// is styled at the new weight straight away.
	const f = lineZoomFactor(map.getZoom());
	const changed = f !== lineFactor;
	lineFactor = f;
	reconcileViewport(map);
	if (!changed) {
		return;
	}
	for (const e of attached) {
		// Keep the live emphasis: restyling the highlighted polygon with
		// baseStyle would silently drop the selection until it changes
		// (highlightAirspace early-returns on an unchanged key).
		if (highlightedKeys.includes(e.airspace.key)) {
			continue;
		}
		e.poly?.setStyle(baseStyle(e.airspace));
	}
}

/** The airspaces airspaceDecoLayer.ts decorates this repaint: THE ATTACHED
 *  SET, filtered to the categories on the map.
 *
 *  Lockstep with the boundary (the contract) is by identity rather than by
 *  agreement: these are the very rows whose polygons are drawn, in the order
 *  they are stacked (largest area first, so small zones paint last and stay
 *  readable on top). Two computations that merely agree are weaker, and the
 *  ordering dependency this creates is satisfied by construction, since
 *  buildAirspaceLayer registers its viewport handler before MapView builds
 *  the decoration layer. Even a violation would leave the boundary and the
 *  decoration one frame stale TOGETHER, which still honours lockstep. */
export function visibleDecoratedAirspaces(map: L.Map): Airspace[] {
	if (!groups) {
		return [];
	}
	const g = groups;
	const out: Airspace[] = [];
	for (const e of attached) {
		if (map.hasLayer(g[e.airspace.category])) {
			out.push(e.airspace);
		}
	}
	return out;
}

/** The hovered / selected airspaces, for the decoration layer's unconditional
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

// Notifies airspaceDecoLayer.ts (registered at its build) that the
// highlighted airspace changed, so the decoration emphasis follows hover /
// selection without MapView threading a redraw through every call site.
let onHighlightChange: (() => void) | null = null;

export function setAirspaceHighlightListener(fn: (() => void) | null): void {
	onHighlightChange = fn;
}

function visibleEntriesAt(map: L.Map, lat: number, lon: number): Entry[] {
	if (!groups || !spatialIndex || map.getZoom() <= LOW_ZOOM_HIDE) {
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
		const inVisibleCategory = entryShown(map, e);
		// Activated airspaces (stripe overlay), the airspaces a selected
		// NOTAM references (highlight clones, linkedClones), the
		// navigation-mode contact emphasis (navContactLayer clones) AND the
		// live alert emphasis (navAlertLayer clones) stay hit-testable even
		// with their category toggle off: the user sees them highlighted and
		// expects to click them. The linked, contact and alert clones are
		// keyed by row `key`, activated by shared `id`.
		//
		// Every one of the four asks the DRAWN layer, never a fresh
		// derivation: this runs per pointer move, and re-deriving the
		// activation set here re-scanned the whole briefing and re-parsed
		// each NOTAM's text on every frame.
		if (
			!inVisibleCategory &&
			!isActivationDrawn(e.airspace.id) &&
			!linkedClones.keys().has(e.airspace.key) &&
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

/** The smallest visible airspace containing the point, or null. */
export function airspaceAt(map: L.Map, lat: number, lon: number): Airspace | null {
	let hit: Entry | null = null;
	for (const e of visibleEntriesAt(map, lat, lon)) {
		if (!hit || e.airspace.area < hit.airspace.area) {
			hit = e;
		}
	}
	return hit ? hit.airspace : null;
}

/** Highlight one airspace's outline: the hovered detail-panel / context-menu
 *  row, or the selected airspace. Takes the per-row `key`, not the shared
 *  `id`. Pass null to clear. */
export function highlightAirspace(key: string | null): void {
	highlightAirspaces(key ? [key] : []);
}

/** Highlight a SET of airspaces at once, for a row that names several: a
 *  nav-log enroute frequency line merges every sector sharing that frequency.
 *  Also refreshes the overlay clones so the highlight shows even when an
 *  airspace's category / publisher / altitude filter hides its real polygon.
 *  Pass an empty list to clear. */
export function highlightAirspaces(keys: readonly string[]): void {
	if (keys.length === highlightedKeys.length && keys.every((k, i) => highlightedKeys[i] === k)) {
		return;
	}
	const wanted = new Set(keys);
	// Restyle only the ones actually leaving: re-styling a key present in both
	// sets would flicker it back to base for a frame.
	for (const key of highlightedKeys) {
		if (wanted.has(key)) {
			continue;
		}
		const p = byKey.get(key)?.poly;
		if (p) {
			p.setStyle(baseStyle(byKey.get(key)!.airspace));
		}
	}
	highlightedKeys = [...keys];
	for (const key of keys) {
		const e = byKey.get(key);
		// Never materialise here: a row highlighted from a panel on the other
		// side of the country is not in the cull window, so a polygon made now
		// would be attached to a group it does not belong in and removed by the
		// next reconcile. refreshHighlightOverlay clones it instead, which is
		// the same answer it already gives for a filtered-out row.
		if (e?.poly) {
			e.poly.setStyle(highlightStyle(e.airspace));
			e.poly.bringToFront();
		}
	}
	refreshHighlightOverlay();
	onHighlightChange?.();
}

/** Reconcile the highlight clones against the emphasised airspaces' current
 *  on-map visibility. Idempotent: the shared keyed reconcile rebuilds only what
 *  changed and keeps the clones on top after a reorder. A clone makes a
 *  highlight (hovered row, context-menu row, nav-log frequency line, or
 *  selected airspace) visible even when the airspace's category / publisher /
 *  altitude filter hides its real polygon, so hovering an airspace row in a
 *  NOTAM panel shows it on the map with the airspace layers off. */
function refreshHighlightOverlay(): void {
	const m = layerMap;
	if (!m) {
		return;
	}
	// Clone only the ones whose real polygon isn't already drawn; a drawn
	// polygon carries the emphasis in its own style.
	const hidden: Airspace[] = [];
	for (const key of highlightedKeys) {
		const e = byKey.get(key);
		// No polygon and a detached one are the same case: the row's own
		// geometry is not carrying the emphasis, so clone it. (hasLayer(null)
		// would throw; Leaflet stamps its argument.)
		if (e && (!e.poly || !m.hasLayer(e.poly))) {
			hidden.push(e.airspace);
		}
	}
	highlightClones.sync(m, hidden);
}

/** Highlight every airspace a selected NOTAM affects (its named TMA / CTA / CTR
 *  or SIV sectors), drawn as standalone clones so they show even with the
 *  airspace layers off. Pass null to clear. Decoupled from highlightAirspace's
 *  single hover / selection highlight, so the two never fight over a polygon's
 *  style. */
export function setLinkedAirspaces(airspaces: Airspace[] | null): void {
	linkedAirspaces = airspaces ?? [];
	reconcileLinkedOverlay();
}

/** Reconcile the NOTAM-linked highlight clones against the requested set:
 *  remove stale clones, clone any missing ones, keep them on top. Idempotent,
 *  so buildAirspaceLayer / reconcileViewport can re-run it after a build or a
 *  cull pass (and to realise a set requested before the layer existed). */
function reconcileLinkedOverlay(): void {
	if (!layerMap) {
		return;
	}
	linkedClones.sync(layerMap, linkedAirspaces);
}
