/* What Ctrl/Cmd+S does (PlanHost's window listener). Pure, so the
 * decision is pinned in node and the listener only reads the page.
 *
 * `pass` leaves every other key alone. `hold` cancels the browser's Save
 * Page and saves nothing: a key held down repeats, and a question standing
 * (a confirm, the palette, a dialog, the aircraft editor's own edits)
 * answers first. `save` saves the plan, from a text box too, as an editor's
 * Save does. */

export type SaveKey = 'pass' | 'hold' | 'save';

export interface KeyLike {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat: boolean;
}

export function saveKey(e: KeyLike, blocked: boolean): SaveKey {
	if (e.key.toLowerCase() !== 's' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) {
		return 'pass';
	}
	return e.repeat || blocked ? 'hold' : 'save';
}
