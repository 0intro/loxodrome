/* When the app fetches the briefing for the planned flight on its own
 * (components/BriefingHost.svelte asks, state/briefingFetch.ts runs).
 * Pure: every input comes as an argument, so the gates and the pacing are
 * plain function tests.
 *
 * A run is due when the switch is on, the plan restored, the source able to
 * brief it, the page visible and online, nothing fetching or printing, the
 * aircraft on the ground, and the briefing loaded one the app may replace:
 * none, or a route fetch aimed at the flight. A bulletin by hand, a map
 * view's fetch and a typed period's stay until the pilot replaces them. It
 * then waits for the plan to hold still, and for the spacing after the
 * last run, or the backoff in its place after a failure, and runs when a
 * fetch would cure a
 * reason of the verdict, or would refresh an old briefing the pilot is
 * using. */

import type { BriefingReason } from './briefingVerdict';

const MINUTE_MS = 60_000;

/** How long the plan must hold before a run: a burst of edits costs one. */
export const STILL_MS = 15_000;
/** The least time from one automatic run to the next, after a run that
 *  did not fail. */
export const SPACING_MS = 2 * MINUTE_MS;
/** The waits after one, two, three and four failed runs in a row, which
 *  pace the next run in the spacing's place. */
export const BACKOFF_MS: readonly number[] = [1, 2, 4, 8].map((m) => m * MINUTE_MS);
/** The wait after more failures than that. */
export const BACKOFF_CAP_MS = 15 * MINUTE_MS;
/** A briefing older than this is refreshed while the pilot uses the app. */
export const IDLE_AGE_MS = 30 * MINUTE_MS;
/** How recent a press or a keystroke counts as the pilot using the app. */
export const ACTIVE_MS = MINUTE_MS;

export interface RefreshInput {
	nowMs: number;
	/** The Settings switch. */
	enabled: boolean;
	/** The boot's restore of the plan has settled. */
	restored: boolean;
	/** The picked source can brief a route of the plan. */
	sourceReady: boolean;
	visible: boolean;
	online: boolean;
	/** A NOTAM fetch, a run or a print is going on. */
	busy: boolean;
	onGround: boolean;
	/** The loaded briefing may be replaced. */
	replaceable: boolean;
	/** The plan's signature, and since when it has held. */
	planSig: string;
	planSigSinceMs: number;
	/** The last automatic run's start. */
	lastRunMs: number | null;
	/** Failed runs in a row, and when the last one failed. */
	failures: number;
	failedMs: number | null;
	/** The verdict's reasons. */
	reasons: readonly BriefingReason[];
	/** The loaded briefing's age, null with none. */
	ageMs: number | null;
	/** The pilot's last press or keystroke. */
	activeMs: number | null;
	/** The reasons the last committed run left standing, for the plan, the
	 *  UTC day and the source it ran for. Held, after the pilot stopped a
	 *  run or cleared the briefing, it stands for every reason. */
	left: { sig: string; day: string; source: string; codes: readonly string[]; held?: boolean | undefined } | null;
	day: string;
	source: string;
}

export interface RefreshDecision {
	due: boolean;
	/** When only time stands in the way (the stillness, the spacing, the
	 *  backoff), the instant to look again. Null when a change of state
	 *  must come first. */
	wakeMs: number | null;
}

/** The wait after `failures` failed runs in a row. */
export function backoffMs(failures: number): number {
	return failures <= 0 ? 0 : (BACKOFF_MS[failures - 1] ?? BACKOFF_CAP_MS);
}

/** Would a fetch now cure one of these reasons? The RTBA reason waits for
 *  the release, before which a fetch learns nothing new, and the SUP AIP
 *  list renews with the app's datasets. A print and the Fly tap ask this
 *  alone (state/briefingFetch.ts ensureBriefing). */
export function fetchCures(reasons: readonly BriefingReason[], nowMs: number): boolean {
	return reasons.some((r) => (r.code !== 'rtba' || r.releaseMs <= nowMs) && r.code !== 'supaip');
}

/** The reasons a committed run leaves standing, for `left`: those a fetch
 *  could have cured then. An RTBA reason before its release and a SUP AIP
 *  one wait for something a fetch cannot bring, so they stay asked: once
 *  the release passes, the next run is due. */
