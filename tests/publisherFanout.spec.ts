/* map/publisherFanout.ts: which publishers' features each layer draws.
 *
 * Two rules, both of which cost real bugs before they were rules, and both of
 * which a second map would otherwise restate: walk PUBLISHERS rather than
 * naming countries, and push only the flags that changed.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PUBLISHERS, layers, type Publisher } from '$lib/state/layers.svelte';
import {
	noPublishersPushed,
	pushChangedPublishers,
	wantedPublishers,
	type PublisherSink,
} from '$lib/map/publisherFanout';

function record(): { calls: [Publisher, boolean][]; sink: PublisherSink } {
	const calls: [Publisher, boolean][] = [];
	return { calls, sink: (p, on) => calls.push([p, on]) };
}

beforeEach(() => {
	for (const p of PUBLISHERS) {
		layers.publisher[p] = true;
	}
});

describe('wantedPublishers', () => {
	it('answers for EVERY publisher, not a hand-kept list', () => {
		// The whole point: a list here produced a dead checkbox for every
		// publisher added after the first eight. Adding one to PUBLISHERS must
		// be all it takes, so the shape of the answer is asserted against
		// PUBLISHERS itself rather than against a copy of it.
		const want = wantedPublishers();
		expect(Object.keys(want).sort()).toEqual([...PUBLISHERS].sort());
	});

	it('reads the live flags', () => {
		const p = PUBLISHERS[0];
		layers.publisher[p] = false;
		expect(wantedPublishers()[p]).toBe(false);
	});
});

describe('pushChangedPublishers', () => {
	it('pushes nothing when nothing changed', () => {
		const pushed = noPublishersPushed();
		const r = record();
		expect(pushChangedPublishers(pushed, wantedPublishers(), [r.sink])).toBe(false);
		expect(r.calls).toEqual([]);
	});

	it('starts from every publisher visible, mirroring the layers', () => {
		// The cache mirrors the layers' own initial state, so the first run
		// pushes exactly the publishers stored as HIDDEN and nothing else.
		const p = PUBLISHERS[1];
		layers.publisher[p] = false;
		const pushed = noPublishersPushed();
		const r = record();
		expect(pushChangedPublishers(pushed, wantedPublishers(), [r.sink])).toBe(true);
		expect(r.calls).toEqual([[p, false]]);
	});

	it('pushes one change to every sink, once', () => {
		const p = PUBLISHERS[2];
		layers.publisher[p] = false;
		const a = record();
		const b = record();
		pushChangedPublishers(noPublishersPushed(), wantedPublishers(), [a.sink, b.sink]);
		expect(a.calls).toEqual([[p, false]]);
		expect(b.calls).toEqual([[p, false]]);
	});

	it('is idempotent: a second pass with the same want pushes nothing', () => {
		const p = PUBLISHERS[3];
		layers.publisher[p] = false;
		const pushed = noPublishersPushed();
		const r = record();
		pushChangedPublishers(pushed, wantedPublishers(), [r.sink]);
		r.calls.length = 0;
		expect(pushChangedPublishers(pushed, wantedPublishers(), [r.sink])).toBe(false);
		expect(r.calls).toEqual([]);
		// And it pushes again the moment the flag comes back.
		layers.publisher[p] = true;
		expect(pushChangedPublishers(pushed, wantedPublishers(), [r.sink])).toBe(true);
		expect(r.calls).toEqual([[p, true]]);
	});
});
