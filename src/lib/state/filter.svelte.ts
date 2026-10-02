/* NOTAM display filters and the app's viewing conditions.
 *
 * Two kinds of field live here, and the split is the point. The DATA filters
 * (query, kind, flight rules, the route corridor) subset the parsed briefing
 * and belong to the NOTAMs tab's funnel. The VIEWING CONDITIONS (the time
 * window, the altitude band) say WHEN and AT WHAT LEVELS the whole map is
 * being read, and every dated surface applies them: the NOTAM list and map
 * layer, SUP AIP zones, SIGMETs, the airspace activation hatch, the navaid /
 * obstacle cue rings and the profile overlays. Their controls are the toolbar
 * chips, reachable with no briefing loaded, which the funnel is not.
 *
 * What persists (docs/preferences.md): every filter that is a standing
 * choice, through its setter and only away from its default, and each one
 * that hides something shows it while it does (the chips above the list, the
 * toolbar's emphasised chips). The search text is a question, not a choice,
 * and the period's mode and custom dates are dated: those stay session-only.
 *
 * The window's inputs live here; resolving them is timeWindow.svelte.ts, and
 * the resolved window is activeEvalWindow() in notam.svelte.ts. */

import { t } from './i18n.svelte';
import { readItem, removeItem, writeItem } from './persist';

/** The Flight-rules filter: 'all' hides nothing, 'vfr' hides IFR-only
 *  NOTAMs, 'ifr' VFR-only ones. */
export type TrafficMode = 'all' | 'vfr' | 'ifr';

/** The coordinate kinds the Kind filter shows or hides. */
export type NotamKind = 'area' | 'position' | 'qualifierLine';
const NOTAM_KINDS: readonly NotamKind[] = ['area', 'position', 'qualifierLine'];

/** How the evaluation window is sourced. */
export type WindowMode = 'now' | 'flight' | 'custom';

/** Look-ahead choices for mode 'now', hours; null is unbounded. The 6 to 48
 *  range is Garmin Pilot's for the same purpose ("from three to 48 hours in
 *  the future"), and it is what keeps a 30-day autorouter tail off the map
 *  without typing a range. */
export const HORIZON_CHOICES_H: readonly (number | null)[] = [6, 24, 48, null];

/** The default look-ahead: unbounded. Nothing scheduled ahead is hidden until
 *  the pilot narrows the period, so the map errs towards showing a restriction
 *  early rather than withholding it. Picking a bound is a decluttering choice
 *  and stays the user's, which is what the look-ahead control is for. */
export const DEFAULT_HORIZON_H: number | null = null;

const DEFAULT_ALTITUDE = { enabled: true, floor: 0, ceiling: 10000 };
const DEFAULT_ALTITUDE_PAIR = `${DEFAULT_ALTITUDE.floor},${DEFAULT_ALTITUDE.ceiling}`;
const ALTITUDE_KEY = 'loxodrome:altitude-band';
const RULES_KEY = 'loxodrome:notam-rules';
const KIND_KEY = 'loxodrome:notam-kind';
const HORIZON_KEY = 'loxodrome:notam-horizon';
const ROUTE_ONLY_KEY = 'loxodrome:notams-on-route';

/** The stored level band: absent for the default 0 to 10 000 ft band on, a
 *  "floor,ceiling" pair for another band on, 'off' for the default band
 *  switched off, "off:floor,ceiling" for another band switched off (so
 *  switching a band off and on again keeps it). readItem degrades to null on
 *  storage failure, so the default stands. */
function initialAltitudeBand(): { enabled: boolean; floor: number; ceiling: number } {
	const raw = readItem(ALTITUDE_KEY);
	if (raw === 'off') {
		return { ...DEFAULT_ALTITUDE, enabled: false };
	}
	const m = /^(off:)?(\d+),(\d+)$/.exec(raw ?? '');
	if (!m) {
		return { ...DEFAULT_ALTITUDE };
	}
	const floor = Number(m[2]);
	const ceiling = Number(m[3]);
	// The writer's own test (writeAltitudeBand): whole feet it can spell back,
	// so a twenty-digit ceiling read as 1e20, or a 400-digit one as Infinity
	// (which boots the band into its "must be numbers" error), reads as the
	// default instead.
	return Number.isSafeInteger(floor) && Number.isSafeInteger(ceiling) && floor <= ceiling
		? { enabled: m[1] === undefined, floor, ceiling }
		: { ...DEFAULT_ALTITUDE };
}

