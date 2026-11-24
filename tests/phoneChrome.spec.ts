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

	it('keeps the phone chrome off paper', () => {
		/* The bar, the pages and the map buttons carry `no-print`. The
		 * toolbar and the map leave paper on every layout
		 * (tests/printPaper.spec.ts). */
		expect(read('src/lib/components/phone/PhoneNavBar.svelte')).toContain('class="phone-bar no-print"');
		expect(read('src/lib/components/phone/PhonePages.svelte')).toContain('class="phone-page no-print"');
	});
});

describe("the phone's search is the palette", () => {
	it('opens the palette full screen, which the system Back closes', () => {
		// The toolbar's phone search opened the Airports page, where a VOR or
		// a reporting point could not be searched at all (docs/search.md).
		const toolbar = read('src/lib/components/Toolbar.svelte');
		expect(toolbar).not.toContain("openPage('airports', 'search')");
		const phone = toolbar.slice(toolbar.indexOf('{#if ui.isMobile}'));
		expect(phone.indexOf('onclick={openSearchPalette}')).toBeGreaterThan(-1);
		expect(phone.indexOf('onclick={openSearchPalette}')).toBeLessThan(phone.indexOf('flight-btn'));
		const palette = read('src/lib/components/SearchPalette.svelte');
		expect(palette).toContain('return registerBackClose(close);');
		expect(palette).not.toContain('above-bar');
	});
});

describe("the phone's fit button names what it fits", () => {
	// fitMap fits the route once it has two waypoints, and both phone
	// buttons read Fit map to NOTAMs whatever they fitted.
	const LABEL = 'const fitLabel = $derived(fitTargetsRoute() ? t.common.fitRoute : t.common.fitMap);';
	for (const file of ['src/lib/components/Toolbar.svelte', 'src/lib/components/phone/MapButtons.svelte']) {
		it(file.replace(/^.*\//, ''), () => {
			const src = read(file);
			expect(src).toContain(LABEL);
			const at = src.indexOf('onclick={fitMap}');
			expect(at).toBeGreaterThan(0);
			const tag = src.slice(src.lastIndexOf('<button', at), src.indexOf('>', at));
			expect(tag).toContain('title={fitLabel}');
			expect(tag).toContain('aria-label={fitLabel}');
		});
	}
});
