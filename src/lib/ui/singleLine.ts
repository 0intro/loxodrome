/* A text box that WRAPS on screen but holds ONE line of text: a textarea sized
 * to its content (app.css's `textarea.one-line`, `field-sizing: content`), so
 * a long value shows whole where an input would cut it. A generic sheet's name
 * states its serial range ("Piper PA-28-181 Archer II, s/n 28-8090001 to
 * 28-8690062 and 2890001 to 2890205"), and a read-only box cannot even be
 * scrolled. Enter never puts a line break in the value, and pasted ones become
 * spaces; with `commitOnEnter`, Enter gives up the focus, which fires the
 * box's change the way an input's Enter does. */

export interface SingleLineOptions {
	commitOnEnter?: boolean | undefined;
}

export function singleLine(node: HTMLTextAreaElement, options: SingleLineOptions = {}): { update: (o: SingleLineOptions) => void; destroy: () => void } {
	let commitOnEnter = options.commitOnEnter === true;

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key !== 'Enter' || e.isComposing) {
			return;
		}
		e.preventDefault();
		if (commitOnEnter) {
			node.blur();
		}
	};

	const onPaste = (e: ClipboardEvent): void => {
		const text = e.clipboardData?.getData('text/plain');
		if (text === undefined || !/[\r\n]/.test(text)) {
			return;
		}
		e.preventDefault();
		node.setRangeText(text.replace(/\s*[\r\n]+\s*/g, ' '), node.selectionStart, node.selectionEnd, 'end');
		node.dispatchEvent(new Event('input', { bubbles: true }));
	};

	node.addEventListener('keydown', onKeyDown);
	node.addEventListener('paste', onPaste);
	return {
		update(o: SingleLineOptions): void {
			commitOnEnter = o.commitOnEnter === true;
		},
		destroy(): void {
			node.removeEventListener('keydown', onKeyDown);
			node.removeEventListener('paste', onPaste);
		},
	};
}
