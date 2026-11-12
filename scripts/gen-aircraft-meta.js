/* gen-aircraft-meta.js: writes public/data/aircraft.meta.json, the aircraft
 * library's index, from the data sheets under public/data/aircraft/.
 *
 * The file is the library's file index and the About panel's sidecar: the
 * app fetches the sheets `files` names (the clubs' aircraft) and those
 * `generic.files` names (the generic sheets, listed apart so an older app,
 * which reads `files` alone, never meets one), and About prints the counts by
 * type, in the file's own order, and `generatedAt`. Kept by hand, it drifted:
 * seven commits of generic sheets left `generatedAt` where it was, so About
 * dated the library two days before its last change, and the counts kept the
 * order they happened to be typed in.
 *
 * So it is generated. Every list is sorted by code point, which no locale
 * decides. `generatedAt` moves when, and only when, the library's data does:
 * `digest` hashes every sheet's VALUES (its path, then the document read the
 * way the app reads it, keys sorted), so a comment fixed in a sheet moves
 * nothing, a figure corrected moves the date, and a run over an unchanged
 * library writes nothing new. The two `source` texts are prose about where
 * the figures come from: kept as written, to edit by hand when a club or a
 * manual joins.
 *
 * A sheet's PLACE is checked here, before anything is written: a club sheet
 * is named by its registration in lower case (`f-gorq.yaml`) and carries no
 * generic flag; a generic sheet sits under `generic/`, its file named by its
 * id (`generic/c172s.yaml` holds `generic: c172s`) and no registration; the
 * directory holds sheets only. Each key (a registration, `generic:<id>`) is
 * then unique by construction. A sheet's FIGURES are the schema's to judge,
 * and Node cannot import it (the app's modules use its `$lib` alias):
 * tests/aircraftData.spec.ts parses every sheet.
 *
 *   npm run gen:aircraft-meta                  regenerate the index
 *   npm run gen:aircraft-meta -- --check       say whether it is current
 *   npm run gen:aircraft-meta -- --add <file>  promote a plane exported from
 *                                              the app into the library
 *
 * `--add` files a pilot's own plane (the Aircraft tab's Export) under its
 * registration and regenerates the index. A plane the library holds already
 * is refused: that sheet's comments are its provenance, which an export
 * carries none of, so it is edited where it is.
 *
 * tests/aircraftMeta.spec.ts fails when the committed index is not the one
 * this writes. */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public/data/aircraft');
const OUT = join(ROOT, 'public/data/aircraft.meta.json');
const GENERIC = 'generic';
const NAME = 'gen-aircraft-meta';

