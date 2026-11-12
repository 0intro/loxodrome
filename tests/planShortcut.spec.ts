/* What Ctrl/Cmd+S does (state/planShortcut.ts): it saves the flight plan,
 * cancels the browser's Save Page whenever it is the chord, and saves
 * nothing for a key held down or while a question stands. */

import { describe, expect, it } from 'vitest';
import { saveKey, type KeyLike } from '$lib/state/planShortcut';

const key = (k: Partial<KeyLike>): KeyLike => ({
	key: 's',
	ctrlKey: false,
	metaKey: false,
	altKey: false,
	shiftKey: false,
	repeat: false,
	...k,
});

describe('Ctrl/Cmd+S', () => {
	it('saves on Ctrl+S and on Cmd+S, caps lock or not', () => {
		expect(saveKey(key({ ctrlKey: true }), false)).toBe('save');
		expect(saveKey(key({ metaKey: true }), false)).toBe('save');
		expect(saveKey(key({ ctrlKey: true, key: 'S' }), false)).toBe('save');
	});

	it('leaves every other key and chord alone', () => {
		expect(saveKey(key({}), false)).toBe('pass');
		expect(saveKey(key({ ctrlKey: true, key: 'd' }), false)).toBe('pass');
		expect(saveKey(key({ ctrlKey: true, shiftKey: true, key: 'S' }), false)).toBe('pass');
		// AltGr arrives as Ctrl+Alt on Windows layouts.
		expect(saveKey(key({ ctrlKey: true, altKey: true }), false)).toBe('pass');
	});

	it('holds a key held down and a standing question, cancelling the Save Page', () => {
		expect(saveKey(key({ ctrlKey: true, repeat: true }), false)).toBe('hold');
		expect(saveKey(key({ ctrlKey: true }), true)).toBe('hold');
	});
});
