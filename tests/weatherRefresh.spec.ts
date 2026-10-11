/* Auto-refresh building blocks: the new-model-cycle predicate that decides
 * when the winds-aloft caches are invalidated (docs/wind-aloft.md
 * "Auto-refresh"). The null transitions MUST not count: run info landing
 * for the first time (or a meta fetch failing) right after a lattice fetch
 * would otherwise throw away data the same cycle just served. */

import { describe, expect, it } from 'vitest';
import { isNewModelRun } from '$lib/state/windAloft.svelte';

describe('isNewModelRun', () => {
	it('detects an advanced cycle', () => {
		expect(isNewModelRun(1_000, 2_000)).toBe(true);
	});

	it('treats any change as a new cycle (upstream regressions refetch too)', () => {
		expect(isNewModelRun(2_000, 1_000)).toBe(true);
	});

	it('ignores the null transitions', () => {
		expect(isNewModelRun(null, 2_000)).toBe(false);
		expect(isNewModelRun(undefined, 2_000)).toBe(false);
		expect(isNewModelRun(1_000, null)).toBe(false);
		expect(isNewModelRun(null, null)).toBe(false);
	});

	it('ignores an unchanged cycle', () => {
		expect(isNewModelRun(1_000, 1_000)).toBe(false);
	});
});
