/* Canonical vertical-limit handling: the one datum-aware type every
 * altitude comparison and display goes through (docs/vertical-limits.md).
 *
 * Aviation vertical limits are published against three datums that are not
 * mutually comparable without context:
 *   - AMSL: altitude above mean sea level (QNH); AIXM code ALT.
 *   - AGL:  height above the surface (SIA: ASFC); AIXM code HEI. The true
 *           AMSL value varies with the ground under the zone.
 *   - STD:  pressure altitude (flight level, 1013.25 hPa); AIXM code STD.
 * plus the sentinels SFC / GND (the surface itself) and UNL (no ceiling).
 *
 * Conversion policy:
 *   - FL compares as feet x100: the standard-atmosphere approximation, off
 *     by the day's QNH (about 28 ft/hPa). Uniform and documented; never
 *     refined here.
 *   - AGL compares exactly only when the caller supplies the ground
 *     elevation at the evaluation point. Without it the role-conservative
 *     endpoints apply: a floor uses its minimum plausible AMSL value (the
 *     published height itself, since ground >= 0) and a ceiling is
 *     unbounded, so datum uncertainty can never hide a zone someone might
 *     be inside.
 *   - Stored data never mutates; conversion happens in the predicates. */

/** An AIXM [code, value, uom] vertical-limit triple as emitted by the Go
 *  pipelines. Codes: STD (flight level), ALT (AMSL), HEI (above surface),
 *  SFC (surface), UNL (unlimited), '' (reference dropped upstream). */
export type VerticalLimit = [string, string, string];

/** Feet per metre (ES airspace rows and NOTAM items publish metric limits). */
const FT_PER_M = 3.28084;

export interface VLimit {
	/** Comparison value in feet IN ITS OWN DATUM: FL x100, metres converted,
	 *  Infinity when `unl`. Never compare directly against another datum;
	 *  go through the endpoint helpers. */
	ft: number;
	/** Datum the published value is referenced to. UNKNOWN (reference
	 *  dropped upstream or unstated) compares as AMSL and displays bare. */
	ref: 'AMSL' | 'AGL' | 'STD' | 'UNKNOWN';
	/** Published numeric value in its own unit, for display ("FL 085"
	 *  keeps 85, "600 m AMSL" keeps 600). Infinity when `unl`, 0 when
	 *  `sfc`. */
	value: number;
	/** Published unit; '' for the sentinels. */
	unit: 'ft' | 'm' | 'FL' | '';
	/** Published as unlimited (UNL). */
	unl?: true;
	/** Published as the surface (SFC / GND / HEI 0). */
	sfc?: true;
}

const UNL_LIMIT: VLimit = { ft: Infinity, ref: 'STD', value: Infinity, unit: '', unl: true };
const SFC_LIMIT: VLimit = { ft: 0, ref: 'AGL', value: 0, unit: '', sfc: true };

export interface FromTripleOpts {
	/** Normalize the legacy unlimited encoding STD 999 / 9999 FL to UNL.
	 *  On for fr / faa / pruatlas rows, where FL999 is the encoding
	 *  convention for "unlimited", not a real level. Off for supaip (its
	 *  historic fabricated FL660 is indistinguishable from a genuinely
	 *  printed FL660 and is fixed at the source instead) and for uk / es
	 *  (their legacy datasets encode UNL as null, unknowable at load). */
	legacyFl999Unl?: boolean;
}

/** Parse a dataset triple into the canonical limit. Returns null for a
 *  missing limit (null triple or unparseable value). */
