/* The distance-profile modals' zoom / pan / fit window state machine
 * (RouteProfileModal and NavProfileModal): the two axis windows with
 * their touched flags, the plot box size, and the apply paths that push
 * every gesture through the pure zoomWindow / panWindow clamps
 * (route/routeProfile.ts, spec-pinned). One factory so the two modals
 * cannot drift; the TWO PERSISTENCE RULES STAY TWO (docs/route-profile.md
 * "Window: zoom, pan, persistence"): the route modal persists per change
 * into its per-route savedViews Map through `onTouched`, the trace modal
 * saves on close and passes none, and each keeps its own restore effect,
 * writing the fields here.
 *
 * Touched flips only when a window actually moves (a wheel pinned at the
 * minimum span or a pan at a bound is a no-op), and an untouched axis
 * keeps tracking the fit: the reset paths in the callers write
 * viewToNM / viewCeilingFt from the live totals while !touched. */

import { panWindow, zoomWindow } from '$lib/route/routeProfile';
import { fmtNM } from '$lib/route/format';

export interface ProfileWindowSource {
	/** Full distance range (NM): the dist window clamps to [0, totalNM]. */
	totalNM: () => number;
	/** Altitude zoom / pan ceiling (ft): the alt window clamps to
	 *  [0, dataCeilingFt], the slider track top. */
	dataCeilingFt: () => number;
	/** The fitted altitude window's top (what Fit restores). */
	fitCeilingFt: () => number;
	/** Enough data to draw; gates `ready`. */
	enough: () => boolean;
	/** Altitude bubble text: the route axis is FL-aware above the TA, the
	 *  trace axis all-feet by contract (docs/route-profile.md). */
	fmtAltBubble: (v: number) => string;
	/** A user window change to persist (slider, wheel, pinch, pan). The
	 *  route modal saves per change; the trace modal saves on close. */
	onTouched?: () => void;
	/** Fit pressed: the persisted window is forgotten. */
	onFitForget?: () => void;
}

export interface ProfileWindowState {
	/** Plot box size (bind:clientWidth / clientHeight). */
	plotW: number;
	plotH: number;
	/** The visible windows; the restore effects write these directly. */
	viewFromNM: number;
	viewToNM: number;
	viewFloorFt: number;
	viewCeilingFt: number;
	distTouched: boolean;
	altTouched: boolean;
	readonly distMinSpan: number;
	readonly distStep: number;
	readonly ready: boolean;
	/** Slider commits (already clamped by RangeSlider). Function-typed
	 *  properties (closures over the factory state, no `this`), so the
	 *  templates can pass them as callbacks directly. */
	onDistWindow: (from: number, to: number) => void;
	onAltWindow: (floor: number, ceiling: number) => void;
	/** Wheel / pinch zoom emitted by the chart; applied + clamped here. */
	applyZoom: (axis: 'dist' | 'alt', anchor: number, factor: number) => void;
	/** Drag / keyboard pan emitted by the chart; applied + clamped here. */
	applyPan: (dxNM: number, dyFt: number) => void;
	/** Back to the fitted windows; forgets the persisted view. */
	fitReset: () => void;
	fmtDistBubble: (v: number) => string;
	fmtAltBubble: (v: number) => string;
}

export function createProfileWindow(src: ProfileWindowSource): ProfileWindowState {
	let plotW = $state(0);
	let plotH = $state(0);
	let viewFromNM = $state(0);
	let viewToNM = $state(0);
	let distTouched = $state(false);
	let viewFloorFt = $state(0);
	let viewCeilingFt = $state(0);
	let altTouched = $state(false);

	const distMinSpan = $derived(Math.max(1, Math.round(src.totalNM() / 50)));
	const distStep = $derived(Math.max(1, Math.round(src.totalNM() / 100)));
	const ready = $derived(
		src.enough() && plotW > 0 && plotH > 0 && viewToNM > viewFromNM && viewCeilingFt > viewFloorFt,
	);

	function onDistWindow(from: number, to: number): void {
		viewFromNM = from;
		viewToNM = to;
		distTouched = true;
		src.onTouched?.();
	}

	function onAltWindow(floor: number, ceiling: number): void {
		viewFloorFt = floor;
		viewCeilingFt = ceiling;
		altTouched = true;
		src.onTouched?.();
	}

	function applyZoom(axis: 'dist' | 'alt', anchor: number, factor: number): void {
		if (axis === 'dist') {
			const [lo, hi] = zoomWindow(viewFromNM, viewToNM, anchor, factor, 0, src.totalNM(), distMinSpan);
			if (lo === viewFromNM && hi === viewToNM) {
				return;
			}
			viewFromNM = lo;
			viewToNM = hi;
			distTouched = true;
		} else {
			const [lo, hi] = zoomWindow(viewFloorFt, viewCeilingFt, anchor, factor, 0, src.dataCeilingFt(), 1000);
			if (lo === viewFloorFt && hi === viewCeilingFt) {
				return;
			}
			viewFloorFt = lo;
			viewCeilingFt = hi;
			altTouched = true;
		}
		src.onTouched?.();
	}

	function applyPan(dxNM: number, dyFt: number): void {
		let changed = false;
		const [lo, hi] = panWindow(viewFromNM, viewToNM, dxNM, 0, src.totalNM());
		if (lo !== viewFromNM) {
			viewFromNM = lo;
			viewToNM = hi;
			distTouched = true;
			changed = true;
		}
		const [flo, fhi] = panWindow(viewFloorFt, viewCeilingFt, dyFt, 0, src.dataCeilingFt());
		if (flo !== viewFloorFt) {
			viewFloorFt = flo;
			viewCeilingFt = fhi;
			altTouched = true;
			changed = true;
		}
		if (changed) {
			src.onTouched?.();
		}
	}

	function fitReset(): void {
		distTouched = false;
		altTouched = false;
		viewFromNM = 0;
		viewToNM = src.totalNM();
		viewFloorFt = 0;
		viewCeilingFt = src.fitCeilingFt();
		src.onFitForget?.();
	}

	function fmtDistBubble(v: number): string {
		// i18n-ignore: unit token
		return `${fmtNM(v)} NM`;
	}

	return {
		get plotW() {
			return plotW;
		},
		set plotW(v: number) {
			plotW = v;
		},
		get plotH() {
			return plotH;
		},
		set plotH(v: number) {
			plotH = v;
		},
		get viewFromNM() {
			return viewFromNM;
		},
		set viewFromNM(v: number) {
			viewFromNM = v;
		},
		get viewToNM() {
			return viewToNM;
		},
		set viewToNM(v: number) {
			viewToNM = v;
		},
		get viewFloorFt() {
			return viewFloorFt;
		},
		set viewFloorFt(v: number) {
			viewFloorFt = v;
		},
		get viewCeilingFt() {
			return viewCeilingFt;
		},
		set viewCeilingFt(v: number) {
			viewCeilingFt = v;
		},
		get distTouched() {
			return distTouched;
		},
		set distTouched(v: boolean) {
			distTouched = v;
		},
		get altTouched() {
			return altTouched;
		},
		set altTouched(v: boolean) {
			altTouched = v;
		},
		get distMinSpan() {
			return distMinSpan;
		},
		get distStep() {
			return distStep;
		},
		get ready() {
			return ready;
		},
		onDistWindow,
		onAltWindow,
		applyZoom,
		applyPan,
		fitReset,
		fmtDistBubble,
		fmtAltBubble: src.fmtAltBubble,
	};
}
