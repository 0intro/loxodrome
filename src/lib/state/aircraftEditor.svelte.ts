/* Mode / target / page state for the aircraft editor surface. Open-ness and
 * placement are the workspace slot; see aboutModal.svelte.ts.
 *
 * It opens as a page filling the stage, keeping the Aircraft tab it was
 * opened from on screen beside it. Claiming the overlay slot displaces
 * whatever else held it, so no module here closes another by hand.
 *
 * The editor shows the plane picked in that tab: a pick in the fleet list
 * moves it there (pickAircraft). Every request that would put another sheet
 * in front of the pilot goes through the modal's leave guard first, so no
 * request ever reseeds a draft that holds unsaved edits without asking. */

import type { AircraftEditorPage } from '$lib/aircraft/edit';
import { GENERIC_KEY_PREFIX } from '$lib/aircraft/schema';
import { aircraftState, selectAircraft } from './aircraft.svelte';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

/** edit: a fleet plane; create: a new sheet, blank or a copy; view: a
 *  generic library sheet, shown read-only (a pilot's figures go on a
 *  Duplicate of it). */
export type AircraftEditorMode = 'edit' | 'create' | 'view';

const local = $state<{
	mode: AircraftEditorMode;
	/** edit / view: the plane's fleet key; create: the duplicate source key,
	 *  or null for a blank sheet. */
	key: string | null;
	page: AircraftEditorPage;
	/** Bumped once per accepted change of subject. The editor rebuilds its
	 *  draft from THIS, not from open-ness: asking for another plane while
	 *  the editor is already up changes neither the placement nor open-ness,
	 *  so nothing else tells the draft that its subject moved. */
	requestSeq: number;
}>({ mode: 'create', key: null, page: 'general', requestSeq: 0 });

export const aircraftEditor = {
	get open(): boolean {
		return isOpen('aircraftEditor');
	},
	get requestSeq(): number {
		return local.requestSeq;
	},
	get mode(): AircraftEditorMode {
		return local.mode;
	},
	get key(): string | null {
		return local.key;
	},
	get page(): AircraftEditorPage {
		return local.page;
	},
	set page(page: AircraftEditorPage) {
		local.page = page;
	},
};

/** A generic library sheet is shown read-only; any other plane is edited.
 *  The prefix is the key's own (aircraftKey), so no fleet lookup. */
function modeFor(key: string): 'edit' | 'view' {
	return key.startsWith(GENERIC_KEY_PREFIX) ? 'view' : 'edit';
}

type LeaveGuard = (proceed: () => void) => void;
let leaveGuard: LeaveGuard | null = null;

/** The modal's unsaved-edits check, registered while it is mounted: it runs
 *  the continuation at once, or holds it behind its discard confirm when the
 *  open draft holds unsaved edits. Unregistering checks identity, the way
 *  registerSurfaceClose does, so a remount's guard is never dropped by the
 *  teardown of the one it replaced. */
export function registerEditorLeaveGuard(guard: LeaveGuard): () => void {
	leaveGuard = guard;
	return () => {
		if (leaveGuard === guard) {
			leaveGuard = null;
		}
	};
}

/** Run a change of subject behind the guard. A closed editor has nothing to
 *  lose (the lazy modal stays mounted after a close, its last draft still
 *  differing from its baseline, so it must not be asked), and with no guard
 *  registered the modal's chunk has not arrived yet, so there is no draft. */
function guarded(proceed: () => void): void {
	if (leaveGuard !== null && isOpen('aircraftEditor')) {
		leaveGuard(proceed);
	} else {
		proceed();
	}
}

/** Point the editor at a new subject; the modal reseeds its draft from it. */
function retarget(mode: AircraftEditorMode, key: string | null, page: AircraftEditorPage): void {
	local.mode = mode;
	local.key = key;
	local.page = page;
	local.requestSeq += 1;
}

