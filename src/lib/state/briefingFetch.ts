/* The automatic NOTAM briefing for the planned flight: the picked source's
 * route fetch, then the aerodromes the briefing owes by name. BriefingHost
 * starts it when notam/briefingRefresh.ts says it is due, and
 * ensureBriefing awaits it for a print and for the Fly tap, past the
 * switch and the pacing. One run at a time: a second caller joins the
 * first. */

import { fetchNotamsForRoute } from '$lib/autorouter/fetch';
import { fetchCures, leftStanding } from '$lib/notam/briefingRefresh';
import { dayKey } from '$lib/notam/briefingVerdict';
import { refreshAerodromesByName } from './aerodromeNotams';
import {
	aerodromesOwed,
	briefingCovers,
	briefingRun,
	briefingVerdictNow,
	briefingWanted,
	planSignature,
	runFailures,
} from './briefing.svelte';
import { briefingGeneration, setAerodromesMissed } from './notam.svelte';
import { notamFetchBusy, notamSource, type FetchOutcome } from './notamSource.svelte';
import { fetchRouteNotamsFromSofia } from './routeNotamFetch';

/** The most aerodromes one run asks for by name. */
const BY_NAME_MAX = 8;

let current: Promise<FetchOutcome> | null = null;

export interface RunOptions {
	/** Fetch the routes even when the aerodromes owed by name are all a
	 *  fetch would cure: the pilot's own press. */
	routes?: boolean;
}

/** Run the briefing now, or join the run going on. */
export function runBriefing(opts: RunOptions = {}): Promise<FetchOutcome> {
	// A run whose last state write woke the caller has ended, though its
	// promise has yet to settle: a new one starts.
	if (current && briefingRun.running) {
		return current;
	}
	const p: Promise<FetchOutcome> = run(opts).finally(() => {
		if (current === p) {
			current = null;
		}
	});
	current = p;
	return p;
}

/** How often a gesture looks whether a fetch going on has landed. */
const LANDED_POLL_MS = 250;

/** The briefing a print or the Fly tap needs: once a run or a fetch going
 *  on has landed, a run when the gesture still wants one (briefingWanted).
 *  A run joined would have asked for the window before the gesture, the
 *  planned flight's rather than a recording's. */
export async function ensureBriefing(): Promise<FetchOutcome> {
	if (current) {
		await current;
	}
	while (notamFetchBusy()) {
		await new Promise((res) => setTimeout(res, LANDED_POLL_MS));
	}
	if (!briefingWanted(Date.now())) {
		return 'skipped';
	}
	return runBriefing();
}

async function run(opts: RunOptions): Promise<FetchOutcome> {
	briefingRun.running = true;
	briefingRun.lastMs = Date.now();
	try {
		// While the loaded briefing still covers the plan, an answer short of
		// it (a lost route, nothing at all) is refused and the briefing stands.
		const before = briefingVerdictNow();
		const covering = briefingCovers(before);
		// Aerodromes owed by name, and nothing else a fetch would cure: asked
		// by name, the route briefing kept.
		const curable = before.reasons.filter((r) => fetchCures([r], Date.now()));
		const byNameOnly = !opts.routes && covering && curable.length > 0 && curable.every((r) => r.code === 'aerodromes');
		const source = notamSource.source;
		// The plan and the day the run fetches for, read before it awaits: a
		// plan edited meanwhile is one to fetch again, never one already
		// asked. So is the briefing: one loaded meanwhile (a paste, a file)
		// stands.
		const sig = planSignature();
		const day = dayKey(Date.now());
		const since = briefingGeneration();
		if (!byNameOnly) {
			const outcome =
				source === 'sofia'
					? await fetchRouteNotamsFromSofia({ wholeOnly: covering, flight: true, since })
					: await fetchNotamsForRoute({ wholeOnly: covering, since });
			if (outcome === 'stopped') {
				// The pilot's Stop holds the runs, as a Clear does.
				briefingRun.left = { sig, day, source, codes: [], held: true };
				return outcome;
			}
			if (outcome !== 'committed') {
				// Skipped is no failure: another fetch was going on, or a
				// briefing loaded meanwhile stands.
				if (outcome === 'failed' || outcome === 'refused') {
					briefingRun.failures = runFailures() + 1;
					briefingRun.failedMs = Date.now();
				}
				return outcome;
			}
			briefingRun.failures = 0;
			briefingRun.failedMs = null;
		}
		// What the run leaves standing, judged at the commit: an RTBA release
		// passing or a Clear during the aerodromes asked by name changes none
		// of it.
		const generation = briefingGeneration();
		const left = leftStanding(briefingVerdictNow().reasons, Date.now());
		const owed = aerodromesOwed();
		const asked = owed.slice(0, BY_NAME_MAX);
		const missed = asked.length > 0 ? await refreshAerodromesByName(asked) : [];
		setAerodromesMissed([...missed, ...owed.slice(BY_NAME_MAX)], generation);
		// A briefing loaded or cleared meanwhile keeps its own record.
		if (briefingGeneration() === generation) {
			briefingRun.left = { sig, day, source, codes: left };
		}
		return 'committed';
	} finally {
		briefingRun.running = false;
	}
}

/** The pilot cleared the briefing: no run until the plan, the day or the
 *  source changes, as after a Stop. A print and the Fly tap still fetch. */
export function holdBriefingRuns(): void {
	briefingRun.left = { sig: planSignature(), day: dayKey(Date.now()), source: notamSource.source, codes: [], held: true };
}
