/* Ctrl/Cmd+P presses the printer of the window in front, or the app's own
 * with no window open (state/printShortcut.ts decides). Both apps install
 * this listener. A key it leaves alone goes to the browser's own print,
 * whose beforeprint auto-claim prints the window in front alone
 * (surfacePrint.svelte.ts). */

import { printBusy } from '$lib/state/printProgress.svelte';
import { isPrintKey, printKey } from '$lib/state/printShortcut';
import { frontmostWindow } from '$lib/state/workspace.svelte';
import { questionStanding } from './questionStanding';
import { printerFor } from './surfacePrint.svelte';

export function listenForPrintKey(): () => void {
	const onKey = (e: KeyboardEvent): void => {
		if (!isPrintKey(e)) {
			return;
		}
		const press = printerFor(frontmostWindow());
		const act = printKey(e, { blocked: questionStanding(), busy: printBusy(), printer: press !== null });
		if (act === 'pass') {
			return;
		}
		e.preventDefault();
		if (act === 'hold' || press === null) {
			return;
		}
		// A draft in a text box commits as a click elsewhere would.
		const el = document.activeElement;
		if (el instanceof HTMLElement && el.matches('input, select, textarea')) {
			el.blur();
		}
		press();
	};
	window.addEventListener('keydown', onKey);
	return () => window.removeEventListener('keydown', onKey);
}
