/* Pins the swipe-down-to-dismiss threshold every phone sheet shares
 * (ui/sheet.ts swipeDismisses). */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_PX, FLICK, SWIPE_SLOP, suppressNextClick, swipeDismisses } from '$lib/ui/sheet';

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

	function stubDocument(): { clicks: number; fire: () => { prevented: boolean } } {
		let handler: ((e: MouseEvent) => void) | null = null;
		const doc = {
			addEventListener: (t: string, h: (e: MouseEvent) => void, capture?: boolean) => {
				if (t === 'click' && capture === true) {
					handler = h;
				}
			},
			removeEventListener: () => {},
		};
		vi.stubGlobal('document', doc);
		return {
			get clicks() {
				return handler ? 1 : 0;
			},
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

	it('is what the grip gesture calls on a touch release', () => {
		const src = readFileSync(join(process.cwd(), 'src/lib/ui/sheet.ts'), 'utf8');
		const end = src.slice(src.indexOf('function end('), src.indexOf('opts.onRelease(height, velocity);'));
		expect(end).toMatch(/if \(ev\.pointerType !== 'mouse'\) \{\s*suppressNextClick\(\);/);
	});
});
