/* Pins the trace-download queue (docs/accounts-sync.md, "the trickle"):
 * the order the pilot reads it in and the dedupe that keeps one run from
 * fetching the same outing twice. Both used to be implicit in a serial
 * loop inside the pass; detached from the pass, they are contracts, and
 * this is where they hold. */
import { describe, expect, it } from 'vitest';
import { mergeWants, type TraceWant } from '$lib/sync/traceQueue';

function want(id: string, hash = `h-${id}`): TraceWant {
	return { col: 'outings', id, refs: [{ h: hash, n: 10 }], meta: { pts: hash } };
}

describe('mergeWants', () => {
	it('orders newest first, the outing id being its first fix', () => {
		const out = mergeWants([], [want('1000'), want('3000'), want('2000')]);
		expect(out.map((w) => w.id)).toEqual(['3000', '2000', '1000']);
	});

	it('re-sorts across the fold, not only within each half', () => {
		const out = mergeWants([want('3000'), want('1000')], [want('2000'), want('4000')]);
		expect(out.map((w) => w.id)).toEqual(['4000', '3000', '2000', '1000']);
	});

	it('adds nothing when the registry re-scan re-offers what is pending', () => {
		const pending = mergeWants([], [want('1000'), want('2000')]);
		const again = mergeWants(pending, [want('1000'), want('2000')]);
		expect(again).toHaveLength(2);
	});

	it('keeps the latest refs for a doc a re-pull restated', () => {
		const out = mergeWants([want('1000', 'old')], [want('1000', 'new')]);
		expect(out).toHaveLength(1);
		expect(out[0]?.refs[0]?.h).toBe('new');
	});

	it('keys on the collection too, so two collections never collide', () => {
		const other: TraceWant = { ...want('1000'), col: 'plans' };
		expect(mergeWants([want('1000')], [other])).toHaveLength(2);
	});

	it('sorts an unorderable id last instead of poisoning the comparison', () => {
		const out = mergeWants([], [want('abc'), want('1000'), want('2000')]);
		expect(out.map((w) => w.id)).toEqual(['2000', '1000', 'abc']);
	});

	it('answers empty for empty', () => {
		expect(mergeWants([], [])).toEqual([]);
	});
});
