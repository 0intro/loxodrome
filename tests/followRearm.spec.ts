/* Pins the in-flight follow re-arm rule (nav/followRearm.ts). */

import { describe, expect, it } from 'vitest';
import { FOLLOW_REARM_MS, followRearmDue } from '$lib/nav/followRearm';

describe('followRearmDue', () => {
	it('waits the full interval after the pan ended', () => {
		expect(followRearmDue(1000, 1000 + FOLLOW_REARM_MS - 1)).toBe(false);
		expect(followRearmDue(1000, 1000 + FOLLOW_REARM_MS)).toBe(true);
	});
	it('never re-arms without a pan end', () => {
		expect(followRearmDue(null, 10_000_000)).toBe(false);
	});
	it('takes a shorter interval when given one', () => {
		expect(followRearmDue(0, 500, 500)).toBe(true);
	});
});
