/* The profile charts' shared pointer state machine: wheel step -> zoom
 * factor, one-pointer slop-then-capture pan, optional two-finger pinch,
 * and the settling paths (pointerup / pointercancel / lostpointercapture
 * / a buttonless move after a missed off-target release). Pure DOM + Math
 * (no Svelte): the chart wires the handlers and keeps its own axis
 * mapping, so the documented per-chart differences stand where they are
 * decided: RouteProfile's 2-axis pan + pinch + cursor-anchored wheel vs
 * VerticalProfile's one-axis pan-x touch-action, floor-anchored wheel and
 * no pinch (docs/route-profile.md, docs/map-profile.md).
 *
 * Capture is taken only once a gesture ENGAGES (pan past the slop, or a
 * second finger): capture retargets the eventual click to the capture
 * element, so capturing at press time would steal the click from whatever
 * sits under the pointer. Deferring it lets a pan start ANYWHERE on the
 * plot, bands and columns included, while an un-moved press still clicks
 * the element under it. The middle button is the one immediate engage,
 * having no click to protect, and with `touchPan` off it is what gives a
 * chart whose primary button is spoken for (the trace profile's replay
 * scrub) a pointer pan at all. */

/** Wheel delta to zoom factor (> 1 zooms out), normalising the three deltaMode
 *  units (pixel / line / page) and clamping the per-event travel so a trackpad
 *  fling cannot jump the window. The one wheel curve of every profile chart,
 *  applied through the machine's `wheel()`. Vitest-pinned. */
export function wheelZoomFactor(delta: number, deltaMode: number): number {
	return Math.exp((wheelPixels(delta, deltaMode) / 100) * 0.2);
}

/** Wheel delta to client pixels: the three deltaMode units normalised and the
 *  per-event travel clamped, so a trackpad fling can move a window no further
 *  than it can scale one. The pan half of the wheel, for a chart mapping a
 *  SIDEWAYS wheel (a trackpad two-finger swipe) onto its own axis; feeding the
 *  same normalised pixels to `emitPan` keeps one curve for both. Vitest-pinned
 *  with the zoom factor it shares. */
export function wheelPixels(delta: number, deltaMode: number): number {
	const scale = deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1;
	return Math.max(-300, Math.min(300, delta * scale));
}

export interface PlotGestureHooks {
	/** Pointer-capture target (the chart svg); capture / release are skipped
	 *  while unmounted. */
	captureEl(): Element | null | undefined;
	/** Incremental pan in client px since the last emit (the slop replayed on
	 *  engage, so the grab re-locks under the pointer). The chart converts to
	 *  its own value units; a one-axis chart ignores the x delta. */
	onPan(dxPx: number, dyPx: number): void;
	/** A gesture engaged (pan past the slop, or a second finger): hovers and
	 *  pending long-presses drop here, and the grabbing cursor turns on. The
	 *  pointer is already captured when this fires. */
	onEngage(): void;
	/** Every pointer settled (release, cancel, lost capture, buttonless
	 *  move): the grabbing cursor resets here. Idempotent by contract. */
	onSettle(): void;
	/** Two-finger pinch (`pinch: true` only): per-axis span factors (> 1
	 *  zooms out; 1 = axis unchanged or under the minimum span) about the
	 *  current midpoint, emitted AFTER the same move's midpoint pan, so a
	 *  caller that applies the pan synchronously anchors on the post-pan
	 *  window. */
	onPinch?(midX: number, midY: number, xFactor: number, yFactor: number): void;
}

export interface PlotGestureOptions {
	/** Enable the two-finger pinch (touch pointers only). */
	pinch?: boolean;
	/** The middle button pans. It engages AT ONCE, no slop: a middle press
	 *  carries no click to protect, so the grab starts on the first pixel. The
	 *  caller preventDefaults the press it accepts, which is what keeps the
	 *  browsers' middle-click autoscroll / paste out of the plot. Read through
	 *  a thunk so a caller can gate it on a live prop. */
	middlePan?: () => boolean;
	/** A lone touch pointer pans (the default). False where another handler
	 *  owns the single finger (the trace profile's replay scrub): the finger is
	 *  still TRACKED, so a second one promotes to a pinch, and the survivor of
	 *  a pinch keeps panning; only a fresh single finger is refused. */
	touchPan?: () => boolean;
}

