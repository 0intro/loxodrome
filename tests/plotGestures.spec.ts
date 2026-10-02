/* The profile charts' shared pointer state machine (src/lib/ui/plotGestures.ts):
 * the two modes that let a chart whose primary button is already spoken for pan
 * at all. The trace profile's plot gives its left button to the replay scrub
 * (docs/route-profile.md), so its window rides the middle button and a second
 * finger; both are one branch each in `down` / `move`, and both are exactly the
 * kind of pointer bookkeeping that breaks silently.
 *
 * No DOM: the machine reads five fields off the event and captures through the
 * `captureEl` hook, so plain literals drive it (the suite runs on node). The
 * gestures themselves are browser-verified. */

import { describe, it, expect } from 'vitest';
import { createPlotGestures, wheelPixels, type PlotGestureOptions } from '$lib/ui/plotGestures';

/** The event shape the machine actually reads. */
function ev(o: {
	id?: number;
	type?: string;
	button?: number;
	buttons?: number;
	x?: number;
	y?: number;
}): PointerEvent {
	return {
		pointerId: o.id ?? 1,
		pointerType: o.type ?? 'mouse',
		button: o.button ?? 0,
		buttons: o.buttons ?? 1,
		clientX: o.x ?? 0,
		clientY: o.y ?? 0,
	} as PointerEvent;
}

interface Log {
	pans: [number, number][];
	pinches: [number, number, number, number][];
	engages: number;
	settles: number;
}

function machine(opts: PlotGestureOptions) {
	const log: Log = { pans: [], pinches: [], engages: 0, settles: 0 };
	const g = createPlotGestures(
		{
			captureEl: () => null, // no DOM: capture is a no-op, the gesture still runs
			onPan: (dx, dy) => log.pans.push([dx, dy]),
			onPinch: (mx, my, fx, fy) => log.pinches.push([mx, my, fx, fy]),
			onEngage: () => log.engages++,
			onSettle: () => log.settles++,
		},
		opts,
	);
	return { g, log };
}

describe('middlePan', () => {
	it('engages on the press, with no slop to cross', () => {
		const { g, log } = machine({ middlePan: () => true });
		expect(g.down(ev({ button: 1, buttons: 4, x: 100, y: 50 }))).toBe(true);
		expect(g.engaged()).toBe(true);
		expect(log.engages).toBe(1);
		// One pixel pans: the grab is already locked to the press point.
		g.move(ev({ button: -1, buttons: 4, x: 101, y: 50 }));
		expect(log.pans).toEqual([[1, 0]]);
	});

	it('is refused when the option is off', () => {
		const { g, log } = machine({});
		expect(g.down(ev({ button: 1, buttons: 4 }))).toBe(false);
		expect(g.active()).toBe(false);
		expect(log.engages).toBe(0);
	});

	it('settles on release', () => {
		const { g, log } = machine({ middlePan: () => true });
		g.down(ev({ button: 1, buttons: 4 }));
		g.up(ev({ button: 1, buttons: 0 }));
		expect(g.engaged()).toBe(false);
		expect(g.active()).toBe(false);
		expect(log.settles).toBe(1);
	});

	it('leaves the primary button to its owner', () => {
		// The trace chart still calls down() for its middle button only, but the
		// machine must not claim a left press it was handed by mistake either:
		// with a middle pan live, a second (same-id) press cannot re-register.
		const { g } = machine({ middlePan: () => true });
		g.down(ev({ button: 1, buttons: 4 }));
		expect(g.down(ev({ button: 0, buttons: 5 }))).toBe(false);
	});
});

describe('touchPan off', () => {
	const opts: PlotGestureOptions = { pinch: true, touchPan: () => false };

	it('tracks one finger without panning it', () => {
		const { g, log } = machine(opts);
		expect(g.down(ev({ id: 7, type: 'touch', x: 10, y: 10 }))).toBe(true);
		expect(g.active()).toBe(true); // tracked
		// Well past the 4 px slop: still no pan, the caller owns this finger.
		expect(g.move(ev({ id: 7, type: 'touch', x: 60, y: 10 }))).toBe(true);
		expect(g.engaged()).toBe(false);
		expect(log.pans).toEqual([]);
		expect(log.engages).toBe(0);
	});

	it('promotes to a pinch from where the tracked finger now is', () => {
		const { g, log } = machine(opts);
		g.down(ev({ id: 7, type: 'touch', x: 10, y: 10 }));
		g.move(ev({ id: 7, type: 'touch', x: 100, y: 10 })); // tracked move
		g.down(ev({ id: 8, type: 'touch', x: 200, y: 10 }));
		expect(g.engaged()).toBe(true);
		expect(log.engages).toBe(1);
		// Spreading finger 8 by 100 px zooms x IN about the moving midpoint. The
		// span starts at 100 px, finger 7's TRACKED position: had it stayed at
		// the press x of 10, the factor would read 190/290 instead.
		g.move(ev({ id: 8, type: 'touch', x: 300, y: 10 }));
		expect(log.pinches).toHaveLength(1);
		const [, , fx, fy] = log.pinches[0];
		expect(fx).toBeCloseTo(100 / 200, 9);
		expect(fy).toBe(1); // no vertical span, no vertical zoom
		expect(log.pans).toEqual([[50, 0]]); // the midpoint travelled half of it
	});

	it('keeps panning from the survivor when a finger lifts', () => {
		const { g, log } = machine(opts);
		g.down(ev({ id: 7, type: 'touch', x: 10, y: 10 }));
		g.down(ev({ id: 8, type: 'touch', x: 50, y: 10 }));
		g.up(ev({ id: 8, type: 'touch', buttons: 0 }));
		expect(g.engaged()).toBe(true); // the pinch continues as a pan
		g.move(ev({ id: 7, type: 'touch', x: 20, y: 15 }));
		expect(log.pans).toEqual([[10, 5]]);
	});

	it('still pans a lone MOUSE press past the slop', () => {
		// The flag is about the finger the scrub owns, not about panning.
		const { g, log } = machine(opts);
		g.down(ev({ x: 10, y: 10 }));
		g.move(ev({ x: 12, y: 10 })); // inside the slop
		expect(log.pans).toEqual([]);
		g.move(ev({ x: 20, y: 10 })); // past it: the slop replays from the press
		expect(g.engaged()).toBe(true);
		expect(log.pans).toEqual([[10, 0]]);
	});
});

describe('wheelPixels', () => {
	it('normalises the three deltaMode units to the same travel', () => {
		expect(wheelPixels(100, 0)).toBe(100);
		expect(wheelPixels(100 / 16, 1)).toBeCloseTo(100, 9);
		expect(wheelPixels(1, 2)).toBe(100);
	});

	it('clamps a fling, keeping its direction', () => {
		expect(wheelPixels(5000, 0)).toBe(300);
		expect(wheelPixels(-5000, 0)).toBe(-300);
		expect(wheelPixels(40, 2)).toBe(300); // 4000 px of pages
	});
});

describe('touchPan on (the default)', () => {
	it('pans a lone finger past the slop', () => {
		const { g, log } = machine({ pinch: true });
		g.down(ev({ id: 7, type: 'touch', x: 10, y: 10 }));
		g.move(ev({ id: 7, type: 'touch', x: 30, y: 10 }));
		expect(g.engaged()).toBe(true);
		expect(log.pans).toEqual([[20, 0]]);
	});
});
