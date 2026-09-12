import L from 'leaflet';
import {
	hasDrawnExtent,
	notamFocusBbox,
	polygonAreaM2,
	type Bbox,
} from '$lib/notam/geometry';
import { radiusToNM } from '$lib/notam/radius';
import { NM_TO_METERS } from '$lib/notam/units';
import type { Notam, NotamCoordinate } from '$lib/notam/types';
import { type IndexedNotam } from '$lib/state/notam.svelte';
import { openNotamMenu } from '$lib/state/notamMenu.svelte';
import { selectNotam } from '$lib/state/ui.svelte';
import { fitBoundsVisible, flyToBoundsVisible } from './focus';
import { positionIcon } from './markerIcons';

const AREA_COLOR = '#ff7800';
const RADIUS_COLOR = '#f08000';
const QLINE_RADIUS_COLOR = '#1f5fbf';

/** How far a fit may zoom IN, so a small zone keeps its surroundings. The
 *  airspace crosshair caps at 12 and SUP AIP at 11; NOTAM geometry is
 *  smaller than either, so it frames one step closer. The fit itself always
 *  wins when it is wider, which is what puts a 20 NM circle on screen. */
const FOCUS_MAX_ZOOM = 13;

/** The same, for an entry that draws nothing but its pin: the box is a
 *  point, so nothing is ever wider and the cap IS the zoom. 13 landed such
 *  a NOTAM on a street with no aerodrome, CTR or neighbouring field round
 *  it, which is the whole of what an obstacle position has to say; 11, the
 *  SUP AIP crosshair's own cap, is about 70 km of map. A cluster of bare
 *  pins spread wider than that still fits, the cap only holding a tight
 *  one. */
const MARKER_FOCUS_ZOOM = 11;

/** Bbox as the Leaflet bounds pair the focus helpers take. */
function boundsOf(b: Bbox): L.LatLngBoundsLiteral {
	return [
		[b.minLat, b.minLon],
		[b.maxLat, b.maxLon],
	];
}

// NOTAM features render in their own pane, above the airspace (z 350) and
// airport (z 400) overlay panes so they always receive clicks; below the
// default markerPane (z 600).
const NOTAM_PANE = 'notams';

function ensureNotamPane(map: L.Map): void {
	if (!map.getPane(NOTAM_PANE)) {
		map.createPane(NOTAM_PANE).style.zIndex = '450';
	}
}

function areaStyle(highlight: boolean): L.PathOptions {
	return {
		color: AREA_COLOR,
		fillColor: AREA_COLOR,
		weight: highlight ? 3.5 : 2,
		fillOpacity: highlight ? 0.42 : 0.2,
	};
}

function circleStyle(color: string, highlight: boolean): L.PathOptions {
	return {
		color,
		fillColor: color,
		weight: highlight ? 3.5 : 2,
		fillOpacity: highlight ? 0.34 : 0.15,
	};
}

/** The Q-line / qualifier circles are a radius of influence (OPADD), not a
 *  charted boundary, so they wear a dashed edge distinct from the published
 *  circles; route/notamProfile.ts documents that look. */
function influenceCircleStyle(color: string): L.PathOptions {
	return { ...circleStyle(color, true), dashArray: '8 6' };
}

interface StyledPath {
	layer: L.Path;
	base: L.PathOptions;
	highlight: L.PathOptions;
}

/** A Q-line radius circle, stashed during render but only added to the map
 *  while its NOTAM is selected; Q-line radii can be ≥ 100 NM and would
 *  otherwise blanket the map. */
interface PendingCircle {
	center: L.LatLngTuple;
	radiusM: number;
	style: L.PathOptions;
}

/** One entry in a colocated-NOTAM stack; `index` indexes notamState.notams. */
interface MarkerStackEntry {
	notam: Notam;
	index: number;
	coord: NotamCoordinate;
}

let group: L.LayerGroup | null = null;
// The set last drawn. visibleNotams() rides the minute tick (the evaluation
// window's default end is open), so renderNotams is called once a minute with
// an unchanged set, and a rebuild is not free here: it tears down and recreates
// every polygon, circle and marker DOM node, which drops keyboard focus on a
// pin and replays the .notam-pin--selected transition. The items are compared
// by Notam IDENTITY, not by index: a fresh parse hands out new objects, so a
// re-parse that happens to yield the same count still redraws.
let mapRef: L.Map | null = null;
let drawnItems: IndexedNotam[] = [];
let drawnDisplaySig: string | null = null;

