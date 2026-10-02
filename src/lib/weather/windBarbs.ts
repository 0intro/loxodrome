/* Wind-barb geometry per the NWS / WMO station-model convention (sources and
 * the side-rule derivation: docs/wind-aloft.md): pennant 50 kt, full barb
 * 10 kt, half barb 5 kt, speeds rounded to the nearest 5; calm (rounds to 0)
 * is a circle around the station dot; a lone half barb sits inset from the
 * tip. The staff points toward the direction the wind blows FROM, and in the
 * northern hemisphere the feathers extend on the clockwise side of the
 * outward staff (toward lower pressure): wind from the north puts them east,
 * wind from the west puts them poleward. One shared unit-space geometry
 * feeds both the canvas painter (map layer, tab legend) and the SVG path
 * builder (route profile), so the two renderings cannot drift apart. */

export interface BarbElements {
	calm: boolean;
	pennants: number;
	full: number;
	half: number;
}

/** Decompose a speed into station-model elements (nearest 5 kt). */
export function windBarbElements(speedKt: number): BarbElements {
	const r = Math.max(0, Math.round(speedKt / 5) * 5);
	if (r === 0) {
		return { calm: true, pennants: 0, full: 0, half: 0 };
	}
	const pennants = Math.floor(r / 50);
	const rest = r - pennants * 50;
	return { calm: false, pennants, full: Math.floor(rest / 10), half: rest % 10 >= 5 ? 1 : 0 };
}

type Pt = [number, number];

interface BarbGeometry {
	/** Station dot to the upwind tip; null when calm. */
	staff: [Pt, Pt] | null;
	feathers: [Pt, Pt][];
	pennants: Pt[][];
	/** Calm-circle radius in unit space; null unless calm. */
	calmR: number | null;
}

/* Unit frame: station at the origin, staff of length 1 along -Y (screen up,
 * map north); feathers on +X. Ratios are measured off the NWS reference
 * tiles (weather.gov/hfo/windbarbinfo per-speed GIFs, staff 41-42 px):
 * full barb 0.39 of the staff raked ~74 degrees from the staff toward the
 * tip (perpendicular reach 0.375, tipward lean 0.11), elements one SLOT
 * (5 px) apart, pennant base 0.23 along the staff with the apex 0.43 out
 * and leaned 0.10 tipward, the gap after a pennant slightly under a SLOT. */
const FEATHER_DX = 0.375;
const FEATHER_DY = -0.11;
const SLOT = 0.122;
const PENNANT_SPAN = 0.23;
const PENNANT_OUT = 0.43;
const PENNANT_LEAN = 0.1;
const PENNANT_GAP = 0.8 * SLOT;
const CALM_R = 0.2;

function barbGeometry(speedKt: number): BarbGeometry {
	const el = windBarbElements(speedKt);
	if (el.calm) {
		return { staff: null, feathers: [], pennants: [], calmR: CALM_R };
	}
	const feathers: [Pt, Pt][] = [];
	const pennants: Pt[][] = [];
	let y = -1;
	for (let i = 0; i < el.pennants; i++) {
		pennants.push([
			[0, y],
			[PENNANT_OUT, y + PENNANT_LEAN],
			[0, y + PENNANT_SPAN],
		]);
		y += PENNANT_SPAN;
	}
	if (el.pennants > 0) {
		y += PENNANT_GAP;
	}
	// A lone half barb is inset one slot from the tip so it cannot be read
	// as a full barb ending the staff.
	if (el.pennants === 0 && el.full === 0 && el.half === 1) {
		y += SLOT;
	}
	for (let i = 0; i < el.full; i++) {
		feathers.push([
			[0, y],
			[FEATHER_DX, y + FEATHER_DY],
		]);
		y += SLOT;
	}
	if (el.half === 1) {
		feathers.push([
			[0, y],
			[FEATHER_DX / 2, y + FEATHER_DY / 2],
		]);
	}
	return { staff: [[0, 0], [0, -1]], feathers, pennants, calmR: null };
}

/** Rotate the unit frame so the staff points toward dirFromDeg (map
 *  north-up), scale to sizePx and translate to the station point. */
