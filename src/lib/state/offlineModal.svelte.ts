/* State for the offline manager surface (docs/offline-maps.md).
 *
 * `focus` names the section an entry point wants the pilot to land on: the
 * Route tab's terrain row asks for 'terrain', the Layers tab's row asks for
 * nothing and lands at the top. `focusSeq` is what distinguishes a fresh
 * request from a repeat, since a same-value write notifies nobody
 * (docs/workspace-surfaces.md, Invariants).
 *
 * Open-ness is not stored here: it is the workspace slot the surface holds
 * (state/workspace.svelte.ts), read through a getter so callers keep writing
 * `offlineModal.open` and stay reactive. */

import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';
import { offlineCharts } from './offlineCharts.svelte';
import { offlineDocs } from './offlineDocs.svelte';
import { availableChartLayers } from '$lib/map/chartOverlays';
import { DOC_PACKS } from '$lib/offline/docPacks';
import { isNativeApp } from '$lib/native/platform';

/** Whether this device has any reason to open the manager, which is the ONE
 *  gate every door reads (the Layers tab's row, the toolbar and the search
 *  palette), so the three cannot drift apart.
 *
 *  Downloading is the Android shell's alone (docs/offline-maps.md: a pack is
 *  the promise a chart will be there at the aerodrome, and only the shell can
 *  keep it). Holding something opens the door anywhere, because a pack on
 *  disk keeps its Delete on every platform. With neither, there is nothing to
 *  manage and no door: a row the surface cannot serve is absent, never
 *  disabled. */
export function offlineManagerAvailable(): boolean {
	if (!offlineCharts.supported) {
		return false;
	}
	if (isNativeApp()) {
		return true;
	}
	return (
		availableChartLayers().some((d) => offlineCharts.packs[d.id]?.status === 'ready') ||
		DOC_PACKS.some((d) => offlineDocs.packs[d.id]?.status === 'ready')
	);
}

export type OfflineSection = 'queue' | 'charts' | 'documents' | 'terrain' | 'storage';

const local = $state<{ focus: OfflineSection | null; focusSeq: number }>({
	focus: null,
	focusSeq: 0,
});

export const offlineModal = {
	get open(): boolean {
		return isOpen('offline');
	},
	get focus(): OfflineSection | null {
		return isOpen('offline') ? local.focus : null;
	},
	/** Bumped by every focused open, so the scroll effect fires again when
	 *  the SAME section is asked for twice. */
	get focusSeq(): number {
		return local.focusSeq;
	},
};

/** Open the manager, optionally landing on one section. The focus request is
 *  kept only if the open took: a refused eviction must leave nothing behind. */
export function openOffline(section?: OfflineSection): void {
	const was = local.focus;
	if (section) {
		local.focus = section;
		local.focusSeq++;
	}
	openSurface('offline');
	if (!isOpen('offline')) {
		local.focus = was;
	}
}

/** The entry-point button: put the surface away when it already shows what
 *  is being asked for, else open it or re-aim it (the parameterised-toggle
 *  rule the flights library and flight prep follow). */
export function toggleOffline(section?: OfflineSection): void {
	if (isOpen('offline') && (section === undefined || section === local.focus)) {
		requestCloseSurface('offline');
		return;
	}
	openOffline(section);
}

export function closeOffline(): void {
	closeSurface('offline');
	local.focus = null;
}
