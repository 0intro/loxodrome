/* A supplement's subject reads in the SUP AIP language the pilot chose
 * (Settings, 'auto' following the interface), wherever it shows: the
 * phone's Brief list and the sheet a row opens agree on one supplement.
 * One rule, data/supaip.ts supaipSubject, read by both; the components are
 * pinned by their source, the node project rendering none. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { supaipSubject, supaipSubjectLang, type SupAip } from '$lib/data/supaip';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const sup = (descriptionFr: string, descriptionEn: string): SupAip =>
	({ id: 'metropole-2026-001', descriptionFr, descriptionEn }) as SupAip;

describe('supaipSubject', () => {
	const both = sup('Exercice militaire', 'Military exercise');

	it('follows the preference over the interface', () => {
		expect(supaipSubject(both, 'fr', 'en')).toBe('Exercice militaire');
		expect(supaipSubject(both, 'en', 'fr')).toBe('Military exercise');
	});

	it('follows the interface on auto', () => {
		expect(supaipSubject(both, 'auto', 'fr')).toBe('Exercice militaire');
		expect(supaipSubject(both, 'auto', 'en')).toBe('Military exercise');
	});

	it('reads the local subject of a supplement that publishes no English', () => {
		const local = sup('Travaux', '');
		expect(supaipSubject(local, 'en', 'en')).toBe('Travaux');
		expect(supaipSubjectLang(local, 'en', 'en')).toBe('fr');
	});

	it('reads the English subject where the local slot is empty', () => {
		// A Belgian supplement publishes its subject in English alone.
		expect(supaipSubject(sup('', 'Air show'), 'fr', 'fr')).toBe('Air show');
	});
});

describe('the subject on screen', () => {
	it('reads through the one rule in the Brief list and the sheet', () => {
		const list = read('src/lib/components/ZoneList.svelte');
		const sheet = read('src/lib/components/detail/SupAipDetail.svelte');
		expect(list).toContain('supaipSubject(s, display.supaipLang, i18n.locale)');
		expect(sheet).toContain('supaipSubject(supaip, display.supaipLang, i18n.locale)');
		for (const src of [list, sheet]) {
			expect(src).not.toMatch(/\.description(Fr|En)\b/);
		}
	});
});
