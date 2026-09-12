/* gen-privacy.js: writes public/privacy.html, the hosted privacy policy the
 * Google Play listing points at.
 *
 * The policy text already exists, in both languages, already reviewed: it is
 * the About modal's Privacy section, in src/lib/i18n/{en,fr}/about.ts. Play
 * needs it at a URL as well, and retyping it into a second document is how
 * one statement becomes two that disagree, the published one being the copy
 * nobody opens. So the page is generated from the same strings the
 * application renders, and tests/privacyPage.spec.ts fails when the two
 * drift apart.
 *
 * Node cannot import those catalogs: they use extensionless relative
 * specifiers ('./plural', '../en') that the ESM resolver rejects. The strings
 * are read with the TypeScript compiler API instead, the technique
 * scripts/i18n-lint.js already uses, which also hands back the COOKED value:
 * the French catalog writes most of its narrow no-break spaces as
 * escapes and this reads the character.
 *
 * The page is self-contained: one <style>, one small <script>, no font, no
 * stylesheet, no icon, nothing third-party. A document that says "no
 * tracking" and then fetches a CDN font is not one, and a page that fetches
 * nothing is also readable offline out of the service worker's precache.
 *
 * Output is deterministic: no clock, no locale data, so running it twice
 * produces no diff. Run `npm run gen:privacy` after touching the privacy,
 * disclaimer or author strings in either catalog. It reads src/ only, so
 * unlike gen-licenses.js it needs no build first.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EN = join(ROOT, 'src/lib/i18n/en/about.ts');
const FR = join(ROOT, 'src/lib/i18n/fr/about.ts');
const OUT = join(ROOT, 'public/privacy.html');

/* The date the page states, and the fingerprint of the text it was stated
 * for.
 *
 * A build timestamp would be honest about the build and dishonest about the
 * policy, and it would rewrite this file on every run. A date read from git
 * is no better: main is one parentless commit, re-squashed on every publish,
 * so git's date is the publish date. So the date is set by hand, and because
 * a hand-set date rots in silence, main() refuses to write once the text no
 * longer hashes to DIGEST and prints the digest to paste. Move both in the
 * same commit as the wording. */
const UPDATED = '2026-09-06';
const DIGEST = 'f8eafee32b9dd3e7';

/** The string-valued keys of `export const about = {…}`, cooked.
 *
 *  Only the top-level object is walked, so a fragment inside one of the
 *  interpolating (function-valued) entries can never be mistaken for a key.
 *  Those entries are skipped: the page renders none of them, and a value
 *  this cannot read is a value it must not guess at.
 *
 *  @param {string} file
 *  @returns {Record<string, string>} */
export function readCatalog(file) {
	const sf = ts.createSourceFile(
		file,
		readFileSync(file, 'utf-8'),
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	/** @type {Record<string, string>} */
	const out = {};
	/** @param {ts.Node} node */
	const visit = (node) => {
		if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === 'about' &&
			node.initializer
		) {
			// The French catalog closes on `satisfies Messages['about']`, the
			// English one on a bare object literal.
			let init = node.initializer;
			while (
				ts.isSatisfiesExpression(init) ||
				ts.isAsExpression(init) ||
				ts.isParenthesizedExpression(init)
			) {
				init = init.expression;
			}
			if (ts.isObjectLiteralExpression(init)) {
				for (const prop of init.properties) {
					if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
						continue;
					}
					const v = prop.initializer;
					if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) {
						out[prop.name.text] = v.text;
					}
				}
			}
			return;
		}
		ts.forEachChild(node, visit);
	};
	visit(sf);
	return out;
}

/* Text-node escaping. Three characters can close a text node and the
 * catalogs carry one: "TEMSI & WINTEM" in privacySofia, both languages.
 *
 * The two no-break spaces go out as entities because they are INVISIBLE in a
 * committed file: French typography puts a narrow no-break space before a
 * colon, a semicolon and a question mark, and an editor that normalises
 * whitespace, or a careless paste, would strip punctuation no reviewer can
 * see in a diff.
 *
 * @param {string} s */
