/* Top-level SOFIA fetch: one narrow-route briefing per drawn route and day
 * through the proxy's /sofia route, merged and handed to the parser. The
 * automated equivalent of pasting a SOFIA-Briefing bulletin: SOFIA already scopes the
 * result to the corridor, so it flows straight into the same seam as a paste.
 *
 * The session handshake + forbidden-header injection live in the worker
 * (loxodrome-proxy/worker.js, handleSofia); the request/response shaping is in
 * client.ts. This module is the user-visible action behind the SOFIA option
 * of the "NOTAMs for route" source picker. */

import { i18n, t } from '$lib/state/i18n.svelte';
import { errorTextOf } from '$lib/i18n/errorText';
import { resolveLangPref } from '$lib/i18n/locale';
import {
	buildNarrowRouteBody,
	narrowRouteTokens,
	parseSofiaResponse,
	sofiaDepartureMs,
	sofiaNotamKey,
	sofiaNotamToIcaoText,
	SOFIA_DURATION_MS,
	type NarrowRouteOptions,
	type NarrowRoutePoint,
	type SofiaNotam,
} from './client';
import {
	clearerFailure,
	fetchFailure,
	httpFailure,
	noAerodromeFailure,
	payloadFailure,
	retryBudget,
	SofiaRouteError,
	type SofiaFailure,
} from './failure';
import { fetchSofiaSession } from './session';
import { sofia } from './state.svelte';
import {
	autorouter,
	proxyBase,
	type AutorouterFetchKind,
} from '$lib/autorouter/state.svelte';
import { notamBlocks } from '$lib/notam/parser';
import { TAIL_TOLERANCE_MS } from '$lib/notam/briefingVerdict';
import { DEFAULT_CORRIDOR_RADIUS_NM } from '$lib/route/notamCorridor';
import { ensureAirports, ensureAirspaces } from '$lib/state/data.svelte';
import { type BriefingAsk, briefingGeneration, commitBriefing } from '$lib/state/notam.svelte';
import type { LatLon } from '$lib/notam/types';
import { notamFetchBusy, type FetchOutcome } from '$lib/state/notamSource.svelte';
import { display } from '$lib/state/display.svelte';

// Radius (NM) SOFIA scans around each aerodrome in the route, matching its own
// narrow-route default. The corridor half-width comes from the app's shared
// corridorRadiusNM.
const SOFIA_AD_RADIUS_NM = 10;

// Delay between successive per-route briefing POSTs. SOFIA rate-limits bursts,
// so back-to-back requests for many routes get spuriously rejected; pacing also
// keeps us gentle on a safety-of-life government service. (The session handshake
// is done once up front and reused, so each route is now a single POST.)
export const SOFIA_PACE_MS = 1500;

/** The most days a route is briefed over, one PIB a day: a longer window
 *  is briefed for its first days, which the briefing's period then says.
 *  SOFIA builds each PIB server-side (a cold one measured at 18.6 s), and
 *  what is published that far ahead thins out (docs/sofia-briefing.md). */
export const SOFIA_MAX_DAYS = 3;

/** How many PIBs, one per SOFIA_DURATION_MS from the departure, reach the
 *  window's end within the minute the verdict allows at a briefing's tail
 *  (a whole day runs a minute past 23 h 59), at most SOFIA_MAX_DAYS. An
 *  open window takes one: the NOTAM Viewer's unbounded look-ahead. */
export function sofiaDays(departureMs: number, toMs: number): number {
	if (!Number.isFinite(toMs)) {
		return 1;
	}
	const reach = toMs - TAIL_TOLERANCE_MS - departureMs;
	return Math.min(SOFIA_MAX_DAYS, Math.max(1, Math.ceil(reach / SOFIA_DURATION_MS)));
}

// When a route is rejected, wait this much longer before trying it again,
// spacing the second attempt well clear of whatever turned the first away
// while staying gentle on the service. How many further attempts a failure is
// worth is retryBudget's call (failure.ts), which carries the reasoning.
const SOFIA_RETRY_PAUSE_MS = 4000;

