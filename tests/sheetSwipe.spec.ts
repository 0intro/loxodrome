/* Pins the swipe-down-to-dismiss threshold every phone sheet shares
 * (ui/sheet.ts swipeDismisses). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_PX, FLICK, SWIPE_SLOP, startSheetDrag, suppressNextClick, swipeDismisses } from '$lib/ui/sheet';

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
	afterEach(() => vi.unstubAllGlobals());

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
		gone.fire('lostpointercapture', ptr(1, 80));
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
});
