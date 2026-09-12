/* airspaceSymbology.ts is the single source of truth for how every airspace
 * type draws on the map, following the SIA convention of the 1:500 000 OACI
 * chart (AIP France GEN 2.3 "Tableau des signes conventionnels", AMDT 08/25)
 * uniformly across publishers. Each type resolves to:
 *
 *   - a Leaflet polygon stroke (the boundary line: solid / dashed / dotted,
 *     or none when the chart marks the boundary with canvas work alone), and
 *   - a canvas decoration drawn by airspaceDecoLayer.ts: an inside band
 *     (solid tint, the 45-degree boundary hatch fringe, the P crosshatch
 *     chain, the RTBA fringe + pecked strip), boundary marks Leaflet cannot
 *     draw (FIR comb ticks, DLG fine comb, SIV square dots), an activity
 *     glyph, and a designator label.
 *
 * The mapping and colour provenance are documented in
 * docs/airspace-symbology.md. Pure module (leaflet import is type-only) so
 * tests/airspaceSymbology.spec.ts can table-test the full mapping in node. */

import type { PathOptions } from 'leaflet';
import type { Airspace } from '$lib/data/airspaces';
import { fromTriple } from '$lib/vertical/limits';
import { AEM_BAND, DARK, SIA } from './palette';

// The inks live in palette.ts (the chart-palette single source of truth);
// re-exported here so the mapping's consumers and specs keep their
// established import surface.
export { AEM_BAND, SIA };

export type BandKind = 'solid' | 'hatch' | 'cross' | 'hatchPecked';
export type MarkKind = 'comb' | 'fineComb' | 'squareDots';
export type GlyphKind =
	| 'parachute'
	| 'aerobatics'
	| 'glider'
	| 'paraglider'
	| 'balloon'
	| 'modelAircraft'
	| 'drone'
	| 'generic';

interface LineSpec {
	color: string;
	weight: number;
	dashArray?: string;
	lineCap?: 'butt' | 'round';
}

export interface BandSpec {
	kind: BandKind;
	color: string;
	/** On-screen band depth in css px: the tint-band width for `solid`, the
	 *  fringe stroke length for `hatch` / `cross` / `hatchPecked`. */
	widthPx: number;
}

export interface SymbolSpec {
	/** Leaflet boundary stroke; null renders the polygon strokeless (CTR,
	 *  SIV, DLG-ATS: the chart marks those boundaries with the band / dots /
	 *  comb alone). */
	line: LineSpec | null;
	band: BandSpec | null;
	/** Canvas boundary marks (FIR comb, DLG fine comb, SIV squares). */
	marks: { kind: MarkKind; color: string } | null;
	glyph: GlyphKind | null;
	/** Family colour for the designator label (and the tiny-zone cross). */
	labelColor: string;
	/** Draw the GEN 2.3 "tres petite zone" rubine + when the zone is too
	 *  small on screen for its band / glyph to read. */
	crossEligible: boolean;
	/** Per-channel zoom gates (map zoom must be >= the gate to draw). */
	minZoom: { band: number; marks: number; glyph: number; label: number };
}

/* Calibration constants. Band widths, dashes, alphas and gates are tuned
 * against reference crops of the 500k chart (recipes in
 * docs/airspace-symbology.md); keep them together so a recalibration is one
 * diff.
 *
 * LINE WEIGHTS come from the production chart, not the legend: the legend
 * exaggerates its thin-line samples about 2x (TMA edge prints 9 px in the
 * legend but ~4.9 px on the chart scan at 600 dpi, both with ~47 px bands),
 * while its CTR (19 px vs chart 15-18) and band widths print true. At the
 * established 0.2 chart-px -> css-px anchor: controlled edges 1.0 (chart
 * 4.9), R / D / P borders 1.2 (chart 5-6.5), CTR dash weight 3 (chart
 * 15-18), RMZ / TMZ 2 (chart 8.5-10, i.e. 0.6x CTR, not the legend's 1x),
 * thin en-route / activity lines 1.0. */
