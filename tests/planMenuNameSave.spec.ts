/* Ctrl/Cmd+S from the plan menu's name box saves the plan under the name
 * typed there. PlanHost's window listener blurs the focused box before it
 * saves, and that blur carries no related target, which the box reads as a
 * dismissal: the draft stayed uncommitted and the plan was saved without
 * it. The box commits on the key itself, its handler running before the
 * window's, and leaves the save and the browser's Save Page to the window.
 * The box's own handler runs here (tests/helpers/componentCode.ts) with the
 * real shortcut decision (state/planShortcut.ts). */

import { describe, expect, it, vi } from 'vitest';
import { saveKey } from '$lib/state/planShortcut';
import { componentCode, run } from './helpers/componentCode';

const menu = componentCode('src/lib/components/PlanMenu.svelte');

interface Key {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat: boolean;
	preventDefault: ReturnType<typeof vi.fn>;
}

function press(key: string, mods: Partial<Omit<Key, 'key' | 'preventDefault'>> = {}): Key {
	return {
		key,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		repeat: false,
		...mods,
		preventDefault: vi.fn(),
	};
}

/** The name box's keydown, over a spy for the commit. */
function nameBox(): { keydown: (e: Key) => void; commitName: ReturnType<typeof vi.fn> } {
	const commitName = vi.fn();
	const keydown = run<(e: Key) => void>({ commitName, saveKey }, `return ${menu.attribute('plan-name', 'onkeydown')};`);
	return { keydown, commitName };
}

describe("the plan menu's name box", () => {
	it('commits its draft on Ctrl+S and Cmd+S, the save left to the window', () => {
		for (const mods of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, key: 'S' }]) {
			const { keydown, commitName } = nameBox();
			const e = press(mods.key ?? 's', mods);
			keydown(e);
			expect(commitName, JSON.stringify(mods)).toHaveBeenCalledTimes(1);
			expect(e.preventDefault).not.toHaveBeenCalled();
		}
	});

	it('commits on Enter, as before', () => {
		const { keydown, commitName } = nameBox();
		const e = press('Enter');
		keydown(e);
		expect(commitName).toHaveBeenCalledTimes(1);
		expect(e.preventDefault).toHaveBeenCalled();
	});

	it('commits nothing on a typed s, a held key or another shortcut', () => {
		for (const e of [press('s'), press('s', { ctrlKey: true, repeat: true }), press('s', { ctrlKey: true, shiftKey: true })]) {
			const { keydown, commitName } = nameBox();
			keydown(e);
			expect(commitName).not.toHaveBeenCalled();
		}
	});
});
