/* A held arrow key pans the map continuously (map/keyPan.ts).
 *
 * The map is an event bus with a pane and a size, Leaflet's DomUtil the two
 * position calls the module makes, and the browser a container, a window
 * and a document that dispatch what the spec tells them to, with animation
 * frames run by hand on a clock the spec advances. What it pins:
 *   - the speed ramp and the direction arithmetic;
 *   - a hold is one view: stopped until the first frame, one movestart, a
 *     move per frame in whole pixels the right way, one moveend at the
 *     release, and a settle per half viewport covered on a long glide;
 *   - the keys the module takes, and the ones it leaves alone (a Ctrl arrow
 *     at rest, a key on a child of the container, a key repeat);
 *   - every way a hold ends (the release, the container or the window
 *     losing focus, the page going hidden), each settling the view;
 *   - yielding to another movement without a moveend of its own, then
 *     resuming, and a pointer settling it until it comes up;
 *   - a stalled frame moving the map no further than a 50 ms one;
 *   - the disarm firing nothing and leaving nothing listening. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';

vi.mock('leaflet', () => {
	class Pt {
		constructor(
			public x: number,
			public y: number,
		) {}
		subtract(p: [number, number]): Pt {
			return new Pt(this.x - p[0], this.y - p[1]);
		}
	}
	return {
		default: {
			DomUtil: {
				getPosition: (el: { pos?: Pt }) => el.pos ?? new Pt(0, 0),
				setPosition: (el: { pos?: Pt }, p: Pt) => {
					el.pos = p;
				},
			},
		},
	};
});

const { armKeyPan, keyPanDirection, keyPanSpeed, KEYPAN_END, KEYPAN_START } = await import('$lib/map/keyPan');

type Listener = (e: Record<string, unknown>) => void;

/** An event target that dispatches to its listeners, capture or not. */
class Target {
	private readonly listeners = new Map<string, Set<Listener>>();

	addEventListener(type: string, fn: Listener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(fn);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, fn: Listener): void {
		this.listeners.get(type)?.delete(fn);
	}

	count(): number {
		let n = 0;
		for (const set of this.listeners.values()) {
			n += set.size;
		}
		return n;
	}

	dispatch(type: string, init: Record<string, unknown> = {}): { prevented: boolean; stopped: boolean } {
		const out = { prevented: false, stopped: false };
		const e = {
			type,
			target: this,
			key: '',
			shiftKey: false,
			ctrlKey: false,
			altKey: false,
			metaKey: false,
			...init,
			preventDefault: () => {
				out.prevented = true;
			},
			stopPropagation: () => {
				out.stopped = true;
			},
		};
		for (const fn of [...(this.listeners.get(type) ?? [])]) {
			fn(e);
		}
		return out;
	}
}

const container = new Target();
const win = Object.assign(new Target(), {
	reduced: false,
	matchMedia: (q: string) => ({ matches: q.includes('reduce') && win.reduced }),
});
const doc = Object.assign(new Target(), { hidden: false });

// The frame clock: frames queue, and advance() runs them one frame at a time.
let now = 0;
let nextId = 1;
const frames = new Map<number, (t: number) => void>();

/** Advance the clock by `ms` in frames of `frameMs`, running what is queued
 *  at each; the last frame may be shorter. */
function advance(ms: number, frameMs = 1000 / 60): void {
	const until = now + ms;
	while (now < until - 1e-9) {
		now = Math.min(until, now + frameMs);
		const due = [...frames];
		frames.clear();
		for (const [, cb] of due) {
			cb(now);
		}
	}
}

interface Fired {
	type: string;
	ours: boolean;
	x: number;
	y: number;
}

