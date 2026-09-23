/* src/notam/identList.ts: the aerodrome box's text as a list of idents.
 *
 * The rule worth pinning is the refusal. Silently briefing one aerodrome when
 * two were asked for, because the second was a typo, is the failure this
 * guards: what is dropped comes back so the loader can name it.
 */

import { describe, expect, it } from 'vitest';
import { parseIdentList } from '../src/notam/identList';

describe('parseIdentList', () => {
	it('takes the spellings a pilot actually types', () => {
		for (const text of ['LFPN LFPO', 'lfpn lfpo', 'LFPN, LFPO', 'LFPN/LFPO', 'LFPN\nLFPO', 'LFPN;LFPO']) {
			expect(parseIdentList(text).idents).toEqual(['LFPN', 'LFPO']);
		}
	});

	it('keeps the order typed and drops a repeat', () => {
		expect(parseIdentList('LFPO LFPN LFPO').idents).toEqual(['LFPO', 'LFPN']);
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
