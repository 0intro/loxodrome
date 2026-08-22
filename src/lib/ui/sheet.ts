/* Pointer-capture vertical drag for a bottom sheet: drag a grip to resize the
 * sheet freely between min and max (px). It reports the released height and the
 * release velocity so the caller can rest the sheet anywhere, flick, or snap. A
 * press that never moves past the slop is a tap. Cribs the setPointerCapture +
 * clientY-delta pattern from RouteProfile's leg drag. */

export interface SheetDragOptions {
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
	onTap?: () => void;
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

export function startSheetDrag(e: PointerEvent, opts: SheetDragOptions): void {
	if (dragging) {
		return;
	}
	const el = e.currentTarget as HTMLElement;
	e.preventDefault();
	dragging = true;
	el.setPointerCapture(e.pointerId);
	const startY = e.clientY;
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
