/* The notice's clock (state/briefing.svelte.ts noticeClock), as the rail's
 * dot, the phone's Brief dot and the map notice read it: the minute tick,
 * and a wake once the plan has held still 15 s, which the row and the dots
 * wait for with the switch off. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const { flushSync } = await import('svelte');
await import('$lib/state/data.svelte');
const { briefingWatch } = await import('$lib/state/briefing.svelte');
const { STILL_MS } = await import('$lib/notam/briefingRefresh');
const { mountNoticeClock } = await import('./helpers/noticeClockHost.svelte');

const T = Date.UTC(2026, 10, 24, 15, 0);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
	vi.setSystemTime(T);
});
afterEach(() => {
	vi.useRealTimers();
	briefingWatch.planSince = 0;
});

describe('the notice clock', () => {
	it('wakes once the plan has held still, between two minute ticks', async () => {
		briefingWatch.planSince = T;
		const clock = mountNoticeClock();
		try {
			flushSync();
			expect(clock.now()).toBe(T);
			await vi.advanceTimersByTimeAsync(STILL_MS + 100);
			flushSync();
			expect(clock.now()).toBeGreaterThanOrEqual(T + STILL_MS);
		} finally {
			clock.stop();
		}
	});

	it('is what the rail, the Brief destination and the map notice read', () => {
		for (const f of [
			'src/lib/components/Sidebar.svelte',
			'src/lib/components/phone/PhoneNavBar.svelte',
			'src/lib/components/NavStrip.svelte',
		]) {
			expect(readFileSync(f, 'utf8'), f).toMatch(/const clock = noticeClock\((true)?\);/);
		}
	});
});
