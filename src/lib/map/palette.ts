/* palette.ts is the single source of truth for the SIA 1:500 000 chart
 * palette: the fixed inks every canvas / Leaflet symbol module draws with,
 * the darker hover companions, and the derived sets the UI mirrors
 * (per-category chips day / night, activation strokes and hatch fills).
 * Provenance: docs/airspace-symbology.md "Colours" (Legende2026 flat-area
 * samples; dlg / tra from GEN 2.3); independently re-audited 2026-07-20 by
 * local/verify-legend audit_colors.py, every value pixel-exact.
 *
 * Imports NOTHING (bottom of the import graph). The CSS mirrors that
 * cannot import it (theme.css, the NavLogModal / flightprep print pins)
 * are locked by tests/paletteSync.spec.ts. App-identity colours are
 * deliberately NOT here: the NOTAM orange family (notamLayer.ts), the SUP
 * AIP magenta #c2185b, SIGMET hazard styles, route / marker inks.
 *
 * Values are static: symbolFor's specCache in airspaceSymbology.ts bakes
 * them into cached specs, so any future theme-switchable palette must
 * invalidate that cache (and repaint every layer) on switch. */

/** SIA print colours, sampled from the official 1:500 000 OACI chart legend
 *  édition 2026 (Géoportail Legende2026.pdf, lossless raster: flat-area
 *  pixels are the exact intended RGBs; recipe in docs/airspace-symbology.md).
 *  `dlg` and `tra` have no swatch there and keep their GEN 2.3 sampling.
 *  Fixed hex across themes, like every map overlay colour in this repo. */
export const SIA = {
	/** Chart red: P / R / D zones, RTBA, aerial activities, class A bands. */
	zone: '#E30613',
	/** Controlled-airspace navy: TMA / CTA / CTR edges, bands and labels,
	 *  ATZ dots, the class chips. */
	ctl: '#164194',
	/** Class E band ink, PRE-BLENDED for the offscreen band compositing:
	 *  drawn at BAND_TINT_ALPHA (0.6, airspaceDecoLayer.ts) over
	 *  paper-white it yields the legend's printed class E screen #B7D0EE. */
	classE: '#87B1E3',
	/** SIV green (the 500k draws FIS sector limits and names in green). */
	siv: '#00713C',
	/** Delegated-airspace dark blue (GEN 2.3 fine-tooth comb). */
	dlg: '#004D91',
	/** Ink: FIR comb, ADIZ. */
	ink: '#1D1D1B',
	/** The legend's softer black layer: RMZ / TMZ dashes print in it
	 *  (Legende2026 sample #3D3D3C, the same ink as its body text; the FIR
	 *  comb stays on the darker #1D1D1B layer). */
	inkSoft: '#3D3D3C',
	/** TRA orange (GEN 2.3). CBA is NOT in this family: the Legende2026
	 *  files it in the R / D hatch row (chart red). */
	tra: '#C3854A',
} as const;

/** Aeromodelling height-band colours: the chart colour-codes AER zones (and
 *  their designators) by ceiling band, Legende2026 rows 9560 / 9604 /
 *  9657-1. */
export const AEM_BAND = {
	/** H <= 1000 ft ASFC: orange. */
	low: '#EF7D00',
	/** 1000 < H <= 2000 ft ASFC: violet. */
	mid: '#AB3A8D',
	/** H > 2000 ft ASFC: red (the activity family ink). */
	high: SIA.zone,
} as const;

/** Darker companions used for the hover / selection stroke, keyed by the
 *  base ink. */
export const DARK: Record<string, string> = {
	[SIA.zone]: '#9B040D',
	[SIA.ctl]: '#0D2A62',
	[SIA.classE]: '#0D2A62',
	[SIA.siv]: '#004726',
	[SIA.dlg]: '#003564',
	[SIA.ink]: '#000000',
	[SIA.inkSoft]: '#1D1D1B',
	[SIA.tra]: '#8F5D2E',
	// Aeromodelling height bands (AEM_BAND low / mid; high is SIA.zone).
	[AEM_BAND.low]: '#A85800',
	[AEM_BAND.mid]: '#73265E',
};