/** Same NOTAMs, same order, same indexes as the set already drawn? */
function sameItems(a: IndexedNotam[], b: IndexedNotam[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i].notam !== b[i].notam || a[i].index !== b[i].index) {
			return false;
		}
	}
	return true;
}
const pathsByIndex = new Map<number, StyledPath[]>();
// Markers per NOTAM index; the DOM element is kept across selection changes
// so the .notam-pin--selected toggle drives a smooth CSS transition.
const markersByIndex = new Map<number, L.Marker[]>();
const qlineCirclesByIndex = new Map<number, PendingCircle[]>();
// Q-line circles for position/area NOTAMs, sourced from notam.qualifier and
// shown only via the detail-panel "Show Q radius" toggle (panelQRadiusIndex).
// Kept separate from qlineCirclesByIndex so the blue Q-line-fallback path
// (auto-on-selection) never shows them.
const qualifierCircleByIndex = new Map<number, PendingCircle[]>();
let activeQlineCircles: L.Circle[] = [];
let highlightedIndex: number | null = null;
let qlineRadiusVisible = true;
// Position/area NOTAM whose qualifier circle the detail panel has toggled on.
let panelQRadiusIndex: number | null = null;
// Set by MapView when the selected NOTAM's affected airspaces replace its
// Q-line radius circle; suppresses the auto-on-selection blue circle.
let qlineSuppressedByAirspaces = false;
// Blue Q-line markers suppressed by "Hide airport NOTAM markers", keyed by NOTAM
// index, plus the single one currently revealed on the map. The revealed marker
// is shown only while its NOTAM is selected; see syncRevealedAirportMarker.
const suppressedAirportQline = new Map<number, { ll: L.LatLngTuple; id: string }>();
let revealedMarker: L.Marker | null = null;

/** Toggle the on-selection Q-line radius circle. Always re-runs the Q-line
 *  layer sync so a flip while a Q-line NOTAM is selected updates the map
 *  immediately, even if the in-memory flag was already in sync (defensive
 *  against HMR or stale state after a re-render). */
export function setQlineRadiusVisible(visible: boolean): void {
	qlineRadiusVisible = visible;
	syncQlineCircles();
}

/** Show the Q-line radius circle for a position/area NOTAM by index, or hide
 *  it with null. Driven by the detail-panel "Show Q radius" toggle; separate
 *  from the blue Q-line-fallback circle's on-selection behaviour above. */
export function setPanelQRadiusIndex(index: number | null): void {
	panelQRadiusIndex = index;
	syncQlineCircles();
}

/** Suppress the auto-on-selection blue Q-line-fallback circle because the
 *  selected NOTAM's affected airspaces are drawn instead. The detail-panel
 *  "Show Q radius" toggle still forces the circle on (see syncQlineCircles). */
export function setQlineRadiusSuppressed(suppressed: boolean): void {
	qlineSuppressedByAirspaces = suppressed;
	syncQlineCircles();
}

/** Reconcile the on-map Q-line radius circles against both triggers: the blue
 *  Q-line-fallback circle (selected NOTAM + the global Display toggle) and the
 *  position/area circle (the detail-panel "Show Q radius" toggle). Split out
 *  from applyHighlight so a toggle never touches path or marker styles. */
function syncQlineCircles(): void {
	if (!group) {
		// Nothing on the map yet; applyHighlight at end-of-render will reconcile.
		return;
	}
	for (const c of activeQlineCircles) {
		group.removeLayer(c);
	}
	activeQlineCircles = [];
	// Blue Q-line-fallback NOTAMs: auto-shown for the selected NOTAM unless the
	// global Display toggle is off or its affected airspaces replaced it; the
	// detail-panel "Show Q radius" toggle can force it on regardless.
	if (highlightedIndex != null) {
		const forced = panelQRadiusIndex === highlightedIndex;
		const auto = qlineRadiusVisible && !qlineSuppressedByAirspaces;
		if (forced || auto) {
			addQlineCircles(qlineCirclesByIndex.get(highlightedIndex));
		}
	}
	// Position / area NOTAMs: the one whose detail-panel toggle is on.
	if (panelQRadiusIndex != null) {
		addQlineCircles(qualifierCircleByIndex.get(panelQRadiusIndex));
	}
}

