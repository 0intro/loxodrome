/* A navaid's frequency, from the committed datasets to the label the app
 * prints. An NDB's carrier is in kHz, the unit every surface appends
 * (navaidFreqLabel, NavaidDetail): written in MHz, AVIANO's 390 kHz reads
 * 0.390 and prints "0.390 kHz", and ENAIRE's 395000 for BILBAO's 395 kHz
 * printed "395000 kHz". The AIM 1-1-2 gives the NDB band, after ICAO
 * Annex 10, as 190 to 1750 kHz, and every carrier in kHz lies in it. A
 * frequency of 0 is none at all. */

import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, serveCoverageSite } from './helpers/coverageSite';
import { loadNavaids, navaidFreqLabel } from '$lib/data/navaids';

const FILES = readdirSync('public/data')
	.filter((f) => /-navaids(\.next)?\.json$/.test(f))
	.sort();

describe('the committed navaid datasets', () => {
	it('are there to judge', () => {
		expect(FILES.length).toBeGreaterThan(20);
	});

	it.each(FILES)('%s carries every NDB in kHz, inside the band', (file) => {
		const doc = JSON.parse(readFileSync(`public/data/${file}`, 'utf8')) as {
			fields: string[];
			rows: unknown[][];
		};
		const type = doc.fields.indexOf('type');
		const freq = doc.fields.indexOf('freq');
		const inBand = (khz: number) => khz >= 190 && khz <= 1750;
		const outside = doc.rows.filter((r) => r[type] === 'NDB' && r[freq] !== '' && !inBand(Number(r[freq])));
		expect(outside.map((r) => [r[0], r[freq]])).toEqual([]);
	});
});

describe('loadNavaids', () => {
	beforeEach(() => {
		serveCoverageSite();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	// The SIA files 0 for the eight foreign stations it gives no frequency
	// (NDB SLU and VOR VLI among them). Read as a frequency, it prints
	// "0 kHz" or "0.000 MHz" in the panels and the search rows.
	it('reads a frequency of 0, or one that is no number, as none', async () => {
		serve('/data/x-navaids.json', {
			fields: [],
			rows: [
				['NDB:1524031', 'NDB', 'SLU', 'GEORGE F. CHARLES', 14.01414, -61.00606, '0', '', null],
				['VOR:1526949', 'VOR', 'VLI', 'PORT VILA', -17.66215, 168.24393, '0', '', null],
				['x:1', 'VOR-DME', 'ABC', '', 48, 2, '1l3.6', '83X', null],
				['NDB:1524142', 'NDB', 'LOR', 'LORIENT LANN BIHOUE', 47.76319, -3.44069, '359', '', 188],
			],
		});
		const navaids = await loadNavaids('/data/x-navaids.json');
		expect(navaids.map((n) => [n.ident, n.freq, navaidFreqLabel(n)])).toEqual([
			['SLU', '', ''],
			['VLI', '', ''],
			['ABC', '', 'CH 83X'],
			['LOR', '359', '359 kHz'],
		]);
	});
});