export const escapeText = (s) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\u00a0/g, '&#160;')
		.replace(/\u202f/g, '&#8239;');

/** Attributes carry generator-authored text only; no catalog string is ever
 *  interpolated into one. This keeps that true by construction.
 *  @param {string} s */
const attr = (s) => escapeText(s).replace(/"/g, '&quot;');

/* The page's own furniture. These are NOT catalog keys: the application
 * never renders this page, so a key would be dead weight in the shipped
 * bundle and one more line for every i18n net to check. `appliesTo` is the
 * one sentence that lives only here, and it describes the DOCUMENT rather
 * than the data practices, which is what a policy is asked to state and what
 * the About modal has no reason to say. */
const CHROME = {
	en: {
		title: 'Privacy policy',
		nav: 'English',
		updated: 'Last updated',
		appliesTo:
			'This policy covers the Loxodrome web application at loxodrome.fr and the Loxodrome application for Android. It reproduces, word for word and from the same source, the Privacy section of the application’s own About screen.',
	},
	fr: {
		title: 'Politique de confidentialité',
		nav: 'Français',
		updated: 'Dernière mise à jour',
		appliesTo:
			'Cette politique couvre l’application web Loxodrome sur loxodrome.fr et l’application Loxodrome pour Android. Elle reprend mot pour mot, depuis la même source, la section Confidentialité de la fenêtre À propos de l’application.',
	},
};

const DOC_TITLE = 'Loxodrome privacy policy / Politique de confidentialité';
const DOC_DESCRIPTION =
	'How Loxodrome handles data: no tracking, no advertising, an entirely optional account; what stays on the device and what leaves it.';

const REPO = 'https://github.com/0intro/loxodrome';

/* The two nodes AboutModal.svelte hardcodes beside a string, reproduced here
 * because privacyAutorouter and privacyWindsAloft are sentence FRAGMENTS:
 * without the service they name, the first loses its object and the second
 * ends on "to". */
const AUTOROUTER =
	'<a href="https://www.autorouter.aero/" target="_blank" rel="noopener noreferrer"><code>autorouter.aero</code></a>';
const OPEN_METEO = '<code>api.open-meteo.com</code>';

/** @param {string} html */
const P = (html) => `<p>${html}</p>`;
/** @param {string[]} items */
const UL = (items) => `<ul>\n${items.map((i) => `\t<li>${i}</li>`).join('\n')}\n</ul>`;

/* The page, in the order a reader meets it, written ONCE for both languages,
 * so English and French cannot come out in different orders.
 *
 * That order lives nowhere a generator can read it: the catalogs are roughly
 * alphabetical and AboutModal.svelte holds the real sequence in its markup.
 * This is a copy of it, and tests/privacyPage.spec.ts compares the privacy
 * run back to the modal so the copy cannot drift. It is load-bearing rather
 * than cosmetic: privacyIntro says "the first two on their own while you use
 * the map, the others only when you ask for them", which is a claim about
 * THIS list.
 *
 * One deliberate departure from the modal: privacy comes before the
 * pilot-in-command disclaimer here. The modal is an About screen and leads
 * with what the application is not; this page is titled Privacy policy, and
 * a reader who came for that has to meet it first.
 *
 * `s(key)` is the accessor for the language being rendered: it escapes, it
 * records the key, and it throws on a key the catalog does not have.
 * Everything else in these templates is markup authored here. */
const SECTIONS = [
	{
		heading: 'privacyHeading',
		class: null,
		blocks: [
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyIntro')),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyPosition')),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyStored')),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyAccount')),
			/** @param {(k: string) => string} s */
			(s) =>
				UL([
					s('privacyTiles'),
					s('privacyTerrain'),
					`${s('privacyAutorouter')} ${AUTOROUTER}`,
					s('privacySofiaNotam'),
					s('privacyWeather'),
					`${s('privacyWindsAloft')} ${OPEN_METEO}`,
					s('privacySofia'),
				]),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyProxy')),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyHosting')),
			/** @param {(k: string) => string} s */
			(s) => P(s('privacyToggleOff')),
		],
	},
	{
		heading: 'disclaimerHeading',
		class: 'disclaimer',
		blocks: [
			// One paragraph, three keys: disclaimer1 ends on "It " and
			// disclaimer2 opens on " of the States", both written to butt
			// against the <strong> between them, so nothing is joined here.
			/** @param {(k: string) => string} s */
			(s) =>
				P(`${s('disclaimer1')}<strong>${s('disclaimerStrong')}</strong>${s('disclaimer2')}`),
		],
	},
	{
		heading: 'authorHeading',
		class: null,
		blocks: [
			// The modal opens the MIT text in place; a static page has nowhere
			// to open it, so the licence name links to the file in the
			// repository. The full stop belongs to the sentence, not the link.
			/** @param {(k: string) => string} s */
			(s) =>
				P(
					`${s('copyright')} <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">${s('licenseMit')}</a>.`,
				),
			/** @param {(k: string) => string} s */
			(s) =>
				P(
					`${s('sourceLabel')} <a href="${REPO}" target="_blank" rel="noopener noreferrer">github.com/0intro/loxodrome</a>` +
						` · <a href="${REPO}/issues" target="_blank" rel="noopener noreferrer">${s('reportIssue')}</a>`,
				),
		],
	},
];

