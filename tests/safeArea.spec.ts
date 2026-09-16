/* Pins the one judgement in $lib/ui/safeArea.ts: when a reported bottom
 * safe-area inset is dead space the app must not pad for. The measurement is
 * the browser window against the screen, and every uncertain case has to keep
 * the padding, since controls under a system bar is the worse failure. */
import { describe, expect, it } from 'vitest';
import { bottomInsetIsDead } from '../src/lib/ui/safeArea';

/* The device the band was reported on, read off its own probe: a 920px screen
 * holding an 821px Chrome window (a 757px viewport under a 64px URL bar), with
 * a 48.3px inset reported for a navigation bar drawn BELOW the window. */
const DEVICE = { screen: 920, outer: 821, inner: 757, inset: 48.3 } as const;

describe('bottomInsetIsDead', () => {
	it('calls the inset dead when the navigation bar is outside the window', () => {
		expect(
			bottomInsetIsDead(DEVICE.inset, DEVICE.screen, DEVICE.outer, DEVICE.inner, false),
		).toBe(true);
	});

	it('reads the same in the installed app, where the window has no chrome', () => {
		// Standalone drops the URL bar, so the window is the viewport; the
		// system bars are still outside it.
		expect(bottomInsetIsDead(DEVICE.inset, DEVICE.screen, 821, 821, true)).toBe(true);
	});

	it('keeps the inset when the window really does reach the screen edge', () => {
		// Edge to edge: the bar the inset stands for is over the page, and the
		// padding is doing its job. A tab (its own chrome inside the window)
		// and an installed app alike.
		expect(bottomInsetIsDead(24, 920, 920, 856, false)).toBe(false);
		expect(bottomInsetIsDead(34, 844, 844, 844, true)).toBe(false);
	});

	it('keeps an inset the space outside the window cannot account for', () => {
		// 24px of screen outside the window, far short of the 48px claimed.
		expect(bottomInsetIsDead(48, 920, 896, 832, false)).toBe(false);
	});

	it('distrusts a window that measures its own viewport in a tab', () => {
		// A tab always has chrome somewhere, so outerHeight === innerHeight is
		// an engine that does not distinguish the two: no reading, no change.
		expect(bottomInsetIsDead(34, 844, 745, 745, false)).toBe(false);
	});

	it('distrusts an outer height in the wrong unit', () => {
		// Device pixels (821 CSS px at dpr 2.6), and the mirror case of a
		// window shorter than the viewport it holds.
		expect(bottomInsetIsDead(48.3, 920, 2142, 757, false)).toBe(false);
		expect(bottomInsetIsDead(48.3, 920, 700, 757, false)).toBe(false);
	});

	it('has nothing to say without a reported inset', () => {
		expect(bottomInsetIsDead(0, 920, 821, 757, false)).toBe(false);
	});

	it('allows rounding slop, but only 4px of it', () => {
		expect(bottomInsetIsDead(48, 876, 832, 757, false)).toBe(true);
		expect(bottomInsetIsDead(48, 875, 832, 757, false)).toBe(false);
	});
});
