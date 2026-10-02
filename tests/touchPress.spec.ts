/* A finger's long press on a draggable marker (map/touchPress.ts), pinned
 * against the gesture as Chromium delivers it, measured in its own touch
 * pipeline: the long press raises `contextmenu` while the finger is still
 * down, a PointerEvent whose pointerType names the finger; the touch goes on
 * after it (no cancel), so the move that follows drags the pin; the release
 * sends pointerup before touchend, and Leaflet's own drag state, the
 * `leaflet-dragging` class on <body>, stands until Leaflet's bubbling
 * touchend clears it.
 *
 * The rules: the pin lifts and the menu waits for the release, opening then
 * unless the press became a drag; a cancel is a release (a cancelled touch
 * drags nothing); drift inside the detent is kept from Leaflet; a right
 * click, the menu key and a long press off a marker open at once. A long
 * press on something the map can carry (a leg of the route) primes it the
 * same way, and past the detent the press carries it: its moves are the
 * carry's, and the release puts it down with no menu.
 *
 * A window, a document and the map container stand in as bare EventTargets,
 * each event dispatched where the module listens; the module is loaded fresh
 * per test, its state being module-level. */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mapView = readFileSync('src/lib/components/MapView.svelte', 'utf8');

interface PinStandIn {
	readonly attrs: Map<string, string>;
	setAttribute: (name: string, value: string) => void;
	removeAttribute: (name: string) => void;
}

function pinStandIn(): PinStandIn {
	const attrs = new Map<string, string>();
	return {
		attrs,
		setAttribute: (name, value) => {
			attrs.set(name, value);
		},
		removeAttribute: (name) => {
			attrs.delete(name);
		},
	};
}

/** What the contextmenu landed on: the pin's inner element (closest() finds
 *  the marker's icon), or the map (no draggable ancestor). */
function onPin(pin: PinStandIn): EventTarget {
	return { closest: (sel: string) => (sel === '.leaflet-marker-draggable' ? pin : null) } as unknown as EventTarget;
}

const onMap = { closest: () => null } as unknown as EventTarget;

/** The text from the brace at `at` to its match, both included. */
function balancedBraces(src: string, at: number): string {
	let depth = 0;
	for (let i = at; i < src.length; i++) {
		if (src[i] === '{') {
			depth++;
		} else if (src[i] === '}') {
			depth--;
			if (depth === 0) {
				return src.slice(at, i + 1);
			}
		}
	}
	return src.slice(at);
}

/** A carry that records what the press did to it. */
interface CarryLog {
	asked: { x: number; y: number }[];
	primes: number;
	moves: [number, number][];
	commits: number;
	cancels: number;
}

/** What the press could carry: always a recording carry, one that refuses
 *  to prime, or nothing. */
type CarryOffer = 'carry' | 'refuse' | 'none';

