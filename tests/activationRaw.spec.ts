/* The activation join a verdict reads: the raw briefing over the window the
 * caller names (activatedAirspaceLinksRaw). The route profile's crossings
 * strip graded a zone NO-GO from the display join, which follows the list
 * filters and the viewing period, so a search or a bounded look-ahead turned
 * an active restricted area into an ordinary crossing. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';
import { parseNotams } from '$lib/notam';

const ZONE = rowToAirspace(
	[
		'LFR262', 'R', 'ENGHIEN', '',
		['ALT', '1500', 'FT'], ['HEI', '0', 'FT'], null, null, 'NOTAM', 'NOTAM', '', [],
		[[49.0, 2.3], [49.0, 2.4], [49.1, 2.4], [49.1, 2.3]],
		'',
	],
	'fr',
);

vi.mock('$lib/state/data.svelte', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/state/data.svelte')>()),
	getAirspaces: () => [ZONE],
}));

const { notamState } = await import('$lib/state/notam.svelte');
const { filter } = await import('$lib/state/filter.svelte');
const { activatedAirspaceLinks, activatedAirspaceLinksRaw } = await import('$lib/state/notamLinks.svelte');

const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 25, 8, 0);

function activation(fromMs: number, toMs: number): void {
	const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(2, 12);
	notamState.notams = parseNotams(`A0007/26 NOTAMN
Q) LFFF/QRRCA/IV/BO/W/000/015/4903N00221E003
A) LFFF B) ${stamp(fromMs)} C) ${stamp(toMs)}
E) ZONE REGLEMENTEE LF-R262 'ENGHIEN' ACTIVE.
`);
	notamState.parsedAt = Date.now();
}

afterEach(() => {
	notamState.notams = [];
	filter.query = '';
	vi.useRealTimers();
});

describe('the raw activation join', () => {
	it('links an activation a search hides from the list', () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		activation(T0, T0 + 8 * H);
		filter.query = 'nothing matches this';
		expect([...activatedAirspaceLinks().keys()]).toEqual([]);
		expect([...activatedAirspaceLinksRaw({ from: T0, to: T0 + H }).keys()]).toEqual(['LFR262']);
	});

	it('reads the window it is handed, whatever the viewing period', () => {
		vi.useFakeTimers();
		vi.setSystemTime(T0 - 24 * H);
		filter.window.horizonH = 6;
		try {
			activation(T0, T0 + 8 * H);
			// The map reads the next six hours: nothing active.
			expect([...activatedAirspaceLinks().keys()]).toEqual([]);
			// The flight is tomorrow, inside the activation.
			expect([...activatedAirspaceLinksRaw({ from: T0 + H, to: T0 + 3 * H }).keys()]).toEqual(['LFR262']);
			// A flight before it reads it cold.
			expect([...activatedAirspaceLinksRaw({ from: T0 - 5 * H, to: T0 - 2 * H }).keys()]).toEqual([]);
		} finally {
			filter.window.horizonH = null;
		}
	});
});