/** One catalog string, escaped. A key the catalog does not have is fatal: a
 *  renamed key must stop the generator, not print "undefined" into a
 *  published policy.
 *  @param {Record<string, string>} cat
 *  @param {string} key
 *  @param {string} lang */
function text(cat, key, lang) {
	const value = cat[key];
	if (typeof value !== 'string') {
		throw new Error(`gen-privacy: the ${lang} catalog has no string key '${key}'`);
	}
	return escapeText(value);
}

/** @param {string} block @param {string} pad */
const indent = (block, pad) =>
	block
		.split('\n')
		.map((l) => pad + l)
		.join('\n');

/** One language's article, plus the keys it read, in reading order.
 *  @param {'en' | 'fr'} lang
 *  @param {Record<string, string>} cat */
function renderArticle(lang, cat) {
	/** @type {string[]} */
	const keys = [];
	/** @param {string} key */
	const s = (key) => {
		keys.push(key);
		return text(cat, key, lang);
	};
	const c = CHROME[lang];
	const out = [`<article id="${lang}" class="${lang}" lang="${lang}">`];
	// The ISO date reads the same in both languages and needs no locale data,
	// which a generator that must produce identical bytes everywhere has no
	// business depending on.
	out.push(
		`\t<p class="updated">${escapeText(c.updated)}: <time datetime="${UPDATED}">${UPDATED}</time></p>`,
	);
	out.push(`\t<p class="lede">${s('tagline')}</p>`);
	out.push(`\t<p>${escapeText(c.appliesTo)}</p>`);
	for (const section of SECTIONS) {
		out.push(section.class ? `\t<section class="${section.class}">` : '\t<section>');
		out.push(`\t\t<h2>${s(section.heading)}</h2>`);
		for (const block of section.blocks) {
			out.push(indent(block(s), '\t\t'));
		}
		out.push('\t</section>');
	}
	out.push('</article>');
	return { html: out.join('\n'), keys };
}

/** Every catalog key the page renders, in the order it renders them.
 *  @param {Record<string, string>} cat */
export function pageKeys(cat) {
	return renderArticle('en', cat).keys;
}

