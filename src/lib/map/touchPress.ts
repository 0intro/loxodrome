/* touchPress.ts: what a finger on the map means where the mouse model says
 * something else. A long press on a draggable marker is a pick-up before it is
 * a question, a long press on something the map can CARRY (a leg of the
 * route, pulled out into a new waypoint) is too, and the mouse events a
 * finger makes are not a hover.
 *
 * On a touch screen the platform's long press IS the map's right-click: it
 * raises `contextmenu` while the finger is still down (Chromium and the
 * Android WebView natively, iOS Safari through Leaflet's TapHold). The route
 * pins and the map profile's crosshair listen for drag and click only, so the
 * event reaches the map (a desktop right-click over them must still open the
 * map's menu, docs/map-profile.md), and the map's handler opened "What is
 * here" at the hold: on a phone a sheet under a scrim, over the very drag the
 * press had begun. The blocked event does not end the touch, so the pin went
 * on moving blind beneath the sheet, and the sheet outlived the drop,
 * describing the place the pin had left.
 *
 * So the question waits for the answer the gesture gives. The marker lifts at
 * the hold (the pointed-at pin's look, and a tick where the platform
 * vibrates), so the pilot sees the press was taken before choosing; released
 * where it was pressed, the menu opens then, the same menu; carried away, the
 * press was a drag and nothing opens. A right click, the menu key, a long
 * press anywhere but a draggable marker and a long tap raised at the release
 * all open at once, as before: no press is held under a marker then.
 *
 * A CARRY is the same question over something that is not a marker: a leg of
 * the active route, which a mouse drags at once but a finger cannot, a quick
 * drag on the line being a pan. The press asks at its start what it could
 * carry (`carryAt`, map/routeLayer.ts legCarryAt); at the hold the carry
 * PRIMES (its ghost lifts where the finger is, the same tick) and the menu
 * waits. Released there, the carry goes and the menu opens, its Insert row
 * the same leg; past the detent the press CARRIES: every move is stopped
 * here and handed to the carry, so the map's Draggable, which claimed the
 * press at its touchstart, never moves and ends with the touch, and the
 * release drops it (a commit) with no menu. A cancel while carrying drops
 * nothing: an insert must come from a release, not from a system gesture
 * taking the touch.
 *
 * Three rules make the answer hold:
 * - DRIFT IS NOT A CARRY. Leaflet starts a marker's drag at 3 px. Chromium
 *   withholds touchmove inside its own slop (8 to 10 px, measured), Gecko
 *   withholds nothing (measured on the Redmi), so there a jittery tap moved the
 *   waypoint and a long press drifting 3 px became a drag. A press that lands
 *   on a draggable marker therefore keeps its moves from Leaflet until the
 *   finger leaves SLOP_PX (inert under Chromium's own slop), and so does a
 *   press on something it could carry, whose long press must survive the
 *   same jitter; a marker or a carry lifted by a long press keeps them until
 *   the finger leaves the wider DETENT_PX, since a finger held in turbulence
 *   drifts further and a pilot asking for Direct-To would get a moved
 *   waypoint. Stopped here, in the capture phase, before Leaflet's document
 *   listener sees them; once the finger passes, or a second finger lands,
 *   every move of the press is Leaflet's (a carry's are the carry's), so a
 *   drag may come back near where it began.
 * - A CANCEL IS A RELEASE, before anything is carried. A cancelled touch can
 *   drag nothing, so the menu is due then rather than lost (a system gesture
 *   taking the touch; Gecko, which a design review expected to cancel after
 *   a blocked long-press contextmenu, was measured sending the pointerup and
 *   the touchend as Chromium does).
 * - THE DRAG IS LEAFLET'S OWN WORD. `leaflet-marker-draggable` marks a marker
 *   whose dragging is on (MarkerDrag.addHooks), and `leaflet-dragging` sits on
 *   <body> from a Draggable's dragstart to its finishDrag, which runs from
 *   Leaflet's BUBBLING touchend on the document: read in the window's capture
 *   phase of the release, the class still says whether the press became a
 *   drag (Chromium sends the pointerup, which decides first, before the
 *   touchend anyway).
 *
 * The second half is hover. Chromium sends a compatibility mouseover and
 * mousemove at a long press and before a tap's click, and a finger never
 * sends the mouseout, so a hover machine fed by them STICKS: a tap on a route
 * leg left it heavy until the next tap elsewhere, and a held pin's leg stayed
 * heavy at the geometry it had before the drag. pressHeld() says a finger or a
 * pen is down (the long press's echo, which answers nothing at all), and
 * fingerLast() that the last pointer the map saw was a finger (a tap's echo:
 * a real mouse sends its pointermove before its mousemove, and a hovering pen
 * is a hover); MapView's pointer handler reads both.
 *
 * The press is watched on the container, the release on the window (a pin
 * removed under the finger takes the pointer capture with it, and the
 * pointerup lands elsewhere): keyPan.ts's split. The listener options are the
 * OBJECT, never a bare `true`: Node's EventTarget, the suites' stand-in,
 * removes nothing given the boolean. Plain .ts, module state: the flight
 * app's one map view arms it (the NOTAM Viewer has neither a menu nor a
 * draggable marker). */

