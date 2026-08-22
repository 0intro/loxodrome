/* Parsed-NOTAM state and the parse action. */

import { parseNotams } from '$lib/notam/parser';
import { notamIntersectsBbox, type Bbox } from '$lib/notam/geometry';
import {
	classifyOwner,
	firOwnershipIndex,
	type NotamOwner,
	type OwnerResolvers,
} from '$lib/notam/ownership';
import type { AutorouterFetchKind } from '$lib/autorouter/state.svelte';
import type { Notam } from '$lib/notam/types';
import type { SofiaFailureCode } from '$lib/sofia/failure';
import type { NotamSource } from './notamSource.svelte';
import { notamBandFt } from '$lib/vertical/limits';
import { airportLookup, dataState, firIdentSet } from './data.svelte';
import { filter, activeAltitudeBand } from './filter.svelte';
import { memoised } from './memoSelector';
import { routeCorridorNotamIds } from './notamCorridor.svelte';
import { customWindow, plannedFlightWindow } from './timeWindow.svelte';
import { ui } from './ui.svelte';

/** One route the current briefing leaves out, and why. A per-route fetch
 *  brief one corridor at a time, so a briefing can land with some of them
 *  missing; the pilot flies on it, so it states which. */
export interface BriefingGap {
	/** The route's endpoint label, e.g. "LFPL-LFPK". */
	label: string;
	cause: SofiaFailureCode;
	/** The wire line behind the cause, EN by policy (docs/i18n.md rule 7),
	 *  shown as the tooltip beside the translated sentence. */
	detail: string;
}

/** Where the briefing now loaded came from, so the fetch view reports it under
 *  the button that ran it and the foot line names the right source. It belongs
 *  to the briefing, not to a source's status: only one briefing is loaded at a
 *  time, and pasting one or fetching from the other source replaces it whole. */
export interface FetchProvenance {
	source: NotamSource;
	/** Which button ran it; SOFIA fetches are always route fetches. */
	kind: AutorouterFetchKind;
	at: number;
	count: number;
	/** The period the source actually briefed, when it briefs one. A SOFIA
	 *  PIB covers ~24 h from the instant it was asked for, while the viewing
	 *  period can be any width, so a three-day custom range briefs its first
	 *  day and reads as complete. Null when the source states no window (a
	 *  paste, or the autorouter's per-FIR pull). */
	briefed: { from: number; to: number } | null;
}

export const notamState = $state<{
	rawText: string;
	notams: Notam[];
	parsedAt: number;
	/** When the current briefing came from a per-route fetch that did not
	 *  cover every route: how many were asked for, and which are missing.
	 *  Cleared by every fresh parse, like fetchBbox; the route fetch
	 *  re-stamps it right after committing its result. */
	gaps: { total: number; routes: BriefingGap[] } | null;
	/** When the current NOTAMs came from a viewport fetch, the region that
	 *  fetch covered; null for paste / upload. visibleNotams() uses it to hide
	 *  NOTAMs whose area of effect doesn't reach the fetched viewport (a fetch
	 *  pulls in whole FIRs, which carry NOTAMs spread far outside the screen). */
	fetchBbox: Bbox | null;
	/** Which fetch produced the current briefing, or null when it was pasted,
	 *  opened from a file, or never loaded. Cleared by every fresh parse, like
	 *  gaps and fetchBbox; each fetch re-stamps it right after committing. */
	lastFetch: FetchProvenance | null;
	/** Bumped every 60 s by the heartbeat below. Reactive consumers that need
	 *  to re-evaluate over wall-clock time (e.g. the "active now" activation
	 *  link filter in notamLinks.svelte.ts) read this to opt into a tick. */
	tick: number;
}>({
	rawText: '',
	notams: [],
	parsedAt: 0,
	gaps: null,
	fetchBbox: null,
	lastFetch: null,
	tick: 0,
});

/** The heartbeat's period, and the granularity activeEvalWindow() floors to. */
const MINUTE_MS = 60_000;

// One-minute heartbeat. Used by activatedAirspaceLinks() in
// notamLinks.svelte.ts so airspaces stop hatching once their activation
// window closes, by the AIRAC watcher, by the age labels, and by the
// live-weather ensure effects as their auto-refresh pulse (each cache
// still paces itself by its own TTL). Visibility-aware: a hidden tab
// skips beats (nothing renders and the weather ensures must not spend
// quota unseen) and one beat fires immediately on return, so a
// returning user re-evaluates everything at once instead of waiting up
// to a minute. setInterval is started at module load so it covers
// every consumer; cleanup isn't needed (the module lives as long as the
// page).
if (typeof setInterval === 'function') {
	const hidden = (): boolean =>
		typeof document !== 'undefined' && document.visibilityState === 'hidden';
	setInterval(() => {
		if (!hidden()) {
			notamState.tick += 1;
		}
	}, MINUTE_MS);
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', () => {
			if (!hidden()) {
				notamState.tick += 1;
			}
		});
	}
}