/** Aerodrome inks (Legende2026 aerodromes panel, flat-area samples). */
export const AIRPORT = {
	/** Civil / joint bodies: the chart navy (same ink as SIA.ctl). */
	civil: SIA.ctl,
	/** Military body red (rings + disc). */
	military: '#E52E15',
	/** The H / anchor inside military symbols (the chart red). */
	militaryGlyph: SIA.zone,
	/** Grey restricted disc (app extra: no-civilian-access fields). */
	restrictedFill: '#c9ccd1',
	/** Dark ring on the restricted disc. */
	restrictedRing: '#3a4250',
	/** Closed / abandoned: chart ink ring + X. */
	closedInk: SIA.ink,
} as const;

/** Navaid inks: the whole radionav family prints in the Legende2026 navy
 *  (= SIA.ctl); ILS (no VFR-chart row) keeps its distinct orange, the RNAV
 *  waypoint star its slate (ENAIRE convention); both documented
 *  deviations. `unserviceable` greys a NOTAM-closed navaid. */
export const NAVAID = {
	radionav: SIA.ctl,
	ils: '#d2691e',
	waypoint: '#5a6470',
	unserviceable: '#878d96',
} as const;

/** The legend's obstacle ink (sampled flat; identical to SIA.ctl). */
export const OBSTACLE_INK = SIA.ctl;

/** Paper white: chip letters, runway capsules, knockout parts. */
export const PAPER = '#ffffff';

/** Halo colour stroked under every point glyph for basemap contrast. */
export const HALO = 'rgba(255, 255, 255, 0.92)';

/** The deco layer's softer designator-label halo. */
export const LABEL_HALO = 'rgba(255, 255, 255, 0.85)';

/** Red "has active NOTAM" cue ring around point symbols (symbolBase). */
export const CUE_RING = '#cb2026';

/** Thin line for FIR boundaries BETWEEN two French FIRs: the chart prints
 *  them as a plain grey line without the comb (2026 Nord-Ouest in-situ,
 *  LFRR/LFFF + LFRR/LFBB). The reduced JPEG scan is not
 *  colour-authoritative, so this is a visually matched neutral grey, not
 *  a flat sample (docs/airspace-symbology.md). */
export const FIR_INTERNAL = '#9A9A9A';

/** UI chip ink per airspace category, day theme (mirrored as the
 *  `--airspace-*` tokens in src/styles/theme.css `:root`, locked by
 *  tests/paletteSync.spec.ts). The MAP always draws the fixed SIA inks on
 *  its light tiles; these tokens style HTML/SVG surfaces (panel chips,
 *  legend swatches, profile bands). `activity` is a lightened chart red,
 *  UI-only, so list chips stay tellable from restricted. */
export const AIRSPACE_CHIP_DAY = {
	controlled: SIA.ctl,
	restricted: SIA.zone,
	activity: '#f0767d',
	trafficmgmt: SIA.ink,
	transit: SIA.tra,
	siv: SIA.siv,
	fir: SIA.ink,
} as const;

/** Night chip variants for panels on dark surfaces (theme.css
 *  `[data-theme="night"]` mirror). The map is unaffected: only themed UI
 *  reads these. */
export const AIRSPACE_CHIP_NIGHT = {
	controlled: '#5c85d6',
	restricted: '#ff5a52',
	activity: '#ff8d86',
	trafficmgmt: '#cfd3d7',
	transit: '#d99a5e',
	siv: '#25b563',
	fir: '#9aa3ad',
} as const;

/** NOTAM-activation hatch stroke per category: the dark companion of the
 *  category's base ink (activationLayer.ts). */
export const ACTIVATION_STROKE = {
	controlled: DARK[SIA.ctl],
	restricted: DARK[SIA.zone],
	activity: DARK[SIA.zone],
	trafficmgmt: DARK[SIA.ink],
	transit: DARK[SIA.tra],
	siv: DARK[SIA.siv],
	fir: DARK[SIA.ink],
} as const;

/** SVG `<pattern>` hatch fill per category (MapView's activation defs):
 *  the category's base ink. Complete across the categories so an
 *  activated zone of ANY category resolves to a real pattern (the SUP AIP
 *  hatch is app identity and stays out, pinned by paletteSync). */
export const ACTIVATION_HATCH_FILL = {
	controlled: SIA.ctl,
	restricted: SIA.zone,
	activity: SIA.zone,
	trafficmgmt: SIA.ink,
	transit: SIA.tra,
	siv: SIA.siv,
	fir: SIA.ink,
} as const;
