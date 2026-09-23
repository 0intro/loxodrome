/* The rendered-panel cache's eviction rule. The bitmaps themselves need a
 * canvas and pdf.js; the rule that decides what goes does not. */

import { describe, expect, it } from 'vitest';

import { evictable, panelKey, scaleBucket, standInKey } from '$lib/state/panelCache';

describe('evictable', () => {
	it('never drops a panel the current pass asked for', () => {
		// Eleven approach sheets are drawn at once on a wide screen at zoom
		// 9, and a ceiling below that evicted whichever were touched first.
		// They were redrawn on the next pass, evicting others in turn, and
		// the two nearest the middle of the view flickered on and off:
		// Poitiers and Angers, reported over the Loire.
		const pass = 100;
		const held = new Map(
			Array.from({ length: 11 }, (_, i) => [`live${i}`, { used: pass + 1 + i }] as const),
		);
		expect(evictable(held, pass)).toBeNull();
	});

	it('drops the least recently used panel that is off screen', () => {
		const pass = 100;
		const cache = new Map<string, { used: number }>([
			['stale-b', { used: 40 }],
			['live', { used: 130 }],
			['stale-a', { used: 12 }],
		]);
		expect(evictable(cache, pass)).toBe('stale-a');
		cache.delete('stale-a');
		expect(evictable(cache, pass)).toBe('stale-b');
		cache.delete('stale-b');
		expect(evictable(cache, pass)).toBeNull();
	});
});

describe('standInKey', () => {
	const p = { ident: 'LFPL', section: 2, page: 1 };
	const at = (b: number) => panelKey(p, b);

	it('lets a panel keep its picture while the wanted scale renders', () => {
		// The cache is keyed by scale bucket, so a zoom step misses EVERY
		// panel at once and the whole overlay went blank until the batch
		// finished rasterising: a second and a half over the Paris basin,
		// twenty-one sheets two at a time. A tile layer keeps its parent
		// tile; this is the same trick.
		expect(standInKey([at(1.414), at(8)], p, 2)).toBe(at(1.414));
	});

	it('prefers the larger bucket, since a smear is worse than a soft chart', () => {
		// Equidistant either way: downscaling a bitmap looks like a chart
		// slightly soft, upscaling one looks like a smear.
		expect(standInKey([at(1), at(4)], p, 2)).toBe(at(4));
	});

	it('refuses a bitmap too far from the wanted scale', () => {
		expect(standInKey([at(16)], p, 2)).toBeNull();
		expect(standInKey([at(0.25)], p, 2)).toBeNull();
	});

	it('never takes another panel\'s picture', () => {
		const other = panelKey({ ident: 'LFPO', section: 2, page: 1 }, 1);
		const page2 = panelKey({ ident: 'LFPL', section: 2, page: 2 }, 1);
		expect(standInKey([other, page2], p, 2)).toBeNull();
	});

	it('answers null when the panel has nothing else at all', () => {
		expect(standInKey([at(2)], p, 2)).toBeNull();
		expect(standInKey([], p, 2)).toBeNull();
	});
});

describe('scaleBucket', () => {
	it('rounds to half a power of two, so a pan reuses the bitmap', () => {
		expect(scaleBucket(1)).toBeCloseTo(1, 6);
		expect(scaleBucket(1.05)).toBeCloseTo(1, 6);
		expect(scaleBucket(1.5)).toBeCloseTo(Math.SQRT2, 6);
		expect(scaleBucket(2.1)).toBeCloseTo(2, 6);
	});

	it('keys a panel by its page and its bucket, never by the raw scale', () => {
		const p = { ident: 'LFPL', section: 2, page: 1 };
		expect(panelKey(p, scaleBucket(1.02))).toBe(panelKey(p, scaleBucket(0.99)));
		expect(panelKey(p, scaleBucket(1))).not.toBe(panelKey(p, scaleBucket(2)));
	});
});
