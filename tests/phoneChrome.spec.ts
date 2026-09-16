/* The phone chrome's two measured rules (docs/workspace-surfaces.md
 * "Phones"), both set against the DEVICE and pinned here so a later edit
 * cannot quietly undo them:
 *
 *  - the page head is the toolbar's twin. The two strips sit one under the
 *    other as the pilot moves between the map and a page, so the head is
 *    --toolbar-h tall and its controls are the toolbar icon's own 44 px,
 *    with the same air above and below. It came out 46 px on the Redmi
 *    because two rules of equal specificity both sized the Segmented and
 *    the winner was left to bundle order.
 *  - the app menu is the phone's BOTTOM SHEET, not a dropdown hanging off
 *    the logo: the same HeadOverlay chrome as every other phone sheet, and
 *    with it the swipe down, Escape and the system Back. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the page head is the toolbar twin', () => {
	const src = read('src/lib/components/phone/PhonePages.svelte');

	it('is exactly the toolbar height', () => {
		expect(src).toMatch(/\.page-head \{[^}]*height: calc\(var\(--toolbar-h\) \+ var\(--sat\)\);/s);
		// No wrapping: Back and the sections share the one row.
		expect(src).not.toMatch(/\.page-head \{[^}]*flex-wrap: wrap;/s);
	});

	it('sizes its sections at the toolbar icon height, in ONE rule', () => {
		expect(src).toMatch(/\.page-seg :global\(\.seg\) \{[^}]*height: 44px;/s);
		const buttonRules = src.match(/\.page-seg :global\(\.seg button\) \{/g) ?? [];
		expect(buttonRules).toHaveLength(1);
		expect(src).toMatch(/\.page-seg :global\(\.seg button\) \{[^}]*height: 100%;/s);
	});

	it('yields the title to the sections, keeping it for assistive tech', () => {
		expect(src).toContain("<h1 class={sections.length > 1 ? 'sr-only' : undefined}>{title}</h1>");
	});
});

describe('the app menu is a bottom sheet', () => {
	const src = read('src/lib/components/Toolbar.svelte');

	it('renders through HeadOverlay on the phone, with no dropdown left', () => {
		const menu = src.slice(src.indexOf('BOTTOM SHEET'));
		expect(menu.slice(0, 900)).toContain('<HeadOverlay');
		expect(menu.slice(0, 900)).toContain('open={moreOpen}');
		expect(src).not.toContain('class="more-menu"');
		expect(src).not.toContain('.more-backdrop {');
	});

	it('keeps its rows and drops the aria-controls that named the dropdown', () => {
		expect(src).toContain('class="item more-item"');
		expect(src).not.toContain('aria-controls={moreOpen');
	});
});
