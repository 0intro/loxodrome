/* One aerodrome's NOTAMs, fetched from its airport panel into the loaded
 * briefing (docs/notam-sources.md, "One aerodrome, from its panel").
 *
 * The route briefing under-covers aerodromes: SOFIA briefs an intermediate
 * route aerodrome about six times more thinly than an endpoint
 * (docs/notam-audit-2026-09.md section 5), and a diversion field off the
 * corridor is in no briefing at all. This asks the source the SOFIA /
 * autorouter picker names for the NOTAMs FILED UNDER one aerodrome and puts
 * them into the briefing in place of what the answer speaks for
 * (notam/splice.ts holds the rules, state/notam.svelte.ts amendBriefing the
 * state). Both apps run it from the shared panel.
 *
 * One NOTAM fetch at a time (notamFetchBusy), and the briefing it was asked
 * for must still be the one loaded when the answer lands: neither a paste
 * nor a Clear waits for a fetch, and an answer put into the briefing that
 * replaced its own, or into none after a Clear, would be one nobody asked
 * for. A failed or stopped fetch changes nothing. */

import { fetchAerodromeFromAutorouter } from '$lib/autorouter/fetch';
import { autorouter } from '$lib/autorouter/state.svelte';
import { errorTextOf } from '$lib/i18n/errorText';
import type { Notam } from '$lib/notam/types';
import { SofiaRouteError } from '$lib/sofia/failure';
import { fetchAerodromeFromSofia, openSofiaSession, SOFIA_PACE_MS } from '$lib/sofia/fetch';
import { aerodromeRefresh } from './aerodromeRefresh.svelte';
import { ensureAirports, ensureAirspaces } from './data.svelte';
import { customWindow } from './filter.svelte';
import { t } from './i18n.svelte';
import { activeEvalWindow, amendBriefing, briefingGeneration } from './notam.svelte';
import { activeIn, validIn } from './notamActive';
import { notamFetchBusy, notamSource, type NotamSource } from './notamSource.svelte';
import { planScope } from './planScope.svelte';

/** An ICAO location indicator: autorouter refuses a whole request over any
 *  other shape (autorouter/viewport.ts), and SOFIA has nothing to brief for
 *  a local code. */
const ICAO = /^[A-Z]{4}$/;

/** How far inside each end of the briefed window a NOTAM must be judged
 *  active before its absence counts. The app reads a D) schedule with its own
 *  grammar and its sun times at its own position; at the window's edges the
 *  source may have read it otherwise, and a NOTAM is better kept unconfirmed
 *  than withdrawn on a disagreement. */
const EDGE_GUARD_MS = 60 * 60_000;

/** Whether the panel can offer a fetch for this ident at all. */
export function aerodromeFetchable(ident: string): boolean {
	return ICAO.test(ident.trim().toUpperCase());
}

/** Would `source`, asked for the window it briefed, have carried this loaded
 *  NOTAM had it still been in force? (notam/splice.ts SpliceRules.covers)
 *
 *  autorouter returns what overlaps its window, whatever the schedule. SOFIA
 *  returns what is ACTIVE during its ~24 h: measured over the corpus, every
 *  NOTAM filed under an endpoint aerodrome that the app reads as active came
 *  back (763 of 763, 29 of 29 unreadable schedules too), and the 11 left out
 *  were all in force by B)/C) and off by D) for the whole window. That held
 *  for scopes A, AE and AW; a pure E or W scope filed under an aerodrome
 *  (a SIV sector closed, pinned far off) may be selected by area, so its
 *  coverage is left unknown. */
export function coverageOf(
	source: NotamSource,
	briefed: { from: number; to: number },
): (n: Notam) => boolean | null {
	const whole = { fromMs: briefed.from, toMs: briefed.to };
	const inner = { fromMs: briefed.from + EDGE_GUARD_MS, toMs: briefed.to - EDGE_GUARD_MS };
	if (source === 'autorouter') {
		return (n) => (!validIn(n, whole) ? false : validIn(n, inner) ? true : null);
	}
	return (n) => {
		if (activeIn(n, whole) === false) {
			return false;
		}
		if (!(n.qualifier?.scope ?? '').toUpperCase().includes('A')) {
			return null;
		}
		return activeIn(n, inner) === true ? true : null;
	};
}

/** The fetch in flight's stop. Module-level: one fetch runs at a time. */
let running: AbortController | null = null;

/** Stop the fetch in flight; the briefing stays as it was. */
export function stopAerodromeRefresh(): void {
	running?.abort();
}

/** Fetch the NOTAMs filed under `ident` from the picker's source and put them
 *  into the loaded briefing. */
