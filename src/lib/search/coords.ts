/* A position typed into the search (docs/search.md "Coordinates"): the forms
 * a pilot copies from a chart, a NOTAM, a GPS or a phone's map, read as a
 * place to go to. Never at an identifier's expense: the palette lists the
 * position beside every other result, since 144 FAA idents begin with N or
 * S and a digit. Pure. */

import type { LatLon } from '$lib/notam/types';
import { parseCoordToken } from '$lib/route/coordToken';
import { TIER } from './match';
import { CLASS, KIND, type Ranked } from './rank';

/** A typed position, or null. Tried in turn:
 *  - a signed decimal pair split by blanks, a point or a comma for the
 *    decimals ("48.82 2.62", "48,82 2,62", "48,8 2"), read before the
 *    blanks are taken out, which would join "48,8 2" into the token 48,82.
 *  - the route field's tokens with the spaces taken out: packed
 *    ("N4849E00237", "484912N 0023712E"), Garmin ("N48,8200/E2,62000") and
 *    signed decimal ("48.82, 2.62").
 *  - one hemisphere letter per axis, all before or all after its figures,
 *    in decimal degrees or with degree, minute and second marks
 *    ("48.82N 2.62E", "N 48° 49.2' E 002° 37.2'", "48°49'12"N 002°37'12"E"). */
export function parseCoordQuery(text: string): LatLon | null {
	const s = text.trim();
	if (!s) {
		return null;
	}
	return decimalPair(s) ?? parseCoordToken(s.replace(/\s+/g, '')) ?? hemispherePair(s);
}

/** The palette's row for a typed position: one hit, or none. */
export function rankCoords(text: string): Ranked<LatLon> {
	const p = parseCoordQuery(text);
	if (!p) {
		return { hits: [], total: 0 };
	}
	return { hits: [{ item: p, tier: TIER.IDENT_EXACT, cls: CLASS.OPEN, dist: 0, kind: KIND.place, order: '' }], total: 1 };
}

function num(s: string): number {
	return parseFloat(s.replace(',', '.'));
}

function inRange(lat: number, lon: number): LatLon | null {
	if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
		return null;
	}
	return { lat, lon };
}

// Two whole numbers ("12 34") are a query, never a position: one of the
// pair must carry decimals.
const PAIR_RE = /^([+-]?\d{1,2}(?:[.,]\d+)?)\s+([+-]?\d{1,3}(?:[.,]\d+)?)$/;

function decimalPair(s: string): LatLon | null {
	const m = PAIR_RE.exec(s);
	if (!m || !/[.,]/.test(m[1] + m[2])) {
		return null;
	}
	return inRange(num(m[1]), num(m[2]));
}

// One axis's figures: degrees, then minutes and seconds behind their marks.
const AXIS_RE = /^(\d+(?:[.,]\d+)?)\s*(?:[°º]\s*(?:(\d+(?:[.,]\d+)?)\s*['′’]\s*(?:(\d+(?:[.,]\d+)?)\s*(?:["″”]|''))?)?)?$/;

/** An axis's degrees, or null: minutes follow whole degrees, seconds whole
 *  minutes, and each stays under sixty. */
function axisDegrees(text: string): number | null {
	const m = AXIS_RE.exec(text.trim());
	if (!m) {
		return null;
	}
	const deg = num(m[1]);
	if (m[2] === undefined) {
		return deg;
	}
	const min = num(m[2]);
	const sec = m[3] === undefined ? 0 : num(m[3]);
	if (!Number.isInteger(deg) || min >= 60 || sec >= 60 || (m[3] !== undefined && !Number.isInteger(min))) {
		return null;
	}
	return deg + min / 60 + sec / 3600;
}

// Between the two axes: blanks, a comma, a semicolon or a slash.
const EDGE_RE = /^[\s,;/]+|[\s,;/]+$/g;

function hemispherePair(s: string): LatLon | null {
	const at = [...s.matchAll(/[NSEW]/gi)].map((m) => m.index);
	if (at.length !== 2) {
		return null;
	}
	// The letters lead their axes ("N48.82 E2.62") or close them ("48.82N 2.62E").
	let parts: string[];
	if (at[0] === 0) {
		parts = [s.slice(0, at[1]), s.slice(at[1])];
	} else if (at[1] === s.length - 1) {
		parts = [s.slice(0, at[0] + 1), s.slice(at[0] + 1)];
	} else {
		return null;
	}
	let lat: number | null = null;
	let lon: number | null = null;
	for (const part of parts) {
		const p = part.replace(EDGE_RE, '');
		const lead = at[0] === 0;
		const letter = (lead ? p[0] : p[p.length - 1]).toUpperCase();
		const v = axisDegrees(lead ? p.slice(1) : p.slice(0, -1));
		if (v === null) {
			return null;
		}
		if (letter === 'N' || letter === 'S') {
			if (lat !== null) {
				return null;
			}
			lat = letter === 'S' ? -v : v;
		} else {
			if (lon !== null) {
				return null;
			}
			lon = letter === 'W' ? -v : v;
		}
	}
	return lat === null || lon === null ? null : inRange(lat, lon);
}
