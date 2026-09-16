/* Shared types for the VerticalProfile primitive + VerticalProfileModal.
 *
 * The primitive draws a stacked-airspace-style altitude diagram from a
 * flat list of columns and zero-or-more horizontal overlay bands.
 * Knowing nothing about airspaces or NOTAMs lets the same component
 * serve multiple call sites: the NOTAM detail panel (this commit),
 * the map's right-click "altitude profile here" action (this commit),
 * and any future per-aerodrome / compare-two-NOTAMs use cases. */

import { airspaceBadge, type Airspace } from '$lib/data/airspaces';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import { exactFt, formatVLimit, vExtent, type GroundBand } from '$lib/vertical/limits';

/** Resolve an airspace's column extents in feet AMSL for a profile drawn
 *  over ground of known elevation (a point, so both ends of the band are the
 *  same figure). AGL / ASFC limits resolve
 *  exactly (height + ground); with the ground unknown they draw at face
 *  value, the chart's honest best. An UNL ceiling comes back `topOpen`
 *  (upperFt Infinity) so the caller draws an open-topped column and keeps
 *  the sentinel out of its chart-ceiling calculation. */
export function columnFeet(
	a: Pick<Airspace, 'vLower' | 'vUpper'>,
	ground: GroundBand,
): { lowerFt: number; upperFt: number; known: boolean; topOpen: boolean } {
	const topOpen = a.vUpper?.unl === true;
	// The floor rides the low end of the ground and the ceiling the high one.
	// For these profiles the two are the same reading, since the ground is a
	// single probed point; the band keeps the two edges distinguishable for
	// the day this chart is drawn over a footprint.
	const lowerFt = a.vLower ? (exactFt(a.vLower, ground.minFt) ?? a.vLower.ft) : 0;
	const upperFt =
		a.vUpper && !topOpen ? (exactFt(a.vUpper, ground.maxFt) ?? a.vUpper.ft) : Infinity;
	return { lowerFt, upperFt, known: vExtent(a.vLower, a.vUpper) === 'known', topOpen };
}

/** Compact "type + name" for an airspace label row, capped at 16
 *  characters: "FRA FRANCE FRA…". The truncation prefers a word boundary
 *  in the latter 60 % of the budget; the hover tooltip keeps the full
 *  string. Shared by the map and NOTAM altitude-profile modals. */
export function shortLabel(a: Airspace): string {
	const full = a.name ? `${a.type} ${a.name}` : a.type;
	return truncate(full, 16);
}

export function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	// Reserve one cell for the ellipsis so the rendered string is at
	// most `max` characters wide.
	const cut = s.slice(0, max - 1);
	const lastSpace = cut.lastIndexOf(' ');
	if (lastSpace > (max - 1) * 0.6) {
		return cut.slice(0, lastSpace) + '…';
	}
	return cut + '…';
}

/** Vocabulary for the column tooltips, so this module stays locale-free
 *  (docs/i18n.md rule 6): built from `t` at the call sites, inside a
 *  $derived, so the labels follow the locale. */
export interface ColumnVocab {
	/** t.detail.unknownLimit: the missing-limit word. */
	unknownLimit: string;
	/** t.data.airspaceTypes: the localized airspace-type dictionary. */
	airspaceTypes: Record<string, string>;
}

function columnTooltip(a: Airspace, vocab: ColumnVocab): string {
	const lo = formatVLimit(a.vLower) || vocab.unknownLimit;
	const up = formatVLimit(a.vUpper) || vocab.unknownLimit;
	const head = a.airClass ? `${a.type} ${a.airClass}` : a.type;
	const name = a.name ? ` ${a.name}` : '';
	const typeLabel = vocab.airspaceTypes[a.type] ?? a.type;
	return `${typeLabel} (${head}${name})\n${lo} – ${up}`;
}

/** One VerticalColumn per airspace for the point profiles (the map's
 *  "Altitude profile here", the detail panels' charts). Datum-aware extents
 *  against the point's ground via columnFeet (AGL limits sit above the
 *  terrain; UNL ceilings draw open-topped); R/D/P zones carry the red
 *  designator chip and the rest their ICAO class chip (AirspaceList's
 *  style). `highlightKey` marks the airspace panel's own subject column,
 *  drawn at full opacity while the rest dim. */
