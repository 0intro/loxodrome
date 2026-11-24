/* The status of a fetch run from an airport panel: one aerodrome's NOTAMs,
 * put into the loaded briefing (state/aerodromeNotams.ts runs it).
 *
 * Its own record, because a failure belongs to the action that raised it: the
 * NOTAMs tab's buttons report through autorouter.* and sofia.*, and an error
 * this fetch wrote there would show under a button nobody pressed. A leaf
 * module, so notamSource.svelte.ts can read it into notamFetchBusy() without
 * importing the fetch itself. */

import type { ErrorText } from '$lib/i18n/errorText';

export const aerodromeRefresh = $state<{
	/** The ident being fetched, upper case; null when idle. */
	fetching: string | null;
	/** The last attempt's failure, null when it landed or was stopped. */
	error: ErrorText | null;
	/** The wire line behind `error`, EN by policy (docs/i18n.md rule 7), for
	 *  the tooltip; null when the error is the app's own sentence. */
	errorDetail: string | null;
	/** Which aerodrome `error` is about, so only its panel shows it. */
	errorIdent: string | null;
}>({
	fetching: null,
	error: null,
	errorDetail: null,
	errorIdent: null,
});
