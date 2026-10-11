/* Use-action that teleports a DOM node to `document.body` on mount and
 * removes it on destroy. Needed for fixed-position modals that would
 * otherwise be confined to an ancestor with a `transform` (which
 * promotes that ancestor to the containing block for fixed-position
 * descendants per the CSS spec). DetailPanel's slide-in animation uses
 * `transform: translateX(...)`, so a modal rendered inside the panel
 * would centre on the panel rather than the viewport.
 *
 * Usage: <div use:portal> ... </div>
 *
 * The action is intentionally minimal -- no target option, no fade,
 * no scroll-lock. Add those if a second portal call site needs them.
 */

export function portal(node: HTMLElement): { destroy: () => void } {
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}
