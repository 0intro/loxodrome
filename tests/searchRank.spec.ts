/* The search's order (src/lib/search/rank.ts) and its key cache
 * (src/lib/search/keys.ts). */

import { describe, it, expect } from 'vitest';
import { frame } from '$lib/search/fold';
import { isIdentTier, matchTier, nameTier, NO_MATCH, TIER, type SearchKey } from '$lib/search/match';
import { prepareQuery } from '$lib/search/query';
import { CLASS, compareHits, FAR_IDENT_M, mergeRanked, rankRows, type Hit, type RankSpec } from '$lib/search/rank';
import { keyCache, warmKeys } from '$lib/search/keys';

function hit(h: Partial<Hit<string>>): Hit<string> {
	return { item: 'x', tier: TIER.NAME_PREFIX, cls: CLASS.OPEN, dist: 0, kind: 0, order: '', ...h };
}

describe('compareHits', () => {
	it('orders by tier, then class, then distance, then kind, then name', () => {
		expect(compareHits(hit({ tier: TIER.NAME_EXACT }), hit({ tier: TIER.NAME_PREFIX, dist: -1 }))).toBeLessThan(0);
		expect(compareHits(hit({ cls: CLASS.OPEN, dist: 900 }), hit({ cls: CLASS.TOWN, dist: 1 }))).toBeLessThan(0);
		expect(compareHits(hit({ dist: 1 }), hit({ dist: 2 }))).toBeLessThan(0);
		expect(compareHits(hit({ kind: 0 }), hit({ kind: 1 }))).toBeLessThan(0);
		expect(compareHits(hit({ order: 'a' }), hit({ order: 'b' }))).toBeLessThan(0);
		expect(compareHits(hit({}), hit({}))).toBe(0);
	});

	it('lets distance settle an exact identifier whatever the class', () => {
		const farOpen = hit({ tier: TIER.IDENT_EXACT, cls: CLASS.OPEN, dist: 7e6 });
		const nearClosed = hit({ tier: TIER.IDENT_EXACT, cls: CLASS.CLOSED, dist: 1e3 });
		expect(compareHits(nearClosed, farOpen)).toBeLessThan(0);
		expect(compareHits({ ...nearClosed, tier: TIER.IDENT_PREFIX }, { ...farOpen, tier: TIER.IDENT_PREFIX })).toBeGreaterThan(0);
	});

	it('puts a row with no distance after one with any', () => {
		expect(compareHits(hit({ dist: 5e6 }), hit({ dist: Infinity }))).toBeLessThan(0);
		expect(compareHits(hit({ dist: Infinity, order: 'a' }), hit({ dist: Infinity, order: 'b' }))).toBeLessThan(0);
	});
});

interface Row {
	ident: string;
	alt?: string;
	name: string;
	d: number;
	c: number;
}

const spec: RankSpec<Row> = {
	key: keyCache((r: Row): SearchKey => ({ id: [r.ident], altId: r.alt ? [r.alt] : [], name: frame([r.name]), altName: '' })),
	kind: 0,
	cls: (r) => r.c,
	dist: (r) => r.d,
	order: (r) => r.ident,
};

// A seeded generator, so a failure names its own inputs.
function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