// Hung requests must settle (the awc.ts convention): a stalled proxy socket
// would otherwise pin sofia.fetching and silently swallow every retry click
// for minutes. The briefing POST gets far longer than the 15 s default
// because SOFIA generates a whole PIB server-side: a cold one has been
// measured at 18.6 s, against 1.4 s once its answer is warm.
//
// INVARIANT: each budget here OUTLASTS the worker's for the same route
// (loxodrome-proxy/worker.js, FETCH_TIMEOUT_MS), so the worker always gets to
// answer first and the pilot reads its framed diagnostic instead of a bare
// "Failed to fetch". The worker's worst case for one POST is session +
// sofia, since it does the handshake inline whenever ?session= is missing,
// which is exactly the degraded path where the diagnostic matters:
//   deployed today 15 + 30 = 45 s, retuned 10 + 35 = 45 s, both under 50.
// The handshake's own budget lives with it (session.ts); the TEMSI / WINTEM
// catalog keeps the same invariant (charts.ts).
const BRIEFING_TIMEOUT_MS = 50_000;

/** One route's briefing request, less the departure instant: that one is
 *  resolved per ATTEMPT (sofiaDepartureMs), so it cannot go stale in a loop
 *  that paces, retries and waits on cold PIBs for minutes. */
type RouteBriefOptions = Omit<NarrowRouteOptions, 'validFrom'>;

/** One route's landed briefing: its NOTAMs, and the departure the attempt
 *  that landed them actually asked for, which is what `briefed` is stamped
 *  from rather than restated. */
interface RouteBriefing {
	notams: SofiaNotam[];
	validFromMs: number;
}

/** Wait, unless the briefing is stopped first: the pacing and retry waits are
 *  seconds long, so Stop has to cut them short or it reads as ignored. An
 *  already-aborted signal never fires 'abort' again, so it is tested up front
 *  rather than only listened for: without that, every route left in the loop
 *  still paid its full pacing wait after a Stop. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
	});
}

/** The running briefing's stop handle, so `stopSofiaFetch` can reach it.
 *  Module-level rather than reactive: the button reads `sofia.fetching`, and
 *  only one briefing runs at a time (the re-entry guard below). */
let running: AbortController | null = null;

/** Stop the briefing in flight. Whatever has already landed is kept and the
 *  routes left over are recorded as gaps, so a stopped briefing is honestly
 *  short rather than silently partial. */
export function stopSofiaFetch(): void {
	running?.abort();
}

/** One thing to brief: a label for the gap list, and the ordered points SOFIA
 *  should read as a track. A drawn route is one; so is a bare pair of
 *  aerodromes, which is the same PIB with two tokens. */
export interface SofiaTrack {
	label: string;
	points: NarrowRoutePoint[];
	/** The drawn track, for the record of what was asked. A caller that
	 *  briefs bare aerodromes (the NOTAM Viewer) has none to give. */
	path?: LatLon[] | undefined;
}

/** What to ask SOFIA for, beyond the tracks themselves. */
export interface SofiaBriefOptions {
	/** Corridor half-width in NM. */
	widthNM: number;
	/** The period the caller is looking at. Read ONCE by the caller so every
	 *  track is briefed for the same window. */
	window: { from: number; to: number };
	/** What the briefing will be recorded as having been fetched FOR. */
	kind: AutorouterFetchKind;
	/** The time it aims at, recorded with the tracks when every track has a
	 *  path: the planned flight's window, or a typed period. */
	aim?: BriefingAsk['aim'] | undefined;
	/** Commit only an answer where every track landed and the whole holds
	 *  NOTAMs, leaving the loaded briefing as it is otherwise: the automatic
	 *  refresh of a briefing that still covers the plan, which a lost route
	 *  or an empty answer would make worse. */
	wholeOnly?: boolean | undefined;
	/** The briefing generation the caller fetches for: an answer landing
	 *  after another briefing was loaded (a paste, a file, a Clear) is
	 *  dropped, 'skipped'. The app's own runs pass it. */
	since?: number | undefined;
}

/** How far a coordinate token can sit from the point it rounds: the minute it
 *  is written to, up to 0.7 NM. The corridor SOFIA briefs is centred on the
 *  tokens, so it covers the drawn track this much less wide. */
const TOKEN_ROUNDING_NM = 0.7;