/* The entry points stay reachable in the Aircraft tab beside the editor (it
 * opens as a page), so asking again for exactly what is already open puts it
 * away, the way clicking the active sidebar tab closes its panel. Asking for
 * another subject switches to it, behind the guard; asking for another page
 * of the subject shown only turns the page, never a reseed. An open editor is
 * retargeted in place, never reopened: openSurface would re-resolve the
 * placement and, for a page, close the detail panel. The close goes through
 * the surface's own handler, so unsaved edits still get their confirm. */
function openEditor(mode: AircraftEditorMode, key: string | null, page?: AircraftEditorPage): void {
	if (!isOpen('aircraftEditor')) {
		const was = { mode: local.mode, key: local.key, page: local.page };
		retarget(mode, key, page ?? local.page);
		openSurface('aircraftEditor');
		if (!isOpen('aircraftEditor')) {
			// Refused by whoever holds the overlay slot: put the target back, or
			// the next successful open lands on a request that never happened.
			local.mode = was.mode;
			local.key = was.key;
			local.page = was.page;
		}
		return;
	}
	if (local.mode === mode && local.key === key) {
		if (page === undefined || page === local.page) {
			requestCloseSurface('aircraftEditor');
		} else {
			local.page = page;
		}
		return;
	}
	guarded(() => retarget(mode, key, page ?? local.page));
}

/** Is the editor up on this plane (edited, or a generic sheet shown)? Its
 *  entry point is a toggle (asking again puts it away), so it can and should
 *  report itself pressed, the way the surface launchers on the Route and
 *  Navigation tabs do. */
export function editorShows(key: string): boolean {
	return isOpen('aircraftEditor') && local.mode !== 'create' && local.key === key;
}

/** Show a fleet plane in the editor, a generic sheet read-only, on the page
 *  asked for or else the one last shown. */
export function openAircraftEditor(key: string, page?: AircraftEditorPage): void {
	openEditor(modeFor(key), key, page);
}

/** Create a new plane as a copy of an existing one (registration cleared,
 *  so the save-time collision check forces a new key). */
export function openAircraftDuplicate(sourceKey: string): void {
	openEditor('create', sourceKey, 'general');
}

/** Create a new plane from a blank sheet. */
export function openAircraftCreate(): void {
	openEditor('create', null, 'general');
}

/** A plane picked in the Aircraft panel's fleet list. With the editor up, the
 *  selection and the editor move together, on the page it shows, once the
 *  guard lets them: a refused discard leaves both where they were. A click on
 *  the selected row selects nothing new and never abandons a New or Duplicate
 *  sheet; it still brings an editor showing another plane to it (an import
 *  selects the plane it brings in and leaves the editor where it was). Nothing
 *  else moves an open editor (an import, a plan load, a sync or a save
 *  selecting a plane leave it on its sheet), and no effect watches the
 *  selection: a confirm must only ever answer the pilot's own gesture. */
export function pickAircraft(key: string): void {
	const mode = modeFor(key);
	const open = isOpen('aircraftEditor');
	if (open && local.mode === mode && local.key === key) {
		if (key !== aircraftState.selectedKey) {
			selectAircraft(key);
		}
		return;
	}
	if (key === aircraftState.selectedKey && (!open || local.mode === 'create')) {
		return;
	}
	if (!open) {
		selectAircraft(key);
		return;
	}
	guarded(() => {
		selectAircraft(key);
		retarget(mode, key, local.page);
	});
}

/** A save landed: the editor goes on editing the plane under the key it was
 *  saved as (a new plane, a re-keyed one) in place. No requestSeq bump: the
 *  modal reseeds its own draft from the fleet, and nothing was lost. */
export function editorSaved(key: string): void {
	local.mode = 'edit';
	local.key = key;
}

/** The plane being edited vanished (deleted from another surface while the
 *  editor was open): fall back to a blank sheet, so the open editor still has
 *  something to edit. */
export function degradeToCreate(): void {
	local.mode = 'create';
	local.key = null;
}

export function closeAircraftEditor(): void {
	closeSurface('aircraftEditor');
}
