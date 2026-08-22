/* Top-level SOFIA fetch: one narrow-route briefing per drawn route through the
 * proxy's /sofia route, merged and handed to the parser. The automated
 * equivalent of pasting a SOFIA-Briefing bulletin; SOFIA already scopes the
 * result to the corridor, so it flows straight into the same seam as paste.
 *
 * The session handshake + forbidden-header injection live in the worker
 * (notam-proxy/worker.js, handleSofia); the request/response shaping is in
 * client.ts. This module is the user-visible action behind the SOFIA option
 * of the "NOTAMs for route" source picker. */

import { i18n, t } from '$lib/state/i18n.svelte';
import { errorTextOf } from '$lib/i18n/errorText';
import { resolveLangPref } from '$lib/i18n/locale';
import {
	buildNarrowRouteBody,
	latLonToSofiaToken,
	narrowRouteTokens,
	parseSofiaResponse,
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
import { sofia } from './state.svelte';
import { autorouter, proxyBase } from '$lib/autorouter/state.svelte';
import { ensureAirports, ensureAirspaces, ensureNavaids } from '$lib/state/data.svelte';
import { activeEvalWindow, commitBriefing } from '$lib/state/notam.svelte';
import { notamFetchBusy } from '$lib/state/notamSource.svelte';
import { display } from '$lib/state/display.svelte';
import { routes, routeSettings, type Route, type Waypoint } from '$lib/state/route.svelte';

// Radius (NM) SOFIA scans around each aerodrome in the route, matching its own
// narrow-route default. The corridor half-width comes from the app's shared
// corridorRadiusNM.
const SOFIA_AD_RADIUS_NM = 10;

// Delay between successive per-route briefing POSTs. SOFIA rate-limits bursts,
// so back-to-back requests for many routes get spuriously rejected; pacing also
// keeps us gentle on a safety-of-life government service. (The session handshake
// is done once up front and reused, so each route is now a single POST.)
const SOFIA_PACE_MS = 1500;

// When a route is rejected, wait this much longer before trying it again, so
// a multi-route briefing stops dropping routes to spurious 500s while staying
// gentle on the service. How many further attempts a failure is worth is
// retryBudget's call (failure.ts), which carries the measurement behind it.
const SOFIA_RETRY_PAUSE_MS = 4000;

// Hung requests must settle (the awc.ts convention): a stalled proxy socket
// would otherwise pin sofia.fetching and silently swallow every retry click
// for minutes. The briefing POST gets far longer than the 15 s default
// because SOFIA generates a whole PIB server-side: a cold one has been
// measured at 18.6 s, against 1.4 s once its answer is warm.
//
// INVARIANT: each budget here OUTLASTS the worker's for the same route
// (notam-proxy/worker.js, FETCH_TIMEOUT_MS), so the worker always gets to
// answer first and the pilot reads its framed diagnostic instead of a bare
// "Failed to fetch". The worker's worst case for one POST is session +
// sofia, since it does the handshake inline whenever ?session= is missing,
// which is exactly the degraded path where the diagnostic matters:
//   deployed today 15 + 30 = 45 s, retuned 10 + 35 = 45 s, both under 50.
const SESSION_TIMEOUT_MS = 12_000;
const BRIEFING_TIMEOUT_MS = 50_000;

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

/** Fetch NOTAMs for every drawn route from SOFIA-Briefing: one narrow-route
 *  PIB per route (SOFIA works one route at a time), merged and de-duplicated,
 *  then parsed like a pasted briefing. Mirrors the autorouter
 *  `fetchNotamsForRoute` shape but keyed off SOFIA, anonymous (no credentials),
 *  and without a display bbox gate (SOFIA already curates to the route). */
export async function fetchRouteNotamsFromSofia(): Promise<void> {
	// Every source counts, not just this one: an autorouter fetch commits
	// through the same commitBriefing seam, so the two must not overlap.
	if (notamFetchBusy()) {
		return;
	}
	sofia.error = null;
	sofia.errorDetail = null;

	if (!autorouter.proxyUrl) {
		sofia.error = () => t.errors.proxyNotConfigured;
		return;
	}
	const drawn = routes.list.filter((r) => r.waypoints.length >= 2);
	if (drawn.length === 0) {
		sofia.error = () => t.errors.needTwoWaypoints;
		return;
	}

	sofia.fetching = true;
	const stop = new AbortController();
	running = stop;
	try {
		// Airports for the ident tokens, airspaces so FIR links resolve, navaids
		// so nav-log frequencies resolve; matches the autorouter route fetch.
		await Promise.all([ensureAirports(), ensureAirspaces(), ensureNavaids()]);

		// Brief the period the pilot is looking at: the flight's own start in
		// Flight mode, the typed start in Custom, else now. SOFIA opens its
		// ~24 h window from there.
		const opts: NarrowRouteOptions = {
			widthNM: routeSettings.corridorRadiusNM,
			radiusADNM: SOFIA_AD_RADIUS_NM,
			validFrom: new Date(activeEvalWindow().from),
		};

		// One anonymous JSESSIONID, fetched once and reused across every route's
		// POST (via ?session=), so a multi-route briefing does one handshake
		// instead of one per route. Null (older worker without /sofia/session, or
		// a failed handshake) falls back to a per-route handshake in the worker.
		const session = await fetchSofiaSession(stop.signal);

		// One request per route, resilient: a route SOFIA rejects (its endpoints
		// must be aerodromes; some points it won't accept) is skipped with a note
		// rather than failing the whole briefing. A NOTAM shared by two corridors
		// collapses via its SOFIA key.
		const merged = new Map<string, SofiaNotam>();
		const failed: { label: string; failure: SofiaFailure }[] = [];
		sofia.progress = { done: 0, total: drawn.length };
		for (const [i, route] of drawn.entries()) {
			if (i > 0) {
				await pause(SOFIA_PACE_MS, stop.signal);
			}
			// Stopped: the routes left over are gaps like any other, so the
			// briefing states what it is short of instead of just being short.
			if (stop.signal.aborted) {
				failed.push({
					label: routeEndpointsLabel(route),
					// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
					failure: { code: 'cancelled', detail: 'Not fetched: briefing stopped.' },
				});
				continue;
			}
			try {
				// SOFIA reads the first and last route[] tokens as the PIB's
				// departure and destination aerodromes, so the walk is ordered to
				// start and end on one (retracing, which leaves the corridor
				// exactly as drawn). A route carrying no aerodrome at all has
				// nothing to anchor on and is reported without being asked for.
				const tokens = narrowRouteTokens(route.waypoints.map(waypointPoint));
				if (!tokens) {
					throw new SofiaRouteError(noAerodromeFailure());
				}
				for (const n of await fetchOneRouteRetrying(tokens, opts, session, stop.signal)) {
					merged.set(sofiaNotamKey(n), n);
				}
			} catch (e) {
				failed.push({
					label: routeEndpointsLabel(route),
					failure:
						e instanceof SofiaRouteError
							? e.failure
							: { code: 'proxy', detail: e instanceof Error ? e.message : String(e) },
				});
			}
			// Settled either way: the count is what has been tried, not what
			// succeeded, so a briefing losing routes still advances.
			sofia.progress = { done: i + 1, total: drawn.length };
		}

		// Commit the result unless every route errored: a total failure leaves
		// the existing NOTAMs untouched (like the autorouter fetch), while a
		// genuine empty briefing (no errors, no NOTAMs) does clear to empty.
		if (merged.size > 0 || failed.length === 0) {
			// The E-item free text follows the SOFIA language preference (defaults
			// to the UI locale); the rest of each block is language-neutral ICAO.
			const lang = resolveLangPref(display.sofiaLang, i18n.locale);
			// No fetchBbox: unlike the autorouter fetch (which over-pulls whole
			// FIRs), SOFIA returns a route-scoped bulletin, so show all of it,
			// as a pasted SOFIA briefing does.
			//
			// `briefed` is what was actually covered in TIME, taken from the
			// request that was sent rather than restated: opts.validFrom is the
			// window the pilot is looking at, and SOFIA covers its capped
			// duration from there. A wider viewing period is a coverage gap,
			// and the fetch view says so.
			commitBriefing(
				[...merged.values()]
					.map((n) => sofiaNotamToIcaoText(n, lang))
					.filter((s) => s.length > 0)
					.join('\n\n'),
				{
					source: 'sofia',
					kind: 'route',
					briefed: {
						from: opts.validFrom.getTime(),
						to: opts.validFrom.getTime() + SOFIA_DURATION_MS,
					},
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
		}

		// A briefing that landed is never an error, however many routes it
		// missed: the count and the causes ride notamState.gaps, so they stay
		// with the briefing instead of with this view.
		if (failed.length > 0 && merged.size === 0) {
			const { code, detail } = failed[0].failure;
			sofia.error = () => t.errors.sofiaCause[code];
			sofia.errorDetail = detail;
		}
	} catch (e) {
		sofia.error = errorTextOf(e);
	} finally {
		sofia.fetching = false;
		sofia.progress = null;
		running = null;
	}
}

/** A route waypoint as a SOFIA `route[]` token. Only aerodromes go in by ICAO
 *  ident (the ident anchors SOFIA's aerodrome NOTAM scan, and is the only thing
 *  it accepts at either end of a route); navaids and free points go in by
 *  coordinate. SOFIA rejects some navaid idents outright (e.g. PMN -> a generic
 *  "Votre requête n'a pas abouti"), but reliably accepts a coordinate token for
 *  any intermediate point, and every waypoint carries resolved coordinates.
 *  buildNarrowRouteBody upper-cases the ident (SOFIA is case-sensitive).
 *
 *  Which points are aerodromes rides along, since that is what decides where
 *  `narrowRouteTokens` can anchor the ends. */
function waypointPoint(w: Waypoint): NarrowRoutePoint {
	const ident = w.ident?.trim();
	return w.kind === 'airport' && ident
		? { token: ident, aerodrome: true }
		: { token: latLonToSofiaToken(w.lat, w.lon), aerodrome: false };
}

/** "LFPL-LFPU" from a route's endpoints, for the skipped-route note; a free or
 *  unnamed endpoint falls back to its name, else "?". */
function routeEndpointsLabel(route: Route): string {
	const wps = route.waypoints;
	const a = endpointLabel(wps[0]);
	const b = endpointLabel(wps[wps.length - 1]);
	return a === b ? a : `${a}-${b}`;
}

function endpointLabel(w: Waypoint | undefined): string {
	return w?.ident?.trim() || w?.label?.trim() || '?';
}

/** Fetch one anonymous JSESSIONID from the proxy's /sofia/session route so the
 *  per-route POSTs can reuse it (?session=), halving the SOFIA hits of a
 *  multi-route briefing. Best-effort: null falls back to a per-route handshake
 *  in the worker, so an older worker without /sofia/session (404) still works. */
async function fetchSofiaSession(stop: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyBase() + '/sofia/session', {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.any([stop, AbortSignal.timeout(SESSION_TIMEOUT_MS)]),
		});
		if (!res.ok) {
			return null;
		}
		const data = (await res.json()) as { session?: string };
		return data.session ?? null;
	} catch {
		return null;
	}
}

/** One route's SOFIA briefing, retried after a spaced backoff for as many
 *  further attempts as the failure is worth (retryBudget: SOFIA's own
 *  transient refusals twice, a transport failure once, a proxy refusal or the
 *  pilot's Stop not at all). Every attempt throws SofiaRouteError, and
 *  clearerFailure keeps whichever explains more for the skipped-route note. */
async function fetchOneRouteRetrying(
	tokens: string[],
	opts: NarrowRouteOptions,
	session: string | null,
	stop: AbortSignal,
): Promise<SofiaNotam[]> {
	let reported: SofiaFailure | null = null;
	for (let attempt = 0; ; attempt++) {
		if (attempt > 0) {
			await pause(SOFIA_RETRY_PAUSE_MS, stop);
		}
		try {
			return await fetchOneRoute(tokens, opts, session, stop);
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
	opts: NarrowRouteOptions,
	session: string | null,
	stop: AbortSignal,
): Promise<SofiaNotam[]> {
	const body = buildNarrowRouteBody(tokens, opts);
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
		return parseSofiaResponse(payload);
	} catch (e) {
		// SOFIA read the request and answered something other than a bulletin:
		// its own "Erreur serveur" text, or an envelope shape we don't know.
		throw new SofiaRouteError(payloadFailure(e));
	}
}
