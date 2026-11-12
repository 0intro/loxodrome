/* Pins the swipe-down-to-dismiss threshold every phone sheet shares
 * (ui/sheet.ts swipeDismisses). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DISMISS_PX,
	FLICK,
	REST_MS,
	SWIPE_SLOP,
	startSheetDrag,
	suppressNextClick,
	swipeDismiss,
	swipeDismisses,
} from '$lib/ui/sheet';

describe('swipeDismisses', () => {
	it('ignores a touch inside the slop whatever its speed', () => {
		expect(swipeDismisses(SWIPE_SLOP - 1, 10)).toBe(false);
	});
	it('dismisses past the travel threshold at any speed', () => {
		expect(swipeDismisses(DISMISS_PX, 0)).toBe(true);
		expect(swipeDismisses(DISMISS_PX + 40, -1)).toBe(true);
	});
	it('dismisses a flick that cleared the slop', () => {
		expect(swipeDismisses(SWIPE_SLOP + 1, FLICK)).toBe(true);
	});
	it('springs back a slow, short drag', () => {
		expect(swipeDismisses(DISMISS_PX - 1, FLICK / 2)).toBe(false);
	});
});

/* The click a finished TOUCH gesture synthesises is hit-tested against the
 * layout as it stands when it fires, and a grip gesture's whole job is to
 * change that layout. Measured on the Redmi: one tap on the profile pane's
 * handle grew the pane and the click that followed selected the airspace
 * band that had moved under the same pixel, whose detail then evicted the
 * profile. The gesture swallows that one click. */
