/* What Ctrl/Cmd+P does (ui/printKey.ts's window listener): it presses the
 * printer of the window in front, or with no window open the app's own (the
 * toolbar's flight dossier in Loxodrome, the bulletin in the NOTAM Viewer).
 * Pure, so the decision is pinned in node and the listener only reads the
 * page, the planShortcut.ts model.
 *
 * `pass` leaves the key to the browser, whose own print then prints the
 * window in front alone: any other key, Shift held (Chromium's system
 * dialog, Firefox's private window), Alt held (AltGr on Windows layouts),
 * or nothing to press. `hold` cancels the browser's print and presses
 * nothing: a key held down repeats, a question standing (a confirm, the
 * palette, a dialog box) answers first, and a print already preparing or
 * printing runs alone. `press` presses the printer. */

import type { KeyLike } from './planShortcut';

export type PrintKey = 'pass' | 'hold' | 'press';

export interface PrintKeyState {
	/** A question stands. */
	blocked: boolean;
	/** A print prepares or a job is live (printBusy). */
	busy: boolean;
	/** The window in front, or the app, has a printer to press. */
	printer: boolean;
}

/** Ctrl or Cmd with P alone. */
export function isPrintKey(e: KeyLike): boolean {
	return e.key.toLowerCase() === 'p' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

export function printKey(e: KeyLike, s: PrintKeyState): PrintKey {
	if (!isPrintKey(e)) {
		return 'pass';
	}
	if (e.repeat || s.blocked || s.busy) {
		return 'hold';
	}
	return s.printer ? 'press' : 'pass';
}