/** A map: an event bus recording what fires, a pane, a size. */
function fakeMap(size = { x: 4000, y: 3000 }) {
	const handlers = new Map<string, Set<(e: L.LeafletEvent) => void>>();
	const fired: Fired[] = [];
	const pane: { pos?: { x: number; y: number } } = {};
	const map = {
		getContainer: () => container,
		getPane: (name: string) => (name === 'mapPane' ? pane : undefined),
		getSize: () => size,
		on(types: string, fn: (e: L.LeafletEvent) => void) {
			for (const t of types.split(' ')) {
				const set = handlers.get(t) ?? new Set();
				set.add(fn);
				handlers.set(t, set);
			}
			return map;
		},
		off(types: string, fn: (e: L.LeafletEvent) => void) {
			for (const t of types.split(' ')) {
				handlers.get(t)?.delete(fn);
			}
			return map;
		},
		fire(type: string, data: Record<string, unknown> = {}) {
			fired.push({ type, ours: data.keyPan === true, x: pane.pos?.x ?? 0, y: pane.pos?.y ?? 0 });
			for (const fn of [...(handlers.get(type) ?? [])]) {
				fn({ ...data, type } as unknown as L.LeafletEvent);
			}
			return map;
		},
		listening: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
	};
	return {
		map: map as unknown as L.Map & { listening: () => number },
		pane,
		fired,
		/** The types this module fired, in order, the moves left out. */
		ours: () => fired.filter((f) => f.ours && f.type !== 'move').map((f) => f.type),
		moves: () => fired.filter((f) => f.ours && f.type === 'move'),
		/** Another source's event. */
		external: (type: string) => map.fire(type),
		at: () => ({ x: pane.pos?.x ?? 0, y: pane.pos?.y ?? 0 }),
	};
}

const down = (key: string, init: Record<string, unknown> = {}) => container.dispatch('keydown', { key, ...init });
const up = (key: string, init: Record<string, unknown> = {}) => container.dispatch('keyup', { key, ...init });

let disarm: () => void = () => undefined;

beforeEach(() => {
	now = 0;
	frames.clear();
	win.reduced = false;
	doc.hidden = false;
	vi.stubGlobal('window', win);
	vi.stubGlobal('document', doc);
	vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
		const id = nextId++;
		frames.set(id, cb);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => {
		frames.delete(id);
	});
});

afterEach(() => {
	disarm();
	vi.unstubAllGlobals();
});

/** Arm on a fresh map. */
function arm(size?: { x: number; y: number }): ReturnType<typeof fakeMap> {
	const m = fakeMap(size);
	disarm = armKeyPan(m.map);
	return m;
}

describe('keyPanSpeed', () => {
	it('ramps from 400 to 1000 px/s over 350 ms, Shift tripling it, reduced motion holding the start', () => {
		expect(keyPanSpeed(0, false, false)).toBe(400);
		expect(keyPanSpeed(175, false, false)).toBe(700);
		expect(keyPanSpeed(350, false, false)).toBe(1000);
		expect(keyPanSpeed(5000, false, false)).toBe(1000);
		expect(keyPanSpeed(-20, false, false)).toBe(400);
		expect(keyPanSpeed(350, true, false)).toBe(3000);
		expect(keyPanSpeed(5000, false, true)).toBe(400);
		expect(keyPanSpeed(5000, true, true)).toBe(1200);
	});
});

describe('keyPanDirection', () => {
	it('adds the held arrows, cancels opposites and normalises a diagonal', () => {
		const dir = (...keys: ('left' | 'right' | 'up' | 'down')[]) => keyPanDirection(new Set(keys));
		expect(dir()).toEqual({ x: 0, y: 0 });
		expect(dir('left')).toEqual({ x: -1, y: 0 });
		expect(dir('down')).toEqual({ x: 0, y: 1 });
		expect(dir('left', 'right')).toEqual({ x: 0, y: 0 });
		expect(dir('up', 'down', 'left')).toEqual({ x: -1, y: 0 });
		const d = dir('up', 'right');
		expect(d.x).toBeCloseTo(Math.SQRT1_2, 12);
		expect(d.y).toBeCloseTo(-Math.SQRT1_2, 12);
		expect(Math.hypot(d.x, d.y)).toBeCloseTo(1, 12);
	});
});

