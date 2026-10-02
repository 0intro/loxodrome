import L from 'leaflet';

/* keyPan.ts: a held arrow key pans the map continuously.
 *
 * Leaflet's keyboard handler pans by a fixed 80 px step per keydown, animated
 * over a quarter of a second, and drops every keydown that lands while that
 * animation runs: a held key moved in bursts, 720 px in nine stop-and-go
 * settles over two seconds, each settle repainting every canvas layer, and
 * missed 95 % of its frames (docs/performance-2026-09.md, "Desktop pan and
 * zoom"). Here a held arrow moves the map every frame, the way a drag does:
 * the map pane moves by whole pixels with a `move` event per frame, starting
 * at 400 px/s and reaching 1000 px/s after 350 ms (Shift triples it, as it
 * triples Leaflet's step; a reduced-motion preference keeps the start
 * speed), and the view settles (`moveend`) when the last key comes up, and
 * also each time the pan has covered half the viewport, so the canvas
 * layers, which repaint on a settle, fill the side the map moves toward
 * while it glides.
 *
 * Leaflet keeps the rest of its keyboard: the container's tabindex and focus,
 * + and - to zoom, Escape. Its arrows are taken away without touching its
 * internals: it pans from a DOCUMENT keydown listener, active while the
 * container itself has focus, so a container listener that stops a plain or
 * Shift arrow's propagation keeps it from ever arriving there, or at the
 * window listeners that step the nav log's and the route profile's routes,
 * which Leaflet's own handler stopped too. Leaflet's container listener,
 * registered first, still turns the key into the map's `keydown`. A Ctrl,
 * Alt or Meta arrow is left alone, as Leaflet leaves it, except while a pan
 * runs: then every arrow is swallowed, and only a plain or Shift one joins.
 *
 * The gesture as a whole is announced (KEYPAN_START, KEYPAN_END) for what
 * must know that the pilot is steering the view, follow mode above all
 * (navLayer.ts), since it fires no `dragstart`. The glide yields to every
 * other movement: another source's `movestart` or `zoomstart` (a wheel zoom,
 * a flyTo, a drag) stops it without a `moveend` of its own, the other
 * movement's closing the view, and it resumes after that `moveend` if the
 * keys are still down, ramping up again; a pointer going down settles it
 * and it resumes when the pointer comes up. The last key coming up, the
 * container or the window losing focus and the page going hidden end it,
 * since a keyup may never come. */

/** The map events that open and close a key pan, the whole gesture: one
 *  pair per hold, however many settles and pauses it contains. */
export const KEYPAN_START = 'keypanstart';
export const KEYPAN_END = 'keypanend';

type Arrow = 'left' | 'right' | 'up' | 'down';

const ARROWS: Partial<Record<string, Arrow>> = {
	ArrowLeft: 'left',
	ArrowRight: 'right',
	ArrowUp: 'up',
	ArrowDown: 'down',
};

/** Speeds in CSS px per second, and the ramp from one to the other. */
const START_PX_S = 400;
const TOP_PX_S = 1000;
const RAMP_MS = 350;
/** Shift's factor, the one Leaflet applies to its step. */
const SHIFT_FACTOR = 3;
/** The longest frame a step is computed over, so a stalled frame (a settle's
 *  repaint, a tab coming back) moves the map this far and no further. */
const MAX_FRAME_MS = 50;
/** The glide settles each time it has covered this share of the viewport. */
const SETTLE_SHARE = 0.5;

/** The pan speed `heldMs` into a glide, CSS px per second. Pure. */
export function keyPanSpeed(heldMs: number, shift: boolean, reduced: boolean): number {
	const ramp = reduced ? 0 : Math.min(Math.max(heldMs, 0) / RAMP_MS, 1);
	const speed = START_PX_S + (TOP_PX_S - START_PX_S) * ramp;
	return shift ? speed * SHIFT_FACTOR : speed;
}

/** The unit vector the held arrows move the VIEW along, in screen axes (y
 *  down): opposite keys cancel, and a diagonal is as fast as a straight
 *  line. Pure. */
export function keyPanDirection(held: ReadonlySet<Arrow>): { x: number; y: number } {
	const x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
	const y = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
	const k = x !== 0 && y !== 0 ? Math.SQRT1_2 : 1;
	return { x: x * k, y: y * k };
}