/** Code-point order: the same on every machine, whatever its locale. */
function cmp(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The sheets under the library's directory, by their path in the index
 *  (`f-gorq.yaml`, `generic/c172s.yaml`), sorted. The index lists the
 *  directory whole, so anything there but a `.yaml` file, at the top or in
 *  `generic/`, is refused, and so is any other directory. */
export function readSheets(dir = DIR) {
	const out = [];
	const list = (sub) => {
		const at = sub === '' ? dir : join(dir, sub);
		if (!existsSync(at)) {
			return;
		}
		for (const entry of readdirSync(at, { withFileTypes: true })) {
			const path = sub === '' ? entry.name : `${sub}/${entry.name}`;
			if (entry.isDirectory()) {
				if (sub === '' && entry.name === GENERIC) {
					list(GENERIC);
					continue;
				}
				throw new Error(`${path}: a directory the library does not hold (its sheets sit at the top and in ${GENERIC}/)`);
			}
			if (!entry.isFile() || !entry.name.endsWith('.yaml')) {
				throw new Error(`${path}: not a .yaml data sheet`);
			}
			out.push({ path, text: readFileSync(join(at, entry.name), 'utf8') });
		}
	};
	list('');
	return out.sort((x, y) => cmp(x.path, y.path));
}

/** A sheet's document, read as the app reads it (the `yaml` package), or a
 *  refusal naming the sheet. */
function readDoc(sheet) {
	let doc;
	try {
		doc = parse(sheet.text);
	} catch (e) {
		throw new Error(`${sheet.path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
	const a = doc?.aircraft;
	if ((doc?.version !== 1 && doc?.version !== 2) || a === null || typeof a !== 'object' || typeof a.type !== 'string' || a.type === '') {
		throw new Error(`${sheet.path}: not an aircraft data sheet (version: 1 or 2, an aircraft with its type)`);
	}
	return doc;
}

/** A club sheet's file name: its registration, lower case. Null without one. */
function clubName(aircraft) {
	const reg = aircraft.registration;
	return typeof reg === 'string' && reg.trim() !== '' ? `${reg.trim().toLowerCase()}.yaml` : null;
}

/** A document's values with every mapping's keys sorted: what the digest
 *  hashes, so comments, layout and key order count for nothing. */
function canonical(value) {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort(cmp)
				.map((k) => [k, canonical(value[k])]),
		);
	}
	return value;
}

/** Sheets by type, the types in code-point order. */
function countByType(types) {
	const counts = new Map();
	for (const t of [...types].sort(cmp)) {
		counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	return Object.fromEntries(counts);
}

/** An instant as the index states it, to the second. */
function stamp(now) {
	return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The index the sheets make. `previous` is the index as committed, or null:
 *  its two `source` texts are kept, and its `generatedAt` while the data has
 *  not changed; `now` stamps a change. Throws, naming the sheet, on a sheet
 *  out of its place. */
export function buildMeta(sheets, previous, now) {
	const club = [];
	const generic = [];
	const hash = createHash('sha256');
	for (const sheet of [...sheets].sort((x, y) => cmp(x.path, y.path))) {
		const doc = readDoc(sheet);
		const a = doc.aircraft;
		if (sheet.path.startsWith(`${GENERIC}/`)) {
			const id = sheet.path.slice(GENERIC.length + 1).replace(/\.yaml$/, '');
			if (a.generic !== id) {
				throw new Error(`${sheet.path}: a generic sheet states generic: ${id}, the name of its file`);
			}
			// The schema reads an empty registration as none.
			if (typeof a.registration === 'string' && a.registration !== '') {
				throw new Error(`${sheet.path}: a generic sheet is a type, with no registration`);
			}
			generic.push({ path: sheet.path, type: a.type });
		} else {
			if (a.generic !== undefined) {
				throw new Error(`${sheet.path}: a generic sheet sits under ${GENERIC}/, its file named by its id`);
			}
			const name = clubName(a);
			if (name === null) {
				throw new Error(`${sheet.path}: a club sheet states its aircraft's registration`);
			}
			if (sheet.path !== name) {
				throw new Error(`${sheet.path}: a club sheet is named by its registration: ${name}`);
			}
			club.push({ path: sheet.path, type: a.type });
		}
		hash.update(`${sheet.path}\0${JSON.stringify(canonical(doc))}\n`);
	}
	const digest = hash.digest('hex').slice(0, 16);
	const prev = previous ?? {};
	const meta = {
		generatedAt: prev.digest === digest && typeof prev.generatedAt === 'string' ? prev.generatedAt : stamp(now),
		digest,
		...(typeof prev.source === 'string' ? { source: prev.source } : {}),
		aircraftCount: club.length,
		files: club.map((s) => s.path),
		counts: countByType(club.map((s) => s.type)),
	};
	if (generic.length > 0) {
		meta.generic = {
			...(typeof prev.generic?.source === 'string' ? { source: prev.generic.source } : {}),
			files: generic.map((s) => s.path),
			counts: countByType(generic.map((s) => s.type)),
		};
	}
	return meta;
}

/** The index as its file holds it: two-space JSON, a final line break. */
export function renderMeta(meta) {
	return `${JSON.stringify(meta, null, 2)}\n`;
}

