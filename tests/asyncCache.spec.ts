/* The async caches' freshness guard (state/asyncCache.ts isFresh), which the
 * weather, SIGMET, METAR tile and chart caches and the route terrain and MSA
 * failure cooldowns all read. A stamp taken before the device clock was set
 * back sits in the future, and its negative age read fresh: nothing was
 * fetched again until the clock caught up, plus the TTL. */

import { describe, expect, it } from 'vitest';
import { isFresh } from '$lib/state/asyncCache';

const TTL = 5 * 60_000;
const NOW = Date.UTC(2026, 10, 18, 12);

describe('isFresh', () => {
	it('reads a stamp fresh while its age is under the TTL', () => {
		expect(isFresh(NOW, TTL, NOW)).toBe(true);
		expect(isFresh(NOW - 1, TTL, NOW)).toBe(true);
		expect(isFresh(NOW - TTL + 1, TTL, NOW)).toBe(true);
		expect(isFresh(NOW - TTL, TTL, NOW)).toBe(false);
	});

	it('reads a missing stamp, or the 0 the stores start with, stale', () => {
		expect(isFresh(null, TTL, NOW)).toBe(false);
		expect(isFresh(undefined, TTL, NOW)).toBe(false);
		expect(isFresh(0, TTL, NOW)).toBe(false);
	});

	it('reads a stamp from the future stale: the clock was set back since', () => {
		expect(isFresh(NOW + 1, TTL, NOW)).toBe(false);
		expect(isFresh(NOW + 60_000, TTL, NOW)).toBe(false);
		expect(isFresh(NOW + 10 * TTL, TTL, NOW)).toBe(false);
	});
});
