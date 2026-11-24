/* The route profile modal's window and empty states, pinned on its source:
 * no spec mounts the modals (tests/profileStackMenuOpen.spec.ts). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync('src/lib/components/RouteProfileModal.svelte', 'utf8');

describe('the route profile’s distance window', () => {
	it('keeps a touched window inside a route cut shorter under it', () => {
		// The restore effect re-runs on the route's length. Rewriting only an
		// untouched window would leave one zoomed to [80, 100] NM past the end
		// of a route cut to 60 NM, its slider handles off the track.
		const at = src.indexOf('if (!win.distTouched) {');
		expect(at).toBeGreaterThan(-1);
		expect(src.slice(at, at + 600)).toContain(
			'clampDistWindow(win.viewFromNM, win.viewToNM, tot, win.distMinSpan)',
		);
	});
});

describe('the route profile’s empty states', () => {
	it('says a route at one place has nothing to draw', () => {
		// LFPN LFPN is two waypoints at one place: enough waypoints and no
		// length, and the window machine waits for a span it never gets, so
		// "Sizing…" would stand for ever.
		expect(src).toContain('const plottable = $derived(enough && totalNM > 0);');
		const at = src.indexOf('{#if !enough}');
		expect(at).toBeGreaterThan(-1);
		expect(src.slice(at, at + 300)).toMatch(/\{:else if !plottable\}\s*<p class="muted">\{t\.route\.profileOnePlace\}<\/p>/);
	});
});
