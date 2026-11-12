/* The search's one fold (src/lib/search/fold.ts): what a pilot types and
 * what the datasets write meet as the same words. */

import { describe, it, expect } from 'vitest';
import { foldText, foldVariants, foldWords, frame, wordAlternatives } from '$lib/search/fold';

describe('foldWords', () => {
	it.each([
		['LYON BRON', 'lyon bron'],
		['Angoulême', 'angouleme'],
		['Saint-Étienne', 'saint etienne'],
		["L'Isle-Adam", 'l isle adam'],
		['Großenhain', 'grossenhain'],
		['Ærøskøbing', 'aeroskobing'],
		['Łódź', 'lodz'],
		['Col·legi', 'collegi'],
		['  KOELN/BONN  ', 'koeln bonn'],
		['BOZEN KH - \nBOLZANO', 'bozen kh bolzano'],
		['', ''],
	])('folds %j to %j', (s, want) => {
		expect(foldWords(s)).toBe(want);
	});
});

describe('foldText', () => {
	it('writes the abbreviations of Saint out, whole words only', () => {
		expect(foldText('ST ETIENNE LOIRE')).toBe('saint etienne loire');
		expect(foldText('Sankt Gallen')).toBe('saint gallen');
		expect(foldText('STE COLOMBE')).toBe('sainte colombe');
		expect(foldText('STUTTGART')).toBe('stuttgart');
	});
});

describe('wordAlternatives', () => {
	it('lets "st" stand for Saint and for the first letters of Stuttgart', () => {
		expect(wordAlternatives('st')).toEqual(['st', 'saint']);
		expect(wordAlternatives('ste')).toEqual(['ste', 'sainte']);
		expect(wordAlternatives('stu')).toEqual(['stu']);
	});
});

describe('foldVariants', () => {
	it('contracts the umlauts DFS writes out, and writes out the ones it does not', () => {
		expect(foldVariants('MUENCHEN')).toEqual(['muenchen', 'munchen']);
		expect(foldVariants('München')).toEqual(['munchen', 'muenchen']);
		expect(foldVariants('KOELN/BONN')).toEqual(['koeln bonn', 'koln bonn']);
	});

	it('drops apostrophes as another spelling', () => {
		expect(foldVariants("L'Isle-Adam")).toEqual(['l isle adam', 'lisle adam']);
		expect(foldVariants('L’Isle-Adam')).toEqual(['l isle adam', 'lisle adam']);
	});

	it('is the fold alone for a plain name, and nothing for an empty one', () => {
		expect(foldVariants('LYON BRON')).toEqual(['lyon bron']);
		expect(foldVariants('')).toEqual([]);
	});
});

describe('frame', () => {
	it('frames every form of every field, skipping empty ones', () => {
		expect(frame(['München', '', null, 'Munich'])).toBe('\n munchen\n\n muenchen\n\n munich\n');
	});
});
