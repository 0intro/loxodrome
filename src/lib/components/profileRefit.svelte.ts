/* When the route profile's altitude window follows an edit to the planned
 * levels, and when it holds still (docs/route-profile.md "Window: zoom,
 * pan, persistence"). WHERE it goes is pure (reopenAltWindow in
 * route/routeProfile.ts: where closing and reopening the profile would put
 * it); this module is the WHEN, which is where the traps are:
 *
 * - SETTLED. The Route tab commits a level on every keystroke, so typing
 *   6500 over 4500 passes through 6, 65 and 650 ft. The refit waits until
 *   the edits have held still for REFIT_SETTLE_MS, and runs once.
 * - HELD while a leg is held on the chart. A refit under the pointer pins
 *   the dragged leg at 3/4 of the height while the axis runs away beneath
 *   it, which is why the fit used to be read untracked altogether. At the
 *   release it runs at once, so a leg dragged to the top of the window
 *   finds room above it.
 * - GATED on the caller's `ready`, nothing else tracked while it is false. */

import { untrack } from 'svelte';

/** Longer than the gap between two keys of a number being typed, short
 *  enough to read as the chart settling after a badge click or a nudge. */
export const REFIT_SETTLE_MS = 400;

export interface SettledRefitSource {
	/** What counts as an edit: read (tracked) on every run outside a hold. */
	changes: () => unknown;
	/** A leg is held on the chart (the sink useHoldReport writes). */
	held: () => boolean;
	/** The refit may run at all. */
	ready: () => boolean;
	/** Apply it. It runs from a timer, so its reads are untracked and
	 *  current, and its writes cannot re-enter the effect. */
	refit: () => void;
}

/** Run `refit` once the edits settle, never while a hold lasts, and at once
 *  when it ends. Call during component init (the $effect needs its
 *  context). */
export function useSettledRefit(src: SettledRefitSource): void {
	// Plain let: the release edge, read and written by the effect alone.
	let wasHeld = false;
	$effect(() => {
		if (!src.ready()) {
			wasHeld = false;
			return;
		}
		// The hold first, and nothing else read while it lasts: a drag moves
		// the levels on every pointer move, and none of them may re-run this.
		const held = src.held();
		const released = wasHeld && !held;
		wasHeld = held;
		if (held) {
			return;
		}
		void src.changes();
		const timer = setTimeout(src.refit, released ? 0 : REFIT_SETTLE_MS);
		return () => clearTimeout(timer);
	});
}

/** Report a hold to its owner: true when it starts, false when it ends.
 *  The end is the effect's teardown, so no way out of a hold can skip it:
 *  the release, a cancel, a lost capture, and the component unmounting
 *  under a held pointer (a surface closed by Back or Escape mid-drag), which
 *  fires no pointerup at all. Teardowns run outside any reaction, so the
 *  write is legal there; the start is reported untracked, so a sink that
 *  also READ its state could not subscribe this effect to its own writes.
 *  Call during component init. */
export function useHoldReport(held: () => boolean, sink: () => ((held: boolean) => void) | undefined): void {
	$effect(() => {
		const report = sink();
		if (!report || !held()) {
			return;
		}
		untrack(() => report(true));
		return () => report(false);
	});
}
