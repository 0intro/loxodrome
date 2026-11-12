/* Open/close for the "?" shortcut-and-gesture map (ShortcutsOverlay.svelte): a
 * state module so the component's own "?" handler and the search palette's
 * action (labelled from the same catalog title) open the same overlay. */

export const shortcutsOverlay = $state<{ open: boolean }>({ open: false });

export function openShortcuts(): void {
	shortcutsOverlay.open = true;
}

export function closeShortcuts(): void {
	shortcutsOverlay.open = false;
}