function place(p: Pt, dirFromDeg: number, sizePx: number, x: number, y: number): Pt {
	const rad = (dirFromDeg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	return [x + (p[0] * cos - p[1] * sin) * sizePx, y + (p[0] * sin + p[1] * cos) * sizePx];
}

export interface PlacedBarb {
	staff: [Pt, Pt] | null;
	feathers: [Pt, Pt][];
	pennants: Pt[][];
	calmR: number | null;
}

export function placedBarb(x: number, y: number, dirFromDeg: number, speedKt: number, sizePx: number): PlacedBarb {
	const g = barbGeometry(speedKt);
	const tr = (p: Pt): Pt => place(p, dirFromDeg, sizePx, x, y);
	return {
		staff: g.staff ? [tr(g.staff[0]), tr(g.staff[1])] : null,
		feathers: g.feathers.map(([a, b]) => [tr(a), tr(b)]),
		pennants: g.pennants.map((poly) => poly.map(tr)),
		calmR: g.calmR != null ? g.calmR * sizePx : null,
	};
}

export interface BarbInk {
	stroke: string;
	/** Contrast halo painted under the barb; omit to skip the halo pass. */
	halo?: string | undefined;
}

const STROKE_W = 2.1;
const HALO_W = 5;
const DOT_R = 2.1;

function tracePaths(ctx: CanvasRenderingContext2D, b: PlacedBarb, x: number, y: number): void {
	ctx.beginPath();
	if (b.staff) {
		ctx.moveTo(b.staff[0][0], b.staff[0][1]);
		ctx.lineTo(b.staff[1][0], b.staff[1][1]);
	}
	for (const [a, e] of b.feathers) {
		ctx.moveTo(a[0], a[1]);
		ctx.lineTo(e[0], e[1]);
	}
	for (const poly of b.pennants) {
		ctx.moveTo(poly[0][0], poly[0][1]);
		for (let i = 1; i < poly.length; i++) {
			ctx.lineTo(poly[i][0], poly[i][1]);
		}
		ctx.closePath();
	}
	if (b.calmR != null) {
		ctx.moveTo(x + b.calmR, y);
		ctx.arc(x, y, b.calmR, 0, 2 * Math.PI);
	}
}

/** Paint one barb on a canvas (the layer's dpr prologue already ran). */
export function drawWindBarb(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	dirFromDeg: number,
	speedKt: number,
	sizePx: number,
	ink: BarbInk,
): void {
	const b = placedBarb(x, y, dirFromDeg, speedKt, sizePx);
	ctx.save();
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	if (ink.halo) {
		tracePaths(ctx, b, x, y);
		ctx.strokeStyle = ink.halo;
		ctx.lineWidth = HALO_W;
		ctx.stroke();
	}
	tracePaths(ctx, b, x, y);
	ctx.strokeStyle = ink.stroke;
	ctx.lineWidth = STROKE_W;
	ctx.stroke();
	ctx.fillStyle = ink.stroke;
	for (const poly of b.pennants) {
		ctx.beginPath();
		ctx.moveTo(poly[0][0], poly[0][1]);
		for (let i = 1; i < poly.length; i++) {
			ctx.lineTo(poly[i][0], poly[i][1]);
		}
		ctx.closePath();
		ctx.fill();
	}
	ctx.beginPath();
	ctx.arc(x, y, DOT_R, 0, 2 * Math.PI);
	ctx.fill();
	ctx.restore();
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

export interface SvgBarb {
	/** Staff + feathers + closed pennant subpaths; render with fill and
	 *  stroke set to the ink (open lines have no area, only pennants fill). */
	pathD: string;
	/** Calm-circle radius, px; null unless calm. */
	calmR: number | null;
	/** Station dot radius, px. */
	dotR: number;
}

/** The same placed geometry as an SVG path (route profile). */
export function svgWindBarb(x: number, y: number, dirFromDeg: number, speedKt: number, sizePx: number): SvgBarb {
	const b = placedBarb(x, y, dirFromDeg, speedKt, sizePx);
	const parts: string[] = [];
	if (b.staff) {
		parts.push(`M${fmt(b.staff[0][0])} ${fmt(b.staff[0][1])}L${fmt(b.staff[1][0])} ${fmt(b.staff[1][1])}`);
	}
	for (const [a, e] of b.feathers) {
		parts.push(`M${fmt(a[0])} ${fmt(a[1])}L${fmt(e[0])} ${fmt(e[1])}`);
	}
	for (const poly of b.pennants) {
		parts.push(`M${poly.map((p) => `${fmt(p[0])} ${fmt(p[1])}`).join('L')}Z`);
	}
	return { pathD: parts.join(''), calmR: b.calmR, dotR: DOT_R };
}

/** TAF-style significance: label gusts at 10 kt or more over the mean. */
export function gustLabel(speedKt: number, gustKt: number | null): string | null {
	if (gustKt == null || gustKt < speedKt + 10) {
		return null;
	}
	return `G${Math.round(gustKt)}`;
}

const KMH_PER_KT = 1.852;

export interface BarbTipInfo {
	dirTrueDeg: number;
	speedKt: number;
	tempC: number | null;
	isaDevC: number | null;
	/** The barb draws faded (level below the cell's ground, 10 m wind
	 *  shown; or above its fetched ladder when `aboveTop` is set). */
	faded?: boolean;
	/** The chosen level sits above the cell's fetched pressure ladder
	 *  (top-level wind shown clamped); wins over the faded note. */
	aboveTop?: boolean;
}

/** The badge's words (t.weather.barb); the geometry module stays
 *  locale-free (docs/i18n.md rule 6). */
export interface BarbWords {
	calm: string;
	degTrue: (ddd: string) => string;
	fadedNote: string;
	aboveTopNote: string;
}

/** Hover readout for a map barb: direction (° true), speed in knots and
 *  km/h, and the temperature with its ISA deviation when known. A wind that
 *  plots as the calm circle (rounds to 0) reads "Calm". */
export function barbTipLines(b: BarbTipInfo, words: BarbWords): string[] {
	const lines: string[] = [];
	if (windBarbElements(b.speedKt).calm) {
		lines.push(words.calm);
	} else {
		const d = ((Math.round(b.dirTrueDeg) % 360) + 360) % 360;
		lines.push(words.degTrue(String(d === 0 ? 360 : d).padStart(3, '0')));
	}
	lines.push(`${Math.round(b.speedKt)} kt (${Math.round(b.speedKt * KMH_PER_KT)} km/h)`);
	if (b.tempC != null && b.isaDevC != null) {
		const dev = Math.round(b.isaDevC);
		lines.push(`${Math.round(b.tempC)} °C (ISA ${dev >= 0 ? '+' : ''}${dev})`);
	}
	if (b.aboveTop) {
		lines.push(words.aboveTopNote);
	} else if (b.faded) {
		lines.push(words.fadedNote);
	}
	return lines;
}
