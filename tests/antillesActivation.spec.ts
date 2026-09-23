/* The French Antilles are filed under Q) TTZP, the Piarco FIR their airspace
 * lies in, with A) TFFF. The designator activation is FR-only by design and
 * was gated on the Q-line FIR alone, so TF-R5 activated nothing: no hatch, no
 * "Activated by", no activation for the alert engine. A foreign FIR now reads
 * its A) locations (notamPublisher), and a US TFR still activates nothing. */

import { describe, it, expect, vi } from 'vitest';
import { rowToAirspace } from '$lib/data/airspaces';
import { parseNotams } from '$lib/notam';
import { firToPublisher } from '$lib/notam/airspaceIds';

const zone = (id: string): ReturnType<typeof rowToAirspace> =>
	rowToAirspace(
		[
			id, 'R', id.slice(2), '',
			['ALT', '2000', 'FT'], ['HEI', '0', 'FT'], null, null, 'H24', 'H24', '', [],
			[[14.6, -61.2], [14.6, -60.9], [14.9, -60.9], [14.9, -61.2]],
			'',
		],
		'fr',
	);

const ROWS = ['TFR5'].map(zone);

vi.mock('$lib/state/data.svelte', () => ({
	dataState: { airspacesLoaded: true, airportsLoaded: false },
	getAirspaces: () => ROWS,
}));

const antilles = (e: string) =>
	parseNotams(`A0100/26 NOTAMN
Q) TTZP/QRRCA/IV/BO/W/000/030/1445N06110W010
A) TFFF B) 2609220800 C) 2609221600
E) ${e}
`)[0];

describe('Antilles activation under Q) TTZP', () => {
	it('the Antilles FIR is not mapped to fr', () => {
		expect(firToPublisher('TTZP')).toBe(null);
	});

	it('activates TF-R5 on its A) location', async () => {
		const { activatedAirspaceIds, activatesAirspaces } = await import(
			'$lib/state/notamLinks.svelte'
		);
		const n = antilles('ZONE TF-R5 ACTIVE.');
		expect(activatedAirspaceIds(n)).toEqual(['TFR5']);
		expect(activatesAirspaces(n).map((a) => a.id)).toEqual(['TFR5']);
	});

	it('still activates nothing off a foreign NOTAM citing the same letters', async () => {
		const { activatedAirspaceIds } = await import('$lib/state/notamLinks.svelte');
		// A US TFR writes "TFR 5/2345", the year's last digit read as a zone.
		const tfr = parseNotams(`A0101/26 NOTAMN
Q) KZNY/QRTCA/IV/BO/W/000/030/4045N07400W010
A) KZNY B) 2609220800 C) 2609221600
E) TFR 5/2345 IN EFFECT.
`)[0];
		expect(activatedAirspaceIds(tfr)).toEqual([]);
		// Nor one of Piarco's own States.
		const trinidad = parseNotams(`A0102/26 NOTAMN
Q) TTZP/QRRCA/IV/BO/W/000/030/1045N06130W010
A) TTPP B) 2609220800 C) 2609221600
E) ZONE TF-R5 ACTIVE.
`)[0];
		expect(activatedAirspaceIds(trinidad)).toEqual([]);
	});
});
