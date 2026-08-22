import L from 'leaflet';
import RBush from 'rbush';
import { pointInRing, type Airspace } from '$lib/data/airspaces';
import { bandIntersects } from '$lib/vertical/limits';
import type { AirspaceCategory, Publisher } from '$lib/state/layers.svelte';
import { activatedAirspaceLinks } from '$lib/state/notamLinks.svelte';
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
// applied at build and refreshed by updateAirspacePane on bucket changes.
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
	poly: L.Polygon;
}

let groups: Record<AirspaceCategory, L.LayerGroup> | null = null;
const entries: Entry[] = [];
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
// R-tree over per-row ring bboxes; replaces the linear scan over `entries`
// in airspaceAt. Built once at buildAirspaceLayer time.
let spatialIndex: RBush<AirspaceIndexEntry> | null = null;
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

/** Add or remove an entry's polygon from its category group to match the filter. */
function reconcileEntry(e: Entry): void {
	if (!groups) {
		return;
	}
	const g = groups[e.airspace.category];
	const should = entryPasses(e);
	const has = g.hasLayer(e.poly);
	if (should && !has) {
		g.addLayer(e.poly);
	} else if (!should && has) {
		g.removeLayer(e.poly);
	}
}

function ensurePane(map: L.Map): void {
	if (!map.getPane('airspaces')) {
		// Below the NOTAM areas (overlayPane z 400) and airports pane (400) so
		// airspaces read as background context.
		map.createPane('airspaces').style.zIndex = '350';
	}
}