const STYLE = `/* The page paints itself: no stylesheet request, no font request, no
   icon, nothing third-party. The colours are the application's own, copied
   rather than imported because public/ is passed through to dist/
   untouched. */
:root {
	color-scheme: light dark;
	--bg: #eef0f3;
	--surface: #fff;
	--border: #d3d7dd;
	--text: #1a1d21;
	--muted: #5d6670;
	--accent: #1f5fbf;
}

@media (prefers-color-scheme: dark) {
	:root {
		--bg: #0f1216;
		--surface: #181c22;
		--border: #313844;
		--text: #e7e9ec;
		--muted: #9aa3af;
		--accent: #4d8bff;
	}
}

* {
	box-sizing: border-box;
}

body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font-family: system-ui, -apple-system, "Segoe UI", roboto, helvetica, arial, sans-serif;
	font-size: 16px;
	line-height: 1.6;
	text-size-adjust: 100%;
}

/* 42rem is about 75 characters, the measure prose reads at; the padding is
   what keeps it off the edge of a 360px phone. */
main {
	max-width: 42rem;
	margin: 0 auto;
	padding: 2rem 1.25rem 4rem;
}

header {
	margin-bottom: 2rem;
	padding-bottom: 1rem;
	border-bottom: 1px solid var(--border);
}

.brand {
	margin: 0;
	font-weight: 700;
	letter-spacing: 0.02em;
	color: var(--accent);
}

h1 {
	margin: 0.25rem 0 0.75rem;
	font-size: 1.5rem;
	line-height: 1.25;
}

/* Stacked, so the two titles do not run together in the state where both
   languages show. */
h1 span {
	display: block;
}

h2 {
	margin: 2.5rem 0 0.5rem;
	font-size: 1.15rem;
}

p {
	margin: 0.75rem 0;
}

ul {
	margin: 0.75rem 0;
	padding-inline-start: 1.25rem;
}

li {
	margin: 0.5rem 0;
}

a {
	color: var(--accent);
}

code {
	font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
	font-size: 0.9em;
	/* A hostname or storage key in a code span must not overflow a 360px phone. */
	overflow-wrap: anywhere;
	padding: 0 0.25em;
	border: 1px solid var(--border);
	border-radius: 4px;
	background: var(--surface);
}

.updated {
	color: var(--muted);
	font-size: 0.9rem;
}

.lede {
	font-size: 1.05rem;
}

.disclaimer {
	border-inline-start: 3px solid var(--border);
	padding-inline-start: 1rem;
}

.langs {
	display: flex;
	gap: 1rem;
}

.langs a {
	color: var(--muted);
	text-decoration: none;
}

/* The switch. Both languages are IN the page; this hides one, and only once
   the head script has said which, so JavaScript off leaves both readable. It
   keys on a CLASS rather than on lang=, so the switcher's own labels stay
   free to carry a lang attribute: keyed on lang=, the "Francais" link would
   hide itself in English and leave no way back. */
html[data-lang="en"] .fr,
html[data-lang="fr"] .en {
	display: none;
}

html[data-lang="en"] .langs a[href="#en"],
html[data-lang="fr"] .langs a[href="#fr"] {
	color: var(--text);
	font-weight: 600;
}

/* Only the state where both languages show needs a seam between them. */
html:not([data-lang]) article + article {
	margin-top: 3rem;
	padding-top: 2rem;
	border-top: 1px solid var(--border);
}

@media print {
	.langs {
		display: none;
	}

	body {
		background: #fff;
		color: #000;
	}

	a {
		color: inherit;
	}
}`;

const SCRIPT = `/* Pick the language before first paint, the way index.html does: an
	   explicit #en / #fr in the URL, then the preference the application
	   stored, then the browser's own list. The attribute goes on <html>, so
	   the stylesheet does the hiding: no flash, and nothing here waits for
	   the document to be parsed.

	   With JavaScript off nothing runs, no data-lang is set, no rule matches,
	   and BOTH languages stay on the page. That is the point of doing it this
	   way round rather than hiding one in the markup: a store reviewer, a
	   crawler and a plain fetch all read the whole policy.

	   This page reads a preference and writes nothing. A document about what
	   the application does not store has no business storing anything. */
	(function () {
		var m = /^#(en|fr)$/.exec(location.hash);
		var lang = m && m[1];
		if (!lang) {
			try {
				lang = localStorage.getItem('loxodrome:locale');
			} catch (e) {
				/* localStorage unavailable */
			}
		}
		if (lang !== 'en' && lang !== 'fr') {
			var prefs = navigator.languages || [navigator.language || 'en'];
			lang = 'en';
			for (var i = 0; i < prefs.length; i++) {
				if (/^fr\\b/i.test(prefs[i])) {
					lang = 'fr';
					break;
				}
				if (/^en\\b/i.test(prefs[i])) {
					break;
				}
			}
		}
		var set = function (l) {
			document.documentElement.lang = l;
			document.documentElement.setAttribute('data-lang', l);
		};
		set(lang);
		/* The switcher is two ordinary anchors. With JavaScript they change
		   the language and the browser scrolls to the article it just
		   revealed; without it they scroll to the article, which is already
		   there. The URL carries the choice either way, so
		   loxodrome.fr/privacy.html#fr is a link worth giving the French
		   store listing. */
		addEventListener('hashchange', function () {
			var h = /^#(en|fr)$/.exec(location.hash);
			if (h) {
				set(h[1]);
			}
		});
	})();`;