export function airspaceColumns(
	list: readonly Airspace[],
	ground: GroundBand,
	vocab: ColumnVocab,
	highlightKey: string | null = null,
): VerticalColumn[] {
	return list.map((a) => {
		const chip = airspaceBadge(a);
		const feet = columnFeet(a, ground);
		return {
			id: a.key,
			label: columnTooltip(a, vocab),
			shortLabel: shortLabel(a),
			badge: chip?.text,
			badgeKind: chip?.kind,
			color: `var(--airspace-${a.category})`,
			category: a.category,
			lowerText: formatVLimit(a.vLower),
			lowerFt: feet.lowerFt,
			upperFt: feet.upperFt,
			knownExtent: feet.known,
			topOpen: feet.topOpen,
			highlight: highlightKey != null && a.key === highlightKey,
		};
	});
}

/* ---- The altitude window ---------------------------------------------- */

/* One rule for both point-profile surfaces (the map's "Altitude profile here",
 * the panels' own charts), replacing the ceiling derived MapProfileModal and
 * detail/AltitudeProfile each carried.
 *
 * The problem it solves: French structure puts a FIR (SFC-FL 195), an LTA or a
 * UTA in nearly every stack, all with PUBLISHED finite tops, so an axis scaled
 * to the tallest column runs GND-FL 200+ and a 0-1500 ft CTR gets 7 % of the
 * plot. The window is SkyDemon's automatic decluttering: draw the band the
 * pilot is flying, perforate what crosses it, drop what lies outside it and SAY
 * SO (the surfaces put windowNoteText in their header). */

/** Window top with no altitude filter on. Mirrors the filter's own 0-10000
 *  default, so switching the filter off does not change the chart's scale. */
const DEFAULT_TOP_FT = 10000;
/** Air kept above a known ground, so the terrain band can never fill the plot
 *  (a 9000 ft alpine point with a thin stack over it). */
const AIR_ABOVE_GROUND_FT = 2000;
/** Narrowest window drawn. A single-level filter band is legal
 *  (floor === ceiling) and would otherwise be a zero-span axis. */
const MIN_SPAN_FT = 1000;
/** FL 660, the top of the published structure (UIR ceilings). Past it is a
 *  data error, not a view. */
const MAX_TOP_FT = 66000;
/** Must-show edges get 1 ft of headroom, so an edge landing exactly ON a step
 *  multiple ends up INSIDE the window once the top is rounded up (the rounding
 *  is a no-op on a multiple, which would weld the band to the frame). */
const MUST_SHOW_HEADROOM_FT = 1;

export interface ProfileWindow {
	/** Bottom of the Y axis, ft. 0 = GND, the usual case. */
	floorFt: number;
	/** Top of the Y axis, ft. Always a tick multiple (see windowTicks). */
	ceilingFt: number;
}

/** What the window rule needs of a column: the extents columnFeet resolved. */
export type ColumnExtent = Pick<
	VerticalColumn,
	'lowerFt' | 'upperFt' | 'knownExtent' | 'topOpen' | 'highlight'
>;

/** A band that must stay wholly inside the window. VerticalOverlay's own
 *  shape: a null side is unbounded and constrains nothing. */
export type MustShowBand = Pick<VerticalOverlay, 'floorFt' | 'ceilingFt'>;

export interface ProfileWindowInput {
	/** The columns the chart will plot, extents already resolved by columnFeet. */
	columns: readonly ColumnExtent[];
	/** activeAltitudeBand(), or null when the filter is off. The filter IS the
	 *  user's statement of what they are flying, and its 0-10000 default is
	 *  exactly the VFR-relevant window, so its ceiling is the default top and
	 *  its floor the window floor. */
	band?: { floor: number; ceiling: number } | null;
	/** Bands that must stay wholly inside: the NOTAM panel's own F)/G) band is
	 *  the SUBJECT of that chart and its floor can be FL 095. Pass the caller's
	 *  own overlays, never the altitude-filter outline, which is derived FROM
	 *  the window. */
	mustShow?: readonly MustShowBand[];
	/** Ground elevation (ft AMSL) under the profiled point, null if unknown. */
	groundFt?: number | null;
}

