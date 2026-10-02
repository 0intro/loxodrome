/* The one schedule for the dataset reads worth repeating
 * (src/lib/state/dataRetry.svelte.ts): when a failed read is asked again,
 * when it is not, and what the banner is told.
 *
 * Each case imports a fresh module graph after stubbing the page it listens
 * to (a document, a window and a navigator of its own), so no case hears
 * another's events. The clock is faked with setTimeout, clearTimeout and
 * Date only: the retries' promises run on microtasks between two timers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Page = EventTarget & { visibilityState: DocumentVisibilityState };

let doc: Page;
let win: EventTarget;
let nav: { onLine: boolean | undefined };
let r: typeof import('$lib/state/dataRetry.svelte');
let t0 = 0;

// The read's error class from the case's own module graph (each case resets
// it): the schedule tells a failure that may pass by its class.
let DataReadError: typeof import('$lib/data/fetchData').DataReadError;

/** A failure that may pass: the network's, a server's "not now". */
const err = (m = 'down'): Error => new DataReadError('/data/x.json', m, { status: 503, transient: true });
/** A fact about the document: one that does not parse. */
const fact = (m = 'bad'): Error => new DataReadError('/data/x.json', m, { status: 200, transient: false });

beforeEach(async () => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
	t0 = Date.now();
	doc = new EventTarget() as Page;
	doc.visibilityState = 'visible';
	win = new EventTarget();
	nav = { onLine: true };
	vi.stubGlobal('document', doc);
	vi.stubGlobal('window', win);
	vi.stubGlobal('navigator', nav);
	r = await import('$lib/state/dataRetry.svelte');
	({ DataReadError } = await import('$lib/data/fetchData'));
});

