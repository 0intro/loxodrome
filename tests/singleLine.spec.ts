/* A box that wraps on screen but holds one line of text ($lib/ui/singleLine):
 * a generic sheet's name states its serial range and must show whole, even in
 * a read-only box that cannot be scrolled, so the name is a textarea sized to
 * its content. Its value must still never take a line break: Enter adds none
 * (and, where the box commits on change like an input, gives up the focus,
 * which fires that change), and pasted line breaks become spaces. Driven
 * through a stand-in for the element, the node project having no DOM. */

import { describe, expect, it, vi } from 'vitest';
import { singleLine } from '$lib/ui/singleLine';

function box(value: string) {
	const listeners: Record<string, (e: unknown) => void> = {};
	const node = {
		value,
		selectionStart: value.length,
		selectionEnd: value.length,
		addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
		removeEventListener: (type: string) => delete listeners[type],
		blur: vi.fn(),
		dispatchEvent: vi.fn(),
		setRangeText(text: string, start: number, end: number) {
			node.value = node.value.slice(0, start) + text + node.value.slice(end);
		},
	};
	return { node, listeners };
}

const key = (k: string, isComposing = false) => ({ key: k, isComposing, preventDefault: vi.fn() });
const paste = (text: string) => ({ clipboardData: { getData: () => text }, preventDefault: vi.fn() });

describe('a wrapping box holding one line', () => {
	it('adds no line break on Enter, and commits only where asked to', () => {
		const plain = box('Cessna 172S');
		singleLine(plain.node as unknown as HTMLTextAreaElement);
		const enter = key('Enter');
		plain.listeners.keydown(enter);
		expect(enter.preventDefault).toHaveBeenCalled();
		expect(plain.node.blur).not.toHaveBeenCalled();

		const card = box('Cessna 172S');
		singleLine(card.node as unknown as HTMLTextAreaElement, { commitOnEnter: true });
		card.listeners.keydown(key('Enter'));
		expect(card.node.blur).toHaveBeenCalledOnce();
	});

	it('leaves other keys and an IME composition alone', () => {
		const { node, listeners } = box('C');
		singleLine(node as unknown as HTMLTextAreaElement, { commitOnEnter: true });
		const letter = key('a');
		listeners.keydown(letter);
		const composing = key('Enter', true);
		listeners.keydown(composing);
		expect(letter.preventDefault).not.toHaveBeenCalled();
		expect(composing.preventDefault).not.toHaveBeenCalled();
		expect(node.blur).not.toHaveBeenCalled();
	});

	it('turns pasted line breaks into spaces and says so to the binding', () => {
		const { node, listeners } = box('Piper ');
		singleLine(node as unknown as HTMLTextAreaElement);
		const e = paste('PA-28-181 Archer II,\r\n  s/n 28-8090001\nand on');
		listeners.paste(e);
		expect(e.preventDefault).toHaveBeenCalled();
		expect(node.value).toBe('Piper PA-28-181 Archer II, s/n 28-8090001 and on');
		expect(node.dispatchEvent).toHaveBeenCalledOnce();
	});

	it('lets a paste without line breaks through untouched', () => {
		const { node, listeners } = box('F-');
		singleLine(node as unknown as HTMLTextAreaElement);
		const e = paste('GORQ');
		listeners.paste(e);
		expect(e.preventDefault).not.toHaveBeenCalled();
		expect(node.value).toBe('F-');
	});

	it('follows a change of option and lets go of the element', () => {
		const { node, listeners } = box('C');
		const action = singleLine(node as unknown as HTMLTextAreaElement);
		action.update({ commitOnEnter: true });
		listeners.keydown(key('Enter'));
		expect(node.blur).toHaveBeenCalledOnce();
		action.destroy();
		expect(Object.keys(listeners)).toEqual([]);
	});
});