/** Terrain-corrected extents, the clamp VerticalProfile applies when it places
 *  the rect: an SFC/GND floor sits ON the terrain, so a column never draws
 *  below the ground, and its top never below its own floor. An unknown extent
 *  spans the window (that is how it draws) and is reported unbounded, so it can
 *  neither be cropped nor culled. */
function extentOf(c: ColumnExtent, ground: number): { lowerFt: number; upperFt: number } {
	if (!c.knownExtent) {
		return { lowerFt: -Infinity, upperFt: Infinity };
	}
	const lowerFt = Math.max(c.lowerFt, ground);
	const upperFt =
		c.topOpen || !Number.isFinite(c.upperFt) ? Infinity : Math.max(c.upperFt, lowerFt);
	return { lowerFt, upperFt };
}

/** The window the chart draws. Pure; pinned by tests/verticalProfile.spec.ts. */
export function profileWindow(input: ProfileWindowInput): ProfileWindow {
	const { columns, band = null, mustShow = [], groundFt = null } = input;
	const ground = groundFt ?? 0;

	// FLOOR: the user's own statement, never derived from the data. A
	// high-based stack (a lone LTA at FL 115) is answered by an empty lower
	// half; un-anchoring the axis from the surface would cost the GND label and
	// the terrain band their meaning.
	let floorFt = band ? Math.max(0, band.floor) : 0;
	// Except for a must-show band below it: the panels list their NOTAM whatever
	// the filter says (linked lists always show), so its band has to fit even
	// when the filter would have excluded it.
	for (const o of mustShow) {
		if (o.floorFt != null && Number.isFinite(o.floorFt)) {
			floorFt = Math.min(floorFt, Math.max(0, o.floorFt));
		}
	}

	// The decluttering choice.
	const wantTop = band ? band.ceiling : DEFAULT_TOP_FT;

	// The data, so a low stack leaves no dead sky above it. An open-topped (UNL)
	// column contributes only its floor: its Infinity must not blow the range
	// (route/routeProfile's computeCeilingFt rule).
	let dataTop = floorFt;
	let dataBottom = Infinity;
	for (const c of columns) {
		if (!c.knownExtent) {
			continue;
		}
		const { lowerFt, upperFt } = extentOf(c, ground);
		const top = Number.isFinite(upperFt) ? upperFt : lowerFt;
		if (top > dataTop) {
			dataTop = top;
		}
		if (lowerFt < dataBottom) {
			dataBottom = lowerFt;
		}
	}
	if (ground > dataTop) {
		dataTop = ground;
	}
	const hasData = dataTop > floorFt;

	// What must stay visible whatever the filter says.
	let mustTop = ground > floorFt ? ground + AIR_ABOVE_GROUND_FT : floorFt;
	for (const o of mustShow) {
		if (o.floorFt != null && Number.isFinite(o.floorFt)) {
			mustTop = Math.max(mustTop, o.floorFt + MUST_SHOW_HEADROOM_FT);
		}
		if (o.ceilingFt != null && Number.isFinite(o.ceilingFt)) {
			mustTop = Math.max(mustTop, o.ceilingFt);
		}
	}
	// The focus column is the airspace panel's own subject, re-added there even
	// when the filter excluded it: a chart about everything EXCEPT its subject is
	// the wrong chart. Only its FLOOR counts, so a subject running to FL 660
	// perforates instead of flattening the rest of the stack.
	const focus = columns.find((c) => c.highlight === true && c.knownExtent);
	if (focus) {
		const ext = extentOf(focus, ground);
		mustTop = Math.max(mustTop, ext.lowerFt + MUST_SHOW_HEADROOM_FT);
		if (ext.upperFt <= floorFt) {
			floorFt = Math.max(0, ext.lowerFt);
		}
	}

	let ceilingFt = Math.max(hasData ? Math.min(wantTop, dataTop) : wantTop, mustTop);

	// The window may never hide the WHOLE stack: with the filter off (or in
	// "only on map" mode with the low categories hidden) a stack can sit
	// entirely above the default top. Fall back to the data.
	const anyDrawn = columns.some((c) => {
		const ext = extentOf(c, ground);
		return !(ext.lowerFt >= ceilingFt || ext.upperFt <= floorFt);
	});
	if (columns.length > 0 && !anyDrawn) {
		if (Number.isFinite(dataBottom)) {
			floorFt = Math.min(floorFt, dataBottom);
		}
		ceilingFt = Math.max(ceilingFt, dataTop);
	}

	// A single-level band is legal; raise the top, never lower the user's floor.
	ceilingFt = Math.max(ceilingFt, floorFt + MIN_SPAN_FT);
	// Round onto the axis step, so the top frame is always a labelled gridline.
	// Past the clamp, round DOWN onto the step instead of stopping at a bare
	// 66000: a UIR reaching FL 660 then perforates like any other crossing
	// column, which is the honest reading either way, and the axis keeps its
	// labelled top edge.
	const step = tickStepFt(ceilingFt - floorFt);
	const rounded = Math.ceil(ceilingFt / step) * step;
	ceilingFt = rounded <= MAX_TOP_FT ? rounded : Math.floor(MAX_TOP_FT / step) * step;
	return { floorFt, ceilingFt };
}

