/* Every text here is verbatim from a real French NOTAM in force, labelled
 * with its aerodrome and, where the pair exists, given in both languages.
 * Source: the NOTAMs over metropolitan France on 2026-09-18/19
 * (docs/notam-audit-2026-09.md), where 172 runway NOTAMs produced a badge
 * and nothing else. */

import { describe, it, expect } from 'vitest';
import { closedRunwayEnds, parseRunwayChange } from '$lib/notam/runwayChange';

describe('closedRunwayEnds', () => {
	it('closes a runway a line closes outright', () => {
		// A3163/26 LFSB, both ends of both runways.
		expect(closedRunwayEnds('PISTES REVETUES 07/25 ET 15/33 FERMEES.')).toEqual([
			'07', '25', '15', '33',
		]);
		expect(closedRunwayEnds('PAVED RWY 07/25 AND 15/33 CLOSED.')).toEqual([
			'07', '25', '15', '33',
		]);
	});

	it('keeps a stated cause out of the way', () => {
		// E4272/26 LFBS, both languages.
		expect(
			closedRunwayEnds(
				"PISTE 20 FERMEE EN RAISON D'OBSTACLES DANS LES TROUEES DE DECOLLAGE ET D'ATTERRISSAGE",
			),
		).toEqual(['20']);
		expect(
			closedRunwayEnds('RWY 20 CLSD\nDUE TO OBST IMPACTING LANDING AND TKOF SURFACES:'),
		).toEqual(['20']);
	});

	it('refuses every line that closes a runway only partly', () => {
		// E3280/26 LFCC: landings prohibited, the runway is not closed.
		// B3844/26 LFAT: reserved, not closed. E3316/26: limited by night.
		// A6040/26 LFBK: reserved to IFR and SAR.
		for (const line of [
			'PISTE NON REVETUE 22 : APPROCHE ET ATTERRISSAGE INTERDITS.',
			'UNPAVED RWY 22 : APPROACH AND LDG PROHIBITED.',
			'PISTE NON REVETUE 08L/26R RESERVEE AUX ULM BASES.',
			'UNPAVED RWY 08L/26R RESERVED FOR HOME BASED MICROLIGHT AIRCRAFT.',
			'RWY 29 LIMITED :',
			'RWY 06/24 USE RESTRICTION :',
			'- RWY 09/27 : RESERVED FOR IFR TRAFFIC',
		]) {
			expect(closedRunwayEnds(line)).toEqual([]);
			expect(parseRunwayChange(line)[0].kind).toBe('note');
		}
	});

	it('says nothing about a line that names no runway', () => {
		// C3738/26 LFRN: a holding point closes, not a runway.
		expect(parseRunwayChange('POINT D\'ATTENTE H3 FERME.')).toEqual([]);
		expect(parseRunwayChange('HOLDING POINT H3 CLOSED.')).toEqual([]);
		expect(closedRunwayEnds('TWY E CLSD DUE TO WIP.')).toEqual([]);
	});

	it('reads a line at a time', () => {
		// The closure and the note live on their own lines and stay apart.
		const s = parseRunwayChange('RWY 07/25 CLSD\nRWY 15/33 RESERVED FOR HOME BASED ACFT');
		expect(s.map((x) => `${x.kind}:${x.designators.join('/')}`)).toEqual([
			'closed:07/25',
			'note:15/33',
		]);
		expect(closedRunwayEnds('RWY 07/25 CLSD\nRWY 15/33 RESERVED FOR HOME BASED ACFT')).toEqual([
			'07', '25',
		]);
	});

	it('tolerates the SIA accents and spacing', () => {
		expect(closedRunwayEnds('PISTE  REVÊTUE  12/30   FERMÉE')).toEqual(['12', '30']);
	});
});
