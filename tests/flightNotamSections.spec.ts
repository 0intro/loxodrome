/* The dossier's bulletin lists the planned flight's NOTAMs
 * (state/notamOrder.svelte.ts flightNotamOwnerSections): the NOTAMs tab's
 * content filters, the flight's span for the period. A dossier for a flight
 * in three days, printed in Now mode with a 6 h look-ahead, listed what is in
 * force today and none of what starts during the flight. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	ensureAirports: () => Promise.resolve([]),
}));

const { clearNotams, commitBriefing } = await import('$lib/state/notam.svelte');
const { flightNotamOwnerSections, orderedNotamOwnerSections } = await import('$lib/state/notamOrder.svelte');
const { filter, setWindowMode } = await import('$lib/state/filter.svelte');

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 24, 10, 30);
const FLIGHT = { from: Date.UTC(2026, 10, 27, 8, 0), to: Date.UTC(2026, 10, 27, 13, 0) };

function notam(id: string, from: string, to: string, e: string): string {
	return [`${id} NOTAMN`, 'Q) LFFF/QWPLW/IV/BO/W/000/115/4826N00209E003', `A) LFFF B) ${from} C) ${to}`, `E) ${e}`].join('\n');
}

const ids = (sections: { items: { notam: { id: string } }[] }[]) => sections.flatMap((s) => s.items.map((i) => i.notam.id));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	clearNotams();
	setWindowMode('now');
	filter.window.horizonH = 6;
	commitBriefing(
		[
			notam('W0001/26', '2611241000', '2611241400', 'PJE TODAY.'),
			notam('W0002/26', '2611270900', '2611271200', 'PJE ON THE FLIGHT DAY.'),
		].join('\n\n'),
		{ source: 'sofia', kind: 'route', briefed: null },
	);
});

afterEach(() => {
	vi.useRealTimers();
	filter.query = '';
	filter.window.horizonH = null;
});

describe('the dossier bulletin', () => {
	it('lists the flight’s NOTAMs, where the tab lists the viewing period’s', () => {
		expect(ids(orderedNotamOwnerSections())).toEqual(['W0001/26']);
		expect(ids(flightNotamOwnerSections(FLIGHT))).toEqual(['W0002/26']);
	});

	it('keeps the tab’s content filters', () => {
		filter.query = 'today';
		expect(ids(flightNotamOwnerSections(FLIGHT))).toEqual([]);
		expect(ids(flightNotamOwnerSections({ from: NOW, to: NOW + 2 * H }))).toEqual(['W0001/26']);
	});
});
