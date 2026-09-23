/* A backdrop dismissed on the pointer's DOWN, so a right-click elsewhere on
 * the map closes one menu and opens the next where it landed (the backdrop is
 * gone before the contextmenu event). For a MOUSE that is the whole story: its
 * click goes to the common ancestor of the down and the up, and the down's
 * target, the backdrop, is gone, so the click reaches nothing.
 *
 * A TOUCH (or a pen) goes on after its down, and what it goes on to do is
 * hit-tested where the finger is, by which time the backdrop has gone:
 *
 * - Its compatibility mousedown focused a field beneath (a phone's keyboard
 *   coming up) and moved a slider (the radar scrub, the replay slider, the
 *   night-dim one under a dialog), measured with genuine touch input in
 *   Chromium. Cancelling the down suppresses those compatibility events.
 * - Its click, which cancelling the down does NOT suppress (Pointer Events,
 *   "compatibility mapping"), landed on the head button that opened a menu
 *   (the dismissing tap reopened it), the profile column under a filter, the
 *   control under a dialog. That one click is swallowed, armed at the
 *   pointer's own RELEASE, which is what synthesises it (ui/sheet.ts
 *   suppressNextClick, whose window a fresh press stands down). Armed at the
 *   press instead, a press held past the window clicked through, and a swipe
 *   or a pen, which synthesise no click, left the window armed to eat the
 *   next deliberate one. A cancelled pointer synthesises no click and arms
 *   nothing.
 *
 * Plain .ts, no state. */

import { suppressNextClick } from './sheet';

/** A press held this long is no tap: its release listeners go, so a later
 *  pointer carrying the same id cannot arm a swallow nobody owes. */
const RELEASE_WAIT_MS = 30_000;

/** What a non-mouse press on a vanishing backdrop owes the page beneath: its
 *  compatibility mouse events cancelled now, its click swallowed once it is
 *  released. A mouse's press is left alone (its click reaches nothing). */
export function swallowFollowingClick(e: PointerEvent): void {
	if (e.pointerType === 'mouse') {
		return;
	}
	e.preventDefault();
	const id = e.pointerId;
	// The options OBJECT, not a bare `true`: Node's EventTarget (the suite's
	// stand-in) removes nothing given the boolean, and the browser takes both.
	const capture = { capture: true };
	const done = (): void => {
		window.removeEventListener('pointerup', settle, capture);
		window.removeEventListener('pointercancel', settle, capture);
		clearTimeout(timer);
	};
	function settle(ev: PointerEvent): void {
		if (ev.pointerId !== id) {
			return;
		}
		done();
		if (ev.type === 'pointerup') {
			suppressNextClick();
		}
	}
	window.addEventListener('pointerup', settle, capture);
	window.addEventListener('pointercancel', settle, capture);
	const timer = setTimeout(done, RELEASE_WAIT_MS);
}

/** A backdrop's pointerdown handler: `close`, then settle a touch's press. */
export function dismissOnDown(close: () => void): (e: PointerEvent) => void {
	return (e: PointerEvent): void => {
		close();
		swallowFollowingClick(e);
	};
}
