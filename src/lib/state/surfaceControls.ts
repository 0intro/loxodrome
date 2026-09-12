/* The plain open / toggle / close trio for a workspace surface with no
 * state of its own (docs/workspace-surfaces.md, Adding a surface):
 * open-ness is the workspace slot behind a getter, open cancels a pending
 * Weather-tab briefing print (only one portaled document ever prints),
 * toggle is the entry-point button that stays reachable beside a docked
 * surface (pressing it again puts the surface away, the way clicking the
 * active sidebar tab closes its panel), and close goes through the
 * workspace so the eviction rules hold. A surface carrying its own params
 * keeps a hand-written module instead (state/aboutModal.svelte.ts is that
 * reference shape). */

import type { SurfaceId } from '$lib/surfaces';
import { cancelWxPrint } from './wxPrint.svelte';
import { closeSurface, isOpen, openSurface, requestCloseSurface } from './workspace.svelte';

export interface SurfaceTrio {
	state: { readonly open: boolean };
	open: () => void;
	toggle: () => void;
	close: () => void;
}

export function surfaceControls(id: SurfaceId): SurfaceTrio {
	const open = (): void => {
		cancelWxPrint();
		openSurface(id);
	};
	return {
		state: {
			get open(): boolean {
				return isOpen(id);
			},
		},
		open,
		toggle: (): void => {
			if (isOpen(id)) {
				requestCloseSurface(id);
				return;
			}
			open();
		},
		close: (): void => closeSurface(id),
	};
}
