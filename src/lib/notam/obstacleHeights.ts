/* Obstacle top / height extraction from NOTAM E) text, for the vertical
 * profile's temporary obstacle marks. Obstacle NOTAMs (crane erected, wind
 * turbine, mast...) rarely carry F)/G) items; the numbers live in the free
 * text, in French ("HAUTEUR : 45M", "ALT AU SOMMET : 542FT") or English
 * ("HEIGHT 350FT AGL", "TOP ELEVATION 1650FT AMSL"). Language-invariant by
 * the bilingual rule: both grammars parse to the same numbers.
 *
 * Multi-obstacle NOTAMs (a wind farm listing several machines) often state
 * several figures; the extractor keeps the MAXIMUM of each kind, the
 * conservative reading for a clearance chart. */

const FT_PER_M = 3.28084;

/** Top elevation (ft AMSL) keyed by an explicit summit/top wording:
 *  FR "ALT(ITUDE) (AU) SOMMET : 542 FT" / "SOMMET : 165 M",
 *  EN "TOP ELEV(ATION) 1650 FT" / "SUMMIT ELEV 1650 FT". */
const TOP_RE =
	/(?:ALT(?:ITUDE)?\s+(?:AU\s+)?SOMMET|SOMMET|TOP\s+ELEV(?:ATION)?|SUMMIT\s+ELEV(?:ATION)?)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(FT|M)\b/g;

/** Height above ground: FR "HAUTEUR (MAX) : 45 M", EN "HEIGHT/HGT 350 FT",
 *  plus the bare "350 FT AGL" / "107 M SOL" forms. */
const HGT_KEYED_RE =
	/(?:HAUTEUR|HEIGHT|HGT)\s*(?:MAX(?:IMALE|IMUM)?)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(FT|M)\b/g;
const HGT_AGL_RE = /(\d+(?:[.,]\d+)?)\s*(FT|M)\s*(?:AGL|ASFC|SOL)\b/g;

function toFt(value: string, unit: string): number {
	const v = Number(value.replace(',', '.'));
	return Math.round(unit === 'M' ? v * FT_PER_M : v);
}

function maxMatch(text: string, re: RegExp): number | null {
	let max: number | null = null;
	re.lastIndex = 0;
	for (const m of text.matchAll(re)) {
		const ft = toFt(m[1], m[2]);
		if (Number.isFinite(ft) && (max == null || ft > max)) {
			max = ft;
		}
	}
	return max;
}

/** The tallest stated top elevation (ft AMSL) and height (ft AGL) in an
 *  obstacle NOTAM's text; null when the text states none. The two are
 *  independent: a NOTAM can give either, both, or neither. */
export function extractObstacleHeights(text: string): {
	topFt: number | null;
	hgtFt: number | null;
} {
	const keyed = maxMatch(text, HGT_KEYED_RE);
	const agl = maxMatch(text, HGT_AGL_RE);
	const hgtFt =
		keyed == null && agl == null ? null : Math.max(keyed ?? -Infinity, agl ?? -Infinity);
	return { topFt: maxMatch(text, TOP_RE), hgtFt };
}