describe('a hold', () => {
	it('glides as one view: one movestart, whole-pixel moves the right way, one moveend at the release', () => {
		const m = arm();
		const k = down('ArrowRight');
		expect(k).toEqual({ prevented: true, stopped: true });
		// Nothing moves before the first frame.
		expect(m.fired).toEqual([]);
		advance(2000);
		expect(m.ours()).toEqual(['movestart', KEYPAN_START]);
		const moves = m.moves();
		// A move per frame but the first, which opens the view.
		expect(moves.length).toBeGreaterThan(110);
		for (const mv of moves) {
			expect(Number.isInteger(mv.x) && Number.isInteger(mv.y)).toBe(true);
			expect(mv.y).toBe(0);
		}
		// Right moves the VIEW east: the pane goes west, never back.
		for (let i = 1; i < moves.length; i++) {
			expect(moves[i].x).toBeLessThanOrEqual(moves[i - 1].x);
		}
		// 245 px up the ramp and 1000 px/s after it, less the opening frame.
		expect(-m.at().x).toBeGreaterThan(1850);
		expect(-m.at().x).toBeLessThan(1900);
		up('ArrowRight');
		expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'moveend', KEYPAN_END]);
		const settled = m.at();
		advance(500);
		expect(m.at()).toEqual(settled);
	});

	it('settles each half viewport it covers, and announces the gesture once', () => {
		const m = arm({ x: 800, y: 600 });
		down('ArrowLeft');
		advance(1500);
		up('ArrowLeft');
		const types = m.ours();
		expect(types.filter((t) => t === KEYPAN_START)).toHaveLength(1);
		expect(types.filter((t) => t === KEYPAN_END)).toHaveLength(1);
		const ends = m.fired.filter((f) => f.ours && f.type === 'moveend');
		// 1245 px over 1.5 s is three settles of 400 px, then the release.
		expect(ends).toHaveLength(4);
		for (let i = 0; i < 3; i++) {
			expect(ends[i].x).toBeGreaterThanOrEqual(400 * (i + 1));
			expect(ends[i].x).toBeLessThan(400 * (i + 1) + 20);
		}
		// Every settle but the last reopens the view at once.
		expect(types.filter((t) => t === 'movestart')).toHaveLength(4);
	});

	it('moves diagonally as fast as straight, and follows a key released or Shift pressed', () => {
		const straight = arm();
		down('ArrowRight');
		advance(1000);
		up('ArrowRight');
		disarm();
		const m = arm();
		down('ArrowUp');
		down('ArrowRight');
		advance(1000);
		const a = m.at();
		expect(a.x).toBeLessThan(0);
		expect(a.y).toBeGreaterThan(0);
		// The same distance as the straight run, less the carried fractions.
		expect(Math.abs(Math.hypot(a.x, a.y) - Math.abs(straight.at().x))).toBeLessThanOrEqual(2);
		up('ArrowUp');
		const b = m.at();
		advance(100);
		expect(m.at().y).toBe(b.y);
		expect(b.x - m.at().x).toBeGreaterThan(95);
		expect(b.x - m.at().x).toBeLessThan(105);
		const c = m.at();
		down('Shift', { shiftKey: true });
		advance(100);
		expect(c.x - m.at().x).toBeGreaterThan(295);
		expect(c.x - m.at().x).toBeLessThan(305);
	});

	it('holds the start speed under reduced motion', () => {
		win.reduced = true;
		const m = arm();
		down('ArrowDown');
		advance(1000);
		// 400 px/s from the second frame.
		expect(-m.at().y).toBeGreaterThan(385);
		expect(-m.at().y).toBeLessThan(400);
	});
});