/** Fetch a SOFIA-Briefing narrow-route PIB per track and day (SOFIA works one
 *  track and about 24 h at a time), merged and de-duplicated, then parsed
 *  like a pasted briefing.
 *  Anonymous (no credentials), and without a display bbox gate: SOFIA already
 *  curates to the track, so everything it returns is shown.
 *
 *  Takes its tracks rather than reading a route workspace, because an app may
 *  have none: two typed aerodrome idents are a track with two points. The
 *  guards that are properties of the FETCH stay here, where one briefing at a
 *  time is enforced whichever source ran it; the guards that are properties of
 *  the INPUT ("you gave me nothing") belong to the caller, whose word for
 *  nothing differs. */
export async function briefFromSofia(
	tracks: readonly SofiaTrack[],
	opts: SofiaBriefOptions,
): Promise<FetchOutcome> {
	// Every source counts, not just this one: an autorouter fetch commits
	// through the same commitBriefing seam, so the two must not overlap.
	if (notamFetchBusy()) {
		return 'skipped';
	}
	sofia.error = null;
	sofia.errorDetail = null;

	if (!autorouter.proxyUrl) {
		sofia.error = () => t.errors.proxyNotConfigured;
		return 'skipped';
	}
	const drawn = tracks;
	const win = opts.window;
	// SOFIA briefs from the present on and refuses a departure earlier than
	// the current minute, so a period that has wholly elapsed could only be
	// answered with the coming 24 h, covering none of it. Settled here like
	// noAerodrome, rather than spent on a service that would rightly say no.
	if (win.to <= Date.now()) {
		sofia.error = () => t.errors.sofiaPeriodPast;
		return 'skipped';
	}

	sofia.fetching = true;
	let outcome: FetchOutcome = 'failed';
	const stop = new AbortController();
	running = stop;
	try {
		// Airports for the ident tokens, airspaces so the FIR links resolve.
		// Navaids are the nav log's need, so the route caller asks for them.
		await Promise.all([ensureAirports(), ensureAirspaces()]);

		// Everything about the request except WHEN it departs, which each
		// attempt resolves for itself from win.from: the window's own start is
		// a display instant, routinely already past (it opens an hour before
		// the ETD, and floors to the past minute in `now` mode), and SOFIA
		// refuses a past departure outright.
		const briefOpts: RouteBriefOptions = {
			widthNM: opts.widthNM,
			radiusADNM: SOFIA_AD_RADIUS_NM,
		};

		// One anonymous JSESSIONID, fetched once and reused across every route's
		// POST (via ?session=), so a multi-route briefing does one handshake
		// instead of one per route. Null (older worker without /sofia/session, or
		// a failed handshake) falls back to a per-route handshake in the worker.
		const session = await fetchSofiaSession(proxyBase(), stop.signal);

		// One request per route and day, resilient: a route SOFIA rejects (its
		// endpoints must be aerodromes, and it refuses some points) is skipped
		// with a note rather than failing the whole briefing. A NOTAM shared by
		// two corridors, or two days, collapses via its SOFIA key.
		const merged = new Map<string, SofiaNotam>();
		const failed: { label: string; failure: SofiaFailure }[] = [];
		const landed: boolean[] = drawn.map(() => false);
		// The interval EVERY route that landed was briefed over: the latest
		// departure any of them asked for, to the end of the earliest one's own
		// last day. The INTERSECTION, not the union, because `briefed` drives a
		// coverage caution and must never claim more than was fetched. Both are
		// set whenever the commit below runs, which needs one route to have
		// landed.
		let briefedFrom = 0;
		let briefedTo = Infinity;
		// One PIB a day: a window longer than SOFIA's ~24 h is briefed as a
		// chain of PIBs, each departing where the one before ends. Counted
		// once, so every route asks the same days.
		const days = sofiaDays(sofiaDepartureMs(win.from, Date.now()), win.to);
		const total = drawn.length * days;
		let tried = 0;
		sofia.progress = { done: 0, total };
		for (const [i, track] of drawn.entries()) {
			// Stopped: the routes left over are gaps like any other, so the
			// briefing states what it is short of instead of just being short.
			if (stop.signal.aborted) {
				failed.push({
					label: track.label,
					// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					failure: { code: 'cancelled', detail: 'Not fetched: briefing stopped.' },
				});
				continue;
			}
			// The days the route got are kept whatever the later ones do,
			// while the route counts as landed only with all of them.
			let first: number | null = null;
			let last = 0;
			try {
				// SOFIA reads the first and last route[] tokens as the PIB's
				// departure and destination aerodromes, so the walk is ordered to
				// start and end on one (retracing, which leaves the corridor
				// exactly as drawn). A route carrying no aerodrome at all has
				// nothing to anchor on and is reported without being asked for.
				const tokens = narrowRouteTokens(track.points);
				if (!tokens) {
					throw new SofiaRouteError(noAerodromeFailure());
				}
				for (let d = 0; d < days; d++) {
					if (tried > 0) {
						await pause(SOFIA_PACE_MS, stop.signal);
					}
					if (stop.signal.aborted) {
						// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
						throw new SofiaRouteError({ code: 'cancelled', detail: 'Not fetched: briefing stopped.' });
					}
					tried++;
					const brief = await fetchOneRouteRetrying(
						tokens,
						briefOpts,
						first === null ? win.from : first + d * SOFIA_DURATION_MS,
						session,
						stop.signal,
					);
					first ??= brief.validFromMs;
					last = brief.validFromMs;
					for (const n of brief.notams) {
						merged.set(sofiaNotamKey(n), n);
					}
					sofia.progress = { done: i * days + d + 1, total };
				}
				briefedFrom = Math.max(briefedFrom, first ?? 0);
				briefedTo = Math.min(briefedTo, last + SOFIA_DURATION_MS);
				landed[i] = true;
			} catch (e) {
				failed.push({
					label: track.label,
					failure:
						e instanceof SofiaRouteError
							? e.failure
							: { code: 'proxy', detail: e instanceof Error ? e.message : String(e) },
				});
			}
			// Settled either way: the count is what has been tried, not what
			// succeeded, so a briefing losing routes still advances.
			sofia.progress = { done: (i + 1) * days, total };
		}

		// Commit the result once a route landed, every day of it: a total
		// failure leaves the existing NOTAMs untouched (like the autorouter
		// fetch), however many days of a lost route came back, while a
		// genuine empty briefing (no errors, no NOTAMs) does clear to empty.
		// Asked for a whole answer, a lost route or an empty one is refused.
		const anyLanded = landed.some(Boolean);
		if (opts.since !== undefined && briefingGeneration() !== opts.since) {
			outcome = 'skipped';
		} else if (stop.signal.aborted && (!anyLanded || opts.wholeOnly)) {
			// The pilot's Stop, with nothing landed that may commit.
			outcome = 'stopped';
		} else if (opts.wholeOnly && (failed.length > 0 || merged.size === 0)) {
			outcome = 'refused';
		} else if (anyLanded) {
			// The E-item free text follows the SOFIA language preference (defaults
			// to the UI locale); the rest of each block is language-neutral ICAO.
			const lang = resolveLangPref(display.sofiaLang, i18n.locale);
			// No fetchScope: unlike the autorouter fetch (which over-pulls whole
			// FIRs), SOFIA returns a route-scoped bulletin, so show all of it,
			// as a pasted SOFIA briefing does.
			//
			// `briefed` is what was actually covered in TIME, taken from the
			// requests that were sent rather than restated: each carried its own
			// resolved departure and SOFIA covers its capped duration from
			// there. A viewing period reaching past either end is a coverage
			// gap, and the NOTAMs head says so.
			commitBriefing(
				[...merged.values()]
					.map((n) => sofiaNotamToIcaoText(n, lang))
					.filter((s) => s.length > 0)
					.join('\n\n'),
				{
					source: 'sofia',
					kind: opts.kind,
					briefed: { from: briefedFrom, to: briefedTo },
					asked: askedOf(drawn, landed, opts),
					gaps:
						failed.length === 0
							? null
							: {
									total: drawn.length,
									routes: failed.map((f) => ({
										label: f.label,
										cause: f.failure.code,
										detail: f.failure.detail,
									})),
								},
				},
			);
			outcome = 'committed';
		}

		// A briefing that landed is never an error, however many routes it
		// missed: the count and the causes ride notamState.gaps, so they stay
		// with the briefing instead of with this view.
		// A refusal and a Stop say why too: a lost route kept the briefing,
		// or an answer with no NOTAM in it.
		if (failed.length > 0 && (!anyLanded || outcome === 'refused' || outcome === 'stopped')) {
			const { code, detail } = failed[0].failure;
			sofia.error = () => t.errors.sofiaCause[code];
			sofia.errorDetail = detail;
		} else if (outcome === 'refused') {
			sofia.error = () => t.errors.briefingEmpty;
		}
	} catch (e) {
		sofia.error = errorTextOf(e);
	} finally {
		sofia.fetching = false;
		sofia.progress = null;
		running = null;
	}
	return outcome;
}

