/* Types for gen-privacy.js, so tests/privacyPage.spec.ts can regenerate the
 * page and compare it against the committed one without linting `any`. The
 * script itself stays plain JS: it is build tooling and lives outside the app
 * tsconfig, like scripts/gen-licenses.js and scripts/i18n-lint.js. */

/** The string-valued keys of a catalog's `about` object, cooked. */
export type Catalog = Record<string, string>;

/** One catalog's string keys, read with the TypeScript compiler API because
 *  Node cannot import the extensionless specifiers the catalogs use. */
export function readCatalog(file: string): Catalog;

/** The whole page, both languages, byte for byte as the committed file. */
export function renderPage(en: Catalog, fr: Catalog): string;

/** Every catalog key the page renders, in the order it renders them. */
export function pageKeys(cat: Catalog): string[];

/** Catalog text escaped for an HTML text node, so a test can look for a
 *  string as it appears in the page. */
export function escapeText(value: string): string;
