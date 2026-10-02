/* A press held still: the in-flight band's second gesture on a cell whose
 * tap already cycles a ring (docs/nav-live.md "Which frequency"). Svelte
 * action: `use:longPress={onLong}`.
 *
 * Fires once after LONG_PRESS_MS with the pointer inside MOVE_SLOP, or on the
 * platform's own long-press signal (`contextmenu`, which the Android WebView
 * and desktop's right button both raise), whichever comes first; the click
 * the same press would land afterwards is swallowed, so a held press never
 * also cycles the ring. Text selection is the caller's CSS to refuse
 * (`user-select: none`). */

export const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;

export function longPress(
	node: HTMLElement,
	onLong: () => void,
): { update: (next: () => void) => void; destroy: () => void } {
	let handler = onLong;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let startX = 0;
	let startY = 0;
	let fired = false;

	function clear(): void {
		if (timer != null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function down(e: PointerEvent): void {
		if (e.pointerType === 'mouse' && e.button !== 0) {
			return;
		}
		fired = false;
		startX = e.clientX;
		startY = e.clientY;
		clear();
		timer = setTimeout(() => {
			timer = null;
			fired = true;
			handler();
		}, LONG_PRESS_MS);
	}

	function move(e: PointerEvent): void {
		if (timer != null && Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_SLOP) {
			clear();
		}
	}

	function up(): void {
		clear();
	}

	function click(e: MouseEvent): void {
		if (fired) {
			e.preventDefault();
			e.stopImmediatePropagation();
			fired = false;
		}
	}

	function context(e: MouseEvent): void {
		e.preventDefault();
		clear();
		if (!fired) {
			fired = true;
			handler();
		}
	}

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', up);
	node.addEventListener('pointerleave', up);
	node.addEventListener('click', click, true);
	node.addEventListener('contextmenu', context);
	return {
		update(next) {
			handler = next;
		},
		destroy() {
			clear();
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', up);
			node.removeEventListener('pointerleave', up);
			node.removeEventListener('click', click, true);
			node.removeEventListener('contextmenu', context);
		},
	};
}
