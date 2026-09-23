/* Drift net over the hosted account-deletion page.
 *
 * public/account-deletion.html is the web resource Google Play's
 * account-deletion policy asks for, the URL the Data safety form carries. It
 * is hand-written like terms.html, so it quotes the account screen's buttons
 * and the service's grace period by hand. This pins both to their sources: a
 * renamed button or a new grace must fail here rather than leave a public page
 * walking people through an application that no longer exists. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const root = new URL('..', import.meta.url).pathname;
const html = readFileSync(join(root, 'public/account-deletion.html'), 'utf-8');
const worker = readFileSync(join(root, 'account-api/worker.ts'), 'utf-8');

// The named entities the page is written with. An unknown one throws rather
// than decoding to nothing, which would let a label comparison pass on a
// string the browser renders differently.
const NAMED: Record<string, string> = {
	acirc: '\u00e2',
	agrave: '\u00e0',
	ccedil: '\u00e7',
	eacute: '\u00e9',
	Eacute: '\u00c9',
	ecirc: '\u00ea',
	egrave: '\u00e8',
	hellip: '\u2026',
	middot: '\u00b7',
	ocirc: '\u00f4',
	ugrave: '\u00f9',
};

function decode(s: string): string {
	return s.replace(/&(#\d+|[A-Za-z]+);/g, (m, name: string) => {
		if (name.startsWith('#')) {
			return String.fromCodePoint(Number(name.slice(1)));
		}
		const c = NAMED[name];
		if (c === undefined) {
			throw new Error(`unknown entity ${m}`);
		}
		return c;
	});
}

/** One language's section as the text a reader sees. */
function section(lang: 'en' | 'fr'): string {
	const m = new RegExp(`<section lang="${lang}">([\\s\\S]*?)</section>`).exec(html);
	if (!m?.[1]) {
		throw new Error(`public/account-deletion.html has no ${lang} section`);
	}
	// ASCII whitespace only: `\s` also matches the narrow no-break space the
	// French typography rests on, and would fold it into the ordinary one.
	return decode(m[1].replace(/<[^>]+>/g, '')).replace(/[ \t\r\n]+/g, ' ');
}

describe('hosted account-deletion page', () => {
	it("quotes the account screen's own labels, in each language", () => {
		for (const [lang, cat] of [
			['en', en],
			['fr', fr],
		] as const) {
			const text = section(lang);
			for (const label of [
				cat.account.deleteAccount,
				cat.account.sudoConfirm,
				cat.account.signOutWipeOption,
				cat.display.reset,
			]) {
				expect(text, `${lang}: the page no longer quotes "${label}"`).toContain(label);
			}
		}
	});

	it('states the grace the service applies', () => {
		const m = /const DELETE_STAGE_MS = (\d+) \* 86_400_000;/.exec(worker);
		expect(m, 'DELETE_STAGE_MS moved in account-api/worker.ts').not.toBeNull();
		const days = Number(m?.[1]);
		expect(section('en')).toContain(`${days}-day grace`);
		expect(section('en')).toContain(`during those ${days} days`);
		expect(section('fr')).toContain(`${days}\u202fjours`);
	});

	it('names the application and reaches the deletion without it', () => {
		for (const lang of ['en', 'fr'] as const) {
			expect(section(lang)).toContain('Loxodrome');
		}
		expect(html.match(/href="https:\/\/loxodrome\.fr\/\?account="/g)).toHaveLength(2);
	});

	it('is self-contained', () => {
		// Like privacy.html and terms.html: it must read whole with JavaScript
		// off and fetch nothing.
		expect(html).not.toMatch(/<script|<link|@import|\bsrc=|url\(/i);
	});
});