export interface PlotGestures {
	/** Track a press: the primary button, or the middle one under `middlePan`.
	 *  True when the press joined the gesture (first pointer, the pinch's
	 *  second finger, or a middle-button pan); the caller decides whether to
	 *  preventDefault on it. */
	down(e: PointerEvent): boolean;
	/** Advance the gesture. True while the move belongs to a live press /
	 *  pan / pinch; false for foreign pointers, no gesture, or the
	 *  buttonless settle, where the caller's hover tail may take the move. */
	move(e: PointerEvent): boolean;
	/** Release a pointer (pointerup AND pointercancel). A pinch losing one
	 *  finger continues as an engaged pan from the survivor, no new slop. */
	up(e: PointerEvent): void;
	/** lostpointercapture: capture can vanish without a pointerup (the
	 *  browser reclaims the pointer, the captured element re-renders), so
	 *  settle the matching gesture here too; the pan latch must not outlive
	 *  the capture. Idempotent after a normal release. */
	lost(e: PointerEvent): void;
	/** Wheel step -> zoom factor, or null when the wheel must not zoom (a
	 *  live press / pan / pinch, or the caller's own `busy` veto), the page
	 *  scroll eaten either way. The caller guards its unwired mounts BEFORE
	 *  calling, keeping native scroll there. */
	wheel(e: WheelEvent, busy?: boolean): number | null;
	/** A pointer is pressed or captured (hover inspectors suppress on it). */
	active(): boolean;
	/** The pan engaged or a pinch is live (a long-press yields to it). */
	engaged(): boolean;
	/** Drop the gesture, releasing any capture (the long-press menu takes
	 *  the still-down finger). No-op when idle. */
	abort(): void;
}

interface GesturePtr {
	id: number;
	type: string;
	startX: number;
	startY: number;
	x: number;
	y: number;
	captured: boolean;
}

const PAN_SLOP_PX = 4;
const PINCH_MIN_SPAN_PX = 12;

