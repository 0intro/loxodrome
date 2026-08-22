/* Loader and types for the generated fr-nature.json dataset (cmd/fr): French
 * "zones naturelles" (TypeEspace PRN: parcs nationaux / réserves naturelles) and
 * sensitive-site overflight zones (SUR: nuclear / industrial / prison), where
 * low overflight is prohibited. The SIA export gives only a representative point
 * for most of these (the big parks have no polygon in the data), so each is a
 * single point carrying its minimum overflight altitude, drawn as the AIP "site
 * with special marking of prohibited low overflying" bullseye (natureSymbols.ts). */

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

/** Belgium & Luxembourg bird areas (cmd/be, eAIP ENR 5.6): named bird
 *  concentration areas + GEOREF squares as centroid points, type BIRD,
 *  carrying the section's blanket "avoid below 1 000 ft ASFC"
 *  recommendation. */
export const BE_NATURE_URL = '/data/be-nature.json';

/** Belgium & Luxembourg bird-area pre-release URL (cmd/be, eAIP_Next). */
export const BE_NATURE_NEXT_URL = '/data/be-nature.next.json';

/** Italian protected natural sites: the national and regional parks the
 *  Italian AIP regulates with a minimum overflight height, which OFMX
 *  files as airspace and cmd/it splits back out. */
export const IT_NATURE_URL = '/data/it-nature.json';
export const IT_NATURE_NEXT_URL = '/data/it-nature.next.json';

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

/** Fetch + decode fr-nature.json; returns [] (with a console warning) on any
 *  fetch / content-type error so a missing dataset degrades quietly. */
export async function loadNature(url: string = NATURE_URL): Promise<Nature[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawNature;
	return data.rows.map(rowToNature);
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
