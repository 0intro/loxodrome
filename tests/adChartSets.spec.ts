/* Which per-publisher chart sets an aerodrome's panel reads
 * (state/adCharts.svelte.ts chartSetsFor). The panel loaded all five for
 * every field, the FAA's d-TPP list alone 1 MB, and a set that failed to
 * read put its retry in the data banner: an offline first use named FAA and
 * UK charts on a French field's panel. Each set is now read for the fields
 * it can hold, by ICAO prefix, the FAA's also for a United States field
 * keyed by its FAA identifier. The gate is held to the committed sets: every
 * row the baseline lists passes its own set's gate. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartSetsFor } from '$lib/state/adCharts.svelte';

interface Table {
	fields: string[];
	rows: unknown[][];
}

const data = (f: string): Table =>
	JSON.parse(readFileSync(join(process.cwd(), 'public/data', f), 'utf8')) as Table;

describe('chartSetsFor', () => {
	it('names the set a field belongs to, and none outside the five', () => {
		const cases: [string, string, string[]][] = [
			['LFPN', 'FR', ['fr']],
			['LNMC', 'MC', ['fr']],
			['EGLL', 'GB', ['uk']],
			['EGJJ', 'JE', ['uk']],
			['KJFK', 'US', ['us']],
			['PHNL', 'US', ['us']],
			['TJSJ', 'PR', ['us']],
			['1D2', 'US', ['us']],
			['EDDF', 'DE', ['de']],
			['ETNL', 'DE', ['de']],
			['LOWW', 'AT', ['at']],
			['LEMD', 'ES', []],
			['EBBR', 'BE', []],
			['CYUL', 'CA', []],
		];
		for (const [ident, country, want] of cases) {
			expect(chartSetsFor({ ident, country }), ident).toEqual(want);
			expect(chartSetsFor({ ident: ident.toLowerCase(), country }), ident.toLowerCase()).toEqual(want);
		}
	});

	it('admits every committed row the airports baseline lists', () => {
		const base = data('airports.json');
		const ii = base.fields.indexOf('ident');
		const ic = base.fields.indexOf('iso_country');
		const country = new Map(base.rows.map((r) => [String(r[ii]), String(r[ic])]));
		for (const set of ['fr', 'uk', 'us', 'de', 'at'] as const) {
			const listed = data(`${set}-adcharts.json`).rows.map((r) => String(r[0])).filter((i) => country.has(i));
			expect(listed.length, set).toBeGreaterThan(50);
			const missed = listed.filter((i) => !chartSetsFor({ ident: i, country: country.get(i)! }).includes(set));
			expect(missed, set).toEqual([]);
		}
	});
});
