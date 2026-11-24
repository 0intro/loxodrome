/* What a NOTAM that creates an area says of the area's activity
 * (notam/areaActivity.ts areaMode), read alike in the two languages the
 * SIA publishes in, its real activity known from a unit reading activable. The pairs are excerpts of the 2026-09 corpus's and the
 * November world fixtures' E) items, verbatim. The census reads every area
 * of the November fixtures in both languages. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseNotams } from '$lib/notam';
import { notamVolumes } from '$lib/nav/alertVolumes';
import { areaMode } from '$lib/notam/areaActivity';
import type { Notam } from '$lib/notam/types';

const e = (text: string): Notam => ({ fullContent: `E) ${text}` }) as unknown as Notam;

describe('areaMode', () => {
	const pairs: [string, string, string, ReturnType<typeof areaMode>][] = [
		['R0564/26', '-ZRT ACTIVABLE H24 AVEC UN PREAVIS DE 24 HEURES,', '-ZRT MAY BE ACTIVATED H24 WITH A 24HR PN,', 'activable'],
		['R2540/26', 'LA ZRT EST ACTIVABLE PENDANT LES CRENEAUX', 'ZRT ACTIVABLE DURING THE SLOTS.', 'activable'],
		[
			'R0916/26',
			'ACTIVABLE DU LUNDI AU VENDREDI SAUF LE 6 AVRIL, 01, 08, 14 ET 25 MAI,',
			'CAN BE ACTIVATED FM MONDAY TO FRIDAY EXC APRIL 6, MAY 01, 08, 14 AND',
			'activable',
		],
		['R2170/26', 'ACTIVABLE H24,', "'ZRT' CAN BE ACTIVED H24", 'activable'],
		['R3509/26', '-ZRT ACTIVABLE AVEC UN PREAVIS DE 30 MINUTES.', '- ACTIVATABLE ZRT UPON 30MIN PN.', 'activable'],
		['R1871/26', "CES 'ZRT/ZDT' SONT ACTIVEES PAR NOTAM A J-7.", "THESE 'ZRT/ZDT' ARE ACTIVATED BY NOTAM AT D-7.", 'notam'],
		// The real activity known from a unit: the area may be active within
		// its period, the unit knowing when.
		[
			'R2307/26',
			"ZRT, QUI LORSQU'ELLE EST ACTIVE, SE SUBSTITUE AUX PORTIONS D'ESPACES AERIENS AVEC LESQUELLES ELLE INTERFERE. 5- ACTIVITE REELLE CONNUE DE : SEINE INFO : 127.815 MHZ (PENDANT HOR ATS)",
			'ZRT, WHICH, WHEN ACT, REPLACES OVERLAPPING PARTS OF AIRSPACE 5- ACTUAL ACTIVITY AVBL AT : SEINE INFO : 127.815MHZ (DURING ATS HOURS)',
			'activable',
		],
		['R2909/26', '5. ACTIVITE REELLE CONNUE DE : LILLE INFO 134.825MHZ', '5. INFO : ACTUAL TIME OF ACTIVITY ANNOUNCED ON : LILLE INFO 134.825MHZ', 'activable'],
		['W1912/26', '-ACTIVITE CONNUE DE SEINE INFO 120.325MHZ.', '-ACT KNOWN FROM SEINE INFO 120.325MHZ.', 'activable'],
		['W2502/26', 'ACTIVITE CONNUE SUR EPINAL INFO 120.205MHZ', 'ACTIVITY INFO AVBL ON EPINAL INFO 120.205MHZ', 'activable'],
		['R1041/26', 'ACTIVITE RELLE CONNUE DE : AQUITAINE INFO 120.575MHZ', 'ACTUAL ACT KNOWN BY : AQUITAINE INFO 120.575MHZ', 'activable'],
		// The template's sentence heads an H24 ZRT too.
		[
			'R3114/26',
			"2) DATES ET HEURES D'ACTIVITE: H24 3) STATUT: ZRT QUI LORSQU'ELLE EST ACTIVE SE SUBSTITUE AUX PORTIONS DES ESPACES AERIENS AVEC LESQUELS ELLE INTERFERE.",
			'2. SKED: H24 3. STATUS: ZRT REPLACES OVERLAPPING AIRSPACE.',
			'firm',
		],
	];
	it.each(pairs)('%s reads alike in both languages', (_, fr, en, mode) => {
		expect(areaMode(e(fr))).toBe(mode);
		expect(areaMode(e(en))).toBe(mode);
	});

	it('reads the forms of one language alone', () => {
		// R2633/26 prints English in both, the ICAO abbreviation ACT.
		expect(areaMode(e("ZRT MAY BE ACT DURING SPECIFIED SLOT IN 'D' FIELD"))).toBe('activable');
		// A1594/26, Austria.
		expect(areaMode(e('EFFECTIVENESS WILL BE ANNOUNCED BY NOTAM. REF AIP AUSTRIA ENR 5.2.'))).toBe('notam');
		// The SIA's misspellings: R3504/26 in French, W0229/26 in English.
		expect(areaMode(e('ACTIVITE REELE CONNUE DE : PARIS INFO 126.100MHZ'))).toBe('activable');
		expect(areaMode(e('ACTAUL ACT KNOWN UP TO 48HR BEFORE VIA TEMPORARY PHONE'))).toBe('activable');
	});

	it('reads an area in force where its words are about other zones or other things', () => {
		const firm = [
			// R2630/26: the zones a ZRT keeps from activation.
			'LF-D526A AND LF-D526B AREAS CANNOT BE ACTIVATED DURING THE TEMPORARY RESTRICTED AREA ACTIVATION',
			// R1129/26: the notice is an exemption's.
			'EXEMPTION SUBMITTED TO MANAGER AGREEMENT WITH PN 05 DAYS.',
			// R1552/26: a zone joining another.
			"THE 'ZRT CESA SOULAC' WILL BE ACTIVATED FOR JOINING THE 'ZRT CESA NORD ETE' PUBLISHED",
			// R0916/26: a zone the ZRT deactivates.
			"ZONE DESACTIVEE LORS DE L'ACTIVATION DE LA ZRT :",
			'RESTRICTED AREA LF-R 174 MEYENHEIM ACTIVE',
		];
		for (const text of firm) {
			expect(areaMode(e(text)), text).toBe('firm');
		}
	});

	it('reads every area of the November fixtures alike in French and English', () => {
		const modes = (lang: string) => {
			const notams = parseNotams(readFileSync(`tests/fixtures/world-${lang}-20261122.txt`, 'utf8'));
			const byId = new Map(notams.map((n) => [n.id, n]));
			return new Map(notamVolumes(notams).map((v) => [v.id, areaMode(byId.get(v.id) as Notam)]));
		};
		const fr = modes('fr');
		const en = modes('en');
		expect(fr.size).toBe(en.size);
		for (const [id, mode] of fr) {
			expect(en.get(id), id).toBe(mode);
		}
		// The areas that are not in force throughout, by number.
		const bare = (id: string) => id.replace(/^[A-Z]{4}-/, '');
		const not = [...fr].filter(([, m]) => m !== 'firm').map(([id, m]) => `${bare(id)} ${m}`);
		expect(not.sort()).toEqual([
			'A1108/26 activable',
			'A1109/26 activable',
			'A1111/26 activable',
			'A1762/26 activable',
			'A1763/26 activable',
			'A1887/26 activable',
			'A2522/26 notam',
			'B0229/26 activable',
			'C0777/26 activable',
			'C0779/26 activable',
			'C0780/26 activable',
			'C0781/26 activable',
			'C0783/26 activable',
			'C0784/26 activable',
			'C0786/26 activable',
			'C0788/26 activable',
			'C0790/26 activable',
			'C0816/26 activable',
			'C1459/26 activable',
			'G0362/26 activable',
			'G0363/26 activable',
			'G0364/26 activable',
			'G0365/26 activable',
			'G0366/26 activable',
			'R0319/26 activable',
			'R0564/26 activable',
			'R0915/26 activable',
			'R1871/26 notam',
			'R2170/26 activable',
			'R2253/26 activable',
			'R2307/26 activable',
			'R2790/26 activable',
			'R2909/26 activable',
			'R2989/26 activable',
			'R3338/26 activable',
			'R3343/26 activable',
			'R3509/26 activable',
			'W0805/26 activable',
			'W1218/26 activable',
			'W2317/26 activable',
			'W2431/26 activable',
			'W2453/26 activable',
		]);
	});
});
