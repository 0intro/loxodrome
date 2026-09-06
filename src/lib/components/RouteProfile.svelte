<script lang="ts">
	/* The distance-vs-altitude plot SVG. Both axes show a window fitted to the
	 * SVG box: distance [fromNM, toNM] across the width, altitude [floorFt,
	 * ceilingFt] up the height. The altitude labels sit in the left gutter; the
	 * plot content (bands / terrain / route) is cropped to the inner rect by a
	 * clip path. Airspace bands hover (in-chart highlight only) / click out; each
	 * leg of the planned-altitude line is drag-to-set-altitude (it sets that one
	 * leg's cruise level). Pure render + callbacks; the modal owns the data and
	 * route mutations. */
	import { t } from '$lib/state/i18n.svelte';
	import { fmtAlt, fmtLevel, isFlightLevelAt } from '$lib/route/format';
	import {
		bandPenetrations,
		clipSpanToRange,
		cloudLayerBands,
		isForbiddenCrossing,
		fmtNMTick,
		sampleAltitudePathAt,
		stackByOverlap,
		stepLineRuns,
		terrainTintRuns,
		TERRAIN_PROXIMITY_MARGIN_FT,
		xOf,
		yOf,
		yTicks,
		xTicks,
		PAD_L,
		PAD_R,
		PAD_T,
		PAD_B,
		type CloudCoverSegment,
		type CloudLayerBand,
		type PenetrationSpan,
		type PlacedBand,
		type PlacedSpan,
		type ProfileWaypoint,
		type TerrainSample,
		type TerrainTintRun,
		type AltitudePath,
		type AltitudeVertex,
	} from '$lib/route/routeProfile';
	import { truncate } from './verticalProfile';
	import { fitWpLabels } from './routeProfileFit';
	import { createPlotGestures, wheelPixels } from '$lib/ui/plotGestures';
	import { svgWindBarb } from '$lib/weather/windBarbs';
	import { obstacleGlyphKind, profileObstacleGlyphPath, profileObstacleRaysPath } from '$lib/map/obstacleSymbols';
	import type { ObstacleGlyphKind } from '$lib/map/obstacleGlyphData';
	import type { ObstacleMark } from '$lib/route/minAltitude';
	import type { NotamObstacleMark, PlacedNotamBand } from '$lib/route/notamProfile';

	interface Props {
		bands: PlacedBand[];
	terrain: TerrainSample[];
	/** The ground to DRAW, when it is not the ground under the track: the
	 *  highest terrain within the minimum-altitude corridor at each station,
	 *  which is the same corridor the obstacle marks and the MSA line already
	 *  come from. The filled silhouette and the proximity tint follow this
	 *  one; `terrain` stays the thin line for the ground directly below. */
	groundFill?: TerrainSample[] | undefined;
		/** distNM + (ident-only) label per waypoint; the dot altitude comes from
		 *  altitudePath.markers, index-aligned with this list. */
		waypoints: ProfileWaypoint[];
		altitudePath: AltitudePath;
		/** Each leg's flat cruise altitude (length n-1); the drag baseline and
		 *  slider value for that leg (the marker is mid-ramp, so it can't be). */
		legAltsFt: number[];
		/** Visible distance window (NM), fitted to the width. */
		fromNM: number;
		toNM: number;
		/** Visible altitude window (ft), fitted to the height. */
		floorFt: number;
		ceilingFt: number;
		/** SVG size in px (the chart fills its container, no scrolling). */
		widthPx: number;
		heightPx: number;
		onWaypointClick?: (i: number) => void;
		onBandClick?: (key: string) => void;
		/** Set waypoint `i`'s cruise altitude to `ft` (already 100-snapped, >= 0).
		 *  Driven by a leg drag, which targets the leg's cruise waypoint, so only
		 *  that one leg's level changes. `exact` (the keyboard nudge) asks the
		 *  handler to keep the value as-is apart from its window clamp: the
		 *  drag snaps to cruising levels, precise entry never does. */
		onWaypointAlt?: (i: number, ft: number, exact?: boolean) => void;
		/** Right-click at distance `distNM` and altitude `altFt` under the cursor
		 *  (screen x/y for the menu position): the modal lists the airspaces there. */
		onContextMenu?: (distNM: number, altFt: number, clientX: number, clientY: number) => void;
		/** VFR flight rules: exempts class E bands from the penetration
		 *  emphasis (SERA.6001, E is controlled for IFR only). The callers
		 *  pass routeSettings.vfr; false / absent flags every class. */
		vfr?: boolean;
		/** A band to highlight from outside (e.g. hovering a context-menu row);
		 *  overridden by an in-chart band hover. */
		highlightKey?: string | null;
		/** Transition altitude (ft) for the drag tooltip: a leg level above it
		 *  reads as a flight level ("FL 065"). Null keeps plain feet (the
		 *  semicircular option off). Pure render: the caller passes it. */
		transitionAltFt?: number | null;
		/** Per-leg effective winds (index-aligned with legAltsFt): a station-model
		 *  barb rides each leg at its mid-distance and cruise altitude,
		 *  plan-view oriented (north up, the profile-chart convention). Null or
		 *  absent hides the barbs. Pure render: the caller resolves the winds. */
		legWinds?: ({ dirDeg: number; speedKt: number } | null)[] | null;
		/** Hover provenance per leg (the nav-log tooltip text). */
		legWindTips?: (string | null)[] | null;
		/** Per-leg freezing-level altitude (ft MSL) from the route forecast:
		 *  a dashed 0 degC step-line across the legs, gapping where null
		 *  (freezing above the fetched ladder). Pure render. */
		freezingFt?: (number | null)[] | null;
		/** Per-leg minimum safe altitude (ft AMSL, the nav-log MSA recipe:
		 *  highest ground or obstacle in the min-alt corridor + 500 ft,
		 *  rounded up to 100 ft): a muted dashed step-line labelled "MSA",
		 *  gapping where null. Pure render: the caller computes the array. */
		msaFt?: (number | null)[] | null;
		/** Per-SEGMENT cloud-cover profiles (each fetch segment's distance
		 *  span + ladder levels at its own valid time): an okta-quantised
		 *  grey curtain drawn behind the bands, sub-leg lateral resolution.
		 *  Null or absent hides it. Pure render: the caller resolves the
		 *  forecast. */
		cloudCover?: CloudCoverSegment[] | null;
		/** Corridor obstacles (route mode): min-alt-corridor marks with a
		 *  prebuilt locale-aware tooltip. Null or absent hides the layer. Pure
		 *  render: the caller resolves the data, corridor width and locale. */
		obstacles?: (ObstacleMark & { tip: string })[] | null;
		/** Draw-ready NOTAM bands (route mode); null hides the layer. Pure
		 *  render: the caller computes the track crossings and filters. */
		notamBands?: PlacedNotamBand[] | null;
		/** Temporary obstacles from obstacle NOTAMs (bare positions), drawn
		 *  as NOTAM-orange obstacle glyphs, clickable via onNotamClick. */
		notamObstacles?: (NotamObstacleMark & { tip: string })[] | null;
		/** Activated airspace bands: band key -> tooltip suffix line
		 *  ("Activated by NOTAM ..."). Presence keys the category-coloured
		 *  hatch overlay on that band's spans. */
		bandActivations?: ReadonlyMap<string, string> | null;
		/** Click a NOTAM band: open its detail (the source index). */
		onNotamClick?: (index: number) => void;
		/** Click a DB obstacle mark: navigate to the obstacle panel. */
		onObstacleClick?: (id: string) => void;
		/** Draw the per-waypoint altitude dots on the flight-path line. The trace
		 *  profile turns these off: its labels are ground references flown over,
		 *  not points on the recorded line. */
		showWaypointDots?: boolean;
		/** A vertical playhead rule at this distance (NM) for trace replay and
		 *  the route profile's live marker; null hides it. Culled when the
		 *  window excludes it (an unclamped x would paint the axis gutters). */
		playheadNM?: number | null;
		/** The aircraft's ACTUAL altitude (ft MSL, the poseAltMslFt datum) at
		 *  playheadNM: the route profile's ownship marker, drawn with a dashed
		 *  connector to the planned-line dot so the vertical deviation reads.
		 *  Null hides it (no live pose, or no altitude in the fix). Culled on
		 *  BOTH axes: like the rule it draws outside the clipped group, and
		 *  y() does not clamp either. */
		playheadAltFt?: number | null;
		/** Live route mode: rest the flown side up to playheadNM (the
		 *  route-progress map convention, flown fades / plan keeps ink).
		 *  Drawn inside the clipped group, so a zoomed window crops it; the
		 *  print and dossier mounts never pass it. */
		dimFlown?: boolean;
		/** Overflown ground features (airports / navaids / reporting points and
		 *  route waypoints) labelled along the top, de-collided by stacking. Null
		 *  in route mode (the waypoint idents cover it). */
		features?: ProfileWaypoint[] | null;
		/** Route-mode hover inspector: report the cursor's along-track distance
		 *  (null on leave / outside the plot / during a leg drag) for the
		 *  modal's docked readout. Svg-level listeners, so bands and legs keep
		 *  their own events; ignored when `onCursor` (trace scrub) is set. */
		onInspect?: (distNM: number | null) => void;
		/** Scale one axis window's span by `factor` (> 1 zooms out) keeping
		 *  `anchor` (NM for 'dist', ft for 'alt') at the same pixel. The chart
		 *  only emits; the caller applies + clamps (zoomWindow). Wheel (Shift
		 *  or the left gutter = altitude) and pinch drive it. */
		onZoom?: (axis: 'dist' | 'alt', anchor: number, factor: number) => void;
		/** Shift both windows by dxNM / dyFt (drag-pan, sign resolved so the
		 *  grabbed point follows the pointer). Caller applies + clamps. */
		onPan?: (dxNM: number, dyFt: number) => void;
		/** Back to the fitted windows (Home while the plot holds focus; the
		 *  header Fit button is the caller's own control). */
		onFit?: (() => void) | undefined;
		/** Hover/scrub inspector (trace profile): report the cursor's along-track
		 *  distance (null on leave) for a readout, and seek to a distance on
		 *  click/drag. Absent in route mode, so its crosshair/handlers stay off. */
		onCursor?: (distNM: number | null) => void;
		onSeek?: (distNM: number) => void;
		/** Click an overflown-feature label (trace mode; index into `features`).
		 *  When set the labels become buttons above the scrub layer. */
		onFeatureClick?: (index: number) => void;
		/** Red terrain-proximity tint: terrain stretches with less than 500 ft
		 *  of clearance under the altitude line (red-only). Driven by the
		 *  shared profileLayers.terrainTint toggle (default on); the dossier
		 *  print passes true. */
		terrainTint?: boolean;
		/** When the readout is locked to a point, suppress the live hover crosshair
		 *  so the profile reads as frozen (the pinned point keeps its playhead line). */
		pinned?: boolean;
	}
	const {
		bands,
		terrain,
		groundFill,
		waypoints,
		altitudePath,
		legAltsFt,
		fromNM,
		toNM,
		floorFt,
		ceilingFt,
		widthPx,
		heightPx,
		onWaypointClick,
		onBandClick,
		onWaypointAlt,
		onContextMenu,
		vfr = false,
		highlightKey = null,
		transitionAltFt = null,
		legWinds = null,
		legWindTips = null,
		freezingFt = null,
		msaFt = null,
		cloudCover = null,
		obstacles = null,
		notamBands = null,
		notamObstacles = null,
		bandActivations = null,
		onNotamClick,
		onObstacleClick,
		showWaypointDots = true,
		playheadNM = null,
		playheadAltFt = null,
		dimFlown = false,
		features = null,
		onInspect,
		onZoom,
		onPan,
		onFit,
		onCursor,
		onSeek,
		onFeatureClick,
		terrainTint = false,
		pinned = false,
	}: Props = $props();

	// The print mounts (dossier PrintDoc) pass no callbacks and stay a plain
	// image for assistive tech; the interactive instances must NOT be
	// role="img", which prunes the band / waypoint / obstacle buttons from
	// the accessibility tree. role="group" keeps the label and the children.
	const interactive = $derived(
		onWaypointClick != null ||
			onBandClick != null ||
			onWaypointAlt != null ||
			onNotamClick != null ||
			onObstacleClick != null ||
			onFeatureClick != null ||
			onContextMenu != null ||
			onZoom != null ||
			onPan != null ||
			onFit != null ||
			onCursor != null ||
			onSeek != null,
	);

	// Window callbacks wired = the svg itself is a keyboard window control
	// (tabindex + plotKeydown); the print mounts pass none and stay a plain
	// image.
	const windowKeys = $derived(onZoom != null || onPan != null || onFit != null);

	// The leg-drag tooltip label: "FL 065" above the transition altitude when
	// one is in force, "4500 ft" otherwise.
	function dragLevelLabel(ft: number): string {
		const ta = transitionAltFt ?? Infinity;
		return `${fmtLevel(ft, ta)}${isFlightLevelAt(ft, ta) ? '' : ' ft'}`;
	}

	let svgEl: SVGSVGElement | undefined;

	// Per-instance clip-path id: the flight-dossier print doc mounts one chart
	// per route, and duplicate SVG ids would all resolve to the first.
	const uid = $props.id();
	// Invert a client X to an along-track distance (NM), clamped to the window.
	// Normalised by the rendered width so any CSS scaling is handled.
	function distAtClientX(clientX: number): number {
		if (!svgEl) {
			return fromNM;
		}
		const rect = svgEl.getBoundingClientRect();
		const sx = rect.width > 0 ? ((clientX - rect.left) / rect.width) * W : 0;
		const distNM = fromNM + ((sx - PAD_L) / innerW) * (toNM - fromNM);
		return Math.max(fromNM, Math.min(toNM, distNM));
	}

	// Invert a client Y to an altitude (ft), clamped to the window. The
	// wheel/pinch anchors and the context menu share it.
	function altAtClientY(clientY: number): number {
		if (!svgEl) {
			return floorFt;
		}
		const rect = svgEl.getBoundingClientRect();
		const sy = rect.height > 0 ? ((clientY - rect.top) / rect.height) * H : 0;
		const altFt = ceilingFt - ((sy - PAD_T) / innerH) * (ceilingFt - floorFt);
		return Math.max(floorFt, Math.min(ceilingFt, altFt));
	}

	// Right-click: map the cursor x/y to a distance + altitude under it and let
	// the modal pop the airspace menu. A native contextmenu right after our
	// long-press fired (Android emits one on long-press) is a duplicate: skip.
	function onCtx(e: MouseEvent): void {
		if (!onContextMenu || !svgEl) {
			return;
		}
		e.preventDefault();
		if (Date.now() - lpFiredAt < 400) {
			return;
		}
		onContextMenu(distAtClientX(e.clientX), altAtClientY(e.clientY), e.clientX, e.clientY);
	}

	// --- touch long-press: opens the same stack menu as right-click (iOS
	// never fires contextmenu on long-press; Android does, deduped above).
	// Armed for a single touch pointer anywhere in the plot EXCEPT the
	// leg-hit strokes (bands included: the stack menu is FOR stacked bands);
	// cancelled by movement past the slop, release, a second pointer, pan
	// engagement or a leg drag. ---
	let lpTimer: ReturnType<typeof setTimeout> | null = null;
	let lpX = 0;
	let lpY = 0;
	let lpFiredAt = 0;
	const LONG_PRESS_MS = 500;
	const LONG_PRESS_SLOP_PX = 8;
	function lpCancel(): void {
		if (lpTimer != null) {
			clearTimeout(lpTimer);
			lpTimer = null;
		}
	}
	function lpDown(e: PointerEvent): void {
		if (!onContextMenu || e.pointerType !== 'touch' || dragLeg !== null) {
			return;
		}
		if ((e.target as Element).closest('.leg-hit')) {
			return;
		}
		lpCancel();
		lpX = e.clientX;
		lpY = e.clientY;
		lpTimer = setTimeout(() => {
			lpTimer = null;
			if (gestures.engaged() || dragLeg !== null || !svgEl) {
				return; // an engaged gesture won the pointer
			}
			lpFiredAt = Date.now();
			// Drop the pending gesture registration so the opened menu isn't
			// followed by a pan from the same (still-down) finger.
			gestures.abort();
			onContextMenu?.(distAtClientX(lpX), altAtClientY(lpY), lpX, lpY);
		}, LONG_PRESS_MS);
	}
	function lpMove(e: PointerEvent): void {
		if (lpTimer != null && Math.hypot(e.clientX - lpX, e.clientY - lpY) > LONG_PRESS_SLOP_PX) {
			lpCancel();
		}
	}

	// Recorded altitude (ft) at an along-track distance, linearly interpolated over
	// the altitude-path vertices; null when the path is empty.
	function altAtDistNM(nm: number): number | null {
		const v = altitudePath.vertices;
		if (v.length === 0) {
			return null;
		}
		if (nm <= v[0].distNM) return v[0].altFt;
		if (nm >= v[v.length - 1].distNM) return v[v.length - 1].altFt;
		for (let i = 1; i < v.length; i++) {
			if (v[i].distNM >= nm) {
				const a = v[i - 1];
				const b = v[i];
				const span = b.distNM - a.distNM;
				const f = span > 0 ? (nm - a.distNM) / span : 0;
				return a.altFt + (b.altFt - a.altFt) * f;
			}
		}
		return v[v.length - 1].altFt;
	}

	// Hover/scrub inspector (trace profile only, i.e. when onCursor is set): a
	// moving crosshair + a dot on the recorded line; the modal renders the readout.
	// Hover reports the distance; click/drag also seeks.
	let hoverNM = $state<number | null>(null);
	let cursorDragging = false;
	function cursorMove(e: PointerEvent): void {
		const nm = distAtClientX(e.clientX);
		// While pinned there is no live hover: report null so no crosshair lingers
		// once the point is unpinned. A drag still seeks, moving the pinned point.
		const h = pinned ? null : nm;
		hoverNM = h;
		onCursor?.(h);
		if (cursorDragging) {
			onSeek?.(nm);
		}
	}
	function cursorDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return; // a right-press opens the context menu, it must never seek
		}
		cursorDragging = true;
		try {
			(e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
		} catch {
			/* capture unavailable (e.g. no active pointer); drag still works in-bounds */
		}
		const nm = distAtClientX(e.clientX);
		const h = pinned ? null : nm;
		hoverNM = h;
		onCursor?.(h);
		onSeek?.(nm);
	}
	function cursorUp(): void {
		cursorDragging = false;
	}
	// A window gesture has taken the pointer (the middle-button pan, or the
	// second finger promoting to a pinch): drop the scrub latch and the
	// crosshair, leaving the playhead where the seek put it.
	function cursorCancel(): void {
		if (!onCursor) {
			return;
		}
		cursorDragging = false;
		hoverNM = null;
		onCursor(null);
	}
	function cursorLeave(): void {
		if (cursorDragging) {
			return;
		}
		hoverNM = null;
		onCursor?.(null);
	}
	// Trace-mode hover continuity at the SVG level: a pointermove over an
	// interactive mark (which sits ABOVE the capture rect and swallows the
	// rect's own events) bubbles here, so the docked readout follows the
	// pointer everywhere. Captured drags retarget to the rect and keep
	// seeking through cursorMove; an uncaptured move over the rect fires
	// both handlers, which is idempotent. Outside the plot area (the axis
	// gutters) this reports null, the rect-leave semantics.
	function cursorHoverMove(e: PointerEvent): void {
		// An engaged pan / pinch moves the window under the pointer, so a hover
		// distance read from it would be noise: the window gesture owns the move.
		if (!onCursor || cursorDragging || gestures.engaged() || !svgEl) {
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		const ux = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
		const uy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * H;
		const inside = ux >= PAD_L && ux <= plotRight && uy >= PAD_T && uy <= baseY;
		const h = inside && !pinned ? distAtClientX(e.clientX) : null;
		hoverNM = h;
		onCursor(h);
	}
	// Drop any crosshair the instant the readout pins (covers a tap that lands and
	// pins without a following move), so unpinning never flashes a stale crosshair.
	$effect(() => {
		if (pinned) {
			hoverNM = null;
		}
	});

	const W = $derived(widthPx);
	const H = $derived(heightPx);
	const innerW = $derived(Math.max(1, widthPx - PAD_L - PAD_R));
	const innerH = $derived(Math.max(1, heightPx - PAD_T - PAD_B));
	const plotRight = $derived(PAD_L + innerW);
	const baseY = $derived(PAD_T + innerH);

	// Local transform closures (read the reactive props at call time).
	const x = (nm: number): number => xOf(nm, fromNM, toNM, innerW);
	const y = (ft: number): number => yOf(ft, floorFt, ceilingFt, innerH);

	const yt = $derived(yTicks(floorFt, ceilingFt, transitionAltFt));
	const xt = $derived(xTicks(fromNM, toNM, innerW));

	// The transition-altitude rule: drawn only when a TA is in force (the
	// semicircular option on) and inside the altitude window. Above it the
	// axis reads FL, below it feet.
	const taRuleFt = $derived(
		transitionAltFt != null && transitionAltFt > floorFt && transitionAltFt < ceilingFt
			? transitionAltFt
			: null,
	);

	// One SVG path per drawable span: the top edge left-to-right, the bottom
	// edge back right-to-left. Terrain-following AGL/ASFC edges carry one
	// vertex per terrain sample, flat edges two. An open-topped (UNL) band
	// tops out at the window ceiling; an unknown extent stays the dashed
	// full-height box.
	function bandPathD(band: PlacedBand, span: PlacedSpan): string {
		if (!band.knownExtent) {
			const x1 = x(span.enterNM);
			const x2 = x(span.leaveNM);
			return `M${x1} ${y(ceilingFt)} L${x2} ${y(ceilingFt)} L${x2} ${y(floorFt)} L${x1} ${y(floorFt)} Z`;
		}
		const top: AltitudeVertex[] = band.topOpen
			? [
					{ distNM: span.enterNM, altFt: ceilingFt },
					{ distNM: span.leaveNM, altFt: ceilingFt },
				]
			: span.upperPts;
		let d = '';
		for (const [i, p] of top.entries()) {
			d += `${i === 0 ? 'M' : 'L'}${x(p.distNM)} ${y(p.altFt)} `;
		}
		for (let i = span.lowerPts.length - 1; i >= 0; i--) {
			const p = span.lowerPts[i];
			d += `L${x(p.distNM)} ${y(p.altFt)} `;
		}
		return d + 'Z';
	}

	// The series the chart FILLS: the corridor envelope when the caller has it,
	// else the ground under the track.
	const ground = $derived<TerrainSample[]>(groundFill ?? terrain);

	// Terrain: one closed (filled-to-baseline) path per contiguous non-null run,
	// so tile-failure gaps are real holes rather than fake-0 spikes.
	const terrainPaths = $derived.by<string[]>(() => {
		const out: string[] = [];
		let run: { px: number; py: number }[] = [];
		const flush = (): void => {
			if (run.length >= 2) {
				const a = run[0];
				const b = run[run.length - 1];
				let d = `M ${a.px} ${baseY} L ${a.px} ${a.py}`;
				for (let i = 1; i < run.length; i++) {
					d += ` L ${run[i].px} ${run[i].py}`;
				}
				out.push(`${d} L ${b.px} ${baseY} Z`);
			}
			run = [];
		};
		for (const s of ground) {
			if (s.elevFt == null) {
				flush();
				continue;
			}
			run.push({ px: x(s.distNM), py: y(s.elevFt) });
		}
		flush();
		return out;
	});

	// The ground DIRECTLY BELOW the track, drawn as a thin line over the
	// envelope: the fill answers "how high is the ground around me", this
	// answers "how high is it under me". Open polyline, broken at failed
	// tiles; absent when the two are the same series.
	const trackLinePath = $derived.by<string>(() => {
		if (!groundFill) {
			return '';
		}
		let d = '';
		let pen = false;
		for (const s of terrain) {
			if (s.elevFt == null) {
				pen = false;
				continue;
			}
			d += `${pen ? 'L' : 'M'}${x(s.distNM)} ${y(s.elevFt)} `;
			pen = true;
		}
		return d;
	});

	// Terrain-proximity tint (red-only, < 500 ft AGL): the pure runs over the
	// same samples the silhouette draws, view paths built per run (surface
	// re-stroke + a translucent slice down to the baseline).
	const tintRuns = $derived<TerrainTintRun[]>(
		terrainTint ? terrainTintRuns(ground, altitudePath.vertices) : [],
	);
	function tintPathD(run: TerrainTintRun): { line: string; fill: string } {
		const pts = run.points.map((p) => `${x(p.distNM)} ${y(p.elevFt)}`);
		const line = `M ${pts.join(' L ')}`;
		const x1 = x(run.points[0].distNM);
		const x2 = x(run.points[run.points.length - 1].distNM);
		return { line, fill: `${line} L ${x2} ${baseY} L ${x1} ${baseY} Z` };
	}

	// Plan-penetrated portions per band key: where the drawn line is inside
	// the volume (bandPenetrations, the nav-log inBand rule). Computed from
	// the same props the bands and the line render from, so the dossier
	// print and the trace profile (recorded line vs bands, an honest
	// post-flight "you were inside") get the emphasis with no caller work.
	const penetrations = $derived.by<Map<string, PenetrationSpan[]>>(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
		const m = new Map<string, PenetrationSpan[]>();
		const path = altitudePath.vertices;
		if (path.length < 2) {
			return m;
		}
		for (const band of bands) {
			const pens = bandPenetrations(band, path, { vfr });
			if (pens.length > 0) {
				m.set(band.key, pens);
			}
		}
		return m;
	});

	// Planned-altitude line: ground -> climb -> cruise holds -> descent (ramps
	// at the aircraft gradients, 3-degree default; the doc builder owns them).
	const routePath = $derived(
		altitudePath.vertices.length < 2
			? ''
			: altitudePath.vertices
					.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(v.distNM)} ${y(v.altFt)}`)
					.join(' '),
	);

	// Per-leg step-lines (freezing level, MSA): each leg with a resolved
	// value draws flat across its own distance span, adjacent legs joining
	// with a vertical step; null legs break the chain (stepLineRuns groups
	// the runs; here each run maps to one path + one label at its start).
	interface StepLineView {
		d: string;
		labelX: number;
		labelY: number;
	}
	function stepRunViews(values: (number | null)[] | null): StepLineView[] {
		return stepLineRuns(
			values,
			waypoints.map((w) => w.distNM),
		).map((run) => {
			let d = '';
			for (const [j, seg] of run.entries()) {
				const yy = y(seg.ft);
				d += `${j === 0 ? 'M' : 'L'} ${x(seg.fromNM)} ${yy} L ${x(seg.toNM)} ${yy} `;
			}
			const first = run[0];
			return { d, labelX: x(first.fromNM) + 4, labelY: y(first.ft) - 5 };
		});
	}
	const freezingRuns = $derived.by<StepLineView[]>(() => stepRunViews(freezingFt));
	const msaRuns = $derived.by<StepLineView[]>(() => stepRunViews(msaFt));

	// Cloud curtain: per fetch segment, the level profile cut into
	// same-amount bands at the interpolated okta-threshold crossings
	// (cloudLayerBands), so a layer's base and top move continuously between
	// levels instead of snapping to level-thick slabs. Bands are
	// window-independent; only the px mapping below re-runs on pan / zoom.
	interface SegmentBands {
		fromNM: number;
		toNM: number;
		bands: CloudLayerBand[];
	}
	const cloudBands = $derived.by<SegmentBands[]>(() =>
		cloudCover
			? cloudCover.map((seg) => ({
					fromNM: seg.fromNM,
					toNM: seg.toNM,
					bands: seg.levels.length > 0 ? cloudLayerBands(seg.levels) : [],
				}))
			: [],
	);
	interface CloudCellView {
		key: string;
		x: number;
		w: number;
		yTop: number;
		h: number;
		amount: string;
	}
	const cloudCells = $derived.by<CloudCellView[]>(() => {
		const out: CloudCellView[] = [];
		for (const [si, seg] of cloudBands.entries()) {
			if (seg.bands.length === 0) {
				continue;
			}
			const x1 = x(seg.fromNM);
			const x2 = x(seg.toNM);
			for (const [k, b] of seg.bands.entries()) {
				out.push({
					key: `${si}:${k}`,
					x: x1,
					w: Math.max(0, x2 - x1),
					yTop: y(b.topFt),
					h: Math.max(0, y(b.botFt) - y(b.topFt)),
					amount: b.amount,
				});
			}
		}
		return out;
	});

	// One wind barb per leg with a resolved wind, riding just above the leg's
	// cruise line at its mid-distance. Orientation is plan-view (north up),
	// the flight-planning profile convention.
	interface BarbView {
		i: number;
		d: string;
		calm: { r: number } | null;
		cx: number;
		cy: number;
		tip: string | null;
	}
	const BARB_PX = 28;
	const windBarbViews = $derived.by<BarbView[]>(() => {
		if (!legWinds) {
			return [];
		}
		const out: BarbView[] = [];
		for (let i = 0; i + 1 < waypoints.length; i++) {
			const w = legWinds[i];
			if (!w) {
				continue;
			}
			const midNM = (waypoints[i].distNM + waypoints[i + 1].distNM) / 2;
			if (midNM < fromNM || midNM > toNM) {
				continue;
			}
			const cx = x(midNM);
			// Above the planned line, clamped so an upwind-pointing staff stays
			// inside the plot.
			const cy = Math.max(PAD_T + BARB_PX + 6, y(legAltsFt[i] ?? 0) - 16);
			const svg = svgWindBarb(cx, cy, w.dirDeg, w.speedKt, BARB_PX);
			out.push({
				i,
				d: svg.pathD,
				calm: svg.calmR != null ? { r: svg.calmR } : null,
				cx,
				cy,
				tip: legWindTips?.[i] ?? null,
			});
		}
		return out;
	});

	// Corridor obstacles: one glyph per ~8 px bucket of the current window so
	// a wind farm collapses to its tallest member at any zoom; the tooltip of
	// the kept mark counts the hidden neighbours. The glyph head sits AT the
	// obstacle top (the charted elevation); a stem drops to the base when the
	// height is known.
	interface ObstacleView {
		key: string;
		/** Obstacle dataset id (the bucketed tallest member): the click
		 *  target for navigateToObstacle. */
		id: string;
		x: number;
		yTop: number;
		yBase: number | null;
		kind: ObstacleGlyphKind;
		lit: boolean;
		/** Terrain-proximity rule: the line clears the charted top by less
		 *  than the shared margin (or passes below it); red ink. */
		close: boolean;
		tip: string;
	}
	// The obstacle half of the terrain-proximity layer (same toggle, same
	// margin): only meaningful with a drawn line, the terrainTintRuns guard.
	const proximityOn = $derived(terrainTint && altitudePath.vertices.length >= 2);
	function closeToLine(distNM: number, topFt: number): boolean {
		return (
			proximityOn &&
			sampleAltitudePathAt(altitudePath.vertices, distNM) - topFt < TERRAIN_PROXIMITY_MARGIN_FT
		);
	}
	const OBST_BUCKET_PX = 8;
	const obstacleViews = $derived.by<ObstacleView[]>(() => {
		if (!obstacles) {
			return [];
		}
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local aggregation inside a derived, never stored
		const byBucket = new Map<number, { o: ObstacleMark & { tip: string }; count: number }>();
		for (const o of obstacles) {
			if (o.distNM < fromNM - 1e-6 || o.distNM > toNM + 1e-6) {
				continue;
			}
			const b = Math.round(x(o.distNM) / OBST_BUCKET_PX);
			const cur = byBucket.get(b);
			if (!cur) {
				byBucket.set(b, { o, count: 1 });
			} else {
				cur.count++;
				if (o.topFt > cur.o.topFt) {
					cur.o = o;
				}
			}
		}
		const out: ObstacleView[] = [];
		for (const [b, { o, count }] of byBucket) {
			out.push({
				key: String(b),
				id: o.id,
				x: x(o.distNM),
				yTop: y(o.topFt),
				yBase: o.baseFt != null ? y(o.baseFt) : null,
				kind: obstacleGlyphKind(o),
				lit: o.lit,
				close: closeToLine(o.distNM, o.topFt),
				// i18n-ignore: "+N" count suffix, locale-invariant
				tip: count > 1 ? `${o.tip}\n+${count - 1}` : o.tip,
			});
		}
		return out;
	});

	// Temporary obstacles from obstacle NOTAMs: window-culled, never bucketed
	// (a NEW crane must not be swallowed by a taller permanent neighbour) and
	// clickable through to the NOTAM panel. Glyph kind by height threshold
	// (the type is unknown, so caret / high tower via 'other').
	interface NotamObstacleView {
		key: string;
		x: number;
		yTop: number;
		yBase: number | null;
		kind: ObstacleGlyphKind;
		close: boolean;
		tip: string;
		index: number;
	}
	const notamObstacleViews = $derived.by<NotamObstacleView[]>(() => {
		if (!notamObstacles) {
			return [];
		}
		const out: NotamObstacleView[] = [];
		notamObstacles.forEach((m, i) => {
			if (m.distNM < fromNM - 1e-6 || m.distNM > toNM + 1e-6) {
				return;
			}
			out.push({
				key: `${m.notamId}#${i}`,
				x: x(m.distNM),
				yTop: y(m.topFt),
				yBase: m.baseFt != null ? y(m.baseFt) : null,
				kind: obstacleGlyphKind({ type: 'other', hgt: m.hgtFt }),
				close: closeToLine(m.distNM, m.topFt),
				tip: m.tip,
				index: m.index,
			});
		});
		return out;
	});

	// Per leg (waypoint i -> i+1): the sub-polyline within the leg's distance
	// range (a draggable hit-target). Each leg flies flat at its own altitude,
	// stored on its from-waypoint (`legAltsFt[i]`), so dragging leg i sets only
	// that one leg's level. Every leg is draggable, including the first and last.
	interface LegSeg {
		i: number;
		d: string;
	}
	const legSegs = $derived.by<LegSeg[]>(() => {
		const m = altitudePath.markers;
		const v = altitudePath.vertices;
		const n = m.length;
		if (n < 2 || v.length < 2 || !onWaypointAlt) {
			return [];
		}
		const out: LegSeg[] = [];
		for (let i = 0; i + 1 < n; i++) {
			const d0 = m[i].distNM;
			const d1 = m[i + 1].distNM;
			const pts = v.filter((p) => p.distNM >= d0 - 1e-6 && p.distNM <= d1 + 1e-6);
			if (pts.length < 2) {
				continue;
			}
			const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.distNM)} ${y(p.altFt)}`).join(' ');
			out.push({ i, d });
		}
		return out;
	});

	// Waypoints inside the distance window; the dot uses the marker altitude
	// (ends on the ground), keeping the original index for clicks.
	const visibleWps = $derived(
		waypoints
			.map((w, idx) => ({ w, idx, mAlt: altitudePath.markers[idx]?.altFt ?? w.altFt }))
			.filter((v) => v.w.distNM >= fromNM - 1e-6 && v.w.distNM <= toNM + 1e-6),
	);

	// Ident fitting among the visible (named) waypoints: width-aware (the
	// old tick-gap rule let long free-point names overprint each other at
	// phone widths), ends whole and anchored outward, interiors ellipsized
	// into the room between kept neighbours or dropped. Pure + pinned in
	// tests/routeProfileFit.spec.ts.
	const wpLabels = $derived(
		fitWpLabels(
			visibleWps.map((v) => ({ x: x(v.w.distNM), label: v.w.label ?? '' })),
			PAD_L,
			plotRight,
		),
	);

	// In-band airspace labels: the class/zone chip plus the airspace name, placed on
	// each band's own top-left strip and elided to the band's visible width. Anchored
	// to each band's own top so stacked bands' labels separate (the inner/higher
	// band's top sits below the outer's). A name needs the band tall enough and >= 3
	// chars of room after the chip; otherwise the chip shows alone, as before.
	// Positions depend only on the scales (not the hover state), so hovering never
	// reflows them; the dim/highlight is applied in the template off `hl`.
	const BAND_LABEL_MIN_H = 13;
	const CHAR_W = 5.4; // px advance per char at the 9px ui-monospace label font
	const LINE_H = 13; // stacked labels step down by this so each gets its own line
	interface BandLabel {
		key: string;
		bandKey: string;
		/** The band's own ink (category colour / NOTAM orange): the limits
		 *  line prints in it, the chart convention (SIA prints an airspace's
		 *  vertical limits in the airspace's colour), which also ties the
		 *  value to its band inside a de-collided stack. */
		color: string;
		chipX: number;
		nameX: number;
		/** Top of the label's line (after stacking overlapping labels). */
		y: number;
		showChip: boolean;
		badge: string | null;
		badgeKind: 'class' | 'zone' | null;
		nameText: string;
		/** Vertical-limits second line ('' hidden): shown when the band is
		 *  tall enough for two lines and the string fits FULLY (a truncated
		 *  limit would misread). */
		limits: string;
		/** Two-line height for the stacking pass; undefined = one line. */
		h?: number | undefined;
		/** Horizontal extent, used only to detect overlaps while stacking. */
		x1: number;
		x2: number;
	}
	const bandLabels = $derived.by<BandLabel[]>(() => {
		// One candidate per drawable span, parked on its span's own top strip
		// (per-span drawn bounds: an AGL band's top follows the terrain).
		// NOTAM bands (chip-less, labelled by id) join the same pass so the
		// stacking de-collides them against the airspace labels.
		const items: BandLabel[] = [];
		for (const band of notamBands ? [...bands, ...notamBands] : bands) {
			if (band.knownExtent && (band.maxFt < floorFt || band.minFt > ceilingFt)) {
				continue;
			}
			band.spans.forEach((span, si) => {
				const bandTop = Math.max(PAD_T, band.knownExtent ? y(span.topFt) : y(ceilingFt));
				const bandBot = Math.min(baseY, band.knownExtent ? y(span.botFt) : y(floorFt));
				const bh = bandBot - bandTop;
				const vx1 = Math.max(x(span.enterNM), PAD_L);
				const vx2 = Math.min(x(span.leaveNM), plotRight);
				// A chip only shows when the band's name fits beside it (or the
				// band is genuinely nameless): a lone floating R/D/P chip on a
				// sliver reads as noise, not identity. Name fit is computed
				// WITH the chip offset first; when the chip drops out, the
				// name gets the full width and may fit on its own.
				const nameFits = (offset: number): boolean =>
					bh >= BAND_LABEL_MIN_H &&
					!!band.label &&
					Math.floor((vx2 - (vx1 + 2 + offset) - 3) / CHAR_W) >= 3;
				const showChip =
					band.badge != null && vx2 - vx1 >= 18 && (nameFits(17) || !band.label);
				const nameX = vx1 + 2 + (showChip ? 17 : 0); // 14px chip + 3px gap
				const maxChars = Math.floor((vx2 - nameX - 3) / CHAR_W);
				const nameText =
					bh >= BAND_LABEL_MIN_H && band.label && maxChars >= 3 ? truncate(band.label, maxChars) : '';
				if (!showChip && !nameText) {
					return;
				}
				// Vertical-limits second line: the band must be tall enough for
				// two rows and the string must fit FULLY in the visible width.
				const limits =
					band.knownExtent &&
					bh >= 2 * LINE_H + 4 &&
					vx1 + 2 + band.limitsText.length * CHAR_W <= vx2 - 3
						? band.limitsText
						: '';
				items.push({
					key: `${band.key}#${si}`,
					bandKey: band.key,
					color: band.color,
					chipX: vx1 + 2,
					nameX,
					y: bandTop + 2,
					showChip,
					badge: band.badge,
					badgeKind: band.badgeKind,
					nameText,
					limits,
					h: limits ? 2 * LINE_H : undefined,
					x1: vx1 + 2,
					x2: Math.max(
						nameText ? nameX + nameText.length * CHAR_W : vx1 + 2 + 14,
						limits ? vx1 + 2 + limits.length * CHAR_W : 0,
					),
				});
			});
		}
		// Stacked airspaces: where labels overlap horizontally, push the lower ones
		// onto successive lines (top-down) so each band's name stays legible instead
		// of printing on top of the one above it.
		stackByOverlap(items, LINE_H);
		return items;
	});

	// Overflown-feature labels (trace mode): one per feature inside the window,
	// centred on its tick and de-collided by the same stacking pass as the band
	// labels, so crowded idents step onto successive lines instead of dropping.
	interface FeatLabel {
		key: string;
		/** Index into the `features` prop (the onFeatureClick argument). */
		idx: number;
		x: number;
		y: number;
		x1: number;
		x2: number;
		text: string;
		name: string;
	}
	const FEAT_Y0 = PAD_T - 4;
	const featureLabels = $derived.by<FeatLabel[]>(() => {
		if (!features) {
			return [];
		}
		const items: FeatLabel[] = [];
		features.forEach((f, i) => {
			if (f.distNM < fromNM - 1e-6 || f.distNM > toNM + 1e-6) {
				return;
			}
			const text = f.label || f.name;
			if (!text) {
				return;
			}
			const px = x(f.distNM);
			const half = (text.length * CHAR_W) / 2;
			items.push({
				key: `${i}`,
				idx: i,
				x: px,
				y: FEAT_Y0,
				x1: px - half,
				x2: px + half,
				text,
				name: f.name,
			});
		});
		stackByOverlap(items, LINE_H);
		return items;
	});

	// --- route-mode hover inspector: svg-level, so bands / legs keep their
	// own events (unlike the trace scrub's capture rect); reports null during
	// a leg drag or a window gesture (their own feedback owns the pointer)
	// and outside the plot. ---
	let inspectNM = $state<number | null>(null);
	function reportInspect(nm: number | null): void {
		if (inspectNM !== nm) {
			inspectNM = nm;
			onInspect?.(nm);
		}
	}
	function inspectMove(e: PointerEvent): void {
		if (!onInspect || onCursor) {
			return;
		}
		if (dragLeg !== null || gestures.active() || !svgEl) {
			reportInspect(null);
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		const ux = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
		const uy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * H;
		const inside = ux >= PAD_L && ux <= plotRight && uy >= PAD_T && uy <= baseY;
		reportInspect(inside ? distAtClientX(e.clientX) : null);
	}
	function inspectLeave(): void {
		if (!onInspect || onCursor) {
			return;
		}
		reportInspect(null);
	}

	// --- direct-manipulation window gestures: wheel zoom, drag-pan, pinch.
	// The chart only EMITS (onZoom / onPan); the modal applies and clamps.
	// In trace mode (onCursor set) the PRIMARY button belongs to the replay
	// scrub's capture rect, so the window keeps the two gestures the scrub
	// leaves free: the middle button pans, and a second finger promotes the
	// tracked one to a pinch (touchPan off, so one finger still seeks). Wheel
	// zoom works in both modes (not a pointer event, it bubbles through the
	// rect). Presses on interactive targets (legs, bands, waypoints,
	// obstacles) never start a gesture, so their click / drag semantics are
	// untouched. The slop-then-capture machine is the shared
	// ui/plotGestures.ts; this chart's own hooks: the 2-axis pan mapping, the
	// pinch's per-axis midpoint anchors, and the long-press / hover / scrub
	// drops on engage. ---
	let panning = $state(false);
	// Which axes the live pan may move: a press in an axis gutter constrains it
	// to that gutter's own axis, and a plot press moves both.
	let panAxis: 'both' | 'x' | 'y' = 'both';
	/** The axis a press owns by position: the left gutter is the altitude axis
	 *  (where its wheel already zooms) and the strip under the plot the distance
	 *  axis; the corner between them goes to the altitude column. Mouse and pen
	 *  only, since 46 and 22 px are not finger targets and two fingers already
	 *  pan freely. */
	function gutterAxis(e: PointerEvent): 'x' | 'y' | null {
		if (e.pointerType === 'touch' || !svgEl) {
			return null;
		}
		const rect = svgEl.getBoundingClientRect();
		const ux = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
		const uy = ((e.clientY - rect.top) / Math.max(1, rect.height)) * H;
		if (ux < PAD_L) {
			return 'y';
		}
		return uy > baseY ? 'x' : null;
	}
	const gestures = createPlotGestures(
		{
			captureEl: () => svgEl,
			onPan: emitPan,
			onPinch: (midX: number, midY: number, xFactor: number, yFactor: number) => {
				if (xFactor !== 1) {
					onZoom?.('dist', distAtClientX(midX), xFactor);
				}
				if (yFactor !== 1) {
					onZoom?.('alt', altAtClientY(midY), yFactor);
				}
			},
			onEngage: () => {
				panning = true;
				lpCancel(); // an engaged gesture owns the pointer
				reportInspect(null);
				cursorCancel(); // trace mode: the seeking finger hands the pointer over
			},
			onSettle: () => {
				panning = false;
				panAxis = 'both';
			},
		},
		{ pinch: true, middlePan: () => true, touchPan: () => onCursor == null },
	);

	function gestureWheel(e: WheelEvent): void {
		if (!onZoom) {
			return; // unwired mounts (print doc) keep native behaviour
		}
		// A sideways-dominant wheel (a trackpad two-finger swipe, a tilt wheel)
		// PANS the distance window instead of scaling it: it is the trackpad's
		// own pan, on the device that has no middle button. Shift keeps its
		// altitude-zoom meaning, and the swallowed page scroll is unchanged.
		if (onPan && !e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
			e.preventDefault();
			if (dragLeg === null && !gestures.active()) {
				// Negated into emitPan's grabbed-point sign: a swipe right moves
				// the window forward, the way it moves the page under it.
				emitPan(-wheelPixels(e.deltaX, e.deltaMode), 0);
			}
			return;
		}
		const factor = gestures.wheel(e, dragLeg !== null || !svgEl);
		if (factor === null || !svgEl) {
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		const ux = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
		if (e.shiftKey || ux < PAD_L) {
			onZoom('alt', altAtClientY(e.clientY), factor);
		} else {
			onZoom('dist', distAtClientX(e.clientX), factor);
		}
	}

	function gestureDown(e: PointerEvent): void {
		if ((!onZoom && !onPan) || dragLeg !== null) {
			return;
		}
		if ((e.target as Element).closest('.leg-hit')) {
			return; // the leg drag owns its press (its own pointer capture)
		}
		const axis = gutterAxis(e);
		// Trace mode: the scrub owns the primary button INSIDE the plot, which
		// is as far as its capture rect reaches, so only the middle button,
		// touch pointers (a second one promotes to a pinch) and the axis
		// gutters reach the machine. A touch press reports button 0 too, hence
		// the pointerType test.
		if (onCursor && e.button === 0 && e.pointerType !== 'touch' && axis === null) {
			return;
		}
		panAxis = axis ?? 'both';
		if (gestures.down(e)) {
			e.preventDefault();
		}
	}

	// Composed svg pointer handlers: the long-press arm/cancel rides the
	// same events as the window gestures.
	function plotPointerDown(e: PointerEvent): void {
		lpDown(e);
		gestureDown(e);
	}
	function plotPointerLeave(): void {
		inspectLeave();
		cursorLeave(); // no-ops in route mode (onCursor unset) and during a drag
	}
	function plotPointerMove(e: PointerEvent): void {
		lpMove(e);
		gestureMove(e);
		cursorHoverMove(e);
	}
	function plotPointerUp(e: PointerEvent): void {
		lpCancel();
		gestureUp(e);
	}

	// Client px deltas -> value units over the current window spans, signed so
	// the grabbed point follows the pointer (screen-y inversion lands on x), and
	// dropping the axis a gutter press excluded.
	function emitPan(dxPx: number, dyPx: number): void {
		if (!onPan || !svgEl || (dxPx === 0 && dyPx === 0)) {
			return;
		}
		const rect = svgEl.getBoundingClientRect();
		const kx = rect.width > 0 ? W / rect.width : 1;
		const ky = rect.height > 0 ? H / rect.height : 1;
		const dxNM = panAxis === 'y' ? 0 : (-(dxPx * kx) * (toNM - fromNM)) / innerW;
		const dyFt = panAxis === 'x' ? 0 : (dyPx * ky * (ceilingFt - floorFt)) / innerH;
		if (dxNM !== 0 || dyFt !== 0) {
			onPan(dxNM, dyFt);
		}
	}

	function gestureMove(e: PointerEvent): void {
		if (gestures.move(e)) {
			return;
		}
		// Hover-inspect tail (its own guards cover trace mode / drag / press).
		inspectMove(e);
	}

	function gestureUp(e: PointerEvent): void {
		gestures.up(e);
	}

	function gestureLost(e: PointerEvent): void {
		// Only the svg's OWN capture. The trace scrub captures on its rect, and
		// the pinch taking that finger over makes the rect lose it; that event
		// bubbles here, and read as the machine's it would collapse the pinch
		// into a one-finger pan.
		if (e.target !== svgEl) {
			return;
		}
		gestures.lost(e);
	}

	/* Keyboard window control, acting ONLY while the svg itself holds focus
	 * (the VerticalProfile gate): legs, bands, waypoints and marks are their
	 * own tab stops with their own arrows / Enter, so a key pressed on them
	 * falls through untouched. Left/Right pan the distance window, Up/Down
	 * the altitude window (10% of the span each), PageUp/PageDown a whole
	 * altitude window, +/- zoom the distance axis about the window centre
	 * (the unmodified wheel's axis), Home fits both. No Shift gate: '+' IS
	 * Shift+'=' on many layouts. */
	function plotKeydown(e: KeyboardEvent): void {
		if (!windowKeys || e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) {
			return;
		}
		const distSpan = toNM - fromNM;
		const altSpan = ceilingFt - floorFt;
		switch (e.key) {
			case 'ArrowLeft':
				onPan?.(-distSpan * 0.1, 0);
				break;
			case 'ArrowRight':
				onPan?.(distSpan * 0.1, 0);
				break;
			case 'ArrowUp':
				onPan?.(0, altSpan * 0.1);
				break;
			case 'ArrowDown':
				onPan?.(0, -altSpan * 0.1);
				break;
			case 'PageUp':
				onPan?.(0, altSpan);
				break;
			case 'PageDown':
				onPan?.(0, -altSpan);
				break;
			case '+':
			case '=':
				onZoom?.('dist', (fromNM + toNM) / 2, 1 / 1.25);
				break;
			case '-':
				onZoom?.('dist', (fromNM + toNM) / 2, 1.25);
				break;
			case 'Home':
				onFit?.();
				break;
			default:
				return;
		}
		e.preventDefault();
	}

	// --- airspace band hover: in-chart highlight only (no map highlight) ---
	let hoveredBandKey = $state<string | null>(null);
	// Effective highlighted band: an in-chart hover wins over an external one
	// (a context-menu row hover via highlightKey).
	const hl = $derived(hoveredBandKey ?? highlightKey);
	// A hovered band can unmount under the pointer (a filter or data change
	// removes it): no mouseleave fires then, so drop the latch when its key
	// leaves the data or the sibling dimming would stick to a ghost.
	$effect(() => {
		const k = hoveredBandKey;
		if (
			k !== null &&
			!bands.some((b) => b.key === k) &&
			!(notamBands ?? []).some((b) => b.key === k)
		) {
			hoveredBandKey = null;
		}
	});
	function bandKey(e: KeyboardEvent, key: string): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onBandClick?.(key);
		}
	}
	function nbandKey(e: KeyboardEvent, index: number): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onNotamClick?.(index);
		}
	}
	function obstKey(e: KeyboardEvent, id: string): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onObstacleClick?.(id);
		}
	}
	function featKey(e: KeyboardEvent, index: number): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onFeatureClick?.(index);
		}
	}

	// Band designator labels double as click targets in trace mode (the band
	// bodies are seek-owned under the capture rect there): airspace labels
	// route to onBandClick, NOTAM-band labels (bandKey "notam:<id>") resolve
	// their notamIndex through the notamBands prop. Route mode keeps the
	// non-interactive labels: clicks pass through to the band body, which
	// already navigates.
	const labelsClickable = $derived(onCursor != null && (onBandClick != null || onNotamClick != null));
	function bandLabelClick(bandKey: string): void {
		if (bandKey.startsWith('notam:')) {
			const nb = (notamBands ?? []).find((b) => b.key === bandKey);
			if (nb) {
				onNotamClick?.(nb.notamIndex);
			}
			return;
		}
		onBandClick?.(bandKey);
	}
	function bandLabelKey(e: KeyboardEvent, bandKey: string): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			bandLabelClick(bandKey);
		}
	}

	// Activation-hatch pattern categories among the activated bands: one
	// per-instance <pattern> each (var(--airspace-<cat>) ink at the map's
	// hatch geometry).
	const hatchCats = $derived.by<string[]>(() => {
		if (!bandActivations) {
			return [];
		}
		const cats: string[] = [];
		for (const band of bands) {
			if (bandActivations.has(band.key) && !cats.includes(band.category)) {
				cats.push(band.category);
			}
		}
		return cats;
	});

	// --- leg drag: vertically drag a leg to set that one leg's flat altitude
	// (absolute, snapped to 100 ft), stored on its from-waypoint `legAltsFt[i]`.
	// Only that leg's level moves; the adjacent legs keep theirs and the climb /
	// descent into the moved leg re-slopes. ---
	let dragLeg = $state<number | null>(null);
	// Pointer x (px, window-clamped) during a drag: anchors the ghost label.
	let dragX = $state(0);
	let dragStartY = 0;
	let dragStartFt = 0;
	function legDown(seg: LegSeg, e: PointerEvent): void {
		if (e.button !== 0) {
			return; // left button only; let right-click open the context menu
		}
		dragLeg = seg.i;
		dragX = x(distAtClientX(e.clientX));
		dragStartY = e.clientY;
		dragStartFt = legAltsFt[seg.i] ?? 0;
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function legMove(seg: LegSeg, e: PointerEvent): void {
		if (dragLeg !== seg.i) {
			return;
		}
		dragX = x(distAtClientX(e.clientX));
		const ftPerPx = (ceilingFt - floorFt) / innerH;
		const target = Math.max(0, Math.round((dragStartFt - (e.clientY - dragStartY) * ftPerPx) / 100) * 100);
		onWaypointAlt?.(seg.i, target);
	}
	function legUp(e: PointerEvent): void {
		if (dragLeg === null) {
			return;
		}
		dragLeg = null;
		(e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
	}
	// Keyboard nudge on a focused leg: +-100 ft (arrows), +-500 with Shift,
	// committed EXACT (the third onWaypointAlt arg skips the semicircular
	// snap): a +-100 step through the snap would land back on the current
	// level, and the app's convention is that only the coarse drag snaps
	// while precise entry stays raw behind the orange non-compliant cue.
	// No ghost: the drag guide is gated on dragLeg, which stays null here.
	function legKey(seg: LegSeg, e: KeyboardEvent): void {
		const dir =
			e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1
				: e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1
					: 0;
		if (dir === 0 || dragLeg !== null) {
			return;
		}
		e.preventDefault();
		const step = e.shiftKey ? 500 : 100;
		const target = Math.max(0, (legAltsFt[seg.i] ?? 0) + dir * step);
		onWaypointAlt?.(seg.i, target, true);
	}

	function onKey(e: KeyboardEvent, idx: number): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onWaypointClick?.(idx);
		}
	}