/** The chart's band prints ~1.95 mm (46 px at 600 dpi) = 9.7 css px at the
 *  z10 anchor; drawn ~10 % under it (with the controlled edge weight):
 *  screen antialiasing and emissive rendering read bolder than print
 *  (user-calibrated against the paper chart). */
const BAND_SOLID_PX = 9;
/** Class E bands print twice the B/C/D width on the chart (Legende2026
 *  class table: E screen 89 px vs B/C/D 45 px, ratio 1.98); the pale tint
 *  needs the extra width to read. */
const BAND_E_PX = 18;
/** Hatch fringe stroke length (R / D): short 45-degree strokes attached to
 *  the boundary line. */
const BAND_HATCH_PX = 13;
/** Crosshatch fringe stroke length (P): the two diagonal families cross
 *  mid-span into the chart's single diamond-row chain. */
const BAND_CROSS_PX = 11;
/** CTR boundary: the ICAO dashed line on the band's outer edge. The legend
 *  prints it at twice the TMA edge weight with long dashes (118.5 on / 22
 *  off at a 19 px weight, duty 0.84; '21 4' reproduces both). */
const CTR_DASH = '21 4';
/** RTBA inner band: thick solid pecked strip tight on the inside edge
 *  (Legende2026 notch row: 65 on / 15.5 off, ratio 4.2). */
export const RTBA_DASH: [number, number] = [21, 5];
export const RTBA_INNER_PX = 6;
const GATE_HATCH = 5;
const GATE_BAND = 7;
const GATE_BAND_E = 8;
const GATE_COMB = 5;
const GATE_FINE_COMB = 8;
const GATE_SQUARES = 7;
/** Zoom at which the SIA activity pictograms (paraglider / parachute /
 *  balloon / drone / ...) start drawing. natureLayer's bullseye shares this
 *  gate so the sensitive-site / nature-reserve glyphs come in with the
 *  activity glyphs (natureLayer covers the SUR / PRN activity rows). */
export const GATE_GLYPH = 8;
const GATE_LABEL = 9;
const GATE_LABEL_FIR = 5;
const GATE_LABEL_SIV = 8;
const NO_GATE = 99;

/** Growth above the anchor zooms: +20 % per step from z12, capped (the
 *  chart-proportional factor would double per step and overwhelm the map;
 *  this just keeps the boundary structure present at airfield zooms). */
function upperRamp(zoom: number): number {
	return zoom >= 14 ? 1.6 : zoom >= 13 ? 1.4 : zoom >= 12 ? 1.2 : 1;
}

/** Boundary-stroke weight factor per zoom. The symbology is chart-true at
 *  the z10-z11 anchor (the 1:500k chart's 0.21 mm TMA edge there); the
 *  chart equivalent halves per zoom step below, so strokes thin toward it,
 *  floored where sub-half-pixel antialiasing would dissolve the line, and
 *  grow gently above it (upperRamp). */
export function lineZoomFactor(zoom: number): number {
	if (zoom >= 12) {
		return upperRamp(zoom);
	}
	return zoom >= 10 ? 1 : zoom >= 9 ? 0.6 : zoom >= 8 ? 0.45 : 0.4;
}

/** Band / fringe width factor per zoom (same anchor and upper ramp; bands
 *  tolerate a deeper cut below it: the chart-true factor would be 0.5 at
 *  z9 and 0.25 at z8). */
export function bandZoomFactor(zoom: number): number {
	if (zoom >= 12) {
		return upperRamp(zoom);
	}
	return zoom >= 10 ? 1 : zoom >= 9 ? 0.5 : zoom >= 8 ? 0.33 : 0.25;
}

export type SymbolInput = Pick<
	Airspace,
	'type' | 'airClass' | 'subtype' | 'source' | 'id' | 'upper'
>;

