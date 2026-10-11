/* Parsed-NOTAM state and the parse action. */

import { parseNotams } from '$lib/notam/parser';
import { bareNotamId, spliceAerodromeNotams } from '$lib/notam/splice';
import { notamIntersectsBbox } from '$lib/notam/geometry';
import {
	classifyOwner,
	ownerPinOnField,
	firOwnershipIndex,
	type NotamOwner,
	type OwnerResolvers,
} from '$lib/notam/ownership';
import type { AutorouterFetchKind } from '$lib/autorouter/state.svelte';
import type { Notam } from '$lib/notam/types';
import type { SofiaFailureCode } from '$lib/sofia/failure';
import type { NotamSource } from './notamSource.svelte';
import { notamBandFt } from '$lib/vertical/limits';
import { airportByIdent, airportLookup, dataState, firIdentSet } from './data.svelte';
import { AIRPORT_KINDS, airportDrawnAt } from '$lib/map/airportVisibility';
import type { Airport } from '$lib/data/airports';
import { layers } from './layers.svelte';
import { fetchScopeNotamIds, type FetchScope } from './fetchScope.svelte';
import { filter, activeAltitudeBand, customWindow } from './filter.svelte';
import { memoised } from './memoSelector';
import { planScope } from './planScope.svelte';
import { ui, type DetailTarget } from './ui.svelte';

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
 *  time, and pasting one or fetching from the other source replaces it whole.
 *  One aerodrome's NOTAMs fetched since from its panel replace only that
 *  aerodrome's, and carry their own record (AerodromeFetch), so this one keeps
 *  describing the briefing they were put into. */
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

/** The NOTAMs filed under one aerodrome, fetched from its panel and put into
 *  the loaded briefing (amendBriefing; the rules are notam/splice.ts's). What
 *  the panel, the loaders' foot lines and the printed bulletin say about that
 *  aerodrome, since its NOTAMs no longer share the briefing's age. */
export interface AerodromeFetch {
	source: NotamSource;
	at: number;
	/** The period the source's selection covered. */
	briefed: { from: number; to: number };
	/** NOTAMs filed under the aerodrome in the answer. */
	count: number;
	/** Ids of the loaded NOTAMs the answer removed. */
	withdrawn: string[];
	/** Ids kept although the answer lacks them: another source's, a pasted
	 *  one, or any when the answer came back empty. */
	unconfirmed: string[];
	/** Ids kept because the answer does not speak for them. */
	kept: string[];
}

