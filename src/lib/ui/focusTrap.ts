/* Use-action that traps keyboard focus inside an open modal dialog: it
 * focuses the first focusable element on mount, cycles Tab / Shift+Tab
 * within the node, and restores focus to the previously-focused element
 * on destroy. Escape-to-close stays with each modal's own handler.
 *
 * Usage: <div class="modal-box" use:focusTrap role="dialog"> ... </div>
 */

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), ' +
	'select:not([disabled]), textarea:not([disabled]), ' +
	'[tabindex]:not([tabindex="-1"])';

export function focusTrap(node: HTMLElement): { destroy: () => void } {
	const previouslyFocused = document.activeElement as HTMLElement | null;

	// Visible (rendered) focusable descendants, in DOM order.
	const focusable = (): HTMLElement[] =>
		Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
			(el) => el.getClientRects().length > 0,
		);

	function onKeydown(e: KeyboardEvent): void {
		if (e.key !== 'Tab') {
			return;
		}
		const items = focusable();
		if (items.length === 0) {
			e.preventDefault();
			return;
		}
		const first = items[0];
		const last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	// Move focus inside the dialog so keyboard users start within the trap.
	focusable()[0]?.focus();
	node.addEventListener('keydown', onKeydown);

	return {
		destroy() {
			node.removeEventListener('keydown', onKeydown);
			previouslyFocused?.focus?.();
		},
	};
}

/** focusTrap, switchable at runtime: a workspace surface traps focus while it
 *  covers the screen (full screen, dialog) and lets it go while it is docked
 *  or paged beside the map, where the sidebar and the panels stay live.
 *  A `use:` directive cannot be applied conditionally, so the condition rides
 *  as the action's parameter. */
export function focusTrapIf(
	node: HTMLElement,
	enabled: boolean,
): { update: (next: boolean) => void; destroy: () => void } {
	let trap = enabled ? focusTrap(node) : null;
	return {
		update(next: boolean) {
			if (next === (trap !== null)) {
				return;
			}
			if (next) {
				trap = focusTrap(node);
			} else {
				trap?.destroy();
				trap = null;
			}
		},
		destroy() {
			trap?.destroy();
		},
	};
}