export function fromTriple(
	triple: VerticalLimit | null | undefined,
	opts?: FromTripleOpts,
): VLimit | null {
	if (!triple) {
		return null;
	}
	const [code, val, uom] = triple;
	if (code === 'UNL') {
		return UNL_LIMIT;
	}
	if (code === 'SFC' || (code === 'HEI' && (val === '0' || val === ''))) {
		return SFC_LIMIT;
	}
	const n = parseFloat(val);
	if (Number.isNaN(n)) {
		return null;
	}
	if (uom === 'FL') {
		if (opts?.legacyFl999Unl && (n === 999 || n === 9999)) {
			return UNL_LIMIT;
		}
		return { ft: n * 100, ref: 'STD', value: n, unit: 'FL' };
	}
	const metres = uom === 'M';
	const ref =
		code === 'HEI' ? 'AGL'
		: code === 'ALT' ? 'AMSL'
		: code === 'STD' ? 'STD'
		: 'UNKNOWN';
	return {
		ft: metres ? n * FT_PER_M : n,
		ref,
		value: n,
		unit: metres ? 'm' : 'ft',
	};
}

/* NOTAM item F) / G) grammar, per OPADD: SFC | GND | UNL | FL nnn |
 * <n> FT/M [AMSL|MSL|AGL|ASFC|SFC]. A bare "5000FT" defaults to AMSL
 * (ICAO Doc 8126 convention). The value+unit rule runs first so an ASFC
 * suffix is consumed before the bare SFC sentinel could match. */
const NOTAM_VALUE_RE = /(\d{1,5}(?:\.\d+)?)\s*(FT|M)\b\s*(AMSL|MSL|AGL|ASFC|SFC)?/i;
const NOTAM_FL_RE = /\bFL\s*(\d{1,3})\b/i;
const NOTAM_UNL_RE = /\bUNL(?:TD|IMITED)?\b/i;
const NOTAM_SFC_RE = /\b(?:SFC|GND)\b/i;

/** Parse one NOTAM F) or G) item into the canonical limit. Returns null
 *  when no limit grammar matches (the coarse Q-line band then applies). */
export function fromNotamLimit(text: string | null | undefined): VLimit | null {
	if (!text) {
		return null;
	}
	const m = NOTAM_VALUE_RE.exec(text);
	if (m) {
		const n = parseFloat(m[1]);
		const metres = m[2].toUpperCase() === 'M';
		const refWord = (m[3] ?? '').toUpperCase();
		const agl = refWord === 'AGL' || refWord === 'ASFC' || refWord === 'SFC';
		return {
			ft: metres ? n * FT_PER_M : n,
			ref: agl ? 'AGL' : 'AMSL',
			value: n,
			unit: metres ? 'm' : 'ft',
		};
	}
	const fl = NOTAM_FL_RE.exec(text);
	if (fl) {
		const n = parseInt(fl[1], 10);
		return { ft: n * 100, ref: 'STD', value: n, unit: 'FL' };
	}
	if (NOTAM_UNL_RE.test(text)) {
		return UNL_LIMIT;
	}
	if (NOTAM_SFC_RE.test(text)) {
		return SFC_LIMIT;
	}
	return null;
}

/** Minimum plausible AMSL feet of a FLOOR. AGL floors sit at height + ground
 *  (>= the height itself); with the ground unknown the height is the
 *  conservative minimum, so a zone is never hidden by datum uncertainty. */
export function floorMinFt(l: VLimit, groundFt?: number | null): number {
	if (l.ref === 'AGL') {
		return l.ft + (groundFt ?? 0);
	}
	return l.ft;
}

/** Maximum plausible AMSL feet of a CEILING. An AGL ceiling with the ground
 *  unknown is unbounded (conservative: the zone may top out anywhere above
 *  the published height); UNL is always unbounded. */
export function ceilingMaxFt(l: VLimit, groundFt?: number | null): number {
	if (l.unl) {
		return Infinity;
	}
	if (l.ref === 'AGL') {
		return groundFt != null ? l.ft + groundFt : Infinity;
	}
	return l.ft;
}

/** Exact AMSL feet of a limit at a point whose ground elevation is known;
 *  null when the limit is AGL and the ground is not. */
export function exactFt(l: VLimit, groundFt: number | null): number | null {
	if (l.unl) {
		return Infinity;
	}
	if (l.ref === 'AGL') {
		return groundFt != null ? l.ft + groundFt : null;
	}
	return l.ft;
}