function addQlineCircles(pending: PendingCircle[] | undefined): void {
	if (!group || !pending) {
		return;
	}
	for (const p of pending) {
		const circle = L.circle(p.center, {
			pane: NOTAM_PANE,
			radius: p.radiusM,
			interactive: false,
			...p.style,
		});
		circle.addTo(group);
		activeQlineCircles.push(circle);
	}
}

/** Reveal the blue Q-line marker of the selected airport NOTAM whose marker is
 *  hidden by "Hide airport NOTAM markers". Shows only the one matching
 *  highlightedIndex and removes it as soon as the selection moves away. The
 *  suppressed set is repopulated each render, so calling this at end-of-render
 *  also re-creates the marker while a NOTAM stays selected. */
function syncRevealedAirportMarker(): void {
	if (!group) {
		return;
	}
	if (revealedMarker) {
		group.removeLayer(revealedMarker);
		revealedMarker = null;
	}
	if (highlightedIndex == null) {
		return;
	}
	const entry = suppressedAirportQline.get(highlightedIndex);
	if (!entry) {
		return;
	}
	const idx = highlightedIndex;
	const marker = L.marker(entry.ll, {
		icon: positionIcon('qualifierLine', '', false, 1),
	});
	marker.on('click', (e: L.LeafletMouseEvent) => {
		L.DomEvent.stopPropagation(e);
		selectNotam(idx);
	});
	marker.addTo(group);
	const el = marker.getElement();
	if (el) {
		el.classList.add('notam-pin--selected');
		// Focusable pin: name it like the stack markers (locale-invariant).
		el.setAttribute('aria-label', `NOTAM ${entry.id}`);
	}
	revealedMarker = marker;
}

function applyHighlight(): void {
	for (const [index, paths] of pathsByIndex) {
		const on = index === highlightedIndex;
		for (const p of paths) {
			p.layer.setStyle(on ? p.highlight : p.base);
		}
	}
	// Colocated NOTAMs share ONE stack marker (several indexes map to the
	// same L.Marker), so toggling per index would let a later index of the
	// stack clear the class the highlighted index just set. Collect the
	// highlighted index's markers first, then toggle each unique marker
	// once, by membership.
	const selected = new Set(
		highlightedIndex != null ? markersByIndex.get(highlightedIndex) ?? [] : [],
	);
	const seen = new Set<L.Marker>();
	for (const markers of markersByIndex.values()) {
		for (const marker of markers) {
			if (seen.has(marker)) {
				continue;
			}
			seen.add(marker);
			const el = marker.getElement();
			if (el) {
				el.classList.toggle('notam-pin--selected', selected.has(marker));
			}
		}
	}
	syncQlineCircles();
	syncRevealedAirportMarker();
}

function stackKey(c: NotamCoordinate): string {
	return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
}

function pushMarkerStack(
	stacks: Map<string, MarkerStackEntry[]>,
	c: NotamCoordinate,
	notam: Notam,
	index: number,
): void {
	const key = stackKey(c);
	let stack = stacks.get(key);
	if (!stack) {
		stack = [];
		stacks.set(key, stack);
	}
	stack.push({ notam, index, coord: c });
}

function pushCircleFeature(
	features: { index: number; size: number; styled: StyledPath }[],
	c: NotamCoordinate,
	index: number,
): void {
	if (c.radius == null || !c.radiusUnit) {
		return;
	}
	const color =
		c.type === 'qualifierLine' ? QLINE_RADIUS_COLOR : RADIUS_COLOR;
	const rMeters = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
	if (c.type === 'qualifierLine') {
		// Defer Q-line radii to selection; see qlineCirclesByIndex.
		let qArr = qlineCirclesByIndex.get(index);
		if (!qArr) {
			qArr = [];
			qlineCirclesByIndex.set(index, qArr);
		}
		qArr.push({
			center: [c.lat, c.lon],
			radiusM: rMeters,
			style: influenceCircleStyle(color),
		});
		return;
	}
	const base = circleStyle(color, false);
	const circle = L.circle([c.lat, c.lon], {
		pane: NOTAM_PANE,
		radius: rMeters,
		...base,
	}).on('click', (e: L.LeafletMouseEvent) => {
		// Don't let the click bubble to the map; see the same comment in
		// airportLayer.ts. Without this, the map's click handler runs
		// immediately after and airspaceAt() overwrites the selection with
		// an airspace sitting under the click.
		L.DomEvent.stopPropagation(e);
		selectNotam(index);
	});
	features.push({
		index,
		size: Math.PI * rMeters * rMeters,
		styled: { layer: circle, base, highlight: circleStyle(color, true) },
	});
}

