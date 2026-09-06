/* Mode / target / page state for the aircraft editor surface. Open-ness and
 * placement are the workspace slot; see aboutModal.svelte.ts.
 *
 * It opens as a page filling the stage, keeping the Aircraft tab it was
 * opened from on screen beside it. Claiming the overlay slot displaces
 * whatever else held it, so no module here closes another by hand. */

import type { AircraftEditorPage } from '$lib/aircraft/edit';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

const local = $state<{
	mode: 'edit' | 'create';
	/** edit: the plane's fleet key; create: the duplicate source key, or
	 *  null for a blank sheet. */
	key: string | null;
	page: AircraftEditorPage;
	/** Bumped once per accepted open request. The editor rebuilds its draft
	 *  from THIS, not from open-ness: asking for another plane while the
	 *  editor is already up changes neither the placement nor open-ness, so
	 *  nothing else tells the draft that its subject moved. */
	requestSeq: number;
}>({ mode: 'create', key: null, page: 'general', requestSeq: 0 });

export const aircraftEditor = {
	get open(): boolean {
		return isOpen('aircraftEditor');
	},
	get requestSeq(): number {
		return local.requestSeq;
	},
	get mode(): 'edit' | 'create' {
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

/* The entry points stay reachable in the Aircraft tab beside the editor (it
 * opens as a page), so asking again for exactly what is already open puts it
 * away, the way clicking the active sidebar tab closes its panel. Asking for
 * a different plane or a different page switches to it, so a per-section
 * link is never a dismiss. The close goes through the surface's own handler,
 * so unsaved edits still get their confirm. */
function openEditor(mode: 'edit' | 'create', key: string | null, page: AircraftEditorPage): void {
	if (isOpen('aircraftEditor') && local.mode === mode && local.key === key && local.page === page) {
		requestCloseSurface('aircraftEditor');
		return;
	}
	const was = { mode: local.mode, key: local.key, page: local.page };
	local.mode = mode;
	local.key = key;
	local.page = page;
	local.requestSeq += 1;
	openSurface('aircraftEditor');
	if (!isOpen('aircraftEditor')) {
		// Refused by whoever holds the overlay slot: put the target back, or
		// the next successful open lands on a request that never happened.
		local.mode = was.mode;
		local.key = was.key;
		local.page = was.page;
	}
}

/** Is the editor up on exactly this plane and page? The entry points are
 *  toggles (asking again for what is already open puts it away), so they can
 *  and should report themselves pressed, the way the surface launchers on the
 *  Route and Navigation tabs do. */
export function editorShows(key: string, page: AircraftEditorPage = 'general'): boolean {
	return (
		isOpen('aircraftEditor') && local.mode === 'edit' && local.key === key && local.page === page
	);
}

/** Edit an existing fleet plane, optionally landing on a specific page. */
export function openAircraftEditor(key: string, page: AircraftEditorPage = 'general'): void {
	openEditor('edit', key, page);
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
