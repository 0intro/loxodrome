/* Flight-route state. The user can draw several routes (each a list of waypoints
 * placed freely or snapped to an airport / navaid); `routes` holds them all plus
 * which one is active, and `routeSettings` holds the editing mode and the corridor
 * / cruise / altitude / wind settings shared by every route. Only the active route
 * is edited; the nav-log and vertical-profile read the active route; the map draws
 * all of them; the NOTAM fetch unions every route's corridor. The routes and the
 * planning settings persist across reloads through state/routePersist.ts (the
 * route-file grammar in localStorage, restored at boot; a ?file= URL wins over
 * it); the view state (editMode, previews, selection), the undo history and the
 * ids stay session-only.
 *
 * Coordinates are stored as `lat` / `lon` to match the data layer (Airport.lon,
 * Navaid.lon), the geodesy helpers and the autorouter fetch. Leaflet's
 * `e.latlng.lng` is the same longitude value; callers pass it as the `lon`
 * argument (positional), and `[wp.lat, wp.lon]` feeds Leaflet directly. */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';
import { cruisingRegimeForRoutes } from '$lib/route/airspaces';
import { computeCruiseAltitudes, type CruisingRegime } from '$lib/route/cruisingLevels';
import { parseCoordToken, formatGarminCoord } from '$lib/route/coordToken';
import { decimalYearFromDate } from '$lib/route/magnetic';
import { reconstructPositions } from '$lib/route/reconstruct';
import { addRouteTo, removeRouteFrom, setActiveIn, reorderRouteIn } from '$lib/route/routeList';
import { windAloft } from './windAloft.svelte';
import { filter } from './filter.svelte';
import type { Airspace } from '$lib/data/airspaces';
import { normalizePlanName, type LoadedRoute, type LoadedSettings } from '$lib/route/yaml';

export type WaypointKind = 'free' | 'airport' | 'navaid';

export interface Waypoint {
	/** Session-unique id (a monotonic counter; see newId). */
	id: string;
	lat: number;
	lon: number;
	kind: WaypointKind;
	/** Airport ICAO (upper-case) or Navaid.id when anchored; absent for free. */
	refId?: string | undefined;
	/** ICAO / navaid ident, shown in the list and on the marker. */
	ident?: string | undefined;
	/** Airport / navaid name. */
	label?: string | undefined;
	/** Navaid frequency label (from navaidFreqLabel); absent for airports/free. */
	freq?: string | undefined;
	/** Altitude in feet of the leg LEAVING this waypoint (per-leg model): leg i
	 *  (wp[i] -> wp[i+1]) flies at wp[i].alt. Seeded from defaultAltitudeFt,
	 *  editable. Unused on the last waypoint (it has no outbound leg). */
	alt: number;
	/** True while the leg altitude is auto-managed by the VFR Class A rule (see
	 *  applyAutoAltitudes); set false the moment the user edits this leg's
	 *  altitude, after which it is never auto-overwritten until reset. */
	altAuto: boolean;
	/** Manual wind override for the leg LEAVING this waypoint (per-leg model,
	 *  like alt): direction the wind blows FROM (° true) and speed (kt). Both
	 *  absent = automatic (the forecast when enabled, else the global manual
	 *  wind). Set together via setWaypointWind, cleared via clearWaypointWind;
	 *  round-trips as leg.wind_dir / leg.wind_speed in the route file. */
	windDirDeg?: number | undefined;
	windSpeedKt?: number | undefined;
	/** Free-text nav-log note for this waypoint; round-trips as `notes`. */
	notes?: string | undefined;
	/** Manual frequencies for this waypoint's nav-log cell (multi-line free
	 *  text, one frequency per line). Absent = automatic (the airport radios +
	 *  enroute contact lines computed by the sheet). Set via setWaypointFreqs
	 *  (typing the automatic content or clearing hands the cell back to auto),
	 *  reverted via clearWaypointFreqs; round-trips as `frequencies_manual` in
	 *  the route file (the `frequencies` snapshot stays saved-only). */
	freqsManual?: string | undefined;
	/** True when this free waypoint's position was dead-reckoned from a saved leg
	 *  course + distance on load (a name-only waypoint with no coords); it is an
	 *  approximation, drawn with a dashed pin. Cleared once the user drags or
	 *  re-snaps the point. Session-only: never written on save (a re-save bakes the
	 *  reconstructed coords in as an ordinary free point). */
	estimated?: boolean | undefined;
}

/** Fields needed to add a waypoint anchored to an airport or navaid. */
export interface WaypointAnchor {
	lat: number;
	lon: number;
	kind: 'airport' | 'navaid';
	refId: string;
	ident: string;
	label?: string | undefined;
	freq?: string | undefined;
}

/** A snap target for placing or moving a waypoint: the position and identity to
 *  copy onto it. Either a nearby airport / navaid feature (an anchored kind with
 *  refId / ident) or an existing route waypoint reused at its own spot, a free
 *  custom point included (kind 'free', label = its name). A WaypointAnchor is a
 *  WaypointSnap, so the feature-resolution paths still produce a valid snap. */
export interface WaypointSnap {
	lat: number;
	lon: number;
	kind: WaypointKind;
	refId?: string | undefined;
	ident?: string | undefined;
	label?: string | undefined;
	freq?: string | undefined;
}