async function stub(offer?: CarryOffer) {
	const win = new EventTarget();
	const bodyClasses = new Set<string>();
	const doc = Object.assign(new EventTarget(), {
		visibilityState: 'visible',
		body: { classList: { contains: (c: string) => bodyClasses.has(c) } },
	});
	const container = new EventTarget();
	const vibrate = vi.fn(() => true);
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', doc);
	vi.stubGlobal('navigator', { vibrate });
	vi.resetModules();
	const mod = await import('$lib/map/touchPress');
	const log: CarryLog = { asked: [], primes: 0, moves: [], commits: 0, cancels: 0 };
	const carryAt =
		offer === undefined
			? undefined
			: (x: number, y: number) => {
					log.asked.push({ x, y });
					if (offer === 'none') {
						return null;
					}
					return {
						prime: () => {
							log.primes++;
							return offer === 'carry';
						},
						move: (mx: number, my: number) => {
							log.moves.push([mx, my]);
						},
						commit: () => {
							log.commits++;
						},
						cancel: () => {
							log.cancels++;
						},
					};
				};
	const disarm = mod.armTouchPress(container as unknown as HTMLElement, { carryAt });
	const pointer = (
		at: EventTarget,
		type: string,
		init: {
			pointerType?: string;
			pointerId?: number;
			isPrimary?: boolean;
			x?: number;
			y?: number;
			target?: EventTarget;
		} = {},
	): Event => {
		const e = Object.assign(new Event(type, { cancelable: true }), {
			pointerType: init.pointerType ?? 'touch',
			pointerId: init.pointerId ?? 1,
			isPrimary: init.isPrimary ?? true,
			clientX: init.x ?? 100,
			clientY: init.y ?? 100,
		});
		if (init.target) {
			// What the press landed on (a pin's inner element), in place of the
			// container the stand-in dispatches on.
			Object.defineProperty(e, 'target', { value: init.target });
		}
		at.dispatchEvent(e);
		return e;
	};
	const touches = (at: EventTarget, type: string, list: { x: number; y: number }[]): Event => {
		const e = Object.assign(new Event(type, { cancelable: true }), {
			touches: list.map((t) => ({ clientX: t.x, clientY: t.y })),
		});
		at.dispatchEvent(e);
		return e;
	};
	let opened = 0;
	return {
		mod,
		disarm,
		log,
		win,
		doc,
		container,
		vibrate,
		opened: () => opened,
		dragging: (on: boolean) => {
			if (on) {
				bodyClasses.add('leaflet-dragging');
			} else {
				bodyClasses.delete('leaflet-dragging');
			}
		},
		/** A press going down on the map. */
		down: (init: Parameters<typeof pointer>[2] = {}) => pointer(container, 'pointerdown', init),
		/** A release or a cancel, which the module hears on the window. */
		up: (type = 'pointerup', pointerId = 1) => pointer(win, type, { pointerId }),
		move: (x: number, y: number) => touches(container, 'touchmove', [{ x, y }]),
		/** Two fingers moving: a pinch. */
		pinch: () =>
			touches(container, 'touchmove', [
				{ x: 101, y: 101 },
				{ x: 200, y: 200 },
			]),
		/** A pointer moving over the map (a mouse, a hovering pen, a finger). */
		hover: (pointerType: string) => pointer(container, 'pointermove', { pointerType }),
		touchEnd: (type = 'touchend') => touches(win, type, []),
		/** The map's contextmenu reaching the handler: did the module take it? */
		menu: (target: EventTarget, pointerType?: string) =>
			mod.deferMenuToRelease(
				(pointerType === undefined
					? { target, clientX: 100, clientY: 100 }
					: { target, pointerType, clientX: 100, clientY: 100 }) as unknown as MouseEvent,
				() => opened++,
			),
	};
}