/** How far a finger on a draggable marker, or on something it could carry,
 *  may move before Leaflet may take the press: Chromium's own slop, which
 *  Gecko does not apply. */
const SLOP_PX = 10;
/** How far a finger may drift from a held press before the marker it lifted
 *  detaches, or the carry it primed begins: past the slop, well inside a
 *  deliberate move. */
const DETENT_PX = 24;
/** The lift's tick, short enough to read as a click (a no-op where the
 *  platform does not vibrate, the APK included without its VIBRATE
 *  permission, and on a silent ringer). */
const HOLD_TICK_MS = 20;
const DRAGGABLE = '.leaflet-marker-draggable';
const DRAGGING = 'leaflet-dragging';
/** The lift is an ATTRIBUTE: DivIcon.createIcon reassigns the icon's
 *  className on every setIcon (routeIcons.ts), which would take a class off a
 *  pin mid-hold. MapView.svelte styles it. */
const HELD = 'data-held';

/** Something a finger's long press can carry off the map's own gesture, the
 *  pointer given in viewport pixels (map/routeLayer.ts legCarry). */
export interface Carry {
	/** The long press held: show what is picked up, where the finger is.
	 *  False when there is nothing to pick up any more, the menu then opening
	 *  at once as for any other long press. */
	prime(clientX: number, clientY: number): boolean;
	/** Every move once the finger has left the detent. */
	move(clientX: number, clientY: number): void;
	/** Released after moving: put it down. */
	commit(): void;
	/** Released before moving, cancelled, or dropped: put everything back. */
	cancel(): void;
}

export interface TouchPressOptions {
	/** What a finger's press at this point could carry, asked when the press
	 *  goes down; null for nothing. */
	carryAt?: ((clientX: number, clientY: number) => Carry | null) | undefined;
}

interface Press {
	pointerId: number;
	/** Where the press went down, the slop's and the detent's centre. */
	x: number;
	y: number;
	/** It went down on a draggable marker, whose drag waits out the slop. */
	onMarker: boolean;
	/** What a finger's long press here would carry, which waits out the slop
	 *  too; null for a marker, a pen, or nothing to carry. */
	carry: Carry | null;
	/** The finger has passed the slop or the detent, or a second one landed:
	 *  every move of the press is Leaflet's from now on. */
	free: boolean;
}

/** A long press waiting for its release: a lifted draggable marker, or a
 *  primed carry, which CARRIES once the finger has left the detent. */
type Pending =
	| { kind: 'lift'; icon: Element; open: () => void }
	| { kind: 'carry'; carry: Carry; carrying: boolean; open: () => void };

/** The primary finger or pen down on the map; null while none is. A mouse
 *  sets none: its right click never waits. */
let held: Press | null = null;
let pending: Pending | null = null;
/** The kind of the last pointer the map saw, '' before any. */
let lastType = '';
/** The armed view's carry provider. */
let carryAt: TouchPressOptions['carryAt'] = undefined;

function dragging(): boolean {
	return typeof document !== 'undefined' && document.body.classList.contains(DRAGGING);
}

/** Forget a waiting menu without opening it: the marker settles, a carry
 *  puts everything back. */
function drop(): void {
	const p = pending;
	pending = null;
	if (p?.kind === 'lift') {
		p.icon.removeAttribute(HELD);
	} else if (p) {
		p.carry.cancel();
	}
}

/** The press ended, lifted or cancelled: a marker's menu opens unless the
 *  press became a drag; a carry is put down if it moved, and a cancel then
 *  puts it back, else its menu opens. */
function release(cancelled: boolean): void {
	const p = pending;
	pending = null;
	if (!p) {
		return;
	}
	if (p.kind === 'lift') {
		p.icon.removeAttribute(HELD);
		if (!dragging()) {
			p.open();
		}
		return;
	}
	if (p.carrying) {
		if (cancelled) {
			p.carry.cancel();
		} else {
			p.carry.commit();
		}
		return;
	}
	p.carry.cancel();
	p.open();
}

/** The draggable marker the event landed on, else null. Duck-typed, SVG
 *  included (a pin's number is an SVG <text>), so the suites can hand a
 *  stand-in carrying closest() alone. */
function draggableAt(target: EventTarget | null): Element | null {
	const t = target as unknown as { closest?: (selector: string) => Element | null } | null;
	return typeof t?.closest === 'function' ? t.closest(DRAGGABLE) : null;
}

/** Arm the long-press rules on the map container, right after L.map().
 *  Returns the disarm. */