/** One drawn route. */
export interface Route {
	/** Session-unique id (`route-N`, monotonic; never reused). */
	id: string;
	/** Custom tab-label override; null derives the label from the endpoints. */
	name: string | null;
	waypoints: Waypoint[];
	selectedWaypointId: string | null;
	/** Alternate (diversion) route: attaches to the nearest preceding
	 *  non-alternate route (interleave convention trip 1, alternate 1,
	 *  trip 2, ...). Absent = a trip. */
	alternate?: boolean | undefined;
}

/** Cap on the number of routes (palette size + NOTAM fetch cost). */
export const MAX_ROUTES = 6;

/** The route workspace: every drawn route, the active one, and the plan's own
 *  descriptive name. Invariant: list is non-empty and activeId always names a
 *  member.
 *
 *  `planName` is the plan's IDENTITY, not route content, and it sits
 *  deliberately outside the undo history (recordUndo below) and outside
 *  planSig (state/activePlan.svelte.ts): the catalog rename writes the stored
 *  row and this field in ONE action, so undoing one half, or reading the pair
 *  as an unstored edit, could only ever desynchronise them. */
export const routes = $state<{ list: Route[]; activeId: string; planName: string | null }>({
	list: [{ id: 'route-1', name: null, waypoints: [], selectedWaypointId: null }],
	activeId: 'route-1',
	planName: null,
});

/** Settings shared by every route (the nav log / profile / NOTAM fetch read
 *  these, not the per-route waypoints). */
export const routeSettings = $state<{
	/** When on, a left-click on the map adds a waypoint to the active route. */
	editMode: boolean;
	/** Corridor half-width (NM) for the route NOTAM fetch. */
	corridorRadiusNM: number;
	/** Transient: the corridor-width field is focused, so the map previews the
	 *  active route's corridor band. Driven by the input's focus/blur, not a
	 *  planning setting and not serialized. */
	corridorPreview: boolean;
	/** Corridor half-width (NM each side of track) for the per-leg
	 *  minimum-safe-altitude terrain / obstacle scan. */
	minAltCorridorRadiusNM: number;
	/** Transient: the MSA-corridor field is focused, so the map previews the
	 *  active route's MSA corridor band. Driven by the field's focus, not
	 *  serialized. */
	minAltCorridorPreview: boolean;
	/** Cruise speed (kt) for ETE; null omits ETE. */
	cruiseSpeedKt: number | null;
	/** Altitude (ft) each auto leg uses by default (and the cap ceiling under the
	 *  VFR Class A rule). */
	defaultAltitudeFt: number;
	/** Flight rules. When on (VFR), an auto leg that crosses Class A is capped to
	 *  the Class A floor; when off (IFR), the rule is disabled. Also picks the
	 *  column of the table of cruising levels (VFR +500 ft) when the
	 *  semicircular option is on. */
	vfr: boolean;
	/** Semicircular cruising levels (ICAO Annex 2 / SERA Appendix 3, applicable
	 *  per SERA.5005(g) above 3000 ft over the surface): auto legs snap to the
	 *  level for their magnetic track, manually set legs are flagged in the UI,
	 *  never rewritten. Round-trips through the route file's settings block. */
	semicircular: boolean;
	/** Transition altitude (ft) manual override; null = automatic, the lowest
	 *  AIP TA among the aerodromes any route touches, else the containing
	 *  FIRs' blanket value, else 5000 ft (`state/transitionAlt.svelte.ts`;
	 *  every display surface reads `effectiveTransitionAltFt()`). Planned
	 *  levels above the effective TA are flown, shown and edited as flight
	 *  levels. */
	transitionAltitudeFt: number | null;
	/** Wind the route is planned against: direction the wind blows FROM (° true)
	 *  and speed (kt). Null leaves the nav-log MH and ETE/W columns blank. */
	windDirDeg: number | null;
	windSpeedKt: number | null;
	/** View preference (not serialized): when on, the map shows only the
	 *  airspaces the active route crosses, hiding the rest and overriding the
	 *  Layers-tab airspace category toggles. */
	airspacesOnRouteOnly: boolean;
	/** View preference (not serialized): when on, the map highlights the cells of
	 *  the active route's minimum-altitude corridor where the terrain / obstacle
	 *  minimum safe altitude (+500 ft) exceeds the planned leg altitude, i.e. the
	 *  patches where flying the planned level busts the clearance floor. */
	minAltDangerOn: boolean;
	/** View preference (not serialized): when on, only the NOTAMs relevant to
	 *  any route's corridor (corridorRadiusNM each side; FIR-wide NOTAMs by
	 *  crossed FIR) stay visible, on the map and in every list. The NOTAM
	 *  sibling of airspacesOnRouteOnly, applied inside visibleNotams(); inert
	 *  while no route has two waypoints. */
	notamsOnRouteOnly: boolean;
	/** When on, the nav log lists each airport waypoint's published COM frequencies
	 *  (any active frequency-change NOTAM applied) under its report banner and saves
	 *  them in the route file. Default on. */
	airportFreqsInNavlog: boolean;
	/** When on, the nav log lists each leg's controlling / FIS frequencies (Class A
	 *  IFR / B / C / D / E IFR, SIV, RMZ) under its from-waypoint and saves them in
	 *  the route file. Default on. */
	enrouteFreqsInNavlog: boolean;
	/** When on, the nav log shows the VOR radial banner in each waypoint's notes cell:
	 *  the tuned station (ident + frequency) and the QDR / QDM magnetic radial of the
	 *  leg leaving it. Saved in the route file. Default on. */
	vorRadialsInNavlog: boolean;
}>({
	editMode: false,
	corridorRadiusNM: 15,
	corridorPreview: false,
	minAltCorridorRadiusNM: 5,
	minAltCorridorPreview: false,
	cruiseSpeedKt: 100,
	defaultAltitudeFt: 2000,
	vfr: true,
	semicircular: true,
	transitionAltitudeFt: null,
	windDirDeg: null,
	windSpeedKt: null,
	airspacesOnRouteOnly: false,
	minAltDangerOn: false,
	notamsOnRouteOnly: false,
	airportFreqsInNavlog: true,
	enrouteFreqsInNavlog: true,
	vorRadialsInNavlog: true,
});