/** Highlight the selected NOTAM's area/circle outline, or clear it with null. */
export function highlightNotam(index: number | null): void {
	if (highlightedIndex === index) {
		return;
	}
	highlightedIndex = index;
	applyHighlight();
}

/** Is this NOTAM entry drawn as an area polygon (vs point markers/circles)? */
function isAreaEntry(notam: Notam): boolean {
	return notam.isPolygon && notam.coordinates.length >= 3;
}

/** Marker pass: group point markers by lat/lon so colocated NOTAMs collapse
 *  to one pin with a count badge instead of stacking invisibly (key precision
 *  is 5 decimals, ~1 m, tighter than any real-world coincidence), then
 *  realise one marker per stack with the chooser click and the highlight
 *  index map. Also stashes the airport Q-line markers "Hide airport NOTAM
 *  markers" suppresses, for the on-selection reveal. */
function renderMarkerPass(
	items: IndexedNotam[],
	typeIcons: boolean,
	qlineMarkers: boolean,
	hideQlineMarkerIdx: Set<number>,
): void {
	if (!group) {
		return;
	}
	const stacksByKey = new Map<string, MarkerStackEntry[]>();
	for (const { notam, index } of items) {
		if (isAreaEntry(notam)) {
			continue;
		}
		for (const c of notam.coordinates) {
			// Q-line position markers are toggleable globally from the Display
			// tab (qlineMarkers); the blue Q-line marker of an airport NOTAM is
			// additionally suppressed when "Hide airport NOTAM markers" is on
			// (hideQlineMarkerIdx). A suppressed airport marker is stashed so it
			// can be revealed while its NOTAM is selected (see
			// syncRevealedAirportMarker). Either way the radius circle is still
			// deferred to qlineCirclesByIndex, so selecting the NOTAM from the
			// list panel still shows its qlineRadius circle. Red PSN markers,
			// radius circles, and area polygons are unaffected.
			const isQline = c.type === 'qualifierLine';
			const airportSuppressed = isQline && hideQlineMarkerIdx.has(index);
			const showQline = qlineMarkers && !hideQlineMarkerIdx.has(index);
			if (!isQline || showQline) {
				pushMarkerStack(stacksByKey, c, notam, index);
			} else if (airportSuppressed) {
				suppressedAirportQline.set(index, { ll: [c.lat, c.lon], id: notam.id });
			}
		}
	}

	// Realise one marker per (lat, lon) stack; colocated NOTAMs collapse
	// to a single pin with a count badge so a stack of N>1 is visible at
	// a glance and the click handler opens a chooser instead of silently
	// picking one.
	for (const stack of stacksByKey.values()) {
		const ll: L.LatLngTuple = [stack[0].coord.lat, stack[0].coord.lon];
		// Mixed-type stacks (a PSN coord + a qualifier-line coord at the
		// same lat/lon, possible when an obstacle NOTAM and a Q-line-only
		// NOTAM coincide) take the PSN colour because that's the more
		// authoritative tag.
		const repr = stack.find((s) => s.coord.type === 'psn') ?? stack[0];
		const icon = positionIcon(
			repr.coord.type,
			repr.notam.obstacleType,
			typeIcons,
			stack.length,
		);
		const marker = L.marker(ll, { icon }).addTo(group);
		// Leaflet keyboard markers render focusable (tabindex="0"), so give
		// each pin an accessible name: the NOTAM ident(s), locale-invariant.
		// DivIcon ignores the marker `alt` option, so stamp the attribute on
		// the element directly (available right after addTo).
		marker
			.getElement()
			?.setAttribute('aria-label', `NOTAM ${[...new Set(stack.map((s) => s.notam.id))].join(', ')}`);
		marker.on('click', (e: L.LeafletMouseEvent) => {
			L.DomEvent.stopPropagation(e);
			if (stack.length === 1) {
				selectNotam(stack[0].index);
				return;
			}
			openNotamMenu(
				stack.map((s) => ({ notam: s.notam, index: s.index })),
				e.originalEvent.clientX,
				e.originalEvent.clientY,
			);
		});
		// Each member of the stack lights up the same marker on highlight.
		for (const s of stack) {
			let mArr = markersByIndex.get(s.index);
			if (!mArr) {
				mArr = [];
				markersByIndex.set(s.index, mArr);
			}
			mArr.push(marker);
		}
	}
}

