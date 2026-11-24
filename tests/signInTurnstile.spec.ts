/* The sign-in dialog and its Turnstile token (LoginModal.svelte).
 *
 * A token is single-use: the worker's siteverify spends it on the code
 * request, and a refused one gets the same silent 204 as a sent code. Back
 * from the code step kept the spent token, so Send was enabled before the
 * remounted widget answered, and a quick resend said a code was sent that
 * never came. A request that failed kept it too, on a widget that stayed
 * mounted. The dialog runs only in a browser, so these pin its source.
 *
 * And a challenge whose script cannot load (no network, a filtering
 * network, a blocker) never called back at all: Send stayed disabled with
 * nothing to say why. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const root = new URL('..', import.meta.url).pathname;
const modal = readFileSync(join(root, 'src/lib/components/LoginModal.svelte'), 'utf-8');
const widget = readFileSync(join(root, 'src/lib/components/TurnstileWidget.svelte'), 'utf-8');

/** The body of one function of the dialog's script. */
function body(name: string): string {
	const m = new RegExp(`function ${name}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\t\\}`).exec(modal);
	expect(m, `${name} moved in LoginModal.svelte`).not.toBeNull();
	return m?.[1] ?? '';
}

describe('the sign-in dialog’s Turnstile token', () => {
	it('is dropped going back to the e-mail step', () => {
		expect(body('backToEmail')).toMatch(/turnstileToken = '';[\s\S]*stage = 'email';/);
		expect(modal).toMatch(/onclick=\{backToEmail\}/);
	});

	it('is dropped, and the widget asked again, when the code request fails', () => {
		const send = body('submitEmail');
		const caught = send.slice(send.indexOf('catch'));
		expect(caught).toContain("turnstileToken = '';");
		expect(caught).toContain('widgetRound++;');
		expect(modal).toMatch(/\{#key widgetRound\}\s*<TurnstileWidget/);
	});
});

describe('a Turnstile challenge that fails', () => {
	it('is reported by the widget, from the script and from the challenge', () => {
		expect(widget).toMatch(/script\.onerror = \(\) => \{\s*if \(!cancelled\) \{\s*onError\?\.\(\);/);
		expect(widget).toMatch(/'error-callback': \(\) => \{\s*onError\?\.\(\);\s*\}/);
	});

	it('is said by the dialog until a token arrives', () => {
		expect(modal).toMatch(/onError=\{challengeError\}/);
		expect(body('challengeError')).toMatch(/turnstileToken = '';[\s\S]*challengeFailed = true;/);
		expect(body('takeToken')).toMatch(/challengeFailed = false;/);
		expect(modal).toMatch(/\{#if challengeFailed\}\s*<p class="lg-error" role="alert">\{t\.account\.turnstileFailed\}<\/p>/);
	});

	it('is worded in both languages', () => {
		expect(en.account.turnstileFailed).toBe(
			'The Turnstile challenge could not load. Check your connection, then close and reopen this dialog.',
		);
		expect(fr.account.turnstileFailed).toBe(
			'Le défi Turnstile n’a pas pu se charger. Vérifiez votre connexion, puis fermez et rouvrez cette fenêtre.',
		);
	});
});