/** Set the route's flight-rules flag and drive the NOTAM Flight-rules filter to
 *  match: VFR hides IFR-only NOTAMs, IFR hides VFR-only (the Filters popover can
 *  still override to 'All' afterwards). The single entry point so the Route-tab
 *  toggle and a loaded route file behave the same. autorouter's API can't filter
 *  by traffic and SOFIA still fetches both, so this is purely the (client-side)
 *  display filter, applied uniformly to every NOTAM source. */
export function setRouteVfr(vfr: boolean): void {
	routeSettings.vfr = vfr;
	filter.trafficMode = vfr ? 'vfr' : 'ifr';
}

/** True while the flight-rules filter mirrors the planned route: a route with
 *  at least two waypoints exists and routeSettings.vfr matches the current
 *  traffic mode (the setRouteVfr coupling above). The NOTAMs-tab chip and the
 *  Filters popover mark the dimension "set by your route" on it; purely
 *  informative, no filter behavior rides on it. Lives here, not in
 *  filter.svelte.ts, which this module imports. */
export function routeDrivesTrafficMode(): boolean {
	if (filter.trafficMode === 'all') {
		return false;
	}
	if (!routes.list.some((r) => r.waypoints.length >= 2)) {
		return false;
	}
	return routeSettings.vfr === (filter.trafficMode === 'vfr');
}

// Session-unique ids. Monotonic counters, not crypto.randomUUID: ids never
// leave the session (the persisted workspace stores none; loadRoutes mints
// fresh ones on restore), so counters are collision-free, need no secure
// context, and are debuggable. Plain module variables, intentionally not
// reactive. Waypoint ids are global across routes (so markers never collide);
// route ids never reused.
let nextWaypointId = 1;
function newId(): string {
	return `wp-${nextWaypointId++}`;
}
let nextRouteId = 2; // route-1 is seeded above
function newRouteId(): string {
	return `route-${nextRouteId++}`;
}

// --- undo / redo history (session-only) -------------------------------------
// The whole route workspace is small (a few routes of a few waypoints), so the
// simplest robust undo is to snapshot all of `routes` before each action and
// restore it on undo. $state.snapshot returns a plain deep clone (never aliased
// to the live state), so stored snapshots can't be mutated by later edits.
interface RoutesSnapshot {
	list: Route[];
	activeId: string;
}
export const UNDO_CAP = 100;
const undoStack: RoutesSnapshot[] = [];
const redoStack: RoutesSnapshot[] = [];
// The open field-edit session: consecutive recordUndo() calls with the same
// non-null key coalesce into the session's first snapshot (a burst of keystrokes,
// or an altitude drag, is one undo step). A different key, or a null (discrete)
// key, starts a fresh entry. Plain module var, intentionally not reactive.
let coalesceKey: string | null = null;

/** Reactive mirror of the undo / redo stack depth, so the route panel's undo /
 *  redo buttons can enable / disable (the stacks are plain arrays a $derived
 *  can't observe). */
export const routeHistory = $state({ canUndo: false, canRedo: false });
function syncHistory(): void {
	routeHistory.canUndo = undoStack.length > 0;
	routeHistory.canRedo = redoStack.length > 0;
}

/** Snapshot the workspace before a mutation. `key` groups a field-edit session;
 *  null (a discrete action) never coalesces. */
function recordUndo(key: string | null = null): void {
	if (key !== null && key === coalesceKey) {
		return; // same field-edit session continues; keep its first snapshot
	}
	// The list and the active tab, never `routes` whole: the plan name is
	// identity (see the routes declaration) and snapshotting it would restore it
	// silently, undoRoute writing back these two fields alone.
	undoStack.push({ list: $state.snapshot(routes.list), activeId: routes.activeId });
	if (undoStack.length > UNDO_CAP) {
		undoStack.shift();
	}
	redoStack.length = 0;
	coalesceKey = key;
	syncHistory();
}

/** Step back one action; false when there is nothing to undo. */
export function undoRoute(): boolean {
	const prev = undoStack.pop();
	if (!prev) {
		return false;
	}
	redoStack.push({ list: $state.snapshot(routes.list), activeId: routes.activeId });
	routes.list = prev.list;
	routes.activeId = prev.activeId;
	coalesceKey = null;
	syncHistory();
	return true;
}

/** Re-apply the last undone action; false when there is nothing to redo. */
export function redoRoute(): boolean {
	const next = redoStack.pop();
	if (!next) {
		return false;
	}
	undoStack.push({ list: $state.snapshot(routes.list), activeId: routes.activeId });
	routes.list = next.list;
	routes.activeId = next.activeId;
	coalesceKey = null;
	syncHistory();
	return true;
}

