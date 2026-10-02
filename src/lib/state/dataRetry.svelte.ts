/* ONE schedule for the dataset reads that failed (docs/data-retry.md).
 *
 * A /data/ read that failed is asked again by this module, whoever asked it
 * first. A failure that may pass (src/lib/data/fetchData.ts isTransient) is
 * asked 5 s after it, then 15 s, then a minute, doubling to five minutes; a
 * fact about the document (one that does not parse, a required file the
 * deployment lacks) only every five minutes, asking soon changing nothing.
 * Every read is asked at once when the browser reports the network back and
 * when a pilot asks (the banner's Retry now, a restore, a print, a file
 * opened, a briefing fetched). Never while the page is hidden (a return runs
 * what came due meanwhile) and never while the browser knows it is offline.
 *
 * Until its retry comes due, a failed read is not read again by anyone
 * else: every dataset's ensure consults retryRefusal first and answers the
 * failure without touching the network or its load flags. The alert effect
 * asks for four datasets on every GPS fix and the min-altitude one on every
 * drag frame; without the wait an outage in flight became four failing
 * requests a second, each flipping the band between acquiring and lost.
 * The backoff timer is the sole re-entry path, the rule the live-weather
 * caches already follow.
 *
 * The dataset code reports every attempt: retryWhenDue (retryParts for the
 * parts of a published dataset, each under its own key and at its own pace)
 * while something is still missing, retryCleared once nothing is. The
 * schedule itself holds a plain Map, which the ensures read, so the per-fix
 * and per-drag effects that call them never subscribe to it; a $state mirror
 * carries what the banner, the detail panel, the alert gaps and the prints
 * show. */

import { isTransient } from '$lib/data/fetchData';

/** What a pending retry is about, as the banner names it. */
export type RetryGroup =
	| 'airports'
	| 'airspaces'
	| 'obstacles'
	| 'navaids'
	| 'nature'
	| 'supaip'
	| 'charts'
	| 'facilities'
	| 'fuel'
	| 'vacgeo'
	| 'metarStations'
	| 'designators'
	| 'aircraft';

/** The order the banner lists the groups in. */
const GROUP_ORDER: readonly RetryGroup[] = [
	'airports',
	'airspaces',
	'obstacles',
	'navaids',
	'nature',
	'supaip',
	'charts',
	'facilities',
	'fuel',
	'vacgeo',
	'metarStations',
	'designators',
	'aircraft',
];

export interface RetryInfo {
	group: RetryGroup;
	/** The publishers whose part is missing, in source order; empty when the
	 *  group is missing as a whole or its parts have no names. */
	parts: readonly string[];
	/** The failure, which a refused ensure answers with. A failure that may
	 *  pass (fetchData's isTransient) is asked again soon; a fact about the
	 *  document (one that does not parse, a required file the deployment
	 *  lacks) only at the longest wait. */
	error: Error;
	/** Retried without being announced or counted: what is missing lies
	 *  outside every area the app is asked about (the gate could not read
	 *  the country's envelope, and its publisher's own territory is far
	 *  away). */
	quiet?: boolean | undefined;
	/** Judges again whether what is missing matters, on the areas as they
	 *  stand: `quiet` is the judgement of the last report, and the areas can
	 *  have moved since (an aerodrome added just before a print). */
	judge?: (() => boolean) | undefined;
}

interface Entry extends RetryInfo {
	run: () => unknown;
	/** Index into DELAYS of the wait after the next failed retry. */
	step: number;
	due: number;
	/** The running retry, settled once its outcome is booked. */
	attempt: Promise<void> | null;
	announced: boolean;
	/** Identity: a key cleared and registered again is a new entry. */
	id: number;
}

/** The waits between retries: after the failure, then after each retry that
 *  failed again. The last repeats, and is the only wait a fact gets. */
const DELAYS = [5_000, 15_000, 60_000, 120_000, 240_000, 300_000] as const;
const LONGEST = DELAYS[DELAYS.length - 1];
/** While the browser says offline, a round that comes due is skipped and
 *  looked at again this much later, a safety net for an 'online' event that
 *  never fires. */
const OFFLINE_RECHECK_MS = 60_000;