/** The aerodromes a track's PIB briefs whole: its first and last aerodrome,
 *  the departure and destination the request anchors on (narrowRouteTokens).
 *  An aerodrome between them comes back thinly. */
function briefedWhole(points: readonly NarrowRoutePoint[]): string[] {
	const ads = points.filter((p) => p.aerodrome).map((p) => p.token);
	if (ads.length === 0) {
		return [];
	}
	const first = ads[0];
	const last = ads[ads.length - 1];
	return first === last ? [first] : [first, last];
}

/** What a briefing over `tracks` asked for, when every track has its drawn
 *  path and the caller named an aim, else null. */
function askedOf(
	tracks: readonly SofiaTrack[],
	landed: readonly boolean[],
	opts: SofiaBriefOptions,
): BriefingAsk | null {
	if (!opts.aim || !tracks.every((tr) => tr.path)) {
		return null;
	}
	return {
		region: {
			kind: 'tracks',
			tracks: tracks.map((tr, i) => ({
				label: tr.label,
				path: tr.path ?? [],
				landed: landed[i],
				ends: briefedWhole(tr.points),
			})),
			halfWidthNM: Math.max(0, opts.widthNM - TOKEN_ROUNDING_NM),
		},
		aim: opts.aim,
	};
}

/** One anonymous SOFIA session for several requests in a row: the
 *  aerodromes an automatic briefing asks for by name share it, as a
 *  multi-route briefing's routes do. */
