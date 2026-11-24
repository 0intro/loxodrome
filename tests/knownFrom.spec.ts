/* Who knows a zone's real activity (data/knownFrom.ts): the units the AIP's
 * remarks and hours and a NOTAM's E) item name, and the one an alert names
 * against the band's channels. The texts are the shipped rows' and the
 * 2026-09 corpus's, verbatim excerpts. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { askUnitText, knownFrom, whoKnows, type KnownUnit } from '$lib/data/knownFrom';

const unit = (u: string, freq: string | null = null, phone: string | null = null): KnownUnit => ({ unit: u, freq, phone });

describe('knownFrom', () => {
	const cases: [string, string, KnownUnit[]][] = [
		[
			'LF-R 174',
			'GAT/OAT: avoidance mandatory throughout activity.#Administrator : Régiment de Marche du Tchad.#Tel : 03 69 21 25 27.#Activity known on BASEL INFO 130.9 MHz.',
			[unit('BASEL INFO', '130.900')],
		],
		[
			'LF-R 505, a list',
			'Actual activity known on :#  - OCHEY APP,#  - STRASBOURG INFO,#  - LORRAINE TWR.',
			[unit('OCHEY APP'), unit('STRASBOURG INFO'), unit('LORRAINE TWR')],
		],
		['LF-R 3101 A, in French', 'Activité connue de :#ORLY APP#VILLACOUBLAY APP#\\\\Possible activation', [unit('ORLY APP'), unit('VILLACOUBLAY APP')]],
		[
			'LF-R 20 H3, the RAI a unit of its own',
			'Activity known on :#AVORD APP or RAI 119.7#PARIS ACC/FIC#BORDEAUX ACC',
			[unit('AVORD APP'), unit('RAI', '119.700'), unit('PARIS ACC/FIC'), unit('BORDEAUX ACC')],
		],
		['LF-R 77 B, a comma decimal', 'activity announced on RAI 135,15.', [unit('RAI', '135.150')]],
		[
			'LF-R 287, a frequency with no service word',
			'activity known on :#MADIRAN : 129.900 MHz#RAIZ : 129.900 MHz#PYRENEES INFO#ATIS PYRENEES#Activation by NOTAM :',
			[unit('MADIRAN', '129.900'), unit('RAIZ', '129.900'), unit('PYRENEES INFO'), unit('ATIS PYRENEES')],
		],
		['LF-R 39, a place passed over', 'activity known on:#CARCASSONNE#TOULOUSE INFO#MON : 0700-2359', [unit('TOULOUSE INFO')]],
		[
			'LF-R 28, known by telephone',
			'Activity known on :#Beynes camp duty office.#TEL : +33(0)1 34 91 21 64#Possible activation H24',
			[unit('BEYNES CAMP DUTY OFFICE', null, '+33 1 34 91 21 64')],
		],
		[
			'LF-R 229 B, a telephone in the list',
			'Actual activity known on :#- ETAIN APP or RAI : 120.125 MHz#- 1RCh : 03 29 73 56 59 or 56 53.',
			[unit('ETAIN APP'), unit('RAI', '120.125'), unit('1RCH', null, '03 29 73 56 59')],
		],
		[
			'LF-R 95 A, a second list read in its turn',
			'Activity known on :#-PROVENCE INFO#-NICE INFO#-MARSEILLE ACC/FIC.#Actual activity known on LE LUC APP',
			[unit('PROVENCE INFO'), unit('NICE INFO'), unit('MARSEILLE ACC/FIC'), unit('LE LUC APP')],
		],
		['R0564/26 in French', '7-INFO :\n  ACTIVITE REELLE CONNUE DE LILLE INFO 132.540MHZ\nF) SFC', [unit('LILLE INFO', '132.540')]],
		['R0564/26 in English', "7-INFO :\n  ACTUAL TIMES OF ACTIVITY ANNOUNCED ON 'LILLE INFO' 132.540MHZ", [unit('LILLE INFO', '132.540')]],
		[
			'R0916/26, one unit a line',
			'5) INFORMATION DES USAGERS : \nACTIVITE REELLE CONNUE DE :\nSTRASBOURG INFO : 119.450 MHZ\nOCHEY APP : 127.250 MHZ\nOCHEY TOUR : 130.275 MHZ\n6) CONDITIONS DE PENETRATION :\nCAM / CAG : CONTOURNEMENT OBLIGATOIRE',
			[unit('STRASBOURG INFO', '119.450'), unit('OCHEY APP', '127.250'), unit('OCHEY TOUR', '130.275')],
		],
		['LF-D 181, by NOTAM', 'Activity announced by  NOTAM', []],
	];
	it.each(cases)('%s', (_, text, want) => {
		expect(knownFrom(text)).toEqual(want);
	});

	it('reads a unit in nearly every shipped row that names who knows', () => {
		const d = JSON.parse(readFileSync('public/data/fr-airspaces.json', 'utf8')) as { fields: string[]; rows: unknown[][] };
		const c = (k: string) => d.fields.indexOf(k);
		const cell = (v: unknown) => (typeof v === 'string' ? v : '');
		let named = 0;
		let read = 0;
		for (const r of d.rows) {
			const text = `${cell(r[c('rmk')])}\n${cell(r[c('rmkWorkHr')])}`;
			if (!['R', 'D', 'P', 'TRA'].includes(cell(r[c('type')])) || !/activity known|announced on|connue de/i.test(text)) {
				continue;
			}
			named++;
			const units = knownFrom(text);
			read += units.length > 0 ? 1 : 0;
			for (const u of units) {
				expect(u.unit, cell(r[c('id')])).toMatch(/^[A-Z0-9][A-Z0-9 /'-]*$/);
			}
		}
		expect(named).toBeGreaterThan(500);
		expect(read / named).toBeGreaterThan(0.97);
	});
});

describe('whoKnows', () => {
	const units = [unit('AVORD APP'), unit('RAI', '119.700'), unit('POITIERS INFO', '119.250'), unit('SEINE INFO')];
	const ch = (call: string, freq: string) => ({ call, unit: '', freq });

	it('names the unit on the channel the band has set, by frequency or by name', () => {
		expect(whoKnows(units, [ch('POITIERS INFORMATION', '119.25')], [])).toEqual({ unit: 'POITIERS INFO', freq: '119.250' });
		// Printed with no frequency, a unit takes its channel's.
		expect(whoKnows(units, [ch('Seine Information', '120.325')], [])).toEqual({ unit: 'SEINE INFO', freq: '120.325' });
	});

	it('names the RAI next, then the next contact, then the first named', () => {
		expect(whoKnows(units, [ch('PARIS INFO', '125.700')], [ch('SEINE INFO', '120.325')])).toEqual({ unit: 'RAI', freq: '119.700' });
		const noRai = units.filter((u) => u.unit !== 'RAI');
		expect(whoKnows(noRai, [], [ch('SEINE INFO', '120.325')])).toEqual({ unit: 'SEINE INFO', freq: '120.325' });
		expect(whoKnows(noRai, [], [])).toEqual({ unit: 'AVORD APP', freq: null });
	});

	it('says a telephone alone, and nothing for nobody', () => {
		expect(whoKnows([unit('BEYNES CAMP DUTY OFFICE', null, '+33(0)1 34 91 21 64')], [], [])).toBe('phone');
		expect(whoKnows([], [], [])).toBeNull();
	});
});

describe('askUnitText', () => {
	it('names the unit to ask with its channel, else its telephone', () => {
		expect(askUnitText([unit('BLOIS INFO', '118.455'), unit('TOURS APP', '120.375')])).toBe('BLOIS INFO 118.455');
		expect(askUnitText([unit('AVORD APP')])).toBe('AVORD APP');
		expect(askUnitText([unit('BEYNES CAMP DUTY OFFICE', null, '+33 1 34 91 21 64')])).toBe(
			'BEYNES CAMP DUTY OFFICE +33 1 34 91 21 64',
		);
		expect(askUnitText([])).toBeNull();
	});
});
