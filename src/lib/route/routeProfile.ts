/* Shared geometry, types and draw-ready builders for the route vertical profile
 * (RouteProfile.svelte + RouteProfileModal.svelte + the flight-dossier print
 * doc). The X/Y window transforms, tick ladders and band builders live here,
 * kept free of Svelte so the pure pieces (xOf / yOf / xTicks / yTicks /
 * computeCeilingFt / buildBands / buildRouteProfileDoc) are unit-testable in
 * Node. */

import type { Airspace } from '$lib/data/airspaces';
import { zoneEntryAction, type EntryConditions } from '$lib/data/airspaceEntry';
import { cloudAmountLabel, cloudOktas, type CloudCoverLevel } from '$lib/weather/openMeteo';
import { formatVLimit, vExtent, type VExtent, type VLimit } from '$lib/vertical/limits';
import { computeAirspaceCorridorSpans, type AirspaceCorridorBand, type AirspaceSpan } from '$lib/route/airspaces';
import { computeNavLog, waypointLabel } from '$lib/route/navlog';
import { fmtLevel, fmtNM } from '$lib/route/format';
import { isRtba } from '$lib/map/airspaceSymbology';
import type { AirspaceCategory } from '$lib/state/layers.svelte';
import type { Waypoint } from '$lib/state/route.svelte';
import { sampleCeilingFt, sampleFloorFt, type TerrainSample } from '$lib/map/terrain';

export type { TerrainSample };

/** Vertical padding shared by the plot and the axis so `yOf` aligns in both.
 *  PAD_T holds the waypoint-ident row along the top; PAD_B the X-axis distance
 *  labels (the axis SVG reserves the same heights though it draws nothing
 *  there). */
export const PAD_T = 28;
export const PAD_B = 22;
/** Left gutter of the plot SVG holding the GND / FL altitude labels (kept
 *  inside the one SVG so a landscape print scales the whole chart, axis
 *  included, to the page with a single viewBox); PAD_R is the right margin. */
export const PAD_L = 46;
export const PAD_R = 16;

/** One waypoint reduced to what the chart draws. */
export interface ProfileWaypoint {
	distNM: number;
	altFt: number;
	/** Ident-only label drawn along the top (blank for a bare coordinate). */
	label: string;
	/** Full name for the hover tooltip (ident / custom name / coordinates). */
	name: string;
}

/** One drawable span of a band, with its edges resolved to chart feet. */
export interface PlacedSpan {
	enterNM: number;
	leaveNM: number;
	/** Distance-ordered edge vertices: two points (flat) for AMSL / FL /
	 *  unknown-datum limits, terrain-following for AGL/ASFC ones (height
	 *  added to each terrain sample inside the span). upperPts is empty for
	 *  an open-topped (UNL) band: the chart draws it to the window top. */
	lowerPts: AltitudeVertex[];
	upperPts: AltitudeVertex[];
	/** Drawn vertical bounds of the span (label parking + culling); topFt
	 *  is Infinity for an open-topped band. */
	botFt: number;
	topFt: number;
}

/** A draw-ready airspace band: colours + feet + chip + tooltip + spans. */
export interface PlacedBand {
	key: string;
	/** CSS colour, `var(--airspace-...)`. */
	color: string;
	/** Airspace category, keying the activation-hatch pattern colour. NOTAM
	 *  bands (PlacedNotamBand) carry a nominal value, never hatched by it. */
	category: AirspaceCategory;
	/** Airspace class letter ('' when none / NOTAM bands): the penetration
	 *  flagging exempts class E under VFR (SERA.6001: E is controlled for
	 *  IFR only; a VFR flight needs neither radio nor clearance there). */
	airClass: string;
	/** Airspace type designator ('P', 'R', 'CTR', ...; '' for NOTAM bands):
	 *  feeds the forbidden-crossing tier (P always, R when active). */
	type: string;
	/** The zone's published entry conditions per traffic category (NO_ENTRY
	 *  for NOTAM bands): the forbidden-crossing tier reads them through the
	 *  shared zoneEntryAction, so a band and the live banner grade alike. */
	entry: EntryConditions;
	/** Prohibited-area NOTAM band (Q subject RP); false for airspace bands.
	 *  A crossing of one is forbidden regardless of rules or activation. */
	prohibited: boolean;
	/** French RTBA network zone (isRtba on the airspace id): the band keeps
	 *  its GEN 2.3 pecked identity outline, always drawn; the activation
	 *  hatch stays the separate "hot now" mark. */
	rtba: boolean;
	/** Face-value floor in its own datum, the paint order key (lowest first). */
	lowerFt: number;
	/** False when either vertical limit is missing -> draw dashed full-height. */
	knownExtent: boolean;
	/** How much of the extent the publisher stated, which the crossings
	 *  strip reports beside a band it could only judge laterally. */
	extent: VExtent;
	/** Published UNL ceiling: spans draw to the window top, and the chart
	 *  ceiling autoscale ignores this band. */
	topOpen: boolean;
	/** Drawn vertical bounds across all spans, for window culling (an AGL
	 *  band over high ground sits far above its face values). maxFt is
	 *  Infinity when `topOpen`. */
	minFt: number;
	maxFt: number;
	/** In-chart label drawn after the chip and elided to the band width: the short
	 *  type prefixed to the name ("TMA RENNES 4") so a glance reads the kind. R/D/P
	 *  keep the bare name (their chip already shows the designator, so "R" + "212"
	 *  reads "R 212"). '' when the source has neither name nor type. The full
	 *  type + class + name + limits stays in `tooltip`. */
	label: string;
	badge: string | null;
	badgeKind: 'class' | 'zone' | null;
	/** "lower – upper" via formatVLimit (the tooltip's second line), printed
	 *  as a second in-band label line when the band is tall and wide enough. */
	limitsText: string;
	tooltip: string;
	spans: PlacedSpan[];
}

/** Distance (NM) -> x px within the visible window [fromNM, toNM], mapped onto
 *  the inner plot width innerW (from at the left gutter edge, to at the right).
 *  Linear (NOT clamped): out-of-window features are cropped by the chart's clip
 *  rect, which keeps the silhouette honest at the edges. */
export function xOf(distNM: number, fromNM: number, toNM: number, innerW: number): number {
	const span = Math.max(1e-6, toNM - fromNM);
	return PAD_L + ((distNM - fromNM) / span) * innerW;
}

/** Altitude (ft) -> y px within the visible window [floorFt, ceilingFt], mapped
 *  onto the inner plot height innerH (ceiling at the top, floor at the bottom).
 *  Linear (NOT clamped); cropping is the chart's clip rect, same as xOf. */
