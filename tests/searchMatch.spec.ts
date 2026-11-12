/* The search's tier scale (src/lib/search/match.ts), one for every kind of
 * result. */

import { describe, it, expect } from 'vitest';
import { frame } from '$lib/search/fold';
import { isIdentTier, matchTier, nameTier, NO_MATCH, TIER, type SearchKey } from '$lib/search/match';
import { prepareQuery } from '$lib/search/query';

function key(k: { id?: string[]; altId?: string[]; name?: string[]; altName?: string[] }): SearchKey {
	return { id: k.id ?? [], altId: k.altId ?? [], name: frame(k.name ?? []), altName: frame(k.altName ?? []) };
}
const tier = (k: SearchKey, q: string, compact = false): number => matchTier(k, prepareQuery(q), compact);

describe('matchTier', () => {
	const lfly = key({ id: ['LFLY'], altId: ['LYN'], name: ['LYON BRON'], altName: ['Lyon'] });

	it('ranks an exact identifier first, the primary before the secondary, then a whole name, then an identifier begun', () => {
		expect(tier(lfly, 'lfly')).toBe(TIER.IDENT_EXACT);
		expect(tier(lfly, 'LYN')).toBe(TIER.ALT_IDENT_EXACT);
		expect(tier(lfly, 'LFL')).toBe(TIER.IDENT_PREFIX);
		expect(tier(key({ id: ['LFPG'], altId: ['CDG'] }), 'CD')).toBe(TIER.ALT_IDENT_PREFIX);
		// "Roma" typed whole is a name before it is the start of ROMAK.
		expect(tier(key({ id: ['ROMAK'], name: ['ROMA'] }), 'roma')).toBe(TIER.NAME_EXACT);
		expect(tier(key({ id: ['ROMAK'] }), 'roma')).toBe(TIER.IDENT_PREFIX);
	});

	it('keeps one order of tiers', () => {
		const order = Object.entries(TIER)
			.sort((a, b) => a[1] - b[1])
			.map(([name]) => name);
		expect(order).toEqual([
			'IDENT_EXACT',
			'ALT_IDENT_EXACT',
			'NAME_EXACT',
			'IDENT_PREFIX',
			'ALT_IDENT_PREFIX',
			'NAME_PREFIX',
			'ALT_NAME_PREFIX',
			'NAME_SUBSTRING',
			'ALT_NAME_SUBSTRING',
			'FAR_IDENT',
			'IDENT_SUBSTRING',
		]);
		expect(Object.values(TIER).filter(isIdentTier)).toEqual([
			TIER.IDENT_EXACT,
			TIER.ALT_IDENT_EXACT,
			TIER.IDENT_PREFIX,
			TIER.ALT_IDENT_PREFIX,
		]);
	});

	it('matches the names alone, for an identifier too far to count', () => {
		// Pauk, Myanmar, is PAU by its IATA code and "pau" begins its name.
		const vypk = key({ id: ['VYPK'], altId: ['PAU'], name: ['Pauk Airport'] });
		expect(tier(vypk, 'PAU')).toBe(TIER.ALT_IDENT_EXACT);
		expect(nameTier(vypk, prepareQuery('PAU'))).toBe(TIER.NAME_PREFIX);
		expect(nameTier(key({ id: ['ROMAK'], name: ['ROMA'] }), prepareQuery('Roma'))).toBe(TIER.NAME_EXACT);
		expect(nameTier(key({ id: ['VERL'], name: ['Raxaul Airport'] }), prepareQuery('VERL'))).toBe(NO_MATCH);
	});

	it('then names: whole, every word beginning a word in any order, the secondary names included', () => {
		expect(tier(lfly, 'Lyon Bron')).toBe(TIER.NAME_EXACT);
		expect(tier(lfly, 'bron lyon')).toBe(TIER.NAME_PREFIX);
		expect(tier(lfly, 'bron')).toBe(TIER.NAME_PREFIX);
		expect(tier(key({ id: ['LFLY'], name: ['BRON'], altName: ['Lyon'] }), 'lyon bron')).toBe(TIER.ALT_NAME_PREFIX);
	});

	it('then substrings of three letters or more, the identifier last', () => {
		expect(tier(lfly, 'yon b')).toBe(TIER.NAME_SUBSTRING);
		expect(tier(key({ id: ['LFLY'], name: ['BRON'], altName: ['Villeurbanne'] }), 'urban')).toBe(
			TIER.ALT_NAME_SUBSTRING,
		);
		expect(tier(lfly, 'ro')).toBe(NO_MATCH);
		expect(tier(lfly, 'FL')).toBe(TIER.IDENT_SUBSTRING);
		expect(tier(lfly, 'X')).toBe(NO_MATCH);
	});

	it('meets accents, hyphens and Saint as a pilot types them', () => {
		const lfmh = key({ id: ['LFMH'], name: ['SAINT ETIENNE LOIRE'] });
		for (const q of ['Saint-Étienne', 'saint etienne', 'st etienne', 'St-Etienne', 'etienne st']) {
			expect([TIER.NAME_EXACT, TIER.NAME_PREFIX], q).toContain(tier(lfmh, q));
		}
		expect(tier(key({ id: ['EDDS'], name: ['STUTTGART'] }), 'st')).toBe(TIER.NAME_PREFIX);
		const lfbm = key({ id: ['LFBM'], name: ['MONT DE MARSAN'] });
		expect(tier(lfbm, 'Mont-de-Marsan')).toBe(TIER.NAME_EXACT);
	});

	it('finds München however it is written, and DFS writes it MUENCHEN', () => {
		const dfs = key({ id: ['EDDM'], name: ['MUENCHEN'] });
		const baseline = key({ id: ['EDDM'], name: ['München'] });
		for (const k of [dfs, baseline]) {
			for (const q of ['München', 'Munchen', 'Muenchen', 'MÜNCHEN']) {
				expect(tier(k, q), q).toBe(TIER.NAME_EXACT);
			}
		}
	});

	it('compares designators on their compact form', () => {
		const r45a = key({ id: ['LFR45A'], name: ['R 45 A'] });
		expect(tier(r45a, 'LF-R 45 A', true)).toBe(TIER.IDENT_EXACT);
		expect(tier(r45a, 'lfr45', true)).toBe(TIER.IDENT_PREFIX);
		expect(tier(r45a, 'R 45 A', true)).toBe(TIER.NAME_EXACT);
	});

	it('matches nothing on an empty query', () => {
		expect(tier(lfly, '   ')).toBe(NO_MATCH);
	});
});
