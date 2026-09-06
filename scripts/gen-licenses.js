/* gen-licenses.js: writes src/lib/data/thirdPartyLicenses.ts from what the
 * build actually ships.
 *
 * The About modal's libraries section states its own rule, "runtime code in
 * the shipped bundle, not build tooling". This makes that rule executable
 * rather than a promise a hand-written list keeps or breaks: the shipped set
 * is read out of the build's source maps, back through node_modules/ to a
 * package name. A hand-kept list had drifted to 14 of the 37 packages that
 * ship, crediting Vite (which contributes no module) while missing
 * html2canvas and the canvg stack, both of which ship as their own chunks
 * exactly the way DOMPurify does, and DOMPurify was credited for that reason.
 *
 * MIT, BSD, Apache-2.0 and MPL-2.0 all require their notice to travel with
 * the software, and minification strips every notice from the bundle, so the
 * texts are carried here and shown in the About modal's licence view.
 *
 * Reads dist/, so run it after a build:
 *
 *	npm run build && npm run gen:licenses
 *
 * That is not circular. The emitted module contains no node_modules code, so
 * it cannot change which packages ship. Output is sorted and carries no
 * timestamp: running it twice produces no diff, which is what
 * tests/thirdPartyLicenses.spec.ts checks.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const MODULES = join(ROOT, 'node_modules');

/* Two files, because they are read at different moments. The credit list is
 * on screen the instant About opens, so it is imported statically and has to
 * stay small; the texts are ~75 kB that most readers never expand, so they
 * are their own module and AboutModal import()s them on the first click. Put
 * them in one file and the bundler has no seam to split on. */
const OUT_LIST = join(ROOT, 'src/lib/data/thirdPartyLicenses.ts');
const OUT_TEXTS = join(ROOT, 'src/lib/data/thirdPartyLicenseTexts.ts');

/* How a package is credited: the name a reader recognises and the page they
 * would go to. npm names and `homepage` fields are neither ("pdfjs-dist"
 * points at a repository directory), so the ones worth naming properly are
 * named here and everything else falls back to the package's own metadata. */
const PRESENTATION = {
	svelte: { name: 'Svelte', url: 'https://svelte.dev/' },
	leaflet: { name: 'Leaflet', url: 'https://leafletjs.com/' },
	rbush: { name: 'RBush', url: 'https://github.com/mourner/rbush' },
	yaml: { name: 'yaml', url: 'https://eemeli.org/yaml/' },
	'html2canvas-pro': { name: 'html2canvas-pro', url: 'https://github.com/yorickshan/html2canvas-pro' },
	html2canvas: { name: 'html2canvas', url: 'https://github.com/niklasvh/html2canvas' },
	jspdf: { name: 'jsPDF', url: 'https://github.com/parallax/jsPDF' },
	'pdfjs-dist': { name: 'pdf.js', url: 'https://mozilla.github.io/pdf.js/' },
	dompurify: { name: 'DOMPurify', url: 'https://github.com/cure53/DOMPurify' },
	pmtiles: { name: 'PMTiles', url: 'https://github.com/protomaps/PMTiles' },
	canvg: { name: 'canvg', url: 'https://github.com/canvg/canvg' },
	'core-js': { name: 'core-js', url: 'https://github.com/zloirock/core-js' },
	pako: { name: 'pako', url: 'https://github.com/nodeca/pako' },
	fflate: { name: 'fflate', url: 'https://github.com/101arrowz/fflate' },
	'fast-png': { name: 'fast-png', url: 'https://github.com/image-js/fast-png' },
	iobuffer: { name: 'IOBuffer', url: 'https://github.com/image-js/iobuffer' },
	quickselect: { name: 'quickselect', url: 'https://github.com/mourner/quickselect' },
	clsx: { name: 'clsx', url: 'https://github.com/lukeed/clsx' },
	raf: { name: 'raf', url: 'https://github.com/chrisdickinson/raf' },
	'performance-now': { name: 'performance-now', url: 'https://github.com/braveg1rl/performance-now' },
	rgbcolor: { name: 'rgbcolor', url: 'https://github.com/stoyan/rgbcolor' },
	'stackblur-canvas': { name: 'StackBlur', url: 'https://github.com/flozz/StackBlur' },
	'svg-pathdata': { name: 'svg-pathdata', url: 'https://github.com/nfroidure/svg-pathdata' },
	'@babel/runtime': { name: '@babel/runtime', url: 'https://babeljs.io/' },
	'@capacitor/synapse': { name: '@capacitor/synapse', url: 'https://github.com/ionic-team/capacitor-synapse' },
};

const CAPACITOR = 'https://capacitorjs.com/';
const WORKBOX = 'https://developer.chrome.com/docs/workbox';

