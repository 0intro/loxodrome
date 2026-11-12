/* The two side panels' widths, the sidebar's and the detail panel's
 * (components/Sidebar.svelte, components/DetailPanel.svelte, the latter
 * mounted by the NOTAM Viewer too). They were component state, which nothing
 * outside the component could put back; here Restore default settings can,
 * in place. Remembered sparsely (docs/preferences.md): a key per panel,
 * holding the width while it differs from the default. A drag writes the
 * state as it goes and commits once, on release, as it always did. */

import { readItem, removeItem, writeItem } from './persist';

export type PanelId = 'sidebar' | 'detail';

/** Each panel's key, default and the range its drag and arrow keys keep it
 *  in (the components' ResizeOptions read it here). */
const PANELS = {
	sidebar: { key: 'loxodrome:sidebar-width', def: 400, min: 280, max: 640 },
	detail: { key: 'loxodrome:detail-width', def: 480, min: 320, max: 760 },
} as const satisfies Record<PanelId, { key: string; def: number; min: number; max: number }>;

/** The range a panel's drag and arrow keys keep it in. */
export function panelRange(id: PanelId): { min: number; max: number } {
	return { min: PANELS[id].min, max: PANELS[id].max };
}

/** Both panels, restorePanelWidths' default scope. */
export const PANEL_IDS: readonly PanelId[] = ['sidebar', 'detail'];

/** The stored width, whole pixels inside the panel's range as a drag or a
 *  nudge commits it, else the default: parseInt read '1e3' as a 1 px panel
 *  and took a width no drag reaches, a sidebar wider than the screen. */
function storedWidth(id: PanelId): number {
	const raw = readItem(PANELS[id].key);
	const v = raw !== null && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
	return v >= PANELS[id].min && v <= PANELS[id].max ? v : PANELS[id].def;
}

export const panelWidths = $state<Record<PanelId, number>>({
	sidebar: storedWidth('sidebar'),
	detail: storedWidth('detail'),
});

/** Follow a drag: the state only, remembered at the release. */
export function setPanelWidth(id: PanelId, width: number): void {
	panelWidths[id] = width;
}

/** Settle a width (a released drag, an arrow-key nudge) and remember it,
 *  stored only away from the panel's default. */
export function commitPanelWidth(id: PanelId, width: number): void {
	const w = Math.round(width);
	panelWidths[id] = w;
	if (w === PANELS[id].def) {
		removeItem(PANELS[id].key);
	} else {
		writeItem(PANELS[id].key, String(w));
	}
}

/** Put panel widths back to their defaults, in place, storage included. */
export function restorePanelWidths(which: readonly PanelId[] = PANEL_IDS): void {
	for (const id of which) {
		commitPanelWidth(id, PANELS[id].def);
	}
}
