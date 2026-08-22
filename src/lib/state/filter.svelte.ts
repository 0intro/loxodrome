/* NOTAM display filters and the app's viewing conditions.
 *
 * Two kinds of field live here, and the split is the point. The DATA filters
 * (query, kind, flight rules) subset the parsed briefing and belong to the
 * NOTAMs tab's funnel. The VIEWING CONDITIONS (the time window, the altitude
 * band) say WHEN and AT WHAT LEVELS the whole map is being read, and every
 * dated surface applies them: the NOTAM list and map layer, SUP AIP zones,
 * SIGMETs, the airspace activation hatch, the navaid / obstacle cue rings and
 * the profile overlays. Their controls are the toolbar chips, reachable with
 * no briefing loaded, which the funnel is not.
 *
 * The window's inputs live here; resolving them is timeWindow.svelte.ts, and
 * the resolved window is activeEvalWindow() in notam.svelte.ts. */

import { t } from './i18n.svelte';
import { readItem, removeItem, writeItem } from './persist';

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
const ALTITUDE_KEY = 'loxodrome:altitude-band';

/** The stored level band: 'off', a "floor,ceiling" pair, or absent for the
 *  default. readItem degrades to null on storage failure, so the default
 *  stands. */
function initialAltitudeBand(): { enabled: boolean; floor: number; ceiling: number } {
	const raw = readItem(ALTITUDE_KEY);
	if (raw === 'off') {
		return { ...DEFAULT_ALTITUDE, enabled: false };
	}
	const m = /^(\d+),(\d+)$/.exec(raw ?? '');
	if (!m) {
		return { ...DEFAULT_ALTITUDE };
	}
	const floor = Number(m[1]);
	const ceiling = Number(m[2]);
	return floor <= ceiling
		? { enabled: true, floor, ceiling }
		: { ...DEFAULT_ALTITUDE };
}

export const filter = $state<{
	/** Free-text search over NOTAM id and content. */
	query: string;
	/** Visibility per coordinate kind:
	 *  - area: polygon NOTAM (≥ 3 vertices)
	 *  - position: single coord parsed from the E-section
	 *  - qualifierLine: single coord taken from the Q) line (parser fallback) */
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
	 * Session state on purpose, unlike the altitude band: a window chosen days
	 * ago would open on a briefing that hides what is in force today.
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
	 *  enabled rather than only when it differs from this default. */
	altitude: { enabled: boolean; floor: number; ceiling: number };
	/** Flight-rules relevance filter, keyed on the Q-line traffic qualifier.
	 *  'vfr' (default) hides IFR-only NOTAMs (traffic 'I'); 'ifr' hides
	 *  VFR-only ('V'); 'all' hides neither. NOTAMs tagged 'IV' (relevant to
	 *  both) or with no parsed traffic qualifier always pass. */
	trafficMode: 'all' | 'vfr' | 'ifr';
}>({
	query: '',
	kind: { area: true, position: true, qualifierLine: true },
	window: {
		mode: 'now',
		horizonH: DEFAULT_HORIZON_H,
		fromDate: '',
		fromTime: '',
		toDate: '',
		toTime: '',
	},
	altitude: initialAltitudeBand(),
	trafficMode: 'vfr',
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
 *  (today 00:00 to tomorrow 00:00) so the fields are never blank on arrival;
 *  anything already typed is kept, so leaving and returning does not clobber
 *  it. */
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
		filter.window.toDate = todayUtc(1);
	}
	if (!filter.window.toTime) {
		filter.window.toTime = '00:00';
	}
}

/** Mirror the level band to storage, the key existing only away from the
 *  default 0 to 10 000 ft band, so an untouched filter leaves no storage
 *  behind. Called from PersistHost's effect; the reads here are its tracking. */
export function persistAltitudeBand(): void {
	const a = filter.altitude;
	if (!a.enabled) {
		writeItem(ALTITUDE_KEY, 'off');
	} else if (a.floor === DEFAULT_ALTITUDE.floor && a.ceiling === DEFAULT_ALTITUDE.ceiling) {
		removeItem(ALTITUDE_KEY);
	} else {
		writeItem(ALTITUDE_KEY, `${a.floor},${a.ceiling}`);
	}
}

/** Set the 'now' look-ahead, in hours, or null for unbounded. */
export function setWindowHorizon(hours: number | null): void {
	filter.window.horizonH = hours;
}

/** The active altitude band in feet, or null when the filter is off / invalid. */
export function activeAltitudeBand(): { floor: number; ceiling: number } | null {
	if (!filter.altitude.enabled) {
		return null;
	}
	const { floor, ceiling } = filter.altitude;
	if (!Number.isFinite(floor) || !Number.isFinite(ceiling) || floor > ceiling) {
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

/** Same as `windowError`, for the altitude band. */
export function altitudeError(): string | null {
	if (!filter.altitude.enabled) {
		return null;
	}
	const { floor, ceiling } = filter.altitude;
	if (!Number.isFinite(floor) || !Number.isFinite(ceiling)) {
		return t.errors.filterFloorCeilingNumbers;
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
export type FilterChip = { id: 'rules' } | { id: 'kind'; on: number; total: number };

/** Everything clearFilterDimension can reset: the chips, plus the level
 *  band, which "Show all" clears although it has no chip of its own (the
 *  toolbar carries it). The period is deliberately absent: it demotes
 *  out-of-window NOTAMs to their own section rather than dropping them, so
 *  it can never be why a list came up empty. */
export type FilterDimension = FilterChip['id'] | 'altitude';

/** The dimensions that currently restrict the NOTAM list, in display order:
 *  flight rules when not 'all', kind when any box is unchecked. The text query
 *  is deliberately not a chip: the search box above the list already displays
 *  it. */
export function activeFilterChips(): FilterChip[] {
	const chips: FilterChip[] = [];
	if (filter.trafficMode !== 'all') {
		chips.push({ id: 'rules' });
	}
	const kind = [filter.kind.position, filter.kind.area, filter.kind.qualifierLine];
	if (kind.some((v) => !v)) {
		chips.push({ id: 'kind', on: kind.filter(Boolean).length, total: kind.length });
	}
	return chips;
}

/** Reset one dimension to its non-restricting state: flight rules widen to
 *  All, kind re-checks every box, the altitude band switches off. */
export function clearFilterDimension(id: FilterDimension): void {
	switch (id) {
		case 'altitude':
			filter.altitude.enabled = false;
			break;
		case 'rules':
			filter.trafficMode = 'all';
			break;
		case 'kind':
			filter.kind = { area: true, position: true, qualifierLine: true };
			break;
	}
}

/** One-tap "Show all" for a filtered-out list: clear every dimension that can
 *  REMOVE a row, plus the text query. The window is left alone on purpose; it
 *  demotes out-of-period NOTAMs to their own section rather than dropping
 *  them, so it can never be why the list came up empty. */
export function clearRestrictingFilters(): void {
	filter.query = '';
	for (const id of ['altitude', 'rules', 'kind'] as const) {
		clearFilterDimension(id);
	}
}
