/** True when the event target consumes its own arrow/character keys (text field,
 *  select, contenteditable, or ARIA slider). Used to suppress modal keyboard
 *  shortcuts while the user is typing or dragging a slider with the keyboard. */
export function isEditableTarget(el: EventTarget | null): boolean {
	const t = el as HTMLElement | null;
	return (
		!!t &&
		(t.tagName === 'INPUT' ||
			t.tagName === 'TEXTAREA' ||
			t.tagName === 'SELECT' ||
			t.isContentEditable ||
			t.getAttribute('role') === 'slider')
	);
}

/** Step on a bare Left or Right arrow, for the steppers listening on the
 *  window: the nav log's and the route profile's route, the detail panel's
 *  NOTAM. The window hears a key after every element handler, so a key a
 *  focused control already used (the chart's pan, the route strip's own
 *  step), one with a modifier held and one typed into an editable target
 *  step nothing. `step` says whether it moved, and a move marks the key
 *  used, so the next stepper on the window skips it: one press, one step. */
export function stepOnArrow(e: KeyboardEvent, step: (delta: -1 | 1) => boolean): void {
	if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || isEditableTarget(e.target)) {
		return;
	}
	const delta = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
	if (delta !== 0 && step(delta)) {
		e.preventDefault();
	}
}
