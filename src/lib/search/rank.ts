/* The order of the search's results (docs/search.md "Order"): the match's
 * tier, then the candidate's class, then its distance from the reference,
 * one scale across every kind of result. Pure. */

import { equirectangularDistanceM } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';
import { isIdentTier, matchTier, nameTier, NO_MATCH, TIER, type SearchKey } from './match';
import type { PreparedQuery } from './query';

/** Beyond this, an identifier match is matched by its names instead: a
 *  town named like a far airport's code means the town ("Pau" led with
 *  Pauk, Myanmar, by its IATA code, "Gap" with Gusap, Papua New Guinea,
 *  and "Verl" with Raxaul, India, by its ICAO ident). */
export const FAR_IDENT_M = 1000 * NM_TO_METERS;

/** What a result is, before how near: an open aerodrome or a radio aid ranks
 *  above a heliport, a reporting point or an RNAV fix at the same match, a
 *  town under them, an airspace under a point, a closed aerodrome last. */
export const CLASS = {
	OPEN: 0,
	MINOR: 1,
	TOWN: 2,
	AIRSPACE: 3,
	CLOSED: 4,
} as const;

/** The kinds, in the order a tie falls to. */
export const KIND = {
	airport: 0,
	navaid: 1,
	airspace: 2,
	place: 3,
	country: 4,
	notam: 5,
	action: 6,
} as const;

export interface Hit<T> {
	readonly item: T;
	readonly tier: number;
	readonly cls: number;
	/** Metres from the reference; Infinity without one. */
	readonly dist: number;
	readonly kind: number;
	/** The last tie-break: an ident or a folded name. */
	readonly order: string;
}

export interface Ranked<T> {
	/** Best first, capped. */
	readonly hits: readonly Hit<T>[];
	/** Every match before the cap. */
	readonly total: number;
}

export function compareHits<A, B>(a: Hit<A>, b: Hit<B>): number {
	if (a.tier !== b.tier) {
		return a.tier - b.tier;
	}
	// An exact identifier names one feature wherever it is filed: of several
	// (KCIR, an aerodrome in Illinois and a reporting point in Corsica), the
	// nearest is meant, whatever its class.
	if (a.tier > TIER.ALT_IDENT_EXACT && a.cls !== b.cls) {
		return a.cls - b.cls;
	}
	if (a.dist !== b.dist) {
		return a.dist - b.dist;
	}
	if (a.kind !== b.kind) {
		return a.kind - b.kind;
	}
	return a.order < b.order ? -1 : a.order > b.order ? 1 : 0;
}

export interface RankSpec<T> {
	readonly key: (row: T) => SearchKey;
	/** Match the identifiers on the query's compact form (designators). */
	readonly compact?: boolean | undefined;
	readonly kind: number;
	readonly cls: (row: T) => number;
	/** Metres from the reference, Infinity without one. */
	readonly dist: (row: T) => number;
	readonly order: (row: T) => string;
	/** Added to every tier: half a tier puts a town under the same match on
	 *  a feature and above the next. */
	readonly tierShift?: number | undefined;
	/** Rows to leave out, applied before the cap (a filter cannot be beaten
	 *  by a broad query whose first matches happen not to pass it). */
	readonly keep?: ((row: T) => boolean) | undefined;
}

/** Rank the rows matching `q`, best first, at most `cap`. The rows are
 *  bucketed by tier and only the buckets the cap reaches are measured and
 *  sorted, so a one-letter query over fifty thousand rows sorts what it
 *  shows. An identifier match is measured as it is bucketed: a far one
 *  takes its names' tier, or FAR_IDENT, which can be an earlier bucket
 *  than its own. */
export function rankRows<T>(rows: readonly T[], q: PreparedQuery, spec: RankSpec<T>, cap: number): Ranked<T> {
	const buckets: number[][] = [];
	let total = 0;
	if (q.raw !== '') {
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i];
			if (spec.keep && !spec.keep(row)) {
				continue;
			}
			const key = spec.key(row);
			let t = matchTier(key, q, spec.compact);
			if (t === NO_MATCH) {
				continue;
			}
			if (isIdentTier(t)) {
				// Without a reference the distance is Infinity, and nothing is far.
				const d = spec.dist(row);
				if (Number.isFinite(d) && d > FAR_IDENT_M) {
					const n = nameTier(key, q);
					t = n === NO_MATCH ? TIER.FAR_IDENT : n;
				}
			}
			(buckets[t] ??= []).push(i);
			total++;
		}
	}
	const shift = spec.tierShift ?? 0;
	const hits: Hit<T>[] = [];
	for (let t = 0; t < buckets.length && hits.length < cap; t++) {
		const bucket = buckets[t];
		if (!bucket) {
			continue;
		}
		const tierHits = bucket.map((i): Hit<T> => {
			const row = rows[i];
			const d = spec.dist(row);
			return {
				item: row,
				tier: t + shift,
				cls: spec.cls(row),
				dist: Number.isNaN(d) ? Infinity : d,
				kind: spec.kind,
				order: spec.order(row),
			};
		});
		tierHits.sort(compareHits);
		for (const h of tierHits) {
			if (hits.length === cap) {
				break;
			}
			hits.push(h);
		}
	}
	return { hits, total };
}

/** Several kinds' rankings as one, best first, at most `cap`: exact, since
 *  each list holds its own best `cap`. */
export function mergeRanked<T>(lists: readonly Ranked<T>[], cap: number): Ranked<T> {
	const hits = lists.flatMap((l) => l.hits);
	hits.sort(compareHits);
	return { hits: hits.slice(0, cap), total: lists.reduce((n, l) => n + l.total, 0) };
}

/** The same hits over other items (a provider's rows wrapped as a kind of
 *  result). */
export function mapHits<T, U>(r: Ranked<T>, f: (item: T) => U): Ranked<U> {
	return { hits: r.hits.map((h) => ({ ...h, item: f(h.item) })), total: r.total };
}

/** What a provider is asked with. */
export interface RankOptions<T> {
	/** Distances are measured from here; none orders by name. */
	readonly ref: LatLon | null;
	readonly cap: number;
	readonly keep?: ((row: T) => boolean) | undefined;
}

/** Distance in metres from `ref`, Infinity without one. */
export function distFrom(ref: LatLon | null, lat: number, lon: number): number {
	return ref ? equirectangularDistanceM(ref.lat, ref.lon, lat, lon) : Infinity;
}