afterEach(() => {
	r.resetDataRetryForTest();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** A retry that fails until told otherwise, noting when it ran. */
function failing(key: string, group: import('$lib/state/dataRetry.svelte').RetryGroup = 'airspaces') {
	const at: number[] = [];
	let lands = false;
	const retry = vi.fn(() => {
		at.push(Date.now());
		if (lands) {
			r.retryCleared(key);
			return Promise.resolve();
		}
		r.retryWhenDue(key, { group, parts: ['de'], error: err() }, retry);
		return Promise.reject(err());
	});
	r.retryWhenDue(key, { group, parts: ['de'], error: err() }, retry);
	return {
		retry,
		at,
		land: () => {
			lands = true;
		},
	};
}

describe('the waits', () => {
	it('are 5 s, 15 s, a minute, then doubling to five minutes', async () => {
		const f = failing('airspaces');
		await vi.advanceTimersByTimeAsync(4_999);
		expect(f.retry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1 + 15_000 + 60_000 + 120_000 + 240_000 + 300_000 + 300_000);
		const gaps = f.at.map((t, i) => t - (i === 0 ? t0 : f.at[i - 1]));
		expect(gaps).toEqual([5_000, 15_000, 60_000, 120_000, 240_000, 300_000, 300_000]);
	});

	it('end when the read lands, and nothing runs again', async () => {
		const f = failing('airspaces');
		f.land();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(f.retry).toHaveBeenCalledTimes(1);
		expect(r.retryPending('airspaces')).toBe(false);
		expect(r.dataRetry.pending).toEqual([]);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(f.retry).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('keep their own pace per read: a new failure waits 5 s, whatever the others wait', async () => {
		const a = failing('airspaces');
		await vi.advanceTimersByTimeAsync(5_000 + 15_000);
		expect(a.at).toHaveLength(2);
		const b = failing('obstacles', 'obstacles');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(b.at).toEqual([Date.now()]);
		expect(a.at).toHaveLength(2);
	});

	it('are not reset by the same read failing again, only by a gesture or the network', async () => {
		const f = failing('airspaces');
		// A coverage pass fails the same read again while it waits.
		await vi.advanceTimersByTimeAsync(3_000);
		r.retryWhenDue('airspaces', { group: 'airspaces', parts: ['de', 'at'], error: err() }, f.retry);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(f.at).toEqual([t0 + 5_000]);
	});
});

describe('the parts of a published dataset', () => {
	/** A store whose parts fail until landed, reporting what it lacks after
	 *  every attempt the way data.svelte.ts reportGaps does. */
	function store(group: import('$lib/state/dataRetry.svelte').RetryGroup = 'airspaces') {
		const failing = new Set<string>();
		const asked: { part: string; at: number }[] = [];
		const report = (): void => {
			r.retryParts(
				group,
				[...failing].map((part) => ({ part, error: err(), wanted: part !== 'far' })),
				retryPart,
			);
		};
		const retryPart = (part: string): Promise<void> => {
			asked.push({ part, at: Date.now() });
			report();
			return failing.has(part) ? Promise.reject(err()) : Promise.resolve();
		};
		return {
			asked,
			fail: (part: string) => {
				failing.add(part);
				report();
			},
			land: (part: string) => {
				failing.delete(part);
			},
			times: (part: string) => asked.filter((a) => a.part === part).map((a) => a.at),
		};
	}

	it('keep their own pace: a country failing anew waits 5 s, whatever another waits', async () => {
		const s = store();
		s.fail('it');
		await vi.advanceTimersByTimeAsync(5_000 + 15_000 + 60_000);
		expect(s.times('it')).toEqual([t0 + 5_000, t0 + 20_000, t0 + 80_000]);
		// Italy now waits two minutes. Austria comes into the view and fails.
		s.fail('at');
		const joined = Date.now();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(s.times('at')).toEqual([joined + 5_000]);
		expect(s.times('it')).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(s.times('it')).toEqual([t0 + 5_000, t0 + 20_000, t0 + 80_000, t0 + 200_000]);
	});

	it('are announced each after its own first retry, never on joining', async () => {
		const s = store();
		s.fail('it');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['it'] }]);
		s.fail('at');
		expect(r.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['it'] }]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['it', 'at'] }]);
	});

	it('are each read alone, and forgotten once landed', async () => {
		const s = store();
		s.fail('it');
		s.fail('at');
		s.land('it');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(s.asked.map((a) => a.part).sort()).toEqual(['at', 'it']);
		expect(r.retryPending('airspaces:it')).toBe(false);
		expect(r.retryPending('airspaces:at')).toBe(true);
		// A part never refuses the dataset's own ensure: it is published.
		expect(r.retryRefusal('airspaces')).toBeNull();
	});

	it('count only where they matter to the pilot', async () => {
		const s = store();
		s.fail('far');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.retryingGroup('airspaces')).toBe(false);
		expect(r.bannerEntries()).toBeNull();
		s.fail('it');
		expect(r.retryingGroup('airspaces')).toBe(true);
	});
});

describe('a fact about the document', () => {
	it('is asked again at the longest wait, from the start', async () => {
		const retry = vi.fn(() => {
			r.retryWhenDue('x', { group: 'airports', parts: [], error: fact() }, retry);
			return Promise.reject(fact());
		});
		r.retryWhenDue('x', { group: 'airports', parts: [], error: fact() }, retry);
		await vi.advanceTimersByTimeAsync(299_999);
		expect(retry).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1 + 300_000);
		expect(retry).toHaveBeenCalledTimes(2);
		// A refusal meanwhile: an ensure asking on every fix reads nothing.
		expect(r.retryRefusal('x')).not.toBeNull();
	});

	it('keeps the longest wait after a gesture asked it again', async () => {
		const retry = vi.fn(() => {
			r.retryWhenDue('x', { group: 'airports', parts: [], error: fact() }, retry);
			return Promise.reject(fact());
		});
		r.retryWhenDue('x', { group: 'airports', parts: [], error: fact() }, retry);
		await r.retryDataNow();
		expect(retry).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(299_999);
		expect(retry).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(retry).toHaveBeenCalledTimes(2);
	});
});

