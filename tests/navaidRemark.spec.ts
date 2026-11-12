/* A French reporting point's remark and stated aerodrome, from fr-navaids'
 * two last columns to the app: the loader, the search's second name, the
 * rows' words and the navaid sheet (docs/fr-aip.md "A reporting point's
 * landmark is its remark"). */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, serveCoverageSite } from './helpers/coverageSite';
import { loadNavaids, NAVAID_LABELS, type Navaid } from '$lib/data/navaids';
import { rankNavaids } from '$lib/search/navaids';
import { TIER } from '$lib/search/match';
import { prepareQuery } from '$lib/search/query';
import { hitSubtitle } from '$lib/state/waypointSearch.svelte';

beforeEach(() => {
	serveCoverageSite();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const BIN = ['VRP:1', 'VFR_REPORTING_POINT', 'BIN', 'BI-N', 46.71, 0.31, '', '', null, 'VRP-Neuville de Poitou', 'LFBI'];

describe('loadNavaids', () => {
	it('reads the remark and the aerodrome where the file carries them, and empty strings elsewhere', async () => {
		serve('/data/fr-x.json', { fields: [], rows: [BIN] });
		serve('/data/de-x.json', { fields: [], rows: [['de:1', 'VOR', 'MUN', 'MUENCHEN', 48.1, 11.6, '112.3', '', 1600]] });
		const [fr] = await loadNavaids('/data/fr-x.json');
		const [de] = await loadNavaids('/data/de-x.json');
		expect([fr.rmk, fr.ad]).toEqual(['VRP-Neuville de Poitou', 'LFBI']);
		expect([de.rmk, de.ad]).toEqual(['', '']);
	});
});

function vrp(rmk: string): Navaid {
	return { id: 'VRP:1', type: 'VFR_REPORTING_POINT', ident: 'BIN', name: 'BI-N', lat: 46.71, lon: 0.31, freq: '', channel: '', elev: null, rmk, ad: 'LFBI', source: 'fr' };
}

describe('the landmark as a second name', () => {
	it('finds a reporting point by its landmark, under its own name', () => {
		const hits = rankNavaids([vrp('VRP-Neuville de Poitou')], prepareQuery('neuville'), { ref: null, cap: 5 }).hits;
		expect(hits.map((h) => [h.item.ident, h.tier])).toEqual([['BIN', TIER.ALT_NAME_PREFIX]]);
		expect(rankNavaids([vrp('VRP-')], prepareQuery('neuville'), { ref: null, cap: 5 }).hits).toEqual([]);
	});

	it('says the landmark in the route field’s row', () => {
		expect(hitSubtitle({ kind: 'navaid', navaid: vrp('VRP-Neuville de Poitou') }, NAVAID_LABELS)).toBe(
			'VFR reporting point, Neuville de Poitou',
		);
	});
});

describe('the navaid sheet', () => {
	const sheet = readFileSync('src/lib/components/detail/NavaidDetail.svelte', 'utf8');

	it('shows the remark whole, through the AIP remark formatter', () => {
		expect(sheet).toContain('formatAipRemark(navaid.rmk, lang)');
	});

	it('links the aerodrome the AIP states, never the search’s guess', () => {
		expect(sheet).toContain('navaid.ad ? airportByIdent(navaid.ad) : null');
		expect(sheet).toContain('navigateToAirport(aerodrome.ident)');
		expect(sheet).not.toContain('vfrAerodromes');
	});
});