/* A package that ships no licence file of its own, whose text therefore has
 * to come from the project itself. Reproducing the notice is the whole
 * obligation, so this is fetched rather than reconstructed from an SPDX
 * template: a BSD-3-Clause template without Protomaps' copyright line would
 * satisfy nothing.
 *
 * pmtiles 4.4.1 publishes only dist/, src/, README.md and package.json. The
 * text below is github.com/protomaps/PMTiles/blob/main/LICENSE, read
 * 2026-08-15. Re-read it when the dependency is bumped; the spec fails if a
 * package starts shipping its own file, which is the signal to drop the
 * entry. */
const NO_LICENSE_FILE = {
	pmtiles: {
		source: 'https://raw.githubusercontent.com/protomaps/PMTiles/main/LICENSE',
		read: '2026-08-15',
		text: `The below license (BSD-3) applies to the reference implementations in this repository.

The PMTiles specification itself is public domain, or CC0 where applicable.

Sample tilesets available in this repository are subject to their own license terms.

---

Copyright 2021 Protomaps LLC

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
	},
};

/** Package name out of a source-map path, "@scope/name" kept whole. */
function packageOf(source) {
	const at = source.lastIndexOf('node_modules/');
	if (at < 0) {
		return null;
	}
	const parts = source.slice(at + 'node_modules/'.length).split('/');
	return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Every .map under a directory, at any depth. The app's chunks sit in
 *  assets/, but the service worker's Workbox runtime is emitted beside it at
 *  the dist root, and that map is the only place workbox-core, -routing,
 *  -precaching and -strategies are named: the service worker inlines them,
 *  so their names survive nowhere in sw.js itself. Scanning one directory
 *  silently credited workbox-window alone. */
function sourceMaps(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...sourceMaps(path));
		} else if (entry.name.endsWith('.map')) {
			out.push(path);
		}
	}
	return out.sort();
}

/** Every package with code in the build, read from what the build says about
 *  itself rather than from the dependency graph: an optional dependency the
 *  bundler dropped is not shipped, and a transitive one it kept is.
 *
 *  @param {string} [dist]
 *  @returns {string[]} */
export function shippedPackages(dist = DIST) {
	const found = new Set();
	for (const file of sourceMaps(dist)) {
		const map = JSON.parse(readFileSync(file, 'utf-8'));
		for (const source of map.sources ?? []) {
			const name = packageOf(source);
			if (name) {
				found.add(name);
			}
		}
	}
	return [...found].sort();
}

/** The licence files a package ships, newest convention first. Several ship
 *  more than one (DOMPurify is dual-licensed and carries both), so all of
 *  them are kept, each under its own filename. */
function licenseFiles(dir) {
	return readdirSync(dir)
		.filter((f) => /^(licen[cs]e|copying|notice)/i.test(f))
		.filter((f) => statSync(join(dir, f)).isFile())
		.sort();
}

/** One credit entry, or null for a package that is not installed.
 *
 *  @typedef {{id: string, name: string, url: string, version: string,
 *             spdx: string, files: string[], text: string}} Credit
 *  @param {string} id
 *  @param {string} [modules]
 *  @returns {Credit | null} */
export function readPackage(id, modules = MODULES) {
	const dir = join(modules, id);
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
	} catch {
		return null;
	}
	const files = licenseFiles(dir);
	const override = NO_LICENSE_FILE[id];
	// A package that ships nothing is the only case an override may cover;
	// once upstream starts shipping a file, the file wins and the override
	// is dead weight the spec will point at.
	const text = files.length
		? files
				.map((f) => (files.length > 1 ? `${f}\n\n${readFileSync(join(dir, f), 'utf-8')}` : readFileSync(join(dir, f), 'utf-8')))
				.join('\n\n')
				.trimEnd()
		: (override?.text ?? '');
	const preset =
		PRESENTATION[id] ??
		(id.startsWith('@capacitor/')
			? { name: id, url: CAPACITOR }
			: id.startsWith('workbox-')
				? { name: id, url: WORKBOX }
				: { name: id, url: typeof pkg.homepage === 'string' ? pkg.homepage : `https://www.npmjs.com/package/${id}` });
	return {
		id,
		name: preset.name,
		url: preset.url,
		version: String(pkg.version ?? ''),
		spdx: String(pkg.license ?? (Array.isArray(pkg.licenses) ? (pkg.licenses[0]?.type ?? '') : '')),
		files: files.length ? files : override ? [`${override.source} (read ${override.read})`] : [],
		text,
	};
}

/** The whole credit list, in the order the About modal shows it: by the name
 *  a reader sees, case-insensitively, so "@babel/runtime" and "DOMPurify"
 *  land where a reader looks for them.
 *
 *  @param {string} [dist]
 *  @param {string} [modules]
 *  @returns {Credit[]} */
export function collect(dist = DIST, modules = MODULES) {
	return shippedPackages(dist)
		.map((id) => readPackage(id, modules))
		.filter((e) => e !== null)
		.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en'));
}

/* A single-quoted JS string literal, because the emitted files are ordinary
 * source and eslint's `quotes` rule holds them to the same style as every
 * other file. JSON.stringify would double-quote them, and a generated file
 * excluded from lint is a file nobody reads. */
const q = (s) =>
	`'${s
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029')}'`;

const GENERATED = (file) =>
	`/* ${file} -- GENERATED by scripts/gen-licenses.js; do not edit.
 *
 * Regenerate with \`npm run build && npm run gen:licenses\`.
 * tests/thirdPartyLicenses.spec.ts fails when this file and the tree
 * disagree, which is what a dependency bump trips.`;

function renderList(entries) {
	const body = entries
		.map(
			(e) => `	{
		id: ${q(e.id)},
		name: ${q(e.name)},
		version: ${q(e.version)},
		spdx: ${q(e.spdx)},
		url: ${q(e.url)},
		files: [${e.files.map(q).join(', ')}],
	},`,
		)
		.join('\n');
	return `${GENERATED('thirdPartyLicenses.ts')}
 *
 * Every package with code in the built bundle, read from the build's own
 * source maps rather than from package.json: an optional dependency the
 * bundler dropped is not shipped, and a transitive one it kept is. The About
 * modal's libraries section is this list.
 *
 * The texts live next door in thirdPartyLicenseTexts.ts, imported on demand,
 * so this module stays small enough to sit in the main chunk.
 *
 * ${entries.length} packages. */

export interface ThirdPartyLicense {
	/** npm package name; the id a licence text is addressed by. */
	id: string;
	/** The name the credit line shows, which is not always the npm one. */
	name: string;
	version: string;
	/** The package's own \`license\` field, verbatim: usually SPDX, sometimes
	 *  a compound expression, occasionally neither. */
	spdx: string;
	url: string;
	/** The licence file names read, or the upstream source for a package
	 *  that ships none of its own. */
	files: string[];
}

export const THIRD_PARTY_LICENSES: ThirdPartyLicense[] = [
${body}
];

/** The entry a licence view was opened for, or undefined for an id that is
 *  no longer a dependency. */
export function thirdPartyLicense(id: string): ThirdPartyLicense | undefined {
	return THIRD_PARTY_LICENSES.find((e) => e.id === id);
}
`;
}

function renderTexts(entries) {
	const bytes = entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
	const distinct = new Set(entries.map((e) => createHash('sha1').update(e.text).digest('hex'))).size;
	const body = entries.map((e) => `	${q(e.id)}: ${q(e.text)},`).join('\n');
	return `${GENERATED('thirdPartyLicenseTexts.ts')}
 *
 * The licence texts themselves, verbatim from each package. MIT, BSD-2,
 * BSD-3, Apache-2.0 and MPL-2.0 all require their notice to travel with the
 * software, and minification strips every notice from the bundle, so this is
 * the only place the app carries the ones it has to pass on.
 *
 * Imported on demand by AboutModal, so it is its own chunk and a reader who
 * never opens a licence never downloads it. The service worker still
 * precaches it, so it works offline like the rest of the app.
 *
 * ${entries.length} texts, ${distinct} distinct, ${bytes} bytes. */

export const THIRD_PARTY_LICENSE_TEXTS: Record<string, string> = {
${body}
};
`;
}

function main() {
	const entries = collect();
	writeFileSync(OUT_LIST, renderList(entries));
	writeFileSync(OUT_TEXTS, renderTexts(entries));
	const missing = entries.filter((e) => !e.text).map((e) => `${e.id} (${e.spdx})`);
	process.stdout.write(`gen-licenses: ${entries.length} packages -> thirdPartyLicenses.ts + thirdPartyLicenseTexts.ts\n`);
	if (missing.length) {
		// A package that ships no licence file and has no entry in
		// NO_LICENSE_FILE would otherwise be credited with an empty text,
		// which is worse than not crediting it: it looks like the notice is
		// there.
		process.stdout.write(`gen-licenses: NO LICENCE TEXT for ${missing.join(', ')}\n`);
		process.exitCode = 1;
	}
}

/* Only when run as a command. tests/thirdPartyLicenses.spec.ts imports
 * collect() and shippedPackages() to compare the committed modules against
 * the tree, and a test that rewrote the source it is checking would pass by
 * fixing its own subject. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
