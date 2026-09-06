/* "Reset the application" (Display tab foot; simplicity review Decision 6):
 * clear the stored state of the confirmed groups, then reload. Clearing is
 * the DEFAULT for every 'loxodrome:' key and only KEEPING requires a
 * listing below, so a future key nobody registers here still resets with
 * the settings group. The PWA caches (map tiles, terrain, datasets) live in
 * the Cache Storage the service worker owns, not in localStorage, so
 * offline maps survive a reset; the dialog's fine print states it. */

import { removeItem } from './persist';
import { nav, stopRecording } from './navRecording.svelte';
import { disarmRoutesPersist, flushRoutesPersist } from './routePersist';
import { archiveCurrentOuting, wipeFlights } from './flightLibrary.svelte';
import { clearNativeJournal, stopNativeRecorder } from '$lib/native/navRecorder';

const PREFIX = 'loxodrome:';

/** The dialog's checkbox groups; true = erase that group's data. */
export interface ResetSelection {
	/** Settings and preferences: every key claimed by no other group. */
	settings: boolean;
	/** Briefing, routes and traces. */
	briefing: boolean;
	/** My aircraft and pilot details (authored data). */
	aircraft: boolean;
	/** The flights library (IndexedDB, outside the key sweep below). */
	flights: boolean;
}

/* The enumerated keep-lists (the settings group is the complement). */
const BRIEFING_KEYS = new Set([
	'loxodrome:routes', // routePersist.ts: the route workspace
	'loxodrome:routes-rescued', // routePersist.ts: a workspace held back from an overwrite
	'loxodrome:nav-trace', // navRecording.svelte.ts: the recorded trace
	'loxodrome:nav-trace-parked', // navRecording.svelte.ts: a finished flight awaiting its flights row
]);
const AIRCRAFT_KEYS = new Set([
	'loxodrome:aircraft-user', // aircraft.svelte.ts: the user's data sheets
	'loxodrome:aircraft-fuel', // aircraft.svelte.ts: tanked grade per plane, user-set operational state
	'loxodrome:flight-prep', // flightPrep.svelte.ts: the prep inputs
	'loxodrome:pilot', // flightPrep.svelte.ts: the pilot identity block, its own key
]);

function erased(key: string, sel: ResetSelection): boolean {
	if (BRIEFING_KEYS.has(key)) {
		return sel.briefing;
	}
	if (AIRCRAFT_KEYS.has(key)) {
		return sel.aircraft;
	}
	return sel.settings;
}

/** Erase the selected groups' stored keys and reload the application.
 *
 *  Ordering is the contract: the two crash-recovery writers flush on
 *  pagehide, which the reload fires AFTER the clear, so each is disarmed
 *  first. flushRoutesPersist() drains the debounced route write (its
 *  pagehide flush then no-ops on the null pending signature), and a live
 *  recording is stopped when the traces group is going anyway, which
 *  unbinds the trace's own pagehide flush; both land their final write
 *  BEFORE the sweep below removes the keys. */
export async function resetApplication(sel: ResetSelection): Promise<void> {
	flushRoutesPersist();
	// Then stand the writer down entirely: a held stored workspace must not be
	// rescued into a catalog this reset is about to wipe, which would
	// resurrect the very plan the user asked to be rid of.
	disarmRoutesPersist();
	const wasRecording = nav.recording;
	if (sel.briefing) {
		if (nav.recording) {
			stopRecording();
		}
		// The native journal would resurrect the erased trace at the next
		// boot reconcile, and stopRecording's own async finalize never
		// survives the reload below: stop the service and clear the journal
		// fire-and-forget (the calls dispatch off the handle the boot
		// reconcile parked, ahead of the navigation), unconditionally, since
		// an unreconciled native-side stop leaves a journal with no
		// recording running.
		void stopNativeRecorder();
		void clearNativeJournal();
	}
	// The flights library lives in IndexedDB, outside the key sweep below:
	// erasing AWAITS the store clear (an un-awaited delete would race the
	// reload), and KEEPING it while a recording was live awaits an explicit
	// archive, since the stop hook's fire-and-forget write would be cut by
	// the reload and the crash doc may be going with the briefing group
	// (docs/flights-library.md). Both are idempotent.
	if (sel.flights) {
		await wipeFlights();
	} else if (wasRecording) {
		await archiveCurrentOuting();
	}
	const doomed: string[] = [];
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key !== null && key.startsWith(PREFIX) && erased(key, sel)) {
				doomed.push(key);
			}
		}
	} catch {
		/* storage unavailable: nothing stored, nothing to erase */
	}
	for (const key of doomed) {
		removeItem(key);
	}
	location.reload();
}