</script>

<!-- The tabindex is the point (the VerticalProfile idiom): with the window
 callbacks wired this chart IS a keyboard window control (arrows / PageUp /
 PageDown pan, +/- zoom, Home fits), and it has to be focusable to receive
 those keys. Legs, bands and marks keep their own tab stops and their own
 keys; plotKeydown acts only while the svg itself holds focus. Each of those
 is role="button" with an aria-label naming the airspace, obstacle or
 waypoint it opens, so a tab stop there is worth having; they sat at
 tabindex="-1" until 2026-08, which left every Enter handler below
 unreachable and the whole chart pointer-only. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<svg
	bind:this={svgEl}
	class="plot"
	class:dragging={dragLeg !== null}
	width={W}
	height={H}
	viewBox="0 0 {W} {H}"
	preserveAspectRatio="xMidYMid meet"
	class:panning
	role={interactive ? 'group' : 'img'}
	aria-label={t.route.routeProfileAria}
	tabindex={windowKeys ? 0 : undefined}
	oncontextmenu={onCtx}
	onwheel={gestureWheel}
	onpointerdown={plotPointerDown}
	onpointermove={plotPointerMove}
	onpointerup={plotPointerUp}
	onpointercancel={plotPointerUp}
	onlostpointercapture={gestureLost}
	onpointerleave={plotPointerLeave}
	onkeydown={plotKeydown}
