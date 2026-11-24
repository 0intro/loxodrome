/* Every shared control shows its own press. The body turns the browser's tap
 * flash off (app.css), on the promise that the controls show their own
 * :active, and none did: on a phone no button showed that it was touched.
 * One rule in app.css lays the --press overlay over whatever fill a control
 * has, as an inset shadow, which no hover rule's background shorthand can
 * take away. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssRulesOf } from './helpers/cssRules';

const CONTROLS = [
	'.btn',
	'.icon-btn',
	'.modal-close',
	'.menu-panel .item',
	'.map-bar .text-btn',
	'.foot-chip',
	':root .leaflet-bar a',
];

describe('the press', () => {
	const rules = cssRulesOf('src/app.css');

	it.each(CONTROLS)('%s lays the press overlay over its fill', (control) => {
		const press = rules.filter((r) => r.selectors.some((s) => s.startsWith(`${control}:active`)));
		expect(press.length).toBeGreaterThan(0);
		for (const r of press) {
			expect(r.decls.get('box-shadow') ?? '').toMatch(/inset 0 0 0 \S+ var\(--press\)/);
		}
	});

	it('has an overlay in both themes', () => {
		const theme = readFileSync('src/styles/theme.css', 'utf8');
		const split = theme.search(/:root\[data-theme=["']night["']\]/);
		expect(split).toBeGreaterThan(0);
		expect(theme.slice(0, split)).toMatch(/--press:/);
		expect(theme.slice(split)).toMatch(/--press:/);
	});

	it("reaches the banners' action, which is a .btn", () => {
		const banner = readFileSync('src/lib/components/Banner.svelte', 'utf8');
		expect(banner).toMatch(/<button type="button" class="btn action"/);
	});
});
