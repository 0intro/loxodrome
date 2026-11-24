/* The zones of major sensitivity (ZSM) of the large raptors' national action
 * plans, as the STAC publishes them (fr-zsm.json, cmd/zsm): AIP France ENR
 * 5.6-1 asks pilots to avoid an active one as far as possible, else to
 * overfly it 1,000 m above its highest point, the height each row carries.
 * docs/zsm-study.md holds the reading.
 *
 * A zone's activity is the file's flag, dated by its record: active, it
 * holds from that date to its species' last day of season, as the DREAL
 * Nouvelle-Aquitaine's principles of October 2025 set it, and the next
 * edition switches it off sooner where a pair settles elsewhere. */

import type { ActivityRule } from './activity';
import { readDataJsonSoft } from './fetchData';
import { groupThousands } from '$lib/format/datetime';
import { ringAreaM2, ringBbox, type Bbox } from '$lib/notam/geometry';

export const ZSM_URL = '/data/fr-zsm.json';

export interface Zsm {
	/** "zsm:<id_zsm_tampon>". */
	id: string;
	name: string;
	/** The species as the STAC names it ("Gypaète barbu"). */
	species: string;
	/** Its TAXREF code. */
	taxon: string;
	active: boolean;
	/** The zone's highest point, metres above mean sea level. */
	topM: number;
	/** The height to overfly it at, metres above mean sea level: its highest
	 *  point plus 1,000 m for powered flights and gliders. */
	overflyM: number;
	/** The record's date, YYYY-MM-DD. */
	modified: string;
	ring: [number, number][];
	bbox: Bbox;
	areaM2: number;
}

type Row = readonly [string, string, string, string, boolean, number, number, string, [number, number][]];

/** The zones, or an empty list where the file is absent. A failure worth
 *  asking again rejects (readDataJsonSoft), for its retry. */
export async function loadZsm(url = ZSM_URL): Promise<Zsm[]> {
	const doc = await readDataJsonSoft<{ fields: string[]; rows: readonly Row[] }>(url);
	if (!doc) {
		return [];
	}
	return doc.rows.map(([id, name, species, taxon, active, topM, overflyM, modified, ring]) => ({
		id,
		name,
		species,
		taxon,
		active,
		topM,
		overflyM,
		modified,
		ring,
		bbox: ringBbox(ring),
		areaM2: ringAreaM2(ring),
	}));
}

/** Each species' last day of season, month and day: the date its zones
 *  are switched off whatever the year's breeding. The bearded vulture's is
 *  15 August, 31 August in the Alps, read here as the later. */
const SEASON_END: Readonly<Record<string, readonly [number, number]>> = {
	'Gypaète barbu': [8, 31],
	'Vautour percnoptère': [9, 15],
	'Vautour moine': [10, 15],
	'Aigle de Bonelli': [7, 15],
};

/** The last day a zone active on `from` (YYYY-MM-DD) holds, YYYY-MM-DD, or
 *  undefined for a species the principles leave out. A season runs over
 *  the new year (the bearded vulture's, 1 November to August). */
export function seasonEnd(species: string, from: string): string | undefined {
	const end = SEASON_END[species];
	if (!end) {
		return undefined;
	}
	const [y, m, d] = from.split('-').map(Number);
	const year = m > end[0] || (m === end[0] && d > end[1]) ? y + 1 : y;
	return `${year}-${String(end[0]).padStart(2, '0')}-${String(end[1]).padStart(2, '0')}`;
}

/** A zone's rules for the activity model: firm from its record's date to
 *  its season's end when the file says it is active, none when it says it
 *  is not. */
export function zsmRules(z: Pick<Zsm, 'active' | 'species' | 'modified'>): ActivityRule[] {
	if (!z.active) {
		return [];
	}
	const end = seasonEnd(z.species, z.modified);
	return [{ mode: 'firm', date: z.modified, ...(end ? { dateTo: end } : {}) }];
}

/** Whether a zone is active over any part of [fromMs, toMs]: its rule's
 *  whole days in UTC. */
export function zsmActiveIn(z: Pick<Zsm, 'active' | 'species' | 'modified'>, fromMs: number, toMs: number): boolean {
	const [rule] = zsmRules(z);
	if (!rule) {
		return false;
	}
	const start = Date.parse(`${rule.date}T00:00:00Z`);
	const end = rule.dateTo ? Date.parse(`${rule.dateTo}T00:00:00Z`) + 86_400_000 : Infinity;
	return start <= toMs && fromMs < end;
}

const FT_PER_M = 1 / 0.3048;

/** A height in metres as feet, up to the next 10 ft: the height to
 *  overfly a zone at reads no lower than it is. The epsilon keeps an exact
 *  conversion exact (3 048 m is 10 000 ft). */
export function feetOf(m: number): number {
	return Math.ceil((m * FT_PER_M) / 10 - 1e-9) * 10;
}

/** The height in feet alone ("10 210 ft"), as the profile's strip and the
 *  nav log's schedule print it beside the published limits. */
export function zsmFeet(overflyM: number): string {
	return `${groupThousands(feetOf(overflyM))}\u202fft`;
}

/** The height label, feet then metres ("10 210 ft (3 110 m)"), each figure
 *  grouped by thousands, the units ICAO's in both languages. */
export function zsmLabel(overflyM: number): string {
	return `${zsmFeet(overflyM)} (${groupThousands(overflyM)}\u202fm)`;
}