function aemBand(a: Pick<Airspace, 'upper'>): keyof typeof AEM_BAND {
	const u = fromTriple(a.upper);
	if (!u || !Number.isFinite(u.ft)) {
		// Missing or UNL ceilings keep the activity family ink.
		return 'high';
	}
	// HEI ceilings are heights ASFC, the band rule's own datum (755 of the
	// fr AER rows; 753 band low). ALT (AMSL) ceilings band on the published
	// number: an upper bound on the height, so the colour can overstate the
	// band but never understate it (metre ceilings convert before banding).
	// The legend's low band is strictly 500 < H <= 1000 with zones at or
	// below 500 ft ASFC not charted at all; a NOTAM viewer draws
	// everything, so those keep the low orange too.
	return u.ft <= 1000 ? 'low' : u.ft <= 2000 ? 'mid' : 'high';
}

/** The Legende2026 height-band colour for an aeromodelling zone. */
export function aemBandColor(a: Pick<Airspace, 'upper'>): string {
	return AEM_BAND[aemBand(a)];
}

/** French RTBA network zones (the GEN 2.3 "R 45 A" symbol: hatch band plus
 *  a thick pecked inner band). The SIA AIXM carries no explicit marker, so
 *  membership is the authoritative AIP France ENR 5.1 list (AIRAC 04/26):
 *  the R-zone families whose penetration conditions defer activation to the
 *  Cartes AZBA, the reseau tres basse altitude timetable (remark
 *  "entrainement tres grande vitesse, tres basse altitude"). */
const RTBA_FAMILIES = new Set([
	45, 46, 56, 57, 69, 139, 142, 143, 144, 145, 147, 149, 152, 165, 166,
	191, 193, 589, 590, 591, 592, 593,
]);

/** True for the RTBA family of a French R-zone id. The FULL number after
 *  LFR is the family (LFR451 is family 451, never a false R 45 match);
 *  sub-zone suffixes still match theirs (LFR45S6.1, LFR149B, LFR166A1). */
export function isRtba(id: string): boolean {
	const m = /^LFR(\d+)/.exec(id);
	return m !== null && RTBA_FAMILIES.has(Number(m[1]));
}

const ACTIVITY_TYPES = new Set([
	'ACTIVITY', 'PARACHUTE', 'PARAGLIDER', 'GLIDER', 'BALLOON', 'TOWING', 'FBZ',
]);

/** Winching subtypes (treuillage planeurs / vol libre): the chart marks
 *  these zones with the word CABLE beside the designator. */
const WINCH_SUBTYPES = new Set(['TRPLA', 'TRVL', 'TRPVL']);

/** True when the chart prints CABLE beside the zone's designator. */
export function isWinchActivity(a: Pick<Airspace, 'subtype'>): boolean {
	return WINCH_SUBTYPES.has(a.subtype);
}

/** Official activity glyph for an activity-family row, or null when the row
 *  must not draw one (SUR / PRN sites are already symbolised by natureLayer's
 *  bullseye; doubling the mark would clutter the chart).
 *
 *  The AIXM txtLocalType in `subtype` routes first: it is the activity
 *  authority for the typed rows too (every PARAGLIDER / GLIDER / TOWING row
 *  is a `*TOW` winch zone carrying its TR* subtype, and LFV926TOW is typed
 *  PARACHUTE while being a vol-libre winch site). The dept-numbered AP rows
 *  ("33-001") are the GEN 2.3-2 drone zones. */
export function activityGlyph(a: SymbolInput): GlyphKind | null {
	switch (a.subtype) {
		case 'AER':
			return 'modelAircraft';
		case 'VOL':
			return 'aerobatics';
		case 'PJE':
			return 'parachute';
		case 'TRPLA':
			return 'glider';
		case 'TRVL':
		case 'TRPVL':
			return 'paraglider';
		case 'BAL':
			return 'balloon';
		case 'AP':
			return 'drone';
		case 'SUR':
		case 'PRN':
			return null;
	}
	switch (a.type) {
		case 'PARACHUTE':
			return 'parachute';
		case 'PARAGLIDER':
		case 'TOWING':
			return 'paraglider';
		case 'GLIDER':
			return 'glider';
		case 'BALLOON':
		case 'FBZ':
			return 'balloon';
	}
	return 'generic';
}