describe('a long press on a draggable marker', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('lifts the pin, ticks, and opens the menu at the release', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		expect(s.menu(onPin(pin), 'touch')).toBe(true);
		expect(pin.attrs.has('data-held')).toBe(true);
		expect(s.vibrate).toHaveBeenCalledOnce();
		expect(s.opened()).toBe(0);
		s.up();
		expect(s.opened()).toBe(1);
		expect(pin.attrs.has('data-held')).toBe(false);
	});

	it('opens nothing when the press became a drag', async () => {
		// The bug: the sheet opened at the hold, the pin was dragged blind
		// beneath it, and the sheet outlived the drop.
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		s.menu(onPin(pin), 'touch');
		s.dragging(true);
		s.up();
		expect(s.opened()).toBe(0);
		expect(pin.attrs.has('data-held')).toBe(false);
	});

	it('opens nothing, and lifts nothing, when the press is already carrying something', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		s.dragging(true);
		expect(s.menu(onPin(pin), 'touch')).toBe(true);
		expect(pin.attrs.has('data-held')).toBe(false);
		expect(s.vibrate).not.toHaveBeenCalled();
		s.dragging(false);
		s.up();
		expect(s.opened()).toBe(0);
	});

	it('takes a cancel for a release: a cancelled touch drags nothing', async () => {
		const s = await stub();
		s.down();
		s.menu(onPin(pinStandIn()), 'touch');
		s.up('pointercancel');
		expect(s.opened()).toBe(1);
	});

	it('decides on whichever end arrives first, once', async () => {
		const s = await stub();
		s.down();
		s.menu(onPin(pinStandIn()), 'touch');
		s.touchEnd();
		expect(s.opened()).toBe(1);
		s.up();
		expect(s.opened()).toBe(1);
	});

	it('takes no touchend for the release while a finger is still down', async () => {
		const s = await stub();
		s.down();
		s.menu(onPin(pinStandIn()), 'touch');
		s.win.dispatchEvent(Object.assign(new Event('touchend'), { touches: [{ clientX: 100, clientY: 100 }] }));
		expect(s.opened()).toBe(0);
		s.touchEnd();
		expect(s.opened()).toBe(1);
	});

	it('holds the primary finger only: a second one never becomes the press', async () => {
		const s = await stub();
		s.down({ pointerId: 1 });
		s.down({ pointerId: 2, isPrimary: false });
		s.up('pointerup', 1);
		// The first finger is up: whatever the second does, no press is held.
		expect(s.menu(onPin(pinStandIn()), 'touch')).toBe(false);
	});

	it('waits for its own finger, not another pointer', async () => {
		const s = await stub();
		s.down();
		s.menu(onPin(pinStandIn()), 'touch');
		s.up('pointerup', 7);
		expect(s.opened()).toBe(0);
		s.up('pointerup', 1);
		expect(s.opened()).toBe(1);
	});

	it('is dropped by a second finger: a pinch, not a release', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		s.menu(onPin(pin), 'touch');
		s.down({ pointerId: 2, isPrimary: false });
		expect(pin.attrs.has('data-held')).toBe(false);
		s.up('pointerup', 1);
		expect(s.opened()).toBe(0);
	});

	it('keeps drift inside the detent from Leaflet, and lets a real move through', async () => {
		// Chromium withholds touchmove inside its slop; a finger held in
		// turbulence drifts past it, and a drag would move the waypoint the
		// pilot was asking about.
		const s = await stub();
		const pin = pinStandIn();
		s.down({ x: 100, y: 100, target: onPin(pin) });
		s.menu(onPin(pin), 'touch');
		expect(s.move(110, 110).cancelBubble, '14 px of drift, past the slop').toBe(true);
		expect(s.move(130, 100).cancelBubble, '30 px, a carry').toBe(false);
	});

	it('lets go for good once the detent is passed: a drag may come back near its start', async () => {
		const s = await stub();
		s.down({ x: 100, y: 100 });
		s.menu(onPin(pinStandIn()), 'touch');
		expect(s.move(130, 100).cancelBubble, 'past the detent').toBe(false);
		expect(s.move(110, 100).cancelBubble, 'back near the start, still the drag').toBe(false);
	});

	it('takes the simulated MouseEvent of Leaflet\'s TapHold as a finger\'s', async () => {
		const s = await stub();
		s.down();
		expect(s.menu(onPin(pinStandIn()))).toBe(true);
	});

	it('is dropped when the window loses the focus', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		s.menu(onPin(pin), 'touch');
		s.win.dispatchEvent(new Event('blur'));
		expect(pin.attrs.has('data-held')).toBe(false);
		s.up();
		expect(s.opened()).toBe(0);
	});
});

describe('a finger on a draggable marker, before any long press', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('keeps its first 10 px from Leaflet, the slop Gecko does not give', async () => {
		// Gecko delivers every touchmove (Chromium withholds those inside
		// its own slop), and Leaflet starts a drag at 3 px: a jittery tap
		// moved the waypoint, and a long press drifting 3 px became a drag.
		const s = await stub();
		s.down({ x: 100, y: 100, target: onPin(pinStandIn()) });
		expect(s.move(105, 105).cancelBubble, '7 px').toBe(true);
		expect(s.move(115, 100).cancelBubble, '15 px, a drag').toBe(false);
		expect(s.move(104, 100).cancelBubble, 'the drag goes on near its start').toBe(false);
	});

	it('holds nothing back for a press on the map itself', async () => {
		const s = await stub();
		s.down({ x: 100, y: 100 });
		expect(s.move(103, 103).cancelBubble).toBe(false);
	});

	it('hands a pinch to Leaflet whole', async () => {
		const s = await stub();
		s.down({ x: 100, y: 100, target: onPin(pinStandIn()) });
		expect(s.pinch().cancelBubble, 'two fingers moving').toBe(false);
		s.down({ pointerId: 2, isPrimary: false, x: 200, y: 200 });
		expect(s.move(103, 103).cancelBubble, 'after a second finger landed').toBe(false);
	});
});