/** A vertical band in feet; -Infinity / Infinity mark unbounded sides. */
export interface FtBand {
	floor: number;
	ceiling: number;
}

/** How much of a volume's vertical extent the publisher stated.
 *
 *  Three states, not two, because a volume with a published floor and no
 *  ceiling is a different thing from one with neither: the first is
 *  "from 3000 ft upwards, top unstated", the second is "somewhere in
 *  this outline". Every consumer used to decide this for itself and they
 *  disagreed (`||` in the alert evaluator, `&&` in the route profile),
 *  so one FAA class-E shelf was "known, unlimited ceiling" to the banner
 *  and "unknown, never a crossing" to the profile. */
export type VExtent = 'known' | 'open' | 'unknown';

/** Classify a limit pair. Callers that must not overstate what the AIP
 *  said test for `'known'`; callers deciding whether the volume can be
 *  evaluated at all test for `!== 'unknown'`. */
export function vExtent(lower: VLimit | null, upper: VLimit | null): VExtent {
	if (lower && upper) {
		return 'known';
	}
	if (lower || upper) {
		return 'open';
	}
	return 'unknown';
}

/** Conservative band-overlap predicate: does the [lower, upper] limit pair
 *  possibly intersect the filter band? A missing side is unbounded; AGL
 *  limits use their conservative endpoints unless `groundFt` is given. */
export function bandIntersects(
	lower: VLimit | null,
	upper: VLimit | null,
	band: FtBand,
	groundFt?: number | null,
): boolean {
	const lo = lower ? floorMinFt(lower, groundFt) : -Infinity;
	const hi = upper ? ceilingMaxFt(upper, groundFt) : Infinity;
	return lo <= band.ceiling && hi >= band.floor;
}

/** The NOTAM's vertical band in feet for filtering, per the OPADD
 *  precedence: the operational F) / G) items win when either parsed; else
 *  the Q-line FL band (x100) applies with its conventions (000 = from the
 *  surface, 999 = unlimited or unknown, unbounded for matching); else null
 *  (no vertical statement: never filter on it). */
export function notamBandFt(
	fgLower: VLimit | null,
	fgUpper: VLimit | null,
	qualifier: { lower: number; upper: number } | null,
): FtBand | null {
	if (fgLower || fgUpper) {
		return {
			floor: fgLower ? floorMinFt(fgLower) : -Infinity,
			ceiling: fgUpper ? ceilingMaxFt(fgUpper) : Infinity,
		};
	}
	if (
		qualifier &&
		Number.isFinite(qualifier.lower) &&
		Number.isFinite(qualifier.upper)
	) {
		return {
			// 999 is "unlimited or unknown" on EITHER side: a 999 lower must
			// stay unbounded for matching, not become a 99 900 ft floor.
			floor: qualifier.lower === 999 ? -Infinity : qualifier.lower * 100,
			ceiling: qualifier.upper === 999 ? Infinity : qualifier.upper * 100,
		};
	}
	return null;
}

/** Format a limit for display, SIA vocabulary: "2500 ft AMSL",
 *  "800 ft ASFC", "600 m AMSL", "FL 085", "SFC", "UNL"; an unknown
 *  reference renders bare ("12500 ft"). Empty string for a missing limit. */
export function formatVLimit(l: VLimit | null): string {
	if (!l) {
		return '';
	}
	if (l.unl) {
		return 'UNL';
	}
	if (l.sfc) {
		return 'SFC';
	}
	if (l.unit === 'FL') {
		return 'FL ' + String(l.value).padStart(3, '0');
	}
	let s = String(l.value);
	if (l.unit) {
		s += ' ' + l.unit;
	}
	if (l.ref === 'AGL') {
		s += ' ASFC';
	} else if (l.ref === 'AMSL') {
		s += ' AMSL';
	}
	return s;
}