const gates = (
	band: number,
	marks: number,
	glyph: number,
	label: number,
): SymbolSpec['minZoom'] => ({ band, marks, glyph, label });

/** Uncached resolution; see symbolFor for the memoised entry point. */
function resolve(a: SymbolInput): SymbolSpec {
	const none = {
		marks: null,
		glyph: null,
		crossEligible: false,
	};
	switch (a.type) {
		// Restricted family: rubine boundary + inside 45-degree hatch band
		// (GEN 2.3 "R 15" / "D 51"); RTBA zones add the thick pecked inner
		// band ("R 45 A"); P draws the crosshatch band instead. CBA rides
		// the same rule: the Legende2026 files it in the R / D hatch row.
		case 'R':
		case 'D':
		case 'CBA':
		case 'MOA':
		case 'W':
		case 'A':
		case 'TFR':
			return {
				...none,
				line: { color: SIA.zone, weight: 1.2 },
				band: {
					kind: a.type === 'R' && isRtba(a.id) ? 'hatchPecked' : 'hatch',
					color: SIA.zone,
					widthPx: BAND_HATCH_PX,
				},
				labelColor: SIA.zone,
				crossEligible: true,
				minZoom: gates(GATE_HATCH, NO_GATE, NO_GATE, GATE_LABEL),
			};
		case 'P':
			return {
				...none,
				line: { color: SIA.zone, weight: 1.2 },
				band: { kind: 'cross', color: SIA.zone, widthPx: BAND_CROSS_PX },
				labelColor: SIA.zone,
				crossEligible: true,
				minZoom: gates(GATE_HATCH, NO_GATE, NO_GATE, GATE_LABEL),
			};
		// CTR: the ICAO dashed boundary line on the outer edge of a
		// CONTINUOUS blue band (the 500k draws CTR Paris's class A band blue
		// too, so the band is class-independent; only the dash distinguishes
		// CTR from the solid-edged TMA band).
		case 'CTR':
			return {
				...none,
				line: { color: SIA.ctl, weight: 3, dashArray: CTR_DASH },
				band: {
					kind: 'solid',
					color: SIA.ctl,
					widthPx: BAND_SOLID_PX,
				},
				labelColor: SIA.ctl,
				minZoom: gates(GATE_BAND, NO_GATE, NO_GATE, GATE_LABEL),
			};
		// ATZ: blue round-dot ring (Leaflet draws the dots; zero-length dash
		// segments with round caps render as circles).
		case 'ATZ':
			return {
				...none,
				line: { color: SIA.ctl, weight: 2.6, dashArray: '0.1 7', lineCap: 'round' },
				band: null,
				labelColor: SIA.ctl,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
			};
		// Mandatory-equipment zones: soft-ink LONG-SHORT dash alternation
		// (Legende2026: long 65.5 / gap 23 / short 21 / gap 23 at weight 19,
		// in the #3D3D3C layer), interior untouched.
		case 'TMZ':
		case 'RMZ':
		case 'TMZ-RMZ':
			return {
				...none,
				line: { color: SIA.inkSoft, weight: 2, dashArray: '10 4 3 4' },
				band: null,
				labelColor: SIA.inkSoft,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
			};
		case 'ADIZ':
			return {
				...none,
				line: { color: SIA.ink, weight: 2, dashArray: '12 4 2 4 2 4' },
				band: null,
				labelColor: SIA.ink,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
			};
		// TSA prints like TRA: the GEN 2.3 TRA orange line (Belgium
		// publishes TRA/TSA volumes; CBA left this family for the R / D
		// hatch red above).
		case 'TRA':
		case 'TSA':
			return {
				...none,
				line: { color: SIA.tra, weight: 2 },
				band: null,
				labelColor: SIA.tra,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
			};
		// SIV: green square dots along the boundary, nothing else (canvas
		// walker; Leaflet dashes would shear the squares at corners).
		case 'SIV':
			return {
				...none,
				line: null,
				band: null,
				marks: { kind: 'squareDots', color: SIA.siv },
				labelColor: SIA.siv,
				minZoom: gates(NO_GATE, GATE_SQUARES, NO_GATE, GATE_LABEL_SIV),
			};
		// FIR-level FIS sectors (PARIS / MARSEILLE Information + overseas;
		// cmd/fr types them FIC): the chart never prints their limits, which
		// ride the FIR boundaries, so they draw NOTHING at rest and carry no
		// designator label (airspaceLabel). labelColor still matters: the
		// selection-highlight stroke derives its colour from it.
		case 'FIC':
			return {
				...none,
				line: null,
				band: null,
				labelColor: SIA.siv,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, NO_GATE),
			};
		// Delegated airspace: dark-blue fine-tooth comb, no base line.
		case 'DLG-ATS':
			return {
				...none,
				line: null,
				band: null,
				marks: { kind: 'fineComb', color: SIA.dlg },
				labelColor: SIA.dlg,
				minZoom: gates(NO_GATE, GATE_FINE_COMB, NO_GATE, NO_GATE),
			};
		// FIR family (incl. the US centres): thin ink line + inward comb
		// ticks, the 500k FIR boundary.
		case 'FIR':
		case 'UIR':
		case 'OCA':
		case 'ARTCC':
		case 'ACC':
			// The chart prints the FIR limit as a THIN line with sparse
			// alternating stubs (sea-measured on the 2026 Nord-Ouest sheet:
			// ~7 chart px = 1.4 css; the legend swatch is a denser stylised
			// form). The weight feeds both the Leaflet ring stroke and the
			// deco layer's arc line; the stub geometry lives in the deco
			// layer's FIR_LIMIT_* constants.
			return {
				...none,
				line: { color: SIA.ink, weight: 1.4 },
				band: null,
				marks: { kind: 'comb', color: SIA.ink },
				labelColor: SIA.ink,
				minZoom: gates(NO_GATE, GATE_COMB, NO_GATE, GATE_LABEL_FIR),
			};
		// Upper / en-route constructs with no 500k symbol: thin blue line.
		case 'UTA':
		case 'FRA':
		case 'TRSA':
		case 'SATA':
			return {
				...none,
				line: { color: SIA.ctl, weight: 0.85 },
				band: null,
				labelColor: SIA.ctl,
				minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
			};
	}
	// Aerial activities: thin outline + the official glyph, in the chart
	// red; aeromodelling zones take their height-band colour throughout
	// (outline, glyph, designator).
	if (ACTIVITY_TYPES.has(a.type)) {
		const glyph = activityGlyph(a);
		const color = glyph === 'modelAircraft' ? aemBandColor(a) : SIA.zone;
		return {
			line: { color, weight: 1 },
			band: null,
			marks: null,
			glyph,
			labelColor: color,
			// No tiny-zone cross for activities: too small for the glyph
			// means just the thin outline (the cross swarm at wide zooms
			// read as noise; the chart's rubine + stays a P / R / D mark).
			crossEligible: false,
			minZoom: gates(NO_GATE, NO_GATE, GATE_GLYPH, GATE_LABEL),
		};
	}
	// Everything else is controlled airspace banded by ICAO class:
	// A rubine, B/C/D (and classless) blue, E the lighter blue, F/G line-only
	// (TMA / CTA / LTA on the chart; FAA CLASS rows ride the same rule).
	const cls = a.airClass;
	if (cls === 'F' || cls === 'G') {
		return {
			...none,
			line: { color: SIA.ctl, weight: 0.85 },
			band: null,
			labelColor: SIA.ctl,
			minZoom: gates(NO_GATE, NO_GATE, NO_GATE, GATE_LABEL),
		};
	}
	const classA = cls === 'A';
	const classE = cls === 'E';
	return {
		...none,
		line: { color: classA ? SIA.zone : SIA.ctl, weight: 0.85 },
		band: {
			kind: 'solid',
			color: classA ? SIA.zone : classE ? SIA.classE : SIA.ctl,
			widthPx: classE ? BAND_E_PX : BAND_SOLID_PX,
		},
		labelColor: classA ? SIA.zone : SIA.ctl,
		minZoom: gates(classE ? GATE_BAND_E : GATE_BAND, NO_GATE, NO_GATE, GATE_LABEL),
	};
}