export const notamState = $state<{
	rawText: string;
	notams: Notam[];
	parsedAt: number;
	/** When the current briefing came from a per-route fetch that did not
	 *  cover every route: how many were asked for, and which are missing.
	 *  Cleared by every fresh parse, like fetchScope; the route fetch
	 *  re-stamps it right after committing its result. */
	gaps: { total: number; routes: BriefingGap[] } | null;
	/** When the current NOTAMs came from a fetch over a REGION, that region:
	 *  the viewport box, or the corridor a route / aerodrome briefing covered.
	 *  Null for paste / upload / SOFIA. computeFilteredNotams() uses it to hide
	 *  NOTAMs whose area of effect doesn't reach it, because such a fetch pulls
	 *  in whole FIRs, which carry NOTAMs spread far outside what was asked for
	 *  (state/fetchScope.svelte.ts). */
	fetchScope: FetchScope | null;
	/** Which fetch produced the current briefing, or null when it was pasted,
	 *  opened from a file, or never loaded. Cleared by every fresh parse, like
	 *  gaps and fetchScope; each fetch re-stamps it right after committing. */
	lastFetch: FetchProvenance | null;
	/** The aerodromes whose NOTAMs were fetched from their panel into this
	 *  briefing, by upper-case ident. Replaced whole on every write (its key
	 *  set is a memo input); cleared by every fresh parse like lastFetch, kept
	 *  by a re-parse. */
	aerodromeFetches: Record<string, AerodromeFetch>;
	/** Bumped every 60 s by the heartbeat below. Reactive consumers that need
	 *  to re-evaluate over wall-clock time (e.g. the "active now" activation
	 *  link filter in notamLinks.svelte.ts) read this to opt into a tick. */
	tick: number;
}>({
	rawText: '',
	notams: [],
	parsedAt: 0,
	gaps: null,
	fetchScope: null,
	lastFetch: null,
	aerodromeFetches: {},
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

/** The text the loaded briefing was parsed from. The paste box binds
 *  notamState.rawText itself, so the raw text can hold an edit nobody has
 *  displayed yet; a re-parse reads what IS loaded, never that. */
let briefingText = '';

const NO_ANCHORS: ReadonlySet<string> = new Set();

/** The aerodromes (upper case) the loaded briefing's "RDL .../... ARP"
 *  anchors named and the airport lookup could not place, on NOTAMs with no
 *  other position to take: what an airport merge has to know to decide
 *  whether it changes the briefing (airportsMerged). */
let unplacedAnchors = NO_ANCHORS;

/** Which briefing is loaded: bumped by every fresh parse and by a Clear,
 *  never by a re-parse or an aerodrome fetch. Neither a paste nor a Clear
 *  waits for a fetch in flight, so an aerodrome fetch reads this before and
 *  after and lets go of an answer whose briefing is gone. */
let generation = 0;

/** The loaded briefing's identity, for a fetch that must not land on another. */
export function briefingGeneration(): number {
	return generation;
}

/** Where each loaded NOTAM came from (originKey -> source): every fetch stamps
 *  its source over what it commits, an aerodrome fetch stamps its answer, and
 *  a paste or a file stamps nothing. Only a NOTAM from the source that
 *  answered can be withdrawn by its absence from the answer (notam/splice.ts:
 *  EAD has been measured short of the French AIS at aerodromes asked for by
 *  name). Module-level and plain: nothing renders it. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup for the splice, never rendered
let origins = new Map<string, NotamSource>();

/** A NOTAM's identity across texts that label it differently: its location
 *  and its number without the prefix a pasted bulletin writes, or the one the
 *  parser adds to tell two States' NOTAMs of one number apart. */
function originKey(n: Notam): string {
	return `${(n.icaoCodes[0] ?? '').toUpperCase()}|${bareNotamId(n.id)}`;
}

/** Parse `text` as the loaded briefing. `carry` keeps everything the text does
 *  not produce (provenance, scope, gaps, the aerodrome fetches) and the
 *  selection on its NOTAMs; without it the briefing is a new one. */
function parseText(text: string, carry: boolean): void {
	const previous = carry ? entryKeys(notamState.notams) : null;
	briefingText = text;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- filled by this one parse and read by the merge check, never rendered
	const unplaced = new Set<string>();
	notamState.notams = parseNotams(briefingText, {
		lookupAirport: airportLookup,
		onUnresolvedAnchor: (ident) => unplaced.add(ident.toUpperCase()),
	});
	unplacedAnchors = unplaced;
	notamState.parsedAt = Date.now();
	if (previous) {
		carrySelection(previous);
		return;
	}
	generation += 1;
	origins = new Map();
	notamState.fetchScope = null;
	notamState.gaps = null;
	notamState.lastFetch = null;
	notamState.aerodromeFetches = {};
	ui.detail = null;
	ui.detailBack = null;
	// An index held across a new briefing names an unrelated NOTAM, which
	// would come up with its circle drawn the first time it was opened.
	ui.qRadiusIndex = null;
}

/** Parse the current raw text into NOTAMs.
 *
 *  A fresh parse of pasted / uploaded text covers no region of its own, so
 *  the geographic display filter must not apply; clear fetchScope. A region
 *  fetch re-sets it right after calling this. Pass `reparse` to parse the
 *  LOADED briefing again (airportsMerged does, once an aerodrome its anchors
 *  named has arrived): the briefing is the same one, so it keeps every field
 *  the text itself doesn't produce, its fetch provenance included, and what
 *  the pilot has open stays open on the same NOTAM (carrySelection). */
export function parseInput(opts: { reparse?: boolean } = {}): void {
	parseText(opts.reparse ? briefingText : notamState.rawText, opts.reparse === true);
}

/** Put one aerodrome's freshly fetched NOTAMs (`answer`: the NOTAMs filed
 *  under `ident`, one ICAO text block each) into the loaded briefing, in place
 *  of what the answer speaks for (notam/splice.ts, which holds the rules).
 *
 *  The briefing stays the same one: its provenance, scope and gaps stand, and
 *  what the pilot has open stays open (the airport panel the fetch was asked
 *  from, a NOTAM back target). The paste box gets the new text only when it
 *  still holds the loaded one, so an edit not yet displayed is left alone.
 *  `covers` is the source's own selection over the window it briefed. */
export function amendBriefing(
	ident: string,
	answer: readonly string[],
	meta: Pick<AerodromeFetch, 'source' | 'at' | 'briefed'>,
	covers: (n: Notam) => boolean | null,
): AerodromeFetch {
	const id = ident.trim().toUpperCase();
	const loaded = briefingText;
	const splice = spliceAerodromeNotams(loaded, id, answer, {
		covers,
		sameSource: (n) => origins.get(originKey(n)) === meta.source,
		parse: { lookupAirport: airportLookup },
	});
	for (const key of splice.freshKeys) {
		origins.set(key, meta.source);
	}
	const record: AerodromeFetch = {
		...meta,
		count: splice.count,
		withdrawn: splice.withdrawn,
		unconfirmed: splice.unconfirmed,
		kept: splice.kept,
	};
	notamState.aerodromeFetches = { ...notamState.aerodromeFetches, [id]: record };
	if (notamState.rawText === loaded) {
		notamState.rawText = splice.text;
	}
	parseText(splice.text, true);
	return record;
}

/** An airport merge was just published (data.svelte.ts, at every merge: the
 *  first load, then each country the coverage gate brings in late). Re-parse
 *  the loaded briefing when the merge places an aerodrome its anchors named
 *  and the last parse could not: one lookup per unplaced ident, and a parse
 *  only when one resolves. Driven by the merge rather than by a map layer, so
 *  it holds in both apps whatever the map shows. */
export function airportsMerged(): void {
	for (const ident of unplacedAnchors) {
		if (airportLookup(ident)) {
			parseInput({ reparse: true });
			return;
		}
	}
}

/** Each entry's identity across a re-parse: its NOTAM and its rank among that
 *  NOTAM's entries. Its INDEX is not one: a NOTAM with no Q-line has no entry
 *  at all until its anchor resolves, and then every entry after it moves down
 *  by one. Nor is its display id, once an aerodrome fetch has amended the
 *  text: the parser labels a number two States share by which comes first, so
 *  withdrawing LFPO A0958/26 promotes Salzburg's LOWS-A0958/26 to A0958/26,
 *  and a back target keyed on the id would move onto Salzburg's NOTAM. Keyed
 *  on the location as well, it is dropped, as a vanished entry should be. */
function entryKeys(notams: readonly Notam[]): string[] {
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local tally, never rendered
	const seen = new Map<string, number>();
	return notams.map((n) => {
		const key = originKey(n);
		const rank = seen.get(key) ?? 0;
		seen.set(key, rank + 1);
		return `${key}#${rank}`;
	});
}

/** Carry what points into the previous parse over to the new one: the open
 *  panel, its back target and the Q-radius toggle, each to where its entry
 *  now sits. A panel whose entry is gone closes; a back target whose entry is
 *  gone is dropped. */
function carrySelection(previous: readonly string[]): void {
	const now = new Map(entryKeys(notamState.notams).map((key, index) => [key, index]));
	const moved = (index: number): number | null => {
		const key = previous[index];
		return key === undefined ? null : (now.get(key) ?? null);
	};
	// 'same' when the target needs no write, so an unchanged panel is left
	// alone rather than handed a copy of itself.
	const carried = (target: DetailTarget | null): DetailTarget | null | 'same' => {
		if (target?.kind !== 'notam') {
			return 'same';
		}
		const index = moved(target.index);
		return index === null ? null : index === target.index ? 'same' : { ...target, index };
	};
	const detail = carried(ui.detail);
	if (detail === null) {
		ui.detail = null;
		ui.detailBack = null;
		ui.detailReturn = null;
	} else {
		if (detail !== 'same') {
			ui.detail = detail;
		}
		const back = carried(ui.detailBack);
		if (back !== 'same') {
			ui.detailBack = back;
		}
	}
	if (ui.qRadiusIndex !== null) {
		ui.qRadiusIndex = moved(ui.qRadiusIndex);
	}
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
		fetchScope?: FetchScope | null;
		gaps?: { total: number; routes: BriefingGap[] } | null;
	},
): void {
	notamState.rawText = rawText;
	parseInput();
	notamState.fetchScope = provenance.fetchScope ?? null;
	notamState.gaps = provenance.gaps ?? null;
	notamState.lastFetch = {
		source: provenance.source,
		kind: provenance.kind,
		at: Date.now(),
		count: notamState.notams.length,
		briefed: provenance.briefed,
	};
	for (const n of notamState.notams) {
		origins.set(originKey(n), provenance.source);
	}
}

/** Reset the input and the parsed NOTAMs. */
export function clearNotams(): void {
	notamState.rawText = '';
	notamState.notams = [];
	notamState.parsedAt = Date.now();
	notamState.gaps = null;
	notamState.fetchScope = null;
	notamState.lastFetch = null;
	notamState.aerodromeFetches = {};
	generation += 1;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a lookup for the splice, never rendered
	origins = new Map();
	briefingText = '';
	unplacedAnchors = NO_ANCHORS;
	ui.detail = null;
	ui.detailBack = null;
	ui.qRadiusIndex = null;
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
const scopeBox = { ref: null as unknown, token: 0 };

/* One pass per change instead of one per caller. About ten always-live
 * selectors read this (the map layer, the ordered list, the link modules, the
 * cue rings), each of which used to run the whole scan itself, and every
 * keystroke in the search box paid for all of them. The window's `from` is
 * floored to the minute upstream, so a tick that changes nothing still keys
 * the same. */
const filteredMemo = memoised(
	// Every reactive input, unconditionally (the memoSelector contract).
	() => {
		const scope = notamState.fetchScope;
		const band = activeAltitudeBand();
		const corridor = planScope.corridor?.(notamState.notams, notamState.parsedAt) ?? null;
		// A corridor scope's own ids are memoised on the datasets as well as
		// on the scope, so the token has to come from the RESULT: an entry the
		// airspace rows rescue lands after the scope itself has stopped moving.
		const scopeIds = fetchScopeNotamIds(notamState.notams, notamState.parsedAt, scope);
		const box = scope?.kind === 'bbox' ? scope.bbox : null;
		return (
			`${identityToken(notamsBox, notamState.notams)}|` +
			`${identityToken(corridorBox, corridor)}|` +
			`${identityToken(scopeBox, scopeIds)}|` +
			`${box ? `${box.minLat},${box.minLon},${box.maxLat},${box.maxLon}` : '-'}|` +
			`${filter.kind.area ? 1 : 0}${filter.kind.position ? 1 : 0}` +
			`${filter.kind.qualifierLine ? 1 : 0}|` +
			`${band ? `${band.floor},${band.ceiling}` : '-'}|` +
			`${filter.trafficMode}|${filter.query.trim().toLowerCase()}|` +
			// The record is replaced whole on every write, but a key string
			// does not care: what decides the result is WHICH aerodromes.
			Object.keys(notamState.aerodromeFetches).sort().join(',')
		);
	},
	() => computeFilteredNotams(),
);

export function filteredNotams(): IndexedNotam[] {
	return filteredMemo();
}

/** The aerodromes fetched from their panel, as a plain set for one pass: the
 *  record is $state, and a proxied read per NOTAM would be thousands. */
function fetchedAerodromes(): ReadonlySet<string> {
	return new Set(Object.keys(notamState.aerodromeFetches));
}

/** Whether a NOTAM is filed under one of `idents` (Item A). */
function filedUnderAny(notam: Notam, idents: ReadonlySet<string>): boolean {
	if (idents.size === 0) {
		return false;
	}
	return notam.icaoCodes.some((code) => idents.has(code.toUpperCase()));
}

/** The briefing's own geographic scope: when the current set came from a
 *  fetch over a region, whether a NOTAM's area of effect reaches it. A
 *  viewport is a box and is tested per NOTAM; a corridor is a capsule and
 *  comes back as a set of ids (state/fetchScope.svelte.ts). Paste / upload /
 *  SOFIA leave fetchScope null, so every NOTAM passes. What it leaves out is
 *  the briefing's scope rather than a filter: nothing on screen lifts it.
 *
 *  An aerodrome fetched from its panel extends that scope by name: its NOTAMs
 *  are exactly what was asked for, which is the code's own rule for a scope
 *  (autorouter/fetch.ts: a scope gates only what a source returned BEYOND the
 *  question), so they pass wherever the aerodrome lies. */
function fetchScopeTest(): (notam: Notam) => boolean {
	const scope = notamState.fetchScope;
	const scopeIds = fetchScopeNotamIds(notamState.notams, notamState.parsedAt, scope);
	const named = fetchedAerodromes();
	return (notam) =>
		filedUnderAny(notam, named) ||
		((scope?.kind !== 'bbox' || notamIntersectsBbox(notam, scope.bbox)) &&
			(scopeIds === null || scopeIds.has(notam.id)));
}

/** How many parsed entries the fetched region itself leaves out
 *  (fetchScopeTest), which the NOTAMs tab tells apart from the ones a filter
 *  hides: Show all brings those back, and nothing brings these. */
export function outOfScopeCount(): number {
	const inScope = fetchScopeTest();
	let n = 0;
	for (const notam of notamState.notams) {
		if (!inScope(notam)) {
			n++;
		}
	}
	return n;
}

/** Whether a briefing is loaded at all: a NOTAM parsed, a fetch committed
 *  (even one that found nothing), or an aerodrome fetched from its panel. A
 *  panel saying "none" without one would be an all-clear the app cannot
 *  give. */
export function briefingLoaded(): boolean {
	return (
		notamState.notams.length > 0 ||
		notamState.lastFetch !== null ||
		Object.keys(notamState.aerodromeFetches).length > 0
	);
}

/** What the briefing HOLDS under an ident before any filter, for the airport
 *  panel to tell apart from what it shows: the distinct NOTAMs filed under it
 *  (checklists aside, as the panel lists them), and how many of those no
 *  entry of reaches the region the briefing was fetched for. */
export function filedUnderCounts(ident: string): { held: number; outOfScope: number } {
	const id = ident.toUpperCase();
	const inScope = fetchScopeTest();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local tally, never rendered
	const held = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local tally, never rendered
	const reached = new Set<string>();
	for (const notam of notamState.notams) {
		if (!notam.icaoCodes.some((code) => code.toUpperCase() === id)) {
			continue;
		}
		if (notamOwner(notam).kind === 'checklist') {
			continue;
		}
		held.add(notam.id);
		if (inScope(notam)) {
			reached.add(notam.id);
		}
	}
	return { held: held.size, outOfScope: held.size - reached.size };
}

function computeFilteredNotams(): IndexedNotam[] {
	const q = filter.query.trim().toLowerCase();
	const band = activeAltitudeBand();
	const inScope = fetchScopeTest();
	const corridorIds = planScope.corridor?.(notamState.notams, notamState.parsedAt) ?? null;
	const named = fetchedAerodromes();
	const out: IndexedNotam[] = [];
	notamState.notams.forEach((notam, index) => {
		if (!inScope(notam)) {
			return;
		}
		// Route-corridor filter ("Show only route NOTAMs"): keep only the
		// NOTAMs relevant to one of the routes' corridors. Keyed by source
		// id, so every entry of a multi-area NOTAM passes together; null when
		// the toggle is off or no route has a corridor. Independent of
		// fetchScope: both can apply, and the workspace's routes are not
		// necessarily the ones the briefing was fetched for. An aerodrome
		// whose NOTAMs the pilot fetched from its panel is relevant by that
		// very request (a diversion, an alternate off the corridor), so its
		// NOTAMs stay: the one exception to this filter, by decision, and the
		// printed bulletin names the aerodromes it lets through.
		if (corridorIds && !corridorIds.has(notam.id) && !filedUnderAny(notam, named)) {
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
	return partitionByWindow().inside;
}

/** The complement: the NOTAMs a data filter kept but the window puts outside
 *  the period. They are DEMOTED, not dropped, so the list can show them in
 *  their own section and a lapsed NOTAM stays readable and selectable; the map
 *  draws only the in-window set. */
export function outOfWindowNotams(): IndexedNotam[] {
	return partitionByWindow().outside;
}

// The window split, computed once per (briefing, window) rather than once per
// caller. About thirty always-live selectors read visibleNotams() and each
// used to re-scan the whole filtered set; the minute tick moved the window, so
// all of them re-ran together. Both halves come out of ONE pass, and both
// arrays keep their identity while the inputs hold, so downstream memos can
// key on the reference.
let windowSplit: {
	items: IndexedNotam[];
	from: number;
	to: number;
	inside: IndexedNotam[];
	outside: IndexedNotam[];
} | null = null;

function partitionByWindow(): { inside: IndexedNotam[]; outside: IndexedNotam[] } {
	// Both reactive inputs read unconditionally, ahead of the cache check
	// (the memoSelector contract), so a caller inside $derived / $effect
	// tracks the filters and the window exactly as before.
	const win = activeEvalWindow();
	const items = filteredNotams();
	if (windowSplit && windowSplit.items === items && windowSplit.from === win.from && windowSplit.to === win.to) {
		return windowSplit;
	}
	const inside: IndexedNotam[] = [];
	const outside: IndexedNotam[] = [];
	for (const it of items) {
		if (inWindow(it.notam, win)) {
			inside.push(it);
		} else {
			outside.push(it);
		}
	}
	// The minute tick moves `from` every minute, and most minutes nothing
	// crosses the window's edge: hand back the SAME two arrays then, so every
	// memo keyed on visibleNotams()'s identity downstream (the canonical
	// order, the hit-test index, the map layer's own compare, the list)
	// holds instead of recomputing the whole briefing once a minute
	// (docs/performance-2026-09.md). Built in the items' order both times,
	// so an element-wise identity compare is the membership test.
	if (
		windowSplit &&
		windowSplit.items === items &&
		sameEntries(windowSplit.inside, inside) &&
		sameEntries(windowSplit.outside, outside)
	) {
		windowSplit = { ...windowSplit, from: win.from, to: win.to };
		return windowSplit;
	}
	windowSplit = { items, from: win.from, to: win.to, inside, outside };
	return windowSplit;
}

function sameEntries(a: IndexedNotam[], b: IndexedNotam[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
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
	const flight = filter.window.mode === 'flight' ? (planScope.flight?.window() ?? null) : null;
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

/** The range a DRAWN operational state is judged over: an aerodrome marked
 *  shut on the map, an airspace drawn with its radio withdrawn.
 *
 *  Deliberately NOT activeEvalWindow(), which is a BRIEFING filter. Its
 *  look-ahead asks "is this true at some point before the horizon", and a
 *  mark on a symbol cannot say that: over the 2026-09-21 corpus, judging
 *  aerodrome closures that way marks 16 fields shut at a 24 h horizon and 36
 *  at 30 days, against 13 actually shut, because a nightly works closure
 *  (Zurich 2100-0400) or a weeknight one (Carcassonne) is "closed at some
 *  point" all day long. Reading the instant instead is the same reasoning
 *  scheduleRadios.svelte.ts states for a sector's published hours.
 *
 *  Three sources, in precedence order: a typed custom period (the pilot said
 *  which period they mean), the planned flight's own span, else the current
 *  minute as a zero-length range. Reads the heartbeat, so a field reopens on
 *  the map within the minute.
 *
 *  A flight DATED but not timed spans its whole day (plannedFlightAt(), the
 *  performance page's reading, and what the period popover tells the
 *  pilot), and so does one whose departure time no cruise speed can fly: the
 *  planned flight's window IS that day then, so the map and the
 *  planned-flight surfaces cannot read one flight two ways. A day is the "at
 *  some point" the look-ahead is, so a nightly closure marks the field for
 *  such a flight; stating a departure time narrows it to the flight. Read at
 *  the current minute's time of day on the flight's day instead, the map drew
 *  tomorrow's flight at whatever hour the pilot happened to look, and a
 *  closure from 1400 to 1600 that day read open at 0900 beside a performance
 *  page marking the field closed.
 *
 *  The activation hatch keeps activeEvalWindow() on purpose: an activation
 *  scheduled for later is exactly what a pilot wants hatched ahead of time,
 *  and those NOTAMs state their period in B)/C) rather than as a recurring
 *  D) schedule. */
export function drawnStateAt(): { fromMs: number; toMs: number } {
	const custom = customWindow();
	if (custom) {
		return { fromMs: custom.from, toMs: custom.to };
	}
	const flight = filter.window.mode === 'flight' ? (planScope.flight?.window() ?? null) : null;
	if (flight) {
		return { fromMs: flight.from, toMs: flight.to };
	}
	void notamState.tick;
	const now = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
	return { fromMs: now, toMs: now };
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
let identIndexCache: { items: IndexedNotam[]; out: Map<string, IndexedNotam[]> } | null = null;

export function notamsByIdent(): Map<string, IndexedNotam[]> {
	// The reactive read comes first, then the cache check: the index is a pure
	// function of the filtered set, and two MapView effects rebuilt it on every
	// filter change (each search keystroke) to hand the airport layer a cue set.
	const items = filteredNotams();
	if (identIndexCache && identIndexCache.items === items) {
		return identIndexCache.out;
	}
	// Local, non-reactive cache; the function is called inside derived/effect
	// contexts and the Map itself is returned, not stored as state.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const m = new Map<string, IndexedNotam[]>();
	for (const item of items) {
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
	identIndexCache = { items, out: m };
	return m;
}

/** Live ownership resolvers over the loaded datasets. airportLookup's index
 *  is a plain non-reactive ref, so the airports load flag AND the airports
 *  revision (a late overlay re-merging the rows, which changes isAirport's
 *  answers) are touched here (the MapView render effect documents the same
 *  compensation); firIdentSet() tracks the airspace load itself through
 *  getAirspaces(). */
function ownerResolvers(): OwnerResolvers {
	const loaded = dataState.airportsLoaded;
	const revision = dataState.revision.airports;
	const firs = firIdentSet();
	if (
		resolvers &&
		resolversFor.loaded === loaded &&
		resolversFor.revision === revision &&
		resolversFor.firs === firs
	) {
		return resolvers;
	}
	resolvers = {
		isAirport: (c) => airportLookup(c) !== null,
		isFir: (c) => firs.has(c),
	};
	resolversFor = { loaded, revision, firs };
	// The classification is a pure function of the NOTAM and these resolvers,
	// so a new resolver pair is what retires the per-NOTAM answers below.
	ownerCache = new WeakMap<Notam, NotamOwner>();
	return resolvers;
}

// The resolver pair, kept stable while its two inputs hold: it is the memo
// key for the owner cache and for firNotamIndex, and a fresh object each
// call would defeat both.
let resolvers: OwnerResolvers | null = null;
let resolversFor: { loaded: boolean; revision: number; firs: ReadonlySet<string> } = {
	loaded: false,
	revision: -1,
	firs: new Set(),
};
let ownerCache = new WeakMap<Notam, NotamOwner>();

/** The resolver pair as an opaque memo token: a downstream cache whose
 *  answers went through notamOwner (the canonical order, the owner
 *  sections) keys on it, read BEFORE its own cache check, so an airspace or
 *  airport dataset landing after the first sort retires the sort too. */
export function ownerResolverToken(): object {
	return ownerResolvers();
}

/** Which feature owns this NOTAM per the ICAO Item A) / scope rule (see
 *  notam/ownership.ts), resolved against the loaded airport + FIR datasets.
 *
 *  Memoised per NOTAM: classifyOwner allocates two arrays per call, and the
 *  canonical list order runs it three times over every NOTAM on every render
 *  (the sort's ownerOf, then the owner-section cut, then the tab's headings). */
export function notamOwner(notam: Notam): NotamOwner {
	const r = ownerResolvers();
	const hit = ownerCache.get(notam);
	if (hit) {
		return hit;
	}
	const owner = classifyOwner(notam, r);
	ownerCache.set(notam, owner);
	return owner;
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
	// Reactive reads first, then the cache check. A FIR panel row asks for
	// this per render and it walks the whole briefing; the resolver pair is
	// stable while the datasets are, so the tick alone never invalidates it.
	const items = filteredNotams();
	const r = ownerResolvers();
	if (firIndexCache && firIndexCache.items === items && firIndexCache.resolvers === r) {
		return firIndexCache.out;
	}
	const out = firOwnershipIndex(items, r);
	firIndexCache = { items, resolvers: r, out };
	return out;
}

let firIndexCache: {
	items: IndexedNotam[];
	resolvers: OwnerResolvers;
	out: { briefing: Map<string, IndexedNotam[]>; checklists: Map<string, IndexedNotam[]> };
} | null = null;

/**
 * The aerodrome that owns this NOTAM when the pin it would draw sits ON it
 * (ownerPinOnField, 3 NM of the reference point), else null.
 *
 * Half of the question "Hide airport NOTAM markers" actually means. Its whole
 * justification is that the airport symbol and its cue ring already stand
 * where the pin would go, and that holds only while the Q-line centre IS the
 * reference point. It usually is, but an en-route or warning-scope NOTAM
 * filed under an aerodrome carries the position of the navaid, zone or sector
 * it is about: A5453/26 closes the SIV BEAUVAIS 2 sector and pins 42.6 NM
 * east of Beauvais, where no symbol stands and nothing else on the map says
 * the sector is shut. Suppressing those left them with no map representation
 * at all.
 */
export function onFieldAirport(notam: Notam): Airport | null {
	const owner = notamOwner(notam);
	if (owner.kind !== 'aerodrome') {
		return null;
	}
	const a = airportByIdent(owner.ident);
	return a && ownerPinOnField(notam, owner, a) ? a : null;
}

/**
 * Does this NOTAM's pin collapse into its aerodrome's symbol at `zoom`? The
 * other half of the hide rule: the symbol must be DRAWN, its kind and its
 * publisher ticked in the Layers tab and the zoom past its kind's floor. Any
 * airport group on was the old test, and it hid the pin of a small field below
 * zoom 8, or of a heliport with the heliports unticked, beside no symbol at
 * all. Reads the Layers choices rather than the airport layer's own flags,
 * which the map sets only once ensureAirports() settles, so a reactive caller
 * tracks the toggles and answers what the next paint shows.
 */
export function pinHeldByAirport(notam: Notam, zoom: number): boolean {
	const a = onFieldAirport(notam);
	if (!a) {
		return false;
	}
	const kind = AIRPORT_KINDS[a.type];
	const shown =
		kind !== undefined &&
		layers.airportTypes[kind.group] &&
		(a.source == null || layers.publisher[a.source]);
	return airportDrawnAt(a, zoom, shown);
}
