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

/** Top elevation (ft AMSL) keyed by a summit, top or elevation wording:
 *  FR "ALT(ITUDE) (AU) SOMMET : 542 FT" / "SOMMET : 165 M" / "ALT
 *  SOMMITALE : 305FT" / "ALTITUDE: 822FT" in the middle of a line (P4074/26),
 *  EN "ELEV : 693FT" / "ELEV 957FT" / "TOP ELEV(ATION) 1650 FT". An
 *  aerodrome's, a threshold's or a runway's elevation is not the
 *  obstacle's, and an elevation stated AGL is a height, as is the summit
 *  of "HAUTEUR DU SOMMET" or "HAUTEUR AU SOMMET" (P2594/26). */
const TOP_RE =
	/(?:(?<!(?:\bDU|HAUTEUR\s+AU)\s)SOMMET|SOMMITALE|\bALTITUDE|(?<!\b(?:AD|ARP|THR|DTHR|RWY) )\bELEV(?:ATION)?(?:\s+AMSL)?)(?:\s+MAX(?:IMALE|IMUM)?)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(FT|M)\b(?!\s*(?:AGL|ASFC|GND|SOL)\b)/g;

/** The French top written as a bare altitude on a line of its own, "ALT :
 *  3953FT" where the English says "ELEV : 3953FT" (P1077/26). Anchored, so
 *  an altitude in prose stays out. */
const TOP_LINE_RE = /^[\s.-]*ALT(?:ITUDE)?\.?(?:\s+MAX(?:IMALE)?)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(FT|M)\b/gm;

/** Height above ground: FR "HAUTEUR (MAX) : 45 M" / "HAUT : 312FT" /
 *  "HAUTEUR DU SOMMET : 16M" / "HAUTEUR AU SOMMET :30M", EN "HEIGHT/HGT
 *  350 FT", plus the bare "350 FT AGL" / "107 M SOL" forms. A height ABOVE
 *  SLOPE is measured from the slope of a take-off surface rather than the
 *  ground ("ESTIMATED HGT : 20M ABOVE SLOPE", P4299/26), and stays out. */
const HGT_KEYED_RE =
	/\b(?:HAUTEUR(?:\s+[AD]U\s+SOMMET)?|HAUT|HEIGHT|HGT)\.?\s*(?:MAX(?:IMALE|IMUM)?)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*(FT|M)\b(?!\s*ABOVE\s+(?:THE\s+)?SLOPE\b)/g;
const HGT_AGL_RE = /(\d+(?:[.,]\d+)?)\s*(FT|M)\s*(?:AGL|ASFC|SOL)\b/g;

function toFt(value: string, unit: string): number {
	const v = Number(value.replace(',', '.'));
	return Math.round(unit === 'M' ? v * FT_PER_M : v);
}

function maxMatch(text: string, ...res: RegExp[]): number | null {
	let max: number | null = null;
	for (const re of res) {
		re.lastIndex = 0;
		for (const m of text.matchAll(re)) {
			const ft = toFt(m[1], m[2]);
			if (Number.isFinite(ft) && (max == null || ft > max)) {
				max = ft;
			}
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
	return { topFt: maxMatch(text, TOP_RE, TOP_LINE_RE), hgtFt };
}