/** The pilot's pinned flight rules, or null while the route drives them. */
function initialRulesPin(): TrafficMode | null {
	const v = readItem(RULES_KEY);
	return v === 'all' || v === 'vfr' || v === 'ifr' ? v : null;
}

/** The kinds shown: every one but those the stored list hides. */
function initialKind(): Record<NotamKind, boolean> {
	const hidden = (readItem(KIND_KEY) ?? '').split(',');
	return {
		area: !hidden.includes('area'),
		position: !hidden.includes('position'),
		qualifierLine: !hidden.includes('qualifierLine'),
	};
}

function initialHorizon(): number | null {
	const v = Number(readItem(HORIZON_KEY));
	return v > 0 && HORIZON_CHOICES_H.includes(v) ? v : DEFAULT_HORIZON_H;
}

const rulesPin = initialRulesPin();

export const filter = $state<{
	/** Free-text search over NOTAM id and content: the COMMITTED value, the
	 *  one filteredNotams() keys on. Written from the search box through
	 *  setSearchQuery, which debounces; a caller with a value already in hand
	 *  (the "Show all" reset, a test) may write it directly, and should write
	 *  queryDraft with it. */
	query: string;
	/** What the search box shows. Tracks every keystroke, while `query`
	 *  follows a pause: committing per keystroke re-ran the whole filter and
	 *  tore down and rebuilt every NOTAM marker on the map, which cost about
	 *  190 ms a letter on a European briefing. */
	queryDraft: string;
	/** Visibility per coordinate kind:
	 *  - area: polygon NOTAM (≥ 3 vertices)
	 *  - position: single coord parsed from the E-section
	 *  - qualifierLine: single coord taken from the Q) line (parser fallback)
	 *  Persisted through setNotamKind; the "Kind n/3" chip shows it while a
	 *  box is unchecked. */
	kind: { area: boolean; position: boolean; qualifierLine: boolean };
	/**
	 * The single evaluation window every dated surface is judged against.
	 *
	 * - 'now' (default): the current minute to horizonH hours ahead.
	 * - 'flight': the planned flight's own span, first ETD to last arrival,
	 *   padded either side.
	 * - 'custom': the from/to fields below, UTC. Date and time are kept
	 *   separately so an empty time can default to 00:00.
	 *
	 * The MODE and the custom dates are session state on purpose, unlike the
	 * altitude band: a window chosen days ago would open on a briefing that
	 * hides what is in force today, so every session opens on Now. The
	 * look-ahead persists (setWindowHorizon): Now starts at the current
	 * minute, so a remembered look-ahead cannot hide what is in force now, it
	 * only decides how far ahead the map draws, and the period chip is
	 * emphasised while it is bounded.
	 */
	window: {
		mode: WindowMode;
		horizonH: number | null;
		fromDate: string;
		fromTime: string;
		toDate: string;
		toTime: string;
	};
	/** Global altitude band (feet) applied to NOTAMs, airspaces, SUP AIP zones
	 *  and SIGMETs. Persisted, unlike the window: a band carries no date, so
	 *  restoring one cannot put the map in a period that has passed. It CAN
	 *  hide things that are in force, though (everything above the ceiling),
	 *  which is why the toolbar chip is emphasised the whole time it is
	 *  enabled rather than only when it differs from this default. Switched
	 *  off, a band keeps its range (setAltitudeEnabled). */
	altitude: { enabled: boolean; floor: number; ceiling: number };
	/** Flight-rules relevance filter, keyed on the Q-line traffic qualifier.
	 *  'vfr' (default) hides IFR-only NOTAMs (traffic 'I'); 'ifr' hides
	 *  VFR-only ('V'); 'all' hides neither. NOTAMs tagged 'IV' (relevant to
	 *  both) or with no parsed traffic qualifier always pass. The route's
	 *  flight rules drive it (followRouteRules) until the pilot PINS a value
	 *  (setTrafficMode), which persists; a route gesture or the popover's
	 *  Route option (followTrafficRoute) unpins it. */
	trafficMode: TrafficMode;
	/** The pilot pinned trafficMode (the one stored; absent = follow the
	 *  route, whose drive is automatic and never written, docs/preferences.md
	 *  rule 2). */
	trafficPinned: boolean;
	/** "Show only route NOTAMs": keep only the NOTAMs relevant to any route's
	 *  corridor (state/notamCorridor.svelte.ts), a filteredNotams() dimension
	 *  like its siblings here. Inert while no route has two waypoints; while
	 *  it applies, the NOTAMs tab shows it as the Route corridor chip and
	 *  "Show all" clears it. Persisted through setNotamsOnRouteOnly; the Route
	 *  tab's Planning options and the Filters popover carry the switch. */
	notamsOnRouteOnly: boolean;
}>({
	query: '',
	queryDraft: '',
	kind: initialKind(),
	window: {
		mode: 'now',
		horizonH: initialHorizon(),
		fromDate: '',
		fromTime: '',
		toDate: '',
		toTime: '',
	},
	altitude: initialAltitudeBand(),
	trafficMode: rulesPin ?? 'vfr',
	trafficPinned: rulesPin !== null,
	notamsOnRouteOnly: readItem(ROUTE_ONLY_KEY) === 'on',
});