export function yOf(ft: number, floorFt: number, ceilingFt: number, innerH: number): number {
	const span = Math.max(1, ceilingFt - floorFt);
	return PAD_T + ((ceilingFt - ft) / span) * innerH;
}

/** Altitude gridline ticks within the visible window [floorFt, ceilingFt]. The
 *  step shrinks with the window span, so zooming into a low window shows finer
 *  marks (down to 500 ft). Labels follow the app's level vocabulary
 *  (docs/cruising-levels.md): plain feet below the transition altitude,
 *  "FL xxx" strictly above it (a level equal to the TA stays an altitude,
 *  AIP France ENR 1.7.2.2, the fmtLevel rule); `taFt` null (semicircular
 *  option off, or a chart with no flight context, e.g. the GPS trace
 *  profile) keeps every tick in plain feet. The 0 ft tick prints "0": the
 *  chart baseline is sea level, not ground. */
export function yTicks(
	floorFt: number,
	ceilingFt: number,
	taFt: number | null,
): { ft: number; label: string }[] {
	const span = ceilingFt - floorFt;
	const step =
		span <= 3000 ? 500
			: span <= 6000 ? 1000
				: span <= 16000 ? 2500
					: span <= 32000 ? 5000
						: span <= 60000 ? 10000
							: 20000;
	const out: { ft: number; label: string }[] = [];
	for (let ft = Math.ceil(floorFt / step) * step; ft <= ceilingFt + 0.5; ft += step) {
		out.push({ ft, label: fmtLevel(ft, taFt ?? Infinity) });
	}
	return out;
}

/** Distance ticks within the visible window [fromNM, toNM], the interval chosen
 *  from a "nice number" ladder so labels never crowd (each >= ~56 px apart for
 *  the given inner width). Always includes the window's two ends (they carry
 *  the zoom state); a regular tick within 30 px of either end is dropped so
 *  its label cannot collide with the end label ("110 113"). */
export function xTicks(fromNM: number, toNM: number, innerW: number): number[] {
	const span = Math.max(1e-6, toNM - fromNM);
	const ladder = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
	const interval = ladder.find((d) => (d / span) * innerW >= 56) ?? ladder[ladder.length - 1];
	const clearPx = 30;
	const out: number[] = [fromNM];
	for (let m = Math.ceil(fromNM / interval) * interval; m < toNM - 1e-6; m += interval) {
		if (m > fromNM + 1e-6) {
			const px = ((m - fromNM) / span) * innerW;
			if (px >= clearPx && innerW - px >= clearPx) {
				out.push(m);
			}
		}
	}
	out.push(toNM);
	return out;
}

/** Distance tick label: a near-integer tick (within 0.05 NM) prints as a
 *  plain integer ("0", "10", "110") and only a genuinely fractional window
 *  end keeps one decimal ("112.9"). fmtNM (a prose formatter) would mix
 *  "0.0 ... 100" on one axis, which reads as differing precision. */
export function fmtNMTick(nm: number): string {
	const r = Math.round(nm);
	return Math.abs(nm - r) <= 0.05 ? String(r) : nm.toFixed(1);
}

/** Scale the window [lo, hi] by `factor` (> 1 zooms out) keeping `anchor`
 *  at the same relative position, i.e. the same pixel; the span clamps to
 *  [minSpan, max - min] and the window shifts back inside [min, max] when a
 *  bound is crossed (the anchor slips minimally then, unavoidable). Factor
 *  1 is a pure re-clamp, reused by the modal's saved-view restore. Pure. */
export function zoomWindow(
	lo: number,
	hi: number,
	anchor: number,
	factor: number,
	min: number,
	max: number,
	minSpan: number,
): [number, number] {
	const span0 = hi - lo;
	const span = Math.min(Math.max(span0 * factor, Math.min(minSpan, max - min)), max - min);
	const r = span0 > 0 ? (anchor - lo) / span0 : 0.5;
	let nlo = anchor - r * span;
	let nhi = nlo + span;
	if (nlo < min) {
		nhi += min - nlo;
		nlo = min;
	}
	if (nhi > max) {
		nlo -= nhi - max;
		nhi = max;
	}
	return [Math.max(min, nlo), nhi];
}

/** Shift the window [lo, hi] by `d`, clamped inside [min, max] with the
 *  span preserved (drag-pan; per-event incremental deltas self-correct at
 *  the bounds). Pure. */
export function panWindow(
	lo: number,
	hi: number,
	d: number,
	min: number,
	max: number,
): [number, number] {
	const span = hi - lo;
	const nlo = Math.min(Math.max(lo + d, min), Math.max(min, max - span));
	return [nlo, nlo + span];
}

/** In-place vertical de-collision: sort by (y, x1), then push each item that
 *  horizontally overlaps an earlier one down past it until it clears, so
 *  overlapping labels stack onto successive lines instead of overprinting.
 *  Operates on any { x1, x2, y, h? }; `h` is the item's own height (a
 *  two-line band label with its limits row), defaulting to `lineH`, and the
 *  push lands below the blocking item's full height. Shared by the airspace
 *  band labels and the trace profile's overflown-feature labels. */
export function stackByOverlap<T extends { x1: number; x2: number; y: number; h?: number | undefined }>(
	items: T[],
	lineH: number,
): void {
	items.sort((a, b) => a.y - b.y || a.x1 - b.x1);
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
		const ih = it.h ?? lineH;
		let settled = false;
		while (!settled) {
			settled = true;
			for (let j = 0; j < i; j++) {
				const p = items[j];
				const ph = p.h ?? lineH;
				if (it.x2 > p.x1 && it.x1 < p.x2 && it.y < p.y + ph && p.y < it.y + ih) {
					it.y = p.y + ph;
					settled = false;
				}
			}
		}
	}
}

/** Chart ceiling (ft): the max of planned altitudes, terrain, and the *drawn*
 *  airspace tops (open-topped UNL bands excluded so a single one can't blow
 *  the range; AGL tops count at their terrain-resolved height), padded 10%
 *  and rounded up to 5000, clamped to a sensible band (MapProfileModal
 *  idiom). */