// Memoised on the resolution inputs; the key space is tiny (a few dozen
// combinations) while buildAirspaceLayer resolves ~15k rows.
const specCache = new Map<string, SymbolSpec>();

/** The SIA symbol spec for an airspace row (memoised). */
export function symbolFor(a: SymbolInput): SymbolSpec {
	// Aeromodelling rows resolve per height band (the band picks the colour).
	const band = a.subtype === 'AER' ? aemBand(a) : '';
	const key = `${a.type}|${a.airClass}|${a.subtype}|${a.source}|${isRtba(a.id) ? 1 : 0}|${band}`;
	let spec = specCache.get(key);
	if (!spec) {
		spec = resolve(a);
		specCache.set(key, spec);
	}
	return spec;
}

/** Resting Leaflet style: the boundary stroke from the spec, never a fill
 *  (the chart leaves interiors clean; bands and hatches mark the edge). */
export function polygonStyle(a: SymbolInput): PathOptions {
	const spec = symbolFor(a);
	if (!spec.line) {
		return { stroke: false, fill: false, fillOpacity: 0 };
	}
	const style: PathOptions = {
		stroke: true,
		color: spec.line.color,
		weight: spec.line.weight,
		fill: false,
		fillOpacity: 0,
	};
	if (spec.line.dashArray) {
		style.dashArray = spec.line.dashArray;
	}
	if (spec.line.lineCap) {
		style.lineCap = spec.line.lineCap;
	}
	return style;
}