/** Combine a `YYYY-MM-DD` date and an optional `HH:MM` time into epoch ms UTC.
 *  An empty time defaults to midnight (00:00). Returns NaN if the date is empty. */
export function parseUtcDateTime(date: string, time: string): number {
	if (!date) {
		return NaN;
	}
	const t = time || '00:00';
	return Date.parse(date + 'T' + t + ':00Z');
}

function todayUtc(offsetDays = 0): string {
	// One-shot timestamps used to format the default values; not reactive.
	const now = new Date();
	const d = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays),
	);
	const p = (n: number): string => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** Switch the window's source. Entering 'custom' pre-fills the current UTC day
 *  (today 00:00 to 23:59) so the fields are never blank on arrival; anything
 *  already typed is kept, so leaving and returning does not clobber it. The
 *  end is the day's last minute, not tomorrow's first: every resolver
 *  compares both ends inclusively, and a tomorrow 00:00 end charged today
 *  with a closure starting at midnight (the flight day's own boundary rule,
 *  timeWindow.svelte.ts dayRange). */
export function setWindowMode(mode: WindowMode): void {
	filter.window.mode = mode;
	if (mode !== 'custom') {
		return;
	}
	if (!filter.window.fromDate) {
		filter.window.fromDate = todayUtc();
	}
	if (!filter.window.fromTime) {
		filter.window.fromTime = '00:00';
	}
	if (!filter.window.toDate) {
		filter.window.toDate = todayUtc();
	}
	if (!filter.window.toTime) {
		filter.window.toTime = '23:59';
	}
}

/** The range the stored band holds, as its "floor,ceiling" pair, or null for
 *  the default range (nothing stored, or a bare 'off'). */
function storedAltitudePair(): string | null {
	const m = /^(?:off:)?(\d+),(\d+)$/.exec(readItem(ALTITUDE_KEY) ?? '');
	const floor = m ? Number(m[1]) : NaN;
	const ceiling = m ? Number(m[2]) : NaN;
	return Number.isSafeInteger(floor) && Number.isSafeInteger(ceiling) && floor <= ceiling
		? `${floor},${ceiling}`
		: null;
}

/** Mirror the level band to storage (initialAltitudeBand's grammar), the key
 *  existing only away from the default band on, so an untouched filter
 *  leaves no storage behind. Only what that grammar reads back is written:
 *  whole feet, a floor at or above zero and at or below its ceiling. A band
 *  half typed (a box emptied, a floor above its ceiling, a minus sign on its
 *  way to nothing the reader takes) keeps the last good range stored,
 *  whichever way its switch is flipped meanwhile. */
function writeAltitudeBand(): void {
	const { enabled } = filter.altitude;
	const floor = Math.round(filter.altitude.floor);
	const ceiling = Math.round(filter.altitude.ceiling);
	const typed =
		Number.isSafeInteger(floor) && Number.isSafeInteger(ceiling) && floor >= 0 && floor <= ceiling
			? `${floor},${ceiling}`
			: null;
	const pair = typed ?? storedAltitudePair() ?? DEFAULT_ALTITUDE_PAIR;
	const isDefault = pair === DEFAULT_ALTITUDE_PAIR;
	if (!enabled) {
		writeItem(ALTITUDE_KEY, isDefault ? 'off' : `off:${pair}`);
	} else if (isDefault) {
		removeItem(ALTITUDE_KEY);
	} else {
		writeItem(ALTITUDE_KEY, pair);
	}
}

