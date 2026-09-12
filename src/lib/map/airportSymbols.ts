/* airportSymbols.ts draws aerodrome chart symbols onto a 2D canvas context,
 * in the same style as navaidSymbols.ts (a white halo under the coloured
 * mark, shared via symbolBase.ts).
 *
 * Following the French SIA / ENAIRE convention, a civil aerodrome keys on
 * whether it is PAVED (any hard-surfaced runway with a known direction):
 *
 *   civil paved:         filled blue disc + 4 cardinal tabs + the runway(s)
 *                        in white at the real heading
 *   civil unpaved/unkn:  an open circle - a blue ring + blue tabs on a white
 *                        halo, the map showing through, no runway
 *   joint:               the ENAIRE aerodromo mixto - the open body with a
 *                        filled blue inner disc + runway (paved) or a hollow
 *                        blue inner ring (unpaved), ICAO 88
 *   military:            red outer ring + thin white gap + SOLID red inner
 *                        disc + white runway(s) when paved, an inner red
 *                        ring when unpaved; no tabs (ENAIRE base_militar,
 *                        ICAO 86)
 *   restricted:          grey disc + a dark ring (ENAIRE/French extra), only
 *                        for fields with no civilian access; civilian "usage
 *                        restreint" fields keep the civil symbol + a panel tag
 *   seaplane:            the STATUS body (civil open / joint inner ring /
 *                        military red double ring) + an anchor in the centre
 *   heliport:            the STATUS body + an "H" in the centre (glyph in
 *                        the status colour; military prints the deep red)
 *   emergency:           plain open circle (ICAO 90) - dormant, no data source
 *   closed:              chart-ink ring + inscribed upright X (ICAO 91)
 *
 * Colours are hardcoded (like navaidSymbols.ts / obstacleLayer.ts) and read
 * on both light and dark themes. Status comes from the data (a.military,
 * a.access, a.joint, a.vfr/a.ifr) where available (FR/UK/ES AIXM); the
 * worldwide baseline carries none, so those fields render civil. */

import type { Airport } from '$lib/data/airports';
import { AIRPORT, PAPER } from './palette';
import { HALO, haloStroke, haloFill } from './symbolBase';

// Inks from the palette (Legende2026 aerodromes panel samples).
const CIVIL = AIRPORT.civil;
const MILITARY = AIRPORT.military;
const MILITARY_GLYPH = AIRPORT.militaryGlyph;
const RESTRICTED_FILL = AIRPORT.restrictedFill;
const RESTRICTED_RING = AIRPORT.restrictedRing;
const CLOSED_INK = AIRPORT.closedInk;
const WHITE = PAPER;

type FacilityKind = 'aerodrome' | 'heliport' | 'seaplane' | 'closed' | 'emergency';

/** Map the OurAirports `type` to a drawing kind. Fixed-wing sizes and
 *  balloonports share the aerodrome glyph. `emergency` is reachable only via a
 *  hypothetical `emergency_aerodrome` type (ICAO 90 has no data source yet). */
export function facilityKind(type: string): FacilityKind {
	if (type === 'heliport') {
		return 'heliport';
	}
	if (type === 'seaplane_base') {
		return 'seaplane';
	}
	if (type === 'closed') {
		return 'closed';
	}
	if (type === 'emergency_aerodrome') {
		return 'emergency';
	}
	return 'aerodrome';
}

export type AirportStatus = 'civil' | 'military' | 'joint' | 'restricted';

/** Operational status, from the AIXM-derived fields. `joint` (civil +
 *  military) uses `a.joint` when the pipeline provides it, else the bridge
 *  "military AND open to civil traffic" (a STATE + GAT field), which already
 *  holds for the FR dataset. */
export function airportStatus(a: Airport): AirportStatus {
	const joint = a.joint || (a.military && a.access === 'cap');
	if (joint) {
		return 'joint';
	}
	if (a.military) {
		return 'military';
	}
	// "Usage restreint" is conveyed by the detail-panel tag (access ===
	// 'restricted'), not the map glyph: a civilian restricted-use field still
	// runs civilian operations (vfr/ifr set), so it keeps the ordinary civil
	// aerodrome symbol. The grey restricted disc stays reserved for fields with
	// no civilian access at all (access restricted AND neither vfr nor ifr).
	if (a.access === 'restricted' && !a.vfr && !a.ifr) {
		return 'restricted';
	}
	return 'civil';
}

