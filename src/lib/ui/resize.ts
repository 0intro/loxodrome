/* Pointer-drag (and keyboard) resizing for the side panels. */

import { readItem, writeItem } from '$lib/state/persist';

export interface ResizeOptions {
	/** +1 if dragging right grows the panel; -1 if dragging right shrinks it. */
	dir: 1 | -1;
	min: number;
	max: number;
}

function clamp(width: number, o: ResizeOptions): number {
	return Math.min(o.max, Math.max(o.min, width));
}

/** Begin a pointer drag that resizes a panel. */
/** One resize at a time; see sheet.ts's dragging flag for why. */
let resizing = false;

export function startResize(
	event: PointerEvent,
	startWidth: number,
	options: ResizeOptions,
	apply: (width: number) => void,
	commit: (width: number) => void,
): void {
	if (resizing) {
		return;
	}
	resizing = true;
	event.preventDefault();
	const startX = event.clientX;
	// The pointer this drag belongs to: the listeners sit on the window, so
	// without it a SECOND finger's release commits the first one's drag, at
	// whatever width the first had reached, and its own move steers it.
	const id = event.pointerId;
	let width = startWidth;
	document.body.style.userSelect = 'none';
	document.body.style.cursor = 'col-resize';

	const onMove = (e: PointerEvent): void => {
		if (e.pointerId !== id) {
			return;
		}
		width = clamp(startWidth + options.dir * (e.clientX - startX), options);
		apply(width);
	};
	const grip = event.currentTarget instanceof Element ? event.currentTarget : null;
	const detach = (): void => {
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onUp);
		grip?.removeEventListener('lostpointercapture', onLost as EventListener);
	};
	const onUp = (e: PointerEvent): void => {
		if (e.pointerId !== id || !resizing) {
			return;
		}
		resizing = false;
		detach();
		document.body.style.userSelect = '';
		document.body.style.cursor = '';
		commit(width);
	};
	/* Filtering by pointer took away the old self-healing, where ANY release
	 * settled the drag: a touch whose release is never delivered would leave
	 * `resizing` set and every handle in the app dead, the body stuck under
	 * `user-select: none`. Capture is what makes the release come back, and
	 * losing it is the other way this ends (ui/sheet.ts states the same
	 * rule for the sheet drag). */
	const onLost = (e: PointerEvent): void => {
		if (e.pointerId !== id || !resizing) {
			return;
		}
		resizing = false;
		detach();
		document.body.style.userSelect = '';
		document.body.style.cursor = '';
		commit(width);
	};
	try {
		grip?.setPointerCapture(id);
	} catch {
		/* a pointer the browser no longer holds: the window listeners below
		 * still run the drag, they just cannot follow the finger off the
		 * handle */
	}
	grip?.addEventListener('lostpointercapture', onLost as EventListener);
	window.addEventListener('pointermove', onMove);
	window.addEventListener('pointerup', onUp);
	// A cancelled touch drag (browser gesture takeover) must also settle,
	// or the listeners leak and the body cursor / userSelect stay stuck.
	window.addEventListener('pointercancel', onUp);
}

/** Arrow-key nudge for a resize handle; returns the new width, or null. */
export function nudgeResize(
	event: KeyboardEvent,
	width: number,
	options: ResizeOptions,
): number | null {
	const step = 16;
	let next: number;
	if (event.key === 'ArrowRight') {
		next = width + step * options.dir;
	} else if (event.key === 'ArrowLeft') {
		next = width - step * options.dir;
	} else {
		return null;
	}
	event.preventDefault();
	return clamp(next, options);
}

export function loadPanelWidth(key: string, fallback: number): number {
	const v = parseInt(readItem(key) ?? '', 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function savePanelWidth(key: string, width: number): void {
	writeItem(key, String(Math.round(width)));
}
