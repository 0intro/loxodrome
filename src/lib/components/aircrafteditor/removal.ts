/* "Remove section", "Remove config", the POH grid's altitude and column
 * removers and the switch of performance model ask first when what they
 * remove holds figures: one click used to drop a transcribed grid, a row of
 * it or a configuration's fitted coefficients. The editor (AircraftEditorModal) provides the question,
 * its own ConfirmDialog, through context; a page asks with the part's name, the
 * part as it stands, the part as it is freshly added, and the removal. A part
 * nobody has filled in goes at once, with no question. */

import { getContext, setContext } from 'svelte';

/** 'model': the performance model's own part, on a switch of kind (its
 *  name is the kind switched to). */
export type RemovedPart = 'section' | 'config' | 'altitude' | 'column' | 'model';

/** `name` is read when the question renders, so a locale switch re-words it. */
export type AskRemoval = (part: RemovedPart, name: () => string, current: unknown, blank: unknown, remove: () => void) => void;

const KEY = Symbol('aircraftEditorRemoval');

export function provideRemoval(ask: AskRemoval): void {
	setContext(KEY, ask);
}

/** The editor's question; outside the editor, a removal runs at once. */
export function askRemoval(): AskRemoval {
	return getContext<AskRemoval | undefined>(KEY) ?? ((_part, _name, _current, _blank, remove) => remove());
}

/** Is the part still as it is freshly added? */
export function untouched(current: unknown, blank: unknown): boolean {
	return JSON.stringify(current) === JSON.stringify(blank);
}