/** Colour for an open glyph (heliport / water anchor) given the status.
 *  The legend prints the military H / anchor in the deeper chart red. */
function glyphColor(status: AirportStatus): string {
	if (status === 'military') {
		return MILITARY_GLYPH;
	}
	if (status === 'restricted') {
		return RESTRICTED_RING;
	}
	return CIVIL; // civil + joint
}

/** Representative colour for the context-menu / Layers swatch. */
export function airportSwatchColor(a: Airport): string {
	if (a.type === 'closed') {
		return CLOSED_INK;
	}
	if (airportStatus(a) === 'military') {
		return MILITARY;
	}
	return glyphColor(airportStatus(a));
}

/** Disc radius (px), uniform across all aerodrome types; the tabs and hit-test
 *  extend beyond it. Type no longer changes the draw size, it only gates the
 *  zoom a feature first appears at (TYPE_MIN_ZOOM in airportLayer.ts). */
export function airportSymbolSize(): number {
	return 7;
}

/** Magnetic heading (deg) of a runway low-end designator like `09` -> 90,
 *  `14L` -> 140, or null for non-directional ends (`H1`, `N`, `ALL`, ``).
 *  The designator is magnetic; we use it directly against map north (the
 *  declination offset is negligible at this glyph size). */
export function runwayBearing(le: string): number | null {
	const m = /^(\d{1,2})[LRC]?$/.exec(le.trim());
	if (!m) {
		return null;
	}
	const n = parseInt(m[1], 10);
	if (n < 1 || n > 36) {
		return null;
	}
	return n * 10;
}

/** Is the runway hard-surfaced (paved)? ICAO draws hard runways solid and
 *  unpaved ones hollow. The OurAirports surface codes are messy free-text,
 *  so this is a keyword heuristic: explicit paved keywords win, explicit
 *  soft keywords are unpaved, and anything unknown defaults to hard. */
export function isHardSurface(surface: string): boolean {
	const s = surface.toUpperCase();
	if (/ASP|CON|PEM|BIT|PAV|TAR|SEAL|MAC/.test(s)) {
		return true;
	}
	if (/GRA|GRS|GRE|TURF|SOD|DIRT|EARTH|GVL|GRVL|SAND|CLAY|MUD|WATER|SNOW|ICE|CORAL|SHELL|GROUND/.test(s)) {
		return false;
	}
	return true;
}

/** Orientation of a bearing folded to [0, 180): a runway and its reciprocal
 *  are the same line. */
function orient180(bearing: number): number {
	return ((bearing % 180) + 180) % 180;
}

/** Up to two runway bars to draw, longest runway first, each carrying its
 *  surface. A second bar is added only when its orientation differs from the
 *  first by more than 20 deg, so parallel runways (14L/14R) collapse to one
 *  and crossed fields (KJFK) draw a cross. With `hardOnly`, soft-surface
 *  runways are dropped before the dedup, so a short paved runway parallel to a
 *  longer grass one still survives (the paved runway is often not the longest). */
export function runwayBars(
	a: Airport,
	hardOnly = false,
): Array<{ bearing: number; hard: boolean }> {
	let cands = a.runways
		.map((r) => ({
			bearing: runwayBearing(r.le),
			len: r.lengthFt ?? 0,
			hard: isHardSurface(r.surface),
		}))
		.filter((r): r is { bearing: number; len: number; hard: boolean } => r.bearing !== null);
	if (hardOnly) {
		cands = cands.filter((r) => r.hard);
	}
	cands.sort((x, y) => y.len - x.len);
	const out: Array<{ bearing: number; hard: boolean }> = [];
	for (const r of cands) {
		if (out.length >= 2) {
			break;
		}
		const o = orient180(r.bearing);
		const dup = out.some((b) => {
			const d = Math.abs(orient180(b.bearing) - o);
			return Math.min(d, 180 - d) < 20;
		});
		if (!dup) {
			out.push({ bearing: r.bearing, hard: r.hard });
		}
	}
	return out;
}

