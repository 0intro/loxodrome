/* The bottom safe-area inset, measured against the screen instead of taken on
 * trust.
 *
 * `env(safe-area-inset-bottom)` states how much of the viewport's bottom edge
 * lies under system chrome (an iPhone's home indicator, an Android navigation
 * bar), and every surface that owns that edge pads by it so its controls stay
 * reachable: the mobile tab rail, the two bottom sheets, the bottom dock, a
 * full-screen surface. Chrome on Android reports the navigation bar's whole
 * height to a page it lays ABOVE the bar, and the padding then buys nothing:
 * the tab rail grows a dead band of its own grey, as tall again as the icons
 * it carries (measured on device: a 48.3px inset, a 115px rail).
 *
 * The check is the WINDOW against the screen. `outerHeight` is the browser
 * window including its own chrome, so screen height it does not reach is
 * system chrome outside the window; finding at least the inset's own height
 * out there means no part of the page can be under the bar the inset stands
 * for, and the strip is dead. Measuring the window rather than the viewport is
 * what makes this work in an ordinary tab: the URL bar lives INSIDE the
 * window, so it never reads as space the page was kept out of.
 *
 * Every uncertain case keeps the padding, which is today's behaviour: the
 * failure worth avoiding is controls under a bar, not a band of grey. That
 * covers engines reporting `outerHeight` in device pixels or simply mirroring
 * the viewport, and a window that already reaches the screen edge (a genuine
 * edge-to-edge browser, where the inset is real and does its job).
 */

/** Rounding slop between the screen and window measurements (px). */
const SLOP_PX = 4;

/** Standalone, i.e. the window carries no browser chrome of its own. */
const STANDALONE_MEDIA = '(display-mode: standalone), (display-mode: fullscreen)';

/** Whether a reported bottom inset is dead space: the browser window stops at
 *  least that far short of the screen, so nothing draws in the strip the app
 *  would pad. Pure, so the truth table is testable without a DOM. */
export function bottomInsetIsDead(
	insetPx: number,
	screenHeightPx: number,
	outerHeightPx: number,
	viewportHeightPx: number,
	standalone: boolean,
): boolean {
	if (insetPx <= 0) {
		return false;
	}
	// A window taller than its screen, or shorter than the viewport it holds,
	// is a reading in the wrong unit or no reading at all.
	if (outerHeightPx > screenHeightPx || outerHeightPx < viewportHeightPx) {
		return false;
	}
	// In a tab the window has to show chrome somewhere; one that measures its
	// own viewport is an engine that does not distinguish the two, and its
	// outer height cannot say where the window ends.
	if (!standalone && outerHeightPx <= viewportHeightPx + SLOP_PX) {
		return false;
	}
	return screenHeightPx - outerHeightPx >= insetPx - SLOP_PX;
}

/** The inset the browser reports, off the token that is never overridden. */
function reportedInsetPx(root: HTMLElement): number {
	const px = Number.parseFloat(getComputedStyle(root).getPropertyValue('--sab-env'));
	return Number.isFinite(px) ? px : 0;
}

/** Keep `--sab` in step with what the bottom inset is worth, and return the
 *  teardown. Re-measures on anything that can move the window inside the
 *  screen: a rotation, a resize, the app being launched or left standalone. */
export function watchSafeArea(): () => void {
	const root = document.documentElement;
	const standalone = window.matchMedia(STANDALONE_MEDIA);
	const vv = window.visualViewport;

	const sync = (): void => {
		const dead = bottomInsetIsDead(
			reportedInsetPx(root),
			window.screen.height,
			window.outerHeight,
			window.innerHeight,
			standalone.matches,
		);
		if (dead) {
			root.style.setProperty('--sab', '0px');
		} else {
			root.style.removeProperty('--sab');
		}
	};

	sync();
	window.addEventListener('resize', sync);
	standalone.addEventListener('change', sync);
	vv?.addEventListener('resize', sync);
	return () => {
		window.removeEventListener('resize', sync);
		standalone.removeEventListener('change', sync);
		vv?.removeEventListener('resize', sync);
		root.style.removeProperty('--sab');
	};
}
