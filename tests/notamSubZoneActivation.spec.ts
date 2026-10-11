/* A zone's sub-lettering detached from its number ("LF-R368 A B C1 C2") is a
 * CANDIDATE, not an id: the loaded dataset decides. This pins both halves of
 * that rule, because either one alone is a defect. Reading the run and
 * activating the parent only would hatch nothing (the parent is not a row);
 * accepting every candidate would hatch the sub-zones the NOTAM does NOT
 * name, and the same grammar would read a vertical limit as a sub-zone.
 *
 * Verbatim from R2617/26 (LFMM, 2026-09-18), which activates 368 A, B, C1 and
 * C2 while the AIP also publishes 368 E1 and E2. */

import { describe, it, expect, vi } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';
import { parseNotams } from '$lib/notam';

const zone = (id: string): ReturnType<typeof rowToAirspace> =>
	rowToAirspace(
		[
			id, 'R', id.slice(2), '',
			['ALT', '2000', 'FT'], ['HEI', '0', 'FT'], null, null, 'H24', 'H24', '', [],
			[[48.6, 2.4], [48.6, 2.8], [49.0, 2.8], [49.0, 2.4]],
			'',
		],
		'fr',
	);

const ROWS = ['LFR368A', 'LFR368B', 'LFR368C1', 'LFR368C2', 'LFR368E1', 'LFR368E2', 'LFR45A'].map(zone);

vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false },
	getAirspaces: () => ROWS,
}));

const notam = (e: string) =>
	parseNotams(`LFFA-R2617/26
DU: 18 09 2026 00:00 AU: 19 09 2026 23:59
A) LFMM
Q) LFMM / QRRCA / IV / BO / W / 000/065 / 4415N00530E010
E) ${e}
F) SFC
G) FL065
`)[0];

describe('detached sub-zone activation', () => {
	it('activates every sub-zone the NOTAM names', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		// The bare designator the text also carries stays in the list and is
		// inert: no row has that id, so nothing resolves to it.
		expect(activatedAirspaceIds(notam('LF-R368 A B C1 C2 ACTIVATED.'))).toEqual([
			'LFR368',
			'LFR368A',
			'LFR368B',
			'LFR368C1',
			'LFR368C2',
		]);
	});

	it('leaves the sub-zones it does not name alone', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		const ids = activatedAirspaceIds(notam('LF-R368 A B C1 C2 ACTIVATED.'));
		expect(ids).not.toContain('LFR368E1');
		expect(ids).not.toContain('LFR368E2');
	});

	it('refuses a candidate the dataset does not carry', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		// 368 Z is not a published row, so the letter stays prose.
		expect(activatedAirspaceIds(notam('LF-R368 Z ACTIVATED.'))).toEqual(['LFR368']);
		// And a vertical limit is never a sub-zone: 45 A is a published row
		// here, so only the grammar's own guard can keep it out.
		expect(activatedAirspaceIds(notam('LF-R45 A 3000FT AMSL ACTIVATED.'))).toEqual(['LFR45']);
	});

	it('hands out the same array while the dataset is unchanged', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		const n = notam('LF-R368 A B ACTIVATED.');
		const first = activatedAirspaceIds(n);
		expect(activatedAirspaceIds(n)).toBe(first);
	});
});

describe('activation by designator is French-FIR only', () => {
	// The grammar is FR-only by design, and since it reads spaced forms
	// ("LF-R 174") another State's prose can spell a French id: an FAA TFR
	// numbered "5/2345" (the year's last digit) reads as TFR5, Martinique's.
	const foreign = (e: string) =>
		parseNotams(`A0001/25 NOTAMN
Q) KZNY/QRTCA/IV/BO/W/000/180/4045N07350W005
A) KZNY B) 2509010000 C) 2509302359
E) ${e}
`)[0];

	it('a foreign FIR’s NOTAM activates no French zone', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		expect(activatedAirspaceIds(foreign('TFR 5/2345 AIRSPACE ACTIVATED.'))).toEqual([]);
		expect(activatedAirspaceIds(foreign('LF-R368 A B ACTIVATED.'))).toEqual([]);
	});

	it('a French FIR’s NOTAM still does, spaced forms included', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		expect(activatedAirspaceIds(notam('RESTRICTED AREA LF-R 368 A ACTIVE.'))).toContain('LFR368A');
	});
});
