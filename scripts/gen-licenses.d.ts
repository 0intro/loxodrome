/* Types for gen-licenses.js, so tests/thirdPartyLicenses.spec.ts can compare
 * the committed modules against a fresh scan without linting `any`. The
 * script itself stays plain JS: it is build tooling and lives outside the app
 * tsconfig, like scripts/i18n-lint.js. */

export interface Credit {
	id: string;
	name: string;
	url: string;
	version: string;
	spdx: string;
	files: string[];
	text: string;
}

/** A credit as collect() emits it: which bundle ships it, and whether it is
 *  artwork copied into src/ rather than an installed package. */
export interface Entry extends Credit {
	inViewer: boolean;
	vendored: boolean;
}

/** Artwork copied into src/: the files holding it, the upstream release it
 *  was checked against, and where and when its licence text was read. */
export interface Vendored {
	id: string;
	name: string;
	url: string;
	version: string;
	spdx: string;
	paths: string[];
	source: string;
	read: string;
	textFile: string;
}

export const VENDORED: readonly Vendored[];

/** Every package with code in the build, from its own source maps. */
export function shippedPackages(dist?: string): string[];

/** Every repository file with code in the build, repo-relative. */
export function shippedSources(dist?: string): string[];

/** One credit entry, or null for a package that is not installed. */
export function readPackage(id: string, modules?: string): Credit | null;

/** The whole credit list, in the order the About modal shows it. */
export function collect(dist?: string, modules?: string): Entry[];
