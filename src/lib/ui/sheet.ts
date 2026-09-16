/* Pointer-capture vertical drag for a bottom sheet: drag a grip to resize the
 * sheet freely between min and max (px). It reports the released height and the
 * release velocity so the caller can rest the sheet anywhere, flick, or snap. A
 * press that never moves past the slop is a tap. Cribs the setPointerCapture +
 * clientY-delta pattern from RouteProfile's leg drag. */

export interface SheetDragOptions {
	/** Where the gesture really began, when the caller armed it on an
	 *  earlier event and is only now handing the pointer over (the pane
	 *  head's drag, which waits for the slop so an un-moved press still
	 *  clicks the control under it). Without it the surface would jump by
	 *  the slop at the moment the drag takes over. */
	startY?: number;
	/** Sheet height (px) at drag start. */
	startHeight: number;
	/** Clamp range (px). */
	min: number;
	max: number;
	/** Live height (px) during the drag, with the travel so far so a caller
	 *  can hold off a commitment until the press is definitely a drag: onMove
	 *  fires from the first pointermove, but onRelease only past TAP_SLOP. */
	onMove: (heightPx: number, movedPx: number) => void;
	/** Released height (px) and velocity (px/ms, positive = dragging up). */
	onRelease: (heightPx: number, velocity: number) => void;
	/** A press that never moved past the slop (a tap on the grip). */
	onTap?: (() => void) | undefined;
}

/** px of travel below which a press counts as a tap. */
export const TAP_SLOP = 6;

/* Shared release thresholds, so the sidebar sheet and the detail sheet feel
 * identical: a release below MIN_OPEN_FRAC of the workspace collapses /
 * dismisses, and a flick faster than FLICK px/ms jumps straight to full
 * (upward) or collapses / dismisses (downward) regardless of height. */
export const MIN_OPEN_FRAC = 0.2;
export const FLICK = 0.6;

/** True while a drag is running, so a second pointer cannot start another:
 *  both would receive both pointers' moves, and both would fire on the first
 *  release, which for a surface grip means two conflicting placement writes. */
let dragging = false;

/* A touch tap fires pointerdown, pointerup and THEN a compatibility click,
 * and the browser hit-tests that click against the layout as it stands when
 * it fires, not as it stood under the finger. A grip gesture's whole job is
 * to change that layout, so the click lands on whatever moved underneath:
 * measured on the Redmi, one tap on the profile pane's handle grew the pane
 * to its page detent and the click that followed selected the airspace band
 * now under the same pixel, whose detail then evicted the profile from the
 * pane. `preventDefault()` on the pointerdown suppresses the compatibility
 * MOUSE events but not the click (Pointer Events, "compatibility mapping"),
 * so the click is swallowed here instead, once, in the capture phase, for as
 * long as a synthesised one can take to arrive. The same rule the swipe-down
 * dismissal already applies to the row under a dismissed sheet. */
const CLICK_SUPPRESS_MS = 700;
let suppressClickUntil = 0;

function swallowStrayClick(e: MouseEvent): void {
	if (performance.now() >= suppressClickUntil) {
		return;
	}
	suppressClickUntil = 0;
	e.preventDefault();
	e.stopPropagation();
}

/** Swallow the one click a finished touch gesture is about to synthesise.
 *  Installed once, on the document, in the capture phase so it runs before
 *  anything the click would otherwise reach. */
export function suppressNextClick(ms: number = CLICK_SUPPRESS_MS): void {
	if (typeof document === 'undefined') {
		return;
	}
	if (suppressClickUntil === 0) {
		document.addEventListener('click', swallowStrayClick, true);
	}
	suppressClickUntil = performance.now() + ms;
}

export function startSheetDrag(e: PointerEvent, opts: SheetDragOptions): void {
	if (dragging) {
		return;
	}
	const el = e.currentTarget as HTMLElement;
	e.preventDefault();
	dragging = true;
	try {
		el.setPointerCapture(e.pointerId);
	} catch {
		/* a pointer the browser no longer holds (a synthetic event, a
		 * release that landed first): the drag still runs on the element's
		 * own listeners, it just cannot follow the finger off it */
	}
	const startY = opts.startY ?? e.clientY;
	let height = opts.startHeight;
	let moved = 0;
	let prevY = startY;
	let prevT = performance.now();
	let velocity = 0; // px/ms, positive = dragging up (growing)

	function move(ev: PointerEvent): void {
		if (ev.pointerId !== e.pointerId) {
			return;
		}
		height = Math.max(opts.min, Math.min(opts.max, opts.startHeight + (startY - ev.clientY)));
		moved = Math.max(moved, Math.abs(ev.clientY - startY));
		const now = performance.now();
		const dt = now - prevT;
		if (dt > 0) {
			velocity = (prevY - ev.clientY) / dt;
		}
		prevY = ev.clientY;
		prevT = now;
		opts.onMove(height, moved);
	}

	function end(ev: PointerEvent): void {
		if (ev.pointerId !== e.pointerId) {
			return;
		}
		dragging = false;
		el.releasePointerCapture?.(ev.pointerId);
		el.removeEventListener('pointermove', move);
		el.removeEventListener('pointerup', end);
		el.removeEventListener('pointercancel', end);
		// Both branches move the surface, so both have to swallow the click
		// the finger is about to land on whatever took its place.
		if (ev.pointerType !== 'mouse') {
			suppressNextClick();
		}
		if (moved < TAP_SLOP) {
			opts.onTap?.();
			return;
		}
		opts.onRelease(height, velocity);
	}

	el.addEventListener('pointermove', move);
	el.addEventListener('pointerup', end);
	el.addEventListener('pointercancel', end);
}

