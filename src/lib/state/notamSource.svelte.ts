/* The NOTAMs tab's fetch view above its two sources: which live service the
 * "NOTAMs for route" fetch uses, and whether any NOTAM fetch is running.
 *
 * The source is SOFIA-Briefing (French SIA) or autorouter (Eurocontrol EAD,
 * Europe-wide); both are anonymous to the user, autorouter's shared
 * credential living in the proxy. Persisted so the choice is remembered
 * across sessions; defaults to SOFIA (zero setup). Both fetch paths end at
 * the same seam (notamState.rawText -> parseInput), so this only selects
 * which fetch function the button calls. */

import { autorouter } from '$lib/autorouter/state.svelte';
import { sofia } from '$lib/sofia/state.svelte';
import { readItem, writeItem } from './persist';

export type NotamSource = 'sofia' | 'autorouter';

const LS_KEY = 'loxodrome:notam-source';

// Default SOFIA (no login, works immediately); only an explicit 'autorouter'
// override switches it. readItem degrades to null on storage failure, so the
// default stands.
export const notamSource = $state<{ source: NotamSource }>({
	source: readItem(LS_KEY) === 'autorouter' ? 'autorouter' : 'sofia',
});

export function setNotamSource(s: NotamSource): void {
	notamSource.source = s;
	writeItem(LS_KEY, s);
}

/** Whether ANY NOTAM fetch is running, whichever source and whichever button
 *  started it. Every fetch commits by replacing notamState.rawText and
 *  re-parsing, so two in flight means the slower one silently replaces the
 *  briefing the faster one just landed: this is the one predicate the three
 *  fetch entry points and both fetch buttons ask. */
export function notamFetchBusy(): boolean {
	return autorouter.fetching !== null || sofia.fetching;
}
