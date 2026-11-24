/* play-listing.js: the Google Play store listing that android/play/listings
 * holds, one directory per language with title.txt, short-description.txt
 * and full-description.txt, each paragraph on one line as the store keeps
 * it. Through the Play Developer API (play-api.js), as the
 * loxodrome-publisher service account.
 *
 *	node scripts/play-listing.js get     the store's texts into the tree
 *	node scripts/play-listing.js diff    the tree against the store
 *	node scripts/play-listing.js links   every link of the full descriptions, fetched
 *	node scripts/play-listing.js put [--not-sent-for-review]
 *
 * --key   the service-account JSON (default local/android/play-publisher.json,
 *         gitignored)
 * --dir   the listing (default android/play/listings)
 *
 * put checks the tree first (checkListing): Play's limits, the disclaimer
 * and the official sources that the Misleading Claims policy asks of an app
 * showing government information, the same links in every language, and
 * the French spaced as the catalogs are. It then sets every language's three
 * texts in one edit and commits it, which sends the change for review. After
 * a rejection, --not-sent-for-review commits it for Publishing overview in
 * Play Console to send.
 *
 * links asks for every URL the full descriptions give as a browser would,
 * since the policy wants each source's link to work, and prints each
 * answer's status, or "challenge" for a site behind Cloudflare's browser
 * check, which a person passes. It fails when a link fails. */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessToken, call, withEdit } from './play-api.js';

const PACKAGE = 'fr.loxodrome.app';

/** Each text's file, its field in the API, and Play's limit in characters. */
const FIELDS = [
	{ file: 'title.txt', field: 'title', max: 30 },
	{ file: 'short-description.txt', field: 'shortDescription', max: 80 },
	{ file: 'full-description.txt', field: 'fullDescription', max: 4000 },
];

/** The listing's languages, with the paragraph headings each full
 *  description carries: the disclaimer, then the sources. */
const LANGUAGES = {
	'en-US': ['NOT A GOVERNMENT APPLICATION', 'OFFICIAL SOURCES'],
	'fr-FR': ['APPLICATION NON GOUVERNEMENTALE', 'SOURCES OFFICIELLES'],
};

const URL_RE = /https?:\/\/[^\s,)]+/g;

/** The URLs text gives, a sentence's final period left out. */
export function links(text) {
	return [...text.matchAll(URL_RE)].map((m) => m[0].replace(/\.$/, ''));
}

/** The listing in dir, by language and field, the final newline of each
 *  file left out. A missing file leaves its field undefined. */
function readListing(dir) {
	const listing = {};
	for (const lang of Object.keys(LANGUAGES)) {
		listing[lang] = {};
		for (const { file, field } of FIELDS) {
			try {
				listing[lang][field] = readFileSync(join(dir, lang, file), 'utf-8').replace(/\n$/, '');
			} catch (e) {
				if (e.code !== 'ENOENT') {
					throw e;
				}
			}
		}
	}
	return listing;
}

/** Why the listing in dir cannot go to Play, a line each, or none. */
export function checkListing(dir) {
	const problems = [];
	const listing = readListing(dir);
	const sources = {};
	for (const [lang, headings] of Object.entries(LANGUAGES)) {
		for (const { file, field, max } of FIELDS) {
			const path = `${lang}/${file}`;
			const text = listing[lang][field];
			if (text === undefined) {
				problems.push(`${path} is missing`);
				continue;
			}
			const n = [...text].length;
			if (n === 0) {
				problems.push(`${path} is empty`);
			}
			if (n > max) {
				problems.push(`${path} is ${n} characters, Play takes ${max}`);
			}
			if (lang.startsWith('fr') && /(^|[^\u202f])[:;!?]/.test(text.replace(URL_RE, ''))) {
				problems.push(`${path} wants U+202F before each : ; ! and ?`);
			}
		}
		const lines = (listing[lang].fullDescription ?? '').split('\n');
		for (const h of headings) {
			if (!lines.includes(h)) {
				problems.push(`${lang}/full-description.txt lacks its ${h} paragraph`);
			}
		}
		sources[lang] = new Set(links(listing[lang].fullDescription ?? ''));
	}
	const [first, ...others] = Object.keys(LANGUAGES);
	for (const lang of others) {
		for (const [a, b] of [
			[first, lang],
			[lang, first],
		]) {
			for (const url of sources[a]) {
				if (!sources[b].has(url)) {
					problems.push(`${url} is in ${a}/full-description.txt alone`);
				}
			}
		}
	}
	return problems;
}

function parseArgs(argv) {
	const out = { cmd: argv[0], key: 'local/android/play-publisher.json', dir: 'android/play/listings', notSentForReview: false };
	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			const v = argv[++i];
			if (v === undefined) {
				throw new Error(`${a} needs a value`);
			}
			return v;
		};
		switch (a) {
			case '--key':
				out.key = next();
				break;
			case '--dir':
				out.dir = next();
				break;
			case '--not-sent-for-review':
				out.notSentForReview = true;
				break;
			default:
				throw new Error(`unknown argument ${a}`);
		}
	}
	return out;
}

