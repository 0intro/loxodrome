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
