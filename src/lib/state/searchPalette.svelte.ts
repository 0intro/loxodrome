/* Open/close for the Ctrl+K search palette (SearchPalette.svelte): one
 * $state flag on the ResetDialog / ShortcutsOverlay convention, deliberately
 * NOT a workspace surface, since a transient launcher needs no registry
 * entry, placement or history entry. Opening kicks off the lazy airport /
 * navaid loads (the ContextMenu idiom: fire-and-forget, the palette renders
 * what is loaded and fills in as each dataset lands). */

import { ensureAirports, ensureNavaids } from './data.svelte';

/** One row of the palette's action registry (surfaces + chart toggles). */
export interface PaletteAction {
	id: string;
	label: string;
	/** Trailing state chip; '' when the action carries none. */
	state: string;
	run: () => void;
}

export const searchPalette = $state<{ open: boolean }>({ open: false });

export function openSearchPalette(): void {
	// Each ensure* is idempotent and records its own failure state.
	void ensureAirports().catch(() => {});
	void ensureNavaids().catch(() => {});
	searchPalette.open = true;
}

export function closeSearchPalette(): void {
	searchPalette.open = false;
}
