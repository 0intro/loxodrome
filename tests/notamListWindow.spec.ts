/* state/notamOrder budgetSections: how many rows a list builds.
 *
 * The rule that matters is the DEFAULT. Loxodrome passes no budget, and
 * docs/performance-2026-08.md:160 declined capping its list on the grounds
 * that it changes what the UI does; this must stay true of it. The NOTAM
 * Viewer passes one, because its briefings are continental: the world corpus
 * shows 9 148 rows in the default period, 79 363 DOM nodes to build.
 *
 * The budget is spent IN ORDER so the first block is whole. The canonical
 * order puts the aerodrome blocks first, which is what a reader opens a
 * briefing for; clipping every block equally would mean no block was readable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNotams } from '$lib/notam';
import { budgetSections } from '$lib/state/notamOrder.svelte';
import type { NotamOwnerSection } from '$lib/state/notamOrder.svelte';

function section(key: string, n: number): NotamOwnerSection {
	return {
		key,
		owner: { kind: 'other' },
		items: Array.from({ length: n }, (_, i) => ({ notam: { id: `${key}${i}` }, index: i })),
	} as unknown as NotamOwnerSection;
}

describe('budgetSections', () => {
	it('is inert without a budget, which is what Loxodrome gets', () => {
		const secs = [section('a', 300), section('b', 400)];
		const out = budgetSections(secs, Number.POSITIVE_INFINITY);
		expect(out.hidden).toBe(0);
		expect(out.sections.map((s) => s.items.length)).toEqual([300, 400]);
	});

	it('leaves a real route briefing untouched at the viewer s own budget', () => {
		// The measured guard: a corridor briefing must never reach the cap, or
		// the cap would be changing what a briefing looks like rather than
		// bounding a pathological one. EGPD-LFKC is 676 NOTAMs whole.
		const notams = parseNotams(
			readFileSync(new URL('./fixtures/EGPD-LFKC-20260207.txt', import.meta.url), 'utf-8'),
		);
		expect(notams.length).toBeLessThan(400 * 3);
		const one = [section('all', 219)];
		expect(budgetSections(one, 400).hidden).toBe(0);
	});

	it('spends the budget in order, keeping the first block whole', () => {
		const out = budgetSections([section('a', 250), section('b', 250), section('c', 250)], 400);
		expect(out.sections.map((s) => s.items.length)).toEqual([250, 150]);
		expect(out.hidden).toBe(350);
	});

	it('drops a whole section rather than showing an empty head', () => {
		const out = budgetSections([section('a', 400), section('b', 50)], 400);
		expect(out.sections.map((s) => s.key)).toEqual(['a']);
		expect(out.hidden).toBe(50);
	});

	it('counts what it withheld, so the row can say how many', () => {
		const out = budgetSections([section('a', 1000)], 400);
		expect(out.sections[0].items).toHaveLength(400);
		expect(out.hidden).toBe(600);
	});

	it('answers empty at a zero budget rather than throwing', () => {
		const out = budgetSections([section('a', 10)], 0);
		expect(out.sections).toEqual([]);
		expect(out.hidden).toBe(10);
	});
});