export interface WindowColumns {
	/** The columns the chart draws, in the caller's order, each carrying the
	 *  perforation flags for the edges the window crops. */
	drawn: VerticalColumn[];
	/** Airspaces DROPPED because they lie entirely above the window. Only these
	 *  need stating (windowNoteText): a column that merely crosses the top edge
	 *  is on screen with a perforated edge already saying it continues. */
	hiddenAbove: number;
	/** The mirror below the window floor; only reachable with a raised filter
	 *  floor or a zoomed-in window. */
	hiddenBelow: number;
}

/** Split the columns against the window: crop flags for what crosses an edge,
 *  and drop what lies entirely outside it. A 2 px sliver welded to the frame is
 *  indistinguishable from a column that really stops there, and it would be
 *  hoverable and clickable, so it would offer an airspace the chart is not
 *  about; the count goes in the header instead. */
export function windowColumns(
	columns: readonly VerticalColumn[],
	win: ProfileWindow,
	groundFt: number | null,
): WindowColumns {
	const ground = groundFt ?? 0;
	const drawn: VerticalColumn[] = [];
	let hiddenAbove = 0;
	let hiddenBelow = 0;
	for (const c of columns) {
		const { lowerFt, upperFt } = extentOf(c, ground);
		// An unknown extent yields +/-Infinity, so knownExtent gates every flag:
		// a dashed full-height outline already says "extent unknown", and a
		// perforation there would assert a fact we do not have.
		const cutTop = c.knownExtent && upperFt > win.ceilingFt;
		const cutBottom = c.knownExtent && lowerFt < win.floorFt;
		if (c.knownExtent && lowerFt >= win.ceilingFt) {
			hiddenAbove++;
			continue;
		}
		if (c.knownExtent && upperFt <= win.floorFt) {
			hiddenBelow++;
			continue;
		}
		drawn.push({ ...c, cutTop, cutBottom });
	}
	return { drawn, hiddenAbove, hiddenBelow };
}

/** Gridline step (ft) for a window span. The route profile's ladder
 *  (routeProfile.yTicks) MINUS its 500 and 2500 ft rungs: this axis is
 *  FL-worded with no transition altitude to fall back on (the deliberate
 *  non-goal in docs/route-profile.md), and "FL 005" / "FL 025" are not levels.
 *  Every rung here is a multiple of 1000 ft, so every label is a plausible
 *  FL 0x0. */
export function tickStepFt(spanFt: number): number {
	return spanFt <= 6000
		? 1000
		: spanFt <= 16000
			? 2000
			: spanFt <= 32000
				? 5000
				: spanFt <= 60000
					? 10000
					: 20000;
}

/** Axis label for a level, the published-limit vocabulary of these charts: the
 *  floor of the world is GND, everything above it is a flight level.
 *  Locale-invariant (ICAO Doc 8400; docs/i18n.md rule 10). */
export function levelLabel(ft: number): string {
	// i18n-ignore-start: invariant ICAO altitude tokens, not display text
	return ft <= 0 ? 'GND' : 'FL ' + String(Math.round(ft / 100)).padStart(3, '0');
	// i18n-ignore-end
}

/** Gridline ticks inside a window: step multiples from the first one at or
 *  above the floor (the route profile's yTicks shape). `maxTicks` lets a short
 *  chart (a nearly collapsed bottom dock, the 160 px inline chart with its
 *  badge row) thin the ladder; doubling keeps every kept rung on the 1000 ft
 *  grid, so the labels stay FL 0x0. */
