// The offline download queue's pure folds (docs/offline-maps.md, "The
// download queue"): dedupe by key, order, removal, promotion and the
// aggregate. Every case also asserts the input is left alone: the runner
// holds the queue in $state, so a fold that mutated its argument would work
// by accident today and break the day the runner stopped reassigning.

import { describe, expect, it } from 'vitest';
import {
	dequeue,
	enqueue,
	jobKey,
	queuePosition,
	queuedBytes,
	removeJob,
	sameJob,
	type QueueJob,
} from '../src/lib/offline/downloadQueue';

function job(kind: QueueJob['kind'], id: string, size: number | null = 100, local = 0): QueueJob {
	return { kind, id, sizeBytes: size, localBytes: local };
}

/** Runs `fold` and fails if it touched its input. */
function pure<T>(queue: readonly QueueJob[], fold: () => T): T {
	const before = JSON.stringify(queue);
	const out = fold();
	expect(JSON.stringify(queue)).toBe(before);
	return out;
}

describe('jobKey', () => {
	it('separates kinds sharing an id', () => {
		expect(jobKey({ kind: 'chart', id: 'x' })).not.toBe(jobKey({ kind: 'doc', id: 'x' }));
	});

	it('names the same job the same way', () => {
		expect(jobKey({ kind: 'chart', id: 'fr500' })).toBe(jobKey({ kind: 'chart', id: 'fr500' }));
		expect(sameJob({ kind: 'chart', id: 'fr500' }, { kind: 'chart', id: 'fr500' })).toBe(true);
		expect(sameJob({ kind: 'chart', id: 'fr500' }, { kind: 'chart', id: 'fr250' })).toBe(false);
	});
});

describe('enqueue', () => {
	it('appends in tap order', () => {
		const q = pure([], () => enqueue(enqueue([], job('chart', 'a')), job('chart', 'b')));
		expect(q.map((j) => j.id)).toEqual(['a', 'b']);
	});

	it('does not grow or reorder on a repeat tap', () => {
		// The TOCTOU regression, pinned as data: tapping Download twice must
		// leave one job, and must not send it to the back of the queue.
		const q = [job('chart', 'a'), job('chart', 'b'), job('chart', 'c')];
		const out = pure(q, () => enqueue(q, job('chart', 'a')));
		expect(out).toHaveLength(3);
		expect(out.map((j) => j.id)).toEqual(['a', 'b', 'c']);
	});

	it('takes the newer numbers in place', () => {
		const q = [job('chart', 'a', null, 0), job('chart', 'b')];
		const out = pure(q, () => enqueue(q, job('chart', 'a', 900, 200)));
		expect(out[0]).toEqual({ kind: 'chart', id: 'a', sizeBytes: 900, localBytes: 200 });
		expect(out.map((j) => j.id)).toEqual(['a', 'b']);
	});

	it('keeps two kinds sharing an id apart', () => {
		const out = enqueue(enqueue([], job('chart', 'x')), job('doc', 'x'));
		expect(out).toHaveLength(2);
	});
});

describe('dequeue', () => {
	it('answers null on an empty queue', () => {
		expect(dequeue([])).toEqual({ job: null, rest: [] });
	});

	it('takes the head and leaves the rest in order', () => {
		const q = [job('chart', 'a'), job('chart', 'b'), job('doc', 'c')];
		const { job: head, rest } = pure(q, () => dequeue(q));
		expect(head?.id).toBe('a');
		expect(rest.map((j) => j.id)).toEqual(['b', 'c']);
	});
});

describe('removeJob', () => {
	it('removes exactly one key and preserves the order of the rest', () => {
		const q = [job('chart', 'a'), job('chart', 'b'), job('chart', 'c')];
		const out = pure(q, () => removeJob(q, jobKey({ kind: 'chart', id: 'b' })));
		expect(out.map((j) => j.id)).toEqual(['a', 'c']);
	});

	it('is identity for an absent key', () => {
		const q = [job('chart', 'a')];
		expect(pure(q, () => removeJob(q, 'chart/zz'))).toEqual(q);
	});
});

describe('queuePosition', () => {
	it('is 0-based, and -1 when absent', () => {
		const q = [job('chart', 'a'), job('doc', 'b')];
		expect(queuePosition(q, 'chart/a')).toBe(0);
		expect(queuePosition(q, 'doc/b')).toBe(1);
		expect(queuePosition(q, 'chart/b')).toBe(-1);
	});
});

describe('queuedBytes', () => {
	it('sums what is LEFT, not the whole size', () => {
		const q = [job('chart', 'a', 1000, 400), job('chart', 'b', 500, 0)];
		expect(queuedBytes(q)).toEqual({ known: 1100, unknown: 0 });
	});

	it('counts an unknown size as unknown, never as zero', () => {
		const q = [job('chart', 'a', 1000, 0), job('doc', 'b', null, 0)];
		expect(queuedBytes(q)).toEqual({ known: 1000, unknown: 1 });
	});

	it('clamps a part larger than the stated size', () => {
		// An orphan archive adopted with an unknown etag reports its own size.
		expect(queuedBytes([job('chart', 'a', 100, 400)])).toEqual({ known: 0, unknown: 0 });
	});

	it('is zero on an empty queue', () => {
		expect(queuedBytes([])).toEqual({ known: 0, unknown: 0 });
	});
});