export function computeCeilingFt(
	plannedAltsFt: number[],
	terrainFt: number[],
	bands: PlacedBand[],
): number {
	let max = 10000;
	for (const a of plannedAltsFt) {
		if (a > max) max = a;
	}
	for (const t of terrainFt) {
		if (t > max) max = t;
	}
	for (const b of bands) {
		if (!b.knownExtent) {
			continue;
		}
		if (b.topOpen) {
			// Open-topped (UNL): the drawn floor is the content to reach; the
			// Infinity top must not blow the range.
			if (Number.isFinite(b.minFt) && b.minFt > max) {
				max = b.minFt;
			}
		} else if (Number.isFinite(b.maxFt) && b.maxFt > max) {
			max = b.maxFt;
		}
	}
	const rounded = Math.ceil((max * 1.1) / 5000) * 5000;
	return Math.min(Math.max(rounded, 10000), 66000);
}

/** Distance-ordered edge vertices for one span of one limit: flat (two points)
 *  for AMSL / FL / unknown-datum limits or without terrain, terrain-following
 *  for AGL/ASFC ones (height added to each terrain sample inside the span,
 *  span ends anchored on the nearest sample; failed tiles fall back to the
 *  bare height). Shared with the NOTAM profile bands
 *  (route/notamProfile.ts), so their F)/G) AGL limits follow the terrain
 *  exactly like airspace bands.
 *
 *  `edge` says which end of the band is being drawn, because the two read
 *  opposite ends of each sample's ground: a FLOOR follows the lowest ground of
 *  its footprint and a CEILING the highest, so the band drawn is the whole
 *  extent the zone can occupy over that stretch rather than a slice of it. */
export function spanEdge(
	l: VLimit | null,
	span: AirspaceSpan,
	terrain: TerrainSample[],
	fallbackFt: number,
	edge: 'floor' | 'ceiling' = 'floor',
): AltitudeVertex[] {
	const groundAt = edge === 'ceiling' ? sampleCeilingFt : sampleFloorFt;
	const flat = (ft: number): AltitudeVertex[] => [
		{ distNM: span.enterNM, altFt: ft },
		{ distNM: span.leaveNM, altFt: ft },
	];
	if (!l) {
		return flat(fallbackFt);
	}
	if (l.ref !== 'AGL' || terrain.length === 0) {
		return flat(l.ft);
	}
	const pts: AltitudeVertex[] = [
		{ distNM: span.enterNM, altFt: terrainFtAt(terrain, span.enterNM, groundAt) + l.ft },
	];
	for (const s of terrain) {
		if (s.distNM > span.enterNM && s.distNM < span.leaveNM) {
			pts.push({ distNM: s.distNM, altFt: (groundAt(s) ?? 0) + l.ft });
		}
	}
	pts.push({ distNM: span.leaveNM, altFt: terrainFtAt(terrain, span.leaveNM, groundAt) + l.ft });
	return pts;
}

/** Map raw corridor bands to draw-ready bands (colour, edge polylines, chip,
 *  tooltip), ordered lowest-floor-first so higher zones paint on top. AGL /
 *  ASFC limits follow the terrain; UNL ceilings come back open-topped.
 *  `typeLabels` is the airspace-type dictionary for the tooltip head (the
 *  UI passes t.data.airspaceTypes; docs/i18n.md rule 6 vocab pack). */
export function buildBands(
	bands: AirspaceCorridorBand[],
	terrain: TerrainSample[],
	typeLabels: Record<string, string>,
): PlacedBand[] {
	return bands
		.map((b): PlacedBand => {
			const lo = formatVLimit(b.vLower) || '?';
			const hi = formatVLimit(b.vUpper) || '?';
			const head = b.airClass ? `${b.type} ${b.airClass}` : b.type;
			const name = b.name ? ` ${b.name}` : '';
			// In-chart label: prefix the short type so a glance reads "TMA RENNES 4".
			// Skip it for R / D / P, whose chip already shows the designator and whose
			// name is a bare id (chip "R" + "212" reads "R 212").
			const typePrefix = b.badge?.kind === 'zone' ? '' : b.type;
			const label =
				typePrefix && !b.name.startsWith(`${typePrefix} `) ? `${typePrefix} ${b.name}`.trim() : b.name;
			const topOpen = b.vUpper?.unl === true;
			// A ceiling the publisher did not state is UNBOUNDED, not sea
			// level. Edging it at 0 ft made every penetration test fail
			// closed on the wrong side: a route could not be inside a band
			// whose roof sat under it.
			const openTop = topOpen || b.vUpper == null;
			let minFt = Infinity;
			let maxFt = openTop ? Infinity : -Infinity;
			const spans: PlacedSpan[] = b.spans.map((span) => {
				const lowerPts = spanEdge(b.vLower, span, terrain, 0, 'floor');
				const upperPts = openTop ? [] : spanEdge(b.vUpper, span, terrain, 0, 'ceiling');
				let botFt = Infinity;
				for (const p of lowerPts) {
					if (p.altFt < botFt) botFt = p.altFt;
				}
				let topFt = openTop ? Infinity : -Infinity;
				for (const p of upperPts) {
					if (p.altFt > topFt) topFt = p.altFt;
				}
				if (botFt < minFt) minFt = botFt;
				if (topFt > maxFt) maxFt = topFt;
				return { enterNM: span.enterNM, leaveNM: span.leaveNM, lowerPts, upperPts, botFt, topFt };
			});
			return {
				key: b.key,
				color: `var(--airspace-${b.category})`,
				category: b.category,
				airClass: b.airClass,
				type: b.type,
				entry: b.entry,
				prohibited: false,
				rtba: isRtba(b.id),
				lowerFt: b.vLower?.ft ?? 0,
				knownExtent: vExtent(b.vLower, b.vUpper) === 'known',
				extent: vExtent(b.vLower, b.vUpper),
				topOpen,
				minFt,
				maxFt,
				label,
				badge: b.badge?.text ?? null,
				badgeKind: b.badge?.kind ?? null,
				limitsText: `${lo} – ${hi}`,
				tooltip: `${typeLabels[b.type] ?? b.type} (${head}${name})\n${lo} – ${hi}`,
				spans,
			};
		})
		.sort((a, b) => a.lowerFt - b.lowerFt);
}

// --- Cloud layer bands (per leg): the level samples as a piecewise-linear
// cover function of altitude, cut into contiguous same-amount bands at the
// okta-threshold crossings, so a layer's base and top sit where the
// interpolated cover crosses FEW / SCT / BKN / OVC instead of snapping to
// level-thick slabs (the amount collars grade a layer's edges). ---

/** One fetched segment of the cloud curtain: the distance span its
 *  forecast column represents plus the resolved level profile there
 *  (routeCloudCover's output, the chart's input). */
export interface CloudCoverSegment {
	fromNM: number;
	toNM: number;
	levels: CloudCoverLevel[];
}

