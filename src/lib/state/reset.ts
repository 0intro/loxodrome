/* "Reset the application" (Settings tab foot; simplicity review Decision 6):
 * clear the stored state of the confirmed groups, then reload. Which group a
 * key belongs to is its class in state/storageKeys.ts: briefing and aircraft
 * keys go with their own checkboxes, and every other key, one nobody
 * registered included, goes with the settings group, so clearing stays the
 * default. The PWA caches (map tiles, terrain, datasets) live in the Cache
 * Storage the service worker owns, not in localStorage, so offline maps
 * survive a reset; the dialog's fine print states it. The non-destructive
 * sibling, Restore default settings, is state/defaultSettings.ts. */

import { keysWithPrefix, removeItem, sealStorage } from './persist';
import { STORAGE_PREFIX, storageClassOf } from './storageKeys';
import { sharedDeviceFlag } from '$lib/sync/keys';
import { readSessionEnd, wipeSessionIdb, wipeSharedSession } from '$lib/sync/wipe';
import { clearFoundRows } from '$lib/sync/found';
import { withSyncWriter } from './syncRegistry';
import { resetLayerChoices } from './layers.svelte';
import { viewHashWithoutLayers, writeViewHash } from '$lib/map/viewHash';
import { forgetTraceFiled, nav, stopRecording } from './navRecording.svelte';
import { disarmRoutesPersist, flushRoutesPersist } from './routePersist';
import { archiveCurrentOuting, wipeFlights } from './flightLibrary.svelte';
import { clearNativeJournal, stopNativeRecorder } from '$lib/native/navRecorder';
import { haltSync, recordingRefusal, stampOwed, type RecordingRefusal } from './sync.svelte';

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

function erased(key: string, sel: ResetSelection): boolean {
	switch (storageClassOf(key)) {
		case 'briefing':
			return sel.briefing;
		case 'aircraft':
			return sel.aircraft;
		default:
			return sel.settings;
	}
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
export async function resetApplication(sel: ResetSelection): Promise<RecordingRefusal | void> {
	// A SHARED session the settings group signs out ENDS, and no end runs
	// under a flight, in this tab or another (docs/accounts-sync.md, "No end
	// under a flight"): it navigates, which stops the flight here, and erases
	// the crash copy and the workspace of a flight anywhere. Refused before
	// anything is touched, saying why (the Account surface's own words).
	if (sel.settings && sharedDeviceFlag()) {
		const refused = await recordingRefusal();
		if (refused !== null) {
			return refused;
		}
	}
	flushRoutesPersist();
	// Sync is the one writer a reset cannot reach by flushing: it answers
	// triggers of its own, and its trace download runs outside every pass
	// promise. Halt it whole before the stores go, or a pass firing inside
	// the awaits below lands pulled rows into a library being erased.
	await haltSync();
	// Then stand the writer down entirely: a held stored workspace must not be
	// rescued into a catalog this reset is about to wipe, which would
	// resurrect the very plan the user asked to be rid of.
	disarmRoutesPersist();
	// A SHARED session the settings group signs out ends like any other
	// (docs/accounts-sync.md, "Device modes"), at the device's defaults
	// whichever groups are kept: its account's own data, the plans and
	// outings its registry lists and its planes, grades and pilot block entry
	// by entry, what the session made and never synced, and the rest of the
	// session with them, its workspace, its trace and its preparation inputs
	// among it, while what its sign-in found goes back as found
	// (wipeSharedSession). The groups then erase the DEVICE's own, as they do
	// signed out. Under the writer lock, so a pass in another tab cannot pull
	// anything back behind this.
	if (sel.settings && sharedDeviceFlag()) {
		const startMs = Date.now();
		await withSyncWriter(async () => {
			const end = readSessionEnd(stampOwed());
			await wipeSessionIdb(end, startMs);
			wipeSharedSession(end);
		});
	} else if (sel.settings) {
		// A found copy a shared session left behind has nothing to put back
		// once the account keys go (the key itself goes with them below).
		await clearFoundRows();
	}
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
		// A trace kept with the briefing group must stop claiming a row the
		// wipe just took: the next boot would read it as filed and let a new
		// flight replace it without a word.
		forgetTraceFiled();
	} else if (wasRecording) {
		await archiveCurrentOuting();
	}
	for (const key of keysWithPrefix(STORAGE_PREFIX)) {
		if (erased(key, sel)) {
			removeItem(key);
		}
	}
	if (sel.settings) {
		// The layer choices live in the URL too: a present #map= wins over the
		// stored seed at boot (MapView), so the reload would put the base map
		// and the chart stack straight back over the key just erased. The
		// view stays, its layers go. The choices go in memory first, so a
		// restamp MapView has pending writes the default rather than the old
		// stack back into the hash before the reload lands.
		resetLayerChoices();
		writeViewHash(viewHashWithoutLayers(location.hash));
	}
	// Nothing written between here and the unload may land: the reset of the
	// layer choices above re-runs PersistHost's layers effect and MapView's
	// view stamp, and either would put an erased key back for the next boot.
	sealStorage();
	location.reload();
}
