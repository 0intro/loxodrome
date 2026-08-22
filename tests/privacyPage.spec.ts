/* Drift net over the hosted privacy policy.
 *
 * The About modal's Privacy section is the application's statement about its
 * own data handling, and Google Play needs that statement at a URL as well,
 * so public/privacy.html carries the same strings, generated from the same
 * catalogs by scripts/gen-privacy.js. Three things can go wrong and each has
 * its own case.
 *
 * The page can fall behind the catalogs it was generated from, which is a
 * byte comparison. A NEW privacy string can land in the catalogs and never
 * reach the page, which is a key comparison and matters more: a policy
 * missing a paragraph is worse than one visibly out of date, because nothing
 * looks wrong. And the reading order, which lives only in the modal's markup
 * and is copied into the generator, can drift from the original, which is a
 * scrape of the modal, built the way tests/aboutCoverage.spec.ts is built:
 * read the tree, not a second copy of the expectations. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { escapeText, pageKeys, readCatalog, renderPage } from '../scripts/gen-privacy.js';

const root = new URL('..', import.meta.url).pathname;
const en = readCatalog(join(root, 'src/lib/i18n/en/about.ts'));
const fr = readCatalog(join(root, 'src/lib/i18n/fr/about.ts'));
const page = readFileSync(join(root, 'public/privacy.html'), 'utf-8');
const modal = readFileSync(join(root, 'src/lib/components/AboutModal.svelte'), 'utf-8');

describe('hosted privacy policy', () => {
	it('matches what the generator would write today', () => {
		expect(
			renderPage(en, fr),
			'public/privacy.html and the i18n catalogs disagree; run `npm run gen:privacy`',
		).toBe(page);
	});

	it('reaches every privacy string in both catalogs', () => {
		// A key added to the catalogs and forgotten in the generator's ordered
		// spec would vanish from the hosted policy in silence. It fails here
		// instead.
		const spec = new Set(pageKeys(en));
		const missing = [...new Set([...Object.keys(en), ...Object.keys(fr)])]
			.filter((k) => k.startsWith('privacy') && !spec.has(k))
			.sort();
		expect(
			missing,
			`these catalog strings never reach the hosted policy; add them to SECTIONS in scripts/gen-privacy.js:\n  ${missing.join('\n  ')}`,
		).toEqual([]);
	});

	it('carries the text itself, in both languages', () => {
		const absent: string[] = [];
		for (const key of pageKeys(en)) {
			if (!page.includes(escapeText(en[key]))) {
				absent.push(`en ${key}`);
			}
			if (!page.includes(escapeText(fr[key]))) {
				absent.push(`fr ${key}`);
			}
		}
		expect(absent, `run \`npm run gen:privacy\`:\n  ${absent.join('\n  ')}`).toEqual([]);
	});

	it('lists the same things, in the same order, as the About modal', () => {
		// The order exists only in the modal's markup, so this is the one
		// place the generator's copy of it can be checked against the
		// original. It matters: privacyIntro says "the first two on their own
		// while you use the map", which is a claim about this list.
		const section = modal.slice(
			modal.indexOf('t.about.privacyHeading'),
			modal.indexOf('t.about.dataSetsHeading'),
		);
		const inModal = [...section.matchAll(/t\.about\.(privacy\w+)/g)].map((m) => m[1]);
		expect(inModal.length, 'the modal scrape found nothing; check the markers').toBeGreaterThan(10);
		expect(
			pageKeys(en).filter((k) => k.startsWith('privacy')),
			'the hosted policy and the About modal disagree about the privacy section; the copy is SECTIONS in scripts/gen-privacy.js',
		).toEqual(inModal);
	});

	it('renders nothing the modal has dropped', () => {
		const gone = pageKeys(en).filter((k) => !modal.includes(`t.about.${k}`));
		expect(gone, `the page still shows strings the About modal no longer does: ${gone.join(', ')}`).toEqual(
			[],
		);
	});

	it('is readable with JavaScript off', () => {
		// Both languages are in the markup and neither is hidden BY the
		// markup: the hiding is a rule that needs the attribute the head
		// script sets. A store reviewer, a crawler and a plain fetch read the
		// whole policy.
		expect(page).toContain('<article id="en" class="en" lang="en">');
		expect(page).toContain('<article id="fr" class="fr" lang="fr">');
		expect(page).not.toMatch(/<article[^>]*\b(?:hidden|style=)/);
		expect(page).toMatch(/html\[data-lang="en"\] \.fr,/);
	});

	it('fetches nothing', () => {
		// One request per reader, and it is the page. A policy that says "no
		// tracking" and then pulls a font from a CDN is not one.
		expect(page).not.toMatch(/<link\b|<script[^>]+\bsrc=|<img\b|@import|url\(/);
	});

	it('states one date, in a form no clock can move', () => {
		const stamps = [...page.matchAll(/<time datetime="([^"]+)">([^<]+)<\/time>/g)];
		expect(stamps).toHaveLength(2);
		expect(new Set(stamps.map((m) => m[1])).size).toBe(1);
		expect(stamps[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(renderPage(en, fr)).toBe(renderPage(en, fr));
	});
});
