/* Countries on the search engine: a fly-to row, ranked last, named in both
 * of the app's languages whatever the interface speaks, and fitted to the
 * country's own aerodromes (docs/search.md "Countries"). Pure: the names come
 * in through `nameOf`, the platform's data the caller holds. */

import type { Airport } from '$lib/data/airports';
import type { LatLon } from '$lib/notam/types';
import { frame } from './fold';
import { keyCache } from './keys';
import { matchTier, NO_MATCH } from './match';
import type { PreparedQuery } from './query';
import { CLASS, compareHits, distFrom, KIND, type Hit, type Ranked } from './rank';

export interface Box {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

export interface Country {
	/** ISO 3166-1 alpha-2, upper-case, as the aerodromes file it. */
	code: string;
	en: string;
	fr: string;
	/** Open aerodromes filed under it. */
	count: number;
	/** Where the map fits: robustExtent of those aerodromes. */
	extent: Box;
	/** The median aerodrome, what a country's distance is measured to. */
	centre: LatLon;
}

// Below this many points the fences are skipped: too few to tell an outlier.
const FENCE_MIN_POINTS = 8;
// Tukey's far-out fences: an aerodrome past three spreads of the middle half
// is a territory the country files under its code, not the country.
const FENCE_K = 3;
// A box never narrower than this, in degrees (a one-aerodrome microstate).
const MIN_SPAN_DEG = 0.5;

function quantile(sorted: readonly number[], p: number): number {
	const i = (sorted.length - 1) * p;
	const lo = Math.floor(i);
	const hi = Math.ceil(i);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

function widen(lo: number, hi: number): [number, number] {
	if (hi - lo >= MIN_SPAN_DEG) {
		return [lo, hi];
	}
	const mid = (lo + hi) / 2;
	return [mid - MIN_SPAN_DEG / 2, mid + MIN_SPAN_DEG / 2];
}

/** The box a set of positions occupies, the far outliers left out: the
 *  longitudes unwrapped at their widest gap, so a set astride the
 *  antimeridian (the Aleutians) is one interval (its east edge may then pass
 *  180, which a map fit takes as it is); null for no points. */
export function robustExtent(points: readonly LatLon[]): Box | null {
	if (points.length === 0) {
		return null;
	}
	const lons = points.map((p) => p.lon).sort((a, b) => a - b);
	let gap = lons[0] + 360 - lons[lons.length - 1];
	let start = lons[0];
	for (let i = 0; i + 1 < lons.length; i++) {
		if (lons[i + 1] - lons[i] > gap) {
			gap = lons[i + 1] - lons[i];
			start = lons[i + 1];
		}
	}
	let pts = points.map((p) => ({ lat: p.lat, lon: p.lon < start ? p.lon + 360 : p.lon }));
	if (pts.length >= FENCE_MIN_POINTS) {
		const fence = (vals: number[]): [number, number] => {
			const s = vals.sort((a, b) => a - b);
			const q1 = quantile(s, 0.25);
			const q3 = quantile(s, 0.75);
			return [q1 - FENCE_K * (q3 - q1), q3 + FENCE_K * (q3 - q1)];
		};
		const [latLo, latHi] = fence(pts.map((p) => p.lat));
		const [lonLo, lonHi] = fence(pts.map((p) => p.lon));
		pts = pts.filter((p) => p.lat >= latLo && p.lat <= latHi && p.lon >= lonLo && p.lon <= lonHi);
	}
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const p of pts) {
		minLat = Math.min(minLat, p.lat);
		maxLat = Math.max(maxLat, p.lat);
		minLon = Math.min(minLon, p.lon);
		maxLon = Math.max(maxLon, p.lon);
	}
	[minLat, maxLat] = widen(minLat, maxLat);
	[minLon, maxLon] = widen(minLon, maxLon);
	return { minLat, minLon, maxLat, maxLon };
}

// OurAirports files an aerodrome of no known country under ZZ, which CLDR
// names "Unknown Region": no place to fly to.
const NO_COUNTRY = 'ZZ';

/** One row per country the aerodromes are filed under, named by `nameOf`
 *  (undefined for a code the platform does not know, which is left out). */
export function countryIndex(
	airports: readonly Airport[],
	nameOf: (code: string, lang: 'en' | 'fr') => string | undefined,
): Country[] {
	const byCode = new Map<string, LatLon[]>();
	for (const a of airports) {
		const code = a.country.toUpperCase();
		if (!code || code === NO_COUNTRY || a.type === 'closed') {
			continue;
		}
		let pts = byCode.get(code);
		if (!pts) {
			pts = [];
			byCode.set(code, pts);
		}
		pts.push({ lat: a.lat, lon: a.lon });
	}
	const out: Country[] = [];
	for (const [code, pts] of byCode) {
		const en = nameOf(code, 'en');
		const fr = nameOf(code, 'fr');
		const extent = robustExtent(pts);
		if (!en || !fr || !extent) {
			continue;
		}
		const lats = pts.map((p) => p.lat).sort((a, b) => a - b);
		const lons = pts.map((p) => p.lon).sort((a, b) => a - b);
		const centre = { lat: quantile(lats, 0.5), lon: quantile(lons, 0.5) };
		out.push({ code, en, fr, count: pts.length, extent, centre });
	}
	return out;
}

// A country is matched on its names alone, from this many letters: its
// two-letter code would answer every aerodrome prefix (LF, ED) typed.
const MIN_LETTERS = 3;

const countryKey = keyCache((c: Country) => ({ id: [], altId: [], name: frame([c.en, c.fr]), altName: '' }));

export function rankCountries(
	rows: readonly Country[],
	q: PreparedQuery,
	opts: { ref: LatLon | null; cap: number },
): Ranked<Country> {
	if (q.words.replace(/ /g, '').length < MIN_LETTERS) {
		return { hits: [], total: 0 };
	}
	const hits: Hit<Country>[] = [];
	for (const c of rows) {
		const tier = matchTier(countryKey(c), q);
		if (tier !== NO_MATCH) {
			const d = distFrom(opts.ref, c.centre.lat, c.centre.lon);
			hits.push({ item: c, tier, cls: CLASS.OPEN, dist: d, kind: KIND.country, order: c.code });
		}
	}
	hits.sort(compareHits);
	return { hits: hits.slice(0, opts.cap), total: hits.length };
}