export function leftStanding(reasons: readonly BriefingReason[], nowMs: number): string[] {
	return reasons.filter((r) => fetchCures([r], nowMs)).map((r) => r.code);
}

/** Would an automatic run cure something? A reason the last committed run
 *  left standing, for the same plan, day and source, is asked once: a
 *  briefing growing old asks again, through the age. */
function wanted(i: RefreshInput): boolean {
	const l = i.left;
	const same = l !== null && l.sig === i.planSig && l.day === i.day && l.source === i.source;
	// The pilot stopped a run or cleared the briefing: no run until the
	// plan, the day or the source changes.
	if (same && l.held) {
		return false;
	}
	const standing = same ? new Set(l.codes) : null;
	const asked = standing ? i.reasons.filter((r) => !standing.has(r.code)) : i.reasons;
	if (fetchCures(asked, i.nowMs)) {
		return true;
	}
	return i.ageMs !== null && i.ageMs > IDLE_AGE_MS && i.activeMs !== null && i.nowMs - i.activeMs <= ACTIVE_MS;
}

/** Is an automatic run due, and if only time stands in the way, when? */
export function refreshDue(i: RefreshInput): RefreshDecision {
	if (
		!i.enabled ||
		!i.restored ||
		!i.sourceReady ||
		!i.visible ||
		!i.online ||
		i.busy ||
		!i.onGround ||
		!i.replaceable ||
		!wanted(i)
	) {
		return { due: false, wakeMs: null };
	}
	let at = i.planSigSinceMs + STILL_MS;
	if (i.failures > 0 && i.failedMs !== null) {
		at = Math.max(at, i.failedMs + backoffMs(i.failures));
	} else if (i.lastRunMs !== null) {
		at = Math.max(at, i.lastRunMs + SPACING_MS);
	}
	return at <= i.nowMs ? { due: true, wakeMs: null } : { due: false, wakeMs: at };
}

export interface NoticeInput {
	/** Not recording, recording and still on the ground, or in the air. */
	phase: 'ground' | 'departing' | 'air';
	/** The verdict's reasons. */
	reasons: readonly BriefingReason[];
	/** Will the app cure a reason by itself: a run due, or held by time
	 *  alone, with no failure behind it. */
	curing: boolean;
	/** A fetch or a run is going on. */
	running: boolean;
	/** The Settings switch. */
	enabled: boolean;
	/** The plan has held still STILL_MS. */
	planStill: boolean;
}

/** Does the map say the briefing needs the pilot? On the ground, while a
 *  reason stands that the app will not cure now: the switch off (once the
 *  plan holds still, so an edit does not flash it), offline, a failed run,
 *  a reason the last run left standing, a briefing it does not replace, an
 *  RTBA release still to come. From the start of a recording to the
 *  takeoff, while any reason stands, a fetch running included. In the air,
 *  never: the alerts carry the caveat there. */
export function noticeShown(i: NoticeInput): boolean {
	if (i.phase === 'air' || i.reasons.length === 0) {
		return false;
	}
	if (i.phase === 'departing') {
		return true;
	}
	if (i.running) {
		return false;
	}
	if (!i.enabled) {
		return i.planStill;
	}
	return !i.curing;
}

/** The instant the pilot away from the app is reminded at, and the flight's
 *  day it is for: the RTBA release of the verdict's rtba reason, while the
 *  app would fetch by itself (the switch on, a source able to brief the
 *  plan, a briefing it may replace) and the verdict judges the planned
 *  flight still to come (`planned`: no recording, the planned window ahead;
 *  otherwise its window rolls from the present). It stays past the release,
 *  until a fetch cures the reason. Null takes the reminder back. Android
 *  only (state/briefingReminder.svelte.ts). */
export function reminderDue(
	i: Pick<RefreshInput, 'enabled' | 'sourceReady' | 'replaceable' | 'reasons'> & { planned: boolean },
): { atMs: number; dayMs: number } | null {
	if (!i.planned || !i.enabled || !i.sourceReady || !i.replaceable) {
		return null;
	}
	for (const r of i.reasons) {
		if (r.code === 'rtba') {
			return { atMs: r.releaseMs, dayMs: r.dayMs };
		}
	}
	return null;
}