export function windowTicks(
	win: ProfileWindow,
	maxTicks = Infinity,
): { ft: number; label: string }[] {
	const span = Math.max(1, win.ceilingFt - win.floorFt);
	let step = tickStepFt(span);
	while (maxTicks >= 2 && span / step + 1 > maxTicks) {
		step *= 2;
	}
	const out: { ft: number; label: string }[] = [];
	for (let ft = Math.ceil(win.floorFt / step) * step; ft <= win.ceilingFt + 0.5; ft += step) {
		out.push({ ft, label: levelLabel(ft) });
	}
	return out;
}

/** Does an overlay band span the whole window? Then it carries nothing: the
 *  altitude filter's dashed outline would trace the plot frame (the window IS
 *  that band in the common case), and a fill would cover everything. The chart
 *  skips it. A band narrower on either side is genuine information and stays.
 *  Read here rather than in the surfaces because the window is live: zooming
 *  out past the band turns it back into a sub-band. */
export function overlayCoversWindow(o: MustShowBand, win: ProfileWindow): boolean {
	return (o.floorFt ?? -Infinity) <= win.floorFt && (o.ceilingFt ?? Infinity) >= win.ceilingFt;
}

/* ---- Window gestures -------------------------------------------------- */
/* The wheel curve (wheelZoomFactor) and the pointer machine live in
 * $lib/ui/plotGestures.ts, shared with RouteProfile.svelte. */

/** Smallest altitude window a zoom may reach, the route profile's own figure. */
export const WINDOW_MIN_SPAN_FT = 1000;

/** How far out the window may be zoomed or panned, as against profileWindow's
 *  default view: the data's own top, so everything the stack holds is
 *  reachable. topOpen / non-finite ceilings are excluded (one UNL FIR column
 *  would peg every chart at the clamp) and unknown extents state nothing; an
 *  overlay ceiling counts, because a band the chart draws has to be reachable.
 *  Floored at the default 10000 ft window so zooming out always has somewhere
 *  to go. Pure. */
export function profileBounds(
	columns: readonly ColumnExtent[],
	opts?: { overlayCeilingFt?: number },
): { minFt: number; maxFt: number } {
	let max = DEFAULT_TOP_FT;
	for (const c of columns) {
		if (!c.knownExtent || c.topOpen || !Number.isFinite(c.upperFt)) {
			continue;
		}
		if (c.upperFt > max) {
			max = c.upperFt;
		}
	}
	const overlay = opts?.overlayCeilingFt ?? 0;
	if (Number.isFinite(overlay) && overlay > max) {
		max = overlay;
	}
	return { minFt: 0, maxFt: Math.min(Math.ceil(max / 500) * 500, MAX_TOP_FT) };
}

/* ---- "What is above you here?" ---------------------------------------- */

/* SkyDemon's PLOG has the precedent as its "Airspace Above" column: "gives you
 * a ceiling to fly below based on the next controlled or dangerous airspace
 * above you". The chart draws the whole stack; this states the one number a
 * pilot acts on. */

/** The airspace categories that count as a ceiling to fly below. `controlled`
 *  always needs a clearance and applies as charted; `restricted` (P / R / D /
 *  W / A / MOA) publishes the limits of a prohibition or a hazard. The others
 *  are DRAWN but not counted, because their answer is conditional rather than a
 *  wall: `transit` (TRA / TSA) is entry by arrangement and scheduled,
 *  `trafficmgmt` (RMZ / TMZ) is an equipment-and-a-call requirement, `siv` is an
 *  information service whose boundary is not a limit (it draws strokeless on the
 *  SIA chart for that reason), `fir` is the volume you are already inside, and
 *  `activity` never reaches a profile (state/profile.svelte.ts drops it) except
 *  as an airspace panel's own re-added subject. */
export const CEILING_CATEGORIES: ReadonlySet<AirspaceCategory> = new Set<AirspaceCategory>([
	'controlled',
	'restricted',
]);

/** The base the chart DRAWS for a column, in feet: airspaces start at the
 *  ground, so an SFC or below-ground floor clamps up to it. Shared with the
 *  chart's own placement, so a readout can never name a base the chart did not
 *  draw. Pure. */
export function drawnBaseFt(c: Pick<VerticalColumn, 'lowerFt'>, groundFt: number | null): number {
	return Math.max(c.lowerFt, groundFt ?? 0);
}

