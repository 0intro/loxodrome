/* The aerodrome resolver's hand-over through the REAL by-name link: a
 * frequency change filed under an aerodrome that names a FIS sector is the
 * sector's to place, so its label ("SEINE INFO", canonically INFO) never
 * moves the aerodrome's own information service.
 *
 * freqOverride.spec mocks the link to judge what the resolver does with it;
 * this file keeps the link real and mocks only the briefing and the airspace
 * dataset, because the hand-over was decided on the level-filtered list the
 * NOTAM panel prints. A band above the sector, or an airspace dataset not yet
 * loaded, emptied that list, and the label then moved LFPM's INFO row to the
 * SIV's frequency in the panel and the nav log.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNotams } from '$lib/notam/parser';
import type { Airport } from '$lib/data/airports';
import type { Airspace } from '$lib/data/airspaces';
import type { Notam } from '$lib/notam/types';
import { fromTriple } from '$lib/vertical/limits';

const m = vi.hoisted(() => ({
	items: [] as { notam: Notam; index: number }[],
	rows: null as Airspace[] | null,
}));

vi.mock('$lib/state/notam.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/notam.svelte')>('$lib/state/notam.svelte');
	return {
		...real,
		filteredNotams: () => m.items,
		notamsByIdent: () => {
			const map = new Map<string, { notam: Notam; index: number }[]>();
			for (const it of m.items) {
				for (const code of it.notam.icaoCodes) {
					map.set(code.toUpperCase(), [...(map.get(code.toUpperCase()) ?? []), it]);
				}
			}
			return map;
		},
		// Wide open: the validity gate has its own contract.
		activeEvalWindow: () => ({ from: -8.64e15, to: 8.64e15 }),
		drawnStateAt: () => ({ fromMs: -8.64e15, toMs: 8.64e15 }),
	};
});

vi.mock('$lib/state/data.svelte', async () => {
	const real =
		await vi.importActual<typeof import('$lib/state/data.svelte')>('$lib/state/data.svelte');
	return { ...real, getAirspaces: () => m.rows };
});

const { filter } = await import('$lib/state/filter.svelte');
const { flagText, resolveAirportRadios, resolveAirspaceRadios } = await import(
	'$lib/state/freqOverride.svelte'
);

/** SEINE 4 as fr-airspaces.json publishes it: SFC to FL 115, on 120.33. */
function seine4(): Airspace {
	return {
		id: 'LFPMFS4',
		key: 'LFPMFS4|SEINE 4',
		type: 'SIV',
		name: 'SEINE 4',
		source: 'fr',
		vLower: fromTriple(['HEI', '0', 'FT']),
		vUpper: fromTriple(['STD', '115', 'FL']),
		radio: [{ freq: '120.33', unit: 'LFPM MELUN SEINE', call: 'SEINE - INFORMATION' }],
		ring: [],
	} as unknown as Airspace;
}

function airport(ident: string, radios: [string, string][]): Airport {
	return {
		ident,
		type: 'small_airport',
		radios: radios.map(([freq, unit]) => ({ freq, unit, call: '' })),
	} as Airport;
}

function brief(text: string): void {
	m.items = parseNotams(text).map((notam, index) => ({ notam, index }));
}

function reading(a: Airport): string[] {
	return resolveAirportRadios(a).radios.map(
		(r) => `${r.unit} ${r.freq}${r.override ? ` was ${r.override.was}` : ''}`,
	);
}

function flags(a: Airport): string[] {
	return resolveAirportRadios(a).flags.map((f) => flagText(f.info));
}

const SEINE_INFO = `W1234/26 NOTAMN
Q) LFFF/QCACF/IV/BO/E/000/999/4840N00230E999
A) LFPM B) 2602170000 C) PERM
E) SEINE INFO : 120.505MHZ`;

const lfpm = (): Airport => airport('LFPM', [['120.5', 'INFO']]);

afterEach(() => {
	m.rows = null;
	filter.altitude.enabled = false;
});

describe('a SIV change filed under an aerodrome', () => {
	it('stays the sector\'s under a level band above it', () => {
		brief(SEINE_INFO);
		m.rows = [seine4()];
		filter.altitude.enabled = true;
		filter.altitude.floor = 12000;
		filter.altitude.ceiling = 19500;
		expect(reading(lfpm())).toEqual(['INFO 120.5']);
		expect(flags(lfpm())).toEqual([]);
		// And the sector places it, the band notwithstanding.
		expect(resolveAirspaceRadios(seine4()).radios.map((r) => r.freq)).toEqual(['120.505']);
	});

	it('moves no row by its label while the sector is not loaded, and says so', () => {
		brief(SEINE_INFO);
		for (const rows of [null, [{ ...seine4(), source: 'be' } as Airspace]]) {
			m.rows = rows;
			expect(reading(lfpm())).toEqual(['INFO 120.5']);
			expect(flags(lfpm())).toEqual(['SEINE INFO: 120.505']);
		}
	});

	it('still places a label that names no sector', () => {
		// D1407/26: the tower's own conversion, judged against the loaded
		// sectors and placed by its label as before.
		brief(`D1407/26 NOTAMN
Q) LFBB/QCACS/IV/BO/A/000/999/4335N00130E005
A) LFCL B) 2603190800 C) PERM
E) FREQUENCE TWR : 122.705MHZ
ABSENCE ATS, FREQUENCE A/A : 122.705MHZ
REF AD2 LFCL APP 01`);
		m.rows = [seine4()];
		expect(reading(airport('LFCL', [['122.7', 'TWR']]))).toEqual(['TWR 122.705 was 122.700']);
	});
});