/** Switch the level band on or off; its range stays as it is. */
export function setAltitudeEnabled(on: boolean): void {
	filter.altitude.enabled = on;
	writeAltitudeBand();
}

/** Set the level band's range, in feet (the slider, the two boxes). */
export function setAltitudeBand(floor: number, ceiling: number): void {
	filter.altitude.floor = floor;
	filter.altitude.ceiling = ceiling;
	writeAltitudeBand();
}

/** Set the 'now' look-ahead, in hours, or null for unbounded, and remember
 *  it: stored only while bounded. */
export function setWindowHorizon(hours: number | null): void {
	filter.window.horizonH = hours;
	if (hours === DEFAULT_HORIZON_H) {
		removeItem(HORIZON_KEY);
	} else {
		writeItem(HORIZON_KEY, String(hours));
	}
}

/** The pilot's own pick of flight rules in the Filters popover: PINNED and
 *  remembered, even a pick equal to what the route would say, until a route
 *  gesture or the popover's Route option (followTrafficRoute) hands the
 *  filter back to the route (followRouteRules). */
export function setTrafficMode(mode: TrafficMode): void {
	filter.trafficMode = mode;
	filter.trafficPinned = true;
	writeItem(RULES_KEY, mode);
}

/** The Filters popover's Route option, the "follow the route" state rule 2
 *  of docs/preferences.md says the control offers: the pin (the stored key)
 *  goes and the route's own rules drive the filter again. Offered only while
 *  a routed plan exists, over the rules planScope.flightRules supplies, so
 *  never in the NOTAM Viewer. */
export function followTrafficRoute(routeRules: 'vfr' | 'ifr'): void {
	followRouteRules(routeRules === 'vfr', true);
}

/** What the Filters popover's flight-rules control reads: Route while the
 *  routed plan's rules (`routeRules`, null without a routed plan) drive an
 *  unpinned filter, else the mode in force, so a session's Show all reads
 *  All, as it is, and a pin reads as the value it pinned. */
export function trafficChoice(routeRules: 'vfr' | 'ifr' | null): 'route' | TrafficMode {
	return routeRules !== null && !filter.trafficPinned && filter.trafficMode === routeRules
		? 'route'
		: filter.trafficMode;
}

/** The route's own flight rules, driving the filter while nothing pins it
 *  (route.svelte.ts setRouteVfr; followTrafficRoute). A GESTURE (the Route tab's
 *  VFR / IFR, a file the pilot opened or a plan activated that states its
 *  rules; one that states none leaves them, and the pin, as they were) hands
 *  the filter back to the route first; the boot reading the stored
 *  workspace back is not a gesture and leaves a pin standing, which is what
 *  lets a pinned pick survive a reload. The drive itself is never stored.
 *  Show all and a chip's x show every rule for the session over whatever
 *  holds (showEveryFlightRule): a pin comes back with the next session, and
 *  an unpinned filter follows the route again at its next drive. */
export function followRouteRules(vfr: boolean, gesture: boolean): void {
	if (gesture && filter.trafficPinned) {
		filter.trafficPinned = false;
		removeItem(RULES_KEY);
	}
	if (!filter.trafficPinned) {
		filter.trafficMode = vfr ? 'vfr' : 'ifr';
	}
}

/** Show or hide one coordinate kind, and remember it: the stored list names
 *  the kinds HIDDEN, and goes when every box is checked. */
export function setNotamKind(kind: NotamKind, on: boolean): void {
	filter.kind[kind] = on;
	const hidden = NOTAM_KINDS.filter((k) => !filter.kind[k]);
	if (hidden.length === 0) {
		removeItem(KIND_KEY);
	} else {
		writeItem(KIND_KEY, hidden.join(','));
	}
}

/** Keep only the NOTAMs of the routes' corridor, or not, and remember it. */
export function setNotamsOnRouteOnly(on: boolean): void {
	filter.notamsOnRouteOnly = on;
	if (on) {
		writeItem(ROUTE_ONLY_KEY, 'on');
	} else {
		removeItem(ROUTE_ONLY_KEY);
	}
}

/** The active altitude band in feet, or null when the filter is off / invalid. */
export function activeAltitudeBand(): { floor: number; ceiling: number } | null {
	if (!filter.altitude.enabled) {
		return null;
	}
	const { floor, ceiling } = filter.altitude;
	if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || floor < 0 || floor > ceiling) {
		return null;
	}
	return { floor, ceiling };
}

