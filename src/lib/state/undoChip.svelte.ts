/* undoChip.svelte.ts: the map's offer to undo the route edit it has just
 * made. A waypoint moved, added, inserted or removed on the map (a pin
 * dropped, a menu row, the Delete key) raises a chip at the foot of the map
 * naming the edit, with an Undo button, for a few seconds: the undo history
 * was a keyboard shortcut and two buttons in the Route tab, a page away on a
 * phone, and a pin moved by a stray finger was the edit most in need of it.
 *
 * The chip undoes ITS edit or nothing. It holds the history serial its edit
 * left (route.svelte.ts `routeHistory.serial`) and stands only while the
 * serial has not moved, so any later step, an undo or a redo from anywhere
 * takes it down, and a tap on Undo that lands just as another edit arrives
 * undoes nothing rather than that one. An edit that recorded no step (a
 * mutator that found nothing to do) raises no chip at all, since the one it
 * would stand over is an older edit.
 *
 * The countdown pauses while the pointer or the focus is on the chip, the
 * way a reader holds a notice, and starts again from the top when they
 * leave. Memory only: an offer does not outlive the session, nor the next
 * edit. */

import { routeHistory, undoRoute } from './route.svelte';

/** What the edit did, which the chip says. */
export type UndoChipKind = 'moved' | 'added' | 'inserted' | 'removed';

/** How long an offer stands while nothing holds it. */
export const UNDO_CHIP_MS = 6000;

export const undoChip = $state<{ kind: UndoChipKind | null; serial: number }>({
	kind: null,
	serial: -1,
});

let timer: ReturnType<typeof setTimeout> | null = null;
/** The pointer or the focus is on the chip: the countdown waits. */
let held = false;

function clearTimer(): void {
	if (timer !== null) {
		clearTimeout(timer);
		timer = null;
	}
}

function arm(): void {
	clearTimer();
	timer = setTimeout(() => {
		timer = null;
		undoChip.kind = null;
	}, UNDO_CHIP_MS);
}

/** Make a route edit on the map's behalf and offer to undo it. The chip is
 *  raised only when the edit moved the history; the edit's own result is
 *  handed back. */
export function offerUndoFor<T>(kind: UndoChipKind, edit: () => T): T {
	const before = routeHistory.serial;
	const out = edit();
	if (routeHistory.serial !== before) {
		undoChip.kind = kind;
		undoChip.serial = routeHistory.serial;
		// A fresh offer starts a fresh countdown: a hold left by a chip the
		// DOM took away under the pointer (no mouseleave fires then) must not
		// keep this one up for good.
		held = false;
		arm();
	}
	return out;
}

/** The chip stands: offered, and its edit is still the history's top. */
export function undoChipShown(): boolean {
	return undoChip.kind !== null && undoChip.serial === routeHistory.serial;
}

/** The chip's button: undo its edit if it still stands, and go. */
export function takeUndo(): void {
	if (undoChipShown()) {
		undoRoute();
	}
	dismissUndo();
}

/** Take the chip down without undoing anything. */
export function dismissUndo(): void {
	clearTimer();
	undoChip.kind = null;
}

/** The pointer or the focus came onto the chip (true) or left it (false). */
export function holdUndoChip(on: boolean): void {
	if (held === on) {
		return;
	}
	held = on;
	if (on) {
		clearTimer();
	} else if (undoChip.kind !== null) {
		arm();
	}
}

/** Specs only: no offer, no timer, no hold. */
export function resetUndoChipForTest(): void {
	clearTimer();
	held = false;
	undoChip.kind = null;
	undoChip.serial = -1;
}
