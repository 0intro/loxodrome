/* The page's side of the decoration worker (map/decoWorkerClient.ts), over a
 * worker stood in by a message recorder, with the timers faked:
 *   - zones cross once each under their number, their arrays handed over,
 *     before the painting that names them; a zone let go on the page is
 *     forgotten in the worker with the next painting; a zone list handed
 *     again is named by the numbers kept for it, sent as a copy, since a
 *     painting's own buffer goes with it;
 *   - it is ready only when the worker says so, and a painting that lands
 *     calls back;
 *   - it gives up for good, once, when the worker cannot paint, fails a
 *     painting, errs, or keeps quiet past a deadline while the page shows,
 *     but never judges a hidden page's worker, nor one whose deadline the
 *     page itself ran late. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecoFrame } from '$lib/map/decoPaint';
import type { FromWorker, ToWorker } from '$lib/map/decoProtocol';
import { DecoWorkerClient, PAINT_TIMEOUT_MS, READY_TIMEOUT_MS, STALL_MS } from '$lib/map/decoWorkerClient';
import type { DecoZone } from '$lib/map/decoZone';

class FakeWorker {
	readonly sent: { msg: ToWorker; transfer: Transferable[] }[] = [];
	terminated = false;
	onmessage: ((e: { data: FromWorker }) => void) | null = null;
	onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	postMessage(msg: ToWorker, transfer: Transferable[]): void {
		this.sent.push({ msg, transfer });
	}
	terminate(): void {
		this.terminated = true;
	}
	answer(data: FromWorker): void {
		this.onmessage?.({ data });
	}
}

/** Visibility, as document reports it. */
const doc = Object.assign(new EventTarget(), { hidden: false });

