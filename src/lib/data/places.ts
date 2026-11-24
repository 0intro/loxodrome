/* The place names (docs/places.md): one file per country,
 * places-<iso>.json, and their one index, places.meta.json, which is every
 * file's sidecar. A French commune is IGN's, every other town GeoNames'.
 * The loader; the store that reads the files by area is
 * state/places.svelte.ts. */

import { readDataJsonSoft } from './fetchData';
import type { DatasetBBox, DatasetBBoxes } from './meta';

export interface Place {
	/** `<iso>:<INSEE code>` for a commune, `<iso>:<geonameid>` otherwise. */
	id: string;
	/** ISO 3166-1, upper-case. */
	country: string;
	/** As shown, in its own case ("Étampes"). */
	name: string;
	lat: number;
	lon: number;
	/** Inhabitants, null when unknown. */
	pop: number | null;
	/** The département (a commune) or the region it lies in, as published;
	 *  '' for none. */
	admin: string;
	/** The names it is also found by ("Munich" for München), '|'-joined;
	 *  '' for none. */
	alt: string;
	/** A French commune (IGN's), where every other place is a GeoNames town. */
	commune: boolean;
}

/** One country's line in the index. */
export interface PlacesCountry {
	source: 'ign' | 'geonames';
	rows: number;
	minPop: number;
	bbox?: DatasetBBox;
	bboxes?: DatasetBBoxes;
}

/** One source's line in the index: what the About credits. */
export interface PlacesSource {
	name: string;
	url: string;
	licence: string;
	licenceUrl: string;
	sha256: string;
	/** The newest change the dump carries (GeoNames). */
	date?: string;
}

export interface PlacesIndex {
	generatedAt: string;
	placeCount: number;
	sources: { ign: PlacesSource; geonames: PlacesSource };
	countries: Record<string, PlacesCountry>;
}

export function placesUrl(iso: string): string {
	return `/data/places-${iso}.json`;
}

// Positional row layout, matching cmd/places' fields.
type PlaceRow = readonly [
	id: string,
	name: string,
	lat: number,
	lon: number,
	pop: number | null,
	admin: string | null,
	alt: string,
];

interface RawPlaces {
	fields: string[];
	admins: Record<string, string>;
	rows: readonly PlaceRow[];
}

/** One country's places, `commune` for a file IGN's communes fill. Fail-soft
 *  for a file the deployment does not hold, which returns []; every other
 *  failure rejects (the national loaders' rule). */
export async function loadPlaces(iso: string, commune: boolean): Promise<Place[]> {
	const doc = await readDataJsonSoft<RawPlaces>(placesUrl(iso));
	if (!doc) {
		return [];
	}
	const country = iso.toUpperCase();
	return doc.rows.map((r) => ({
		id: r[0],
		country,
		name: r[1],
		lat: r[2],
		lon: r[3],
		pop: r[4],
		admin: r[5] !== null ? (doc.admins[r[5]] ?? '') : '',
		alt: r[6],
		commune,
	}));
}