/* ---- swipe-down to dismiss ----------------------------------------------
 *
 * Every phone sheet (the layers sheet, the long-press menu, the app menu,
 * HeadOverlay's rendition) closes on a downward swipe as well as on its X
 * and the system Back: the gesture every bottom sheet on the platform
 * answers. The drag is TOUCH events on purpose: a pointer drag over a
 * scrollable body is cancelled by the browser the moment it takes the
 * gesture for a scroll, and `touch-action: none` would kill the body's own
 * scrolling. A non-passive touchmove can refuse the scroll instead, and does
 * so only once the swipe is committed: downward, past the slop, from a body
 * scrolled to its top. Above that slop the sheet follows the finger; released
 * short of the threshold it springs back; a real drag suppresses the click
 * the same finger would otherwise land on a row. */

/** Travel below which a touch is not a swipe (a tap, a scroll's first pixels). */
export const SWIPE_SLOP = 24;
/** Travel past which a release dismisses whatever the speed. */
export const DISMISS_PX = 80;

/** Whether a released downward swipe dismisses: past DISMISS_PX, or past the
 *  slop and flicked (velocity in px/ms, positive downward). Pure; pinned by
 *  tests/sheetSwipe.spec.ts. */
export function swipeDismisses(dyPx: number, velocity: number): boolean {
	if (dyPx < SWIPE_SLOP) {
		return false;
	}
	return dyPx >= DISMISS_PX || velocity >= FLICK;
}

/** Svelte action: `use:swipeDismiss={onClose}` on a sheet's box. The
 *  scrollable body is found from the touch target (`[data-sheet-scroll]`, or
 *  HeadOverlay's `.sheet-body`); a body scrolled below its top keeps the
 *  gesture for scrolling. */
export function swipeDismiss(
	node: HTMLElement,
	onClose: () => void,
): { update: (next: () => void) => void; destroy: () => void } {
	let close = onClose;
	let startY = 0;
	let prevY = 0;
	let prevT = 0;
	let velocity = 0;
	let armed = false;
	let dragging = false;
	let suppressUntil = 0;

	function scrollerOf(target: EventTarget | null): HTMLElement | null {
		const el = target instanceof Element ? target.closest<HTMLElement>('[data-sheet-scroll], .sheet-body') : null;
		return el && node.contains(el) ? el : null;
	}

	function onStart(e: TouchEvent): void {
		if (e.touches.length !== 1) {
			armed = false;
			return;
		}
		const t = e.touches[0];
		startY = prevY = t.clientY;
		prevT = performance.now();
		velocity = 0;
		dragging = false;
		armed = (scrollerOf(e.target)?.scrollTop ?? 0) <= 0;
	}

	function onMove(e: TouchEvent): void {
		if (!armed || e.touches.length !== 1) {
			return;
		}
		const t = e.touches[0];
		const dy = t.clientY - startY;
		if (!dragging) {
			if (dy > SWIPE_SLOP) {
				dragging = true;
				node.classList.add('swiping');
			} else if (dy < -SWIPE_SLOP) {
				armed = false; // an upward scroll: the body's
				return;
			} else {
				return;
			}
		}
		e.preventDefault();
		const now = performance.now();
		if (now > prevT) {
			velocity = (t.clientY - prevY) / (now - prevT);
		}
		prevY = t.clientY;
		prevT = now;
		node.style.transform = `translateY(${Math.max(0, dy)}px)`;
	}

	function onEnd(): void {
		if (!dragging) {
			armed = false;
			return;
		}
		dragging = false;
		armed = false;
		node.classList.remove('swiping');
		node.style.transform = '';
		const dy = prevY - startY;
		if (swipeDismisses(dy, velocity)) {
			suppressUntil = performance.now() + 300;
			close();
		}
	}

	function onClick(e: MouseEvent): void {
		if (performance.now() < suppressUntil) {
			e.preventDefault();
			e.stopPropagation();
		}
	}

	node.addEventListener('touchstart', onStart, { passive: true });
	node.addEventListener('touchmove', onMove, { passive: false });
	node.addEventListener('touchend', onEnd);
	node.addEventListener('touchcancel', onEnd);
	node.addEventListener('click', onClick, true);
	return {
		update(next) {
			close = next;
		},
		destroy() {
			node.removeEventListener('touchstart', onStart);
			node.removeEventListener('touchmove', onMove);
			node.removeEventListener('touchend', onEnd);
			node.removeEventListener('touchcancel', onEnd);
			node.removeEventListener('click', onClick, true);
		},
	};
}