/**
 * A human-readable explanation when the window is set to a custom range that
 * won't take effect (missing date inputs, or `from` > `to`); null otherwise.
 */
export function windowError(): string | null {
	if (filter.window.mode !== 'custom') {
		return null;
	}
	const fromOk = !!filter.window.fromDate;
	const toOk = !!filter.window.toDate;
	if (!fromOk && !toOk) {
		return t.errors.filterPickBothDates;
	}
	if (!fromOk) {
		return t.errors.filterPickFromDate;
	}
	if (!toOk) {
		return t.errors.filterPickToDate;
	}
	const from = parseUtcDateTime(filter.window.fromDate, filter.window.fromTime);
	const to = parseUtcDateTime(filter.window.toDate, filter.window.toTime);
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return t.errors.filterInvalidDateTime;
	}
	if (from > to) {
		return t.errors.filterFromAfterTo;
	}
	return null;
}

/** The typed UTC range as epoch ms, or null when the window is not in custom
 *  mode or the inputs are not a valid from <= to pair. The positive answer to
 *  the question `windowError` answers negatively, off the same two fields and
 *  the same parse, which is why the two sit together. */
export function customWindow(): { from: number; to: number } | null {
	if (filter.window.mode !== 'custom') {
		return null;
	}
	const from = parseUtcDateTime(filter.window.fromDate, filter.window.fromTime);
	const to = parseUtcDateTime(filter.window.toDate, filter.window.toTime);
	if (Number.isNaN(from) || Number.isNaN(to) || from > to) {
		return null;
	}
	return { from, to };
}

/** Same as `windowError`, for the altitude band. */
export function altitudeError(): string | null {
	if (!filter.altitude.enabled) {
		return null;
	}
	const { floor, ceiling } = filter.altitude;
	if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) {
		return t.errors.filterFloorCeilingNumbers;
	}
	// Below the surface is no band the stored form takes (writeAltitudeBand),
	// so it is an error here like the others, not a band that quietly
	// reverts at the next load.
	if (floor < 0) {
		return t.errors.filterFloorNegative;
	}
	if (floor > ceiling) {
		return t.errors.filterFloorAboveCeiling;
	}
	return null;
}

/** One restricting filter dimension, shown as a dismissable chip above the
 *  NOTAM list. Kind carries how many of its boxes stay checked (the "Kind 2/3"
 *  chip form). The window and the altitude band are viewing conditions with
 *  their own always-visible toolbar chips, so they never appear here. */
export type FilterChip =
	| { id: 'rules' }
	| { id: 'route' }
	| { id: 'kind'; on: number; total: number };

/** Everything clearFilterDimension can reset: the chips, plus the level
 *  band, which "Show all" clears although it has no chip of its own (the
 *  toolbar carries it). The period is deliberately absent: it demotes
 *  out-of-window NOTAMs to their own section rather than dropping them, so
 *  clearing filters would never bring them back, and the NOTAMs tab says so
 *  separately when they are all the list has. */
export type FilterDimension = FilterChip['id'] | 'altitude';

/** The dimensions that currently restrict the NOTAM list, in display order:
 *  flight rules when not 'all', the route corridor while it applies, kind
 *  when any box is unchecked. `route` says whether the app has a routed plan
 *  for the corridor to apply to (a prop from the shell: this module cannot
 *  read the routes), without which the switch is inert and no chip shows.
 *  The text query is deliberately not a chip: the search box above the list
 *  already displays it. */
export function activeFilterChips(opts: { route?: boolean | undefined } = {}): FilterChip[] {
	const chips: FilterChip[] = [];
	if (filter.trafficMode !== 'all') {
		chips.push({ id: 'rules' });
	}
	if (opts.route === true && filter.notamsOnRouteOnly) {
		chips.push({ id: 'route' });
	}
	const kind = [filter.kind.position, filter.kind.area, filter.kind.qualifierLine];
	if (kind.some((v) => !v)) {
		chips.push({ id: 'kind', on: kind.filter(Boolean).length, total: kind.length });
	}
	return chips;
}

// The search debounce. A plain module timer, deliberately not reactive.
let queryTimer: ReturnType<typeof setTimeout> | null = null;
const QUERY_DEBOUNCE_MS = 200;