/** The active route. Invariant holds, so the list[0] fallback is a non-null
 *  guard that also keeps the return type non-nullable. */
export function activeRoute(): Route {
	return routes.list.find((r) => r.id === routes.activeId) ?? routes.list[0];
}

/** Add a new empty route and make it active (no-op at MAX_ROUTES). Returns the
 *  now-active route. */
export function addRoute(): Route {
	recordUndo();
	const r: Route = { id: newRouteId(), name: null, waypoints: [], selectedWaypointId: null };
	const next = addRouteTo({ list: routes.list, activeId: routes.activeId }, r, MAX_ROUTES);
	routes.list = next.list;
	routes.activeId = next.activeId;
	return activeRoute();
}

/** Remove a route (refuses to drop the last one); the previous neighbour becomes
 *  active when the active route is removed. */
export function removeRoute(id: string): void {
	recordUndo();
	const next = removeRouteFrom({ list: routes.list, activeId: routes.activeId }, id);
	routes.list = next.list;
	routes.activeId = next.activeId;
}

/** Activate a route by id (no-op if it isn't in the list). */
export function setActiveRoute(id: string): void {
	routes.activeId = setActiveIn({ list: routes.list, activeId: routes.activeId }, id).activeId;
}

/** Move the active route by `delta` positions in the list, clamped to the ends. */
export function stepActiveRoute(delta: number): void {
	const i = routes.list.findIndex((r) => r.id === routes.activeId);
	if (i < 0) {
		return;
	}
	const j = Math.max(0, Math.min(routes.list.length - 1, i + delta));
	if (j !== i) {
		setActiveRoute(routes.list[j].id);
	}
}

/** Move the route at `from` to index `to` (both clamped). Active route unchanged.
 *  No-op (no undo step) when the indices don't move anything. */
export function reorderRoute(from: number, to: number): void {
	const next = reorderRouteIn({ list: routes.list, activeId: routes.activeId }, from, to);
	if (next.list === routes.list) {
		return; // clamped / out-of-range no-op
	}
	recordUndo();
	routes.list = next.list;
}

/** Set a route's custom label; blank reverts to the endpoint-derived label. */
/** Name the whole PLAN (the catalog's rename, state/activePlan.renamePlan).
 *  Records NO undo step, see the routes declaration; blank hands the plan back
 *  to its derived chain. */
export function setPlanName(name: string | null): void {
	routes.planName = normalizePlanName(name);
}

export function renameRoute(id: string, name: string): void {
	const r = routes.list.find((x) => x.id === id);
	if (r) {
		recordUndo(`rename:${id}`);
		r.name = name.trim() === '' ? null : name;
	}
}

/** Flag / unflag a route as an alternate (diversion) of the preceding trip. */
export function setRouteAlternate(id: string, on: boolean): void {
	const r = routes.list.find((x) => x.id === id);
	if (r && (r.alternate ?? false) !== on) {
		recordUndo();
		r.alternate = on ? true : undefined;
	}
}

/** Whether another route can be added. */
export function canAddRoute(): boolean {
	return routes.list.length < MAX_ROUTES;
}

/** Append a free waypoint at (lat, lon) to the active route. Returns it. */
export function addWaypoint(lat: number, lon: number): Waypoint {
	recordUndo();
	const wp: Waypoint = {
		id: newId(),
		lat,
		lon,
		kind: 'free',
		alt: routeSettings.defaultAltitudeFt,
		altAuto: true,
	};
	activeRoute().waypoints.push(wp);
	return wp;
}

/** Append a waypoint from a snap target: an airport / navaid anchor, or an existing
 *  waypoint reused at its coords (a free point included), all at the target's spot. */
export function addWaypointFromSnap(s: WaypointSnap): Waypoint {
	recordUndo();
	const wp: Waypoint = {
		id: newId(),
		lat: s.lat,
		lon: s.lon,
		kind: s.kind,
		refId: s.refId,
		ident: s.ident,
		label: s.label,
		freq: s.freq,
		alt: routeSettings.defaultAltitudeFt,
		altAuto: true,
	};
	activeRoute().waypoints.push(wp);
	return wp;
}

/** Insert a waypoint after `index` (index < 0 unshifts to the front) in the
 *  active route. Splitting a leg keeps that leg's altitude: the new waypoint
 *  inherits the from-waypoint's alt (so both halves fly the same level) unless
 *  the caller supplies one; a front-unshift falls back to defaultAltitudeFt. The
 *  split also inherits altAuto so both halves stay auto (and get re-capped) or
 *  stay manual together; an explicit alt is treated as manual. */
export function insertWaypointAfter(
	index: number,
	fields: Omit<Waypoint, 'id' | 'alt' | 'altAuto'> & { alt?: number },
): Waypoint {
	recordUndo();
	const r = activeRoute();
	const wp: Waypoint = {
		...fields,
		id: newId(),
		alt: fields.alt ?? r.waypoints[index]?.alt ?? routeSettings.defaultAltitudeFt,
		altAuto: fields.alt !== undefined ? false : (r.waypoints[index]?.altAuto ?? true),
		// A split leg keeps its wind override on both halves (the alt rule).
		windDirDeg: fields.windDirDeg ?? r.waypoints[index]?.windDirDeg,
		windSpeedKt: fields.windSpeedKt ?? r.waypoints[index]?.windSpeedKt,
	};
	const at = Math.max(0, Math.min(r.waypoints.length, index + 1));
	r.waypoints.splice(at, 0, wp);
	return wp;
}

