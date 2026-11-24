/* The flight app's half of the kept NOTAM briefing (state/briefingStore.ts):
 * the boot's restore, and a write after each change of the briefing,
 * coalesced over a second, flushed when the page is hidden and written at
 * once while it is. The NOTAM Viewer never imports it, so it never opens
 * the database. */

import { readStoredBriefing, writeStoredBriefing } from './briefingStore';
import {
	briefingGeneration,
	briefingLoaded,
	restoreBriefing,
	setBriefingChangeHook,
	snapshotBriefing,
} from './notam.svelte';

/** A burst of changes (a fetch, then the aerodromes fetched after it) is
 *  one write. */
const COALESCE_MS = 1000;

let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
	if (timer === null) {
		return;
	}
	clearTimeout(timer);
	timer = null;
	void writeStoredBriefing(snapshotBriefing());
}

/** Write the loaded briefing after each change. Called once, at boot. */
export function installBriefingKeep(): void {
	setBriefingChangeHook(() => {
		if (timer !== null) {
			clearTimeout(timer);
		}
		timer = setTimeout(flush, COALESCE_MS);
		// A run goes on landing behind a locked screen, and a hidden page
		// may be frozen before the timer fires, then killed.
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			flush();
		}
	});
	// A relaunch right after a fetch finds it: Android hides the page before
	// it kills the process.
	if (typeof document !== 'undefined') {
		addEventListener('pagehide', flush);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				flush();
			}
		});
	}
}

/** Load the kept briefing, waiting `waitMs` at most: a slower read lands
 *  when it can, unless a briefing was loaded meanwhile (a ?file=, a
 *  fetch), which wins. A record this version cannot restore is dropped. */
export async function restoreKeptBriefing(waitMs: number): Promise<void> {
	const generation = briefingGeneration();
	const read = readStoredBriefing(Date.now(), (doc) => {
		if (briefingGeneration() === generation && !briefingLoaded()) {
			restoreBriefing(doc);
		}
	});
	await Promise.race([read, new Promise((resolve) => setTimeout(resolve, waitMs))]);
}