/** A field is "paved" (French revetue) if it has any hard-surfaced runway with
 *  a known direction. Drives the filled-vs-open civil and joint symbols. */
export function isPaved(a: Airport): boolean {
	return runwayBars(a, true).length > 0;
}

/** Add a rounded rectangle subpath (top-left origin). */
function roundedRect(p: Path2D, x: number, y: number, w: number, h: number, r: number): void {
	const right = x + w;
	const bot = y + h;
	p.moveTo(x + r, y);
	p.lineTo(right - r, y);
	p.arcTo(right, y, right, y + r, r);
	p.lineTo(right, bot - r);
	p.arcTo(right, bot, right - r, bot, r);
	p.lineTo(x + r, bot);
	p.arcTo(x, bot, x, bot - r, r);
	p.lineTo(x, y + r);
	p.arcTo(x, y, x + r, y, r);
	p.closePath();
}

/** Disc + four short cardinal tabs (the ICAO civil aerodrome body, item 84).
 *  One consistently-wound compound path so haloFill leaves a clean white halo
 *  around the silhouette with no internal seams. */
function aerodromeBodyPath(x: number, y: number, s: number): Path2D {
	const p = new Path2D();
	p.arc(x, y, s, 0, Math.PI * 2);
	// Legende2026 proportions: short tab nubs (reach 1.37x the disc radius,
	// width 0.38x), much slighter than the old long tabs.
	const half = s * 0.19; // tab half-width
	const inn = s * 0.62; // tab inner end (inside the disc, for a solid join)
	const out = s * 1.37; // tab outer end
	const len = out - inn;
	p.rect(x - half, y - out, 2 * half, len); // top
	p.rect(x - half, y + inn, 2 * half, len); // bottom
	p.rect(x - out, y - half, len, 2 * half); // left
	p.rect(x + inn, y - half, len, 2 * half); // right
	return p;
}

/** Solid white runway bar through the centre at `bearing`, kept inside the
 *  disc. Only paved runways are drawn (the open symbol shows none).
 *  Legende2026 proportions: 0.82 s long and 0.24 s wide, with square ends
 *  that hold full width to the last twentieth of the bar, so the corners
 *  take a fifth of the half-width and the tips stay off the disc rim. */
function drawRunway(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	bearing: number,
): void {
	const halfLen = s * 0.82;
	const halfW = Math.max(1.1, s * 0.24);
	const p = new Path2D();
	roundedRect(p, -halfW, -halfLen, 2 * halfW, 2 * halfLen, halfW * 0.2);
	ctx.save();
	ctx.translate(x, y);
	ctx.rotate((bearing * Math.PI) / 180);
	ctx.fillStyle = WHITE;
	ctx.fill(p);
	ctx.restore();
}

/** Append an "H" (heliport) to a path; the legend's H fills about 60 % of
 *  the ring interior. */
function addH(p: Path2D, x: number, y: number, s: number): void {
	const hx = s * 0.38;
	const hy = s * 0.55;
	p.moveTo(x - hx, y - hy);
	p.lineTo(x - hx, y + hy);
	p.moveTo(x + hx, y - hy);
	p.lineTo(x + hx, y + hy);
	p.moveTo(x - hx, y);
	p.lineTo(x + hx, y);
}

/** Append an anchor (the ICAO water modifier) to a path, centred on (x, y):
 *  eye, stock, shaft, fluke V. */
function addAnchor(p: Path2D, x: number, y: number, s: number): void {
	const top = y - s * 0.55;
	const bot = y + s * 0.5;
	p.moveTo(x, top + s * 0.2); // shaft
	p.lineTo(x, bot);
	p.moveTo(x - s * 0.3, top + s * 0.36); // stock
	p.lineTo(x + s * 0.3, top + s * 0.36);
	p.moveTo(x + s * 0.13, top); // eye
	p.arc(x, top, s * 0.13, 0, Math.PI * 2);
	p.moveTo(x - s * 0.34, bot - s * 0.22); // fluke V
	p.lineTo(x, bot);
	p.lineTo(x + s * 0.34, bot - s * 0.22);
}