/** The store's listings, by language, read in an edit that is then dropped. */
async function storeListings(args) {
	const token = await accessToken(JSON.parse(readFileSync(args.key, 'utf-8')));
	return withEdit(token, PACKAGE, async (edit) => {
		const { listings = [] } = await call(token, 'GET', `${edit.url}/listings`);
		return Object.fromEntries(listings.map((l) => [l.language, l]));
	});
}

async function get(args) {
	const store = await storeListings(args);
	for (const lang of Object.keys(LANGUAGES)) {
		const l = store[lang];
		if (!l) {
			throw new Error(`the store holds no ${lang} listing`);
		}
		mkdirSync(join(args.dir, lang), { recursive: true });
		for (const { file, field } of FIELDS) {
			writeFileSync(join(args.dir, lang, file), `${l[field] ?? ''}\n`);
		}
		console.log(`${lang}: ${FIELDS.map(({ field }) => `${field} ${[...(l[field] ?? '')].length}`).join(', ')}`);
	}
	for (const lang of Object.keys(store)) {
		if (!(lang in LANGUAGES)) {
			console.log(`the store also holds ${lang}, which LANGUAGES would need to name`);
		}
	}
}

async function diff(args) {
	const store = await storeListings(args);
	const tree = readListing(args.dir);
	let same = true;
	for (const lang of Object.keys(LANGUAGES)) {
		for (const { file, field } of FIELDS) {
			const a = store[lang]?.[field] ?? '';
			const b = tree[lang][field] ?? '';
			if (a === b) {
				continue;
			}
			same = false;
			console.log(`${lang}/${file}: the store holds ${[...a].length} characters, the tree ${[...b].length}`);
			const al = a.split('\n');
			const bl = b.split('\n');
			for (const line of al.filter((l) => !bl.includes(l))) {
				console.log(`- ${line}`);
			}
			for (const line of bl.filter((l) => !al.includes(l))) {
				console.log(`+ ${line}`);
			}
		}
	}
	if (same) {
		console.log('the tree matches the store');
	}
}

async function checkLinks(args) {
	const tree = readListing(args.dir);
	const urls = [...new Set(Object.values(tree).flatMap((l) => links(l.fullDescription ?? '')))].sort();
	let failed = 0;
	for (const url of urls) {
		let status;
		try {
			const res = await fetch(url, {
				redirect: 'follow',
				signal: AbortSignal.timeout(30_000),
				headers: {
					'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'accept-language': 'en',
				},
			});
			await res.body?.cancel();
			// Cloudflare's browser check stops a script and lets a person
			// through, so the source answers.
			if (res.headers.get('cf-mitigated') === 'challenge') {
				status = 'challenge';
			} else if (res.ok) {
				status = String(res.status);
			} else {
				status = `HTTP ${res.status}`;
				failed++;
			}
		} catch (e) {
			status = e.cause?.code ?? e.name;
			failed++;
		}
		console.log(`${status} ${url}`);
	}
	if (failed > 0) {
		throw new Error(`${failed} of ${urls.length} links failed`);
	}
}

async function put(args) {
	const problems = checkListing(args.dir);
	if (problems.length > 0) {
		throw new Error(`the listing in ${args.dir} cannot go to Play:\n${problems.join('\n')}`);
	}
	const tree = readListing(args.dir);
	const key = JSON.parse(readFileSync(args.key, 'utf-8'));
	const token = await accessToken(key);
	await withEdit(token, PACKAGE, async (edit) => {
		console.log(`edit ${edit.id} opened as ${key.client_email}`);
		for (const lang of Object.keys(LANGUAGES)) {
			const body = Object.fromEntries(FIELDS.map(({ field }) => [field, tree[lang][field]]));
			await call(token, 'PATCH', `${edit.url}/listings/${lang}`, body);
			console.log(`${lang}: set`);
		}
		const done = await edit.commit({ notSentForReview: args.notSentForReview });
		console.log(
			args.notSentForReview
				? `committed edit ${done.id}: Publishing overview in Play Console sends it for review`
				: `committed edit ${done.id}, sent for review`,
		);
	});
}

const COMMANDS = { get, diff, links: checkLinks, put };

/* Only when run as a command: tests/playListing.spec.ts imports
 * checkListing, and an import must never reach the API. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	(async () => {
		const args = parseArgs(process.argv.slice(2));
		const run = COMMANDS[args.cmd];
		if (!run) {
			console.error('usage: play-listing.js get | diff | links | put [--not-sent-for-review] [--key file] [--dir dir]');
			process.exit(2);
		}
		await run(args);
	})().catch((e) => {
		console.error(`play-listing: ${e.message}`);
		process.exit(1);
	});
}
