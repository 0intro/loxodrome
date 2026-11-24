/* The hold's haptic tick, where the platform vibrates: a finger's long press
 * that lifted something (a map pin, a strip's tab, a list's disc). A no-op
 * where the platform does not vibrate, the APK included without its VIBRATE
 * permission, and on a silent ringer. */

/** Short enough to read as a click. */
const HOLD_TICK_MS = 20;

export function holdTick(): void {
	if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
		navigator.vibrate(HOLD_TICK_MS);
	}
}