describe('a long press on something the map can carry (a leg of the route)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('is asked for at a finger\'s press, where the press went down', async () => {
		const s = await stub('carry');
		s.down({ x: 120, y: 80 });
		expect(s.log.asked).toEqual([{ x: 120, y: 80 }]);
	});

	it('keeps the press\'s first 10 px from Leaflet, so a jittery hold still primes it', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		expect(s.move(105, 105).cancelBubble, '7 px').toBe(true);
		expect(s.move(115, 100).cancelBubble, '15 px, a pan').toBe(false);
		expect(s.log.moves, 'a pan carries nothing').toEqual([]);
	});

	it('primes at the hold with the tick, and opens the menu at the release, putting it back', async () => {
		const s = await stub('carry');
		s.down();
		expect(s.menu(onMap, 'touch')).toBe(true);
		expect(s.log.primes).toBe(1);
		expect(s.vibrate).toHaveBeenCalledOnce();
		expect(s.opened()).toBe(0);
		s.up();
		expect(s.opened()).toBe(1);
		expect([s.log.cancels, s.log.commits]).toEqual([1, 0]);
	});

	it('carries past the detent: every move stopped and handed over, and the release puts it down, no menu', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		s.menu(onMap, 'touch');
		expect(s.move(110, 110).cancelBubble, 'inside the detent').toBe(true);
		expect(s.log.moves, 'drift carries nothing').toEqual([]);
		expect(s.move(130, 100).cancelBubble, 'past it').toBe(true);
		expect(s.move(104, 100).cancelBubble, 'back near the start, still carried').toBe(true);
		expect(s.log.moves).toEqual([
			[130, 100],
			[104, 100],
		]);
		s.up();
		expect([s.log.commits, s.log.cancels, s.opened()]).toEqual([1, 0, 0]);
	});

	it('puts a carry back on a cancel, and opens nothing: an insert comes from a release', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		s.menu(onMap, 'touch');
		s.move(140, 100);
		s.up('pointercancel');
		expect([s.log.commits, s.log.cancels, s.opened()]).toEqual([0, 1, 0]);
	});

	it('takes a touchcancel for the same', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		s.menu(onMap, 'touch');
		s.move(140, 100);
		s.touchEnd('touchcancel');
		expect([s.log.commits, s.log.cancels]).toEqual([0, 1]);
	});

	it('takes a cancel before any carry for a release: the menu is due', async () => {
		const s = await stub('carry');
		s.down();
		s.menu(onMap, 'touch');
		s.up('pointercancel');
		expect([s.log.cancels, s.opened()]).toEqual([1, 1]);
	});

	it('is dropped by a second finger, whose pinch is Leaflet\'s whole', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		s.menu(onMap, 'touch');
		s.move(140, 100);
		s.down({ pointerId: 2, isPrimary: false, x: 200, y: 200 });
		expect(s.log.cancels).toBe(1);
		expect(s.move(150, 100).cancelBubble).toBe(false);
		expect(s.log.moves).toEqual([[140, 100]]);
		s.up('pointerup', 1);
		expect([s.log.commits, s.opened()]).toEqual([0, 0]);
	});

	it('is dropped when the window loses the focus', async () => {
		const s = await stub('carry');
		s.down();
		s.menu(onMap, 'touch');
		s.win.dispatchEvent(new Event('blur'));
		expect(s.log.cancels).toBe(1);
		s.up();
		expect(s.opened()).toBe(0);
	});

	it('is a finger\'s: a pen asks nothing and its long press opens at once', async () => {
		const s = await stub('carry');
		s.down({ pointerType: 'pen' });
		expect(s.log.asked).toEqual([]);
		expect(s.menu(onMap, 'pen')).toBe(false);
	});

	it('gives way to a marker under the press, which lifts as before', async () => {
		const s = await stub('carry');
		const pin = pinStandIn();
		s.down({ target: onPin(pin) });
		expect(s.log.asked, 'the marker is the press\'s').toEqual([]);
		expect(s.menu(onPin(pin), 'touch')).toBe(true);
		expect(pin.attrs.has('data-held')).toBe(true);
		expect(s.log.primes).toBe(0);
	});

	it('opens the menu at once when it will not prime (the leg went)', async () => {
		const s = await stub('refuse');
		s.down();
		expect(s.menu(onMap, 'touch')).toBe(false);
		expect(s.log.primes).toBe(1);
		expect(s.vibrate).not.toHaveBeenCalled();
	});

	it('with nothing to carry, holds nothing back and opens at once', async () => {
		const s = await stub('none');
		s.down({ x: 100, y: 100 });
		expect(s.move(103, 103).cancelBubble).toBe(false);
		expect(s.menu(onMap, 'touch')).toBe(false);
	});

	it('carries nothing once the press has left the slop before the hold', async () => {
		const s = await stub('carry');
		s.down({ x: 100, y: 100 });
		s.move(120, 100);
		expect(s.menu(onMap, 'touch')).toBe(false);
		expect(s.log.primes).toBe(0);
	});

	it('is forgotten with the disarm', async () => {
		const s = await stub('carry');
		s.disarm();
		s.mod.armTouchPress(s.container as unknown as HTMLElement);
		s.down();
		expect(s.log.asked).toEqual([]);
		expect(s.menu(onMap, 'touch')).toBe(false);
	});
});