export function armTouchPress(container: HTMLElement, options: TouchPressOptions = {}): () => void {
	carryAt = options.carryAt;
	const capture = { capture: true };
	const onDown = (e: PointerEvent): void => {
		// Any press ends a gesture still waiting: a second finger is a pinch,
		// not the release, and a press after a lost release is a new one.
		drop();
		lastType = e.pointerType;
		if (!e.isPrimary) {
			// A pinch or a two-finger pan: the gesture is Leaflet's whole.
			if (held) {
				held.free = true;
			}
			return;
		}
		if (e.pointerType === 'mouse') {
			held = null;
			return;
		}
		const onMarker = draggableAt(e.target) !== null;
		// A carry is a finger's: a pen hovers, and its moves are not touches.
		const carry = !onMarker && e.pointerType === 'touch' ? (carryAt?.(e.clientX, e.clientY) ?? null) : null;
		held = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, onMarker, carry, free: false };
	};
	const onMove = (e: PointerEvent): void => {
		lastType = e.pointerType;
	};
	const onTouchMove = (e: TouchEvent): void => {
		const press = held;
		const touch = e.touches[0];
		if (!press || press.free || !touch || e.touches.length > 1) {
			return;
		}
		const p = pending;
		if (p?.kind === 'carry' && p.carrying) {
			e.stopPropagation();
			p.carry.move(touch.clientX, touch.clientY);
			return;
		}
		const radius = p ? DETENT_PX : press.onMarker || press.carry ? SLOP_PX : 0;
		if (Math.hypot(touch.clientX - press.x, touch.clientY - press.y) < radius) {
			e.stopPropagation();
			return;
		}
		if (p?.kind === 'carry') {
			p.carrying = true;
			e.stopPropagation();
			p.carry.move(touch.clientX, touch.clientY);
			return;
		}
		press.free = true;
	};
	const onPointerEnd = (e: PointerEvent): void => {
		if (held?.pointerId !== e.pointerId) {
			return;
		}
		held = null;
		release(e.type === 'pointercancel');
	};
	const onTouchEnd = (e: TouchEvent): void => {
		if (e.touches.length > 0) {
			return;
		}
		held = null;
		release(e.type === 'touchcancel');
	};
	const onLeave = (): void => {
		held = null;
		drop();
	};
	const onVisibility = (): void => {
		if (document.visibilityState === 'hidden') {
			onLeave();
		}
	};
	container.addEventListener('pointerdown', onDown, capture);
	container.addEventListener('pointermove', onMove, capture);
	container.addEventListener('touchmove', onTouchMove, capture);
	window.addEventListener('pointerup', onPointerEnd, capture);
	window.addEventListener('pointercancel', onPointerEnd, capture);
	window.addEventListener('touchend', onTouchEnd, capture);
	window.addEventListener('touchcancel', onTouchEnd, capture);
	window.addEventListener('blur', onLeave);
	document.addEventListener('visibilitychange', onVisibility);
	return () => {
		container.removeEventListener('pointerdown', onDown, capture);
		container.removeEventListener('pointermove', onMove, capture);
		container.removeEventListener('touchmove', onTouchMove, capture);
		window.removeEventListener('pointerup', onPointerEnd, capture);
		window.removeEventListener('pointercancel', onPointerEnd, capture);
		window.removeEventListener('touchend', onTouchEnd, capture);
		window.removeEventListener('touchcancel', onTouchEnd, capture);
		window.removeEventListener('blur', onLeave);
		document.removeEventListener('visibilitychange', onVisibility);
		onLeave();
		lastType = '';
	};
}

/** A finger or a pen is down on the map: a mouse event now is its echo (the
 *  long press's), and a hover machine must answer nothing. */
export function pressHeld(): boolean {
	return held !== null;
}

/** The last pointer the map saw was a finger: a mouse event now is a tap's
 *  echo, a readout at most, never a hover's emphasis. */
export function fingerLast(): boolean {
	return lastType === 'touch';
}

/** The map's contextmenu, before its menu opens: true when it is a finger's
 *  long press on a draggable marker, which then lifts, the menu waiting for
 *  the release and opening through `open` only if the press never became a
 *  drag; true too for a long press on something it can carry, which primes,
 *  the menu opening at the release only if the press never carried it (and
 *  true, opening nothing, when the press is already carrying something).
 *  False for everything else, whose menu opens at once. */
export function deferMenuToRelease(e: MouseEvent, open: () => void): boolean {
	// No press held: a right click, the menu key, a long tap raised at the
	// release (Chromium on Windows).
	if (held === null) {
		return false;
	}
	// The event names its own input where it can (a PointerEvent in
	// Chromium), so a press record gone stale cannot capture a mouse's right
	// click. Leaflet's TapHold (iOS) simulates a plain MouseEvent.
	const type = (e as { pointerType?: unknown }).pointerType;
	if (typeof type === 'string' && type !== 'touch' && type !== 'pen') {
		return false;
	}
	if (dragging()) {
		return true;
	}
	const icon = draggableAt(e.target);
	if (icon) {
		drop();
		icon.setAttribute(HELD, '');
		pending = { kind: 'lift', icon, open };
		tick();
		return true;
	}
	const carry = held.free ? null : held.carry;
	if (!carry) {
		return false;
	}
	drop();
	if (!carry.prime(e.clientX, e.clientY)) {
		return false;
	}
	pending = { kind: 'carry', carry, carrying: false, open };
	tick();
	return true;
}

/** The hold's haptic tick, where the platform vibrates. */
function tick(): void {
	if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
		navigator.vibrate(HOLD_TICK_MS);
	}
}
