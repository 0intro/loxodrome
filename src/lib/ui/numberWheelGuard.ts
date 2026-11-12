/* Global guard against the <input type="number"> / <select> wheel footgun.
 *
 * A focused number input (or select) STEPS its value when the mouse wheel rolls
 * over it, firing `input` / `change`. So scrolling the page with the pointer
 * over such a control silently commits a value the user never typed; on the
 * performance grid a net-zero fidget (up then back down) even re-froze the live
 * METAR default into a persisted, then stale, override.
 *
 * One document-level listener covers every control, current and future, instead
 * of a per-input action on 60+ sites. On a wheel rolled over the focused
 * control it blurs it: the wheel-to-step only applies to the focused element, so
 * dropping focus skips that tick's step and lets the page scroll normally. The
 * pointer-over-the-control test (contains) means scrolling elsewhere with a
 * field focused is left alone. Deliberate edits (typing, arrow keys, the
 * spinner) never go through `wheel`, so they are untouched.
 *
 * Capture phase so a descendant that stops `wheel` propagation can't hide the
 * event; passive (we only blur, never preventDefault, which would also block
 * the scroll); idempotent so an HMR re-run can't stack listeners.
 */

let installed = false;

export function installNumberWheelGuard(): void {
	if (installed || typeof document === 'undefined') {
		return;
	}
	installed = true;
	document.addEventListener(
		'wheel',
		(e) => {
			const el = document.activeElement;
			if (
				((el instanceof HTMLInputElement && el.type === 'number') ||
					el instanceof HTMLSelectElement) &&
				e.target instanceof Node &&
				el.contains(e.target)
			) {
				el.blur();
			}
		},
		{ capture: true, passive: true },
	);
}
