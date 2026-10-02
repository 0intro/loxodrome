import L from 'leaflet';
import {
	hasDrawnExtent,
	notamFocusBbox,
	notamMarkerBbox,
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

/* ---- areas and radius circles, per NOTAM entry ----
 *
 * Kept per entry and diffed on the entry's NOTAM object: a filter change or a
 * NOTAM crossing the window's edge adds and removes the few entries that
 * changed instead of tearing down and re-projecting every path (a
 * 7,500-NOTAM briefing draws 1,365 of them). */
interface DrawnEntry {
	notam: Notam;
	paths: StyledPath[];
	/** Footprint in m², for the largest-first draw order. */
	sizes: number[];
}
const drawnEntries = new Map<number, DrawnEntry>();
// The highlighted index whose paths currently wear the highlight style.
let styledIndex: number | null = null;

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

/* ---- position pins: one per stack of colocated entries ----
 *
 * VIEWPORT-CULLED, like the airspace polygons (airspaceLayer.ts): a pin is
 * built the first time the padded window reaches it and attached only while
 * it is inside. Every attached DivIcon is DOM the browser composites on each
 * frame of a pan or a zoom; a 7,500-NOTAM briefing attached 3,450 of them,
 * which Chromium turned into 2,966 compositing layers and 13 s of blocking
 * per two drags (culled to the padded viewport: 0.2 s;
 * docs/performance-2026-09.md). Leaflet's marker add is also O(n^2) in the
 * number of attached markers (Evented._listens), so a full rebuild of them
 * all on a zoom-floor crossing cost 1.7 s on a phone-class CPU. */
interface PinStack {
	/** Position key + member indexes + what the icon shows: a stack whose
	 *  members or icon change is a different pin. */
	sig: string;
	lat: number;
	lon: number;
	members: MarkerStackEntry[];
	label: string;
	icon: L.DivIcon;
}
let stacks: PinStack[] = [];
// Every pin built so far, by stack signature, attached or not, with the
// members it was built for (a re-parse keeps signatures but not NOTAMs).
const pins = new Map<string, { marker: L.Marker; members: MarkerStackEntry[] }>();
const attachedPins = new Set<string>();
// The cull window's pad, a fraction of the viewport on every side: a quarter
// of a viewport of panning re-attaches nothing, and the pins a drag reveals
// are already there.
const PIN_CULL_PAD = 0.25;
const SELECTED_PIN = 'notam-pin--selected';

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
		el.classList.add(SELECTED_PIN);
		// Focusable pin: name it like the stack markers (locale-invariant).
		el.setAttribute('aria-label', `NOTAM ${entry.id}`);
	}
	revealedMarker = marker;
}

/** Move the highlight style from the previously highlighted entry's paths to
 *  the current one's, and the selected class onto the attached pins that carry
 *  it: two entries and a few pins, where every path and every marker used to
 *  be restyled on each selection and each hover of a NOTAM id. */
function applyHighlight(): void {
	if (styledIndex !== highlightedIndex) {
		if (styledIndex != null) {
			for (const p of drawnEntries.get(styledIndex)?.paths ?? []) {
				p.layer.setStyle(p.base);
			}
		}
		if (highlightedIndex != null) {
			for (const p of drawnEntries.get(highlightedIndex)?.paths ?? []) {
				p.layer.setStyle(p.highlight);
			}
		}
		styledIndex = highlightedIndex;
	}
	// Colocated NOTAMs share ONE stack pin, so the class follows membership:
	// every attached pin whose stack holds the highlighted index, and no other.
	for (const sig of attachedPins) {
		const st = stackBySig.get(sig);
		const el = pins.get(sig)?.marker.getElement();
		if (st && el) {
			el.classList.toggle(SELECTED_PIN, st.members.some((m) => m.index === highlightedIndex));
		}
	}
	syncQlineCircles();
	syncRevealedAirportMarker();
}
const stackBySig = new Map<string, PinStack>();

function stackKey(c: NotamCoordinate): string {
	return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
}

function pushMarkerStack(
	stacksByKey: Map<string, MarkerStackEntry[]>,
	c: NotamCoordinate,
	notam: Notam,
	index: number,
): void {
	const key = stackKey(c);
	let stack = stacksByKey.get(key);
	if (!stack) {
		stack = [];
		stacksByKey.set(key, stack);
	}
	stack.push({ notam, index, coord: c });
}

/** A radius circle for a position coordinate (Q-line radii are registered
 *  for selection by registerQlineCircles and never drawn here). */
