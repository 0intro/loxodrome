/* The data retry banner's sentence, in both languages
 * (src/lib/format/dataRetry.ts over the catalogs' own words). */

import { describe, expect, it } from 'vitest';
import { describeMissing, failureText, sharedFailure, type DataRetryWords } from '$lib/format/dataRetry';
import type { ReadFailure } from '$lib/data/fetchData';
import type { RetryView } from '$lib/state/dataRetry.svelte';
import { en } from '../src/lib/i18n/en';
import { fr } from '../src/lib/i18n/fr';

const words = (m: typeof en): DataRetryWords => ({
	sentence: m.common.dataRetry,
	groups: m.common.dataRetryGroups,
	publishers: m.layers.publisherNames,
});

describe('the data retry sentence', () => {
	it('names each group, and its missing publishers in brackets', () => {
		const entries = [
			{ group: 'airspaces' as const, parts: ['de'] },
			{ group: 'obstacles' as const, parts: [] },
		];
		expect(describeMissing(entries, words(en))).toBe(
			'Some aeronautical data did not load: airspaces (Germany), obstacles. Retrying automatically.',
		);
		expect(describeMissing(entries, words(fr))).toBe(
			'Certaines données aéronautiques n’ont pas été chargées : espaces aériens (Allemagne), obstacles. Nouvelles tentatives automatiques.',
		);
	});

	it('lists several publishers of a group in the order given, the FIR rings included', () => {
		expect(
			describeMissing([{ group: 'airspaces', parts: ['de', 'at', 'pruatlas'] }], words(en)),
		).toBe('Some aeronautical data did not load: airspaces (Germany, Austria, Worldwide FIRs). Retrying automatically.');
	});

	it('names a chart index that is no publisher by its region, in the reading language', () => {
		// The held States' and Denmark's chart indexes ship with no Layers
		// name: the banner read "aerodrome charts (CZ)". The About dialog's
		// rule, the catalog's name else the locale's own for the region.
		const regions = (tag: string) => {
			const names = new Intl.DisplayNames([tag], { type: 'region', fallback: 'none' });
			return (code: string): string | undefined => (/^[a-z]{2}$/.test(code) ? names.of(code.toUpperCase()) : undefined);
		};
		const entries = [{ group: 'charts' as const, parts: ['cz', 'dk', 'faa'] }];
		expect(describeMissing(entries, { ...words(en), regionName: regions('en-GB') })).toBe(
			'Some aeronautical data did not load: aerodrome charts (Czechia, Denmark, United States). Retrying automatically.',
		);
		expect(describeMissing(entries, { ...words(fr), regionName: regions('fr-FR') })).toBe(
			'Certaines données aéronautiques n’ont pas été chargées : cartes d’aérodrome (Tchéquie, Danemark, États-Unis). Nouvelles tentatives automatiques.',
		);
	});

	it('gives every group a name in both languages', () => {
		for (const m of [en, fr]) {
			for (const name of Object.values(m.common.dataRetryGroups)) {
				expect(name.length).toBeGreaterThan(0);
			}
		}
		expect(Object.keys(fr.common.dataRetryGroups)).toEqual(Object.keys(en.common.dataRetryGroups));
	});
});

describe('the sentence after a Retry now that did not land', () => {
	const still = (m: typeof en): DataRetryWords => ({ ...words(m), sentence: m.common.dataRetryStill });
	const entries = [{ group: 'airspaces' as const, parts: ['de'] }];

	it('says what is still missing, with the failure the reads share', () => {
		const http = { kind: 'http', status: 503 } as const;
		expect(describeMissing(entries, still(en), failureText(http, en.common.dataRetryFailures))).toBe(
			'Some aeronautical data still did not load: airspaces (Germany). HTTP 503. Retrying automatically.',
		);
		expect(describeMissing(entries, still(fr), failureText(http, fr.common.dataRetryFailures))).toBe(
			'Certaines données aéronautiques n’ont toujours pas été chargées\u202f: espaces aériens (Allemagne). HTTP 503. Nouvelles tentatives automatiques.',
		);
		expect(describeMissing(entries, still(en))).toBe(
			'Some aeronautical data still did not load: airspaces (Germany). Retrying automatically.',
		);
	});

	it('words each kind of failure in both languages, the HTTP frame the same in both', () => {
		const kinds = [{ kind: 'stalled' }, { kind: 'unanswered' }, { kind: 'unreadable' }, 'offline'] as const;
		expect(kinds.map((k) => failureText(k, en.common.dataRetryFailures))).toEqual([
			'No data for 30 s',
			'No answer from the server',
			'The file does not parse',
			'The device is offline',
		]);
		expect(kinds.map((k) => failureText(k, fr.common.dataRetryFailures))).toEqual([
			'Aucune donnée pendant 30 s',
			'Pas de réponse du serveur',
			'Le fichier est illisible',
			'L’appareil est hors ligne',
		]);
		expect(failureText({ kind: 'http', status: 502 }, fr.common.dataRetryFailures)).toBe('HTTP 502');
	});

	it('states a failure only when every read the banner names shares it, the device offline first', () => {
		const view = (failure: ReadFailure | null): RetryView => ({ key: 'k', group: 'airspaces', parts: [], announced: true, quiet: false, failure });
		const http = (status: number): ReadFailure => ({ kind: 'http', status });
		expect(sharedFailure([view(http(503)), view(http(503))], false)).toEqual(http(503));
		expect(sharedFailure([view(http(503)), view(http(502))], false)).toBeNull();
		expect(sharedFailure([view({ kind: 'stalled' }), view(null)], false)).toBeNull();
		expect(sharedFailure([view(null)], false)).toBeNull();
		expect(sharedFailure([view({ kind: 'stalled' })], true)).toBe('offline');
	});

	it('says the data loaded, in both languages', () => {
		expect(en.common.dataRetryLoaded).toBe('The missing data loaded.');
		expect(fr.common.dataRetryLoaded).toBe('Les données manquantes sont chargées.');
	});
});