export function createPlotGestures(
	hooks: PlotGestureHooks,
	opts: PlotGestureOptions = {},
): PlotGestures {
	let gp1: GesturePtr | null = null;
	let gp2: GesturePtr | null = null;
	let panEngaged = false;
	let lastX = 0;
	let lastY = 0;

	function ptr(e: PointerEvent): GesturePtr {
		return {
			id: e.pointerId,
			type: e.pointerType,
			startX: e.clientX,
			startY: e.clientY,
			x: e.clientX,
			y: e.clientY,
			captured: false,
		};
	}

	function capture(p: GesturePtr): void {
		try {
			hooks.captureEl()?.setPointerCapture(p.id);
			p.captured = true;
		} catch {
			/* capture unavailable; the gesture still works in-bounds */
		}
	}

	function release(p: GesturePtr): void {
		if (!p.captured) {
			return;
		}
		p.captured = false;
		try {
			hooks.captureEl()?.releasePointerCapture(p.id);
		} catch {
			/* already gone */
		}
	}

	function down(e: PointerEvent): boolean {
		if (e.button === 1 && !gp1 && opts.middlePan?.() === true) {
			gp1 = ptr(e);
			// Engaged on the press: there is no click under a middle button to
			// keep, so the pan needs no slop and the grab starts here.
			panEngaged = true;
			lastX = e.clientX;
			lastY = e.clientY;
			capture(gp1);
			hooks.onEngage();
			return true;
		}
		if (e.button !== 0) {
			return false;
		}
		if (!gp1) {
			gp1 = ptr(e);
			panEngaged = false;
			return true;
		}
		if (
			opts.pinch === true &&
			!gp2 &&
			e.pointerId !== gp1.id &&
			e.pointerType === 'touch' &&
			gp1.type === 'touch'
		) {
			gp2 = ptr(e);
			panEngaged = false;
			// A pinch engages immediately: take both fingers now.
			capture(gp1);
			capture(gp2);
			hooks.onEngage();
			return true;
		}
		return false;
	}

	function move(e: PointerEvent): boolean {
		// Pinch: pan by the midpoint displacement, then zoom each axis by its
		// span ratio (factors computed AFTER the pan: a caller applying the
		// pan synchronously anchors its inverses on the post-pan window).
		if (gp1 && gp2 && (e.pointerId === gp1.id || e.pointerId === gp2.id)) {
			const pdx = Math.abs(gp1.x - gp2.x);
			const pdy = Math.abs(gp1.y - gp2.y);
			const pmx = (gp1.x + gp2.x) / 2;
			const pmy = (gp1.y + gp2.y) / 2;
			const p = e.pointerId === gp1.id ? gp1 : gp2;
			p.x = e.clientX;
			p.y = e.clientY;
			const cdx = Math.abs(gp1.x - gp2.x);
			const cdy = Math.abs(gp1.y - gp2.y);
			const cmx = (gp1.x + gp2.x) / 2;
			const cmy = (gp1.y + gp2.y) / 2;
			hooks.onPan(cmx - pmx, cmy - pmy);
			const xFactor =
				pdx >= PINCH_MIN_SPAN_PX && cdx >= PINCH_MIN_SPAN_PX
					? Math.max(0.5, Math.min(2, pdx / cdx))
					: 1;
			const yFactor =
				pdy >= PINCH_MIN_SPAN_PX && cdy >= PINCH_MIN_SPAN_PX
					? Math.max(0.5, Math.min(2, pdy / cdy))
					: 1;
			if (xFactor !== 1 || yFactor !== 1) {
				hooks.onPinch?.(cmx, cmy, xFactor, yFactor);
			}
			return true;
		}
		// One-pointer pan: slop, then incremental deltas.
		if (gp1 && !gp2 && e.pointerId === gp1.id) {
			// A press that never engaged holds no capture, so its pointerup can
			// land off-plot and never reach us: a later hover move with the
			// same (stable) mouse id would replay as a buttonless drag. Settle
			// the latch instead of panning; the caller's hover tail may take
			// the move.
			if (e.buttons === 0) {
				gp1 = null;
				panEngaged = false;
				hooks.onSettle();
				return false;
			}
			gp1.x = e.clientX;
			gp1.y = e.clientY;
			if (!panEngaged) {
				if (gp1.type === 'touch' && opts.touchPan?.() === false) {
					// Tracked for the pinch only: the caller owns this finger,
					// and its position has just been updated so a second finger
					// starts its span from where this one actually is.
					return true;
				}
				if (Math.hypot(e.clientX - gp1.startX, e.clientY - gp1.startY) < PAN_SLOP_PX) {
					return true;
				}
				panEngaged = true;
				capture(gp1); // from here the click goes to the capture element
				hooks.onEngage();
				// Replay the slop so the grab locks under the pointer.
				lastX = gp1.startX;
				lastY = gp1.startY;
			}
			hooks.onPan(e.clientX - lastX, e.clientY - lastY);
			lastX = e.clientX;
			lastY = e.clientY;
			return true;
		}
		return false;
	}

	/** Hand the surviving pinch finger the pan, with no new slop. */
	function continueFrom(p: GesturePtr): void {
		panEngaged = true;
		lastX = p.x;
		lastY = p.y;
	}

	function up(e: PointerEvent): void {
		if (gp2 && e.pointerId === gp2.id) {
			release(gp2);
			gp2 = null;
			if (gp1) {
				continueFrom(gp1);
			}
			return;
		}
		if (gp1 && e.pointerId === gp1.id) {
			release(gp1);
			if (gp2) {
				gp1 = gp2;
				gp2 = null;
				continueFrom(gp1);
				return;
			}
			gp1 = null;
			panEngaged = false;
			hooks.onSettle();
		}
	}

	function lost(e: PointerEvent): void {
		if (gp2 && e.pointerId === gp2.id) {
			gp2.captured = false;
			gp2 = null;
			if (gp1) {
				continueFrom(gp1);
			}
			return;
		}
		if (gp1 && e.pointerId === gp1.id) {
			gp1.captured = false;
			gp1 = gp2;
			gp2 = null;
			if (gp1) {
				continueFrom(gp1);
			} else {
				panEngaged = false;
				hooks.onSettle();
			}
		}
	}

	function wheel(e: WheelEvent, busy = false): number | null {
		e.preventDefault(); // the surface never scrolls under the plot wheel
		if (busy || gp1 !== null) {
			return null; // never rescale under a live drag / pan / pinch
		}
		const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		if (raw === 0) {
			return null;
		}
		return wheelZoomFactor(raw, e.deltaMode);
	}

	function abort(): void {
		if (!gp1 && !gp2) {
			return;
		}
		if (gp2) {
			release(gp2);
			gp2 = null;
		}
		if (gp1) {
			release(gp1);
			gp1 = null;
		}
		panEngaged = false;
		hooks.onSettle();
	}

	return {
		down,
		move,
		up,
		lost,
		wheel,
		abort,
		active: () => gp1 !== null,
		engaged: () => panEngaged || gp2 !== null,
	};
}
