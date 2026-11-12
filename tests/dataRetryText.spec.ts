/* The data retry banner's sentence, in both languages
 * (src/lib/format/dataRetry.ts over the catalogs' own words). */

import { describe, expect, it } from 'vitest';
import { describeMissing, type DataRetryWords } from '$lib/format/dataRetry';
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
			'Some aeronautical data did not load: airspaces (Germany), obstacles. Retrying.',
		);
		expect(describeMissing(entries, words(fr))).toBe(
			'Certaines données aéronautiques n’ont pas été chargées : espaces aériens (Allemagne), obstacles. Nouvelle tentative en cours.',
		);
	});

	it('lists several publishers of a group in the order given, the FIR rings included', () => {
		expect(
			describeMissing([{ group: 'airspaces', parts: ['de', 'at', 'pruatlas'] }], words(en)),
		).toBe('Some aeronautical data did not load: airspaces (Germany, Austria, Worldwide FIRs). Retrying.');
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
			'Some aeronautical data did not load: aerodrome charts (Czechia, Denmark, United States). Retrying.',
		);
		expect(describeMissing(entries, { ...words(fr), regionName: regions('fr-FR') })).toBe(
			'Certaines données aéronautiques n’ont pas été chargées : cartes d’aérodrome (Tchéquie, Danemark, États-Unis). Nouvelle tentative en cours.',
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