/** Move a waypoint to (lat, lon). Dragging an ANCHORED waypoint off its anchor
 *  un-anchors it (kind -> free, drops refId/ident/label/freq); re-snapping is an
 *  explicit follow-up by the caller. A free waypoint keeps its custom name across
 *  moves. The altitude is preserved. */
export function moveWaypoint(id: string, lat: number, lon: number): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (!wp) {
		return;
	}
	recordUndo();
	wp.lat = lat;
	wp.lon = lon;
	// A dragged point is placed deliberately: no longer a dead-reckoned estimate.
	wp.estimated = undefined;
	if (wp.kind !== 'free') {
		wp.kind = 'free';
		wp.refId = undefined;
		wp.ident = undefined;
		wp.label = undefined;
		wp.freq = undefined;
	}
}

/** Re-place an existing waypoint onto a snap target (used when a drag ends on a
 *  feature or another waypoint). Copies the target's coords + identity in one
 *  write: an airport / navaid anchor, or a free point (kind 'free', anchor fields
 *  cleared, the target's name kept). Altitude preserved. */
export function setWaypointFromSnap(id: string, s: WaypointSnap): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (!wp) {
		return;
	}
	recordUndo();
	wp.lat = s.lat;
	wp.lon = s.lon;
	wp.kind = s.kind;
	wp.refId = s.refId;
	wp.ident = s.ident;
	wp.label = s.label;
	wp.freq = s.freq;
	// Re-snapped onto a real target: no longer a dead-reckoned estimate.
	wp.estimated = undefined;
}

/** The highest planned level the route mutators accept (ft): FL 660, the UTA
 *  ceiling and the top of the cruising-level tables the planner models
 *  (docs/cruising-levels.md). Clamping here keeps an FL-mode input typo
 *  (feet entered as a flight level, so x100) from planning a million-foot
 *  cruise. Loaded YAML altitudes are not clamped (tolerant loader; the
 *  badges report). */
export const MAX_LEG_ALT_FT = 66000;

/** Set a waypoint's planned altitude (feet), clamped into
 *  [0, MAX_LEG_ALT_FT]. A user edit locks the leg manual (altAuto = false)
 *  so the VFR Class A rule no longer touches it until reset, EXCEPT when the
 *  (clamped) value equals the leg's current auto target (`autoTargetFt`, the
 *  VFR Class A rule's value for this leg): typing the auto altitude hands the
 *  leg back to auto, exactly as the reset control does, so the manual cue never
 *  lingers on a leg that already sits at its computed altitude. */
export function setWaypointAltitude(id: string, ft: number, autoTargetFt?: number): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (wp) {
		recordUndo(`alt:${id}`);
		const alt = Math.min(Math.max(0, ft), MAX_LEG_ALT_FT);
		wp.alt = alt;
		wp.altAuto = autoTargetFt !== undefined && alt === autoTargetFt;
	}
}

/** Set a leg's manual wind override (direction the wind blows FROM, ° true,
 *  plus speed in kt). The leg stops following the forecast / global wind
 *  until cleared; repeated edits coalesce into one undo step (the alt idiom). */
export function setWaypointWind(id: string, dirDeg: number, speedKt: number): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (wp) {
		recordUndo(`wind:${id}`);
		wp.windDirDeg = dirDeg;
		wp.windSpeedKt = speedKt;
	}
}

/** Hand a leg's wind back to automatic (the forecast when enabled, else the
 *  global manual wind). */
export function clearWaypointWind(id: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (wp && (wp.windDirDeg !== undefined || wp.windSpeedKt !== undefined)) {
		recordUndo();
		wp.windDirDeg = undefined;
		wp.windSpeedKt = undefined;
	}
}

/** Hand a leg back to the VFR Class A auto rule (clears a manual override); the
 *  recompute effect re-caps its altitude on the next tick. */
export function resetWaypointAltitudeAuto(id: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (wp) {
		recordUndo();
		wp.altAuto = true;
	}
}

/** Apply the auto-altitude rules to a route's AUTO legs in place. */
function applyAutoAltitudesTo(
	wps: Waypoint[],
	vfr: boolean,
	airspaces: Airspace[] | null,
	legMinElevFt: readonly (number | null)[],
	timeYears: number,
	regime: CruisingRegime,
): void {
	if (wps.length < 2) {
		return;
	}
	const targets = computeCruiseAltitudes(wps, {
		vfr,
		defaultFt: routeSettings.defaultAltitudeFt,
		classA: airspaces,
		semicircular: routeSettings.semicircular,
		legMinElevFt,
		timeYears,
		regime,
	});
	for (let i = 0; i + 1 < wps.length; i++) {
		if (!wps[i].altAuto) {
			continue;
		}
		// Unconditional assignment on purpose: a wps[i].alt read here (even
		// in a guard) would be tracked by MapView's recompute effect, which
		// is keyed on geometry only; reading alt would re-trigger it once
		// per re-level and on every manual altitude edit. Svelte 5's proxied
		// set already skips notification when the value is unchanged.
		wps[i].alt = targets[i];
	}
}