describe('rankRows', () => {
	it('matches a full sort of every hit, on seeded data', () => {
		const SEED = 20261018;
		const r = rng(SEED);
		const letters = 'ABLMNORST';
		const pick = (n: number): string => Array.from({ length: n }, () => letters[Math.floor(r() * letters.length)]).join('');
		// A third of the names are one word and a third of the rows carry a
		// secondary identifier, so whole names and every identifier tier meet.
		const rows: Row[] = Array.from({ length: 3000 }, () => ({
			ident: pick(3 + Math.floor(r() * 3)),
			...(r() < 0.3 ? { alt: pick(3) } : {}),
			name: r() < 0.3 ? pick(3 + Math.floor(r() * 2)) : `${pick(4)} ${pick(5)}`,
			// A fifth of the rows lie beyond FAR_IDENT_M and a few have no
			// distance at all.
			d: r() < 0.03 ? Infinity : Math.floor(r() * 4e6),
			c: Math.floor(r() * 3),
		}));
		const whole = rows.find((row) => !row.name.includes(' '))?.name ?? '';
		const alt = rows.find((row) => row.alt)?.alt ?? '';
		for (const text of ['A', 'AB', 'LA', 'ST', 'mos', 'ab l', 'NOR', whole, whole.slice(0, 3), alt]) {
			const q = prepareQuery(text);
			const all: Hit<Row>[] = [];
			for (const row of rows) {
				const k = spec.key(row);
				let t = matchTier(k, q);
				if (t === NO_MATCH) {
					continue;
				}
				// The rule, stated again: a far identifier match is matched by
				// its names, else it ranks after them all.
				if (isIdentTier(t) && Number.isFinite(row.d) && row.d > FAR_IDENT_M) {
					const n = nameTier(k, q);
					t = n === NO_MATCH ? TIER.FAR_IDENT : n;
				}
				all.push({ item: row, tier: t, cls: row.c, dist: row.d, kind: 0, order: row.ident });
			}
			all.sort(compareHits);
			const got = rankRows(rows, q, spec, 25);
			expect(got.total, `seed ${SEED} "${text}"`).toBe(all.length);
			expect(got.hits.map((h) => h.item), `seed ${SEED} "${text}"`).toEqual(all.slice(0, 25).map((h) => h.item));
		}
	});

	it('matches an identifier beyond FAR_IDENT_M by its names, else after every name', () => {
		const far = FAR_IDENT_M + 1;
		const rows: Row[] = [
			{ ident: 'VYPK', alt: 'PAU', name: 'PAUK AIRPORT', d: far, c: 0 },
			{ ident: 'PAUM', name: 'UMIAT', d: far, c: 0 },
			{ ident: 'LFBP', name: 'PAU PYRENEES', d: 5e3, c: 0 },
			{ ident: 'PAUX', name: 'X', d: FAR_IDENT_M, c: 0 },
		];
		const got = rankRows(rows, prepareQuery('PAU'), spec, 10).hits.map((h) => [h.item.ident, h.tier]);
		expect(got).toEqual([
			['PAUX', TIER.IDENT_PREFIX],
			['LFBP', TIER.NAME_PREFIX],
			['VYPK', TIER.NAME_PREFIX],
			['PAUM', TIER.FAR_IDENT],
		]);
		// An exact ident too: Raxaul, India, is VERL.
		const verl = rankRows([{ ident: 'VERL', name: 'RAXAUL', d: far, c: 0 }], prepareQuery('verl'), spec, 5);
		expect(verl.hits.map((h) => h.tier)).toEqual([TIER.FAR_IDENT]);
	});

	it('moves nothing without a reference', () => {
		const rows: Row[] = [{ ident: 'VERL', name: 'RAXAUL', d: Infinity, c: 0 }];
		expect(rankRows(rows, prepareQuery('VERL'), spec, 5).hits.map((h) => h.tier)).toEqual([TIER.IDENT_EXACT]);
	});

	it('applies keep before the cap, and the tier shift to every hit', () => {
		const rows: Row[] = [
			{ ident: 'ABA', name: '', d: 1, c: 0 },
			{ ident: 'ABB', name: '', d: 2, c: 0 },
			{ ident: 'ABC', name: '', d: 3, c: 0 },
		];
		const got = rankRows(rows, prepareQuery('AB'), { ...spec, keep: (row) => row.ident !== 'ABA', tierShift: 1 }, 1);
		expect(got.total).toBe(2);
		expect(got.hits.map((h) => [h.item.ident, h.tier])).toEqual([['ABB', TIER.IDENT_PREFIX + 1]]);
	});

	it('is empty for an empty query', () => {
		expect(rankRows([{ ident: 'AB', name: 'AB', d: 0, c: 0 }], prepareQuery(' '), spec, 5)).toEqual({ hits: [], total: 0 });
	});
});

describe('mergeRanked', () => {
	it('merges kinds on one scale and adds their totals', () => {
		const a = { hits: [hit({ item: 'a1', dist: 5 }), hit({ item: 'a2', dist: 9 })], total: 4 };
		const b = { hits: [hit({ item: 'b1', dist: 7, kind: 1 })], total: 1 };
		const m = mergeRanked([a, b], 2);
		expect(m.hits.map((h) => h.item)).toEqual(['a1', 'b1']);
		expect(m.total).toBe(5);
	});
});

describe('keyCache and warmKeys', () => {
	it('builds each row key once, ahead of the first query', async () => {
		let built = 0;
		const k = keyCache((r: { s: string }): SearchKey => {
			built++;
			return { id: [r.s], altId: [], name: '', altName: '' };
		});
		const rows = Array.from({ length: 500 }, (_, i) => ({ s: String(i) }));
		await warmKeys(rows, k, 1);
		expect(built).toBe(500);
		expect(k(rows[7])).toBe(k(rows[7]));
		expect(built).toBe(500);
	});
});