describe('suppressNextClick', () => {
	afterEach(() => vi.unstubAllGlobals());

	function stubDocument(): {
		clicks: number;
		press: (isPrimary?: boolean) => void;
		fire: () => { prevented: boolean };
	} {
		let handler: ((e: MouseEvent) => void) | null = null;
		let press: ((e: unknown) => void) | null = null;
		const doc = {
			addEventListener: (t: string, h: (e: MouseEvent) => void, capture?: boolean) => {
				if (t === 'click' && capture === true) {
					handler = h;
				}
				if (t === 'pointerdown' && capture === true) {
					press = h as unknown as (e: unknown) => void;
				}
			},
			removeEventListener: () => {},
		};
		vi.stubGlobal('document', doc);
		return {
			get clicks() {
				return handler ? 1 : 0;
			},
			press: (isPrimary = true) => press?.({ isPrimary }),
			fire: () => {
				let prevented = false;
				handler?.({
					preventDefault: () => {
						prevented = true;
					},
					stopPropagation: () => {},
				} as unknown as MouseEvent);
				return { prevented };
			},
		};
	}

	it('swallows the next click, and only that one', () => {
		const d = stubDocument();
		suppressNextClick();
		expect(d.clicks).toBe(1);
		expect(d.fire().prevented).toBe(true);
		// A second click, the user's own, must get through.
		expect(d.fire().prevented).toBe(false);
	});

	it('lets a click through once the window has passed', () => {
		const d = stubDocument();
		suppressNextClick(-1);
		expect(d.fire().prevented).toBe(false);
	});

	it('stands down as soon as the finger lands again', () => {
		// The stray click is synthesised from the release that armed the
		// window, so it cannot follow a fresh press: a gesture that
		// synthesised none would otherwise leave the window armed and the
		// pilot's next deliberate tap would pay for it.
		const d = stubDocument();
		suppressNextClick();
		d.press();
		expect(d.fire().prevented).toBe(false);
	});

	it('holds through a SECOND finger landing on the same gesture', () => {
		// A non-primary pointer is one arriving while the first is still
		// down: the click owed to that first release has not been dispatched
		// yet, so standing down there would let it through.
		const d = stubDocument();
		suppressNextClick();
		d.press(false);
		expect(d.fire().prevented).toBe(true);
	});

	it('is what the grip gesture calls on a touch release', () => {
		const src = readFileSync(join(process.cwd(), 'src/lib/ui/sheet.ts'), 'utf8');
		const end = src.slice(src.indexOf('function end('), src.indexOf('opts.onRelease(height, velocity);'));
		expect(end).toMatch(/if \(ev\.pointerType !== 'mouse'\) \{\s*suppressNextClick\(\);/);
	});
});


/* A DOM-less stand-in for the element a grip drag runs on: the four methods
 * startSheetDrag actually uses, plus a way to deliver an event to it. */
interface FakeEl {
	captured: number | null;
	setPointerCapture: (id: number) => void;
	releasePointerCapture: (id: number) => void;
	addEventListener: (t: string, h: (e: unknown) => void) => void;
	removeEventListener: (t: string, h: (e: unknown) => void) => void;
	fire: (t: string, e: unknown) => void;
	listenerCount: () => number;
}

function fakeEl(): FakeEl {
	const hs: Record<string, ((e: unknown) => void)[]> = {};
	return {
		captured: null,
		setPointerCapture(id) {
			this.captured = id;
		},
		releasePointerCapture(id) {
			if (this.captured === id) {
				this.captured = null;
			}
		},
		addEventListener(t, h) {
			(hs[t] ??= []).push(h);
		},
		removeEventListener(t, h) {
			hs[t] = (hs[t] ?? []).filter((x) => x !== h);
		},
		fire(t, e) {
			for (const h of [...(hs[t] ?? [])]) {
				h(e);
			}
		},
		listenerCount() {
			return Object.values(hs).reduce((n, l) => n + l.length, 0);
		},
	};
}

const ptr = (pointerId: number, clientY: number, currentTarget?: unknown): PointerEvent =>
	({
		pointerId,
		clientY,
		pointerType: 'touch',
		preventDefault: () => {},
		currentTarget,
	}) as unknown as PointerEvent;

describe('startSheetDrag', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/** A clock the test moves: performance.now() is the drag's only time. */
	function clock(): { tick: (ms: number) => void } {
		let now = 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		return {
			tick: (ms) => {
				now += ms;
			},
		};
	}

	/* The window stub RECORDS: a no-op one let a release-fallback that was
	 * only ever REMOVED, never added, pass as a fix. */
	function stubEnv(): FakeEl {
		const win = fakeEl();
		vi.stubGlobal('window', win);
		vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} });
		return win;
	}

	it('runs an ordinary drag and reports where it was let go', () => {
		stubEnv();
		const el = fakeEl();
		const let_go: number[] = [];
		startSheetDrag(ptr(1, 100, el), {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px) => let_go.push(px),
		});
		el.fire('pointermove', ptr(1, 60));
		el.fire('pointerup', ptr(1, 60));
		expect(let_go).toEqual([240]);
		expect(el.listenerCount()).toBe(0);
	});

	it('settles when capture vanishes with no release, so the next drag still runs', () => {
		stubEnv();
		const gone = fakeEl();
		const let_go: number[] = [];
		const opts = {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px: number) => let_go.push(px),
		};
		startSheetDrag(ptr(1, 100, gone), opts);
		gone.fire('pointermove', ptr(1, 80));
		// The element is removed from the DOM mid-drag (an eviction, a
		// rotation reflow): capture is lost and no pointerup ever reaches it.
		gone.fire('lostpointercapture', { ...ptr(1, 80), target: gone });
		expect(let_go).toEqual([]);
		expect(gone.listenerCount()).toBe(0);
		// Without that settle the module's one-drag-at-a-time flag would stay
		// set and refuse every later grip drag for the rest of the session.
		const next = fakeEl();
		startSheetDrag(ptr(2, 100, next), opts);
		next.fire('pointermove', ptr(2, 60));
		next.fire('pointerup', ptr(2, 60));
		expect(let_go).toEqual([240]);
	});

	it('settles on a release the element never sees, capture having been refused', () => {
		// A pointer the browser will not let the element capture (a synthetic
		// one, a release that landed first): the finger then lifts off the
		// grip and no pointerup reaches the element at all. Without a
		// window-level release the one-drag-at-a-time flag would stay set and
		// refuse every later grip drag for the rest of the session.
		const win = stubEnv();
		const el = fakeEl();
		el.setPointerCapture = () => {
			throw new Error('refused');
		};
		const let_go: number[] = [];
		const opts = {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px: number) => let_go.push(px),
		};
		startSheetDrag(ptr(1, 100, el), opts);
		win.fire('pointermove', ptr(1, 60));
		win.fire('pointerup', ptr(1, 60));
		expect(el.listenerCount()).toBe(0);
		expect(win.listenerCount()).toBe(0);
		// A second drag is not refused by a flag nobody cleared.
		const next = fakeEl();
		startSheetDrag(ptr(2, 100, next), opts);
		next.fire('pointermove', ptr(2, 60));
		next.fire('pointerup', ptr(2, 60));
		expect(let_go).toEqual([240]);
	});

	it('takes the drag target the caller hands it, not the event\'s', () => {
		// The pane head arms on the WINDOW and hands the pointer over from a
		// move whose currentTarget is the window, so the drag has to be told
		// which element it runs on.
		stubEnv();
		const head = fakeEl();
		startSheetDrag(ptr(3, 100, { not: 'an element' }), {
			target: head as unknown as HTMLElement,
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: () => {},
		});
		expect(head.captured).toBe(3);
		head.fire('pointerup', ptr(3, 100));
		expect(head.listenerCount()).toBe(0);
	});

	it('runs on when capture comes to it from a child', () => {
		// A finger's press holds capture on the element it landed on (a
		// chevron, the title's text). Taking capture on the head fires
		// lostpointercapture at that child, and the event bubbles to the
		// head: read as the head's own loss, it ended every drag begun on
		// the head's content the moment it began.
		stubEnv();
		const head = fakeEl();
		const let_go: number[] = [];
		startSheetDrag(ptr(4, 100, head), {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px) => let_go.push(px),
		});
		head.fire('lostpointercapture', { ...ptr(4, 100), target: { a: 'chevron' } });
		head.fire('pointermove', ptr(4, 60));
		head.fire('pointerup', ptr(4, 60));
		expect(let_go).toEqual([240]);
	});

	it('measures a throw from where the drag took over, not from the press', () => {
		// The head hands a press over once it has travelled the slop, and
		// passes where the finger first landed as startY. Measured from
		// there, the first move after the hand-over divided all the travel
		// before it by one frame.
		stubEnv();
		const c = clock();
		const head = fakeEl();
		const thrown: number[] = [];
		startSheetDrag(ptr(5, 70, head), {
			startY: 100,
			target: head as unknown as HTMLElement,
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (_px, velocity) => thrown.push(velocity),
		});
		c.tick(8);
		head.fire('pointermove', ptr(5, 68));
		head.fire('pointerup', ptr(5, 68));
		expect(thrown).toEqual([2 / 8]);
	});

	it('reads a release short of SWIPE_SLOP as no throw, however fast', () => {
		// A tap whose finger rolls as it lifts: 12 px in 4 ms is 3 px/ms,
		// five times FLICK, and ran the pane to the end it pointed at.
		stubEnv();
		const c = clock();
		const el = fakeEl();
		const let_go: [number, number][] = [];
		startSheetDrag(ptr(6, 100, el), {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px, velocity) => let_go.push([px, velocity]),
		});
		c.tick(4);
		el.fire('pointermove', ptr(6, 88));
		el.fire('pointerup', ptr(6, 88));
		expect(SWIPE_SLOP).toBeGreaterThan(12);
		expect(let_go).toEqual([[212, 0]]);
	});

	it('keeps the speed of a throw that cleared SWIPE_SLOP', () => {
		stubEnv();
		const c = clock();
		const el = fakeEl();
		const let_go: [number, number][] = [];
		startSheetDrag(ptr(7, 100, el), {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px, velocity) => let_go.push([px, velocity]),
		});
		c.tick(10);
		el.fire('pointermove', ptr(7, 70));
		el.fire('pointerup', ptr(7, 70));
		expect(let_go).toEqual([[230, 3]]);
		expect(let_go[0][1]).toBeGreaterThan(FLICK);
	});

	it('reads a throw whose finger rested before it lifted as no throw', () => {
		// A browser reports no move while the finger rests, so the speed of
		// the last one outlived it: a quick drag held still at the height
		// wanted, then lifted, ran the pane to the end it had pointed at.
		stubEnv();
		const c = clock();
		const el = fakeEl();
		const let_go: [number, number][] = [];
		startSheetDrag(ptr(8, 100, el), {
			startHeight: 200,
			min: 0,
			max: 400,
			onMove: () => {},
			onRelease: (px, velocity) => let_go.push([px, velocity]),
		});
		c.tick(10);
		el.fire('pointermove', ptr(8, 70));
		c.tick(REST_MS + 1);
		el.fire('pointerup', ptr(8, 70));
		expect(let_go).toEqual([[230, 0]]);
	});
});