/** Area pass: one styled polygon per area NOTAM, collected (not yet added)
 *  so the shared largest-first sort can interleave them with the circles. */
function collectAreaFeatures(
	items: IndexedNotam[],
	features: { index: number; size: number; styled: StyledPath }[],
): void {
	for (const { notam, index } of items) {
		if (!isAreaEntry(notam)) {
			continue;
		}
		const ring = notam.coordinates.map(
			(c) => [c.lat, c.lon] as L.LatLngTuple,
		);
		const base = areaStyle(false);
		const poly = L.polygon(ring, { pane: NOTAM_PANE, ...base }).on(
			'click',
			(e: L.LeafletMouseEvent) => {
				// Don't let the click bubble to the map; without this,
				// the map's click handler runs immediately after and
				// airspaceAt() overwrites the selection with an
				// airspace sitting under the click. Same reason as the
				// circle handler in pushCircleFeature.
				L.DomEvent.stopPropagation(e);
				selectNotam(index);
			},
		);
		features.push({
			index,
			size: polygonAreaM2(notam.coordinates),
			styled: { layer: poly, base, highlight: areaStyle(true) },
		});
	}
}

/** Circle pass: the point NOTAMs' radius circles (Q-line radii deferred to
 *  selection inside pushCircleFeature), plus the position / area NOTAMs'
 *  Q) qualifier circle registration for the detail-panel toggle. */
function collectCircleFeatures(
	items: IndexedNotam[],
	features: { index: number; size: number; styled: StyledPath }[],
): void {
	for (const { notam, index } of items) {
		// Position / area NOTAMs (no qualifierLine coordinate) expose their Q)
		// line centre + radius (NM) via the detail-panel "Show Q radius" toggle.
		const q = notam.qualifier;
		if (
			q && q.radius != null && q.radius > 0 &&
			!notam.coordinates.some((c) => c.type === 'qualifierLine')
		) {
			qualifierCircleByIndex.set(index, [
				{
					center: [q.lat, q.lon],
					radiusM: q.radius * NM_TO_METERS,
					style: influenceCircleStyle(QLINE_RADIUS_COLOR),
				},
			]);
		}
		if (isAreaEntry(notam)) {
			continue;
		}
		for (const c of notam.coordinates) {
			pushCircleFeature(features, c, index);
		}
	}
}

/**
 * Draw the given NOTAMs: position markers, area polygons and radius circles,
 * as three named passes in that order. Polygons and circles share one
 * largest-first sort so the smallest sits on top and wins an overlapping
 * click. Replaces whatever was drawn before and re-applies the current
 * selection highlight. The map view is left untouched; fitting is an
 * explicit user action (a coord-button click → focusNotam).
 */
