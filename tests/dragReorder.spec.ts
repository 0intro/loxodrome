/* The reordering drag (ui/dragReorder.ts): a mouse lifts past its slop, a
 * finger after the long press, a finger that moves first is the list's own
 * scroll; the release drops and swallows its click; a cancel, a lost
 * capture or Escape drop nothing; a pressed child's lost capture is not
 * the handle's. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dragHandle, HOLD_SLOP, MOUSE_SLOP } from '$lib/ui/dragReorder';
import { LONG_PRESS_MS } from '$lib/ui/longPress';

type Handler = (e: Record<string, unknown>) => void;

function rig(enabled = true) {
	const on = new Map<string, Handler[]>();
	const node = {
		addEventListener: (t: string, h: Handler) => on.set(t, [...(on.get(t) ?? []), h]),
		removeEventListener: (t: string, h: Handler) => on.set(t, (on.get(t) ?? []).filter((x) => x !== h)),
		setPointerCapture: vi.fn(),
	};
	const fire = (t: string, e: Record<string, unknown> = {}) => {
		const ev = { target: node, pointerId: 1, isPrimary: true, preventDefault: vi.fn(), ...e };
		for (const h of on.get(t) ?? []) {
			h(ev);
		}
		return ev;
	};
	const opts = {
		axis: 'x' as const,
		enabled: () => enabled,
		scroller: () => null,
		onLift: vi.fn(),
		onMove: vi.fn(),
		onDrop: vi.fn(),
		onCancel: vi.fn(),
	};
	const action = dragHandle(node as unknown as HTMLElement, opts);
	return { node, fire, opts, action };
}

const mouse = (clientX: number, extra: Record<string, unknown> = {}) => ({ pointerType: 'mouse', button: 0, clientX, clientY: 10, ...extra });
const finger = (clientX: number, extra: Record<string, unknown> = {}) => ({ pointerType: 'touch', button: 0, clientX, clientY: 10, ...extra });

describe('dragHandle', () => {
	let keys: Handler[];
	let blurs: Handler[];
	let clicks: Handler[];
	let vibrate: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useFakeTimers();
		keys = [];
		blurs = [];
		clicks = [];
		vi.stubGlobal('window', {
			addEventListener: (t: string, h: Handler) => (t === 'blur' ? blurs : keys).push(h),
			removeEventListener: () => {},
		});
		vi.stubGlobal('document', {
			addEventListener: (t: string, h: Handler) => {
				if (t === 'click') {
					clicks.push(h);
				}
			},
			removeEventListener: () => {},
		});
		vibrate = vi.fn();
		vi.stubGlobal('navigator', { vibrate });
		vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
		vi.stubGlobal('cancelAnimationFrame', vi.fn());
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('a mouse lifts past its slop and drops on release, swallowing the click', () => {
		const { fire, opts, node } = rig();
		fire('pointerdown', mouse(100));
		expect(node.setPointerCapture).toHaveBeenCalledWith(1);
		fire('pointermove', mouse(100 + MOUSE_SLOP - 1));
		expect(opts.onLift).not.toHaveBeenCalled();
		fire('pointermove', mouse(100 + MOUSE_SLOP + 3));
		expect(opts.onLift).toHaveBeenCalledOnce();
		expect(opts.onMove).toHaveBeenLastCalledWith(100 + MOUSE_SLOP + 3, 10);
		fire('pointerup', mouse(140));
		expect(opts.onDrop).toHaveBeenCalledOnce();
		const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
		clicks.forEach((h) => h(click));
		expect(click.preventDefault).toHaveBeenCalled();
	});

	it('a mouse click that never moved lifts nothing and keeps its click', () => {
		const { fire, opts } = rig();
		fire('pointerdown', mouse(100));
		fire('pointerup', mouse(100));
		expect(opts.onLift).not.toHaveBeenCalled();
		expect(opts.onDrop).not.toHaveBeenCalled();
	});

	it('a finger lifts after the long press, with the tick, and drops', () => {
		const { fire, opts } = rig();
		fire('pointerdown', finger(100));
		vi.advanceTimersByTime(LONG_PRESS_MS - 1);
		expect(opts.onLift).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(opts.onLift).toHaveBeenCalledOnce();
		expect(vibrate).toHaveBeenCalled();
		const tm = fire('touchmove');
		expect(tm.preventDefault).toHaveBeenCalled();
		fire('pointermove', finger(160));
		expect(opts.onMove).toHaveBeenLastCalledWith(160, 10);
		fire('pointerup', finger(160));
		expect(opts.onDrop).toHaveBeenCalledOnce();
	});

	it('a finger that moves first is the scroll: no lift, the pan left alone', () => {
		const { fire, opts } = rig();
		fire('pointerdown', finger(100));
		fire('pointermove', finger(100 + HOLD_SLOP + 1));
		vi.advanceTimersByTime(LONG_PRESS_MS * 2);
		expect(opts.onLift).not.toHaveBeenCalled();
		const tm = fire('touchmove');
		expect(tm.preventDefault).not.toHaveBeenCalled();
	});

	it('a cancel, a lost capture or Escape drop nothing', () => {
		for (const end of ['pointercancel', 'lostpointercapture', 'Escape']) {
			const { fire, opts } = rig();
			fire('pointerdown', mouse(100));
			fire('pointermove', mouse(120));
			if (end === 'Escape') {
				keys.at(-1)!({ key: 'Escape', preventDefault: vi.fn() });
			} else {
				fire(end, mouse(120));
			}
			expect(opts.onCancel, end).toHaveBeenCalledOnce();
			fire('pointerup', mouse(120));
			expect(opts.onDrop, end).not.toHaveBeenCalled();
		}
	});

	it("a pressed child's lost capture is not the handle's", () => {
		const { fire, opts } = rig();
		fire('pointerdown', finger(100));
		vi.advanceTimersByTime(LONG_PRESS_MS);
		fire('lostpointercapture', finger(100, { target: {} }));
		expect(opts.onCancel).not.toHaveBeenCalled();
		fire('pointerup', finger(130));
		expect(opts.onDrop).toHaveBeenCalledOnce();
	});

	it('a disabled handle and a second finger lift nothing', () => {
		const off = rig(false);
		off.fire('pointerdown', mouse(100));
		off.fire('pointermove', mouse(140));
		expect(off.opts.onLift).not.toHaveBeenCalled();
		const two = rig();
		two.fire('pointerdown', finger(100, { isPrimary: false, pointerId: 2 }));
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(two.opts.onLift).not.toHaveBeenCalled();
	});

	it('a release never seen: the next press cancels the stale drag and arms afresh', () => {
		const { fire, opts } = rig();
		fire('pointerdown', finger(100));
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(opts.onLift).toHaveBeenCalledOnce();
		// No pointerup: the system dropped it. A new press comes.
		fire('pointerdown', finger(300, { pointerId: 2 }));
		expect(opts.onCancel).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(LONG_PRESS_MS);
		expect(opts.onLift).toHaveBeenCalledTimes(2);
		fire('pointerup', finger(320, { pointerId: 2 }));
		expect(opts.onDrop).toHaveBeenCalledOnce();
	});

	it('the window losing the focus mid-drag cancels it', () => {
		const { fire, opts } = rig();
		fire('pointerdown', mouse(100));
		fire('pointermove', mouse(130));
		blurs.forEach((h) => h({}));
		expect(opts.onCancel).toHaveBeenCalledOnce();
	});

	it('a teardown mid-drag cancels it', () => {
		const { fire, opts, action } = rig();
		fire('pointerdown', mouse(100));
		fire('pointermove', mouse(130));
		action.destroy();
		expect(opts.onCancel).toHaveBeenCalledOnce();
	});
});
