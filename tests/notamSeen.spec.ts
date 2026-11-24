/* What a refresh brings since the NOTAMs list last showed the briefing
 * (state/notam.svelte.ts markSeen, newNotamKeys). Nothing reads as new
 * until a list has shown a briefing. After it, a NOTAM the next briefing
 * holds beyond it is new, a re-numbered or re-labelled copy of one it held
 * is not, and the marks clear the next time the pilot leaves the list. The
 * record rides the kept briefing. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
}));

const { clearNotams, commitBriefing, isNewNotam, markSeen, newNotamKeys, notamState, restoreBriefing, snapshotBriefing } =
	await import('$lib/state/notam.svelte');
const { newListedCount, newListedNotams } = await import('$lib/state/notamOrder.svelte');
const { filter } = await import('$lib/state/filter.svelte');
import type { BriefingSnapshot } from '$lib/state/notam.svelte';

function notam(id: string, a = 'LFPN'): string {
	return [`${id} NOTAMN`, 'Q) LFFF/QMRLC/IV/NBO/A/000/999/4845N00207E005', `A) ${a} B) 2601010000 C) PERM`, 'E) RWY CLSD.'].join('\n');
}

const fetch = (...blocks: string[]): void =>
	commitBriefing(blocks.join('\n\n'), { source: 'sofia', kind: 'route', briefed: null });

const ids = () => notamState.notams.filter(isNewNotam).map((n) => n.id);

beforeEach(() => {
	clearNotams();
	notamState.seen = null;
});

describe('the new NOTAMs', () => {
	it('are none until a list has shown a briefing', () => {
		fetch(notam('A0001/26'));
		expect(newNotamKeys()).toBeNull();
		fetch(notam('A0001/26'), notam('A0002/26'));
		expect(ids()).toEqual([]);
	});

	it('are what a refresh brings beyond the briefing the list showed', () => {
		fetch(notam('A0001/26'), notam('A0002/26', 'LFOZ'));
		markSeen();
		fetch(notam('A0001/26'), notam('A0002/26', 'LFOZ'), notam('A0003/26'));
		expect(ids()).toEqual(['A0003/26']);
		expect(newNotamKeys()?.size).toBe(1);
	});

	it('leave out a copy of one it showed under another label', () => {
		fetch(notam('LFFA-A0001/26'));
		markSeen();
		fetch(notam('A0001/26'));
		expect(ids()).toEqual([]);
	});

	it('clear the next time the pilot leaves the list, and outlive a Clear', () => {
		fetch(notam('A0001/26'));
		markSeen();
		fetch(notam('A0001/26'), notam('A0002/26'));
		markSeen();
		expect(ids()).toEqual([]);
		clearNotams();
		fetch(notam('A0002/26'), notam('A0004/26'));
		expect(ids()).toEqual(['A0004/26']);
	});

	it('ride the kept briefing', () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(Date.UTC(2026, 10, 24, 20, 2));
		fetch(notam('A0001/26'));
		markSeen();
		fetch(notam('A0001/26'), notam('A0005/26'));
		const doc = snapshotBriefing() as BriefingSnapshot;
		clearNotams();
		notamState.seen = null;
		restoreBriefing(doc);
		expect(snapshotBriefing()?.seen?.at).toBe(Date.UTC(2026, 10, 24, 20, 2));
		expect(ids()).toEqual(['A0005/26']);
		vi.useRealTimers();
	});
});

describe('what the line, the dot and the New group count', () => {
	it('is the new NOTAMs the list shows, a filter’s hidden ones left out', () => {
		const ifr = (id: string) =>
			[`${id} NOTAMN`, 'Q) LFFF/QMRLC/I/NBO/A/000/999/4845N00207E005', 'A) LFPN B) 2601010000 C) PERM', 'E) RWY CLSD.'].join('\n');
		const mode = filter.trafficMode;
		filter.trafficMode = 'vfr';
		fetch(notam('A0001/26'));
		markSeen();
		fetch(notam('A0001/26'), notam('A0002/26'), ifr('A0003/26'));
		expect(newNotamKeys()?.size).toBe(2);
		expect(newListedNotams().map((i) => i.notam.id)).toEqual(['A0002/26']);
		expect(newListedCount()).toBe(1);
		filter.trafficMode = mode;
	});
});