/** One draw-ready cloud band of a segment: a vertical extent + the lowercase
 *  METAR amount word ('few' | 'sct' | 'bkn' | 'ovc') keying its opacity. */
export interface CloudLayerBand {
	botFt: number;
	topFt: number;
	amount: string;
}

/** Half-gap extension past the outer samples when the profile has a single
 *  level and no gap to mirror. */
const CLOUD_END_HALF_GAP_FT = 300;

/** The cover thresholds where the okta quantisation steps into FEW / SCT /
 *  BKN / OVC: the round-half-up inverse of cloudOktas, kept as a formula so
 *  the crossings can never drift from the quantiser. */
const CLOUD_CLASS_MIN_PCT = [1, 3, 5, 8].map((k) => (k - 0.5) * 12.5);

/** Cut one leg's cloud profile into draw-ready bands, bottom-up. The cover
 *  is constant over a mirrored half-gap beyond the outer samples (a cloudy
 *  top or bottom level keeps its thickness, and a single-level profile
 *  degenerates to the old slab); between samples it interpolates linearly,
 *  the sampleWindAt convention. Between two consecutive breakpoints (every
 *  sample altitude plus every threshold crossing) the quantised amount is
 *  constant, so each segment is classified at its midpoint and same-amount
 *  neighbours merge. */
export function cloudLayerBands(levels: CloudCoverLevel[]): CloudLayerBand[] {
	if (levels.length === 0) {
		return [];
	}
	const first = levels[0];
	const last = levels[levels.length - 1];
	const gapBelow =
		levels.length > 1 ? (levels[1].altFt - first.altFt) / 2 : CLOUD_END_HALF_GAP_FT;
	const gapAbove =
		levels.length > 1 ? (last.altFt - levels[levels.length - 2].altFt) / 2 : CLOUD_END_HALF_GAP_FT;
	const pts: CloudCoverLevel[] = [
		{ altFt: first.altFt - gapBelow, coverPct: first.coverPct },
		...levels,
		{ altFt: last.altFt + gapAbove, coverPct: last.coverPct },
	];

	const coverAt = (altFt: number): number => {
		if (altFt <= pts[0].altFt) {
			return pts[0].coverPct;
		}
		for (let i = 1; i < pts.length; i++) {
			if (altFt <= pts[i].altFt) {
				const a = pts[i - 1];
				const b = pts[i];
				const span = b.altFt - a.altFt;
				return span <= 0 ? b.coverPct : a.coverPct + ((b.coverPct - a.coverPct) * (altFt - a.altFt)) / span;
			}
		}
		return pts[pts.length - 1].coverPct;
	};

	const breaks: number[] = pts.map((p) => p.altFt);
	for (let i = 0; i + 1 < pts.length; i++) {
		const a = pts[i];
		const b = pts[i + 1];
		for (const t of CLOUD_CLASS_MIN_PCT) {
			if (t > Math.min(a.coverPct, b.coverPct) && t < Math.max(a.coverPct, b.coverPct)) {
				breaks.push(a.altFt + ((t - a.coverPct) / (b.coverPct - a.coverPct)) * (b.altFt - a.altFt));
			}
		}
	}
	breaks.sort((x, y) => x - y);

	const out: CloudLayerBand[] = [];
	for (let i = 0; i + 1 < breaks.length; i++) {
		const botFt = breaks[i];
		const topFt = breaks[i + 1];
		if (topFt - botFt < 1e-6) {
			continue;
		}
		const amount = cloudAmountLabel(cloudOktas(coverAt((botFt + topFt) / 2)));
		if (!amount) {
			continue;
		}
		const a = amount.toLowerCase();
		const prev = out[out.length - 1];
		if (prev && prev.amount === a && Math.abs(prev.topFt - botFt) < 1e-6) {
			prev.topFt = topFt;
		} else {
			out.push({ botFt, topFt, amount: a });
		}
	}
	return out;
}

/** One flat segment of a per-leg step line: value `ft` over
 *  [fromNM, toNM]. */
export interface StepRunSegment {
	fromNM: number;
	toNM: number;
	ft: number;
}

/** Group a LEG-INDEXED value array (freezing level, MSA; values[i] spans
 *  dists[i]..dists[i+1]) into step-line runs: contiguous legs with a value
 *  join into one run (the renderer steps vertically between their values),
 *  a null leg breaks the chain. Returns data-space segments; the chart maps
 *  to pixels and places one label per run. Pure. */
export function stepLineRuns(
	values: (number | null)[] | null,
	dists: number[],
): StepRunSegment[][] {
	if (!values) {
		return [];
	}
	const runs: StepRunSegment[][] = [];
	let run: StepRunSegment[] = [];
	for (let i = 0; i + 1 < dists.length; i++) {
		const ft = values[i];
		if (ft == null) {
			if (run.length > 0) {
				runs.push(run);
				run = [];
			}
			continue;
		}
		run.push({ fromNM: dists[i], toNM: dists[i + 1], ft });
	}
	if (run.length > 0) {
		runs.push(run);
	}
	return runs;
}

// --- Altitude path (per leg): each leg flies flat at its own cruise altitude,
// joined by transition ramps at the climb / descent gradients (per-aircraft
// when the data sheet has them, 3-degree default), with the departure and
// destination on the ground. ---

/** Feet of altitude per NM along a 3-degree flight path: tan(3 deg) * 6076.12.
 *  ~318. Speed-independent, so the climb/descent slope looks the same at any
 *  cruise speed. */
export const FT_PER_NM_3DEG = Math.tan((3 * Math.PI) / 180) * 6076.12;

export interface AltitudeVertex {
	distNM: number;
	altFt: number;
}

export interface AltitudePath {
	/** The polyline to stroke, in distance order. */
	vertices: AltitudeVertex[];
	/** Per waypoint (same order / length as `distNM`), the (distNM, altFt) the
	 *  chart draws its dot at: ends on the ground, each interior waypoint where it
	 *  crosses the line (mid-transition between its two legs). */
	markers: AltitudeVertex[];
}

/** Linear-interpolate the altitude of a distance-sorted polyline at distance `d`
 *  (clamped to the endpoints outside its range; 0 for an empty path). Feeds
 *  the interior waypoint markers here and the modal's cursor readout (the
 *  planned level under the pointer). */
