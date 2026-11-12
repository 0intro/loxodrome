/* Where the flight plan sits in the chrome (docs/workspace-surfaces.md):
 * the plan chip right after the toolbar's brand on desktop, the plan line
 * atop the phone's Plan page, and the Route tab's menu holding what a route
 * file holds and nothing of the document. The node project renders no
 * component, so these read the sources, the radarCaution idiom. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssRulesOf } from './helpers/cssRules';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the plan in the chrome', () => {
	it('sits right after the brand on the desktop toolbar, and nowhere on a phone toolbar', () => {
		const bar = read('src/lib/components/Toolbar.svelte');
		const brand = bar.indexOf('<div class="brand"');
		const chip = bar.indexOf('<PlanChip />');
		const conds = bar.indexOf('<ViewConditions />');
		expect(brand).toBeGreaterThan(0);
		expect(chip).toBeGreaterThan(brand);
		expect(conds).toBeGreaterThan(chip);
		expect(bar.slice(brand, chip)).toMatch(/\{#if !ui\.isMobile\}\s*$/);
	});

	it('gives way first: a zero basis, its natural width at most, its label the one track that shrinks', () => {
		const rule = cssRulesOf('src/lib/components/PlanChip.svelte').find((r) => r.selectors.includes('.plan-chip'));
		expect(rule?.decls.get('flex')).toBe('1000 1 0');
		expect(rule?.decls.get('max-width')).toBe('max-content');
		expect(rule?.decls.get('grid-template-columns')).toBe('auto minmax(0, max-content) 12px auto');
	});

	it('rides the phone’s Plan page as a row of its own, between the head and the body', () => {
		const pages = read('src/lib/components/phone/PhonePages.svelte');
		const head = pages.indexOf('</header>');
		const line = pages.indexOf('<PlanLine />');
		const body = pages.indexOf('<div class="page-body"');
		expect(line).toBeGreaterThan(head);
		expect(body).toBeGreaterThan(line);
		expect(pages.slice(head, line)).toMatch(/\{#if page === 'plan'\}\s*$/);
	});

	it('leaves the Route tab’s menu to the route, its strip without the plan’s dot', () => {
		const tab = read('src/lib/components/tabs/RouteTab.svelte');
		expect(tab).not.toMatch(/t\.plan\./);
		expect(tab).not.toMatch(/savePlan|newPlan|pickPlanFile|downloadPlanFile|openFlights/);
		expect(read('src/lib/components/tabs/route/RouteStrip.svelte')).not.toMatch(/unstored/);
	});
});