describe('the refusal', () => {
	it('answers the failure while a retry is pending, then lets the read go', async () => {
		const e = err('/data/x.json: HTTP 503');
		r.retryWhenDue('x', { group: 'airports', parts: [], error: e }, () => {
			r.retryCleared('x');
		});
		expect(r.retryPending('x')).toBe(true);
		expect(r.retryRefusal('x')).toBe(e);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.retryRefusal('x')).toBeNull();
	});
});

describe('a hidden page', () => {
	it('asks nothing, and on return asks only what came due', async () => {
		const a = failing('airspaces');
		doc.visibilityState = 'hidden';
		await vi.advanceTimersByTimeAsync(600_000);
		expect(a.retry).not.toHaveBeenCalled();
		const b = failing('obstacles', 'obstacles'); // due in 5 s, not yet
		doc.visibilityState = 'visible';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(a.retry).toHaveBeenCalledTimes(1);
		expect(b.retry).not.toHaveBeenCalled();
	});

	it('asks nothing on return when nothing is pending', async () => {
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('a hidden page and the network', () => {
	it('reads nothing when the network comes back hidden, and all of it on return', async () => {
		const f = failing('airspaces');
		doc.visibilityState = 'hidden';
		await vi.advanceTimersByTimeAsync(5_000 + 15_000);
		expect(f.retry).not.toHaveBeenCalled();
		win.dispatchEvent(new Event('online'));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.retry).not.toHaveBeenCalled();
		doc.visibilityState = 'visible';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.retry).toHaveBeenCalledTimes(1);
	});

	it('reads nothing on return while the browser knows it is offline, and tells the banner', async () => {
		const f = failing('airspaces');
		doc.visibilityState = 'hidden';
		await vi.advanceTimersByTimeAsync(20_000);
		nav.onLine = false;
		doc.visibilityState = 'visible';
		doc.dispatchEvent(new Event('visibilitychange'));
		await vi.advanceTimersByTimeAsync(0);
		expect(f.retry).not.toHaveBeenCalled();
		expect(r.dataRetry.pending[0]?.announced).toBe(true);
	});
});

describe('a clock moved back', () => {
	it('never holds a retry past the longest wait', async () => {
		const f = failing('airspaces');
		vi.setSystemTime(new Date(t0 - 3_600_000));
		r.retryWhenDue('other', { group: 'obstacles', parts: [], error: err() }, () => Promise.reject(err()));
		await vi.advanceTimersByTimeAsync(300_000);
		expect(f.retry).toHaveBeenCalled();
	});
});

describe('an offline browser', () => {
	it('is not asked, and the network coming back asks at once and starts the waits over', async () => {
		nav.onLine = false;
		const f = failing('airspaces');
		await vi.advanceTimersByTimeAsync(600_000);
		expect(f.retry).not.toHaveBeenCalled();
		// The round that could not run still tells the banner.
		expect(r.dataRetry.pending[0]?.announced).toBe(true);
		nav.onLine = true;
		const back = Date.now();
		win.dispatchEvent(new Event('online'));
		expect(f.at).toEqual([back]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(f.at).toEqual([back, back + 5_000]);
	});

	it('reads undefined onLine (no browser) as online', async () => {
		nav.onLine = undefined;
		const f = failing('airspaces');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(f.retry).toHaveBeenCalledTimes(1);
	});
});

describe('the mirror', () => {
	it('keeps its array while nothing it says changes', () => {
		// Every coverage pass reports its gaps, empty ones included: a fresh
		// array each time woke every reader on each pan.
		const before = r.dataRetry.pending;
		r.retryParts('airspaces', [], () => {});
		r.retryParts('obstacles', [], () => {});
		expect(r.dataRetry.pending).toBe(before);
		r.retryParts('airspaces', [{ part: 'de', error: err(), wanted: true }], () => {});
		const one = r.dataRetry.pending;
		expect(one.map((p) => p.key)).toEqual(['airspaces:de']);
		r.retryParts('airspaces', [{ part: 'de', error: err(), wanted: true }], () => {});
		expect(r.dataRetry.pending).toBe(one);
		r.retryParts('airspaces', [{ part: 'de', error: err(), wanted: false }], () => {});
		expect(r.dataRetry.pending).not.toBe(one);
		expect(r.dataRetry.pending[0]?.quiet).toBe(true);
	});
});

describe('a gesture', () => {
	it('asks every pending read now, synchronously, whatever the browser says', () => {
		nav.onLine = false;
		const a = failing('airspaces');
		const b = failing('obstacles', 'obstacles');
		void r.retryDataNow();
		expect(a.retry).toHaveBeenCalledTimes(1);
		expect(b.retry).toHaveBeenCalledTimes(1);
	});

	it("a print's asks only the groups it reads, and only the parts known to matter", async () => {
		// A print awaited every pending read, a far country nobody is told
		// about and the chart indexes included, each up to a stalled read's
		// 30 s: the nav log's print, which has no Cancel, sat behind them.
		const near = failing('obstacles:fr', 'obstacles');
		const charts = failing('charts:uk', 'charts');
		const far = vi.fn(() => new Promise<void>(() => {}));
		r.retryParts('airspaces', [{ part: 'is', error: err(), wanted: false }], far);
		const asked = r.retryDataNow({ groups: ['obstacles', 'airspaces'], wantedOnly: true });
		expect(near.retry).toHaveBeenCalledTimes(1);
		expect(charts.retry).not.toHaveBeenCalled();
		expect(far).not.toHaveBeenCalled();
		// Settled without the stalled far read, which was never asked.
		await expect(asked).resolves.toBeUndefined();
		// The rest keep their own schedule.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(charts.retry).toHaveBeenCalledTimes(1);
		expect(far).toHaveBeenCalledTimes(1);
	});

	it('judges a quiet part again when a print asks, on the areas as they stand', () => {
		// Quiet was the last report's judgement: an aerodrome added just
		// before the print put the country back in the plan's areas, and the
		// print, asking only what matters, skipped it until a coverage pass
		// reported again.
		let near = false;
		const part = vi.fn(() => Promise.resolve());
		r.retryParts('obstacles', [{ part: 'at', error: err(), wanted: false, judge: () => near }], part);
		expect(r.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(true);
		void r.retryDataNow({ groups: ['obstacles'], wantedOnly: true });
		expect(part).not.toHaveBeenCalled();
		near = true;
		void r.retryDataNow({ groups: ['obstacles'], wantedOnly: true });
		expect(part).toHaveBeenCalledTimes(1);
		expect(r.dataRetry.pending.find((p) => p.key === 'obstacles:at')?.quiet).toBe(false);
	});

	it('never doubles a retry in flight', async () => {
		let release!: () => void;
		const retry = vi.fn(
			() =>
				new Promise<void>((res) => {
					release = res;
				}),
		);
		r.retryWhenDue('x', { group: 'airports', parts: [], error: err() }, retry);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(retry).toHaveBeenCalledTimes(1);
		void r.retryDataNow();
		win.dispatchEvent(new Event('online'));
		expect(retry).toHaveBeenCalledTimes(1);
		release();
		await vi.advanceTimersByTimeAsync(0);
	});

	it('resolves once every read it started, and every one running, has settled', async () => {
		let release!: () => void;
		const running = vi.fn(
			() =>
				new Promise<void>((res) => {
					release = res;
				}),
		);
		r.retryWhenDue('x', { group: 'airports', parts: [], error: err() }, running);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(running).toHaveBeenCalledTimes(1);
		const other = vi.fn(() => {
			r.retryCleared('y');
			return Promise.resolve();
		});
		r.retryWhenDue('y', { group: 'obstacles', parts: [], error: err() }, other);
		let settled = false;
		void r.retryDataNow().then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(other).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		r.retryCleared('x');
		release();
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
	});

	it('counts a retry that throws as one that failed', async () => {
		const retry = vi.fn(() => {
			throw err();
		});
		r.retryWhenDue('x', { group: 'airports', parts: [], error: err() }, retry);
		await vi.advanceTimersByTimeAsync(5_000 + 15_000);
		expect(retry).toHaveBeenCalledTimes(2);
		expect(r.dataRetry.pending[0]?.announced).toBe(true);
	});
});

describe('the banner', () => {
	it('is told once a first retry did not land, never before', async () => {
		failing('airspaces');
		expect(r.dataRetry.pending[0]?.announced).toBe(false);
		expect(r.bannerEntries()).toBeNull();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([{ group: 'airspaces', parts: ['de'] }]);
	});

	it('is never told of a read that landed at its first retry', async () => {
		const f = failing('airspaces');
		f.land();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toBeNull();
	});

	it('groups in its own order and merges the parts, a whole group taking no names', async () => {
		r.retryWhenDue('obstacles', { group: 'obstacles', parts: [], error: err() }, () => Promise.reject(err()));
		r.retryWhenDue('airspaces', { group: 'airspaces', parts: ['de', 'at'], error: err() }, () =>
			Promise.reject(err()),
		);
		r.retryWhenDue('charts:uk', { group: 'charts', parts: [], error: err() }, () => Promise.reject(err()));
		r.retryWhenDue('quiet', { group: 'navaids', parts: [], error: err(), quiet: true }, () =>
			Promise.reject(err()),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([
			{ group: 'airspaces', parts: ['de', 'at'] },
			{ group: 'obstacles', parts: [] },
			{ group: 'charts', parts: [] },
		]);
		expect(r.retryingGroup('airspaces')).toBe(true);
		expect(r.retryingGroup('navaids')).toBe(false);
	});

	it('stays dismissed until something new fails, and forgets it once nothing is pending', async () => {
		const a = failing('airspaces');
		await vi.advanceTimersByTimeAsync(5_000);
		r.dismissDataRetry();
		expect(r.bannerEntries()).toBeNull();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(r.bannerEntries()).toBeNull();
		failing('obstacles', 'obstacles');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()?.map((e) => e.group)).toEqual(['airspaces', 'obstacles']);
		a.land();
		r.retryCleared('obstacles');
		void r.retryDataNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(r.dataRetry.pending).toEqual([]);
		expect(r.dataRetry.dismissed).toEqual([]);
	});
});

describe('the dismissal', () => {
	it('is per read: another read of the same group failing is news', async () => {
		r.retryWhenDue('charts:fr', { group: 'charts', parts: ['fr'], error: err() }, () => Promise.reject(err()));
		await vi.advanceTimersByTimeAsync(5_000);
		r.dismissDataRetry();
		expect(r.bannerEntries()).toBeNull();
		r.retryWhenDue('charts:uk', { group: 'charts', parts: ['uk'], error: err() }, () => Promise.reject(err()));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([{ group: 'charts', parts: ['fr', 'uk'] }]);
	});

	it('forgets a read no longer pending, which failing again is news', async () => {
		r.retryWhenDue('fuel', { group: 'fuel', parts: [], error: err() }, () => Promise.reject(err()));
		r.retryWhenDue('far', { group: 'navaids', parts: [], error: err(), quiet: true }, () => Promise.reject(err()));
		await vi.advanceTimersByTimeAsync(5_000);
		r.dismissDataRetry();
		r.retryCleared('fuel');
		expect(r.dataRetry.dismissed).toEqual([]);
		r.retryWhenDue('fuel', { group: 'fuel', parts: [], error: err() }, () => Promise.reject(err()));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(r.bannerEntries()).toEqual([{ group: 'fuel', parts: [] }]);
	});
});

describe('without a page', () => {
	it('imports and runs its rounds', async () => {
		r.resetDataRetryForTest();
		vi.unstubAllGlobals();
		vi.resetModules();
		const bare = await import('$lib/state/dataRetry.svelte');
		({ DataReadError } = await import('$lib/data/fetchData'));
		const retry = vi.fn(() => Promise.reject(err()));
		bare.retryWhenDue('x', { group: 'airports', parts: [], error: err() }, retry);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(retry).toHaveBeenCalledTimes(1);
		bare.resetDataRetryForTest();
	});
});