/** The whole page, both languages.
 *  @param {Record<string, string>} en
 *  @param {Record<string, string>} fr */
export function renderPage(en, fr) {
	const a = renderArticle('en', en).html;
	const b = renderArticle('fr', fr).html;
	return `<!DOCTYPE html>
<!-- privacy.html: GENERATED by scripts/gen-privacy.js; do not edit.
     The text is src/lib/i18n/{en,fr}/about.ts, the same strings the
     application's About screen renders. Regenerate with
     \`npm run gen:privacy\`; tests/privacyPage.spec.ts fails when this file
     and the catalogs disagree. -->
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="description" content="${attr(DOC_DESCRIPTION)}" />
<title>${escapeText(DOC_TITLE)}</title>
<style>
${STYLE}
</style>
<script>
${SCRIPT}
</script>
</head>
<body>
<main>
	<header>
		<p class="brand">Loxodrome</p>
		<h1><span class="en" lang="en">${escapeText(CHROME.en.title)}</span><span class="fr" lang="fr">${escapeText(CHROME.fr.title)}</span></h1>
		<nav class="langs" aria-label="Language / Langue">
			<a href="#en" hreflang="en" lang="en">${escapeText(CHROME.en.nav)}</a>
			<a href="#fr" hreflang="fr" lang="fr">${escapeText(CHROME.fr.nav)}</a>
		</nav>
	</header>
${indent(a, '\t')}
${indent(b, '\t')}
</main>
</body>
</html>
`;
}

/** Fingerprint of every string the page shows, both languages, in the order
 *  it shows them, plus the chrome. The date is only true while this holds.
 *  @param {Record<string, string>} en
 *  @param {Record<string, string>} fr */
function textDigest(en, fr) {
	const h = createHash('sha256');
	for (const key of pageKeys(en)) {
		h.update(key).update('\0').update(en[key] ?? '').update('\0').update(fr[key] ?? '').update('\0');
	}
	h.update(JSON.stringify(CHROME));
	return h.digest('hex').slice(0, 16);
}

function main() {
	const en = readCatalog(EN);
	const fr = readCatalog(FR);
	const digest = textDigest(en, fr);
	if (digest !== DIGEST) {
		/* Writing now would publish a policy dated for wording it no longer
		 * carries, which is the one lie this file is placed to tell. So it
		 * stops and says what to change. */
		process.stdout.write(
			`gen-privacy: the policy text changed; the page still says ${UPDATED}.\n` +
				`gen-privacy: in scripts/gen-privacy.js set UPDATED to today and DIGEST to '${digest}', then run again.\n`,
		);
		process.exitCode = 1;
		return;
	}
	const page = renderPage(en, fr);
	writeFileSync(OUT, page);
	process.stdout.write(
		`gen-privacy: ${pageKeys(en).length} strings x2 languages -> public/privacy.html (${Buffer.byteLength(page)} bytes, updated ${UPDATED})\n`,
	);
}

/* Only when run as a command. tests/privacyPage.spec.ts imports renderPage()
 * to compare the committed page against the catalogs, and a test that
 * rewrote the file it is checking would pass by fixing its own subject. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