/** Heliport: the status body + an "H" in the centre, carrying its own halo
 *  the way the navaid glyphs do. Civil = open body + blue H; joint adds the
 *  inner ring (the legend's mixte modifier); military = the red double ring
 *  without tabs, H in the deeper red. */
function drawHeliport(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	status: AirportStatus,
): void {
	drawModifierBody(ctx, x, y, s, status);
	const p = new Path2D();
	addH(p, x, y, s);
	ctx.lineCap = 'round';
	haloStroke(ctx, p, glyphColor(status), Math.max(1.3, s * 0.16));
	ctx.lineCap = 'butt';
}

/** The body under a heliport / seaplane glyph per status: civil = the open
 *  body; joint = open body + inner ring (legend mixte row); military = red
 *  ring + inner ring, NO tabs (legend militaire row). */
function drawModifierBody(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	status: AirportStatus,
): void {
	if (status === 'military') {
		const backing = new Path2D();
		backing.arc(x, y, s + 1.5, 0, Math.PI * 2);
		ctx.fillStyle = WHITE;
		ctx.fill(backing);
		const outer = new Path2D();
		outer.arc(x, y, s * 0.9, 0, Math.PI * 2);
		ctx.strokeStyle = MILITARY;
		ctx.lineWidth = s * 0.2;
		ctx.stroke(outer);
		const inner = new Path2D();
		inner.arc(x, y, s * 0.6, 0, Math.PI * 2);
		ctx.strokeStyle = MILITARY;
		ctx.lineWidth = Math.max(1.3, s * 0.16);
		ctx.stroke(inner);
		return;
	}
	drawOpenAerodromeBody(ctx, x, y, s, CIVIL);
	if (status === 'joint') {
		const inner = new Path2D();
		inner.arc(x, y, s * 0.6, 0, Math.PI * 2);
		ctx.strokeStyle = CIVIL;
		ctx.lineWidth = Math.max(1.3, s * 0.16);
		ctx.stroke(inner);
	}
}

/** Restricted aerodrome (ENAIRE/French extra, not ICAO): grey disc + dark ring. */
function drawRestrictedAerodrome(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
): void {
	const backing = new Path2D();
	backing.arc(x, y, s + 1, 0, Math.PI * 2);
	ctx.fillStyle = HALO;
	ctx.fill(backing);
	const core = new Path2D();
	core.arc(x, y, s * 0.86, 0, Math.PI * 2);
	ctx.fillStyle = RESTRICTED_FILL;
	ctx.fill(core);
	const ring = new Path2D();
	ring.arc(x, y, s * 0.86, 0, Math.PI * 2);
	ctx.strokeStyle = RESTRICTED_RING;
	ctx.lineWidth = s * 0.26;
	ctx.stroke(ring);
}

/** Military aerodrome (Legende2026 militaire row): a red outer ring, a thin
 *  white gap, then a SOLID red inner disc with the white runway when paved
 *  (legend: disc to 0.75 of the extent), or an inner red ring when unpaved.
 *  No cardinal tabs. */
function drawMilitary(
	ctx: CanvasRenderingContext2D,
	a: Airport,
	x: number,
	y: number,
	s: number,
): void {
	const backing = new Path2D();
	backing.arc(x, y, s + 1.5, 0, Math.PI * 2);
	ctx.fillStyle = WHITE;
	ctx.fill(backing);
	const bars = runwayBars(a, true);
	if (bars.length > 0) {
		const inner = new Path2D();
		inner.arc(x, y, s * 0.74, 0, Math.PI * 2);
		ctx.fillStyle = MILITARY;
		ctx.fill(inner);
		for (const bar of bars) {
			drawRunway(ctx, x, y, s * 0.74, bar.bearing);
		}
	} else {
		const inner = new Path2D();
		inner.arc(x, y, s * 0.6, 0, Math.PI * 2);
		ctx.strokeStyle = MILITARY;
		ctx.lineWidth = Math.max(1.3, s * 0.16);
		ctx.stroke(inner);
	}
	const outer = new Path2D();
	outer.arc(x, y, s * 0.9, 0, Math.PI * 2);
	ctx.strokeStyle = MILITARY;
	ctx.lineWidth = s * 0.2;
	ctx.stroke(outer);
}

