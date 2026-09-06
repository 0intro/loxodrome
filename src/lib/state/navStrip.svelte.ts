/* The in-flight strip's own visibility, kept out of navRecording because it is
 * a display choice rather than a fact about the flight.
 *
 * The strip is map chrome, not a workspace surface: the registry has three
 * slots and opening a surface evicts the slot's incumbent, so a strip in one
 * would fight the nav log and the profiles it is meant to sit beside
 * (src/lib/surfaces.ts, docs/workspace-surfaces.md). It therefore has no
 * placement, no backdrop and no history entry, just these switches.
 *
 * Each persists: a pilot who collapsed the strip on the last flight wants it
 * collapsed on this one. */

import { readItem, removeItem, writeItem } from './persist';

const COLLAPSED_KEY = 'loxodrome:nav-strip-collapsed';
const HIDDEN_KEY = 'loxodrome:nav-strip-hidden';
const OVERFLIGHT_KEY = 'loxodrome:nav-overflight';

export const navStrip = $state<{
	/** One line (the contact and the active waypoint) instead of the full band. */
	collapsed: boolean;
	/** Dismissed outright; the Navigation tab brings it back. */
	hidden: boolean;
	/** The overflown-aerodrome frequency cell, the strip's one
	 *  position-resolved figure (state/navOverflight.svelte). */
	overflight: boolean;
	/** The idle PEEK, session-only on purpose: the strip auto-shows only
	 *  while it has a job (recording / replaying / a route loaded, the
	 *  posture rule in NavStrip.svelte), and the restore handle grants a
	 *  look at the frozen readout outside those. A peek is not a standing
	 *  preference, so it is never persisted. */
	idleOpen: boolean;
}>({
	collapsed: readItem(COLLAPSED_KEY) === 'on',
	hidden: readItem(HIDDEN_KEY) === 'on',
	// readItem degrades to null on storage failure, so the default stays on.
	overflight: readItem(OVERFLIGHT_KEY) !== 'off',
	idleOpen: false,
});

/** Stored only in the non-default state, so a default leaves no storage. */
function remember(key: string, on: boolean): void {
	if (on) {
		writeItem(key, 'on');
	} else {
		removeItem(key);
	}
}

export function setStripCollapsed(on: boolean): void {
	navStrip.collapsed = on;
	remember(COLLAPSED_KEY, on);
}

export function setStripHidden(on: boolean): void {
	navStrip.hidden = on;
	remember(HIDDEN_KEY, on);
}

export function toggleStripCollapsed(): void {
	setStripCollapsed(!navStrip.collapsed);
}

/** Default ON, so it is the OFF state that is stored (remember()'s mirror). */
export function setStripOverflight(on: boolean): void {
	navStrip.overflight = on;
	if (on) {
		removeItem(OVERFLIGHT_KEY);
	} else {
		writeItem(OVERFLIGHT_KEY, 'off');
	}
}
