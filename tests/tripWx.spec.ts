/* The dossier weather packer (src/lib/weather/tripWx.ts packWxPanels):
 * A5-card panels in trip order, balanced across one sheet when everything
 * fits, sequential capacity fill beyond (panels pair up two per sheet). */

import { describe, it, expect } from 'vitest';
import type { AwcTaf } from '$lib/weather/awc';
import { packWxPanels, type TripWxEntry } from '$lib/weather/tripWx';

/** An 'ok' entry sized in estimator lines: 4 without a TAF, +1+g with a
 *  g-group TAF (each group is one full raw line). */
function entry(icao: string, tafGroups = 0): TripWxEntry {
	const taf: AwcTaf | null =
		tafGroups > 0
			? {
					icaoId: icao,
					validTimeFrom: 0,
					validTimeTo: 0,
					rawTAF: [
						`TAF ${icao} 031100Z`,
						...Array.from({ length: tafGroups - 1 }, () => `BECMG ${'X'.repeat(64)}`),
					].join(' '),
				}
			: null;
	return {
		icao,
		status: 'ok',
		pick: {
			metar: { icaoId: icao, obsTime: 0, rawOb: 'M'.repeat(60), lat: 0, lon: 0 },
			distanceM: 0,
		},
		taf,
	};
}

describe('packWxPanels', () => {
	it('handles the empty and single-entry cases', () => {
		expect(packWxPanels([])).toEqual([]);
		const a = entry('LFPL');
		expect(packWxPanels([a])).toEqual([[a]]);
	});

	it('splits one sheet into two panels, preserving trip order', () => {
		const [a, b, c] = [entry('LFPL'), entry('LFQB'), entry('LFQH')];
		const panels = packWxPanels([a, b, c]);
		expect(panels).toHaveLength(2);
		expect(panels.flat().map((e) => e.icao)).toEqual(['LFPL', 'LFQB', 'LFQH']);
	});

	it('balances the split by estimated height', () => {
		// A tall TAF entry on the left balances against two short ones.
		const big = entry('LFPO', 6);
		const [b, c] = [entry('LFQB'), entry('LFQH')];
		expect(packWxPanels([big, b, c])).toEqual([[big], [b, c]]);
	});

	it('falls back to capacity fill when a sheet overflows', () => {
		// 8 entries x 10 lines = 80 > 2 x 36: three panels of 3 / 3 / 2.
		const entries = Array.from({ length: 8 }, (_, i) => entry(`LF${String(i).padStart(2, '0')}`, 5));
		const panels = packWxPanels(entries);
		expect(panels.map((p) => p.length)).toEqual([3, 3, 2]);
		expect(panels.flat().map((e) => e.icao)).toEqual(entries.map((e) => e.icao));
	});
});