/** What the page's FinalizationRegistry would report, run by hand. */
let finalize: (gid: number) => void = () => undefined;
class FakeRegistry {
	constructor(cb: (gid: number) => void) {
		finalize = cb;
	}
	register(): void {}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	doc.hidden = false;
	vi.stubGlobal('document', doc);
	vi.stubGlobal('FinalizationRegistry', FakeRegistry);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function zone(key: string): DecoZone {
	return {
		key,
		area: 1,
		bbox: { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 },
		ring: new Float64Array([0, 0, 0, 1, 1, 1, 1, 0]),
		arcs: null,
		internal: null,
		spec: { line: null, band: null, marks: null, glyph: null, labelColor: '#000000', crossEligible: false, minZoom: { band: 0, marks: 0, glyph: 0, label: 0 } },
		label: null,
	};
}

const FRAME: DecoFrame = {
	view: { zoom: 9, originX: 0, originY: 0, paneX: 0, paneY: 0 },
	topLeft: { x: 0, y: 0 },
	size: { x: 800, y: 600 },
	margin: { left: 0, top: 0, right: 0, bottom: 0 },
	dpr: 1,
	labels: true,
	lines: false,
};

function client() {
	const worker = new FakeWorker();
	const frames: number[] = [];
	const downs: string[] = [];
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
	const c = new DecoWorkerClient(worker as unknown as Worker, {
		frame: (seq) => frames.push(seq),
		down: (reason) => downs.push(reason),
	});
	return { c, worker, frames, downs, warn };
}

describe('DecoWorkerClient', () => {
	it('sends each zone once, handed over, before the painting that names it', () => {
		const { c, worker } = client();
		worker.answer({ type: 'ready' });
		expect(c.ready).toBe(true);
		const a = zone('A');
		const b = zone('B');
		const ringA = a.ring.buffer;
		c.paint(1, FRAME, 800, 600, [a, b], [b], []);
		const [zones, paint] = worker.sent;
		expect(zones.msg.type).toBe('zones');
		if (zones.msg.type !== 'zones' || paint.msg.type !== 'paint') {
			throw new Error('unexpected messages');
		}
		expect(zones.msg.zones.map((z) => [z.key, z.gid])).toEqual([
			['A', 1],
			['B', 2],
		]);
		expect(zones.transfer).toContain(ringA);
		expect([...paint.msg.zones]).toEqual([1, 2]);
		expect([...paint.msg.highlighted]).toEqual([2]);
		// The second painting sends no zone again.
		c.paint(2, FRAME, 800, 600, [b, a], [], []);
		expect(worker.sent.slice(2).map((s) => s.msg.type)).toEqual(['paint']);
	});

	it('names a list handed again by the numbers kept for it, sending a copy each time', () => {
		const { c, worker } = client();
		worker.answer({ type: 'ready' });
		const list = [zone('A'), zone('B')];
		const named: number[][] = [];
		for (let seq = 1; seq <= 3; seq++) {
			c.paint(seq, FRAME, 800, 600, list, [], []);
			const last = worker.sent.at(-1);
			if (last?.msg.type !== 'paint') {
				throw new Error('no painting');
			}
			named.push([...last.msg.zones]);
			// As postMessage does: the painting's buffers go with it.
			structuredClone(last.msg, { transfer: last.transfer });
		}
		expect(named).toEqual([
			[1, 2],
			[1, 2],
			[1, 2],
		]);
		expect(worker.sent.filter((s) => s.msg.type === 'zones')).toHaveLength(1);
	});

	it('tells the worker to forget a zone the page let go, with the next painting', () => {
		const { c, worker } = client();
		worker.answer({ type: 'ready' });
		c.paint(1, FRAME, 800, 600, [zone('A')], [], []);
		finalize(1);
		c.paint(2, FRAME, 800, 600, [zone('C')], [], []);
		const types = worker.sent.slice(2).map((s) => s.msg);
		expect(types[0]).toMatchObject({ type: 'forget' });
		if (types[0].type === 'forget') {
			expect([...types[0].gids]).toEqual([1]);
		}
	});

	it('calls back when a painting lands, and keeps the worker', () => {
		const { c, worker, frames, downs } = client();
		worker.answer({ type: 'ready' });
		c.paint(4, FRAME, 800, 600, [zone('A')], [], []);
		worker.answer({ type: 'frame', seq: 4, bitmap: {} as ImageBitmap });
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS * 3);
		expect(frames).toEqual([4]);
		expect(downs).toEqual([]);
	});

	for (const [what, act, reason] of [
		['says it cannot paint here', (w: FakeWorker) => w.answer({ type: 'unsupported', reason: 'text' }), 'unsupported: text'],
		['fails a painting', (w: FakeWorker) => w.answer({ type: 'failed', seq: 1, reason: 'zone 9 unknown' }), 'failed: zone 9 unknown'],
		['errs', (w: FakeWorker) => w.onerror?.({ message: 'boom', preventDefault: () => undefined }), 'error: boom'],
	] as const) {
		it(`gives up for good, once, when the worker ${what}`, () => {
			const { c, worker, downs, warn } = client();
			act(worker);
			act(worker);
			expect(downs).toEqual([reason]);
			expect(worker.terminated).toBe(true);
			expect(c.ready).toBe(false);
			expect(warn).toHaveBeenCalledTimes(1);
		});
	}

	it('keeps a ready worker with nothing to paint, however long', () => {
		const { c, worker, downs } = client();
		worker.answer({ type: 'ready' });
		vi.advanceTimersByTime(READY_TIMEOUT_MS * 3);
		expect(downs).toEqual([]);
		expect(c.ready).toBe(true);
	});

	it('gives up on a worker that never says ready while the page shows', () => {
		const { downs } = client();
		vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
		expect(downs).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(downs).toEqual(['ready-timeout']);
	});

	it('does not judge a hidden page’s worker, and restarts the clock when it shows', () => {
		const { c, worker, downs } = client();
		worker.answer({ type: 'ready' });
		c.paint(1, FRAME, 800, 600, [zone('A')], [], []);
		doc.hidden = true;
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS * 10);
		expect(downs).toEqual([]);
		doc.hidden = false;
		doc.dispatchEvent(new Event('visibilitychange'));
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS - 1);
		expect(downs).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(downs).toEqual(['paint-timeout']);
	});

	it('does not judge the worker on a deadline the page ran late, and judges it on the next', () => {
		const { c, worker, downs } = client();
		worker.answer({ type: 'ready' });
		c.paint(1, FRAME, 800, 600, [zone('A')], [], []);
		// A long task on the main thread: the wall clock runs on and no timer
		// fires, so the deadline fires late when the page runs again.
		vi.setSystemTime(Date.now() + STALL_MS + 1);
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS);
		expect(downs).toEqual([]);
		// The deadline starts again: a worker that never answers is still
		// given up, one deadline later.
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS - 1);
		expect(downs).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(downs).toEqual(['paint-timeout']);
	});

	it('takes a deadline only a little late as a verdict', () => {
		const { c, worker, downs } = client();
		worker.answer({ type: 'ready' });
		c.paint(1, FRAME, 800, 600, [zone('A')], [], []);
		vi.setSystemTime(Date.now() + STALL_MS);
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS);
		expect(downs).toEqual(['paint-timeout']);
	});

	it('takes the answer queued behind a stall, and keeps the worker', () => {
		const { c, worker, downs, frames } = client();
		worker.answer({ type: 'ready' });
		c.paint(1, FRAME, 800, 600, [zone('A')], [], []);
		vi.setSystemTime(Date.now() + 3 * PAINT_TIMEOUT_MS);
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS);
		worker.answer({ type: 'frame', seq: 1, bitmap: {} as ImageBitmap });
		vi.advanceTimersByTime(PAINT_TIMEOUT_MS * 3);
		expect(frames).toEqual([1]);
		expect(downs).toEqual([]);
		expect(c.ready).toBe(true);
	});

	it('reports nothing once disposed, not even a message posted before', () => {
		const { c, worker, downs, frames } = client();
		const late = worker.onmessage;
		c.dispose();
		late?.({ data: { type: 'frame', seq: 1, bitmap: {} as ImageBitmap } });
		vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
		expect(worker.terminated).toBe(true);
		expect(worker.onmessage).toBeNull();
		expect(downs).toEqual([]);
		expect(frames).toEqual([]);
	});
});