/** A NOTAM paired with its index in notamState.notams. */
export interface IndexedNotam {
	notam: Notam;
	index: number;
}

/** Parse the current raw text into NOTAMs.
 *
 *  A fresh parse of pasted / uploaded text isn't viewport-scoped, so the
 *  geographic display filter must not apply; clear fetchBbox. The viewport
 *  fetch re-sets it right after calling this. Pass `reparse` when merely
 *  re-parsing the same text (MapView re-parses once airport coords load so
 *  RDL-anchored NOTAMs resolve): the briefing is the same one, so it keeps
 *  every field the text itself doesn't produce, its fetch provenance
 *  included. */
export function parseInput(opts: { reparse?: boolean } = {}): void {
	notamState.notams = parseNotams(notamState.rawText, {
		lookupAirport: airportLookup,
	});
	notamState.parsedAt = Date.now();
	if (!opts.reparse) {
		notamState.fetchBbox = null;
		notamState.gaps = null;
		notamState.lastFetch = null;
	}
	ui.detail = null;
	ui.detailBack = null;
}

/** Commit a fetched briefing: the raw text becomes the parsed set, and the
 *  three fields that describe WHERE IT CAME FROM are stamped after the
 *  parse that cleared the previous briefing's. Ordering is the whole
 *  point, and it was the same eight lines at each of the three fetch
 *  paths; a fourth would have copied them again.
 *
 *  A fetch that produced nothing must not call this: leaving the earlier
 *  briefing and its coverage intact is what makes a failed fetch harmless
 *  (docs/sofia-briefing.md). */
export function commitBriefing(
	rawText: string,
	provenance: Omit<FetchProvenance, 'at' | 'count'> & {
		fetchBbox?: Bbox | null;
		gaps?: { total: number; routes: BriefingGap[] } | null;
	},
): void {
	notamState.rawText = rawText;
	parseInput();
	notamState.fetchBbox = provenance.fetchBbox ?? null;
	notamState.gaps = provenance.gaps ?? null;
	notamState.lastFetch = {
		source: provenance.source,
		kind: provenance.kind,
		at: Date.now(),
		count: notamState.notams.length,
		briefed: provenance.briefed,
	};
}

/** Reset the input and the parsed NOTAMs. */
export function clearNotams(): void {
	notamState.rawText = '';
	notamState.notams = [];
	notamState.parsedAt = Date.now();
	notamState.gaps = null;
	notamState.fetchBbox = null;
	notamState.lastFetch = null;
	ui.detail = null;
	ui.detailBack = null;
}

/**
 * The NOTAMs passing every DATA filter, each with its source index: the text
 * query, the geometry kind, the flight-rules mode, the fetch region, the route
 * corridor and the altitude band. Deliberately free of the time dimension, so
 * a relationship list can stay explainable when its NOTAM has lapsed; the
 * detail panels and the link modules read this, while visibleNotams() narrows
 * it in time for the map and the list. Reading it in a reactive context tracks
 * both the NOTAM set and the filter.
 */
/** A stable integer per distinct object identity, for the two memo inputs a
 *  signature string cannot hold: the NOTAM array (replaced wholesale by every
 *  parse, and by tests that assign it without stamping parsedAt) and the
 *  corridor id set (whose own memo hands back a stable reference while its
 *  inputs hold). Keying on parsedAt instead would go stale in exactly those
 *  tests, and the failures would read as parser bugs. */
function identityToken(box: { ref: unknown; token: number }, value: unknown): number {
	if (value !== box.ref) {
		box.ref = value;
		box.token += 1;
	}
	return box.token;
}

const notamsBox = { ref: null as unknown, token: 0 };
const corridorBox = { ref: null as unknown, token: 0 };

/* One pass per change instead of one per caller. About ten always-live
 * selectors read this (the map layer, the ordered list, the link modules, the
 * cue rings), each of which used to run the whole scan itself, and every
 * keystroke in the search box paid for all of them. The window's `from` is
 * floored to the minute upstream, so a tick that changes nothing still keys
 * the same. */
const filteredMemo = memoised(
	// Every reactive input, unconditionally (the memoSelector contract).
	() => {
		const b = notamState.fetchBbox;
		const band = activeAltitudeBand();
		const corridor = routeCorridorNotamIds(notamState.notams, notamState.parsedAt);
		return (
			`${identityToken(notamsBox, notamState.notams)}|` +
			`${identityToken(corridorBox, corridor)}|` +
			`${b ? `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}` : '-'}|` +
			`${filter.kind.area ? 1 : 0}${filter.kind.position ? 1 : 0}` +
			`${filter.kind.qualifierLine ? 1 : 0}|` +
			`${band ? `${band.floor},${band.ceiling}` : '-'}|` +
			`${filter.trafficMode}|${filter.query.trim().toLowerCase()}`
		);
	},
	() => computeFilteredNotams(),
);