export function openSofiaSession(signal: AbortSignal): Promise<string | null> {
	return fetchSofiaSession(proxyBase(), signal);
}

/** The NOTAMs filed under one aerodrome, for its panel (state/aerodromeNotams.ts):
 *  the NOTAM Viewer's single-aerodrome PIB, the ident sent at both ends (SOFIA
 *  reads the first and last tokens as the departure and destination, and an
 *  endpoint is the aerodrome it briefs fully), reduced to the NOTAMs whose
 *  Item A) names it, since the answer replaces exactly the aerodrome's own
 *  NOTAMs in a briefing that keeps everything else. A record that rebuilds
 *  into no NOTAM header is left out (its text would read as the tail of
 *  whichever NOTAM it followed).
 *
 *  `briefed` is the window SOFIA was asked for, from the departure the landing
 *  attempt sent (sofiaDepartureMs), which is what its selection covers: the
 *  NOTAMs ACTIVE during it, a schedule off for the whole of it left out
 *  (docs/sofia-briefing.md).
 *
 *  Reports to its caller only, by throwing SofiaRouteError: sofia.error and
 *  sofia.fetching belong to the NOTAMs tab's own buttons. `session` is one
 *  openSofiaSession opened for several aerodromes in a row. Left out, the
 *  fetch opens its own. */
export async function fetchAerodromeFromSofia(
	ident: string,
	windowFromMs: number,
	signal: AbortSignal,
	session?: string | null,
	windowToMs = Number.POSITIVE_INFINITY,
): Promise<{ answer: string[]; briefed: { from: number; to: number } }> {
	const id = ident.toUpperCase();
	if (session === undefined) {
		session = await fetchSofiaSession(proxyBase(), signal);
	}
	const point: NarrowRoutePoint = { token: id, aerodrome: true };
	const tokens = narrowRouteTokens([point, point]);
	if (!tokens) {
		throw new SofiaRouteError(noAerodromeFailure());
	}
	// One PIB a day to the window's end, as the routes are briefed
	// (sofiaDays), each departing where the one before ends.
	const days = sofiaDays(sofiaDepartureMs(windowFromMs, Date.now()), windowToMs);
	const merged = new Map<string, SofiaNotam>();
	let first: number | null = null;
	let last = 0;
	for (let d = 0; d < days; d++) {
		if (d > 0) {
			await pause(SOFIA_PACE_MS, signal);
		}
		const brief = await fetchOneRouteRetrying(
			tokens,
			{ widthNM: DEFAULT_CORRIDOR_RADIUS_NM, radiusADNM: SOFIA_AD_RADIUS_NM },
			first === null ? windowFromMs : first + d * SOFIA_DURATION_MS,
			session,
			signal,
		);
		first ??= brief.validFromMs;
		last = brief.validFromMs;
		for (const n of brief.notams) {
			merged.set(sofiaNotamKey(n), n);
		}
	}
	const lang = resolveLangPref(display.sofiaLang, i18n.locale);
	const answer: string[] = [];
	for (const n of merged.values()) {
		if (!(n.itemA ?? '').toUpperCase().split(/\s+/).includes(id)) {
			continue;
		}
		const text = sofiaNotamToIcaoText(n, lang);
		if (notamBlocks(text).length === 1) {
			answer.push(text);
		}
	}
	return {
		answer,
		briefed: { from: first ?? windowFromMs, to: last + SOFIA_DURATION_MS },
	};
}

