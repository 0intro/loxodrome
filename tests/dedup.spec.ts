import { describe, expect, it } from 'vitest';
import { dedupeById } from '$lib/data/dedup';

type Item = { notam: { id: string }; index: number };

describe('dedupeById', () => {
	it('returns an empty list unchanged', () => {
		expect(dedupeById([])).toEqual([]);
	});

	it('passes a duplicate-free list through, preserving order', () => {
		const items: Item[] = [
			{ notam: { id: 'A' }, index: 0 },
			{ notam: { id: 'B' }, index: 1 },
			{ notam: { id: 'C' }, index: 2 },
		];
		expect(dedupeById(items)).toEqual(items);
	});

	it('keeps the first occurrence of each id and drops later ones', () => {
		const first: Item = { notam: { id: 'A' }, index: 0 };
		const second: Item = { notam: { id: 'B' }, index: 1 };
		const dupOfA: Item = { notam: { id: 'A' }, index: 2 };
		const out = dedupeById([first, second, dupOfA]);
		expect(out).toEqual([first, second]);
		// First-wins: the retained 'A' is the original entry, not the later dup.
		expect(out[0]).toBe(first);
	});

	it('collapses a multi-area NOTAM (same id, several indices) to one entry', () => {
		const items: Item[] = [
			{ notam: { id: 'W1234/26' }, index: 0 },
			{ notam: { id: 'W1234/26' }, index: 1 },
			{ notam: { id: 'W1234/26' }, index: 2 },
		];
		expect(dedupeById(items)).toEqual([{ notam: { id: 'W1234/26' }, index: 0 }]);
	});
});