/** Apply the auto-altitude rules (the VFR Class A cap, plus the semicircular
 *  cruising levels when the option is on) to every route's AUTO legs. Manual
 *  legs (altAuto false) are never touched. Driven by a recompute effect in
 *  MapView keyed on the routes' geometry, the VFR flag, the default altitude,
 *  the semicircular option, the airspace-load state and the shared route
 *  terrain; never reads wp.alt, so writing alt here cannot re-trigger that
 *  effect. `airspaces` is null until the dataset loads (no cap yet);
 *  `legMinElevByRoute` carries each route's per-leg minimum ground elevation
 *  (absent / missing legs count as unknown -> sea level, conservative). */
export function applyAutoAltitudes(
	vfr: boolean,
	airspaces: Airspace[] | null,
	legMinElevByRoute?: Record<string, readonly (number | null)[]>,
	yearOverride?: number,
): void {
	// new Date() read once for the magnetic-model year; tests pass yearOverride.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- one-shot read, not state
	const year = yearOverride ?? decimalYearFromDate(new Date());
	const regime = cruisingRegimeForRoutes(
		routes.list.map((r) => r.waypoints),
		airspaces,
	);
	for (const r of routes.list) {
		applyAutoAltitudesTo(r.waypoints, vfr, airspaces, legMinElevByRoute?.[r.id] ?? [], year, regime);
	}
}

/** Set a free waypoint's custom name (shown in the list and the nav log). Blank
 *  clears it back to "Custom point". Stored verbatim so typing spaces doesn't
 *  fight the cursor. */
export function setWaypointName(id: string, name: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (!wp) {
		return;
	}
	recordUndo(`name:${id}`);
	wp.label = name.trim() === '' ? undefined : name;
}

/** Set a waypoint's nav-log note. Stored verbatim; blank clears it. */
export function setWaypointNotes(id: string, notes: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (!wp) {
		return;
	}
	recordUndo(`notes:${id}`);
	wp.notes = notes === '' ? undefined : notes;
}

/** Set a waypoint's manual nav-log frequencies. Trailing whitespace is
 *  trimmed (keeps the YAML block scalar plain and stops an invisible
 *  "auto text + final Enter" override); blank text, or text equal to the
 *  cell's automatic content (`autoText`, as the sheet renders it), hands
 *  the cell back to auto, the setWaypointAltitude idiom. The editor
 *  commits once on blur, so an unchanged commit records no undo step. */
export function setWaypointFreqs(id: string, text: string, autoText?: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (!wp) {
		return;
	}
	const next = text.replace(/\s+$/, '');
	const value = next === '' || next === autoText ? undefined : next;
	if (value === wp.freqsManual) {
		return;
	}
	recordUndo();
	wp.freqsManual = value;
}

/** Hand a waypoint's nav-log frequencies back to automatic. */
export function clearWaypointFreqs(id: string): void {
	const wp = activeRoute().waypoints.find((w) => w.id === id);
	if (wp && wp.freqsManual !== undefined) {
		recordUndo();
		wp.freqsManual = undefined;
	}
}

/** Move the waypoint at `from` to index `to` (both clamped) in the active route. */
export function reorderWaypoint(from: number, to: number): void {
	const r = activeRoute();
	const n = r.waypoints.length;
	if (from < 0 || from >= n) {
		return;
	}
	const dst = Math.max(0, Math.min(n - 1, to));
	if (dst === from) {
		return;
	}
	recordUndo();
	const [wp] = r.waypoints.splice(from, 1);
	r.waypoints.splice(dst, 0, wp);
}

/** Remove a waypoint from the active route; clears the selection if it was it. */
export function removeWaypoint(id: string): void {
	recordUndo();
	const r = activeRoute();
	r.waypoints = r.waypoints.filter((w) => w.id !== id);
	if (r.selectedWaypointId === id) {
		r.selectedWaypointId = null;
	}
}

/** Drop every waypoint of the active route (leaves settings as the user set them). */
export function clearRoute(): void {
	recordUndo();
	const r = activeRoute();
	r.waypoints = [];
	r.selectedWaypointId = null;
}

/** Reset the workspace to the one empty route a session starts with; the shared
 *  settings stay as the user set them, like clearRoute. The route takes a FRESH
 *  id, so the per-route caches keyed on it (terrain, wind, live progress) can't
 *  serve the cleared route's entries to the new one. */
export function clearAllRoutes(): void {
	recordUndo();
	const r: Route = { id: newRouteId(), name: null, waypoints: [], selectedWaypointId: null };
	routes.list = [r];
	routes.activeId = r.id;
	routes.planName = null;
}

// Coords serialise to 4dp (~11 m); reuse an existing free point within this.
const COORD_EPS = 1e-4;

/** Split a route string into tokens: whitespace-separated, with comma-joined
 *  ident lists ("LFPL,LFAI") expanded but coordinate tokens (which contain commas)
 *  kept whole. */
function tokenizeRoute(text: string): string[] {
	const out: string[] = [];
	for (const part of text.trim().split(/\s+/).filter(Boolean)) {
		if (parseCoordToken(part)) {
			out.push(part);
		} else {
			for (const t of part.split(',').filter(Boolean)) {
				out.push(t);
			}
		}
	}
	return out;
}

/** Serialise the active route to a string for the two-way add field: an ident per
 *  anchored waypoint, a Garmin Pilot coordinate token per free point. */
export function serializeRoute(): string {
	return activeRoute()
		.waypoints.map((w) =>
			w.kind !== 'free' && w.ident ? w.ident : formatGarminCoord(w.lat, w.lon),
		)
		.join(' ');
}

