/* The small note (`.muted.small`) has one size, declared once in app.css.
 * Ten components declared it for themselves, and four used it with nothing
 * declaring it (the NOTAMs tab's "outside the period" note, the phone's
 * Nearest hint, the viewer's Layers and About notes), so their notes ran at
 * the body size. What a type checker cannot see: the shared rule going, which
 * would put those notes back at the body size with nothing failing, and the
 * viewer About's prose, which reads at the About's own size like Loxodrome's
 * About, keeping the small class only on its library line, whose licence id
 * Loxodrome's About sets small too. */

import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { cssRulesOf } from './helpers/cssRules';

const APP = cssRulesOf('src/app.css');

describe('the small note', () => {
	it('has one size, declared once in app.css', () => {
		const small = APP.filter((r) => r.selectors.includes('.small'));
		expect(small.map((r) => [r.parents, Object.fromEntries(r.decls)])).toEqual([[[], { 'font-size': 'var(--fs-xs)' }]]);
	});

	it('reaches every component that uses it without a size of its own', () => {
		const relying: string[] = [];
		for (const file of globSync('src/**/*.svelte')) {
			const src = readFileSync(file, 'utf8');
			if (!/class="[^"]*\bsmall\b/.test(src)) {
				continue;
			}
			const own = /<style/.test(src) && cssRulesOf(file).some((r) => r.selectors.some((s) => /\.small\b/.test(s)));
			if (!own) {
				relying.push(file);
			}
		}
		expect(relying.sort()).toEqual([
			'src/lib/components/phone/NearestAerodromes.svelte',
			'src/lib/components/tabs/NotamsTab.svelte',
			'src/notam/AboutSurface.svelte',
			'src/notam/LayersPopover.svelte',
		]);
	});

	it('keeps the viewer About\'s prose at the About\'s size, its library line small', () => {
		const about = readFileSync('src/notam/AboutSurface.svelte', 'utf8');
		expect(about.match(/class="muted small"/g)?.length).toBe(1);
		expect(about).toMatch(/<span class="muted small">\{lib\.version\}/);
		for (const key of ['t.about.terrainCreditsMissing', 't.viewer.aboutLibrariesBody', 't.about.copyright']) {
			expect(about, key).toContain(`<p class="muted">{${key}`);
		}
	});
});
