/* state/planScope.svelte.ts: what a flight plan tells surfaces that also have
 * to work without one.
 *
 * The NOTAM half reads four route-workspace facts through nullable providers
 * rather than by importing the route workspace. This file pins the UNREGISTERED
 * answer, which is the whole point of the indirection: an app with no plan must
 * get a briefing that is complete rather than one silently narrowed by a
 * corridor nobody drew, a period it cannot offer, and an aerodrome order it has
 * no aerodromes for.
 *
 * The registered side is pinned by every other spec in the suite, which runs
 * against Loxodrome's own scope.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam';
import { filter, DEFAULT_HORIZON_H } from '$lib/state/filter.svelte';
import { planScope } from '$lib/state/planScope.svelte';
import { activeEvalWindow, filteredNotams, notamState } from '$lib/state/notam.svelte';
import { orderedVisibleNotams } from '$lib/state/notamOrder.svelte';

const NOW = '2026-07-31T12:00:00Z';

const BRIEFING = `A0001/26
Q) LFBB/QRTCA/IV/BO/AW/000/055/4500N00100W005
A) LFBD
B) 2607010000 C) 2612310000
E) ONE.
F) SFC
G) 5500FT AMSL

A0002/26
Q) LFFF/QRTCA/IV/BO/AW/000/055/4845N00207E005
A) LFPN
B) 2607010000 C) 2612310000
E) TWO.
F) SFC
G) 5500FT AMSL
`;

function seed(): void {
	notamState.notams = parseNotams(BRIEFING);
	notamState.parsedAt = Date.now();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	filter.window.mode = 'now';
	filter.window.horizonH = DEFAULT_HORIZON_H;
	filter.query = '';
	filter.trafficMode = 'all';
	filter.kind = { area: true, position: true, qualifierLine: true };
	filter.altitude.enabled = false;
	notamState.notams = [];
	notamState.fetchScope = null;
});

describe('the unregistered scope', () => {
	it('has every provider null, which is how a test run finds it', () => {
		// Loxodrome registers in main.ts's boot(), which no spec runs. A slot
		// that had quietly acquired a value here would mean some module had
		// registered itself as a side effect of being imported, and the whole
		// point is that nothing does.
		expect(planScope.flight).toBeNull();
		expect(planScope.corridor).toBeNull();
		expect(planScope.aerodromeRank).toBeNull();
		expect(planScope.flightRules).toBeNull();
	});

	it('narrows nothing: every NOTAM survives the filter', () => {
		seed();
		// With a corridor provider this is where "show only route NOTAMs"
		// would cut. Without one the clause is inert, not empty: the failure
		// this guards against is a briefing that silently loses NOTAMs on a
		// site that has no routes to be off.
		expect(filteredNotams()).toHaveLength(2);
	});

	it('offers no flight period, and says so by falling back', () => {
		// The mode can still be SET (it persists, and a stored workspace could
		// carry it), so the fallback has to be the safe one rather than an
		// empty window that would hide the whole briefing.
		filter.window.mode = 'flight';
		filter.window.horizonH = 24;
		const w = activeEvalWindow();
		expect(w.from).toBe(Date.parse(NOW));
		expect(w.to).toBe(Date.parse(NOW) + 24 * 3600_000);
	});

	it('still orders a briefing, without an aerodrome rank', () => {
		seed();
		// The canonical sort takes the rank as context; an empty one degrades
		// it to the non-route ordering rather than throwing or dropping rows.
		expect(orderedVisibleNotams().map((it) => it.notam.id).sort()).toEqual([
			'A0001/26',
			'A0002/26',
		]);
	});
});