/** Replace the active route from a route string (the two-way add field). Each
 *  token is an ICAO / navaid ident (resolved by `resolve`) or a "lat,lon" free
 *  point. Existing waypoints are reused in order so `id` / `alt` / `notes` survive
 *  an edit: anchored matched by ident, free by coords. Tokens that resolve to
 *  nothing are returned in `unresolved` and left out of the route. */
export function setRouteFromText(
	text: string,
	resolve: (token: string) => WaypointAnchor | null,
): { unresolved: string[] } {
	recordUndo(`text:${routes.activeId}`);
	const r = activeRoute();
	// Pools of the current waypoints, consumed FIFO so duplicate idents (a closed
	// LFPL … LFPL route) and repeated free points reconcile in order.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient local index, not reactive state
	const anchored = new Map<string, Waypoint[]>();
	const free: Waypoint[] = [];
	for (const w of r.waypoints) {
		if (w.kind === 'free') {
			free.push(w);
		} else if (w.ident) {
			const k = w.ident.toUpperCase();
			const q = anchored.get(k);
			if (q) {
				q.push(w);
			} else {
				anchored.set(k, [w]);
			}
		}
	}

	const next: Waypoint[] = [];
	const unresolved: string[] = [];
	for (const tok of tokenizeRoute(text)) {
		const coord = parseCoordToken(tok);
		if (coord) {
			const { lat, lon } = coord;
			const i = free.findIndex(
				(w) => Math.abs(w.lat - lat) <= COORD_EPS && Math.abs(w.lon - lon) <= COORD_EPS,
			);
			if (i >= 0) {
				next.push(free.splice(i, 1)[0]);
			} else {
				next.push({
					id: newId(),
					lat,
					lon,
					kind: 'free',
					alt: routeSettings.defaultAltitudeFt,
					altAuto: true,
				});
			}
			continue;
		}
		const anchor = resolve(tok);
		if (!anchor) {
			unresolved.push(tok);
			continue;
		}
		const key = (anchor.ident ?? '').toUpperCase();
		const reuse = anchored.get(key)?.shift();
		if (reuse) {
			// Keep id/alt/notes/freqsManual; refresh the anchor metadata in case
			// data moved.
			reuse.lat = anchor.lat;
			reuse.lon = anchor.lon;
			reuse.kind = anchor.kind;
			reuse.refId = anchor.refId;
			reuse.ident = anchor.ident;
			reuse.label = anchor.label;
			reuse.freq = anchor.freq;
			next.push(reuse);
		} else {
			next.push({
				id: newId(),
				lat: anchor.lat,
				lon: anchor.lon,
				kind: anchor.kind,
				refId: anchor.refId,
				ident: anchor.ident,
				label: anchor.label,
				freq: anchor.freq,
				alt: routeSettings.defaultAltitudeFt,
				altAuto: true,
			});
		}
	}

	r.waypoints = next;
	if (r.selectedWaypointId && !next.some((w) => w.id === r.selectedWaypointId)) {
		r.selectedWaypointId = null;
	}
	return { unresolved };
}

// A free-point name that is really just a "lat, lon" display string (the writer's
// fallback when a free point has no custom label); not a user label.
const COORD_NAME_RE = /^-?\d+(?:\.\d+)?,\s*-?\d+(?:\.\d+)?$/;

/** Replace the whole workspace with the loaded routes (open-file semantics).
 *  Anchored waypoints (with an `ident`) resolve via `resolve` (airports before
 *  navaids, fresh coords / refId / freq / label from current data); free
 *  waypoints (lat/lon, no ident) keep their stored coordinates + name. A name-only
 *  waypoint (no ident, no coords) is dead-reckoned from a resolved neighbour using
 *  its saved leg course + distance and flagged `estimated` (its name is listed in
 *  `reconstructed`); one that can't be placed is listed in `dropped` alongside any
 *  ident that no longer resolves. Routes past MAX_ROUTES are dropped (`truncated`).
 *  A `settings` block applies its stated keys to `routeSettings` (absent keys
 *  keep the session values); loaded altitudes are never rewritten here, the
 *  MapView effect re-levels the auto legs and redraws. `year` (for the
 *  magnetic model) is injectable for tests. */