export async function refreshAerodromeNotams(ident: string): Promise<void> {
	const id = ident.trim().toUpperCase();
	if (!ICAO.test(id) || notamFetchBusy()) {
		return;
	}
	aerodromeRefresh.error = null;
	aerodromeRefresh.errorDetail = null;
	aerodromeRefresh.errorIdent = id;
	if (!autorouter.proxyUrl) {
		aerodromeRefresh.error = () => t.errors.proxyNotConfigured;
		return;
	}
	const source = notamSource.source;
	// The period is read once: SOFIA briefs from its start (moved forward to
	// the present when it is behind), and a period wholly past has no future
	// half for a briefing to land in. It is the one the route fetch asks
	// for, the planned flight's, a typed custom period going first. An app
	// with no flight to plan reads the viewing period.
	const win = customWindow() ?? planScope.flight?.briefingWindow() ?? activeEvalWindow();
	if (source === 'sofia' && win.to <= Date.now()) {
		aerodromeRefresh.error = () => t.errors.sofiaPeriodPast;
		return;
	}
	const generation = briefingGeneration();
	const stop = new AbortController();
	running = stop;
	aerodromeRefresh.fetching = id;
	try {
		// Airports to place anchors in the answer, airspaces for its links.
		await Promise.all([ensureAirports(), ensureAirspaces()]);
		await fetchInto(id, source, win, generation, stop.signal);
	} catch (e) {
		// Asked first: a Stop during SOFIA's retry pause still reaches here as
		// the first attempt's failure, which is not what happened.
		if (stop.signal.aborted) {
			return;
		}
		if (e instanceof SofiaRouteError) {
			const { code, detail } = e.failure;
			aerodromeRefresh.error = () => t.errors.sofiaCause[code];
			aerodromeRefresh.errorDetail = detail;
		} else {
			aerodromeRefresh.error = errorTextOf(e);
		}
	} finally {
		if (running === stop) {
			running = null;
		}
		aerodromeRefresh.fetching = null;
	}
}

/** One aerodrome's answer, put into the loaded briefing unless the fetch
 *  was stopped or the briefing replaced meanwhile. Throws what the source
 *  threw. */
async function fetchInto(
	id: string,
	source: NotamSource,
	win: { from: number; to: number },
	generation: number,
	signal: AbortSignal,
	session?: string | null,
): Promise<void> {
	const result =
		source === 'sofia'
			? await fetchAerodromeFromSofia(id, win.from, signal, session, win.to)
			: await fetchAerodromeFromAutorouter(id, signal);
	if (signal.aborted || briefingGeneration() !== generation) {
		return;
	}
	amendBriefing(id, result.answer, { source, at: Date.now(), briefed: result.briefed }, coverageOf(source, result.briefed));
}

/** Fetch several aerodromes by name into the loaded briefing, one after
 *  the other: the automatic briefing's second step (state/briefingFetch.ts).
 *  SOFIA's share one session and its pace. Each answer lands as it comes,
 *  and the panel of the one running says so. Returns the idents that got
 *  no answer. Errors stay out of the panels' status, which belongs to the
 *  pilot's own fetch: the briefing's verdict states what was missed. */
export async function refreshAerodromesByName(idents: readonly string[]): Promise<string[]> {
	const ids = [...new Set(idents.map((x) => x.trim().toUpperCase()))].filter((x) => ICAO.test(x));
	if (ids.length === 0) {
		return [];
	}
	const source = notamSource.source;
	// The run's own window: the planned flight's, whatever period is typed.
	const win = planScope.flight?.briefingWindow() ?? activeEvalWindow();
	if (notamFetchBusy() || !autorouter.proxyUrl || (source === 'sofia' && win.to <= Date.now())) {
		return ids;
	}
	const generation = briefingGeneration();
	const stop = new AbortController();
	running = stop;
	const missed: string[] = [];
	try {
		aerodromeRefresh.fetching = ids[0];
		await Promise.all([ensureAirports(), ensureAirspaces()]);
		const session = source === 'sofia' ? await openSofiaSession(stop.signal) : null;
		for (const [k, id] of ids.entries()) {
			// Paced from the first: the route fetch's last POST went just
			// before it.
			if (source === 'sofia') {
				await new Promise((resolve) => setTimeout(resolve, SOFIA_PACE_MS));
			}
			if (stop.signal.aborted || briefingGeneration() !== generation) {
				missed.push(...ids.slice(k));
				break;
			}
			aerodromeRefresh.fetching = id;
			try {
				await fetchInto(id, source, win, generation, stop.signal, session);
			} catch {
				missed.push(id);
			}
		}
	} catch {
		return ids;
	} finally {
		if (running === stop) {
			running = null;
		}
		aerodromeRefresh.fetching = null;
	}
	return missed;
}