/** Hover / selection style: always stroked (CTR / SIV / DLG rest strokeless)
 *  in the darker family colour, with an interior tint so the selected zone
 *  reads at a glance; FIR-family rows tint barely (region-sized). */
export function polygonHighlightStyle(a: SymbolInput): PathOptions {
	const spec = symbolFor(a);
	const family = spec.line?.color ?? spec.band?.color ?? spec.labelColor;
	const style: PathOptions = {
		stroke: true,
		color: DARK[family] ?? family,
		weight: 3,
		fill: true,
		fillColor: family,
		fillOpacity: spec.marks?.kind === 'comb' ? 0.08 : 0.18,
	};
	if (spec.line?.dashArray) {
		style.dashArray = spec.line.dashArray;
	}
	if (spec.line?.lineCap) {
		style.lineCap = spec.line.lineCap;
	}
	return style;
}

export type LabelInput = Pick<
	Airspace,
	'type' | 'airClass' | 'subtype' | 'source' | 'id' | 'name' | 'workHr' | 'upper'
>;

export interface AirspaceLabel {
	text: string;
	color: string;
	/** ICAO class chip beside controlled-airspace labels. Solid (white letter
	 *  on a filled box) when the class holds throughout operating hours (H24);
	 *  outlined otherwise, the GEN 2.3 "most restrictive class" form. */
	chip: { letter: string; solid: boolean } | null;
}

/** Types whose designator label is `TYPE name` unless the name already
 *  carries the type word (fr names are bare tails: "RENNES 4", "212"). */
const PREFIXED_TYPES = new Set([
	'TMA', 'CTA', 'LTA', 'CTR', 'ATZ', 'UTA',
	'R', 'D', 'P', 'TRA', 'TSA', 'CBA',
	'TMZ', 'RMZ', 'TMZ-RMZ', 'ADIZ',
	'FIR', 'UIR', 'OCA',
]);

/** Token-boundary matcher per prefixed type: a name "carries" its type only
 *  as a whole token ("LONDON TMA 14"), never as a substring. Critical for
 *  the single-letter types R/D/P, where a plain substring test swallows the
 *  designator into ordinary words ("12 SUD B" contains D, "108 RM" contains
 *  R) and drops the chart-meaningful prefix. The type strings are all
 *  [A-Z-], so no regex escaping is needed. */