describe('every other contextmenu opens the menu at once', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('a mouse right click on a pin', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down({ pointerType: 'mouse' });
		expect(s.menu(onPin(pin), 'mouse')).toBe(false);
		expect(pin.attrs.has('data-held')).toBe(false);
		expect(s.vibrate).not.toHaveBeenCalled();
	});

	it('a right click raised as a plain MouseEvent, after a mouse press', async () => {
		// Engines where contextmenu is no PointerEvent: only the press record
		// can tell, and a mouse's press records none.
		const s = await stub();
		s.down({ pointerType: 'mouse' });
		expect(s.menu(onPin(pinStandIn()))).toBe(false);
	});

	it('the menu key, with no press at all', async () => {
		const s = await stub();
		expect(s.menu(onPin(pinStandIn()), '')).toBe(false);
	});

	it('a right click while a finger\'s press record stands', async () => {
		// The event names its own input: a stale record cannot capture a mouse.
		const s = await stub();
		s.down();
		expect(s.menu(onPin(pinStandIn()), 'mouse')).toBe(false);
	});

	it('a long press on the map itself', async () => {
		const s = await stub();
		s.down();
		expect(s.menu(onMap, 'touch')).toBe(false);
	});

	it('anything after the disarm', async () => {
		const s = await stub();
		const pin = pinStandIn();
		s.down();
		s.menu(onPin(pin), 'touch');
		s.disarm();
		expect(pin.attrs.has('data-held')).toBe(false);
		s.down();
		expect(s.menu(onPin(pinStandIn()), 'touch')).toBe(false);
	});
});