export function sampleAltitudePathAt(vertices: AltitudeVertex[], d: number): number {
	if (vertices.length === 0) {
		return 0;
	}
	if (d <= vertices[0].distNM) {
		return vertices[0].altFt;
	}
	const last = vertices[vertices.length - 1];
	if (d >= last.distNM) {
		return last.altFt;
	}
	for (let i = 1; i < vertices.length; i++) {
		const b = vertices[i];
		if (d <= b.distNM) {
			const a = vertices[i - 1];
			const span = b.distNM - a.distNM;
			return span <= 0 ? b.altFt : a.altFt + ((b.altFt - a.altFt) * (d - a.distNM)) / span;
		}
	}
	return last.altFt;
}

/** Build the drawn altitude profile for the PER-LEG model: leg `i`
 *  (waypoint i -> i+1) flies flat at `legAltsFt[i]` over [distNM[i], distNM[i+1]].
 *  The climb / descent always happens AFTER a waypoint: a leg holds its level to
 *  its end-waypoint and the next leg ramps up / down at its start; the departure
 *  climbs from the ground after the first fix; the only exception is the descent
 *  to the destination, which happens BEFORE the last fix so the route ends on the
 *  ground. Rising ramps use `climbFtPerNM`, falling ramps `descentFtPerNM`
 *  (both default to the 3-degree gradient; the doc builder threads the
 *  selected aircraft's still-air gradients). A big step on a short leg
 *  degrades to one steeper segment (no
 *  overshoot). A direct two-fix route climbs to `legAltsFt[0]` then descends
 *  (trapezoid, or a triangle when too short to reach it). Pure; tested in Node.
 *
 *  legAltsFt  length n-1  (one cruise altitude per leg)
 *  distNM     length n    (cumulative distance per waypoint; distNM[0] === 0) */
export function buildAltitudePath(
	legAltsFt: number[],
	distNM: number[],
	groundStartFt: number,
	groundEndFt: number,
	climbFtPerNM: number = FT_PER_NM_3DEG,
	descentFtPerNM: number = FT_PER_NM_3DEG,
): AltitudePath {
	const n = distNM.length;
	if (n < 2 || legAltsFt.length < n - 1) {
		return { vertices: [], markers: [] };
	}
	const cGrad = Math.max(1, climbFtPerNM);
	const dGrad = Math.max(1, descentFtPerNM);
	const totalNM = distNM[n - 1];
	const level = legAltsFt; // altitude held over each leg
	const fullRamp = (aFt: number, bFt: number): number =>
		Math.abs(bFt - aFt) / (bFt >= aFt ? cGrad : dGrad);

	// Markers: one per waypoint; ends on the ground, interiors sampled off the
	// finished line (filled once `vertices` exists).
	const markers: AltitudeVertex[] = [];
	const fillMarkers = (vertices: AltitudeVertex[]): void => {
		markers.length = 0;
		for (let i = 0; i < n; i++) {
			markers.push({
				distNM: distNM[i],
				altFt:
					i === 0 ? groundStartFt : i === n - 1 ? groundEndFt : sampleAltitudePathAt(vertices, distNM[i]),
			});
		}
	};

	// Direct route (single leg, no interior waypoint): climb to the leg altitude,
	// cruise, descend; a triangle when the route is too short to reach it.
	if (n === 2) {
		const gS = groundStartFt;
		const gE = groundEndFt;
		if (totalNM <= 0) {
			const v = [{ distNM: 0, altFt: gS }];
			fillMarkers(v);
			return { vertices: v, markers };
		}
		const cruise = Math.max(gS, gE, level[0]);
		const climbNM = (cruise - gS) / cGrad;
		const descNM = (cruise - gE) / dGrad;
		let vertices: AltitudeVertex[];
		if (climbNM + descNM <= totalNM) {
			vertices = [
				{ distNM: 0, altFt: gS },
				{ distNM: climbNM, altFt: cruise },
				{ distNM: totalNM - descNM, altFt: cruise },
				{ distNM: totalNM, altFt: gE },
			];
		} else {
			// Climb meets descent before reaching cruise: peak where the climb
			// line gS + cGrad x crosses the descent line gE + dGrad (D - x).
			const x = (dGrad * totalNM + gE - gS) / (cGrad + dGrad);
			vertices = [
				{ distNM: 0, altFt: gS },
				{ distNM: x, altFt: gS + cGrad * x },
				{ distNM: totalNM, altFt: gE },
			];
		}
		fillMarkers(vertices);
		return { vertices, markers };
	}

	// Per-leg reserves: the distance a leg gives up to a transition ramp on each
	// side. The change happens AFTER the waypoint, so each transition lives wholly
	// at the START of the later leg (its reserveL) and a leg holds level to its end
	// (reserveR = 0). The departure climbs at the start of leg 0 (after the first
	// fix); the last leg also descends to the ground at its end (before the
	// destination).
	const reserveL = new Array<number>(n - 1).fill(0);
	const reserveR = new Array<number>(n - 1).fill(0);
	reserveL[0] = fullRamp(groundStartFt, level[0]);
	reserveR[n - 2] = fullRamp(level[n - 2], groundEndFt);
	for (let b = 1; b <= n - 2; b++) {
		reserveL[b] = fullRamp(level[b - 1], level[b]);
	}
	// A leg can't give up more than its own length: shrink both sides to fit (a
	// big step on a short leg becomes one steeper-than-3-degree segment).
	for (let i = 0; i < n - 1; i++) {
		const legNM = distNM[i + 1] - distNM[i];
		const need = reserveL[i] + reserveR[i];
		if (need > legNM && need > 0) {
			const k = legNM / need;
			reserveL[i] *= k;
			reserveR[i] *= k;
		}
	}

	const vertices: AltitudeVertex[] = [{ distNM: distNM[0], altFt: groundStartFt }];
	const push = (v: AltitudeVertex): void => {
		const prev = vertices[vertices.length - 1];
		if (Math.abs(prev.distNM - v.distNM) > 1e-6 || Math.abs(prev.altFt - v.altFt) > 1e-6) {
			vertices.push(v);
		}
	};
	for (let i = 0; i < n - 1; i++) {
		const start = distNM[i] + reserveL[i];
		const end = distNM[i + 1] - reserveR[i];
		push({ distNM: start, altFt: level[i] });
		if (end > start + 1e-9) {
			push({ distNM: end, altFt: level[i] });
		}
	}
	push({ distNM: distNM[n - 1], altFt: groundEndFt });

	fillMarkers(vertices);
	return { vertices, markers };
}

// --- Plan penetration: where the drawn planned line is INSIDE a band
// (finding 1 of the profile UX review). Pure piecewise-linear math against
// buildAltitudePath's output, ramps included, so the emphasized portion
// aligns exactly with where the line visually enters the band. ---

export interface PenetrationSpan {
	fromNM: number;
	toNM: number;
}

