/* The route strip's + rides inside its scroller while the tabs fit and docks
 * beside it once they overflow (RouteStrip `stripOverflows`). On a touch
 * screen the + carries an ::after slop past its box, which is scrollable
 * overflow inside the scroller: tabs that fill the strip then read as
 * overflowing, the + docks beside the strip, everything fits, the + comes
 * back, every frame, and the tab names shake by 2 px (measured on a 392 px
 * phone with two routes). The strip keeps the slop's reach as end padding,
 * and never scrolls vertically, the slop's height being taller than it. */

import { describe, expect, it } from 'vitest';
import { cssRulesOf } from './helpers/cssRules';

const rules = cssRulesOf('src/lib/components/tabs/route/RouteStrip.svelte');

function decl(selector: string, property: string): string | undefined {
	return rules.find((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);
}

/** The horizontal reach of an `inset` shorthand, in px. */
function inlineReach(inset: string): number {
	const v = inset.split(/\s+/).map((s) => Math.abs(parseFloat(s)));
	const inline = v.length === 1 ? [v[0]] : v.length === 4 ? [v[1], v[3]] : [v[1]];
	return Math.max(...inline);
}

describe('the route strip under a finger', () => {
	it('keeps room at its end for the slop of the + riding in it', () => {
		const inset = decl(':global(:root.touch-ui) .route-add::after', 'inset');
		expect(inset).toBeDefined();
		const room = parseFloat(decl(':global(:root.touch-ui) .route-tabs', 'padding-inline-end') ?? 'NaN');
		expect(room).toBeGreaterThanOrEqual(inlineReach(inset!));
	});

	it('scrolls sideways only', () => {
		expect(decl('.route-tabs', 'overflow-x')).toBe('auto');
		expect(decl('.route-tabs', 'overflow-y')).toBe('hidden');
	});
});
