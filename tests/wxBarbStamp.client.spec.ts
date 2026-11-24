/* The hover badge's hour stamp (state/wxTime.svelte.ts wxBarbStamp), in the
 * client runtime, where a derived recomputes only when what it read changes.
 * The barbs of a typed period's start, a stated ETD or a hand-set hour are
 * read at an instant the clock never moves, so the stamp follows the minute
 * tick itself: it appears once the hour it would leave out is past. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(Date.UTC(2026, 10, 18, 14, 10));
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the barb stamp', () => {
	it('stamps a typed period start once the clock is past its hour', async () => {
		const { flushSync } = await import('svelte');
		// The data module first: its module effect reads the NOTAM tick, and a
		// cycle entered from elsewhere runs it before that module is done.
		await import('$lib/state/data.svelte');
		const { filter, setWindowMode } = await import('$lib/state/filter.svelte');
		const { notamState } = await import('$lib/state/notam.svelte');
		const { wxBarbStamp, wxValidTimeMs } = await import('$lib/state/wxTime.svelte');
		const host = await import('./helpers/derivedHost.svelte');
		setWindowMode('custom');
		filter.window.fromDate = '2026-11-18';
		filter.window.fromTime = '14:00';
		filter.window.toDate = '2026-11-18';
		filter.window.toTime = '18:00';
		// What MapView's badge reads: the stamp of the instant shown.
		const stamp = host.mountDerived(() => wxBarbStamp(wxValidTimeMs()));
		flushSync();
		expect(stamp.value()).toBeNull();

		vi.setSystemTime(Date.UTC(2026, 10, 18, 16, 30));
		notamState.tick++;
		flushSync();
		expect(stamp.value()).toBe('2026-11-18 14:00Z');
		stamp.stop();
	});
});