export interface AirspaceAbove {
	/** The counted column whose base is the ceiling, null when nothing counted
	 *  sits above the reference. */
	column: VerticalColumn | null;
	/** That base in feet AMSL, ground-clamped like the drawn column. */
	baseFt: number | null;
	/** Free height between the reference and that base, 0 for a surface-based
	 *  volume (the honest answer); Infinity when nothing counted is above. */
	freeFt: number;
}

/** The lowest counted airspace base at or above the reference altitude, and the
 *  free height under it. `refFt` defaults to the ground: the PLOG question,
 *  asked from the surface.
 *
 *  Skipped: categories outside CEILING_CATEGORIES; unknown extents, since an
 *  unpublished limit can state no base; and any volume whose base is BELOW the
 *  reference, i.e. one you are already inside or under, the question being what
 *  is above. A surface-based volume therefore reports its base AT the ground
 *  with 0 ft free, which is exactly "you are under a CTR from the ground".
 *
 *  Ties keep the FIRST in the given order, which at both call sites is
 *  compareAirspaceByBand's highest-band-first, smallest-area-first. Pure. */
export function airspaceAbove(
	columns: readonly VerticalColumn[],
	groundFt: number | null,
	refFt?: number,
): AirspaceAbove {
	const ref = refFt ?? groundFt ?? 0;
	let best: VerticalColumn | null = null;
	let bestFt = Infinity;
	for (const c of columns) {
		if (!c.knownExtent || c.category == null || !CEILING_CATEGORIES.has(c.category)) {
			continue;
		}
		const base = drawnBaseFt(c, groundFt);
		if (base < ref || base >= bestFt) {
			continue;
		}
		best = c;
		bestFt = base;
	}
	return best === null
		? { column: null, baseFt: null, freeFt: Infinity }
		: { column: best, baseFt: bestFt, freeFt: bestFt - ref };
}

/* ---- Chart gutters ---------------------------------------------------- */

/* The chart's own padding, exported so a surface can line an altitude slider up
 * with the gridlines the chart draws: unaligned, its GND handle would sit a
 * label row (110 px) away from the GND line. VerticalProfile is the only other
 * reader, so there is one writer. */
export const PAD_L = 36; // room for FL labels
export const PAD_R = 6;
export const PAD_T = 8;
export const PAD_B_BASE = 14; // room for the "GND" axis label
/** 110 px at a 10 px font fits ~16 vertical characters plus the class chip. */
export const LABEL_ROW_H = 110;
export const BADGE_ROW_H = 18;

/** The chart's vertical gutters for a column set at a given column width: the
 *  label row is reserved only when labels are on AND a column has one, the
 *  chip-only row only when the columns are wide enough for a chip to read (the
 *  same 16 px gate the chips render behind). Pure. */
export function chartPads(
	columns: readonly VerticalColumn[],
	opts: { showLabels: boolean; colW: number },
): { padT: number; padB: number } {
	const gapPx = Math.max(1, Math.min(4, opts.colW * 0.15));
	const hasLabels =
		opts.showLabels && columns.some((c) => c.shortLabel != null && c.shortLabel !== '');
	const hasBadges =
		opts.colW - gapPx >= 16 && columns.some((c) => c.badge != null && c.badge !== '');
	return {
		padT: PAD_T,
		padB: PAD_B_BASE + (hasLabels ? LABEL_ROW_H : hasBadges ? BADGE_ROW_H : 0),
	};
}

/** Vocabulary pack for windowNoteText, so this module stays locale-free
 *  (docs/i18n.md rule 6): `t.detail` satisfies it. */
export interface WindowNoteVocab {
	profileWindowAbove: (p: { top: string; n: number }) => string;
	profileWindowBelow: (p: { bottom: string; n: number }) => string;
}

/** The disclosure the window owes the reader: how many airspaces it left out
 *  entirely, and at which level. Undefined when it left none out, which is the
 *  common case, so the header carries nothing. Deliberately silent about the
 *  window itself: its top and bottom are the labelled gridlines, and a column
 *  crossing an edge is perforated there. */