/** The wait after a failure at this step: the ladder for a failure that may
 *  pass, the longest for a fact, which asking soon cannot change. */
const delayFor = (e: RetryInfo, step: number): number =>
	isTransient(e.error) ? DELAYS[Math.min(step, DELAYS.length - 1)] : LONGEST;

/** One pending retry as the UI sees it. */
export interface RetryView {
	key: string;
	group: RetryGroup;
	parts: readonly string[];
	/** Its first retry came due without landing it (or could not run). */
	announced: boolean;
	quiet: boolean;
}

export const dataRetry = $state<{ pending: RetryView[]; dismissed: string[] }>({
	pending: [],
	dismissed: [],
});

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain on purpose: the ensures read it, and their effects must not subscribe
const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

function hidden(): boolean {
	return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function offline(): boolean {
	return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Whether two views say the same thing. */
function sameView(a: RetryView, b: RetryView): boolean {
	return (
		a.key === b.key &&
		a.group === b.group &&
		a.announced === b.announced &&
		a.quiet === b.quiet &&
		a.parts.length === b.parts.length &&
		a.parts.every((p, i) => p === b.parts[i])
	);
}

function mirror(): void {
	const next = [...entries].map(([key, e]) => ({
		key,
		group: e.group,
		parts: [...e.parts],
		announced: e.announced,
		quiet: e.quiet ?? false,
	}));
	// Written only when it says something new: every coverage pass reports
	// its gaps, empty ones included, and a fresh array each time woke every
	// reader (the banner, the alert gaps, the detail panel) on each pan and
	// position update.
	const cur = dataRetry.pending;
	if (next.length !== cur.length || next.some((v, i) => !sameView(v, cur[i]))) {
		dataRetry.pending = next;
	}
	// A dismissal is about the keys it hid: one no longer pending is
	// forgotten, so the same read failing again later is news.
	if (dataRetry.dismissed.some((k) => !entries.has(k))) {
		dataRetry.dismissed = dataRetry.dismissed.filter((k) => entries.has(k));
	}
}

function arm(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	const now = Date.now();
	let next = Infinity;
	for (const e of entries.values()) {
		// No wait is longer than the longest: a later due time is a clock
		// moved back since, which would otherwise hold the retry that long.
		if (e.due > now + LONGEST) {
			e.due = now + LONGEST;
		}
		if (!e.attempt && e.due < next) {
			next = e.due;
		}
	}
	if (next !== Infinity) {
		timer = setTimeout(fire, Math.max(0, next - now));
	}
}

function fire(): void {
	timer = null;
	round();
}

/** Run what came due: never while the page is hidden (it is not re-armed,
 *  a hidden page does not spin; the return runs what came due meanwhile),
 *  and never while the browser knows it is offline (the round tells the
 *  banner and looks again later). */
function round(): void {
	if (hidden()) {
		return;
	}
	const now = Date.now();
	const due = [...entries].filter(([, e]) => !e.attempt && e.due <= now).map(([key]) => key);
	if (offline()) {
		for (const key of due) {
			const e = entries.get(key);
			if (e) {
				e.announced = true;
				e.due = now + OFFLINE_RECHECK_MS;
			}
		}
		mirror();
		arm();
		return;
	}
	run(due);
}

/** Start the retries of these keys, synchronously; each settles on its own. */
function run(keys: readonly string[]): void {
	for (const key of keys) {
		const e = entries.get(key);
		if (!e || e.attempt) {
			continue;
		}
		const id = e.id;
		let attempt: Promise<unknown>;
		try {
			attempt = Promise.resolve(e.run());
		} catch (err) {
			attempt = Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}
		e.attempt = attempt.catch(() => {}).then(() => settle(key, id));
	}
	arm();
}

/** A retry is over. Still registered as the same entry, it failed again: it
 *  is announced and waits one step longer. Cleared, or registered anew while
 *  it ran, there is nothing left to do for it. */
function settle(key: string, id: number): void {
	const e = entries.get(key);
	if (e && e.id === id) {
		e.attempt = null;
		e.announced = true;
		e.due = Date.now() + delayFor(e, e.step);
		e.step++;
		mirror();
	}
	arm();
}

/** Register a read's retry, or refresh what an already pending one says
 *  (never its timing). */
function upsert(key: string, info: RetryInfo, retry: () => unknown): void {
	const e = entries.get(key);
	if (e) {
		e.group = info.group;
		e.parts = info.parts;
		e.error = info.error;
		e.quiet = info.quiet;
		e.judge = info.judge;
		e.run = retry;
	} else {
		entries.set(key, {
			...info,
			run: retry,
			step: 1,
			due: Date.now() + delayFor(info, 0),
			attempt: null,
			// A failure that may pass is news once its first retry did not
			// land it, so a blip that retry closes never shows; a fact will
			// not pass on its own, and waiting five minutes to say so would
			// only hide it.
			announced: !isTransient(info.error),
			id: ++seq,
		});
	}
}

/** A read is still missing something after an attempt: schedule its retry,
 *  or refresh what an already pending one says (never its timing). */
export function retryWhenDue(key: string, info: RetryInfo, retry: () => unknown): void {
	upsert(key, info, retry);
	mirror();
	arm();
}

/** One missing part of a dataset, as its store reports it. */
export interface RetryPart {
	part: string;
	error: Error;
	/** Is it known to matter: inside an area the app is asked about. */
	wanted: boolean;
	/** The same judgement made again, on the areas as they stand when a
	 *  gesture asks (RetryAsk.wantedOnly). */
	judge?: (() => boolean) | undefined;
}

/** What a published dataset still lacks after an attempt, each part under
 *  its own key (`<group>:<part>`) so each keeps its own pace: a country
 *  failing for the first time waits 5 s whatever another has come to wait,
 *  and is announced only once its own first retry failed. A part no longer
 *  missing is forgotten. `retry` reads the one part again. */
export function retryParts(group: RetryGroup, gaps: readonly RetryPart[], retry: (part: string) => unknown): void {
	const prefix = `${group}:`;
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a one-call lookup, not state
	const keep = new Set(gaps.map((g) => prefix + g.part));
	for (const key of [...entries.keys()]) {
		if (key.startsWith(prefix) && !keep.has(key)) {
			entries.delete(key);
		}
	}
	for (const g of gaps) {
		upsert(prefix + g.part, { group, parts: [g.part], error: g.error, quiet: !g.wanted, judge: g.judge }, () => retry(g.part));
	}
	mirror();
	arm();
}

/** A read has everything it wanted: forget its retry. */
export function retryCleared(key: string): void {
	if (!entries.delete(key)) {
		return;
	}
	mirror();
	arm();
}

/** A read failed: its retry is scheduled, soon for a failure that may pass
 *  and at the longest wait for a fact, which the next ensure would otherwise
 *  ask again at once, from an effect on every GPS fix. Call it before the
 *  failure's state writes: an effect those writes wake must already find the
 *  refusal, or it starts a second read. */
export function retryAfterFailure(
	key: string,
	group: RetryGroup,
	e: unknown,
	retry: () => unknown,
	parts: readonly string[] = [],
): void {
	retryWhenDue(key, { group, parts, error: e instanceof Error ? e : new Error(String(e)) }, retry);
}

/** Is a retry pending for this read? Plain, never tracked. */
export function retryPending(key: string): boolean {
	return entries.has(key);
}

/** The failure a refused ensure answers with while its retry is pending, or
 *  null when the read may go ahead. Plain, never tracked. */
export function retryRefusal(key: string): Error | null {
	return entries.get(key)?.error ?? null;
}

/** Is something of this group missing and being retried? Reactive; a quiet
 *  entry lies outside every area the app is asked about and does not count. */
export function retryingGroup(group: RetryGroup): boolean {
	return dataRetry.pending.some((p) => p.group === group && !p.quiet);
}

/** Which pending reads a gesture asks for: every one by default (the
 *  banner's button, a file opened), or a print's, which names the groups
 *  its paper reads and asks only the parts known to matter. A quiet part is
 *  far from every area the app is asked about, the plan's included, and a
 *  stalled read costs 30 s: held in front of the paper, it kept the nav
 *  log's print, which has no Cancel, waiting on a country the plan never
 *  meets. What is not asked keeps its own schedule. */
export interface RetryAsk {
	groups?: readonly RetryGroup[] | undefined;
	wantedOnly?: boolean | undefined;
}

/** A pilot's gesture: the pending reads it asks for (every one by default,
 *  RetryAsk), now and synchronously, starting their waits over and ignoring
 *  the browser's onLine, which can be wrong. Resolves once every read it
 *  started, and every one of them already running, has settled and booked
 *  its outcome, so `await retryDataNow()` sees what landed: the ensures of
 *  a published dataset answer at once, whatever of it is still being read. */
export function retryDataNow(ask: RetryAsk = {}): Promise<void> {
	// Whether a part matters is judged again here, on the areas as they
	// stand: the last report's judgement predates whatever moved since (an
	// aerodrome added just before a print, whose country that report found
	// far away), and a print asking only what matters must not skip it.
	let rejudged = false;
	if (ask.wantedOnly) {
		for (const e of entries.values()) {
			if (e.judge && (!ask.groups || ask.groups.includes(e.group))) {
				const quiet = !e.judge();
				rejudged ||= quiet !== (e.quiet ?? false);
				e.quiet = quiet;
			}
		}
	}
	if (rejudged) {
		mirror();
	}
	const keys = [...entries]
		.filter(([, e]) => (!ask.groups || ask.groups.includes(e.group)) && !(ask.wantedOnly && e.quiet))
		.map(([key]) => key);
	for (const key of keys) {
		const e = entries.get(key);
		if (e) {
			e.step = 0;
		}
	}
	run(keys);
	const attempts = keys.flatMap((key) => {
		const attempt = entries.get(key)?.attempt;
		return attempt ? [attempt] : [];
	});
	return Promise.all(attempts).then(() => {});
}

function onOnline(): void {
	if (entries.size === 0) {
		return;
	}
	if (hidden()) {
		// Not now, but the moment the page is back: nothing is read for a
		// page nobody looks at.
		const now = Date.now();
		for (const e of entries.values()) {
			e.step = 0;
			e.due = Math.min(e.due, now);
		}
		return;
	}
	void retryDataNow();
}

function onVisible(): void {
	if (entries.size > 0) {
		round();
	}
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
	window.addEventListener('online', onOnline);
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
	document.addEventListener('visibilitychange', onVisible);
}

/* ---- the banner ---- */

/** One line of the banner: a group, and the publishers of it that are
 *  missing (empty when the group has no named parts). */
export interface BannerEntry {
	group: RetryGroup;
	parts: readonly string[];
}

/** What the banner says is missing: the announced entries, grouped in the
 *  banner's order with their parts merged in the order they came; null when
 *  there is nothing to say or everything announced was dismissed. Reactive. */
export function bannerEntries(): BannerEntry[] | null {
	const shown = dataRetry.pending.filter((p) => p.announced && !p.quiet);
	if (shown.length === 0 || shown.every((p) => dataRetry.dismissed.includes(p.key))) {
		return null;
	}
	const out: BannerEntry[] = [];
	for (const group of GROUP_ORDER) {
		const views = shown.filter((p) => p.group === group);
		if (views.length === 0) {
			continue;
		}
		const parts: string[] = [];
		let whole = false;
		for (const v of views) {
			if (v.parts.length === 0) {
				whole = true;
			}
			for (const p of v.parts) {
				if (!parts.includes(p)) {
					parts.push(p);
				}
			}
		}
		out.push({ group, parts: whole ? [] : parts });
	}
	return out;
}

/** The banner's dismissal: it holds, per read, until a read not yet
 *  announced fails, and a read no longer pending is forgotten. */
export function dismissDataRetry(): void {
	const keys = dataRetry.pending.filter((p) => p.announced && !p.quiet).map((p) => p.key);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- transient dedup, the assignment carries the reactivity
	dataRetry.dismissed = [...new Set([...dataRetry.dismissed, ...keys])];
}

/** Forget every pending retry and its timer (specs, between cases). */
export function resetDataRetryForTest(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
	entries.clear();
	dataRetry.pending = [];
	dataRetry.dismissed = [];
}