describe('the keys it takes', () => {
	it('swallows a repeat and adds nothing for it', () => {
		const m = arm();
		down('ArrowRight');
		advance(500);
		expect(down('ArrowRight', { repeat: true })).toEqual({ prevented: true, stopped: true });
		expect(m.ours()).toEqual(['movestart', KEYPAN_START]);
	});

	it('leaves a Ctrl, Alt or Meta arrow alone at rest, and swallows one mid-hold without joining it', () => {
		const m = arm();
		for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
			expect(down('ArrowLeft', { [mod]: true })).toEqual({ prevented: false, stopped: false });
		}
		advance(200);
		expect(m.fired).toEqual([]);
		down('ArrowRight');
		advance(200);
		expect(down('ArrowUp', { ctrlKey: true })).toEqual({ prevented: true, stopped: true });
		const a = m.at();
		advance(200);
		expect(m.at().y).toBe(a.y);
	});

	it('leaves a key on a child of the container, and every other key, alone', () => {
		const m = arm();
		const child = new Target();
		expect(down('ArrowRight', { target: child })).toEqual({ prevented: false, stopped: false });
		expect(down('+')).toEqual({ prevented: false, stopped: false });
		expect(down('Escape')).toEqual({ prevented: false, stopped: false });
		advance(200);
		expect(m.fired).toEqual([]);
	});
});

describe('the end of a hold', () => {
	const ways: [string, () => void][] = [
		['the container losing focus', () => container.dispatch('blur')],
		['the window losing focus', () => win.dispatch('blur')],
		[
			'the page going hidden',
			() => {
				doc.hidden = true;
				doc.dispatch('visibilitychange');
			},
		],
	];
	for (const [what, act] of ways) {
		it(`settles on ${what}, with no keyup to come`, () => {
			const m = arm();
			down('ArrowRight');
			advance(300);
			act();
			expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'moveend', KEYPAN_END]);
			doc.hidden = false;
			const at = m.at();
			advance(300);
			expect(m.at()).toEqual(at);
			// The key it never saw come up is not held any more.
			down('ArrowDown');
			advance(300);
			expect(m.at().x).toBe(at.x);
		});
	}
});

describe('other movements', () => {
	it('yields to a zoom without a moveend of its own, then resumes and ramps again', () => {
		const m = arm();
		down('ArrowRight');
		advance(1000);
		m.external('zoomstart');
		m.external('movestart');
		const held = m.at();
		advance(300);
		expect(m.at()).toEqual(held);
		expect(m.ours()).toEqual(['movestart', KEYPAN_START]);
		m.external('zoomend');
		m.external('moveend');
		advance(1000 / 60);
		expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'movestart']);
		// Back from the start speed: 400 px/s, not 1000.
		advance(100);
		expect(held.x - m.at().x).toBeLessThan(60);
		up('ArrowRight');
		expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'movestart', 'moveend', KEYPAN_END]);
	});

	it('settles on a pointer going down, and resumes when it comes up', () => {
		const m = arm();
		down('ArrowLeft');
		advance(500);
		container.dispatch('pointerdown');
		expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'moveend']);
		const held = m.at();
		advance(300);
		expect(m.at()).toEqual(held);
		win.dispatch('pointerup');
		advance(300);
		expect(m.at().x).toBeGreaterThan(held.x);
		expect(m.ours()).toEqual(['movestart', KEYPAN_START, 'moveend', 'movestart']);
	});

	it('does not take its own events for another movement', () => {
		const m = arm({ x: 800, y: 600 });
		down('ArrowRight');
		advance(3000);
		// Its settles reopened the view each time rather than pausing it.
		expect(-m.at().x).toBeGreaterThan(2800);
	});
});

describe('a stalled frame', () => {
	it('moves the map no further than a 50 ms one', () => {
		const m = arm();
		down('ArrowRight');
		advance(1000);
		const at = m.at();
		advance(500, 500);
		expect(at.x - m.at().x).toBeLessThanOrEqual(51);
		expect(at.x - m.at().x).toBeGreaterThanOrEqual(49);
	});
});

describe('disarm', () => {
	it('fires nothing, stops the frames and leaves nothing listening', () => {
		const m = arm();
		down('ArrowRight');
		advance(500);
		const count = m.fired.length;
		const at = m.at();
		disarm();
		disarm = () => undefined;
		advance(500);
		expect(m.fired).toHaveLength(count);
		expect(m.at()).toEqual(at);
		expect(frames.size).toBe(0);
		expect(container.count() + win.count() + doc.count()).toBe(0);
		expect(m.map.listening()).toBe(0);
	});
});
