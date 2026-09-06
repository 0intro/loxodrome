/* The memo contracts of the selectors downstream of filteredNotams().
 *
 * Every one of these walks the whole briefing, and about thirty always-live
 * consumers read them: the map layers, the list, the cue rings, the link
 * panels. The minute heartbeat re-evaluates all of them at once, so each has
 * to hand back the SAME reference while its inputs hold, and each has to
 * invalidate on a re-parse that happens to yield the same count.
 *
 * That second case is the trap tests/notamVisibility.spec.ts names for
 * filteredNotams: keying on parsedAt or on a length would serve the previous
 * briefing's answer here, and the failure would read as a parser bug. These
 * specs pin the same rule one layer out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams, notamSections, notamEText } from '$lib/notam';
import { filter } from '$lib/state/filter.svelte';
import {
	filteredNotams,
	firNotamIndex,
	notamOwner,
	notamsByIdent,
	notamState,
	outOfWindowNotams,
	visibleNotams,
} from '$lib/state/notam.svelte';
import { orderedNotamOwnerSections, orderedVisibleNotams } from '$lib/state/notamOrder.svelte';
import { dataState } from '$lib/state/data.svelte';
import { activatedAirspaceIds, activatedAirspaceLinks } from '$lib/state/notamLinks.svelte';
import type { Notam } from '$lib/notam/types';

const NOW = '2026-07-31T12:00:00Z';

const AERODROME = `A0002/26
Q) LFBB/QRTCA/IV/BO/A/000/055/4500N00100W005
A) LFBD
B) 2607010000 C) 2612310000
E) IN FORCE.
F) SFC
G) 5500FT AMSL
`;

const ENROUTE = `W0001/26
Q) LFBB/QRTCA/IV/BO/W/000/055/4500N00100W005
A) LFBB
B) 2607010000 C) 2612310000
E) EN ROUTE, FIR OWNED.
`;

const LAPSED = `A0001/26
Q) LFBB/QRTCA/IV/BO/A/000/055/4500N00100W005
A) LFBD
B) 2601010000 C) 2601020000
E) ENDED IN JANUARY.
`;

const ACTIVATION = `A0007/26
Q) LFBB/QRRCA/IV/BO/W/000/055/4500N00100W005
A) LFBB
B) 2607010000 C) 2612310000
E) LF-R262 ACTIVE.
`;

function seed(...texts: string[]): void {
	notamState.notams = texts.flatMap((t) => parseNotams(t));
	notamState.parsedAt = Date.now();
}

describe('the selectors downstream of filteredNotams', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		filter.window.mode = 'now';
		filter.query = '';
		seed(AERODROME, ENROUTE, LAPSED, ACTIVATION);
	});

	afterEach(() => {
		vi.useRealTimers();
		notamState.notams = [];
		notamState.parsedAt = 0;
		filter.query = '';
	});

	/* Each entry: the selector, and whether its result is compared by
	 * reference. Everything here is memoised on the filtered set's identity,
	 * so one table drives the three shared contracts. */
	const selectors: [string, () => unknown][] = [
		['visibleNotams', visibleNotams],
		['outOfWindowNotams', outOfWindowNotams],
		['notamsByIdent', notamsByIdent],
		['firNotamIndex', firNotamIndex],
		['orderedVisibleNotams', orderedVisibleNotams],
		['orderedNotamOwnerSections', orderedNotamOwnerSections],
		['activatedAirspaceLinks', activatedAirspaceLinks],
	];

	for (const [name, run] of selectors) {
		describe(name, () => {
			it('hands back the same result while nothing changes', () => {
				expect(run()).toBe(run());
			});

			it('invalidates on a re-parse that leaves the count unchanged', () => {
				const first = run();
				notamState.notams = parseNotams(AERODROME + ENROUTE + LAPSED + ACTIVATION);
				expect(run()).not.toBe(first);
			});

			it('invalidates when a data filter changes', () => {
				const first = run();
				filter.query = 'nothing matches this';
				expect(run()).not.toBe(first);
			});
		});
	}

	it('splits the window into two halves that partition the filtered set', () => {
		const inside = visibleNotams();
		const outside = outOfWindowNotams();
		expect(inside.length + outside.length).toBe(filteredNotams().length);
		expect(inside.map((it) => it.notam.id)).not.toContain('A0001/26');
		expect(outside.map((it) => it.notam.id)).toContain('A0001/26');
	});

	it('re-splits when the window moves without the briefing changing', () => {
		const items = filteredNotams();
		const first = visibleNotams();
		// A custom range that reaches back over the lapsed NOTAM: the filtered
		// set is untouched, so only the window key may invalidate the split.
		filter.window.mode = 'custom';
		filter.window.fromDate = '2026-01-01';
		filter.window.fromTime = '00:00';
		filter.window.toDate = '2026-12-31';
		filter.window.toTime = '00:00';
		const after = visibleNotams();
		expect(filteredNotams()).toBe(items);
		expect(after).not.toBe(first);
		expect(after.map((it) => it.notam.id)).toContain('A0001/26');
		filter.window.mode = 'now';
	});

	it('re-sorts when the ownership datasets move under an unchanged visible set', () => {
		// A boot sorts the briefing before the airspace / airport datasets
		// land; when they do, the visible set is the same array, and only
		// the ownership resolvers changed. The order must follow them, or a
		// FIR-owned NOTAM stays filed under an aerodrome block until the
		// window moves.
		const items = visibleNotams();
		const first = orderedVisibleNotams();
		const sections = orderedNotamOwnerSections();
		dataState.revision.airports++;
		expect(visibleNotams()).toBe(items);
		expect(orderedVisibleNotams()).not.toBe(first);
		expect(orderedNotamOwnerSections()).not.toBe(sections);
	});

	it('classifies an owner once per NOTAM and keeps the answer', () => {
		const n = notamState.notams[0];
		const owner = notamOwner(n);
		expect(notamOwner(n)).toBe(owner);
		expect(owner).toEqual({ kind: 'aerodrome', ident: 'LFBD' });
	});

	it('still separates aerodrome-owned from FIR-owned NOTAMs', () => {
		const owners = notamState.notams.map((n) => notamOwner(n).kind);
		expect(owners).toContain('aerodrome');
		expect(owners).toContain('fir');
	});
});

describe('the per-NOTAM parse caches', () => {
	afterEach(() => {
		notamState.notams = [];
	});

	it('parses a NOTAM’s sections once and hands back the same object', () => {
		const [n] = parseNotams(AERODROME);
		expect(notamSections(n)).toBe(notamSections(n));
		expect(notamEText(n)).toContain('IN FORCE');
	});

	it('tolerates a NOTAM with no body text', () => {
		// Several specs build a Notam literal without fullContent; a cache
		// consulted during a render must not throw on one.
		const bare = { id: 'X0001/26' } as unknown as Notam;
		expect(notamSections(bare)).toEqual({});
		expect(notamEText(bare)).toBe('');
	});

	it('extracts activated airspace ids once per NOTAM', () => {
		const [n] = parseNotams(ACTIVATION);
		const ids = activatedAirspaceIds(n);
		expect(ids).toContain('LFR262');
		expect(activatedAirspaceIds(n)).toBe(ids);
	});

	it('gives a fresh answer to a fresh parse of the same text', () => {
		const [first] = parseNotams(ACTIVATION);
		const [second] = parseNotams(ACTIVATION);
		expect(second).not.toBe(first);
		expect(activatedAirspaceIds(second)).not.toBe(activatedAirspaceIds(first));
		expect(activatedAirspaceIds(second)).toEqual(activatedAirspaceIds(first));
	});
});
