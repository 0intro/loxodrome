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
	let width = startWidth;
	document.body.style.userSelect = 'none';
	document.body.style.cursor = 'col-resize';

	const onMove = (e: PointerEvent): void => {
		width = clamp(startWidth + options.dir * (e.clientX - startX), options);
		apply(width);
	};
	const onUp = (): void => {
		resizing = false;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
		window.removeEventListener('pointercancel', onUp);
		document.body.style.userSelect = '';
		document.body.style.cursor = '';
		commit(width);
	};
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
