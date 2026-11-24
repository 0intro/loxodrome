/* The automatic NOTAM briefing's clock, which BriefingHost runs as an
 * effect (flight app only). Each tick reads what the decision reads
 * (notam/briefingRefresh.ts refreshDue over refreshInputNow), keeps the
 * instant the plan's signature last changed, and starts the run
 * (state/briefingFetch.ts) when it is due. A timer wakes it when only time
 * stands in the way, and the minute tick and the page's events do the
 * rest. The plan's signature and the pilot's last press are plain values:
 * read when a tick runs, never a reason to run one. */

import { untrack } from 'svelte';
import { refreshDue } from '$lib/notam/briefingRefresh';
import { briefingWatch, planSignature, refreshInputNow } from './briefing.svelte';
import { runBriefing } from './briefingFetch';
import { notamState } from './notam.svelte';

export interface BriefingClock {
	/** The effect's body. */
	tick(): void;
	/** The pilot pressed or typed. */
	pressed(): void;
	/** Clear the wake timer. */
	stop(): void;
}

export function createBriefingClock(): BriefingClock {
	/** Bumped by the timer. */
	let wake = $state(0);
	let activeMs: number | null = null;
	/** The plan's signature since the restore. The first one counts as long
	 *  held: a boot's plan is no edit to wait for. */
	let sig: string | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;

	function stop(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	return {
		tick() {
			void wake;
			void notamState.tick;
			const now = Date.now();
			const planSig = planSignature();
			if (briefingWatch.restored && planSig !== sig) {
				const since = sig === null ? 0 : now;
				sig = planSig;
				untrack(() => {
					briefingWatch.planSince = since;
				});
			}
			const decision = refreshDue(refreshInputNow(now, activeMs));
			untrack(() => {
				stop();
				if (decision.wakeMs !== null) {
					timer = setTimeout(() => {
						wake += 1;
					}, decision.wakeMs - now);
				}
				if (decision.due) {
					void runBriefing();
				}
			});
		},
		pressed() {
			activeMs = Date.now();
		},
		stop,
	};
}