/** One route's SOFIA briefing, retried after a spaced backoff for as many
 *  further attempts as the failure is worth (retryBudget: a transient
 *  failure once, a proxy refusal, the pilot's Stop, a route with no
 *  aerodrome and an expired link not at all). Every attempt throws SofiaRouteError, and
 *  clearerFailure keeps whichever explains more for the skipped-route note. */
async function fetchOneRouteRetrying(
	tokens: string[],
	opts: RouteBriefOptions,
	windowFromMs: number,
	session: string | null,
	stop: AbortSignal,
): Promise<RouteBriefing> {
	let reported: SofiaFailure | null = null;
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			await pause(SOFIA_RETRY_PAUSE_MS, stop);
		}
		try {
			return await fetchOneRoute(tokens, opts, windowFromMs, session, stop);
		} catch (e) {
			if (!(e instanceof SofiaRouteError)) {
				throw e;
			}
			reported = reported ? clearerFailure(reported, e.failure) : e.failure;
			// The budget is read from the LATEST failure: what the route is up
			// against now decides whether trying again is worth anything.
			if (attempt >= retryBudget(e.failure.code)) {
				throw new SofiaRouteError(reported);
			}
		}
	}
}

async function fetchOneRoute(
	tokens: string[],
	opts: RouteBriefOptions,
	windowFromMs: number,
	session: string | null,
	stop: AbortSignal,
): Promise<RouteBriefing> {
	// Resolved HERE, per attempt: SOFIA refuses a departure earlier than the
	// current minute, and the pacing, the retry pauses and a cold PIB together
	// run a briefing for minutes, so a value frozen at the start would be
	// refused for every route behind the first minute boundary.
	const validFromMs = sofiaDepartureMs(windowFromMs, Date.now());
	const body = buildNarrowRouteBody(tokens, { ...opts, validFrom: new Date(validFromMs) });
	// Reuse the shared session when we have one; the worker does its own
	// handshake when the param is absent.
	const url = proxyBase() + '/sofia' + (session ? '?session=' + encodeURIComponent(session) : '');
	let res: Response;
	let text: string;
	try {
		res = await fetch(url, {
			method: 'POST',
			// A CORS-safelisted content type, so the browser sends no preflight.
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body,
			// Two ways to end: the pilot's Stop and the budget. They arrive as
			// one signal and fetchFailure tells them apart by the abort's name.
			signal: AbortSignal.any([stop, AbortSignal.timeout(BRIEFING_TIMEOUT_MS)]),
		});
		// Inside the try: the signal aborts the body stream too, so a budget
		// spent while reading rejects here and stays a classified timeout.
		text = await res.text();
	} catch (e) {
		throw new SofiaRouteError(fetchFailure(e, proxyBase()));
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		// A non-JSON body is the proxy speaking: its 429 refusals and 502
		// upstream errors are plain text. A SOFIA server error arrives as a JSON
		// envelope instead and is unpacked by parseSofiaResponse below.
		throw new SofiaRouteError(httpFailure(res, text));
	}
	try {
		return { notams: parseSofiaResponse(payload), validFromMs };
	} catch (e) {
		// SOFIA read the request and answered something other than a bulletin:
		// its own "Erreur serveur" text, or an envelope shape we don't know.
		throw new SofiaRouteError(payloadFailure(e));
	}
}
