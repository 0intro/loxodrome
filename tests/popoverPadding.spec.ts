/* A popover's panel takes its padding from the box that frames it, never its
 * own: the desktop popup (PopupMenu's `.menu`, 4 px) gives its panel 6 px 8 px,
 * so every popover's notes and sections stand 12 px in from the box's edge,
 * and the phone sheet (HeadOverlay) gives it 6 px 0 inside its own 12 px.
 * Before, five panels chose five paddings (6, 6, 6 4, 0, 0), which put the
 * NOTAM Viewer's notes 4 px from the box and Loxodrome's 21 px. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const PANELS: [string, string][] = [
	['src/lib/components/FiltersPopover.svelte', '.filters'],
	['src/lib/components/ViewConditionsPopover.svelte', '.conds-pop'],
	['src/lib/components/flightprep/OnBoardForm.svelte', '.ob-form'],
	['src/notam/LayersPopover.svelte', '.layers-pop'],
	['src/notam/SettingsPopover.svelte', '.settings-pop'],
];

describe('a popover panel takes its padding from its frame', () => {
	for (const [file, root] of PANELS) {
		it(`${file.split('/').pop()}'s ${root} declares no padding of its own`, () => {
			const src = readFileSync(file, 'utf8');
			expect(src).toMatch(new RegExp(`class="${root.slice(1)} popover-panel"`));
			const own = cssRulesOf(file).filter((r) => r.selectors.includes(root));
			expect(own.length).toBeGreaterThan(0);
			for (const r of own) {
				expect([...r.decls.keys()].filter((k) => k.startsWith('padding'))).toEqual([]);
			}
		});
	}

	it('the desktop popup pads its panel 6 px 8 px, inside its own 4 px', () => {
		const rules = cssRulesOf('src/lib/components/PopupMenu.svelte');
		const menu = rules.find((r) => r.selectors.includes('.menu') && r.decls.has('padding'));
		expect(menu?.decls.get('padding')).toBe('4px');
		const panel = rules.filter((r) => r.selectors.includes('.menu > :global(.popover-panel)'));
		expect(panel.length).toBe(1);
		expect(panel[0].decls.get('padding')).toBe('6px 8px');
	});

	it('the shared field look reaches the popovers', () => {
		const rules = cssRulesOf('src/app.css');
		const search = rules.find((r) => r.selectors.includes(':is(.tab-panel, .popover-panel) .search'));
		expect(search?.decls.get('background')).toBe('var(--surface-2)');
	});
});