export function filteredNotams(): IndexedNotam[] {
	return filteredMemo();
}

function computeFilteredNotams(): IndexedNotam[] {
	const q = filter.query.trim().toLowerCase();
	const band = activeAltitudeBand();
	const fetchBbox = notamState.fetchBbox;
	const corridorIds = routeCorridorNotamIds(notamState.notams, notamState.parsedAt);
	const out: IndexedNotam[] = [];
	notamState.notams.forEach((notam, index) => {
		// Geographic filter: when the current set came from a viewport fetch,
		// hide NOTAMs whose area of effect doesn't reach the fetched region.
		// Paste / upload leave fetchBbox null, so the whole set shows.
		if (fetchBbox && !notamIntersectsBbox(notam, fetchBbox)) {
			return;
		}
		// Route-corridor filter ("Show only route NOTAMs"): keep only the
		// NOTAMs relevant to one of the routes' corridors. Keyed by source
		// id, so every entry of a multi-area NOTAM passes together; null when
		// the toggle is off or no route has a corridor. Independent of
		// fetchBbox: both can apply, the corridor being the stricter one.
		if (corridorIds && !corridorIds.has(notam.id)) {
			return;
		}
		const kind = notam.isPolygon
			? 'area'
			: notam.coordinates[0]?.type === 'qualifierLine'
				? 'qualifierLine'
				: 'position';
		if (!filter.kind[kind]) {
			return;
		}
		// Altitude filter, per the OPADD precedence: the operational F)/G)
		// limits win when parsed, else the coarse Q-line band applies
		// (000 = from the surface, 999 = unbounded). A NOTAM with no
		// vertical statement always passes.
		if (band) {
			const nb = notamBandFt(notam.fgLower, notam.fgUpper, notam.qualifier);
			if (nb && !(nb.floor <= band.ceiling && nb.ceiling >= band.floor)) {
				return;
			}
		}
		// Flight-rules filter. 'vfr' (default) hides IFR-only NOTAMs (Q-line
		// traffic 'I'); 'ifr' hides VFR-only ('V'); 'all' hides neither.
		// NOTAMs tagged 'IV' (both) or without a parsed traffic qualifier
		// always pass (never hide a NOTAM on absence of a qualifier).
		const traffic = (notam.qualifier?.traffic ?? '').toUpperCase();
		if (filter.trafficMode === 'vfr' && traffic === 'I') {
			return;
		}
		if (filter.trafficMode === 'ifr' && traffic === 'V') {
			return;
		}
		if (
			q &&
			!notam.id.toLowerCase().includes(q) &&
			!notam.fullContent.toLowerCase().includes(q)
		) {
			return;
		}
		out.push({ notam, index });
	});
	return out;
}

/** The NOTAM's validity as epoch ms, open-ended wherever the source is: a
 *  missing B) or C) item, an unparseable date and C) PERM all read as
 *  unbounded on that side, so a window test never hides a NOTAM because its
 *  own dates are incomplete. */
export function notamSpanMs(n: Notam): { start: number; end: number } {
	const s = n.startDate?.getTime() ?? -Infinity;
	const e = n.permanent ? Infinity : (n.endDate?.getTime() ?? Infinity);
	return {
		start: Number.isNaN(s) ? -Infinity : s,
		end: Number.isNaN(e) ? Infinity : e,
	};
}

/** Does the NOTAM's validity overlap the evaluation window? */
function inWindow(n: Notam, win: { from: number; to: number }): boolean {
	const { start, end } = notamSpanMs(n);
	return start <= win.to && end >= win.from;
}

/**
 * The NOTAMs that should currently be drawn: filteredNotams() narrowed to the
 * evaluation window. Every NOTAM map render and the list's main body read
 * this, so a new data filter only needs adding to filteredNotams() to reach
 * all of them.
 */
export function visibleNotams(): IndexedNotam[] {
	const win = activeEvalWindow();
	return filteredNotams().filter((it) => inWindow(it.notam, win));
}

/** The complement: the NOTAMs a data filter kept but the window puts outside
 *  the period. They are DEMOTED, not dropped, so the list can show them in
 *  their own section and a lapsed NOTAM stays readable and selectable; the map
 *  draws only the in-window set. */
export function outOfWindowNotams(): IndexedNotam[] {
	const win = activeEvalWindow();
	return filteredNotams().filter((it) => !inWindow(it.notam, win));
}