const TYPE_TOKEN_RE = new Map(
	[...PREFIXED_TYPES].map((t) => [t, new RegExp(`(^|[^A-Z0-9])${t}([^A-Z0-9]|$)`)]),
);

/** The compact designator drawn on the map ("R 3103 A", "TMA RENNES 4",
 *  "RMZ MEAUX"), or null for rows the chart leaves unlabelled. */
export function airspaceLabel(a: LabelInput): AirspaceLabel | null {
	const spec = symbolFor(a);
	if (a.type === 'DLG-ATS' || a.type === 'FRA' || a.type === 'FIC') {
		return null;
	}
	if (ACTIVITY_TYPES.has(a.type)) {
		// Activity zones print their bare number beside the glyph, winch
		// zones with the chart's CABLE mark in front ("CABLE 912"); SUR /
		// PRN rows (no glyph) stay unlabelled.
		if (!spec.glyph || !a.name) {
			return null;
		}
		const text = isWinchActivity(a) ? `CABLE ${a.name}` : a.name;
		return { text, color: spec.labelColor, chip: null };
	}
	let text: string | null = null;
	if (a.source === 'uk' && /^EG[A-Z]/.test(a.id)) {
		// UK ids carry the chart designator (EGD710 -> "D 710"); names hold
		// the area name ("RAASAY") or already include the type word
		// ("LONDON TMA 14").
		const m = /^EG([RDPW])(\d.*)$/.exec(a.id);
		if (m) {
			text = `${m[1]} ${m[2]}`;
		}
	} else if (a.source === 'faa' && /^[RPWA]-\d/.test(a.id)) {
		// FAA SUA ids ("R-2101") print with the dash opened up.
		text = a.id.replace('-', ' ');
	} else if (a.source === 'de' && /^ED[RDP]\d/.test(a.id)) {
		// DFS ids carry the chart designator (EDR32A -> "ED-R 32A",
		// EDD19AZ -> "ED-D 19A"). The trailing Z on some danger sub-zones
		// is an internal variant marker, dropped from the printed label.
		const m = /^ED([RDP])(\d+[A-Z]?)/.exec(a.id);
		if (m) {
			text = `ED-${m[1]} ${m[2]}`;
		}
	} else if (a.source === 'at' && /^LO[RD]\d/.test(a.id)) {
		// Austro Control ids carry the chart designator (LOR1 -> "LO-R 1",
		// LOD25A -> "LO-D 25A").
		const m = /^LO([RD])(\d+[A-Z]?)/.exec(a.id);
		if (m) {
			text = `LO-${m[1]} ${m[2]}`;
		}
	} else if (a.source === 'es' && /^LE[RDP]\d/.test(a.id)) {
		// ENAIRE ids carry the chart designator (LER146 -> "LE-R 146",
		// LED17C -> "LE-D 17C").
		const m = /^LE([RDP])(\d+[A-Z]?)/.exec(a.id);
		if (m) {
			text = `LE-${m[1]} ${m[2]}`;
		}
	} else if (a.source === 'be' && /^EB[RDP]\d/.test(a.id)) {
		// skeyes ids carry the chart designator (EBR01 -> "EB-R 01",
		// EBR18A -> "EB-R 18A"); the republished French LFR* rows fall
		// through to their name.
		const m = /^EB([RDP])(\d+[A-Z]?)/.exec(a.id);
		if (m) {
			text = `EB-${m[1]} ${m[2]}`;
		}
	}
	if (text === null) {
		if (!a.name) {
			return null;
		}
		const tokenRe = TYPE_TOKEN_RE.get(a.type);
		text =
			tokenRe && !tokenRe.test(a.name.toUpperCase())
				? `${a.type} ${a.name}`
				: a.name;
	}
	const chipLetter =
		spec.band?.kind === 'solid' || a.type === 'ATZ' ? a.airClass : '';
	return {
		text,
		color: spec.labelColor,
		chip: chipLetter
			? { letter: chipLetter, solid: a.workHr === '' || a.workHr === 'H24' }
			: null,
	};
}