/** Type into the NOTAM search box. The draft updates at once so the field
 *  never lags the keyboard; the committed `query` follows after a pause, or
 *  immediately with `now` (the "Show all" reset, which has no typing behind
 *  it and should read as instant). Clearing the box commits immediately too:
 *  emptying a search is a request to see everything again, and waiting two
 *  tenths of a second for it reads as a stall. */
export function setSearchQuery(text: string, opts: { now?: boolean } = {}): void {
	filter.queryDraft = text;
	if (queryTimer !== null) {
		clearTimeout(queryTimer);
		queryTimer = null;
	}
	if (opts.now || text === '') {
		filter.query = text;
		return;
	}
	queryTimer = setTimeout(() => {
		queryTimer = null;
		filter.query = filter.queryDraft;
	}, QUERY_DEBOUNCE_MS);
}

/** Show the NOTAMs of every flight rule, for the rest of the session: a
 *  chip's x and Show all clear the filter out of the way, which is not a
 *  pick, so the stored choice is left as it was. Stored as a pin of All, it
 *  would stop the route driving the filter in every later session with
 *  nothing on screen saying so (no chip shows at All); dropping a pin the
 *  pilot made in the popover would lose a choice they never took back; and
 *  on loxodrome.fr/notam either would reach into the flight app's filter.
 *  A pin therefore comes back with the next session, and an unpinned filter
 *  follows the route again at its next drive (the boot's restore, a route
 *  gesture). Only the Filters popover pins (setTrafficMode) or unpins
 *  (followTrafficRoute). */
function showEveryFlightRule(): void {
	filter.trafficMode = 'all';
}

/** Reset one dimension to its non-restricting state, through the setters so
 *  the storage follows: flight rules at All for the session (the stored
 *  choice left as it was), the route corridor off, kind re-checks every box,
 *  the altitude band switches off (its range kept). */
export function clearFilterDimension(id: FilterDimension): void {
	switch (id) {
		case 'altitude':
			setAltitudeEnabled(false);
			break;
		case 'rules':
			showEveryFlightRule();
			break;
		case 'route':
			setNotamsOnRouteOnly(false);
			break;
		case 'kind':
			for (const kind of NOTAM_KINDS) {
				setNotamKind(kind, true);
			}
			break;
	}
}

/** One-tap "Show all" for a filtered-out list: clear every dimension that can
 *  REMOVE a row, plus the text query. The route corridor only where it
 *  applies (`route`, as activeFilterChips takes it): the NOTAM Viewer has no
 *  plan, and flipping a switch that does nothing there would flip it for the
 *  flight app reading the same storage. The window is left alone on purpose:
 *  it demotes out-of-period NOTAMs to their own section rather than dropping
 *  them, so clearing it would bring nothing back into the list. */
export function clearRestrictingFilters(opts: { route?: boolean | undefined } = {}): void {
	setSearchQuery('', { now: true });
	for (const id of ['altitude', 'rules', 'kind'] as const) {
		clearFilterDimension(id);
	}
	if (opts.route === true) {
		clearFilterDimension('route');
	}
}

/** A filter preference restoreFilterDefaults can put back. */
export type FilterPref = 'altitude' | 'kind' | 'horizon' | 'rules' | 'route';

/** Every filter preference, restoreFilterDefaults' default scope. */
export const FILTER_PREFS: readonly FilterPref[] = ['altitude', 'kind', 'horizon', 'rules', 'route'];

/** Put filter preferences back to their defaults, in place, storage
 *  included: the 0 to 10 000 ft band on, every kind shown, an unbounded
 *  look-ahead, the flight rules unpinned (resting at VFR here; Loxodrome
 *  hands them straight back to the route, setRouteVfr), the route corridor
 *  off. The search text, the period's mode and its custom dates are session
 *  state and stay as they are. */
export function restoreFilterDefaults(which: readonly FilterPref[] = FILTER_PREFS): void {
	for (const pref of which) {
		switch (pref) {
			case 'altitude':
				filter.altitude.enabled = DEFAULT_ALTITUDE.enabled;
				setAltitudeBand(DEFAULT_ALTITUDE.floor, DEFAULT_ALTITUDE.ceiling);
				break;
			case 'kind':
				clearFilterDimension('kind');
				break;
			case 'horizon':
				setWindowHorizon(DEFAULT_HORIZON_H);
				break;
			case 'rules':
				filter.trafficPinned = false;
				removeItem(RULES_KEY);
				filter.trafficMode = 'vfr';
				break;
			case 'route':
				setNotamsOnRouteOnly(false);
				break;
		}
	}
}