describe('the mouse events a finger makes', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('answer nothing while the finger or the pen is down', async () => {
		// Chromium's compatibility mousemove at a long press painted the leg
		// under a held pin heavy, where it stayed through the drag.
		const s = await stub();
		expect(s.mod.pressHeld()).toBe(false);
		for (const pointerType of ['touch', 'pen']) {
			s.down({ pointerType });
			expect(s.mod.pressHeld(), pointerType).toBe(true);
			s.up();
			expect(s.mod.pressHeld(), pointerType).toBe(false);
		}
		s.down({ pointerType: 'mouse' });
		expect(s.mod.pressHeld(), 'a mouse press is no finger').toBe(false);
	});

	it('are a tap\'s echo after a finger, until a real pointer moves', async () => {
		// A tap's compatibility mousemove comes after its pointerup: a tap on
		// a leg left it heavy until the next tap elsewhere.
		const s = await stub();
		expect(s.mod.fingerLast()).toBe(false);
		s.down();
		s.up();
		expect(s.mod.fingerLast(), 'after the tap').toBe(true);
		s.hover('mouse');
		expect(s.mod.fingerLast(), 'a mouse moved in').toBe(false);
		s.hover('touch');
		expect(s.mod.fingerLast()).toBe(true);
		s.hover('pen');
		expect(s.mod.fingerLast(), 'a hovering pen is a hover').toBe(false);
	});

	it('are forgotten with the disarm', async () => {
		const s = await stub();
		s.down();
		s.disarm();
		expect(s.mod.pressHeld()).toBe(false);
		expect(s.mod.fingerLast()).toBe(false);
	});
});

describe('MapView', () => {
	it('arms the rules, with the route legs to carry, and takes them down with the view', () => {
		expect(mapView).toContain(
			'const disarmTouchPress = armTouchPress(map.getContainer(), { carryAt: legCarryAt });',
		);
		expect(mapView).toMatch(/return \(\) => \{[^}]*disarmTouchPress\(\);/);
	});

	it('arms the mouse\'s leg drag beside them, and takes it down too', () => {
		expect(mapView).toContain('const disarmLegDrag = armLegDrag(map);');
		expect(mapView).toMatch(/return \(\) => \{[^}]*disarmLegDrag\(\);/);
	});

	it('asks before opening the menu, and opens it through one closure', () => {
		const start = mapView.indexOf('const onMapContextMenu = ');
		const end = mapView.indexOf("map.on('contextmenu', onMapContextMenu);");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const handler = mapView.slice(start, end);
		const closure = handler.indexOf('const open = (): void => {');
		expect(closure, 'the menu opens through the one closure').toBeGreaterThan(0);
		const body = balancedBraces(handler, handler.indexOf('{', closure));
		const outside = handler.slice(0, closure) + handler.slice(closure + 'const open = (): void => '.length + body.length);
		expect(outside, 'nothing opens outside the closure').not.toContain('openContextMenu(');
		expect(handler).toMatch(
			/if \(\s*deferMenuToRelease\(e\.originalEvent, \(\) => \{\s*suppressNextClick\(\);\s*open\(\);\s*\}\)\s*\) \{\s*return;\s*\}\s*open\(\);\s*\};/,
		);
	});

	it('lets a finger\'s echo point at nothing, and a held press answer nothing', () => {
		const start = mapView.indexOf('const onMapMouseMove = ');
		const end = mapView.indexOf('const onMapMouseOut = ', start);
		expect(start).toBeGreaterThan(0);
		const handler = mapView.slice(start, end);
		// The first statement: nothing at all while a finger is down, before
		// the readouts are written.
		expect(handler).toMatch(/^const onMapMouseMove = \(e: L\.LeafletMouseEvent\): void => \{\s*(\/\/[^\n]*\s*)*if \(!map \|\| cursorPending \|\| pressHeld\(\)\) \{\s*return;/);
		expect(handler.indexOf('pressHeld()')).toBeLessThan(handler.indexOf('hoveredCoord = '));
		// The tap's flag is read when the event lands, not in the frame.
		expect(handler.indexOf('const finger = fingerLast();')).toBeLessThan(handler.indexOf('requestAnimationFrame('));
		// The leg is pointed at by a pointer only.
		expect(handler).toMatch(/if \(finger\) \{\s*applyMapLegHover\(null\);\s*return;\s*\}[\s\S]*applyMapLegHover\(legAt\(lat, lng\)\);/);
		expect(handler.match(/applyMapLegHover\(legAt\(/g)?.length).toBe(1);
	});

	it('lifts a held marker with an attribute setIcon cannot wipe', () => {
		expect(mapView).toContain(':global(.leaflet-marker-draggable[data-held])');
		expect(mapView).toContain(':global(.leaflet-marker-draggable[data-held] > svg)');
	});
});
