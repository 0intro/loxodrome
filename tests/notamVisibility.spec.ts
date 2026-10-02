/* The NOTAM evaluation window (state/notam.svelte). One window governs the
 * list and the map, and a NOTAM outside it is DEMOTED, not dropped: it leaves
 * visibleNotams for outOfWindowNotams, while filteredNotams keeps it so the
 * detail panels and the link modules stay explainable when a NOTAM lapses.
 *
 * The window test is permissive on purpose: a missing B) or C) item and
 * C) PERM all read as unbounded on that side, so a NOTAM is never hidden
 * because its own dates are incomplete. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import { filter, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';
import {
	filteredNotams,
	notamState,
	outOfWindowNotams,
	visibleNotams,
} from '$lib/state/notam.svelte';

const NOW = '2026-07-31T12:00:00Z';

function notam(id: string, b: string, c: string, e = 'TEST.'): string {
	return `${id}
Q) LFBB/QRTCA/IV/BO/AW/000/055/4500N00100W005
A) LFBD
B) ${b} C) ${c}
E) ${e}
F) SFC
G) 5500FT AMSL
`;
}

// Undated: no B) / C) items at all, the FAA-domestic shape.
const UNDATED = `A0009/26
Q) LFBB/QRTCA/IV/BO/AW/000/055/4500N00100W005
A) LFBD
E) NO DATES AT ALL.
F) SFC
G) 5500FT AMSL
`;

const ENDED = notam('A0001/26', '2601010000', '2601020000', 'ENDED IN JANUARY.');
const IN_FORCE = notam('A0002/26', '2607010000', '2612310000', 'IN FORCE.');
const SOON = notam('A0003/26', '2607311800', '2608010600', 'STARTS IN SIX HOURS.');
const LATER = notam('A0004/26', '2610010000', '2610020000', 'STARTS IN OCTOBER.');
const PERM = notam('A0005/26', '2601010000', 'PERM', 'PERMANENT.');

function seed(...texts: string[]): void {
	notamState.notams = texts.flatMap((t) => parseNotams(t));
	notamState.parsedAt = Date.now();
}

const ids = (list: { notam: { id: string } }[]): string[] =>
	list.map((it) => it.notam.id).sort();

describe('the NOTAM evaluation window', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		filter.window.mode = 'now';
		filter.window.horizonH = DEFAULT_HORIZON_H;
		filter.altitude.enabled = false;
		filter.trafficMode = 'all';
		filter.query = '';
	});

	afterEach(() => {
		vi.useRealTimers();
		notamState.notams = [];
		filter.altitude.enabled = true;
	});

	it('demotes a NOTAM that has ended rather than dropping it', () => {
		seed(ENDED, IN_FORCE);
		expect(ids(visibleNotams())).toEqual(['A0002/26']);
		expect(ids(outOfWindowNotams())).toEqual(['A0001/26']);
		// The panels and the link modules read this one, so a lapsed NOTAM is
		// still explainable and still reachable.
		expect(ids(filteredNotams())).toEqual(['A0001/26', 'A0002/26']);
	});

	it('shows what is scheduled ahead, however far, by default', () => {
		// Unbounded look-ahead: nothing scheduled is withheld until the pilot
		// narrows the period.
		seed(SOON, LATER);
		expect(ids(visibleNotams())).toEqual(['A0003/26', 'A0004/26']);
		expect(outOfWindowNotams()).toEqual([]);
	});

	it('demotes what starts beyond a chosen look-ahead', () => {
		seed(SOON, LATER);
		filter.window.horizonH = 24;
		expect(ids(visibleNotams())).toEqual(['A0003/26']);
		expect(ids(outOfWindowNotams())).toEqual(['A0004/26']);
	});

	it('never hides a NOTAM on its own missing dates', () => {
		// C) PERM and no B)/C) at all both read as unbounded, the permissive
		// rule that keeps FAA-domestic entries on the map.
		seed(PERM, UNDATED);
		expect(ids(visibleNotams())).toEqual(['A0005/26', 'A0009/26']);
		expect(outOfWindowNotams()).toEqual([]);
	});

	it('walks backwards into the past with a custom range', () => {
		seed(ENDED, IN_FORCE);
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-01-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-01-02';
		filter.window.toTime = '00:00';
		expect(ids(visibleNotams())).toEqual(['A0001/26']);
		// The one in force in July is now the one outside the period.
		expect(ids(outOfWindowNotams())).toEqual(['A0002/26']);
	});

	it('composes with the data filters, which subset both sides', () => {
		seed(ENDED, IN_FORCE);
		filter.query = 'ENDED IN JANUARY';
		expect(visibleNotams()).toEqual([]);
		expect(ids(outOfWindowNotams())).toEqual(['A0001/26']);
		expect(ids(filteredNotams())).toEqual(['A0001/26']);
	});

	describe('the filteredNotams memo', () => {
		it('hands back the same array while nothing changes', () => {
			seed(IN_FORCE);
			expect(filteredNotams()).toBe(filteredNotams());
		});

		it('invalidates on a re-parse that leaves the count unchanged', () => {
			// The identity trap: keying on parsedAt (or on a count) would serve
			// the previous briefing's array here, and the failure would read as
			// a parser bug.
			seed(IN_FORCE);
			const first = filteredNotams();
			notamState.notams = parseNotams(IN_FORCE);
			expect(filteredNotams()).not.toBe(first);
			expect(ids(filteredNotams())).toEqual(['A0002/26']);
		});

		it('invalidates when a data filter changes', () => {
			seed(IN_FORCE);
			const first = filteredNotams();
			filter.query = 'nothing matches this';
			expect(filteredNotams()).not.toBe(first);
			expect(filteredNotams()).toEqual([]);
		});
	});
});
