/* Unit tests for the bilingual AIP-remark formatter (format/remark.ts): the
 * "French\\English" split, the locale pick with empty-side fallback, and the
 * '#' line-break normalisation shared by the airspace and obstacle panels.
 * Sample strings are real SIA remark data (each literal `\\` is one backslash,
 * so `\\\\` here is the two-backslash separator at runtime). */

import { describe, it, expect } from 'vitest';
import { formatAipRemark } from '$lib/format/remark';

describe('formatAipRemark', () => {
	it('keeps the French side in fr', () => {
		expect(
			formatAipRemark(
				'0400-1300 jours ouvrables seulement\\\\0400-1300 working days only',
				'fr',
			),
		).toBe('0400-1300 jours ouvrables seulement');
	});

	it('keeps the English side in en', () => {
		expect(formatAipRemark('Tour + mât\\\\Tower and mast', 'en')).toBe(
			'Tower and mast',
		);
	});

	it('tolerates whitespace around the separator', () => {
		expect(formatAipRemark('Tour + pylônet \\\\ Tower', 'en')).toBe('Tower');
		expect(formatAipRemark('Tour + pylônet \\\\ Tower', 'fr')).toBe(
			'Tour + pylônet',
		);
	});

	it('falls back to the other side when the chosen one is empty', () => {
		expect(formatAipRemark('\\\\English only', 'fr')).toBe('English only');
		expect(formatAipRemark('Texte seul\\\\', 'en')).toBe('Texte seul');
	});

	it('passes a single-language remark through unchanged (no separator)', () => {
		expect(formatAipRemark('Activity according to protocol.', 'fr')).toBe(
			'Activity according to protocol.',
		);
	});

	it('trims a trailing break left by a "#" against the separator', () => {
		// Real airspace form (LFR215): the French half ends with '#' right
		// before the "\\" separator, which must not leave a trailing blank line.
		const raw =
			"SR-30 à SS+30 pendant l'activité de la CTR SAINT-DIZIER.#\\\\SR- 30 to SS+30 during SAINT- DIZIER CTR activity.";
		expect(formatAipRemark(raw, 'fr')).toBe(
			"SR-30 à SS+30 pendant l'activité de la CTR SAINT-DIZIER.",
		);
		expect(formatAipRemark(raw, 'en')).toBe(
			'SR- 30 to SS+30 during SAINT- DIZIER CTR activity.',
		);
	});

	it('normalises # to newlines within the chosen side', () => {
		expect(
			formatAipRemark(
				'100LL: 1 tank#JET A1: 2 tanks\\\\100LL: 1 tank#JET A1: 2 tanks',
				'en',
			),
		).toBe('100LL: 1 tank\nJET A1: 2 tanks');
		// Single-language remark still gets the '#' break.
		expect(formatAipRemark('Line 1#Line 2', 'en')).toBe('Line 1\nLine 2');
	});
});
