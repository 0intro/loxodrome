/* One pointer drag that reorders a list: a Svelte action on each HANDLE (a
 * strip's tab, a list's number disc), the order itself kept by the caller.
 * A mouse lifts the handle once it moves a few pixels with the button held,
 * so a click and a double-click stay what they were. A finger or a pen
 * lifts it after a press held still for the app's long press, with the
 * hold's haptic tick: a press that moves first is the list's own scroll.
 * While lifted, the handle owns the pointer, the scroller scrolls itself
 * near its ends, and a touchmove listener keeps the browser from panning;
 * that listener is there from the start, since a touch sequence can be
 * cancelled only when a blocking listener stood under it as it began. The
 * release drops and its click is swallowed, so the dropped handle is not
 * activated. Escape, a cancel, a lost capture or the window losing the
 * focus end the drag with no drop, and so does a new press: a release can
 * go unseen (measured on the Redmi, an injected one the system dropped),
 * and the handle must not stay deaf to every press after it. */

import { holdTick } from './haptics';
import { LONG_PRESS_MS } from './longPress';
import { suppressNextClick } from './sheet';

/** Mouse travel (px) before a held button lifts the handle. */
export const MOUSE_SLOP = 5;
/** Finger travel (px) that tells a scroll from a hold. */
export const HOLD_SLOP = 10;
/** The scroller's hot zone at either end (px), and its top speed (px a
 *  frame), the ramp the route strip's edge scroll always had. */
const EDGE_PX = 44;
const EDGE_SPEED = 16;

export interface DragHandleOptions {
	axis: 'x' | 'y';
	/** Whether this handle may lift now. */
	enabled: () => boolean;
	/** The element that scrolls the list, auto-scrolled near its ends. */
	scroller: () => HTMLElement | null | undefined;
	onLift: () => void;
	/** The pointer moved, or the list scrolled under it (client px). */
	onMove: (x: number, y: number) => void;
	/** Released while lifted. */
	onDrop: () => void;
	/** Ended with no drop. */
	onCancel: () => void;
}

export function dragHandle(
	node: HTMLElement,
	options: DragHandleOptions,
): { update: (next: DragHandleOptions) => void; destroy: () => void } {
	let o = options;
	let pointerId: number | null = null;
	let touch = false;
	let startX = 0;
	let startY = 0;
	let x = 0;
	let y = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let frame: number | null = null;
	let lifted = false;

	function stop(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
	}

	/* The speed ramps up from the hot zone's inner edge to the scroller's. */
	function scrollStep(): void {
		frame = null;
		const el = o.scroller();
		if (!lifted || !el) {
			return;
		}
		const r = el.getBoundingClientRect();
		const at = o.axis === 'x' ? x : y;
		const lo = o.axis === 'x' ? r.left : r.top;
		const hi = o.axis === 'x' ? r.right : r.bottom;
		const edge = Math.min(EDGE_PX, (hi - lo) / 3);
		const ramp = (d: number): number => EDGE_SPEED * Math.min(1, Math.max(0, 1 - d / edge));
		const v = at < lo + edge ? -ramp(at - lo) : at > hi - edge ? ramp(hi - at) : 0;
		if (v !== 0) {
			if (o.axis === 'x') {
				el.scrollLeft += v;
			} else {
				el.scrollTop += v;
			}
			o.onMove(x, y);
		}
		frame = requestAnimationFrame(scrollStep);
	}

	function lift(): void {
		stop();
		lifted = true;
		if (touch) {
			holdTick();
		}
		o.onLift();
		o.onMove(x, y);
		frame = requestAnimationFrame(scrollStep);
	}

	/** The press is over: dropped when `drop` and lifted. */
	function end(drop: boolean): void {
		stop();
		const was = lifted;
		lifted = false;
		pointerId = null;
		if (!was) {
			return;
		}
		if (drop) {
			suppressNextClick();
			o.onDrop();
		} else {
			o.onCancel();
		}
	}

	function down(e: PointerEvent): void {
		if (!e.isPrimary || !o.enabled()) {
			return;
		}
		// A primary press starts a new gesture: the last one ended unseen.
		end(false);
		if (e.pointerType === 'mouse' && e.button !== 0) {
			return;
		}
		pointerId = e.pointerId;
		touch = e.pointerType !== 'mouse';
		startX = x = e.clientX;
		startY = y = e.clientY;
		if (touch) {
			timer = setTimeout(lift, LONG_PRESS_MS);
		} else {
			// A finger's press holds its capture already; a mouse's release
			// must come back here wherever it lands.
			node.setPointerCapture(e.pointerId);
		}
	}

	function move(e: PointerEvent): void {
		if (e.pointerId !== pointerId) {
			return;
		}
		x = e.clientX;
		y = e.clientY;
		if (lifted) {
			o.onMove(x, y);
			return;
		}
		const d = Math.hypot(x - startX, y - startY);
		if (!touch && d > MOUSE_SLOP) {
			lift();
		} else if (touch && d > HOLD_SLOP) {
			end(false);
		}
	}

	function up(e: PointerEvent): void {
		if (e.pointerId === pointerId) {
			end(true);
		}
	}

	function cancel(e: PointerEvent): void {
		if (e.pointerId === pointerId) {
			end(false);
		}
	}

	/* A pressed child's own capture bubbles its loss here: only the
	 * handle's counts. */
	function lost(e: PointerEvent): void {
		if (e.target === node && e.pointerId === pointerId) {
			end(false);
		}
	}

	function touchMove(e: TouchEvent): void {
		if (lifted) {
			e.preventDefault();
		}
	}

	function context(e: Event): void {
		if (pointerId !== null) {
			e.preventDefault();
		}
	}

	function key(e: KeyboardEvent): void {
		if (lifted && e.key === 'Escape') {
			e.preventDefault();
			end(false);
		}
	}

	function blur(): void {
		end(false);
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	node.addEventListener('lostpointercapture', lost);
	node.addEventListener('touchmove', touchMove, { passive: false });
	node.addEventListener('contextmenu', context);
	window.addEventListener('keydown', key);
	window.addEventListener('blur', blur);
	return {
		update(next) {
			o = next;
		},
		destroy() {
			end(false);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
			node.removeEventListener('lostpointercapture', lost);
			node.removeEventListener('touchmove', touchMove);
			node.removeEventListener('contextmenu', context);
			window.removeEventListener('keydown', key);
			window.removeEventListener('blur', blur);
		},
	};
}