/** The four cardinal tabs as a standalone path (the joint symbol's outer ring
 *  has no filled disc to merge them into); tabs run from `inn` to `out` with
 *  half-width `half`. */
function tabsPath(x: number, y: number, half: number, inn: number, out: number): Path2D {
	const p = new Path2D();
	const len = out - inn;
	p.rect(x - half, y - out, 2 * half, len);
	p.rect(x - half, y + inn, 2 * half, len);
	p.rect(x - out, y - half, len, 2 * half);
	p.rect(x + inn, y - half, len, 2 * half);
	return p;
}

/** The open aerodrome body (French non-revetue / unknown, and the base for the
 *  seaplane / heliport / joint glyphs): a `color` ring (outer edge at s) with
 *  `color` cardinal tabs and no runway, over a white halo. The ring interior
 *  stays open the way the chart prints item 84, so the basemap and any chart
 *  layer under it show through the circle. */
function drawOpenAerodromeBody(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	color: string,
): void {
	// The ink, in legend proportions: a thin ring (0.15 s) with its outer edge
	// at s, and short tab nubs (0.19 s half-width) reaching 1.27 s.
	const ringR = s * 0.93;
	const ringW = s * 0.15;
	const tabHalf = s * 0.19;
	const tabOut = s * 1.27;
	const inner = ringR - ringW / 2; // the ring's inner edge
	// White halo: the ink outset by 1 px all round, the margin haloFill's 2 px
	// stroke leaves around the filled body. One consistently-wound compound
	// path (the tab backings, the disc, then a counter-wound circle at the
	// ring's inner edge, which the default nonzero fill rule turns into a
	// hole, the Icon.svelte runway trick), each moveTo opening its arc's own
	// subpath so no connector runs back to the rects. The tab backings start
	// ON that edge, keeping the winding at 1 everywhere the hole has to cut.
	const halo = tabsPath(x, y, tabHalf + 1, inner, tabOut + 1);
	const haloR = ringR + ringW / 2 + 1;
	halo.moveTo(x + haloR, y);
	halo.arc(x, y, haloR, 0, Math.PI * 2);
	halo.moveTo(x + inner, y);
	halo.arc(x, y, inner, 0, Math.PI * 2, true);
	ctx.fillStyle = WHITE;
	ctx.fill(halo);
	// Coloured cardinal tabs, reaching inside the ring so they weld to it.
	ctx.fillStyle = color;
	ctx.fill(tabsPath(x, y, tabHalf, s * 0.8, tabOut));
	const ring = new Path2D();
	ring.arc(x, y, ringR, 0, Math.PI * 2);
	ctx.strokeStyle = color;
	ctx.lineWidth = ringW;
	ctx.stroke(ring);
}

/** Joint civil/military aerodrome (ICAO 88, the ENAIRE aerodromo mixto): the
 *  open body plus, when paved, a filled blue inner disc split by the runway
 *  (mixto right); otherwise a hollow blue inner ring (mixto left). */
function drawJoint(
	ctx: CanvasRenderingContext2D,
	a: Airport,
	x: number,
	y: number,
	s: number,
	paved: boolean,
): void {
	drawOpenAerodromeBody(ctx, x, y, s, CIVIL);
	if (paved) {
		// The legend's mixte inner disc nearly fills the ring interior.
		const inner = new Path2D();
		inner.arc(x, y, s * 0.72, 0, Math.PI * 2);
		ctx.fillStyle = CIVIL;
		ctx.fill(inner);
		for (const bar of runwayBars(a, true)) {
			drawRunway(ctx, x, y, s * 0.72, bar.bearing);
		}
	} else {
		const inner = new Path2D();
		inner.arc(x, y, s * 0.55, 0, Math.PI * 2);
		ctx.strokeStyle = CIVIL;
		ctx.lineWidth = Math.max(1.3, s * 0.16);
		ctx.stroke(inner);
	}
}

/** The land aerodrome body for `status`: civil draws the filled blue disc +
 *  tabs + white runway when paved, else the open white disc; joint the ENAIRE
 *  mixto (ICAO 88); military the base_militar ring; restricted the grey disc. */
