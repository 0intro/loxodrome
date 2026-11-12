/* How well a candidate matches a query: one tier scale for every kind of
 * result, lower is better (docs/search.md "Tiers"). Pure. */

import type { PreparedQuery } from './query';

export const TIER = {
	/** An identifier: an ident, a NOTAM id, a compact airspace id. */
	IDENT_EXACT: 0,
	/** A secondary identifier: an IATA code, a VRP's aerodrome, a designator. */
	ALT_IDENT_EXACT: 1,
	/** The whole query is a name: above an identifier it merely begins, so
	 *  "Roma" is the city before the ROMAK waypoint. */
	NAME_EXACT: 2,
	IDENT_PREFIX: 3,
	ALT_IDENT_PREFIX: 4,
	/** Every word of the query begins a word of the primary name. */
	NAME_PREFIX: 5,
	/** Every word begins a word of the names together, the secondary ones
	 *  (a city, a landmark, an exonym, a département) included. */
	ALT_NAME_PREFIX: 6,
	NAME_SUBSTRING: 7,
	ALT_NAME_SUBSTRING: 8,
	/** An identifier match far from the reference whose names do not match
	 *  (rank.ts FAR_IDENT_M): after every name, before an identifier the
	 *  query is only inside. */
	FAR_IDENT: 9,
	IDENT_SUBSTRING: 10,
} as const;

/** The tiers an identifier matches at, exact or begun. NAME_EXACT sits
 *  among them, so they are no range. */
export function isIdentTier(t: number): boolean {
	return t === TIER.IDENT_EXACT || t === TIER.ALT_IDENT_EXACT || t === TIER.IDENT_PREFIX || t === TIER.ALT_IDENT_PREFIX;
}

/** No match. */
export const NO_MATCH = -1;

/** A query of fewer letters than this matches inside a name only as a word's
 *  beginning; inside an identifier, fewer than IDENT_SUBSTRING_MIN. */
const SUBSTRING_MIN = 3;
const IDENT_SUBSTRING_MIN = 2;

/** What a candidate is matched on. Identifiers are upper-cased; names are
 *  folded and framed (src/lib/search/fold.ts `frame`). */
export interface SearchKey {
	readonly id: readonly string[];
	readonly altId: readonly string[];
	readonly name: string;
	readonly altName: string;
}

/** Every word of the query, by one of its alternatives, begins a word of
 *  the framed text. */
function allWordsBegin(framed: string, tokens: PreparedQuery['tokens']): boolean {
	return tokens.every((alts) => alts.some((w) => framed.includes(' ' + w)));
}

/** The whole query is one of the names. */
function nameExact(key: SearchKey, q: PreparedQuery): boolean {
	return q.tokens.length > 0 && key.name.includes('\n ' + q.exact + '\n');
}

/** The name tiers under the exact one: every word beginning a word, then
 *  the query inside a name, or NO_MATCH. */
function wordTier(key: SearchKey, q: PreparedQuery): number {
	if (q.tokens.length === 0) {
		return NO_MATCH;
	}
	if (allWordsBegin(key.name, q.tokens)) {
		return TIER.NAME_PREFIX;
	}
	if (allWordsBegin(key.name + key.altName, q.tokens)) {
		return TIER.ALT_NAME_PREFIX;
	}
	if (q.words.length >= SUBSTRING_MIN) {
		if (key.name.includes(q.words)) {
			return TIER.NAME_SUBSTRING;
		}
		if (key.altName.includes(q.words)) {
			return TIER.ALT_NAME_SUBSTRING;
		}
	}
	return NO_MATCH;
}

/** The tier at which the names alone match `q`, NAME_EXACT to
 *  ALT_NAME_SUBSTRING, or NO_MATCH. */
export function nameTier(key: SearchKey, q: PreparedQuery): number {
	return nameExact(key, q) ? TIER.NAME_EXACT : wordTier(key, q);
}

/** The tier at which `key` matches `q`, or NO_MATCH: each test runs only
 *  when every better one has failed. `compact` compares the identifiers
 *  with the query's compact form (airspace designators). */
export function matchTier(key: SearchKey, q: PreparedQuery, compact = false): number {
	const qi = compact ? q.compact : q.upper;
	if (qi) {
		if (key.id.includes(qi)) {
			return TIER.IDENT_EXACT;
		}
		if (key.altId.includes(qi)) {
			return TIER.ALT_IDENT_EXACT;
		}
	}
	if (nameExact(key, q)) {
		return TIER.NAME_EXACT;
	}
	if (qi) {
		if (key.id.some((x) => x.startsWith(qi))) {
			return TIER.IDENT_PREFIX;
		}
		if (key.altId.some((x) => x.startsWith(qi))) {
			return TIER.ALT_IDENT_PREFIX;
		}
	}
	const w = wordTier(key, q);
	if (w !== NO_MATCH) {
		return w;
	}
	if (qi.length >= IDENT_SUBSTRING_MIN && key.id.some((x) => x.includes(qi))) {
		return TIER.IDENT_SUBSTRING;
	}
	return NO_MATCH;
}