/** Cut a placed span to [fromNM, toNM]: edge polylines clipped, the cut
 *  points interpolated (`sampleAltitudePathAt` over each edge polyline).
 *  The chart feeds the result through the same path builder as the full
 *  span, so a penetration overlay follows terrain-hugging edges exactly. */
export function clipSpanToRange(span: PlacedSpan, fromNM: number, toNM: number): PlacedSpan {
	const lo = Math.max(span.enterNM, fromNM);
	const hi = Math.min(span.leaveNM, toNM);
	const cut = (pts: AltitudeVertex[]): AltitudeVertex[] => {
		if (pts.length === 0) {
			return [];
		}
		const out: AltitudeVertex[] = [{ distNM: lo, altFt: sampleAltitudePathAt(pts, lo) }];
		for (const p of pts) {
			if (p.distNM > lo + 1e-9 && p.distNM < hi - 1e-9) {
				out.push(p);
			}
		}
		out.push({ distNM: hi, altFt: sampleAltitudePathAt(pts, hi) });
		return out;
	};
	return { ...span, enterNM: lo, leaveNM: hi, lowerPts: cut(span.lowerPts), upperPts: cut(span.upperPts) };
}

/** Keep the sub-interval of [a, b] where the linear function running from
 *  f0 (at a) to f1 (at b) is positive (or non-negative when `inclusive`);
 *  null when nowhere. The crossing is an exact linear root. */
function clipLinearPositive(
	a: number,
	b: number,
	f0: number,
	f1: number,
	inclusive: boolean,
): [number, number] | null {
	const pos0 = inclusive ? f0 >= 0 : f0 > 0;
	const pos1 = inclusive ? f1 >= 0 : f1 > 0;
	if (pos0 && pos1) {
		return [a, b];
	}
	if (!pos0 && !pos1) {
		return null;
	}
	const r = a + ((b - a) * f0) / (f0 - f1);
	return pos0 ? [a, r] : [r, b];
}

/** Distance intervals where the drawn planned line (`pathVertices`,
 *  buildAltitudePath's output) is INSIDE the band: strictly above the
 *  lower edge and at-or-below the upper (the nav-log schedule's `inBand`
 *  rule, so a leg cruising exactly AT a TMA floor is NOT a penetration),
 *  the upper unbounded for an open-topped band. A band whose extent the
 *  publisher only half stated, or did not state at all, is treated as
 *  unbounded on the missing side and crossed on the lateral evidence,
 *  which is what the map filter and the alert evaluator already do: it
 *  used to return [] instead, so 279 UK danger areas and 103 control
 *  areas could never be flagged however squarely the line went through
 *  them. The caller carries `extentUnknown` so the strip says on what
 *  the crossing rests. CLASS E bands under VFR do return []
 *  (`opts.vfr`): SERA.6001 makes E controlled for IFR only (ATC service,
 *  clearance and continuous two-way for IFR; a VFR flight needs neither
 *  radio nor clearance there), so flagging an E transit on a VFR plan
 *  would be noise. Piecewise-exact: between breakpoints (edge + path
 *  vertices) every curve is linear, so crossings are solved as linear
 *  roots, never sampled. */
export function bandPenetrations(
	band: PlacedBand,
	pathVertices: AltitudeVertex[],
	opts?: { vfr?: boolean },
): PenetrationSpan[] {
	if (pathVertices.length < 2) {
		return [];
	}
	if (opts?.vfr && band.airClass === 'E') {
		return [];
	}
	const out: PenetrationSpan[] = [];
	for (const span of band.spans) {
		const ds = new Set<number>([span.enterNM, span.leaveNM]);
		for (const p of span.lowerPts) {
			ds.add(p.distNM);
		}
		for (const p of span.upperPts) {
			ds.add(p.distNM);
		}
		for (const p of pathVertices) {
			if (p.distNM > span.enterNM && p.distNM < span.leaveNM) {
				ds.add(p.distNM);
			}
		}
		const grid = [...ds]
			.filter((d) => d >= span.enterNM - 1e-9 && d <= span.leaveNM + 1e-9)
			.sort((a, b) => a - b);
		const loMargin = (d: number): number =>
			sampleAltitudePathAt(pathVertices, d) - sampleAltitudePathAt(span.lowerPts, d);
		const hiMargin = (d: number): number =>
			span.upperPts.length === 0
				? Infinity
				: sampleAltitudePathAt(span.upperPts, d) - sampleAltitudePathAt(pathVertices, d);
		for (let i = 0; i + 1 < grid.length; i++) {
			const d0 = grid[i];
			const d1 = grid[i + 1];
			if (d1 - d0 < 1e-9) {
				continue;
			}
			const overFloor = clipLinearPositive(d0, d1, loMargin(d0), loMargin(d1), false);
			if (!overFloor) {
				continue;
			}
			const [a, b] = overFloor;
			const kept =
				span.upperPts.length === 0
					? overFloor
					: clipLinearPositive(a, b, hiMargin(a), hiMargin(b), true);
			if (!kept || kept[1] - kept[0] < 1e-6) {
				continue;
			}
			const prev = out[out.length - 1];
			if (prev && kept[0] - prev.toNM < 1e-6) {
				prev.toNM = kept[1];
			} else {
				out.push({ fromNM: kept[0], toNM: kept[1] });
			}
		}
	}
	return out;
}

/** A crossing that is not "contact someone" but NO-GO, per the verified
 *  taxonomy:
 *  - prohibited area, type P, both rules always (ICAO Annex 2 3.1.10 /
 *    SERA.3145 / 14 CFR 91.133 / SIA ZP);
 *  - a prohibited-area NOTAM band, Q subject RP, likewise;
 *  - class A under VFR (ICAO Annex 11 App 4 / SERA.6001(a) / 91.135:
 *    IFR only);
 *  - an ACTIVE RTBA zone (SIA ENR 5.1: penetration interdite pendant
 *    les creneaux d'activation, no clearance exists);
 *  - an R zone whose PUBLISHED condition for this flight's traffic category
 *    is avoidance, while it is active or permanently in force (AIP France
 *    ENR 5.1 states them per category, and ICAO Annex 2 3.1.10 makes entry
 *    lawful in accordance with them: LF-R 275 is a no-go for VFR H24 and an
 *    ordinary crossing for IFR, which is allowed on radio contact). An R
 *    whose condition is a clearance or a radio call is NOT forbidden, and
 *    one whose remark states nothing readable stays forbidden while hot;
 *  - an ACTIVE TSA / TFR: a temporary segregated area is reserved for its
 *    user while active, so no transit clearance exists to obtain (the be
 *    / at / es datasets carry 76 TSA rows).
 *  Deliberately NOT forbidden: D (advisory everywhere incl. France),
 *  MOA / W / Alert (FAA: VFR transit legal), ADIZ / RMZ / TMZ
 *  (requirements), TRA (transit with clearance), classes B/C/D
 *  (clearance obtainable).
 *  This set IS the live evaluator's `avoid` tier (nav/alertRules.ts): the
 *  briefed profile and the in-flight banner must never disagree about what
 *  is forbidden, which is why both now grade through the one shared
 *  `zoneEntryAction` and are pinned against each other (docs/nav-alerts.md). */
