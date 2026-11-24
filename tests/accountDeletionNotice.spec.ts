/* The notice over "Cancel the deletion", signed in to an account staged for
 * deletion. The date comes from GET /v1/account, which the surface asks
 * on every open: until it answers, or when it cannot (offline), and when
 * the deletion was cancelled from another device, the surface stood in
 * today's date, up to seven days earlier than the real deadline. Unknown,
 * the notice now states no date. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const root = new URL('..', import.meta.url).pathname;
const modal = readFileSync(join(root, 'src/lib/components/AccountModal.svelte'), 'utf-8');

describe('the deletion notice of a signed-in account', () => {
	it('names the date it knows, in both languages', () => {
		expect(en.account.deleteStagedSignedIn('3 December 2026')).toContain('3 December 2026');
		expect(fr.account.deleteStagedSignedIn('3 décembre 2026')).toContain('3 décembre 2026');
	});

	it('states no date it does not know, in both languages', () => {
		expect(en.account.deleteStagedSignedIn(null)).toBe(
			'Deletion scheduled. Choose "Cancel the deletion" to keep the account.',
		);
		expect(fr.account.deleteStagedSignedIn(null)).toBe(
			'Suppression prévue. Choisissez "Annuler la suppression" pour conserver le compte.',
		);
	});

	it('is fed the account’s own date or none, never the clock', () => {
		expect(modal).not.toMatch(/deleteStagedSignedIn\([^\n]*Date\.now/);
		expect(modal).toContain(
			'deleteStagedSignedIn(info?.deleteAfter != null ? fmtDate(info.deleteAfter) : null)',
		);
	});
});