function prefersReducedMotion(): boolean {
	try {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

/** The mark on the events this module fires, so its own listeners tell them
 *  from another source's (Leaflet copies an event's data onto it). */
interface KeyPanMark {
	keyPan?: true;
}

/** Whether a map event is one a key pan fired: its own movestart, and the
 *  moveend it settles with each half viewport while the glide goes on (and
 *  once more as it ends). */
export function isKeyPanEvent(e: L.LeafletEvent): boolean {
	return (e as L.LeafletEvent & KeyPanMark).keyPan === true;
}

/** Arm the continuous key pan on `map`, right after L.map(). Returns the
 *  disarm, which fires nothing: it runs as the view is taken down. */
export function armKeyPan(map: L.Map): () => void {
	const container = map.getContainer();
	const found = map.getPane('mapPane');
	if (!found) {
		return () => undefined;
	}
	const pane: HTMLElement = found;
	const held = new Set<Arrow>();
	let shift = false;
	// KEYPAN_START went out for the current hold.
	let announced = false;
	// This module's movestart went out and its moveend has not.
	let moving = false;
	// Another source's movement is under way, or a pointer is down.
	let external = false;
	let pointerDown = false;
	let frame: number | null = null;
	let rampStart = 0;
	let lastFrame = 0;
	let reduced = false;
	let carry = { x: 0, y: 0 };
	let covered = { x: 0, y: 0 };

	const mark: KeyPanMark = { keyPan: true };
	const fire = (type: string): void => {
		map.fire(type, mark);
	};
	const ours = isKeyPanEvent;
	const free = (): boolean => held.size > 0 && !external && !pointerDown && !document.hidden;

	const request = (): void => {
		frame ??= requestAnimationFrame(step);
	};
	const cancel = (): void => {
		if (frame !== null) {
			cancelAnimationFrame(frame);
			frame = null;
		}
	};

	/** Close the view if this module opened it. */
	const settle = (): void => {
		if (moving) {
			moving = false;
			fire('moveend');
		}
	};

	/** The hold is over: settle, and close the gesture. */
	const end = (): void => {
		held.clear();
		cancel();
		settle();
		if (announced) {
			announced = false;
			fire(KEYPAN_END);
		}
	};

	function step(now: number): void {
		frame = null;
		if (!free()) {
			return;
		}
		if (!moving) {
			// Open the view from rest: no distance on this frame, the ramp
			// counting from it.
			moving = true;
			rampStart = now;
			lastFrame = now;
			carry = { x: 0, y: 0 };
			covered = { x: 0, y: 0 };
			reduced = prefersReducedMotion();
			fire('movestart');
			if (!announced) {
				announced = true;
				fire(KEYPAN_START);
			}
			request();
			return;
		}
		const dt = Math.min(Math.max(now - lastFrame, 0), MAX_FRAME_MS);
		lastFrame = now;
		const dir = keyPanDirection(held);
		const travel = (keyPanSpeed(now - rampStart, shift, reduced) * dt) / 1000;
		// Whole pixels only, the pane staying on the pixel grid the tiles and
		// the canvases are drawn on; the remainder rides to the next frame.
		const fx = dir.x * travel + carry.x;
		const fy = dir.y * travel + carry.y;
		const dx = Math.trunc(fx);
		const dy = Math.trunc(fy);
		carry = { x: fx - dx, y: fy - dy };
		if (dx !== 0 || dy !== 0) {
			L.DomUtil.setPosition(pane, L.DomUtil.getPosition(pane).subtract([dx, dy]));
			fire('move');
			covered = { x: covered.x + Math.abs(dx), y: covered.y + Math.abs(dy) };
			const size = map.getSize();
			if (covered.x >= size.x * SETTLE_SHARE || covered.y >= size.y * SETTLE_SHARE) {
				covered = { x: 0, y: 0 };
				fire('moveend');
				// A moveend listener may have started a movement of its own,
				// which took the view over (onExternalStart).
				if (!moving) {
					return;
				}
				fire('movestart');
			}
		}
		request();
	}

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.target !== container) {
			return;
		}
		shift = e.shiftKey;
		const arrow = ARROWS[e.key];
		if (!arrow) {
			return;
		}
		const modified = e.ctrlKey || e.altKey || e.metaKey;
		if (modified && held.size === 0) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (modified || held.has(arrow)) {
			return;
		}
		held.add(arrow);
		if (!moving) {
			request();
		}
	};

	const onKeyUp = (e: KeyboardEvent): void => {
		shift = e.shiftKey;
		const arrow = ARROWS[e.key];
		if (!arrow || !held.delete(arrow)) {
			return;
		}
		if (held.size === 0) {
			end();
		}
	};

	const onBlur = (): void => {
		if (held.size > 0) {
			end();
		}
	};

	const onVisibility = (): void => {
		if (document.hidden) {
			onBlur();
		}
	};

	const onPointerDown = (): void => {
		pointerDown = true;
		cancel();
		settle();
	};

	const onPointerUp = (): void => {
		if (!pointerDown) {
			return;
		}
		pointerDown = false;
		if (free() && !moving) {
			request();
		}
	};

	const onExternalStart = (e: L.LeafletEvent): void => {
		if (ours(e)) {
			return;
		}
		external = true;
		cancel();
		// Silently: the other movement closes the view with its own moveend.
		moving = false;
	};

	const onExternalEnd = (e: L.LeafletEvent): void => {
		if (ours(e)) {
			return;
		}
		external = false;
		if (free() && !moving) {
			request();
		}
	};

	container.addEventListener('keydown', onKeyDown);
	container.addEventListener('keyup', onKeyUp);
	container.addEventListener('blur', onBlur);
	container.addEventListener('pointerdown', onPointerDown, true);
	window.addEventListener('pointerup', onPointerUp, true);
	window.addEventListener('pointercancel', onPointerUp, true);
	window.addEventListener('blur', onBlur);
	document.addEventListener('visibilitychange', onVisibility);
	// i18n-ignore: Leaflet event names, not display text
	map.on('movestart zoomstart', onExternalStart);
	map.on('moveend', onExternalEnd);

	return () => {
		cancel();
		held.clear();
		moving = false;
		announced = false;
		container.removeEventListener('keydown', onKeyDown);
		container.removeEventListener('keyup', onKeyUp);
		container.removeEventListener('blur', onBlur);
		container.removeEventListener('pointerdown', onPointerDown, true);
		window.removeEventListener('pointerup', onPointerUp, true);
		window.removeEventListener('pointercancel', onPointerUp, true);
		window.removeEventListener('blur', onBlur);
		document.removeEventListener('visibilitychange', onVisibility);
		// i18n-ignore: Leaflet event names, not display text
		map.off('movestart zoomstart', onExternalStart);
		map.off('moveend', onExternalEnd);
	};
}
