/* Reactive status for the SOFIA-Briefing route fetch. Unlike autorouter,
 * SOFIA NOTAM consultation is anonymous, so there are no credentials to hold
 * or persist; only the transient fetch status lives here. The proxy URL is
 * shared with autorouter (`proxyBase()` in `autorouter/state.svelte.ts`), the
 * same worker serving the `/sofia` route. */

import type { ErrorText } from '$lib/i18n/errorText';
export const sofia = $state<{
	fetching: boolean;
	/** A briefing that produced nothing to show: the pre-flight guards (no
	 *  proxy configured, no route drawn) and a fetch every route failed. A
	 *  briefing that did land, with some routes missing, is not an error and
	 *  rides notamState.gaps instead, so it survives leaving this view. */
	error: ErrorText | null;
	/** The wire line behind `error` when it came from the network, for the
	 *  tooltip beside it; null for the guards, which are already plain. */
	errorDetail: string | null;
	/** How far a running briefing has got: routes settled out of routes
	 *  asked for. One POST per route against a service that can take tens of
	 *  seconds, so a six-route briefing needs to say where it is. Null while
	 *  no briefing is running. */
	progress: { done: number; total: number } | null;
}>({
	fetching: false,
	error: null,
	errorDetail: null,
	progress: null,
});
