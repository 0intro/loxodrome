/* Dismiss-on-Back for transient surfaces (modals, the detail panel, the
 * positioned menus): each open surface pushes one history entry, and popstate
 * (the Android back gesture, the browser Back button) closes the topmost
 * surface instead of leaving the app. Counter-based rather than
 * entry-identity-based, so out-of-order closes and programmatic swaps
 * (one surface evicting another from its workspace slot) stay balanced; the
 * entry payload is never read, only the counts matter.
 *
 * The traces that keep the history depth and the open-surface count in step:
 * - UI close (X / Escape / backdrop / map movestart): release() removes the
 *   closer and consumes its entry with a counted history.back().
 * - User Back: onPop() pre-pushes a replacement entry, then calls the top
 *   closer; the release() from the surface's effect cleanup consumes the
 *   replacement. If the close is vetoed (the aircraft editor's dirty
 *   window.confirm), nothing releases and the replacement keeps the balance.
 * - Reload with entries still in history: the stack is empty, those pops are
 *   swallowed, and each Back consumes one stale entry until the app exits
 *   normally.
 * pushState is always called without a URL, so the location (including
 * ?file=) never changes.
 *
 * What does change is the location our own back() lands ON. pushState snapshots
 * the URL of the moment into the new entry and MapView keeps only the CURRENT
 * entry's #map= in step (writeViewHash replaceStates, never pushes), so the
 * entry underneath holds the map view as it was when the surface opened. Going
 * back to it restored that stale view and the map jumped, on every close of
 * every modal surface. So a release carries the live URL across its own
 * traversal and puts it back. Only OUR pops: a fragment navigation from the
 * address bar fires popstate too (it is a same-document navigation), and there
 * the typed hash is the whole point. */

const stack: (() => void)[] = [];
let selfPops = 0; // popstates that our own history.back() calls will emit
/** One live URL per pending self-pop, oldest first; see release(). */
const selfPopUrls: string[] = [];
let listening = false;

function onPop(): void {
	if (selfPops > 0) {
		selfPops--;
		const url = selfPopUrls.shift();
		if (url !== undefined && url !== location.href) {
			// replaceState fires no event of its own, and the hashchange the
			// traversal already queued reads the location at call time, so the
			// map re-applies the view it is already at.
			history.replaceState(history.state, '', url);
		}
		return;
	}
	const top = stack[stack.length - 1];
	if (!top) {
		return;
	}
	history.pushState({ nv: true }, '');
	top();
}

/**
 * Register an open transient surface. Returns the idempotent release to call
 * once the surface closes by any means; from a Svelte $effect, return it as
 * the cleanup:
 *
 *   $effect(() => {
 *     if (!open) {
 *       return;
 *     }
 *     return registerBackClose(() => close());
 *   });
 */
export function registerBackClose(close: () => void): () => void {
	if (!listening) {
		window.addEventListener('popstate', onPop);
		listening = true;
	}
	history.pushState({ nv: true }, '');
	stack.push(close);
	return () => {
		const i = stack.lastIndexOf(close);
		if (i === -1) {
			return;
		}
		stack.splice(i, 1);
		selfPops++;
		selfPopUrls.push(location.href);
		history.back();
	};
}

/** Close the topmost surface as a user Back would, WITHOUT navigating
 *  history; false when no surface is open. The Android shell's hardware-Back
 *  handler calls this instead of history.back() because the session's
 *  POSITION cannot be trusted there: the documented same-tick drift (a
 *  release's async back() landing after the next surface's push, e.g. the
 *  phone More menu opening About) can strand the session at the base entry,
 *  where a WebView back() is a silent no-op and the modal would never close
 *  (measured on the API 36 emulator). Mirrors onPop: pre-push the
 *  replacement entry, then run the closer, so the release() from the
 *  surface's effect cleanup consumes it and the counts stay balanced
 *  wherever the session sits; a vetoed close leaves the entry, exactly as a
 *  vetoed user Back does. */
export function closeTopBackClose(): boolean {
	const top = stack[stack.length - 1];
	if (!top) {
		return false;
	}
	history.pushState({ nv: true }, '');
	top();
	return true;
}
