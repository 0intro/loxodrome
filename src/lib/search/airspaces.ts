/* Airspaces on the search engine: by designator however a NOTAM or a chart
 * writes it ("LF-R45A", "LF R 45 A", "R 45 A", "EG D6A"), and by name
 * ("TMA SEINE", "SIV CHAMBERY") (docs/search.md "Airspaces"). Pure. */

import type { Airspace } from '$lib/data/airspaces';
import { designatorKey } from '$lib/notam/airspaceIds';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import type { LatLon } from '$lib/notam/types';
import { frame } from './fold';
import { keyCache } from './keys';
import type { SearchKey } from './match';
import type { PreparedQuery } from './query';
import { CLASS, KIND, rankRows, type RankOptions, type Ranked } from './rank';

/** Letters, digits and dots, upper-cased: the query's compact form. */
function compact(s: string): string {
	return s.toUpperCase().replace(/[^A-Z0-9.]/g, '');
}

// A designator written inside a name, prefix and type letter apart or not
// ("LI R64 - CUNEO": Italy files its designators in the name).
const NAMED_DESIGNATOR_RE = /\b([A-Z]{2})\s?([RPD])\s?(\d{1,4}[A-Z]{0,3})\b/g;
// A compact id carrying a State's prefix before its type letter (LFR45A).
const PREFIXED_ID_RE = /^[A-Z]{2}[RPD]\d/;

/** Every identifier an airspace answers to, all secondary: an aerodrome or a
 *  navaid filed under the same letters stays above it. The compact id
 *  (LFR45A), its designator key, the id without its State's prefix (R45A),
 *  the type and name run together (R45A, TMASEINE7.2), and any designator its
 *  name carries, with and without its prefix. */
function airspaceIds(a: Airspace): string[] {
	const ids = new Set<string>();
	const add = (s: string | null | undefined): void => {
		if (s) {
			ids.add(s);
		}
	};
	const id = compact(a.id);
	add(id);
	add(designatorKey(id));
	if (PREFIXED_ID_RE.test(id)) {
		add(id.slice(2));
	}
	add(compact(`${a.type}${a.name}`));
	for (const m of a.name.toUpperCase().matchAll(NAMED_DESIGNATOR_RE)) {
		add(m[1] + m[2] + m[3]);
		add(m[2] + m[3]);
	}
	return [...ids];
}

export const airspaceKey = keyCache(
	(a: Airspace): SearchKey => ({
		id: [],
		altId: airspaceIds(a),
		name: frame([`${a.type} ${a.name}`.trim()]),
		altName: '',
	}),
);

/** Metres from `ref` to the airspace's box, 0 inside it. */
function distToBox(ref: LatLon | null, b: Airspace['bbox']): number {
	if (!ref) {
		return Infinity;
	}
	const lat = Math.min(Math.max(ref.lat, b.minLat), b.maxLat);
	const lon = Math.min(Math.max(ref.lon, b.minLon), b.maxLon);
	return equirectangularDistanceM(ref.lat, ref.lon, lat, lon);
}

/** Airspaces matching `q`, one row per id and name (a zone split into
 *  sub-rings is one result). */
export function rankAirspaces(rows: readonly Airspace[], q: PreparedQuery, opts: RankOptions<Airspace>): Ranked<Airspace> {
	const { ref } = opts;
	const seen = new Set<string>();
	return rankRows(
		rows,
		q,
		{
			key: airspaceKey,
			compact: true,
			kind: KIND.airspace,
			cls: () => CLASS.AIRSPACE,
			dist: (a) => distToBox(ref, a.bbox),
			order: (a) => a.id,
			keep: (a) => {
				const k = `${a.id}|${a.name}`;
				if (seen.has(k) || (opts.keep && !opts.keep(a))) {
					return false;
				}
				seen.add(k);
				return true;
			},
		},
		opts.cap,
	);
}