/** THE evaluation window: the period every dated surface is judged against.
 *  The NOTAM map layer and the list's main body (visibleNotams), SUP AIP
 *  zones, SIGMETs, the airspace activation hatch, the navaid / obstacle cue
 *  rings and the profile overlays all read it, and the toolbar's period chip
 *  is its readout.
 *
 *  Three sources, in precedence order: a valid custom range, the planned
 *  flight's own span, else the current minute plus the look-ahead. The
 *  look-ahead reaches far enough ahead that an activation scheduled LATER
 *  (tomorrow's RTBA viewed today) still hatches, while `from` at now drops one
 *  whose window has already closed; set to unbounded it is the old
 *  now → future default. Only that branch opts into the 60-second heartbeat,
 *  so a fixed range does not trigger needless once-a-minute re-renders. */
export function activeEvalWindow(): { from: number; to: number } {
	// Both sourced branches are consulted first so the mode is tracked; either
	// falling through (mode 'now', an invalid range, no flyable trip) lands on
	// the default rather than on a window that would hide everything.
	const custom = customWindow();
	if (custom) {
		return custom;
	}
	const flight = filter.window.mode === 'flight' ? plannedFlightWindow() : null;
	if (flight) {
		return flight;
	}
	void notamState.tick;
	// Floored to the minute so every caller in one render pass reads the SAME
	// instant: the window is compared against by a dozen selectors, and a
	// `from` that moves between them would defeat any memo keyed on it. The
	// heartbeat is a minute anyway, and flooring can only keep something on
	// screen a little longer, never hide it early.
	const from = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
	const h = filter.window.horizonH;
	return { from, to: h == null ? Infinity : from + h * 60 * MINUTE_MS };
}

/** The NOTAM currently shown in the detail panel, or null. */
export function selectedNotam(): Notam | null {
	if (ui.detail?.kind !== 'notam') {
		return null;
	}
	return notamState.notams[ui.detail.index] ?? null;
}

/**
 * Index the data-filtered NOTAMs by airport ICAO (upper-case) from their
 * A) section. Deliberately not narrowed to the viewing period: a linked
 * list stays explainable when its NOTAM has lapsed. Used by the airport detail panel, the NOTAM Location-code
 * links, and the airport-cue rings on the map.
 */
export function notamsByIdent(): Map<string, IndexedNotam[]> {
	// Local, non-reactive cache; the function is called inside derived/effect
	// contexts and the Map itself is returned, not stored as state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const m = new Map<string, IndexedNotam[]>();
	for (const item of filteredNotams()) {
		for (const code of item.notam.icaoCodes) {
			const k = code.toUpperCase();
			let arr = m.get(k);
			if (!arr) {
				arr = [];
				m.set(k, arr);
			}
			arr.push(item);
		}
	}
	return m;
}

/** Live ownership resolvers over the loaded datasets. airportLookup's index
 *  is a plain non-reactive ref, so the airports load flag is touched here
 *  (the MapView render effect documents the same compensation); firIdentSet()
 *  tracks the airspace load itself through getAirspaces(). */
function ownerResolvers(): OwnerResolvers {
	void dataState.airportsLoaded;
	const firs = firIdentSet();
	return {
		isAirport: (c) => airportLookup(c) !== null,
		isFir: (c) => firs.has(c),
	};
}

/** Which feature owns this NOTAM per the ICAO Item A) / scope rule (see
 *  notam/ownership.ts), resolved against the loaded airport + FIR datasets. */
export function notamOwner(notam: Notam): NotamOwner {
	return classifyOwner(notam, ownerResolvers());
}

/** The data-filtered NOTAMs filed under each FIR ident (Item A)
 *  ownership): the briefing a FIR detail panel lists, with the QKKKK
 *  checklists split out. Downstream of filteredNotams(), so every data
 *  filter (query / kind / flight rules / fetch region / route corridor /
 *  level band) composes, and the viewing period does not. */
export function firNotamIndex(): {
	briefing: Map<string, IndexedNotam[]>;
	checklists: Map<string, IndexedNotam[]>;
} {
	return firOwnershipIndex(filteredNotams(), ownerResolvers());
}

/**
 * True when this is an aerodrome-owned NOTAM whose A) location code resolves
 * to a known airport (notamOwner: scope rule + the data-driven fallback for
 * Q-line-less NOTAMs). En-route NOTAMs (scope E/W) that merely carry an FIR
 * code in A) are excluded; the airport-match test keeps the result scoped to
 * airports the map actually shows, so a suppressed marker is always reachable
 * via that airport's cue ring + detail panel. Returns false until the airport
 * dataset has loaded (airportLookup reads its index).
 */
export function isAirportNotam(notam: Notam): boolean {
	const owner = notamOwner(notam);
	return owner.kind === 'aerodrome' && airportLookup(owner.ident) !== null;
}