/** Where a plane exported from the app goes in the library: its file name,
 *  by its registration. A generic sheet is refused (written by hand under
 *  generic/, its id its file's name), and so is a plane without a
 *  registration: a club's aircraft is an airframe. */
export function promotionTarget(text, source = 'the sheet') {
	const a = readDoc({ path: source, text }).aircraft;
	if (a.generic !== undefined) {
		throw new Error(`${source}: a generic sheet is written by hand under ${GENERIC}/, its file named by its id`);
	}
	const name = clubName(a);
	if (name === null) {
		throw new Error(`${source}: a club aircraft states its registration`);
	}
	return name;
}

/** The index as committed, or null where there is none yet. One that does
 *  not parse stops the run: regenerated over, its prose would be lost. */
function readPrevious(file = OUT) {
	if (!existsSync(file)) {
		return null;
	}
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(
			`${basename(file)} does not parse (${e instanceof Error ? e.message : String(e)}): mend it, its source texts are kept from it`,
			{ cause: e },
		);
	}
}

function say(line) {
	process.stdout.write(`${NAME}: ${line}\n`);
}

function main(argv) {
	const check = argv.includes('--check');
	const at = argv.indexOf('--add');
	const add = at >= 0 ? argv[at + 1] : undefined;
	const known = argv.every((arg, i) => arg === '--check' || arg === '--add' || (i === at + 1 && at >= 0));
	if (!known || (at >= 0 && add === undefined) || (check && add !== undefined)) {
		say('usage: gen-aircraft-meta.js [--check | --add <exported sheet.yaml>]');
		process.exitCode = 2;
		return;
	}
	try {
		const sheets = readSheets();
		let promoted = null;
		if (add !== undefined) {
			const text = readFileSync(add, 'utf8');
			const name = promotionTarget(text, basename(add));
			if (existsSync(join(DIR, name))) {
				throw new Error(
					`${name} is in the library already: edit that sheet, whose comments carry its provenance`,
				);
			}
			promoted = { path: name, text: text.endsWith('\n') ? text : `${text}\n` };
			sheets.push(promoted);
		}
		// Every sheet is checked before anything is written.
		const previous = readPrevious();
		const meta = buildMeta(sheets, previous, Date.now());
		const text = renderMeta(meta);
		const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
		if (check) {
			if (text === current) {
				say(`current (${meta.aircraftCount} club sheets, ${meta.generic?.files.length ?? 0} generic, generated ${meta.generatedAt})`);
			} else {
				say('public/data/aircraft.meta.json is not the index the sheets make: run npm run gen:aircraft-meta');
				process.exitCode = 1;
			}
			return;
		}
		if (promoted !== null) {
			writeFileSync(join(DIR, promoted.path), promoted.text);
			say(`${basename(add)} -> public/data/aircraft/${promoted.path}`);
		}
		if (text === current) {
			say(`unchanged (${meta.aircraftCount} club sheets, ${meta.generic?.files.length ?? 0} generic, generated ${meta.generatedAt})`);
		} else {
			writeFileSync(OUT, text);
			say(
				`${meta.aircraftCount} club sheets, ${meta.generic?.files.length ?? 0} generic -> public/data/aircraft.meta.json (generated ${meta.generatedAt}${meta.generatedAt === previous?.generatedAt ? ', the data unchanged' : ''})`,
			);
		}
		if (promoted !== null) {
			say(
				"next: give the sheet its provenance in comments (its weighing report, its manual's pages) as the others carry, name its club in the index's source if it is a new one, and run npm test -- tests/aircraftData.spec.ts",
			);
		}
	} catch (e) {
		say(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}

/* Only when run as a command: tests/aircraftMeta.spec.ts imports buildMeta()
 * and renderMeta() to compare the committed index with the sheets, and a
 * test that rewrote the file it checks would pass by fixing its own subject. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2));
}