/** Build the airspace polygons once, from the loaded dataset. */
export function buildAirspaceLayer(map: L.Map, airspaces: Airspace[]): void {
	if (groups) {
		return;
	}
	layerMap = map;
	ensurePane(map);
	const renderer = L.canvas({ pane: 'airspaces' });
	groups = {
		controlled: L.layerGroup(),
		restricted: L.layerGroup(),
		activity: L.layerGroup(),
		trafficmgmt: L.layerGroup(),
		transit: L.layerGroup(),
		siv: L.layerGroup(),
		fir: L.layerGroup(),
	};
	const indexEntries: AirspaceIndexEntry[] = new Array<AirspaceIndexEntry>(airspaces.length);
	for (let i = 0; i < airspaces.length; i++) {
		const airspace = airspaces[i];
		// interactive:false; the airspace pane sits below the NOTAM canvas;
		// clicks are hit-tested manually (airspaceAt) so airspaces never shadow
		// NOTAM or airport clicks.
		const poly = L.polygon(airspace.ring, {
			pane: 'airspaces',
			renderer,
			interactive: false,
			...baseStyle(airspace),
		});
		const entry: Entry = { airspace, poly };
		entries.push(entry);
		byKey.set(airspace.key, entry);
		groups[airspace.category].addLayer(poly);
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
	// Apply any altitude filter that was set before the layer was built.
	for (const e of entries) {
		reconcileEntry(e);
	}
	// Draw any NOTAM-linked highlight set requested before the build.
	reconcileLinkedOverlay();
}

/** Drop every module-level Leaflet handle so a rebuilt map starts clean:
 *  buildAirspaceLayer early-returns on the stale `groups` after an HMR /
 *  test remount, leaving every polygon bound to the destroyed map (the new
 *  map then renders no airspaces). The Layers-tab preferences
 *  (publisherVisible, categoryOn, altitudeBand) survive; MapView's effects
 *  re-apply them after the rebuild. Called from MapView's teardown. */
export function clearAirspaceLayer(): void {
	groups = null;
	entries.length = 0;
	byKey.clear();
	spatialIndex = null;
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
	for (const e of entries) {
		reconcileEntry(e);
	}
	refreshAirspaceOrder(map);
}

/** Show or hide every airspace from a single publisher (SIA France, NATS UK,
 *  ENAIRE Spain, pruatlas, FAA). Each entry is reconciled in place; the
 *  category LayerGroup membership stays the same. */
export function setAirspacePublisher(
	map: L.Map,
	publisher: Publisher,
	visible: boolean,
): void {
	publisherVisible[publisher] = visible;
	for (const e of entries) {
		if (e.airspace.source === publisher) {
			reconcileEntry(e);
		}
	}
	refreshAirspaceOrder(map);
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
		g.addTo(map);
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
	refreshAirspaceOrder(map);
}

/** Restrict the airspace layer to the airspaces the active route crosses (an
 *  override: forces every category group on and gates each polygon to `keys`),
 *  or pass null to clear the filter and restore the Layers-tab category toggles.
 *  Mirrors setAirspaceAltitudeFilter / setAirspacePublisher: flip the module
 *  state, reconcile every entry, and re-stack. */
export function setRouteAirspaceFilter(map: L.Map, keys: Set<string> | null): void {
	routeOnly = keys !== null;
	routeKeys = keys;
	for (const c of CATEGORIES) {
		applyCategory(map, c);
	}
	for (const e of entries) {
		reconcileEntry(e);
	}
	refreshAirspaceOrder(map);
}

/** Re-stack visible airspaces so the smallest outline stays on top. */
export function refreshAirspaceOrder(map: L.Map): void {
	if (!groups) {
		return;
	}
	const g = groups;
	const visible = entries.filter((e) => map.hasLayer(g[e.airspace.category]));
	visible.sort((a, b) => b.airspace.area - a.airspace.area);
	for (const e of visible) {
		e.poly.bringToFront();
	}
	for (const key of highlightedKeys) {
		byKey.get(key)?.poly.bringToFront();
	}
	refreshHighlightOverlay();
	reconcileLinkedOverlay();
}

/** Hide the whole airspace pane at very low zoom, and re-stroke every
 *  polygon when the zoom crosses a line-weight bucket (the chart look is
 *  pinned at z10; below it boundary strokes thin with the map). */
export function updateAirspacePane(map: L.Map): void {
	const pane = map.getPane('airspaces');
	if (pane) {
		pane.style.display = map.getZoom() <= 4 ? 'none' : '';
	}
	const f = lineZoomFactor(map.getZoom());
	if (f !== lineFactor) {
		lineFactor = f;
		for (const e of entries) {
			// Keep the live emphasis: restyling the highlighted polygon with
			// baseStyle would silently drop the selection until it changes
			// (highlightAirspace early-returns on an unchanged key).
			if (highlightedKeys.includes(e.airspace.key)) {
				continue;
			}
			e.poly.setStyle(baseStyle(e.airspace));
		}
	}
}

export function anyAirspaceVisible(map: L.Map): boolean {
	if (!groups) {
		return false;
	}
	const g = groups;
	return CATEGORIES.some((c) => map.hasLayer(g[c]));
}

/** The airspaces airspaceDecoLayer.ts decorates this repaint: every row in
 *  the padded viewport whose category group is on the map AND whose polygon
 *  passed the per-entry filters (altitude band, publisher, route filter;
 *  `g[cat].hasLayer(poly)` is exactly `reconcileEntry`'s outcome, i.e. the
 *  `entryPasses` chokepoint), so bands / hatches / combs / dots / glyphs /
 *  labels show and hide in exact lockstep with the boundary. Sorted largest
 *  area first, mirroring the polygon stacking, so small zones paint last and
 *  stay readable on top. */
export function visibleDecoratedAirspaces(map: L.Map): Airspace[] {
	if (!groups || !spatialIndex) {
		return [];
	}
	const g = groups;
	const b = map.getBounds().pad(0.05);
	const candidates = spatialIndex.search({
		minX: b.getWest(),
		minY: b.getSouth(),
		maxX: b.getEast(),
		maxY: b.getNorth(),
	});
	const out: Airspace[] = [];
	for (const c of candidates) {
		const e = c.entry;
		const group = g[e.airspace.category];
		if (map.hasLayer(group) && group.hasLayer(e.poly)) {
			out.push(e.airspace);
		}
	}
	out.sort((x, y) => y.area - x.area);
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
	if (!groups || !spatialIndex || map.getZoom() <= 4) {
		return [];
	}
	const g = groups;
	// Activated airspaces are rendered by activationLayer (stripe overlay)
	// regardless of category visibility or altitude band, so include them in
	// the hit-test even when their category toggle is off; the user sees the
	// stripes and expects them to be clickable, especially when a NOTAM area
	// sits on top.
	const activated = activatedAirspaceLinks();
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
		const inVisibleCategory =
			map.hasLayer(g[e.airspace.category]) &&
			g[e.airspace.category].hasLayer(e.poly);
		// Activated airspaces (stripe overlay), the airspaces a selected
		// NOTAM references (highlight clones, linkedClones), the
		// navigation-mode contact emphasis (navContactLayer clones) AND the
		// live alert emphasis (navAlertLayer clones) stay hit-testable even
		// with their category toggle off: the user sees them highlighted and
		// expects to click them. The linked, contact and alert clones are
		// keyed by row `key`, activated by shared `id`.
		if (
			!inVisibleCategory &&
			!activated.has(e.airspace.id) &&
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
		const e = byKey.get(key);
		if (e) {
			e.poly.setStyle(baseStyle(e.airspace));
		}
	}
	highlightedKeys = [...keys];
	for (const key of keys) {
		const e = byKey.get(key);
		if (e) {
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
		if (e && !m.hasLayer(e.poly)) {
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
 *  so buildAirspaceLayer / refreshAirspaceOrder can re-run it after a build or
 *  reorder (and to realise a set requested before the layer existed). */
function reconcileLinkedOverlay(): void {
	if (!layerMap) {
		return;
	}
	linkedClones.sync(layerMap, linkedAirspaces);
}
