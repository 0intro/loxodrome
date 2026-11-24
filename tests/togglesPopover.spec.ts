/* The toggles popover's keyboard (TogglesPopover.svelte, the profiles'
 * airspace filter and layers, the nav log's columns). The panel takes focus
 * when it opens, and it sits OUTSIDE the surface box, in the shell's `extra`
 * snippet, so the box's own keyboard never reaches it:
 *
 * - Escape: a docked or paged surface answers Escape only from inside its
 *   box, so with focus in the panel the key closed nothing (measured over
 *   CDP on a docked chart: the filter stayed open);
 * - Tab: a full-screen surface traps Tab inside its box, which the panel is
 *   not in, so Tab past the last row walked out to the app behind the modal
 *   backdrop, where Enter pressed a toolbar control (measured).
 *
 * So the panel owns both keys, and the backdrop button named "Dismiss menu",
 * which Shift+Tab from the panel reached, answers a keyboard activation.
 * The suite mounts no components: the cycle is pinned as a unit and the
 * wiring as source. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cycleTab } from '$lib/ui/focusTrap';

const toggles = readFileSync('src/lib/components/TogglesPopover.svelte', 'utf8');

/** A panel holding `names` focusable controls, and the document whose
 *  activeElement their focus() moves. */
function panel(names: string[]) {
	const doc = { activeElement: null as unknown };
	vi.stubGlobal('document', doc);
	const el = (name: string) => ({
		name,
		getClientRects: () => [{}],
		focus() {
			doc.activeElement = this;
		},
	});
	const items = names.map(el);
	const node = {
		name: 'panel',
		querySelectorAll: () => items,
		focus() {
			doc.activeElement = node;
		},
	};
	const tab = (shiftKey = false) => {
		let prevented = false;
		cycleTab(node as unknown as HTMLElement, {
			key: 'Tab',
			shiftKey,
			preventDefault: () => {
				prevented = true;
			},
		} as unknown as KeyboardEvent);
		return prevented;
	};
	const at = () => (doc.activeElement as { name?: string } | null)?.name ?? null;
	return { node, items, doc, tab, at };
}

describe('the Tab cycle a panel keeps', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('goes round from the last control to the first', () => {
		const p = panel(['a', 'b', 'c']);
		p.items[2].focus();
		expect(p.tab()).toBe(true);
		expect(p.at()).toBe('a');
	});

	it('goes round backwards from the first control, and from the panel itself', () => {
		// Focus opens on the PANEL, never its first row: Shift+Tab from there
		// left for the backdrop button before it in the document.
		const p = panel(['a', 'b', 'c']);
		p.items[0].focus();
		expect(p.tab(true)).toBe(true);
		expect(p.at()).toBe('c');
		p.node.focus();
		expect(p.tab(true)).toBe(true);
		expect(p.at()).toBe('c');
	});

	it("leaves every other step to the browser's own order", () => {
		const p = panel(['a', 'b', 'c']);
		p.node.focus();
		expect(p.tab()).toBe(false); // the panel to its first row
		p.items[1].focus();
		expect(p.tab()).toBe(false);
		expect(p.tab(true)).toBe(false);
		expect(p.at()).toBe('b');
	});

	it('holds focus where it is when there is nothing to reach', () => {
		const p = panel([]);
		p.node.focus();
		expect(p.tab()).toBe(true);
		expect(p.at()).toBe('panel');
	});
});

describe('the toggles popover', () => {
	it('closes on Escape from its own panel, and the key goes no further', () => {
		// Stopped there, so a full-screen surface's window Escape does not
		// close the surface on the key meant for the popover.
		expect(toggles).toMatch(
			/onkeydown=\{\(e: KeyboardEvent\) => \{\s*if \(e\.key === 'Escape'\) \{\s*e\.stopPropagation\(\);\s*onClose\(\);\s*\} else if \(panelEl\) \{\s*cycleTab\(panelEl, e\);/,
		);
		expect(toggles).toMatch(/bind:this=\{panelEl\}\s+tabindex="-1"[\s\S]*?onkeydown=/);
	});

	it('closes from its backdrop button pressed from the keyboard', () => {
		expect(toggles).toMatch(/class="ctx-backdrop no-print"[^>]*?onpointerdown=\{dismissOnDown\(onClose\)\}\s*onclick=\{onClose\}/);
	});
});
