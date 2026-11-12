/* Loader and types for the generated fr-nature.json dataset (cmd/fr): French
 * "zones naturelles" (TypeEspace PRN: parcs nationaux / réserves naturelles) and
 * sensitive-site overflight zones (SUR: nuclear / industrial / prison), where
 * low overflight is prohibited. The SIA export gives only a representative point
 * for most of these (the big parks have no polygon in the data), so each is a
 * single point carrying its minimum overflight altitude, drawn as the AIP "site
 * with special marking of prohibited low overflying" bullseye (natureSymbols.ts). */

import { readDataJsonSoft } from '$lib/data/fetchData';

export type NatureType = 'NATURE' | 'SENSITIVE' | 'BIRD';

export interface Nature {
	/** Stable slug from the SIA Espace lk ("LF-PRN-020"). */
	id: string;
	type: NatureType;
	/** Site name (Partie NomUsuel), e.g. "PARC NATIONAL DES CEVENNES". */
	name: string;
	lat: number;
	lon: number;
	/** Minimum overflight altitude value (feet, or the FL number for FL). */
	minAlt: number;
	/** Reference of minAlt: "AGL" | "AMSL" | "FL" | "SFC" | "UNL" | "". */
	minAltRef: string;
}

// Positional row layout, matching natureOutputFields in cmd/fr/nature.go.
type NatureRow = readonly [
	id: string,
	type: string,
	name: string,
	lat: number,
	lon: number,
	minAlt: number,
	minAltRef: string,
];

interface RawNature {
	fields: string[];
	rows: readonly NatureRow[];
}

/** Default dataset URL (the active AIRAC slot). */
export const NATURE_URL = '/data/fr-nature.json';

/** Next-AIRAC slot, loaded once its effective date has arrived. */
export const NATURE_NEXT_URL = '/data/fr-nature.next.json';

function rowToNature(r: NatureRow): Nature {
	// SIA legacy encoding: FL 999 (and FL 9999) means "unlimited"
	// (docs/vertical-limits.md); normalise at read so the label shows UNL
	// instead of a nonsense flight level.
	const unl = r[6] === 'FL' && r[5] >= 999;
	return {
		id: r[0],
		type: r[1] === 'SENSITIVE' ? 'SENSITIVE' : r[1] === 'BIRD' ? 'BIRD' : 'NATURE',
		name: r[2],
		lat: r[3],
		lon: r[4],
		minAlt: r[5],
		minAltRef: unl ? 'UNL' : r[6],
	};
}

/** Fetch + decode a nature dataset; returns [] (with a console warning) for
 *  what the deployment does not hold, so a missing dataset degrades quietly,
 *  and REJECTS a failure worth asking again (readDataJsonSoft), never an
 *  empty list the store would keep as the country's rows. */
export async function loadNature(url: string = NATURE_URL): Promise<Nature[]> {
	const data = await readDataJsonSoft<RawNature>(url);
	return data ? data.rows.map(rowToNature) : [];
}

/** Minimum overflight altitude as a label: "1000 ft ASFC", "FL 115", "SFC",
 *  "UNL" (the app-wide SIA vocabulary; the dataset's AGL ref is the same
 *  datum as ASFC). */
export function natureMinAltLabel(n: Nature): string {
	if (n.minAltRef === 'SFC') {
		return 'SFC';
	}
	if (n.minAltRef === 'UNL') {
		return 'UNL';
	}
	if (n.minAltRef === 'FL') {
		return `FL ${n.minAlt}`;
	}
	const ref = n.minAltRef === 'AGL' ? ' ASFC' : n.minAltRef === 'AMSL' ? ' AMSL' : '';
	return `${n.minAlt} ft${ref}`;
}

/** Human label for the zone type. */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/data.ts
export function natureTypeLabel(type: NatureType): string {
	if (type === 'BIRD') {
		return 'Bird concentration area';
	}
	return type === 'NATURE'
		? 'Park or nature reserve'
		: 'Site with special marking of prohibited low overflying';
}
// i18n-ignore-end
