import { NM_TO_KILOMETERS, NM_TO_METERS } from './units';
import type { AirportAnchor, LatLon, RadiusUnit } from './types';

export interface RadiusInfo {
	radius: number;
	radiusUnit: RadiusUnit;
}

function normaliseUnit(raw: string): RadiusUnit {
	const u = raw.toUpperCase();
	return u === 'METRES' || u === 'METRE' ? 'M' : (u as RadiusUnit);
}

/**
 * Extract radius info from the text surrounding a coordinate match in the E)
 * section. Handles a range of English and French phrasings.
 */
export function extractRadiusFromText(
	eContent: string,
	matchStart: number,
	matchEnd: number,
): RadiusInfo | null {
	// Look after the coordinate: "RADIUS [:] <num><unit>" / "[WITH[IN]]
	// [CIRCLE OF] <num><unit> RADIUS" ("PSN : ... RADIUS : 1NM", "PSN MOY :
	// ... WITHIN 330M RADIUS", "PSN : ... CIRCLE OF 3NM RADIUS").
	const afterText = eContent.substring(matchEnd, matchEnd + 50);
	const afterMatch = afterText.match(
		/^\s+RADIUS\s*:?\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i,
	);
	if (afterMatch) {
		return {
			radius: parseFloat(afterMatch[1].replace(',', '.')),
			radiusUnit: afterMatch[2].toUpperCase() as RadiusUnit,
		};
	}
	const afterMatch2 = afterText.match(
		/^\s+(?:WITH(?:IN)?\s+(?:A\s+)?|CIRCLE\s+OF\s+(?:A\s+)?)?(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS\b/i,
	);
	if (afterMatch2) {
		return {
			radius: parseFloat(afterMatch2[1].replace(',', '.')),
			radiusUnit: afterMatch2[2].toUpperCase() as RadiusUnit,
		};
	}

	// French: "[- ]?[DANS UN ]?RAYON [:|DE] <num><unit>" after the coord.
	const afterMatchFr = afterText.match(
		/^\s+[-*]?\s*(?:DANS\s+(?:UN\s+)?)?RAYON\s*(?::|DE\s+)\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i,
	);
	if (afterMatchFr) {
		return {
			radius: parseFloat(afterMatchFr[1].replace(',', '.')),
			radiusUnit: normaliseUnit(afterMatchFr[2]),
		};
	}

	// French elision: "RAYON D'<WORD> DE <num><unit>" after the coord.
	const afterMatchElision = afterText.match(
		/^\s+(?:AVEC\s+(?:UN\s+)?)?RAYON\s+D['][A-Z]+\s+DE\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i,
	);
	if (afterMatchElision) {
		return {
			radius: parseFloat(afterMatchElision[1].replace(',', '.')),
			radiusUnit: normaliseUnit(afterMatchElision[2]),
		};
	}

	// French: "RAYON <num><unit>" with no separator.
	const afterMatchBare = afterText.match(
		/^[\s,]+(?:DANS\s+)?RAYON\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i,
	);
	if (afterMatchBare) {
		return {
			radius: parseFloat(afterMatchBare[1].replace(',', '.')),
			radiusUnit: normaliseUnit(afterMatchBare[2]),
		};
	}

	// Look before the coordinate (up to 50 chars), but never past an earlier
	// coordinate: a radius phrase bound to THAT one must not leak onto this
	// one ("ARC HORAIRE DE 0.8NM DE RAYON CENTRE SUR <centre>, <vertex>"
	// used to give the vertex the arc's radius).
	let beforeText = eContent.substring(Math.max(0, matchStart - 50), matchStart);
	const prevCoord = [
		...beforeText.matchAll(
			/\d{4,7}(?:[.,]\d+)?\s*[NS]\s*,?\s*\d{5,8}(?:[.,]\d+)?\s*[EW]/gi,
		),
	].pop();
	if (prevCoord) {
		beforeText = beforeText.slice(prevCoord.index + prevCoord[0].length);
	}

	// "<num><unit> RADIUS [OF|CENTRED ON/AT]".
	const beforeMatch1 = beforeText.match(
		/(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS\b/i,
	);
	if (beforeMatch1) {
		return {
			radius: parseFloat(beforeMatch1[1].replace(',', '.')),
			radiusUnit: beforeMatch1[2].toUpperCase() as RadiusUnit,
		};
	}

	// "RADIUS <num><unit> [CENTRE/CENTRED/CENTER/CENTERED ON/AT]".
	const beforeMatch2 = beforeText.match(
		/\bRADIUS\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i,
	);
	if (beforeMatch2) {
		return {
			radius: parseFloat(beforeMatch2[1].replace(',', '.')),
			radiusUnit: beforeMatch2[2].toUpperCase() as RadiusUnit,
		};
	}

	// French: "<num><unit> DE RAYON".
	const beforeMatch3 = beforeText.match(
		/(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+DE\s+RAYON\b/i,
	);
	if (beforeMatch3) {
		return {
			radius: parseFloat(beforeMatch3[1].replace(',', '.')),
			radiusUnit: beforeMatch3[2].toUpperCase() as RadiusUnit,
		};
	}

	// French: "RAYON DE <num><unit>" / "RAYON : <num><unit>".
	const beforeMatch4 = beforeText.match(
		/\bRAYON\s*(?::|DE\s+)\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\b/i,
	);
	if (beforeMatch4) {
		return {
			radius: parseFloat(beforeMatch4[1].replace(',', '.')),
			radiusUnit: beforeMatch4[2].toUpperCase() as RadiusUnit,
		};
	}

	// French: "RAYON <num><unit>" with no separator.
	const beforeMatch5 = beforeText.match(
		/\bRAYON\s+(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i,
	);
	if (beforeMatch5) {
		return {
			radius: parseFloat(beforeMatch5[1].replace(',', '.')),
			radiusUnit: normaliseUnit(beforeMatch5[2]),
		};
	}

	// "CERCLE DE <num><unit> CENTRE SUR" / "CIRCLE OF <num><unit> CENTRED
	// ON": the circle stated without the word RAYON/RADIUS at all
	// ("CERCLE DE 2NM CENTRE SUR 462131N 0063859E", R1651/26).
	const beforeCircle = beforeText.match(
		/\b(?:CERCLE\s+DE|CIRCLE\s+OF)\s+(?:A\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+CENT(?:ER|RE)E?D?\s+(?:SUR|ON|AT)\b/i,
	);
	if (beforeCircle) {
		return {
			radius: parseFloat(beforeCircle[1].replace(',', '.')),
			radiusUnit: normaliseUnit(beforeCircle[2]),
		};
	}

	// Fallback: French obstacle NOTAMs put the radius in the E-section preamble
	// ("... DANS UN RAYON DE 96M AUTOUR DU PSN ..."). The "AUTOUR" suffix
	// anchors this to a single PSN, so applying it across the NOTAM is safe.
	const preamble = eContent.match(
		/\bDANS\s+(?:UN\s+)?RAYON\s+(?:DE\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\s+AUTOUR\b/i,
	);
	if (preamble) {
		return {
			radius: parseFloat(preamble[1].replace(',', '.')),
			radiusUnit: normaliseUnit(preamble[2]),
		};
	}

	// English twin of the preamble rule: the radius phrase anchored to the
	// position by name rather than adjacency ("WITHIN A 5NM RADIUS AROUND
	// 'CHALONS' AD", "0.11NM RADIUS CIRCLE AROUND PSN", "01NM RADIUS CIRCLE
	// CENTRED ON PSN"). The PSN / quoted-name requirement keeps it off
	// "CENTRED ON <coordinates>" texts, whose radius binds locally.
	const enPreamble = eContent.match(
		/\b(?:WITHIN\s+)?(?:A\s+)?(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+RADIUS(?:\s+CIRCLE)?\s+(?:AROUND|CENT(?:ER|RE)E?D?\s+ON)\s*(?:PSN\b|')/i,
	);
	if (enPreamble) {
		return {
			radius: parseFloat(enPreamble[1].replace(',', '.')),
			radiusUnit: enPreamble[2].toUpperCase() as RadiusUnit,
		};
	}

	// Diameter (helipad FATO circles): halve it for the equivalent radius.
	const diameter = eContent.match(
		/\bDIAMET(?:RE|ER)\s*(?::|DE\s+)?\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|METRES?|M)\b/i,
	);
	if (diameter) {
		return {
			radius: parseFloat(diameter[1].replace(',', '.')) / 2,
			radiusUnit: normaliseUnit(diameter[2]),
		};
	}

	return null;
}

/** Convert a radius in the given unit to nautical miles. */
export function radiusToNM(radius: number, unit: RadiusUnit): number {
	if (unit === 'KM') {
		return radius / NM_TO_KILOMETERS;
	}
	if (unit === 'M') {
		return radius / NM_TO_METERS;
	}
	return radius;
}

/**
 * Extract an airport-anchored position spec from the E section, e.g.
 * "RDL 031/5.4NM ARP LFAI"; bearing 31°, 5.4 NM from the airport reference
 * point of LFAI. Used as a fallback when no DMS coord is present. Real
 * briefings also write "RDL : 268DEG/1.24NM ARP LFDB" (label colon) and
 * "RDL220DE/0.22NM ARP LFBJ" (truncated DEG), both accepted.
 */
export function extractAirportAnchor(eContent: string): AirportAnchor | null {
	const m = eContent.match(
		/\bRDL\s*:?\s*(\d{1,3})(?:DEG?)?\s*\/\s*(\d+(?:[.,]\d+)?)\s*(NM|KM|M)\s+ARP\s+([A-Z]{4})\b/i,
	);
	if (!m) {
		return null;
	}
	return {
		bearing: parseFloat(m[1]),
		distance: parseFloat(m[2].replace(',', '.')),
		distanceUnit: m[3].toUpperCase() as RadiusUnit,
		ident: m[4].toUpperCase(),
	};
}

/**
 * Move `distance` along true bearing `bearing` from an airport coord. Planar
 * approximation; good to ~50 m at the few-NM scale of RDL specs.
 */
export function computeAirportAnchoredPosition(
	anchor: AirportAnchor,
	airportCoord: LatLon,
): LatLon {
	const dist =
		anchor.distance *
		(anchor.distanceUnit === 'NM'
			? NM_TO_METERS
			: anchor.distanceUnit === 'KM'
				? 1000
				: 1);
	const bearingRad = (anchor.bearing * Math.PI) / 180;
	const dy = dist * Math.cos(bearingRad);
	const dx = dist * Math.sin(bearingRad);
	const M_PER_DEG = 111320;
	const cosLat = Math.cos((airportCoord.lat * Math.PI) / 180);
	return {
		lat: airportCoord.lat + dy / M_PER_DEG,
		lon: airportCoord.lon + dx / (cosLat * M_PER_DEG),
	};
}