export function isForbiddenCrossing(
	band: Pick<PlacedBand, 'type' | 'airClass' | 'rtba' | 'prohibited' | 'entry'>,
	opts: { vfr: boolean; active: boolean },
): boolean {
	return (
		band.prohibited ||
		band.type === 'P' ||
		(opts.vfr && band.airClass === 'A') ||
		((band.rtba || band.type === 'R' || band.type === 'TSA' || band.type === 'TFR') &&
			zoneEntryAction(band, opts) === 'forbidden')
	);
}

/** One crossings-strip row: a band the drawn line penetrates, with its
 *  identity and the penetrated intervals. */
export interface BandCrossing {
	key: string;
	label: string;
	badge: string | null;
	badgeKind: 'class' | 'zone' | null;
	color: string;
	limitsText: string;
	tooltip: string;
	pens: PenetrationSpan[];
	firstNM: number;
	/** NO-GO crossing (isForbiddenCrossing): alarm chip, listed first. */
	forbidden: boolean;
	/** The publisher did not state the whole vertical extent, so the
	 *  crossing rests on the lateral evidence and on an unbounded reading
	 *  of the missing side. The strip says so beside the row. */
	extentUnknown: boolean;
	/** The band is NOTAM-activated / RTBA-hot in the evaluation window. */
	active: boolean;
}

/** One penetrated interval as strip text: "87.4–96.7", or a single
 *  figure for a sliver shorter than a mile ("105", not "105–105" once
 *  fmtNM drops decimals). Unit-free; the caller appends " NM". */
export function fmtRangeNM(fromNM: number, toNM: number): string {
	if (toNM - fromNM < 0.95) {
		return fmtNM((fromNM + toNM) / 2);
	}
	return `${fmtNM(fromNM)}–${fmtNM(toNM)}`;
}

/** Crossing rows for the strip under the profile title: every band the
 *  drawn line penetrates, forbidden crossings first, then by first entry
 *  distance. Pure; PlacedNotamBand extends PlacedBand, so NOTAM bands
 *  flow through unchanged and the caller resolves its own NOTAM linkage
 *  by key. `opts.vfr` rides through to bandPenetrations (the class-E
 *  exemption) and the forbidden tier; `opts.activeKeys` is the
 *  bandActivations key set (NOTAM-activated / RTBA-hot bands). */
export function bandCrossings(
	bands: PlacedBand[],
	pathVertices: AltitudeVertex[],
	opts?: { vfr?: boolean; activeKeys?: ReadonlySet<string> },
): BandCrossing[] {
	const out: BandCrossing[] = [];
	for (const band of bands) {
		const pens = bandPenetrations(band, pathVertices, opts);
		if (pens.length === 0) {
			continue;
		}
		const active = opts?.activeKeys?.has(band.key) ?? false;
		out.push({
			key: band.key,
			label: band.label || band.key,
			extentUnknown: band.extent !== 'known',
			badge: band.badge,
			badgeKind: band.badgeKind,
			color: band.color,
			limitsText: band.limitsText,
			tooltip: band.tooltip,
			pens,
			firstNM: pens[0].fromNM,
			forbidden: isForbiddenCrossing(band, { vfr: opts?.vfr ?? false, active }),
			active,
		});
	}
	out.sort((a, b) => Number(b.forbidden) - Number(a.forbidden) || a.firstNM - b.firstNM);
	return out;
}

// --- Draw-ready profile document: everything RouteProfile needs for one
// route, computed off a prefetched terrain array. The interactive modal and
// the flight-dossier print doc share this recipe, so the printed chart is
// the on-screen chart. ---

export interface RouteProfileDocInput {
	waypoints: Waypoint[];
	cruiseSpeedKt: number | null;
	/** Loaded airspaces, or null before the dataset arrives (no bands). */
	airspaces: Airspace[] | null;
	/** Terrain samples along the route; [] when the fetch failed (the chart
	 *  draws no silhouette and the route ends fall back to field elevation). */
	terrain: TerrainSample[];
	/** The ground the chart FILLS when it is not the track's own: the
	 *  minimum-altitude corridor's envelope. Only the default view ceiling
	 *  reads it here (the bands stay anchored on the track); the component
	 *  draws it. */
	groundFill?: TerrainSample[] | undefined;
	/** Charted field elevation for an airport ident, or null. The caller wraps
	 *  airportByIdent so this module stays free of Svelte state. */
	airportElevFt: (ident: string) => number | null;
	/** Airspace-type labels for the band tooltips. The UI passes
	 *  t.data.airspaceTypes (read in a $derived, so the tooltips follow the
	 *  locale) and this module stays locale-free (docs/i18n.md rule 6). */
	typeLabels: Record<string, string>;
	/** Still-air climb / descent gradients (ft/NM) from the selected
	 *  aircraft's data sheet (gradientFtPerNM over the climb / descent
	 *  sections); null / absent falls back to the 3-degree default. */
	climbGradFtPerNM?: number | null | undefined;
	descentGradFtPerNM?: number | null | undefined;
}

export interface RouteProfileDocData {
	wpPoints: ProfileWaypoint[];
	/** Raw corridor bands (the modal's context menu + computeCeilingFt input). */
	corridorBands: AirspaceCorridorBand[];
	placedBands: PlacedBand[];
	/** Each leg's flat cruise altitude (length n-1). */
	legAltsFt: number[];
	altitudePath: AltitudePath;
	totalNM: number;
	totalEteMin: number | null;
	/** Default view ceiling: the route-line / terrain peak 3/4 up the height
	 *  (peak / 0.75) for headroom, at least 1000 ft. */
	fitCeilingFt: number;
}

/** The terrain-proximity margin (ft AGL): the tint's threshold and the
 *  obstacle marks' red-ink rule share it, so the two cues cannot drift. */
export const TERRAIN_PROXIMITY_MARGIN_FT = 500;