export function windowNoteText(
	win: ProfileWindow,
	split: Pick<WindowColumns, 'hiddenAbove' | 'hiddenBelow'>,
	v: WindowNoteVocab,
): string | undefined {
	const parts: string[] = [];
	if (split.hiddenAbove > 0) {
		parts.push(v.profileWindowAbove({ top: levelLabel(win.ceilingFt), n: split.hiddenAbove }));
	}
	if (split.hiddenBelow > 0) {
		parts.push(v.profileWindowBelow({ bottom: levelLabel(win.floorFt), n: split.hiddenBelow }));
	}
	return parts.length > 0 ? parts.join(' · ') : undefined;
}

export interface VerticalColumn {
	/** Caller-defined key. Echoed back to `onColumnClick` so the
	 *  caller can map it to whatever entity the column represents
	 *  (an Airspace, an aerodrome, ...). */
	id: string;
	/** Tooltip + aria-label text shown on the column. Multi-line OK
	 *  (newlines render as actual newlines in <title>). */
	label: string;
	/** Optional short label rendered as vertical text in a row
	 *  below the plot (when the chart's column width allows it).
	 *  e.g. "TMA RENNES 1", "R 254". The label row clips strings
	 *  beyond ~12 characters, so callers can either pass full
	 *  names and accept the clip or pre-truncate. */
	shortLabel?: string;
	/** Optional 1-3 character badge rendered at the bottom of the
	 *  column itself (inside the column rect). Used today for the
	 *  ICAO airspace class letter (A-G) and the R / D / P special-use
	 *  designator; generic enough to host other tiny chips. */
	badge?: string | undefined;
	/** Visual style for `badge`: `'class'` (default) draws the accent-blue
	 *  ICAO-class chip; `'zone'` draws it in the restricted-airspace red,
	 *  used for the R / D / P designator. */
	badgeKind?: 'class' | 'zone' | undefined;
	/** CSS colour or `var(--…)`; used for both fill and stroke. */
	color: string;
	/** Lower altitude in feet AGL/AMSL (the primitive doesn't care
	 *  which datum; the caller is responsible for using one). */
	lowerFt: number;
	/** Upper altitude in feet. */
	upperFt: number;
	/** When false, the column is drawn as a dashed full-height outline
	 *  so the user knows the vertical extent is unknown rather than
	 *  zero-width. */
	knownExtent: boolean;
	/** Published UNL ceiling: the column runs to the chart top with a
	 *  perforated top edge (continues above), and the caller keeps its
	 *  Infinity out of the chart-ceiling autoscale. */
	topOpen?: boolean | undefined;
	/** Set by `windowColumns`: the column's real top is above the window, so its
	 *  top edge is perforated. One vocabulary with `topOpen` on purpose, since a
	 *  perforated edge means "the drawn cap is not the real limit"; WHICH of the
	 *  two it is stays in `label`, which the window never touches. */
	cutTop?: boolean | undefined;
	/** The mirror: the real floor is below the window. */
	cutBottom?: boolean | undefined;
	/** Airspace category, so the chart's own data can answer "what is above
	 *  you". The primitive never reads it; only `airspaceAbove`'s counted-category
	 *  rule does. */
	category?: AirspaceCategory | undefined;
	/** The floor AS PUBLISHED (`formatVLimit` output: "FL 115", "800 ft ASFC",
	 *  "SFC"), so a readout can name a base the way the AIP filed it rather than
	 *  as a re-derived AMSL figure. Locale-invariant. */
	lowerText?: string | undefined;
	/** Marks the focus column (e.g. the selected airspace in the airspace
	 *  detail panel): drawn at full opacity with an accent outline, while
	 *  the other columns dim so it stands out. Optional; absent on the
	 *  NOTAM / map / aerodrome profiles, which highlight nothing. */
	highlight?: boolean;
}

export interface VerticalOverlay {
	/** `fill` renders a translucent rect; `outline` renders a dashed
	 *  rectangular outline (useful for "filter window" overlays so
	 *  they don't drown out the underlying fill overlay). */
	kind: 'fill' | 'outline';
	/** Bottom of the band, in feet. Null = the window floor. */
	floorFt: number | null;
	/** Top of the band, in feet. Null = the window ceiling. */
	ceilingFt: number | null;
	/** CSS colour or `var(--…)`. */
	color: string;
	/** Tooltip + accessibility label, rendered as the overlay rect's
	 *  <title> (shown on hover over the band). */
	label: string;
}