export function loadRoutes(
	parsed: {
		routes: LoadedRoute[];
		planName?: string | undefined;
		settings?: LoadedSettings | undefined;
	},
	resolve: (token: string) => WaypointAnchor | null,
	yearOverride?: number,
): { dropped: string[]; truncated: boolean; reconstructed: string[] } {
	recordUndo();
	if (parsed.settings) {
		const s = parsed.settings;
		if (s.vfr !== undefined) {
			setRouteVfr(s.vfr);
		}
		if (s.semicircular !== undefined) {
			routeSettings.semicircular = s.semicircular;
		}
		// Absent (or malformed) transition_altitude = automatic: the one
		// settings key where absence states a value (clear the override),
		// mirroring the fuel plan's final_reserve convention.
		routeSettings.transitionAltitudeFt = s.transitionAltitudeFt ?? null;
		if (s.windForecast !== undefined) {
			windAloft.useForecastForLegs = s.windForecast;
		}
		if (s.temperatureTas !== undefined) {
			windAloft.tempTas = s.temperatureTas;
		}
	}
	// new Date() read once for the magnetic-model year; tests pass yearOverride.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const year = yearOverride ?? decimalYearFromDate(new Date());
	const dropped: string[] = [];
	const reconstructed: string[] = [];
	const truncated = parsed.routes.length > MAX_ROUTES;
	const list: Route[] = [];
	for (const sr of parsed.routes.slice(0, MAX_ROUTES)) {
		// Phase A: resolve anchored idents + free coords. `known[i]` is the position
		// of waypoint i, or null for an unresolved ident (a barrier) or a name-only
		// target. Everything stays indexed by source position.
		const anchors: (WaypointAnchor | null)[] = sr.waypoints.map((sw) =>
			sw.ident ? resolve(sw.ident) : null,
		);
		const known: (LatLon | null)[] = sr.waypoints.map((sw, i) => {
			const a = anchors[i];
			if (a) {
				return { lat: a.lat, lon: a.lon };
			}
			return sw.lat !== undefined && sw.lon !== undefined ? { lat: sw.lat, lon: sw.lon } : null;
		});
		// Phase B: dead-reckon the name-only waypoints from resolved neighbours.
		const pos = reconstructPositions(sr.waypoints, known, year);
		// Phase C: build the waypoints.
		const waypoints: Waypoint[] = [];
		for (let i = 0; i < sr.waypoints.length; i++) {
			const sw = sr.waypoints[i];
			const alt = sw.altitude ?? routeSettings.defaultAltitudeFt;
			const altAuto = sw.auto ?? true;
			const label = sw.name && !COORD_NAME_RE.test(sw.name) ? sw.name : undefined;
			if (sw.ident) {
				const a = anchors[i];
				if (!a) {
					dropped.push(sw.ident);
					continue;
				}
				waypoints.push({
					id: newId(),
					lat: a.lat,
					lon: a.lon,
					kind: a.kind,
					refId: a.refId,
					ident: a.ident,
					label: a.label,
					freq: a.freq,
					alt,
					altAuto,
					windDirDeg: sw.windDirDeg,
					windSpeedKt: sw.windSpeedKt,
					notes: sw.notes,
					freqsManual: sw.freqsManual,
				});
			} else if (sw.lat !== undefined && sw.lon !== undefined) {
				waypoints.push({
					id: newId(),
					lat: sw.lat,
					lon: sw.lon,
					kind: 'free',
					label,
					alt,
					altAuto,
					windDirDeg: sw.windDirDeg,
					windSpeedKt: sw.windSpeedKt,
					notes: sw.notes,
					freqsManual: sw.freqsManual,
				});
			} else {
				// Name-only: placed approximately by dead reckoning, or dropped.
				const p = pos[i];
				if (!p) {
					dropped.push(sw.name ?? '(unnamed)');
					continue;
				}
				waypoints.push({
					id: newId(),
					lat: p.lat,
					lon: p.lon,
					kind: 'free',
					label,
					alt,
					altAuto,
					windDirDeg: sw.windDirDeg,
					windSpeedKt: sw.windSpeedKt,
					notes: sw.notes,
					freqsManual: sw.freqsManual,
					estimated: true,
				});
				if (sw.name) {
					reconstructed.push(sw.name);
				}
			}
		}
		list.push({
			id: newRouteId(),
			name: sr.name,
			waypoints,
			selectedWaypointId: null,
			alternate: sr.alternate ? true : undefined,
		});
	}
	// Keep the non-empty invariant if the file had no usable routes.
	if (list.length === 0) {
		list.push({ id: newRouteId(), name: null, waypoints: [], selectedWaypointId: null });
	}
	routes.list = list;
	routes.activeId = list[0].id;
	// Unconditional: a file with no name must clear the previous plan's, the
	// workspace being replaced whole.
	routes.planName = normalizePlanName(parsed.planName);
	return { dropped, truncated, reconstructed };
}

export function selectWaypoint(id: string | null): void {
	activeRoute().selectedWaypointId = id;
}

/** Toggle edit mode; clears the active route's selection when turning off so no
 *  highlight lingers. */
export function setEditMode(on: boolean): void {
	routeSettings.editMode = on;
	if (!on) {
		activeRoute().selectedWaypointId = null;
	}
}

export function waypointById(id: string): Waypoint | undefined {
	return activeRoute().waypoints.find((w) => w.id === id);
}

/** Per-leg great-circle distances (NM) of the active route. */
export function legDistancesNM(): number[] {
	const wps = activeRoute().waypoints;
	const out: number[] = [];
	for (let i = 0; i + 1 < wps.length; i++) {
		out.push(
			equirectangularDistanceM(wps[i].lat, wps[i].lon, wps[i + 1].lat, wps[i + 1].lon) /
				NM_TO_METERS,
		);
	}
	return out;
}

/** Total distance (NM) of the active route. */
export function totalDistanceNM(): number {
	return legDistancesNM().reduce((s, d) => s + d, 0);
}

/** Estimated total time in minutes at the given cruise speed, or null when
 *  unset. Takes the speed as a parameter (callers pass the effective value
 *  from aircraft.svelte.ts) so this module never imports aircraft state. */
export function estimatedTimeMin(cruiseKt: number | null): number | null {
	if (!cruiseKt || cruiseKt <= 0) {
		return null;
	}
	return (totalDistanceNM() / cruiseKt) * 60;
}

/** True when the active route returns to its start (>= 3 waypoints, first == last). */
export function routeIsClosed(): boolean {
	const wps = activeRoute().waypoints;
	if (wps.length < 3) {
		return false;
	}
	const a = wps[0];
	const b = wps[wps.length - 1];
	return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6;
}
