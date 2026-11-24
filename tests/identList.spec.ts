/* src/notam/identList.ts: the aerodrome box's text as a list of idents.
 *
 * The rule worth pinning is the refusal. Silently briefing one aerodrome when
 * two were asked for, because the second was a typo, is the failure this
 * guards: what is dropped comes back so the loader can name it.
 */

import { describe, expect, it } from 'vitest';
import { narrowRouteTokens } from '$lib/sofia/client';
import { parseIdentList, sofiaTracks } from '../src/notam/identList';

describe('parseIdentList', () => {
	it('takes the spellings a pilot actually types', () => {
		for (const text of ['LFPN LFPO', 'lfpn lfpo', 'LFPN, LFPO', 'LFPN/LFPO', 'LFPN\nLFPO', 'LFPN;LFPO', 'LFPN-LFPO', 'LFPN - LFPO']) {
			expect(parseIdentList(text).idents, text).toEqual(['LFPN', 'LFPO']);
		}
	});

	it('takes a chain joined by dashes, the form the app writes', () => {
		// routesFileBaseName names a plan's file LFPL-LFPU-LFGO. Read as one
		// word, the chain was refused whole, and beside another ident only
		// that one was briefed.
		expect(parseIdentList('LFPL-LFPU-LFGO')).toEqual({ idents: ['LFPL', 'LFPU', 'LFGO'], rejected: [] });
		expect(parseIdentList('LFPN-LFPO LFPB')).toEqual({ idents: ['LFPN', 'LFPO', 'LFPB'], rejected: [] });
	});

	it('keeps the chain typed, a circuit’s return included, and drops an ident repeating itself', () => {
		// routesFileBaseName names a circuit's file LFPN-LFOZ-LFOX-LFPN: its
		// closing leg is a corridor to brief.
		expect(parseIdentList('LFPN LFOZ LFOX LFPN').idents).toEqual(['LFPN', 'LFOZ', 'LFOX', 'LFPN']);
		expect(parseIdentList('LFPO LFPO LFPN').idents).toEqual(['LFPO', 'LFPN']);
	});

	it('reports what it did not understand instead of guessing', () => {
		// ORY is the IATA code for LFPO. Sending it to a briefing service
		// answers nothing, and answering nothing quietly is worse than saying
		// which word was not an ident.
		const out = parseIdentList('LFPO ORY LFPNX 42');
		expect(out.idents).toEqual(['LFPO']);
		expect(out.rejected).toEqual(['ORY', 'LFPNX', '42']);
	});

	it('is empty on empty, and on whitespace', () => {
		expect(parseIdentList('')).toEqual({ idents: [], rejected: [] });
		expect(parseIdentList('   \n\t ')).toEqual({ idents: [], rejected: [] });
	});
});

describe('sofiaTracks', () => {
	const nowhere = () => null;
	// SOFIA briefs the two END aerodromes of a route fully and the ones
	// between about six times more thinly (docs/notam-audit-2026-09.md
	// section 5), so the four placeholder idents sent as one route came back
	// without most NOTAMs filed under the two stops in the middle.
	const sent = (idents: string[]): string[][] =>
		sofiaTracks(idents, nowhere).map((t) => narrowRouteTokens(t.points) ?? []);

	it('makes every named aerodrome an end of the route SOFIA is sent', () => {
		const idents = ['LFPL', 'LFPK', 'LFFZ', 'LFQB'];
		const routes = sent(idents);
		expect(routes).toEqual([
			['LFPL', 'LFPK'],
			['LFPK', 'LFFZ'],
			['LFFZ', 'LFQB'],
		]);
		const ends = new Set(routes.flatMap((r) => [r[0], r[r.length - 1]]));
		expect([...ends].sort()).toEqual([...idents].sort());
	});

	it('briefs the corridor of the whole chain, leg by leg', () => {
		const legs = (r: string[]): string[] => r.slice(1).map((b, i) => `${r[i]}-${b}`);
		expect(sent(['LFPL', 'LFPK', 'LFFZ', 'LFQB']).flatMap(legs)).toEqual(['LFPL-LFPK', 'LFPK-LFFZ', 'LFFZ-LFQB']);
	});

	it('names each route by its two ends for the gap list', () => {
		expect(sofiaTracks(['LFPN', 'LFPO', 'LFRS'], nowhere).map((t) => t.label)).toEqual(['LFPN-LFPO', 'LFPO-LFRS']);
	});

	it('sends one aerodrome at both ends, its own single-aerodrome PIB', () => {
		expect(sofiaTracks(['LFPN'], nowhere)).toEqual([
			{
				label: 'LFPN',
				points: [
					{ token: 'LFPN', aerodrome: true },
					{ token: 'LFPN', aerodrome: true },
				],
			},
		]);
		expect(sent(['LFPN'])).toEqual([['LFPN', 'LFPN']]);
	});

	it('briefs a circuit’s closing leg, and an out-and-back’s leg once', () => {
		expect(sent(['LFPN', 'LFOZ', 'LFOX', 'LFPN'])).toEqual([
			['LFPN', 'LFOZ'],
			['LFOZ', 'LFOX'],
			['LFOX', 'LFPN'],
		]);
		expect(sent(['LFPN', 'LFOZ', 'LFPN', 'LFOX'])).toEqual([
			['LFPN', 'LFOZ'],
			['LFPN', 'LFOX'],
		]);
	});

	it('is empty on empty', () => {
		expect(sofiaTracks([], nowhere)).toEqual([]);
	});

	it('draws each pair whose ends both place, for the record of what was asked', () => {
		const at: Record<string, { lat: number; lon: number }> = {
			LFPN: { lat: 48.752, lon: 2.106 },
			LFOZ: { lat: 47.897, lon: 2.163 },
		};
		const place = (id: string) => at[id] ?? null;
		expect(sofiaTracks(['LFPN', 'LFOZ', 'LFXX'], place).map((t) => t.path)).toEqual([
			[at.LFPN, at.LFOZ],
			undefined,
		]);
		expect(sofiaTracks(['LFPN'], place)[0].path).toEqual([at.LFPN, at.LFPN]);
	});
});