/* The swipe-down dismissal over DOM-less stand-ins: a sheet node that
 * records its listeners, touch events carrying their touch lists. */
describe('swipeDismiss', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/** A sheet swiped down 40 px in two moves 10 ms apart (4 px/ms at the
	 *  last), the finger resting `restMs` before it lifts: how many times the
	 *  sheet closed. */
	function swipe(restMs: number): number {
		let now = 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => now);
		vi.stubGlobal('Element', class {});
		const hs: Record<string, ((e: unknown) => void)[]> = {};
		const node = {
			style: {},
			classList: { add: () => {}, remove: () => {} },
			addEventListener: (t: string, h: (e: unknown) => void) => {
				(hs[t] ??= []).push(h);
			},
		};
		const fire = (t: string, y?: number): void => {
			const e = { target: null, touches: y === undefined ? [] : [{ clientY: y }], preventDefault: () => {} };
			for (const h of hs[t] ?? []) {
				h(e);
			}
		};
		let closed = 0;
		swipeDismiss(node as unknown as HTMLElement, () => closed++);
		fire('touchstart', 100);
		now += 10;
		fire('touchmove', 130);
		now += 10;
		fire('touchmove', 140);
		now += restMs;
		fire('touchend');
		return closed;
	}

	it('dismisses a sheet flicked down past the slop', () => {
		expect(swipe(0)).toBe(1);
	});

	it('keeps a sheet whose finger rested before it lifted, short of DISMISS_PX', () => {
		expect(DISMISS_PX).toBeGreaterThan(40);
		expect(swipe(REST_MS + 1)).toBe(0);
	});
});
