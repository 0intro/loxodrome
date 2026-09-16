/* State for the stacked-NOTAM menu; opened when a pin badge shows >1 and
 * the user clicks it. Mirrors contextMenu.svelte.ts in shape. */

import type { Notam } from '$lib/notam/types';

export interface NotamMenuItem {
	notam: Notam;
	index: number;
}

export const notamMenu = $state<{
	open: boolean;
	items: NotamMenuItem[];
	x: number;
	y: number;
}>({
	open: false,
	items: [],
	x: 0,
	y: 0,
});

export function openNotamMenu(items: NotamMenuItem[], x: number, y: number): void {
	notamMenu.items = items;
	notamMenu.x = x;
	notamMenu.y = y;
	notamMenu.open = true;
}

export function closeNotamMenu(): void {
	notamMenu.open = false;
	notamMenu.items = [];
}
