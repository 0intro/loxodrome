/* Native-app detection (the Capacitor Android shell; docs/android.md).
 *
 * The Capacitor runtime injects `window.Capacitor` before the page loads, so
 * its presence IS the platform test. That only stays true while the web
 * bundle never imports `@capacitor/*` statically: a static import of the core
 * package defines the global in every browser and corrupts this check. All
 * plugin access is dynamic-imported behind this predicate. */
export function isNativeApp(): boolean {
	return typeof window !== 'undefined' && 'Capacitor' in window;
}
