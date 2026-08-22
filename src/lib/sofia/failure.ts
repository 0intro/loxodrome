/* Why one route's SOFIA briefing did not land.
 *
 * A route the briefing skips is reported to the pilot, so the reason has to
 * survive the throw. Each failure carries a CODE the UI translates and a
 * DETAIL that stays the untranslated wire line (docs/i18n.md rule 7), shown
 * as the tooltip beside it. Pure and rune-free so `tests/sofia.spec.ts` can
 * pin the classification; the transport itself lives in `fetch.ts`.
 *
 * The codes separate faults the pilot can act on differently: `busy` clears
 * by waiting, `notDeployed` needs the worker redeployed, `refused` means
 * SOFIA read the request and would refuse it again, and `timeout` /
 * `upstream` are the transient ones a second attempt usually recovers. */

import { humanErrorDetail, parseRetryAfterMs } from '$lib/autorouter/errorDetail';

export type SofiaFailureCode =
	/** The client's own budget expired before the answer arrived. */
	| 'timeout'
	/** The POST never produced a response at all (offline, DNS, CORS). */
	| 'unreachable'
	/** A proxy rate-limit tier refused the request (HTTP 429). */
	| 'busy'
	/** The proxy reached SOFIA and SOFIA failed it (the worker's 502). */
	| 'upstream'
	/** The deployed worker predates the /sofia route (HTTP 404). */
	| 'notDeployed'
	/** SOFIA answered with its own server error instead of a bulletin. */
	| 'refused'
	/** SOFIA answered an envelope this client cannot read. */
	| 'malformed'
	/** Any other proxy status. */
	| 'proxy'
	/** No waypoint on the route is an aerodrome, so neither end can carry the
	 *  ident SOFIA reads as the PIB's departure / destination. Decided here,
	 *  before anything is asked for. */
	| 'noAerodrome'
	/** The pilot stopped the briefing before this route was asked for. */
	| 'cancelled';

/** One route's failure: the translated cause plus the wire line behind it.
 *  `retryAfterS` rides a `busy` refusal whose response carried Retry-After. */
export interface SofiaFailure {
	code: SofiaFailureCode;
	detail: string;
	retryAfterS?: number;
}

/** A classified route failure. `Error.message` keeps the wire line so a
 *  console trace and `errorTextOf` both stay meaningful; the display text
 *  comes from `failure.code`. */
export class SofiaRouteError extends Error {
	readonly failure: SofiaFailure;

	constructor(failure: SofiaFailure) {
		super(failure.detail);
		this.failure = failure;
	}
}

/** The failure behind a rejected `fetch()`. `AbortSignal.timeout` rejects with
 *  a DOMException named TimeoutError, so a spent budget is told apart from a
 *  proxy that answered nothing. */
export function fetchFailure(e: unknown, proxy: string): SofiaFailure {
	const reason = e instanceof Error ? e.message : String(e);
	if (e instanceof Error && e.name === 'TimeoutError') {
		return {
			code: 'timeout',
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			detail: `SOFIA briefing timed out: ${reason}`,
		};
	}
	// The pilot's own Stop. The two aborts arrive through one combined signal
	// and are told apart by name, so a stopped route never reads as a fault.
	if (e instanceof Error && e.name === 'AbortError') {
		return {
			code: 'cancelled',
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			detail: 'SOFIA briefing stopped by the pilot.',
		};
	}
	return {
		code: 'unreachable',
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		detail: `Cannot reach proxy at ${proxy}: ${reason}`,
	};
}

/** The failure behind a proxy response the client cannot use. The worker's
 *  refusals and upstream errors are plain text, so `humanErrorDetail` unwraps
 *  the body the same way the autorouter path does. */
export function httpFailure(res: Response, body: string): SofiaFailure {
	const detail = humanErrorDetail(body);
	// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
	const line = `SOFIA fetch failed: HTTP ${res.status}${detail ? ': ' + detail : ''}`;
	if (res.status === 429) {
		const ms = parseRetryAfterMs(res);
		return ms == null
			? { code: 'busy', detail: line }
			: { code: 'busy', detail: line, retryAfterS: Math.max(1, Math.ceil(ms / 1000)) };
	}
	if (res.status === 404) {
		return { code: 'notDeployed', detail: line };
	}
	if (res.status === 502) {
		return { code: 'upstream', detail: line };
	}
	return { code: 'proxy', detail: line };
}

/** The failure of a route SOFIA could only refuse: no waypoint on it is an
 *  aerodrome, so `narrowRouteTokens` has no ident to anchor either end on.
 *  Determined client-side, so the detail is ours rather than a wire line (the
 *  `cancelled` convention), and asking would cost three doomed requests
 *  against a flood-prone service for an answer we already have. */
export function noAerodromeFailure(): SofiaFailure {
	return {
		code: 'noAerodrome',
		// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
		detail: 'Not fetched: SOFIA briefs a route between aerodromes, and this one has none.',
	};
}

/** The failure behind a payload the response parser rejected. SOFIA reports
 *  its own server errors as plain text under `status.message`, which
 *  `unwrapSofiaMessage` surfaces prefixed `SOFIA: `; anything else is an
 *  envelope shape this client does not know. */
export function payloadFailure(e: unknown): SofiaFailure {
	const detail = e instanceof Error ? e.message : String(e);
	return { code: detail.startsWith('SOFIA: ') ? 'refused' : 'malformed', detail };
}

/** The failure to report when a route was attempted more than once. An
 *  explained refusal beats a bare transport failure, so a retry that finally
 *  reached SOFIA replaces a first attempt that only timed out. */
export function clearerFailure(first: SofiaFailure, second: SofiaFailure): SofiaFailure {
	const vague = first.code === 'timeout' || first.code === 'unreachable';
	const explained = second.code === 'refused' || second.code === 'malformed';
	return vague && explained ? second : first;
}

/** How many further attempts a failure is worth, by what it costs and how
 *  likely a repeat is to land.
 *
 *  SOFIA refuses roughly one briefing in six with a spurious
 *  "Erreur serveur : Le format d'un des paramètres n'est pas bon" against a
 *  body it accepts on either side of it; measured 2 refusals in 12 paced
 *  requests on 2026-07-29, spread across routes, and BOTH recovered on the
 *  next attempt. Those come back in seconds, so a second retry is cheap and
 *  takes the odds of losing a route from about 1 briefing in 6 to 1 in 200.
 *
 *  A transport failure can cost the whole briefing budget per attempt, so it
 *  keeps the single well-spaced retry. A proxy refusal (`busy`) and the
 *  pilot's Stop (`cancelled`) are decisions, not accidents: retrying either
 *  would only add load to what just turned us away, and `noAerodrome` was
 *  settled here without asking, so there is nothing to ask again. */
export function retryBudget(code: SofiaFailureCode): number {
	switch (code) {
		case 'busy':
		case 'cancelled':
		case 'noAerodrome':
			return 0;
		case 'refused':
		case 'malformed':
			return 2;
		default:
			return 1;
	}
}