>
	<defs>
		<clipPath id="rp-clip-{uid}">
			<rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} />
		</clipPath>
		<!-- NOTAM band hatch + per-category activation hatches: the map's
		 pattern geometry (8 px tile, 45 deg, 3 px stripe); per-instance ids
		 because the dossier print mounts one chart per route. -->
		<pattern
			id="rp-nhatch-{uid}"
			patternUnits="userSpaceOnUse"
			width="8"
			height="8"
			patternTransform="rotate(45)"
		>
			<rect width="3" height="8" fill="#ff7800" />
		</pattern>
		{#each hatchCats as cat (cat)}
			<pattern
				id="rp-ahatch-{uid}-{cat}"
				patternUnits="userSpaceOnUse"
				width="8"
				height="8"
				patternTransform="rotate(45)"
			>
				<rect width="3" height="8" fill="var(--airspace-{cat})" />
			</pattern>
		{/each}
	</defs>

	<!-- horizontal FL/GND gridlines + altitude labels in the left gutter -->
	{#each yt as t (t.ft)}
		<line class="grid" x1={PAD_L} x2={plotRight} y1={y(t.ft)} y2={y(t.ft)} />
		<line class="ay-tick" x1={PAD_L - 4} x2={PAD_L} y1={y(t.ft)} y2={y(t.ft)} />
		<text class="ay-label" x={PAD_L - 6} y={y(t.ft) + 3} text-anchor="end">{t.label}</text>
	{/each}

	<!-- vertical distance gridlines + labels -->
	{#each xt as d (d)}
		<line class="grid" x1={x(d)} x2={x(d)} y1={PAD_T} y2={baseY} />
		<text class="xlabel" x={x(d)} y={H - 7} text-anchor="middle">{fmtNMTick(d)}</text>
	{/each}

	<!-- axis unit captions in the gutter corners: the distance unit on the
	 x-label row (the PAD_R gutter would collide with the centered end label),
	 the level unit atop the y-label column ("ft / FL" only when a transition
	 altitude is in force, matching what yTicks actually prints) -->
	<text class="axis-unit" x={2} y={H - 7} text-anchor="start">NM</text>
	<text class="axis-unit" x={PAD_L - 6} y={PAD_T - 8} text-anchor="end">{transitionAltFt != null ? 'ft / FL' : 'ft'}</text>

	<!-- Axis grab zones: dragging a gutter pans THAT axis alone, the
	 gutter-wheel rule extended to the drag, and their resize cursors are what
	 says so. Transparent and handler-free: the press bubbles to the svg, which
	 reads the position (gutterAxis). Placed here on purpose: above the tick
	 labels, which are what the pointer aims at, and below both the clipped plot
	 content (which never reaches a gutter) and the top-gutter waypoint /
	 feature labels, which keep their own clicks. -->
	{#if onPan}
		<rect class="gutter gy" x="0" y="0" width={PAD_L} height={H} />
		<!-- Clamped: innerH has a floor of 1, so a box shorter than the top
		     padding (a dock mid-open, whose height starts at 0) leaves this
		     gutter negative, which is an SVG error rather than a small rect. -->
		<rect
			class="gutter gx"
			x={PAD_L}
			y={baseY}
			width={innerW + PAD_R}
			height={Math.max(0, H - baseY)}
		/>
	{/if}

	<!-- plot content, cropped to the window -->
	<g clip-path="url(#rp-clip-{uid})">
		<!-- forecast cloud curtain (okta-quantised, per leg), behind the bands
		 so airspace, terrain and the route line keep prominence -->
		{#if cloudCells.length > 0}
			<g class="clouds">
				{#each cloudCells as c (c.key)}
					<rect x={c.x} y={c.yTop} width={c.w} height={c.h} class={c.amount} />
				{/each}
			</g>
		{/if}

		<!-- airspace bands (faint), lowest-floor first so higher zones overlay.
		 Each span is a polygon whose AGL/ASFC edges follow the terrain; UNL
		 bands run open-topped to the window ceiling. Culling uses the DRAWN
		 bounds (an ASFC band over high ground sits far above its face values). -->
		{#each bands as band (band.key)}
			{#if !band.knownExtent || (band.maxFt >= floorFt && band.minFt <= ceilingFt)}
				{#each band.spans as span, si (si)}
					{@const actLine = bandActivations?.get(band.key)}
					{@const bandTip = actLine ? `${band.tooltip}\n${actLine}` : band.tooltip}
					<g
						class="band"
						class:unknown={!band.knownExtent}
						class:highlight={band.key === hl}
						class:dimmed={hl !== null && band.key !== hl}
						style:--as-color={band.color}
						role="button"
						tabindex="0"
						aria-label={bandTip}
						onmouseenter={() => (hoveredBandKey = band.key)}
						onmouseleave={() => (hoveredBandKey = null)}
						onclick={() => onBandClick?.(band.key)}
						onkeydown={(e) => bandKey(e, band.key)}
					>
						{#if actLine}
							<!-- NOTAM-activated: category-coloured diagonal hatch, the
							 map's activation convention; non-interactive overlay drawn
							 UNDER the band's own path so the outline (thin solid, or
							 the RTBA pecked dash) stays crisp on top: identity above
							 state. The pattern fill MUST be an inline style: as a
							 presentation attribute it would lose to the `.band path`
							 fill rule and render the category colour as a solid slab. -->
							<path
								class="act-hatch"
								d={bandPathD(band, span)}
								style:fill={`url(#rp-ahatch-${uid}-${band.category})`}
							/>
						{/if}
						<!-- plan-penetrated portion: stronger fill + solid outline over
						 exactly the interval the drawn line is inside; zones (R/D/P)
						 louder than controlled (a TMA transit is routinely
						 intentional). Under the band's own outline, identity above
						 state, like the activation hatch. -->
						{#each penetrations.get(band.key) ?? [] as pen (pen.fromNM)}
							{#if pen.fromNM < span.leaveNM - 1e-9 && pen.toNM > span.enterNM + 1e-9}
								<path
									class="pen"
									class:zone={band.badgeKind === 'zone'}
									class:forbidden={isForbiddenCrossing(band, {
										vfr,
										active: bandActivations?.has(band.key) ?? false,
									})}
									d={bandPathD(band, clipSpanToRange(span, pen.fromNM, pen.toNM))}
								/>
							{/if}
						{/each}
						<path class:pecked={band.rtba} d={bandPathD(band, span)} />
						<title>{bandTip}</title>
					</g>
				{/each}
			{/if}
		{/each}

		<!-- NOTAM bands: hatched orange where the track crosses a NOTAM area,
		 between its published limits (dashed full-height when unknown) -->
		{#each notamBands ?? [] as nb (nb.key)}
			{#if !nb.knownExtent || (nb.maxFt >= floorFt && nb.minFt <= ceilingFt)}
				{#each nb.spans as span, si (si)}
					<g
						class="nband"
						class:unknown={!nb.knownExtent}
						class:highlight={nb.key === hl}
						class:dimmed={hl !== null && nb.key !== hl}
						role="button"
						tabindex="0"
						aria-label={nb.tooltip}
						onmouseenter={() => (hoveredBandKey = nb.key)}
						onmouseleave={() => (hoveredBandKey = null)}
						onclick={() => onNotamClick?.(nb.notamIndex)}
						onkeydown={(e) => nbandKey(e, nb.notamIndex)}
					>
						<path
							d={bandPathD(nb, span)}
							fill={nb.knownExtent ? `url(#rp-nhatch-${uid})` : 'none'}
						/>
						<title>{nb.tooltip}</title>
					</g>
				{/each}
			{/if}
		{/each}

		<!-- terrain silhouette: the corridor envelope, with the ground under
		 the track itself as a thin line over it -->
		{#each terrainPaths as d, i (i)}
			<path class="terrain" {d} />
		{/each}
		{#if trackLinePath}
			<path class="terrain-track" d={trackLinePath} />
		{/if}

		<!-- terrain-proximity tint: the ground re-inked red where the altitude
		 line's clearance is under 500 ft AGL (red-only, the terrainTint
		 prop). Non-interactive, under the trace scrub layer like the
		 terrain it emphasizes. -->
		{#each tintRuns as run, i (i)}
			{@const d = tintPathD(run)}
			<path class="terrain-tint-fill" d={d.fill} />
			<path class="terrain-tint-line" d={d.line} />
		{/each}

		<!-- trace-mode scrub layer: the transparent capture rect sits HERE, under
		 the interactive marks (obstacles, NOTAM marks: they take their own
		 clicks) and above the bands / terrain, which stay seek-owned (their
		 navigation is the right-click menu; the contextmenu event bubbles past
		 the rect to the svg handler). Everything drawn after this point in
		 trace mode must be pointer-events: none unless it is deliberately
		 clickable, or it would dead-spot the scrub. -->
		{#if onCursor}
			<rect
				class="cursor-capture"
				x={PAD_L}
				y={PAD_T}
				width={innerW}
				height={innerH}
				role="slider"
				tabindex="-1"
				aria-label={t.route.routeProfileAria}
				aria-valuemin={fromNM}
				aria-valuemax={toNM}
				aria-valuenow={hoverNM ?? fromNM}
				onpointermove={cursorMove}
				onpointerdown={cursorDown}
				onpointerup={cursorUp}
				onpointercancel={cursorUp}
				onpointerleave={cursorLeave}
			/>
		{/if}

		<!-- corridor obstacles: stem to the base + glyph head at the charted
		 top; clickable through to the obstacle panel (a bucketed wind farm
		 navigates to its kept tallest member, the tooltip's "+n") -->
		{#each obstacleViews as v (v.key)}
			<g
				class="obst"
				class:close={v.close}
				role="button"
				tabindex="0"
				aria-label={v.tip}
				onclick={() => onObstacleClick?.(v.id)}
				onkeydown={(e) => obstKey(e, v.id)}
			>
				<title>{v.tip}</title>
				{#if v.yBase != null && v.yBase > v.yTop + 1}
					<line class="casing" x1={v.x} x2={v.x} y1={v.yTop} y2={v.yBase} />
					<line class="ink" x1={v.x} x2={v.x} y1={v.yTop} y2={v.yBase} />
				{/if}
				<path class="casing" d={profileObstacleGlyphPath(v.kind, v.x, v.yTop)} />
				<path class="ink" d={profileObstacleGlyphPath(v.kind, v.x, v.yTop)} />
				{#if v.lit}
					<path class="casing" d={profileObstacleRaysPath(v.x, v.yTop)} />
					<path class="ink rays" d={profileObstacleRaysPath(v.x, v.yTop)} />
				{/if}
			</g>
		{/each}

		<!-- temporary obstacles from obstacle NOTAMs: NOTAM-orange, clickable -->
		{#each notamObstacleViews as v (v.key)}
			<g
				class="obst notam"
				class:close={v.close}
				role="button"
				tabindex="0"
				aria-label={v.tip}
				onclick={() => onNotamClick?.(v.index)}
				onkeydown={(e) => nbandKey(e, v.index)}
			>
				<title>{v.tip}</title>
				{#if v.yBase != null && v.yBase > v.yTop + 1}
					<line class="casing" x1={v.x} x2={v.x} y1={v.yTop} y2={v.yBase} />
					<line class="ink" x1={v.x} x2={v.x} y1={v.yTop} y2={v.yBase} />
				{/if}
				<path class="casing" d={profileObstacleGlyphPath(v.kind, v.x, v.yTop)} />
				<path class="ink" d={profileObstacleGlyphPath(v.kind, v.x, v.yTop)} />
			</g>
		{/each}

		<!-- reference step-line halos (MSA + freezing), UNDER the planned route
		 line: a surface-coloured casing drawn above it would erase the route
		 wherever a leg is planned exactly at the reference altitude. The
		 dashed inks draw above the route instead, so at coincidence the
		 dashes ride the accent line and both stay readable; splitting the
		 passes also keeps one line's casing off the other's dashes where
		 MSA and freezing cross. -->
		{#each msaRuns as run (run.d)}
			<path class="msa-casing" d={run.d} />
		{/each}
		{#each freezingRuns as run (run.d)}
			<path class="fz-casing" d={run.d} />
		{/each}

		<!-- planned-altitude route line (the fat per-leg hit-paths catch the drag) -->
		{#if routePath}
			<path class="route" d={routePath} />
		{/if}

		<!-- per-leg minimum safe altitude step-line (the nav-log MSA recipe) -->
		{#each msaRuns as run (run.d)}
			<path class="msa" d={run.d} />
			<text class="msa-label" x={run.labelX} y={run.labelY}>MSA</text>
		{/each}

		<!-- freezing level (0 degC) step-line from the route forecast -->
		{#each freezingRuns as run (run.d)}
			<path class="fz" d={run.d} />
			<text class="fz-label" x={run.labelX} y={run.labelY}>0 °C</text>
		{/each}

		<!-- per-leg wind barbs (forecast / override / manual, resolved upstream) -->
		{#each windBarbViews as b (b.i)}
			<g class="wind-barb" role="img" aria-label={b.tip ?? t.route.legWindAria}>
				{#if b.tip}<title>{b.tip}</title>{/if}
				{#if b.calm}
					<circle class="casing" cx={b.cx} cy={b.cy} r={b.calm.r} />
					<circle class="ink-open" cx={b.cx} cy={b.cy} r={b.calm.r} />
				{:else}
					<path class="casing" d={b.d} />
					<path class="ink" d={b.d} />
				{/if}
				<circle class="dot" cx={b.cx} cy={b.cy} r="1.7" />
			</g>
		{/each}
		{#each legSegs as seg (seg.i)}
			<path
				class="leg-hit"
				class:active={dragLeg === seg.i}
				d={seg.d}
				role="slider"
				tabindex="0"
				aria-label={t.route.legAltAria(seg.i + 1)}
				aria-valuenow={legAltsFt[seg.i] ?? 0}
				aria-valuemin={Math.max(0, Math.ceil(floorFt / 100) * 100)}
				aria-valuemax={Math.max(0, Math.floor(ceilingFt / 100) * 100)}
				aria-valuetext={dragLevelLabel(legAltsFt[seg.i] ?? 0)}
				onpointerdown={(e) => legDown(seg, e)}
				onpointermove={(e) => legMove(seg, e)}
				onpointerup={legUp}
				onpointercancel={legUp}
				onlostpointercapture={legUp}
				onkeydown={(e) => legKey(seg, e)}
			><title>{dragLevelLabel(legAltsFt[seg.i] ?? 0)}</title></path>
		{/each}

		<!-- in-band airspace labels (chip + name), drawn on top. Non-interactive
		 in route mode (clicks pass through to the band body, which navigates);
		 in trace mode they are the bands' left-click affordance, buttons above
		 the scrub layer with a full-line hit rect. -->
		{#snippet bandLabelBody(L: BandLabel)}
			{#if L.showChip && L.badge}
				<g class="band-chip" class:zone={L.badgeKind === 'zone'}>
					<rect x={L.chipX} y={L.y} width={14} height={12} rx={2} />
					<text
						x={L.chipX + 7}
						y={L.y + 6.5}
						text-anchor="middle"
						dominant-baseline="middle">{L.badge}</text
					>
				</g>
			{/if}
			{#if L.nameText}
				<text
					class="band-name"
					x={L.nameX}
					y={L.y + 6.5}
					text-anchor="start"
					dominant-baseline="middle">{L.nameText}</text
				>
			{/if}
			{#if L.limits}
				<text
					class="band-limits"
					style:fill={L.color}
					x={L.chipX}
					y={L.y + LINE_H + 6.5}
					text-anchor="start"
					dominant-baseline="middle">{L.limits}</text
				>
			{/if}
		{/snippet}
		{#if dimFlown && playheadNM != null}
			<!-- live route mode: the flown side rests, the plan ahead keeps its
			     ink (the route-progress map convention). Inside the clip, so a
			     zoomed window crops it; the band labels below draw above it and
			     stay crisp. -->
			<rect
				class="flown-dim"
				x={PAD_L}
				y={PAD_T}
				width={Math.max(0, x(playheadNM) - PAD_L)}
				height={innerH}
			/>
		{/if}
		{#each bandLabels as L (L.key)}
			{#if labelsClickable}
				<g
					class="band-label clickable"
					class:dimmed={hl !== null && L.bandKey !== hl}
					role="button"
					tabindex="0"
					aria-label={`${L.badge ?? ''} ${L.nameText}`.trim()}
					onclick={() => bandLabelClick(L.bandKey)}
					onkeydown={(e) => bandLabelKey(e, L.bandKey)}
					onmouseenter={() => (hoveredBandKey = L.bandKey)}
					onmouseleave={() => (hoveredBandKey = null)}
				>
					<rect class="label-hit" x={L.x1} y={L.y} width={L.x2 - L.x1} height={L.h ?? LINE_H} />
					{@render bandLabelBody(L)}
				</g>
			{:else}
				<g class="band-label" class:dimmed={hl !== null && L.bandKey !== hl}>
					{@render bandLabelBody(L)}
				</g>
			{/if}
		{/each}
	</g>

	<!-- transition altitude rule: feet below, flight levels above -->
	{#if taRuleFt != null}
		<line class="ta-line" x1={PAD_L} x2={plotRight} y1={y(taRuleFt)} y2={y(taRuleFt)} />
		<text class="ta-label" x={PAD_L + 4} y={y(taRuleFt) - 4}>TA {fmtAlt(taRuleFt)} ft</text>
	{/if}

	<!-- leg-drag ghost: the committed level (post-snap, post-clamp, exactly
	 what the leg now flies) as a guide line + a label at the pointer, so the
	 drag is never blind. Non-interactive; gone on release. -->
	{#if dragLeg !== null}
		{@const gy = y(legAltsFt[dragLeg] ?? 0)}
		{@const lx = Math.min(plotRight - 60, Math.max(PAD_L + 6, dragX))}
		<line class="drag-guide" x1={PAD_L} x2={plotRight} y1={gy} y2={gy} />
		<text class="drag-label" x={lx} y={gy < PAD_T + 18 ? gy + 16 : gy - 7}
			>{dragLevelLabel(legAltsFt[dragLeg] ?? 0)}</text
		>
	{/if}

	<!-- route-mode inspect crosshair + a dot on the planned line at that
	 distance (the readout's Level value, anchored to the geometry; the
	 trace inspector's idiom). The docked readout lives in the modal. -->
	{#if inspectNM != null && dragLeg === null}
		{@const iy = altAtDistNM(inspectNM)}
		<line class="inspect-line" x1={x(inspectNM)} x2={x(inspectNM)} y1={PAD_T} y2={baseY} />
		{#if iy != null && iy >= floorFt && iy <= ceilingFt}
			<circle class="cursor-dot" cx={x(inspectNM)} cy={y(iy)} r={3.5} />
		{/if}
	{/if}

	<!-- waypoints in the window: tick, dot at the marker altitude, ident at the top -->
	{#each visibleWps as v, j (v.idx)}
		{@const px = x(v.w.distNM)}
		{@const inAlt = v.mAlt >= floorFt && v.mAlt <= ceilingFt}
		<line class="wp-tick" x1={px} x2={px} y1={PAD_T} y2={baseY} />
		{#if onWaypointClick}
			<g
				class="wp clickable"
				role="button"
				tabindex="0"
				aria-label={v.w.label || t.navlog.waypoint}
				onclick={() => onWaypointClick?.(v.idx)}
				onkeydown={(e) => onKey(e, v.idx)}
			>
				<title>{v.w.name}</title>
				<rect class="wp-hit" x={px - 6} y={PAD_T} width={12} height={innerH} />
				{#if showWaypointDots && inAlt}<circle class="wp-dot" cx={px} cy={y(v.mAlt)} r={3} />{/if}
			</g>
		{:else if showWaypointDots && inAlt}
			<circle class="wp-dot" cx={px} cy={y(v.mAlt)} r={3} />
		{/if}
		{#if wpLabels[j] != null}
			{@const L = wpLabels[j]}
			<text
				class="wp-label"
				x={px + (L.anchor === 'start' ? 2 : L.anchor === 'end' ? -2 : 0)}
				y={PAD_T - 16}
				text-anchor={L.anchor}>{L.text}</text
			>
		{/if}
	{/each}

	<!-- overflown ground features (trace mode): dashed ticks + stacked idents -->
	{#if features}
		{#each features as f, i (i)}
			{#if f.distNM >= fromNM - 1e-6 && f.distNM <= toNM + 1e-6}
				<line class="feat-tick" x1={x(f.distNM)} x2={x(f.distNM)} y1={PAD_T} y2={baseY} />
			{/if}
		{/each}
		{#each featureLabels as fl (fl.key)}
			{#if onFeatureClick}
				<text
					class="feat-label clickable"
					x={fl.x}
					y={fl.y}
					text-anchor="middle"
					role="button"
					tabindex="0"
					onclick={() => onFeatureClick?.(fl.idx)}
					onkeydown={(e) => featKey(e, fl.idx)}>{fl.text}<title>{fl.name}</title></text
				>
			{:else}
				<text class="feat-label" x={fl.x} y={fl.y} text-anchor="middle"
					>{fl.text}<title>{fl.name}</title></text
				>
			{/if}
		{/each}
	{/if}

	<!-- replay playhead / pinned point / the route profile's live marker.
	 Culled when the window excludes it: it draws OUTSIDE the clipped group
	 and x() does not clamp, so an off-window position would paint the rule
	 into the axis gutters (a zoomed phone window crosses it routinely). -->
	{#if playheadNM != null}
		{@const phx = x(playheadNM)}
		{#if phx >= PAD_L && phx <= plotRight}
			{@const py = altAtDistNM(playheadNM)}
			<line class="playhead" x1={phx} x2={phx} y1={PAD_T} y2={baseY} />
			{#if py != null}
				<circle class="playhead-dot" cx={phx} cy={y(py)} r={3.5} />
			{/if}
			<!-- Ownship at ACTUAL altitude, culled on y like the rule is on x
			 (both draw outside the clip and neither scale clamps). The dashed
			 link to the planned dot is the vertical deviation made visible;
			 it needs both ends inside the window. -->
			{#if playheadAltFt != null}
				{@const ay = y(playheadAltFt)}
				{#if ay >= PAD_T && ay <= baseY}
					{#if py != null && y(py) >= PAD_T && y(py) <= baseY}
						<line class="live-alt-link" x1={phx} x2={phx} y1={y(py)} y2={ay} />
					{/if}
					<circle class="live-alt-dot" cx={phx} cy={ay} r={4.5} />
				{/if}
			{/if}
		{/if}
	{/if}

	<!-- hover/scrub crosshair (the capture rect itself sits lower in the svg,
	 beneath the interactive marks; the crosshair stays last so it draws over
	 everything, pointer-events: none) -->
	{#if onCursor && hoverNM != null && !pinned}
		{@const ay = altAtDistNM(hoverNM)}
		<line class="cursor-line" x1={x(hoverNM)} x2={x(hoverNM)} y1={PAD_T} y2={baseY} />
		{#if ay != null}
			<circle class="cursor-dot" cx={x(hoverNM)} cy={y(ay)} r={3.5} />
		{/if}
	{/if}
</svg>

<style>
	.plot {
		display: block;

		/* A drag that starts on empty chart (or misses a hit stroke) must
		   never text-select the axis labels; touch gestures (pan / pinch /
		   the leg drag) belong to the chart, not the page. */
		user-select: none;
		touch-action: none;
	}

	.plot:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.plot.dragging {
		cursor: ns-resize;
	}

	.plot.panning {
		cursor: grabbing;
	}

	/* Axis grab zones: the resize cursor is the whole affordance, so it stays
	   on through the drag, where it reads as the constraint. */
	.gutter {
		fill: transparent;
	}

	.gy {
		cursor: ns-resize;
	}

	.gx {
		cursor: ew-resize;
	}

	.grid {
		stroke: var(--border);
		stroke-width: 1;
	}

	.xlabel {
		fill: var(--text-muted);
		font-family: ui-monospace, monospace;
		font-size: 9px;
	}

	.ay-tick {
		stroke: var(--border);
		stroke-width: 1;
	}

	.ay-label {
		fill: var(--text-muted);
		font-family: ui-monospace, monospace;
		font-size: 9px;
	}

	.axis-unit {
		fill: var(--text-muted);
		font-family: ui-monospace, monospace;
		font-size: 9px;
	}

	.band {
		cursor: pointer;
	}

	.band path {
		fill: var(--as-color);
		fill-opacity: 0.1;
		stroke: var(--as-color);
		stroke-width: 0.75;
		stroke-opacity: 0.4;
		pointer-events: all;
	}

	.band.unknown path {
		fill: none;
		stroke-dasharray: 3 3;
		stroke-opacity: 0.5;
	}

	.band.highlight path {
		fill-opacity: 0.25;
		stroke-width: 2;
		stroke-opacity: 0.9;
	}

	.band.dimmed path {
		fill-opacity: 0.07;
		stroke-opacity: 0.25;
	}

	/* RTBA identity: the GEN 2.3 pecked strip as a heavy dashed chart-red
	   outline on the band's own path, always drawn hot or cold (the
	   activation hatch stays the separate "active now" mark), the map's
	   layering. Placed after the highlight / dimmed rules so its weight and
	   dash win the ties; the hatch overlay path never carries .pecked. */
	.band path.pecked {
		stroke-width: 2.5;
		stroke-opacity: 0.85;
		stroke-dasharray: 10 4;
	}

	.band.highlight path.pecked {
		stroke-width: 3.5;
	}

	.band.dimmed path.pecked {
		stroke-opacity: 0.3;
	}

	/* NOTAM-activation hatch overlay: rides its band's spans, never
	   interactive (the band group beneath keeps hover / click). Full
	   fill-opacity, the map overlay's value: the pattern's 3-on-8 stripes
	   carry the density. `path.act-hatch` (not bare `.act-hatch`) so these
	   rules outrank `.band.highlight path` / `.band.dimmed path` above. */
	.band path.act-hatch {
		fill-opacity: 1;
		stroke: none;
		pointer-events: none;
	}

	.band.dimmed path.act-hatch {
		fill-opacity: 0.3;
	}

	/* Plan-penetrated portion: the drawn line is inside this volume over
	   exactly this sub-span. Stronger fill + solid outline under the band's
	   own outline (identity above state); R/D/P zones louder than
	   controlled, whose transits are routinely intentional. */
	.band path.pen {
		fill-opacity: 0.18;
		stroke: var(--as-color);
		stroke-width: 1;
		stroke-opacity: 0.7;
		pointer-events: none;
	}

	.band path.pen.zone {
		fill-opacity: 0.26;
		stroke-width: 1.75;
		stroke-opacity: 1;
	}

	/* NO-GO crossing (prohibited / class A under VFR / active RTBA or R):
	   the loudest tier, still under the identity outline. */
	.band path.pen.forbidden {
		fill-opacity: 0.32;
		stroke-width: 2.25;
		stroke-opacity: 1;
	}

	.band.dimmed path.pen {
		fill-opacity: 0.08;
		stroke-opacity: 0.3;
	}

	/* NOTAM bands: the map's area orange as a diagonal hatch (the fill is
	   the per-instance pattern set inline) behind a SOLID outline, the map's
	   own NOTAM-area stroke. The colour + hatch carry "temporary
	   restriction"; profile dashes stay reserved for the two marks with
	   precedent, the RTBA pecked identity and the unknown-extent box. */
	.nband {
		cursor: pointer;
	}

	.nband path {
		fill-opacity: 0.55;
		stroke: #ff7800;
		stroke-width: 1;
		pointer-events: all;
	}

	.nband.unknown path {
		stroke-dasharray: 3 3;
		stroke-opacity: 0.5;
	}

	.nband.highlight path {
		fill-opacity: 0.9;
		stroke-width: 2;
	}

	.nband.dimmed path {
		fill-opacity: 0.15;
		stroke-opacity: 0.3;
	}

	.band-chip rect {
		fill: var(--accent);
		stroke: rgb(255 255 255 / 80%);
		stroke-width: 0.75;
	}

	.band-chip.zone rect {
		fill: var(--airspace-restricted);
	}

	.band-chip text {
		fill: var(--accent-text);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		font-weight: 700;
	}

	.band-label {
		pointer-events: none;
	}

	/* Trace mode: the labels are the bands' click affordance (buttons above
	   the scrub layer); the transparent hit rect makes the whole label line
	   a comfortable target, text glyphs alone are thin. */
	.band-label.clickable {
		pointer-events: all;
		cursor: pointer;
	}

	.band-label.clickable:hover .band-name {
		text-decoration: underline;
	}

	.label-hit {
		fill: transparent;
	}

	.band-label.dimmed {
		opacity: 0.45;
	}

	/* The airspace name, sat on the band over terrain / route: a surface-coloured
	   halo (paint-order: stroke draws it behind the glyphs) keeps it legible. */
	.band-name {
		fill: var(--text);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		font-weight: 600;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2px;
		stroke-linejoin: round;
	}

	/* The vertical-limits second line, muted under the name. */
	.band-limits {
		fill: var(--text-muted);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2px;
		stroke-linejoin: round;
	}

	.terrain {
		fill: var(--terrain-fill);
		stroke: var(--terrain-line);
		stroke-width: 1;
	}

	/* The ground directly under the track, inside the corridor envelope the
	   silhouette fills: dashed so the two read as different questions. */
	.terrain-track {
		fill: none;
		stroke: var(--terrain-line);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		opacity: 0.85;
		pointer-events: none;
	}

	/* Terrain-proximity tint: the restricted red (the forbid banner's ink,
	   theme-aware) as a translucent slice + a firm surface re-stroke. */
	.terrain-tint-fill {
		fill: var(--airspace-restricted);
		fill-opacity: 0.16;
		stroke: none;
		pointer-events: none;
	}

	.terrain-tint-line {
		fill: none;
		stroke: var(--airspace-restricted);
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	/* Transition altitude rule: a muted dashed reference line with a haloed
	   label, non-interactive (an axis annotation, drawn over the plot so it
	   stays visible across bands and terrain). */
	.ta-line {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 5 4;
		pointer-events: none;
	}

	.ta-label {
		font-family: ui-monospace, monospace;
		font-size: 9px;
		fill: var(--text-muted);
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2px;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.route {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		pointer-events: none;
	}

	/* Corridor obstacles: the map's obstacle navy (readable blue in night via
	   the airspace-controlled token) over a surface casing, the wind-barb
	   idiom, so glyphs read on bands and terrain alike. Clickable through
	   to the obstacle panel. */
	.obst {
		cursor: pointer;
	}

	.obst .casing {
		fill: none;
		stroke: var(--surface);
		stroke-width: 3.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.obst .ink {
		fill: none;
		stroke: var(--airspace-controlled);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.obst .ink.rays {
		stroke-width: 1.1;
	}

	/* Temporary obstacles (obstacle NOTAMs): the NOTAM-band orange marks the
	   source; clickable through to the NOTAM panel. */
	.obst.notam {
		cursor: pointer;
	}

	.obst.notam .ink {
		stroke: #ff7800;
	}

	/* Terrain-proximity rule: an obstacle whose top the line clears by less
	   than the shared 500 ft margin (or passes under) inks the restricted
	   red. AFTER the notam rule on purpose: equal specificity, last wins,
	   so a close temporary obstacle reddens too. */
	.obst.close .ink {
		stroke: var(--airspace-restricted);
	}

	/* Cloud curtain: okta-quantised grey cells behind the bands. Fixed hex
	 * like .fz, so both themes and the pinned light print palette read the
	 * same layers; the amount words step the opacity. */
	.clouds {
		pointer-events: none;
	}

	.clouds rect {
		fill: #7c8796;
	}

	.clouds rect.few {
		fill-opacity: 0.1;
	}

	.clouds rect.sct {
		fill-opacity: 0.2;
	}

	.clouds rect.bkn {
		fill-opacity: 0.34;
	}

	.clouds rect.ovc {
		fill-opacity: 0.5;
	}

	/* Per-leg MSA: muted short-dashed grey over a surface casing, stepped
	 * per leg (dash cadence distinct from the TA rule's 5 4 and the
	 * freezing line's 7 5; the "MSA" label disambiguates). */
	.msa-casing {
		fill: none;
		stroke: var(--surface);
		stroke-width: 4;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.msa {
		fill: none;
		stroke: var(--text-muted);
		stroke-width: 1.6;
		stroke-dasharray: 2 3;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.msa-label {
		font-size: 10px;
		fill: var(--text-muted);
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3;
		stroke-linejoin: round;
	}

	/* Freezing level: the map isotherm's dashed blue over a surface casing,
	 * stepped per leg. */
	.fz-casing {
		fill: none;
		stroke: var(--surface);
		stroke-width: 4;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.fz {
		fill: none;
		stroke: #1c5fbf;
		stroke-width: 1.8;
		stroke-dasharray: 7 5;
		stroke-linecap: round;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.fz-label {
		font-size: 10px;
		fill: #1c5fbf;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3;
		stroke-linejoin: round;
	}

	/* Wind barbs: theme ink over a surface casing so they read on the bands;
	 * pennant subpaths fill, the calm circle stays open. */
	.wind-barb .casing {
		fill: none;
		stroke: var(--surface);
		stroke-width: 3.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.wind-barb .ink {
		fill: var(--text);
		stroke: var(--text);
		stroke-width: 1.4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.wind-barb .ink-open {
		fill: none;
		stroke: var(--text);
		stroke-width: 1.4;
	}

	.wind-barb .dot {
		fill: var(--text);
	}

	/* Leg-drag ghost: the committed level under the pointer. Accent ink with
	   the surface halo (the .fz-label idiom) so it reads over any band. */
	.drag-guide {
		stroke: var(--accent);
		stroke-width: 1;
		stroke-dasharray: 4 3;
		pointer-events: none;
	}

	.drag-label {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 700;
		fill: var(--accent);
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 3px;
		stroke-linejoin: round;
		pointer-events: none;
	}

	.leg-hit {
		fill: none;
		stroke: transparent;
		stroke-width: 14;
		pointer-events: stroke;
		cursor: ns-resize;
		touch-action: none;
	}

	/* Wider grab stroke for fingers (the RangeSlider handle precedent). */
	@media (pointer: coarse) {
		.leg-hit {
			stroke-width: 22;
		}
	}

	.leg-hit:hover,
	.leg-hit.active,
	.leg-hit:focus-visible {
		stroke: var(--accent);
		stroke-opacity: 0.18;
	}

	.leg-hit:focus-visible {
		outline: none; /* the stroke treatment IS the focus affordance */
	}

	.wp-tick {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 2 2;
		stroke-opacity: 0.5;
		pointer-events: none;
	}

	.wp-dot {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 1;
	}

	.wp.clickable {
		cursor: pointer;
	}

	.wp-hit {
		fill: transparent;
	}

	.wp.clickable:hover .wp-dot {
		r: 4px;
	}

	.wp-label {
		fill: var(--text);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		font-weight: 600;
		pointer-events: none;
	}

	/* Overflown-feature ticks + labels (trace mode), in the trace's orange. */
	.feat-tick {
		stroke: var(--nav-orange);
		stroke-width: 1;
		stroke-dasharray: 2 3;
		stroke-opacity: 0.55;
		pointer-events: none;
	}

	.feat-label {
		fill: var(--nav-orange);
		font-family: ui-monospace, monospace;
		font-size: 9px;
		font-weight: 600;
		paint-order: stroke;
		stroke: var(--surface);
		stroke-width: 2.4px;
		stroke-linejoin: round;
		pointer-events: none;
	}

	/* Clickable feature labels (trace mode, onFeatureClick wired): buttons
	   above the scrub layer; the labels sit in the top gutter, so they steal
	   no plot-area scrub pixels. */
	.feat-label.clickable {
		pointer-events: all;
		cursor: pointer;
	}

	.feat-label.clickable:hover {
		text-decoration: underline;
	}

	.playhead {
		stroke: #1565c0;
		stroke-width: 1.5;
		pointer-events: none;
	}

	/* Live route mode: the flown side rests under a surface wash (the
	   route-progress map convention). */
	.flown-dim {
		fill: var(--surface);
		fill-opacity: 0.35;
		pointer-events: none;
	}

	.playhead-dot {
		fill: #1565c0;
		stroke: var(--surface);
		stroke-width: 1.5;
		pointer-events: none;
	}

	/* Ownship at actual altitude: the live ink (the strip / progress family),
	   ringed in --surface like the planned dot so it stands on any band. The
	   link is the vertical deviation between the two. */
	.live-alt-dot {
		fill: var(--nav-orange);
		stroke: var(--surface);
		stroke-width: 1.5;
		pointer-events: none;
	}

	.live-alt-link {
		stroke: var(--nav-orange);
		stroke-width: 1.5;
		stroke-dasharray: 3 3;
		pointer-events: none;
	}

	/* Route-mode inspect crosshair: the trace cursor-line styling. */
	.inspect-line {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		pointer-events: none;
	}

	/* Hover/scrub inspector (trace profile). */
	.cursor-capture {
		fill: transparent;
		cursor: crosshair;
		touch-action: none;
	}

	/* A pan owns the pointer even over the scrub rect, whose own crosshair
	   would otherwise win it as the deeper element. */
	.plot.panning .cursor-capture {
		cursor: grabbing;
	}

	.cursor-line {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: 3 3;
		pointer-events: none;
	}

	.cursor-dot {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 1.5;
		pointer-events: none;
	}
</style>
