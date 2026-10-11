import { describe, expect, it } from 'vitest';
import { dedupeById, occurrenceKeys, uniqueBy, uniqueRowIds } from '$lib/data/dedup';

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

// A list's identity when its items are named by something that can repeat:
// Svelte's keyed each throws on a duplicate key in production too, and a pick
// stored by name resolves a repeat to the first. The first occurrence keeps
// its bare name (so a list without repeats keys and saves as before), repeats
// take #2, #3..., the mergeAirspaces / uniqueSigmetIds convention.
describe('occurrenceKeys', () => {
	it('leaves unique names as they are', () => {
		expect(occurrenceKeys(['17', '35', '09', '27'], (x) => x)).toEqual(['17', '35', '09', '27']);
	});

	it('suffixes each repeat in list order', () => {
		expect(occurrenceKeys(['17', '35', '17', '35GLD'], (x) => x)).toEqual(['17', '35', '17#2', '35GLD']);
		expect(occurrenceKeys(['A', 'A', 'A'], (x) => x)).toEqual(['A', 'A#2', 'A#3']);
	});

	it('never hands out a key another item bears as its own name', () => {
		expect(occurrenceKeys(['Seat', 'Seat#2', 'Seat'], (x) => x)).toEqual(['Seat', 'Seat#2', 'Seat#3']);
		const keys = occurrenceKeys(['A', 'A#2', 'A#2', 'A', 'A#3'], (x) => x);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys[1]).toBe('A#2');
		expect(keys[4]).toBe('A#3');
	});

	it('reads the name through the accessor', () => {
		const rows = [{ label: 'Front seats' }, { label: 'Front seats' }];
		expect(occurrenceKeys(rows, (r) => r.label)).toEqual(['Front seats', 'Front seats#2']);
	});
});

describe('uniqueBy', () => {
	it('keeps the first item per key, in order', () => {
		const a1 = { k: 'a', n: 1 };
		const b = { k: 'b', n: 2 };
		const a2 = { k: 'a', n: 3 };
		const out = uniqueBy([a1, b, a2], (x) => x.k);
		expect(out).toEqual([a1, b]);
		expect(out[0]).toBe(a1);
	});
});

describe('uniqueRowIds', () => {
	it('returns a list without repeated ids as it is', () => {
		const rows = [
			{ id: 'a', v: 1 },
			{ id: 'b', v: 2 },
		];
		expect(uniqueRowIds(rows)).toBe(rows);
	});

	it('drops a row identical to an earlier one of its id', () => {
		// ENAIRE emits 216 obstacle rows twice, field for field.
		const a = { id: 'es:1', lat: 40.4, h: 30 };
		const out = uniqueRowIds([a, { id: 'es:2', lat: 41, h: 20 }, { ...a }]);
		expect(out.map((r) => r.id)).toEqual(['es:1', 'es:2']);
		expect(out[0]).toBe(a);
	});

	it('gives a different row sharing an id an occurrence id', () => {
		// Two NDBs under one FAA id (faa:NDB:AA, CEDAR and KENIE).
		const cedar = { id: 'faa:NDB:AA', name: 'CEDAR' };
		const kenie = { id: 'faa:NDB:AA', name: 'KENIE' };
		const out = uniqueRowIds([cedar, kenie, { ...cedar }]);
		expect(out.map((r) => [r.id, r.name])).toEqual([
			['faa:NDB:AA', 'CEDAR'],
			['faa:NDB:AA#2', 'KENIE'],
		]);
		expect(out[0]).toBe(cedar);
	});
});
