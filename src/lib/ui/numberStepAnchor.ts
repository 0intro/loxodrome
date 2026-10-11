/* Global rule: an empty number input steps from the value its placeholder
 * shows, not from zero.
 *
 * A gray placeholder over an empty numeric box IS the value in force in this
 * app, the automatic one it would use: the station's default mass, the METAR
 * QNH, the AIP transition altitude, the derived final reserve. Typing pins an
 * override, clearing hands it back. The browser knows nothing of that and steps
 * an empty value from 0, so the up arrow on a station showing 80 kg committed
 * 1 kg, and on a QNH showing 1013 hPa it committed 900 (0 + 1, clamped to min):
 * the nudge the pilot meant became a value nobody would ever type. The QNH cell
 * used to buy its way out by refusing the placeholder and rendering a real 1013,
 * which is exactly what a live METAR default must not do (a materialised default
 * goes stale in a saved route file).
 *
 * The anchor is written into the box BEFORE the browser steps: a default action
 * runs after the listeners, so the step reads it, and the browser still applies
 * min / max and the step grid itself. The field's own oninput then sees an
 * ordinary event carrying 81 / 1014, and the box is a typed override like any
 * other.
 *
 * An anchor nothing stepped is taken back on the next frame, before it can
 * paint: a click that merely placed the caret must leave the box empty (still
 * automatic) and must never be typed on top of, where a stuck 80 would turn a
 * typed 8 into 808. So an anchor survives only when an input event says the step
 * landed; an engine that stepped on the click rather than on the press would
 * simply behave as it did before this module, committing nothing on its own.
 *
 * One document-level listener per event covers every field, current and future,
 * instead of an action on 60+ sites: the sibling numberWheelGuard's reasoning.
 * Capture phase so a descendant that stops propagation cannot hide the event;
 * idempotent so an HMR re-run cannot stack listeners.
 */

/** The value an empty box's spinner should step from: the number its placeholder
 *  shows, or null when there is none to read. */
export function stepAnchor(value: string, placeholder: string): string | null {
	// A box with content already carries its own anchor.
	if (value !== '') {
		return null;
	}
	const text = placeholder.trim();
	// Number('') is 0, and the placeholder is blank wherever the automatic value
	// is unknown (no aircraft selected, no fuel row yet): no anchor, not zero.
	if (text === '') {
		return null;
	}
	const n = Number(text);
	// '= capacity', an em dash, 'hh:mm': a worded placeholder is a hint, not a
	// value, and nothing may be inferred from it.
	if (!Number.isFinite(n)) {
		return null;
	}
	// Normalised, since type=number drops a value it cannot parse: setting
	// ' 80 ' would empty the box instead of anchoring it.
	return String(n);
}

/** The anchor written this tick, until an input event confirms the step. */
let pending: HTMLInputElement | null = null;

function anchor(el: HTMLInputElement): void {
	if (el.type !== 'number' || el.disabled || el.readOnly) {
		return;
	}
	const text = stepAnchor(el.value, el.placeholder);
	if (text == null) {
		return;
	}
	el.value = text;
	pending = el;
	requestAnimationFrame(() => {
		if (pending === el) {
			pending = null;
			el.value = '';
		}
	});
}

let installed = false;

export function installNumberStepAnchor(): void {
	if (installed || typeof document === 'undefined') {
		return;
	}
	installed = true;
	document.addEventListener(
		'keydown',
		(e) => {
			if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target instanceof HTMLInputElement) {
				anchor(e.target);
			}
		},
		{ capture: true },
	);
	// The spinner is a pointer affordance (no touch device draws one) and steps
	// on the press, so the anchor lands ahead of it.
	document.addEventListener(
		'pointerdown',
		(e) => {
			if (e.button === 0 && e.pointerType !== 'touch' && e.target instanceof HTMLInputElement) {
				anchor(e.target);
			}
		},
		{ capture: true },
	);
	// The step landed: the anchor stays, and the field commits it like a typed
	// value.
	document.addEventListener(
		'input',
		(e) => {
			if (pending !== null && e.target === pending) {
				pending = null;
			}
		},
		{ capture: true },
	);
}