function drawAerodromeBody(
	ctx: CanvasRenderingContext2D,
	a: Airport,
	x: number,
	y: number,
	s: number,
	status: AirportStatus,
): void {
	if (status === 'restricted') {
		drawRestrictedAerodrome(ctx, x, y, s);
		return;
	}
	if (status === 'military') {
		drawMilitary(ctx, a, x, y, s);
		return;
	}
	const paved = isPaved(a);
	if (status === 'joint') {
		drawJoint(ctx, a, x, y, s, paved);
		return;
	}
	// civil: paved = filled blue disc + white runway(s); else the open disc.
	if (paved) {
		haloFill(ctx, aerodromeBodyPath(x, y, s), CIVIL);
		for (const bar of runwayBars(a, true)) {
			drawRunway(ctx, x, y, s, bar.bearing);
		}
	} else {
		drawOpenAerodromeBody(ctx, x, y, s, CIVIL);
	}
}

/** Seaplane base: the status body + a haloed anchor in the centre (see
 *  drawHeliport for the status forms). */
function drawSeaplane(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	s: number,
	status: AirportStatus,
): void {
	drawModifierBody(ctx, x, y, s, status);
	const p = new Path2D();
	addAnchor(p, x, y, s); // large, centred on the disc
	ctx.lineCap = 'round';
	haloStroke(ctx, p, glyphColor(status), Math.max(1.3, s * 0.16));
	ctx.lineCap = 'butt';
}

/** Emergency / no-facilities aerodrome (ICAO 90): a plain open circle, no
 *  tabs. Dormant - no OurAirports/AIXM field marks one. */
function drawEmergencyAerodrome(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
	const p = new Path2D();
	p.arc(x, y, s * 0.9, 0, Math.PI * 2);
	haloStroke(ctx, p, CIVIL, 1.8);
}

/** Closed / abandoned aerodrome (Legende2026 "AD desaffecte", ICAO 91): a
 *  chart-ink ring with an upright X inscribed clear of it. Legend metrics on
 *  a 57 px outer radius: ring centreline 52.4 px stroked 9.4 px; X bbox
 *  48 x 70 px (arms ~31 deg from vertical, butt-cut), stroke 10.3 px, its
 *  reach stopping one ring-width short of the ring's inner edge. */
function drawClosed(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
	const circle = new Path2D();
	circle.arc(x, y, s * 0.92, 0, Math.PI * 2);
	const hw = s * 0.35;
	const hh = s * 0.56;
	const cross = new Path2D();
	cross.moveTo(x - hw, y - hh);
	cross.lineTo(x + hw, y + hh);
	cross.moveTo(x + hw, y - hh);
	cross.lineTo(x - hw, y + hh);
	// One white pass under both inks (the haloStroke recipe, interleaved by
	// hand): the X's halo must not notch the ring where the two come close.
	ctx.lineJoin = 'round';
	ctx.strokeStyle = HALO;
	ctx.lineWidth = s * 0.165 + 2;
	ctx.stroke(circle);
	ctx.lineWidth = s * 0.18 + 2;
	ctx.stroke(cross);
	ctx.strokeStyle = CLOSED_INK;
	ctx.lineWidth = s * 0.165;
	ctx.stroke(circle);
	ctx.lineWidth = s * 0.18;
	ctx.stroke(cross);
}

/** Draw the aerodrome symbol for `a` centred at (x, y); `s` is the disc radius
 *  (see airportSymbolSize). The layer passes a larger `s` for a selection. */
export function drawAirportSymbol(
	ctx: CanvasRenderingContext2D,
	a: Airport,
	x: number,
	y: number,
	s: number,
): void {
	const kind = facilityKind(a.type);
	if (kind === 'closed') {
		drawClosed(ctx, x, y, s);
		return;
	}
	if (kind === 'emergency') {
		drawEmergencyAerodrome(ctx, x, y, s);
		return;
	}
	if (kind === 'heliport') {
		drawHeliport(ctx, x, y, s, airportStatus(a));
		return;
	}
	if (kind === 'seaplane') {
		drawSeaplane(ctx, x, y, s, airportStatus(a));
		return;
	}
	// aerodrome (fixed-wing + balloonport)
	drawAerodromeBody(ctx, a, x, y, s, airportStatus(a));
}