/** One contiguous stretch of terrain whose clearance under the altitude
 *  line is below the margin: the surface vertices to re-stroke / tint. */
export interface TerrainTintRun {
	/** Terrain-surface vertices of the run (data space, ordered by distance). */
	points: { distNM: number; elevFt: number }[];
}

/** Terrain-proximity tint runs (the UX review's finding 13, red-only per
 *  the user decision): the terrain stretches where the altitude line's
 *  clearance is below `marginFt` AGL. AGL is evaluated at each terrain
 *  sample (`sampleAltitudePathAt` minus the sample elevation) and treated
 *  as linear BETWEEN samples for the run's entry/exit interpolation;
 *  honest at the ~1 NM sampling and never worth resampling the path's own
 *  vertices. Runs break at failed-tile gaps (elevFt null) and clip to the
 *  path's own distance extent: no line, no tint. */
export function terrainTintRuns(
	terrain: TerrainSample[],
	path: AltitudeVertex[],
	marginFt = TERRAIN_PROXIMITY_MARGIN_FT,
): TerrainTintRun[] {
	if (path.length < 2) {
		return [];
	}
	const fromNM = path[0].distNM;
	const toNM = path[path.length - 1].distNM;
	const runs: TerrainTintRun[] = [];
	let cur: TerrainTintRun['points'] | null = null;
	// Previous usable sample of the CURRENT contiguous stretch (null right
	// after a gap, so interpolation never spans a failed tile).
	let prev: { distNM: number; elevFt: number; agl: number } | null = null;
	const close = (): void => {
		if (cur && cur.length >= 2) {
			runs.push({ points: cur });
		}
		cur = null;
	};
	// Crossing of AGL == margin between two samples, linear in AGL.
	const crossing = (
		a: { distNM: number; elevFt: number; agl: number },
		b: { distNM: number; elevFt: number; agl: number },
	): { distNM: number; elevFt: number } => {
		const f = (marginFt - a.agl) / (b.agl - a.agl);
		return {
			distNM: a.distNM + (b.distNM - a.distNM) * f,
			elevFt: a.elevFt + (b.elevFt - a.elevFt) * f,
		};
	};
	for (const s of terrain) {
		if (s.elevFt == null || s.distNM < fromNM - 1e-9 || s.distNM > toNM + 1e-9) {
			close();
			prev = null;
			continue;
		}
		const here = {
			distNM: s.distNM,
			elevFt: s.elevFt,
			agl: sampleAltitudePathAt(path, s.distNM) - s.elevFt,
		};
		const below = here.agl < marginFt;
		if (below) {
			if (!cur) {
				cur = [];
				if (prev && prev.agl >= marginFt && prev.agl !== here.agl) {
					cur.push(crossing(prev, here)); // enter mid-segment
				}
			}
			cur.push({ distNM: here.distNM, elevFt: here.elevFt });
		} else if (cur) {
			if (prev && prev.agl < marginFt && prev.agl !== here.agl) {
				cur.push(crossing(prev, here)); // exit mid-segment
			}
			close();
		}
		prev = here;
	}
	close();
	return runs;
}

/** Terrain elevation nearest a distance along the route (skips failed tiles);
 *  0 when there are no samples at all. O(n) per call: fine for span ends and
 *  cursor queries, never for per-sample walks (those use groundAtSamples'
 *  two-pointer merge in route/airspaces.ts).
 *
 *  `pick` chooses which reading of the sample is wanted: the ground under the
 *  track by default, its footprint's floor or ceiling for a band edge, its
 *  ceiling for anything measuring clearance. */
export function terrainFtAt(
	terrain: TerrainSample[],
	targetNM: number,
	pick: (s: TerrainSample) => number | null = (s) => s.elevFt,
): number {
	let best: number | null = null;
	let bestD = Infinity;
	for (const s of terrain) {
		const v = pick(s);
		if (v == null) {
			continue;
		}
		const d = Math.abs(s.distNM - targetNM);
		if (d < bestD) {
			bestD = d;
			best = v;
		}
	}
	return best ?? 0;
}

export function buildRouteProfileDoc(input: RouteProfileDocInput): RouteProfileDocData {
	const { waypoints, terrain } = input;
	const navlog = computeNavLog(waypoints, input.cruiseSpeedKt);
	const totalNM = navlog.totalNM;

	// label = ident only (blank for a bare coordinate; the chart prints these
	// along the top). name = the full hover label (ident / custom / coords).
	const wpPoints: ProfileWaypoint[] = [];
	if (waypoints.length >= 2) {
		const first = waypoints[0];
		wpPoints.push({
			distNM: 0,
			altFt: first.alt,
			label: first.ident || first.label || '',
			name: waypointLabel(first),
		});
		for (const leg of navlog.legs) {
			const to = waypoints[leg.index];
			wpPoints.push({
				distNM: leg.cumNM,
				altFt: to.alt,
				label: to.ident || to.label || '',
				name: waypointLabel(to),
			});
		}
	}

	const corridorBands = input.airspaces
		? computeAirspaceCorridorSpans(waypoints, input.airspaces)
		: [];
	const placedBands = buildBands(corridorBands, terrain, input.typeLabels);

	// Ground at an end: the charted field elevation for an anchored airport,
	// else the terrain sample under that end, else sea level.
	const groundFt = (index: number, atNM: number): number => {
		const wp = waypoints[index];
		if (wp?.kind === 'airport' && wp.refId) {
			const elev = input.airportElevFt(wp.refId);
			if (elev != null) {
				return elev;
			}
		}
		return terrainFtAt(terrain, atNM);
	};

	const legAltsFt = waypoints.slice(0, -1).map((w) => w.alt);
	const altitudePath = buildAltitudePath(
		legAltsFt,
		wpPoints.map((w) => w.distNM),
		groundFt(0, 0),
		groundFt(waypoints.length - 1, totalNM),
		input.climbGradFtPerNM ?? FT_PER_NM_3DEG,
		input.descentGradFtPerNM ?? FT_PER_NM_3DEG,
	);

	let peak = 0;
	for (const v of altitudePath.vertices) {
		if (v.altFt > peak) peak = v.altFt;
	}
	for (const t of input.groundFill ?? terrain) {
		if (t.elevFt != null && t.elevFt > peak) peak = t.elevFt;
	}

	return {
		wpPoints,
		corridorBands,
		placedBands,
		legAltsFt,
		altitudePath,
		totalNM,
		totalEteMin: navlog.totalEteMin,
		fitCeilingFt: Math.max(1000, peak / 0.75),
	};
}