function circleFeature(c: NotamCoordinate): { size: number; styled: StyledPath } | null {
	if (c.radius == null || !c.radiusUnit || c.type === 'qualifierLine') {
		return null;
	}
	const rMeters = radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS;
	const base = circleStyle(RADIUS_COLOR, false);
	// Non-interactive, like every other filled overlay: a fill that took its
	// own click would shadow whatever it covers whatever its size. The map's
	// own handler resolves it through featureAt, which ranks this circle's
	// area against the other areas under the point (docs/map-hit-testing.md).
	const circle = L.circle([c.lat, c.lon], {
		pane: NOTAM_PANE,
		radius: rMeters,
		interactive: false,
		...base,
	});
	return {
		size: Math.PI * rMeters * rMeters,
		styled: { layer: circle, base, highlight: circleStyle(RADIUS_COLOR, true) },
	};
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

/** Pin pass: group point markers by lat/lon so colocated NOTAMs collapse to
 *  one pin with a count badge instead of stacking invisibly (key precision is
 *  5 decimals, ~1 m, tighter than any real-world coincidence). Builds the
 *  stacks only; the pins themselves are built and attached by syncPins, for
 *  the stacks inside the window. Also stashes the airport Q-line markers
 *  "Hide airport NOTAM markers" suppresses, for the on-selection reveal. */
function collectPinStacks(
	items: IndexedNotam[],
	typeIcons: boolean,
	qlineMarkers: boolean,
	hideQlineMarkerIdx: Set<number>,
): PinStack[] {
	suppressedAirportQline.clear();
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
	const out: PinStack[] = [];
	for (const [key, stack] of stacksByKey) {
		// Mixed-type stacks (a PSN coord + a qualifier-line coord at the
		// same lat/lon, possible when an obstacle NOTAM and a Q-line-only
		// NOTAM coincide) take the PSN colour because that's the more
		// authoritative tag.
		const repr = stack.find((s) => s.coord.type === 'psn') ?? stack[0];
		const icon = positionIcon(repr.coord.type, repr.notam.obstacleType, typeIcons, stack.length);
		out.push({
			sig: `${key}|${stack.map((s) => s.index).join(',')}|${repr.coord.type}|${repr.notam.obstacleType}|${typeIcons ? 1 : 0}`,
			lat: stack[0].coord.lat,
			lon: stack[0].coord.lon,
			members: stack,
			// Leaflet keyboard markers render focusable (tabindex="0"), so each
			// pin gets an accessible name: the NOTAM ident(s), locale-invariant.
			label: `NOTAM ${[...new Set(stack.map((s) => s.notam.id))].join(', ')}`,
			icon,
		});
	}
	return out;
}

/** Same NOTAM objects at the same indexes: a pin built for `a` still serves
 *  `b` (its click handler and chooser hold these entries). */
function sameMembers(a: MarkerStackEntry[], b: MarkerStackEntry[]): boolean {
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

function buildPin(st: PinStack): L.Marker {
	const marker = L.marker([st.lat, st.lon], { icon: st.icon });
	const members = st.members;
	marker.on('click', (e: L.LeafletMouseEvent) => {
		L.DomEvent.stopPropagation(e);
		if (members.length === 1) {
			selectNotam(members[0].index);
			return;
		}
		openNotamMenu(
			members.map((s) => ({ notam: s.notam, index: s.index })),
			e.originalEvent.clientX,
			e.originalEvent.clientY,
		);
	});
	return marker;
}

function attachPin(st: PinStack): void {
	if (!group) {
		return;
	}
	let entry = pins.get(st.sig);
	if (!entry || !sameMembers(entry.members, st.members)) {
		entry = { marker: buildPin(st), members: st.members };
		pins.set(st.sig, entry);
	}
	group.addLayer(entry.marker);
	attachedPins.add(st.sig);
	// A detached marker loses its element, so the name and the selected class
	// are stamped on every attach (DivIcon ignores the marker `alt` option).
	const el = entry.marker.getElement();
	if (el) {
		el.setAttribute('aria-label', st.label);
		el.classList.toggle(SELECTED_PIN, st.members.some((m) => m.index === highlightedIndex));
	}
}

function detachPin(sig: string): void {
	const entry = pins.get(sig);
	if (group && entry) {
		group.removeLayer(entry.marker);
	}
	attachedPins.delete(sig);
}

/** The padded, UNWRAPPED viewport clipped to the world (airspaceLayer's
 *  cullWindow and its reasons: markers project at their raw longitude too),
 *  'all' for a map with no size yet (a hidden container, the unit tests'
 *  stubs), 'none' when the window misses the world. */
function pinWindow(
	map: L.Map,
): { minX: number; minY: number; maxX: number; maxY: number } | 'all' | 'none' {
	if (typeof map.getSize !== 'function' || typeof map.getBounds !== 'function') {
		return 'all';
	}
	const size = map.getSize();
	if (!(size.x > 0) || !(size.y > 0)) {
		return 'all';
	}
	const b = map.getBounds().pad(PIN_CULL_PAD);
	const minX = Math.max(-180, b.getWest());
	const maxX = Math.min(180, b.getEast());
	if (minX > maxX) {
		return 'none';
	}
	return { minX, minY: Math.max(-90, b.getSouth()), maxX, maxY: Math.min(90, b.getNorth()) };
}

/** Attach the pins inside the window, detach the rest. A pass over the
 *  stacks (bounds tests only); DOM work is proportional to what changed. */
function syncPins(): void {
	if (!group || !mapRef) {
		return;
	}
	const win = pinWindow(mapRef);
	const want = new Set<string>();
	if (win !== 'none') {
		for (const st of stacks) {
			if (
				win !== 'all' &&
				(st.lat < win.minY || st.lat > win.maxY || st.lon < win.minX || st.lon > win.maxX)
			) {
				continue;
			}
			want.add(st.sig);
			if (!attachedPins.has(st.sig)) {
				attachPin(st);
			}
		}
	}
	for (const sig of [...attachedPins]) {
		if (!want.has(sig)) {
			detachPin(sig);
		}
	}
}

/** Re-cull the pins for the current view. Called by the map views on every
 *  settled move (MapView / NotamMapView onMove). */
export function updateNotamPinsViewport(map: L.Map): void {
	if (map === mapRef) {
		syncPins();
	}
}

/** Register every entry's deferred Q-line circles (the blue fallback, drawn
 *  on selection) and the position / area NOTAMs' Q) qualifier circle (the
 *  detail-panel toggle). Data only; syncQlineCircles draws the one wanted. */
function registerQlineCircles(items: IndexedNotam[]): void {
	qlineCirclesByIndex.clear();
	qualifierCircleByIndex.clear();
	for (const { notam, index } of items) {
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
			if (c.type !== 'qualifierLine' || c.radius == null || !c.radiusUnit) {
				continue;
			}
			let qArr = qlineCirclesByIndex.get(index);
			if (!qArr) {
				qArr = [];
				qlineCirclesByIndex.set(index, qArr);
			}
			qArr.push({
				center: [c.lat, c.lon],
				radiusM: radiusToNM(c.radius, c.radiusUnit) * NM_TO_METERS,
				style: influenceCircleStyle(QLINE_RADIUS_COLOR),
			});
		}
	}
}

/** The paths one entry draws: its area polygon, or its position radius
 *  circles. */
function entryFeatures(notam: Notam): { size: number; styled: StyledPath }[] {
	if (isAreaEntry(notam)) {
		const ring = notam.coordinates.map((c) => [c.lat, c.lon] as L.LatLngTuple);
		const base = areaStyle(false);
		// Non-interactive; the map's own handler resolves the click through
		// featureAt, which ranks this ring against every other area under the
		// point. Same reason as the circle in circleFeature.
		const poly = L.polygon(ring, {
			pane: NOTAM_PANE,
			interactive: false,
			...base,
		});
		return [{ size: polygonAreaM2(notam.coordinates), styled: { layer: poly, base, highlight: areaStyle(true) } }];
	}
	const out: { size: number; styled: StyledPath }[] = [];
	for (const c of notam.coordinates) {
		const f = circleFeature(c);
		if (f) {
			out.push(f);
		}
	}
	return out;
}

/** Bring the drawn entries to the new item set: remove the entries that left
 *  or were re-parsed, add the new ones, and when anything was added restore
 *  the largest-first order (the smallest on top, visible inside the ones that
 *  contain it; a DRAW order only, featureAt ranks the click by area itself). */
function syncEntries(items: IndexedNotam[]): void {
	if (!group) {
		return;
	}
	const want = new Map<number, Notam>();
	for (const { notam, index } of items) {
		want.set(index, notam);
	}
	for (const [index, d] of drawnEntries) {
		if (want.get(index) !== d.notam) {
			for (const p of d.paths) {
				group.removeLayer(p.layer);
			}
			drawnEntries.delete(index);
			if (styledIndex === index) {
				styledIndex = null;
			}
		}
	}
	const added: { size: number; styled: StyledPath }[] = [];
	for (const { notam, index } of items) {
		if (drawnEntries.has(index)) {
			continue;
		}
		const feats = entryFeatures(notam);
		drawnEntries.set(index, { notam, paths: feats.map((f) => f.styled), sizes: feats.map((f) => f.size) });
		added.push(...feats);
	}
	if (added.length === 0) {
		return;
	}
	const hadOthers = drawnEntries.size > 0 && added.length < countPaths();
	added.sort((a, b) => b.size - a.size);
	for (const f of added) {
		f.styled.layer.addTo(group);
	}
	if (hadOthers) {
		const all: { size: number; layer: L.Path }[] = [];
		for (const d of drawnEntries.values()) {
			d.paths.forEach((p, i) => all.push({ size: d.sizes[i], layer: p.layer }));
		}
		all.sort((a, b) => b.size - a.size);
		for (const a of all) {
			a.layer.bringToFront?.();
		}
	}
}

function countPaths(): number {
	let n = 0;
	for (const d of drawnEntries.values()) {
		n += d.paths.length;
	}
	return n;
}

/**
 * Draw the given NOTAMs: position pins (viewport-culled), area polygons and
 * radius circles. Polygons and circles keep one largest-first order so the
 * smallest stays visible inside the ones that contain it. Diffs against what
 * is drawn: entries by their NOTAM object, pins by their stack signature, so
 * a changed item set or display flag touches only what changed, and
 * re-applies the current selection highlight. The map view is left
 * untouched; fitting is an explicit user action (a coord-button click →
 * focusNotam).
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
	const sameMap = mapRef === map;
	const itemsSame = sameMap && sameItems(items, drawnItems);
	if (group && itemsSame && displaySig === drawnDisplaySig) {
		return;
	}
	if (!group) {
		group = L.layerGroup().addTo(map);
	}
	if (!sameMap) {
		// Another map (a remount without clearNotamLayer): nothing drawn
		// belongs to it, so start over.
		group.clearLayers();
		drawnEntries.clear();
		pins.clear();
		attachedPins.clear();
		activeQlineCircles = [];
		revealedMarker = null;
		styledIndex = null;
	}
	mapRef = map;
	drawnDisplaySig = displaySig;
	drawnItems = items.slice();

	if (!itemsSame) {
		registerQlineCircles(items);
		syncEntries(items);
	}

	// Pins: rebuild the stacks, drop the pins whose stack left or changed,
	// then attach what the window holds.
	const next = collectPinStacks(items, typeIcons, qlineMarkers, hideQlineMarkerIdx);
	stackBySig.clear();
	for (const st of next) {
		stackBySig.set(st.sig, st);
	}
	for (const [sig, entry] of pins) {
		const st = stackBySig.get(sig);
		if (!st || !sameMembers(entry.members, st.members)) {
			if (attachedPins.has(sig)) {
				detachPin(sig);
			}
			pins.delete(sig);
		}
	}
	stacks = next;
	syncPins();

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
	drawnEntries.clear();
	styledIndex = null;
	stacks = [];
	stackBySig.clear();
	pins.clear();
	attachedPins.clear();
	qlineCirclesByIndex.clear();
	qualifierCircleByIndex.clear();
	activeQlineCircles = [];
	suppressedAirportQline.clear();
	revealedMarker = null;
	highlightedIndex = null;
	panelQRadiusIndex = null;
	qlineSuppressedByAirspaces = false;
}

/** Pan/zoom the map to fit every NOTAM in the list, each by the points it is
 *  DRAWN at: a polygon's ring, or the position(s) its pins sit on. NOT by
 *  radius, which is the whole point. A NOTAM's radius of influence routinely
 *  covers a country or more, and two 460 NM navaid outages reach into every
 *  French briefing there is, so a radius-padded fit framed three different
 *  routes at the identical 18.1 x 23.4 degrees; see notamMarkerBbox for the
 *  measurement. The zoom CAP still reads the drawn extent, because a briefing
 *  that draws areas can be framed closer than one that is only pins.
 *
 *  Framing ONE NOTAM is the other question and keeps the other answer:
 *  focusNotam below frames its whole extent. No-op for an empty list. */
export function fitToNotams(map: L.Map, items: IndexedNotam[]): void {
	let box: Bbox | null = null;
	let extent = false;
	for (const { notam } of items) {
		const b = notamMarkerBbox(notam);
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
