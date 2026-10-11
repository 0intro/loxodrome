/* The one filename grammar (docs/file-names.md): the field fold, the ISO
 * 8601 basic UTC stamps, field omission, and the print-job stems every
 * printed document is named by. */

import { describe, it, expect } from 'vitest';
import { APP_SUBJECT, fileDayUtc, fileName, fileStampUtc, fileStem, fileToken } from '$lib/files/fileName';

describe('fileToken', () => {
	it('folds diacritics to their base letter', () => {
		expect(fileToken('Bâle')).toBe('Bale');
		expect(fileToken('Aérodrome de Saint-Cyr')).toBe('Aerodrome-de-Saint-Cyr');
		expect(fileToken('Nîmes-Garons')).toBe('Nimes-Garons');
	});

	it('collapses every run of punctuation and space to one separator', () => {
		expect(fileToken('48.857, 2.352')).toBe('48-857-2-352');
		expect(fileToken('LFPN / LFOZ')).toBe('LFPN-LFOZ');
	});

	it('keeps case, so an ident reads as an ident', () => {
		expect(fileToken('F-GORQ')).toBe('F-GORQ');
		expect(fileToken('LFPN')).toBe('LFPN');
	});

	it('trims the separators off both ends', () => {
		expect(fileToken('  -LFPN-  ')).toBe('LFPN');
		// A key of nothing but punctuation is an EMPTY field, never a bare "-":
		// the Aircraft tab's own slug used to emit "-.yaml" for exactly this.
		expect(fileToken('///')).toBe('');
		expect(fileToken('')).toBe('');
	});

	it('caps a field and never ends it on a separator', () => {
		const token = fileToken('a'.repeat(150));
		expect(token).toHaveLength(100);
		expect(fileToken(`${'a'.repeat(99)} tail`)).toBe('a'.repeat(99));
	});
});

describe('the UTC stamps', () => {
	/* Local time would name a 23:50 flight with tomorrow's date east of
	 * Greenwich, and these files get sent to a club. */
	it('stamps UTC, not the local day', () => {
		expect(fileStampUtc(Date.UTC(2026, 6, 7, 23, 50, 0))).toBe('20260707T2350Z');
		expect(fileStampUtc(Date.UTC(2026, 0, 1, 0, 5, 0))).toBe('20260101T0005Z');
		expect(fileDayUtc(Date.UTC(2026, 6, 7, 23, 50, 0))).toBe('20260707');
	});

	/* ISO 8601 BASIC: the extended form's colons are reserved on Windows and
	 * on macOS, so a name carrying one is not a name at all there. */
	it('carries no character a filesystem reserves', () => {
		const stamp = fileStampUtc(Date.UTC(2026, 6, 7, 14, 32, 0));
		expect(stamp).toBe('20260707T1432Z');
		expect(stamp).toMatch(/^[0-9A-Z]+$/);
	});
});

describe('fileStem', () => {
	it('joins the fields with the field separator', () => {
		expect(fileStem(['LFPN-LFOZ', 'dossier', '20260707'])).toBe('LFPN-LFOZ_dossier_20260707');
	});

	/* A field the application has no value for disappears; it never leaves a
	 * separator behind, which is what makes the grammar readable at both
	 * ends of the range. */
	it('omits an absent field rather than leaving a gap', () => {
		expect(fileStem(['', 'plan'])).toBe('plan');
		expect(fileStem([null, 'plan', undefined])).toBe('plan');
		expect(fileStem(['LFPN-LFOZ', undefined, '20260707T1432Z'])).toBe(
			'LFPN-LFOZ_20260707T1432Z',
		);
	});

	it('falls back to the application when every field is empty', () => {
		expect(fileStem([])).toBe(APP_SUBJECT);
		expect(fileStem(['', null])).toBe(APP_SUBJECT);
	});

	/* A file whose whole stem is a Windows device name cannot be created
	 * there. Unreachable through the composers, since each adds a kind or a
	 * stamp beside the subject, but a navaid ident is three letters. */
	it('escapes a Windows reserved device name', () => {
		expect(fileStem(['CON'])).toBe('loxodrome_CON');
		expect(fileStem(['prn'])).toBe('loxodrome_prn');
		expect(fileStem(['COM1'])).toBe('loxodrome_COM1');
		// Only the WHOLE stem is reserved; one field among several is not.
		expect(fileStem(['CON', 'plan'])).toBe('CON_plan');
	});
});

describe('fileName', () => {
	it('is the stem plus the extension', () => {
		expect(fileName(['LFPN-LFOZ', 'plan'], 'yaml')).toBe('LFPN-LFOZ_plan.yaml');
		expect(fileName(['F-GORQ', 'aircraft'], 'yaml')).toBe('F-GORQ_aircraft.yaml');
		expect(fileName([APP_SUBJECT, 'traces', '20260817T1043Z'], 'zip')).toBe(
			'loxodrome_traces_20260817T1043Z.zip',
		);
	});

	/* No name this grammar builds may carry a space or a reserved character:
	 * the one thing every filesystem in use agrees on. */
	it('never produces a space or a reserved character', () => {
		const names = [
			fileName([fileToken('Aérodrome de Saint-Cyr'), 'plan'], 'yaml'),
			fileName([fileToken('48.857, 2.352'), fileStampUtc(0)], 'gpx'),
			fileName([APP_SUBJECT, 'logbook', fileStampUtc(0)], 'csv'),
		];
		for (const name of names) {
			expect(name).not.toMatch(/[\s<>:"/\\|?*]/);
		}
	});
});