export function renderNotams(
	map: L.Map,
	items: IndexedNotam[],
	typeIcons: boolean,
	qlineMarkers: boolean,
	hideQlineMarkerIdx: Set<number> = new Set(),
): void {
	ensureNotamPane(map);
	const displaySig =
		`${typeIcons ? 1 : 0}${qlineMarkers ? 1 : 0}|` +
		[...hideQlineMarkerIdx].sort((a, b) => a - b).join(',');
	// Only skippable on the map already holding the features: a fresh map (or
	// one after clearNotamLayer) has no group yet and must draw. The selection
	// stays out of the comparison; highlightNotam re-applies it on its own and
	// already early-returns on an unchanged index, and the Q-radius display
	// flags reconcile through their own setters (syncQlineCircles).
	if (
		group &&
		mapRef === map &&
		displaySig === drawnDisplaySig &&
		sameItems(items, drawnItems)
	) {
		return;
	}
	mapRef = map;
	drawnDisplaySig = displaySig;
	drawnItems = items.slice();
	if (!group) {
		group = L.layerGroup().addTo(map);
	}
	group.clearLayers();
	pathsByIndex.clear();
	markersByIndex.clear();
	qlineCirclesByIndex.clear();
	qualifierCircleByIndex.clear();
	activeQlineCircles = [];
	suppressedAirportQline.clear();
	revealedMarker = null;

	const features: { index: number; size: number; styled: StyledPath }[] = [];
	renderMarkerPass(items, typeIcons, qlineMarkers, hideQlineMarkerIdx);
	collectAreaFeatures(items, features);
	collectCircleFeatures(items, features);

	// Largest first → the smallest feature ends up on top and wins clicks.
	features.sort((a, b) => b.size - a.size);
	for (const f of features) {
		f.styled.layer.addTo(group);
		let arr = pathsByIndex.get(f.index);
		if (!arr) {
			arr = [];
			pathsByIndex.set(f.index, arr);
		}
		arr.push(f.styled);
	}

	applyHighlight();
}

/** Drop every module-level Leaflet handle so a rebuilt map starts clean:
 *  without this, an HMR / test remount of MapView leaves `group` attached to
 *  the destroyed map and renderNotams keeps feeding it, so the new map shows
 *  no NOTAMs. Display preferences (qlineRadiusVisible) survive; they are
 *  re-synced by MapView's effects. Called from MapView's teardown. */
export function clearNotamLayer(): void {
	group = null;
	mapRef = null;
	drawnItems = [];
	drawnDisplaySig = null;
	pathsByIndex.clear();
	markersByIndex.clear();
	qlineCirclesByIndex.clear();
	qualifierCircleByIndex.clear();
	activeQlineCircles = [];
	suppressedAirportQline.clear();
	revealedMarker = null;
	highlightedIndex = null;
	panelQRadiusIndex = null;
	qlineSuppressedByAirspaces = false;
}

/** Pan/zoom the map to fit every NOTAM in the list, each by its drawn
 *  extent (radius circles included, the whole-FIR sentinel excluded so one
 *  FIR-wide entry can't blow the view out to 1850 km). A list that
 *  contributed no extent at all frames like one pin does. No-op for an
 *  empty list. */
export function fitToNotams(map: L.Map, items: IndexedNotam[]): void {
	let box: Bbox | null = null;
	let extent = false;
	for (const { notam } of items) {
		const b = notamFocusBbox(notam);
		if (!b) {
			continue;
		}
		extent = extent || hasDrawnExtent(notam);
		box = box
			? {
					minLat: Math.min(box.minLat, b.minLat),
					minLon: Math.min(box.minLon, b.minLon),
					maxLat: Math.max(box.maxLat, b.maxLat),
					maxLon: Math.max(box.maxLon, b.maxLon),
				}
			: b;
	}
	if (box) {
		fitBoundsVisible(
			map,
			boundsOf(box),
			50,
			extent ? FOCUS_MAX_ZOOM : MARKER_FOCUS_ZOOM,
		);
	}
}

/** Pan/zoom the map to one NOTAM, framing its whole drawn extent: the area
 *  ring, or the position(s) with their radius circles. The detail panel's
 *  own crosshair recipe for every other feature kind (airspace, SUP AIP,
 *  SIGMET), at the cap NOTAM geometry wants, or the wider one when the
 *  entry is nothing but its pin and there is no extent to frame. Stays on
 *  the bounds path either way: a point box plus a numeric maxZoom is what
 *  keeps Leaflet on the padding-offset branch, so the panel-aware half-inset
 *  shift survives. */
export function focusNotam(map: L.Map, notam: Notam): void {
	const b = notamFocusBbox(notam);
	if (b) {
		flyToBoundsVisible(
			map,
			boundsOf(b),
			40,
			hasDrawnExtent(notam) ? FOCUS_MAX_ZOOM : MARKER_FOCUS_ZOOM,
		);
	}
}

/* notamAreasAt + helpers were moved to src/lib/state/notamHit.svelte.ts so
 * vitest can import the hit-test in Node without Leaflet's window-touching
 * module side effects. */
