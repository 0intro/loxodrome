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
import { fetchAerodromeFromSofia } from '$lib/sofia/fetch';
import { aerodromeRefresh } from './aerodromeRefresh.svelte';
import { ensureAirports, ensureAirspaces } from './data.svelte';
import { t } from './i18n.svelte';
import { activeEvalWindow, amendBriefing, briefingGeneration } from './notam.svelte';
import { activeIn, validIn } from './notamActive';
import { closeNotamMenu } from './notamMenu.svelte';
import { notamFetchBusy, notamSource, type NotamSource } from './notamSource.svelte';

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
	// half for a briefing to land in.
	const win = activeEvalWindow();
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
		const result =
			source === 'sofia'
				? await fetchAerodromeFromSofia(id, win.from, stop.signal)
				: await fetchAerodromeFromAutorouter(id, stop.signal);
		if (stop.signal.aborted || briefingGeneration() !== generation) {
			return;
		}
		// A map-click menu holds indices into the parsed set the splice is
		// about to renumber.
		closeNotamMenu();
		amendBriefing(
			id,
			result.answer,
			{ source, at: Date.now(), briefed: result.briefed },
			coverageOf(source, result.briefed),
		);
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
