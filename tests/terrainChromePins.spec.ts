/* Three first-pass terrain fixes that no spec held, pinned by source (the
 * popupMenu.spec idiom: they live in a component's markup and style and in
 * the service worker's build config, which no suite mounts or runs).
 *
 * - The legend annunciates the pilot's inhibit ON ITS OWN when the shading is
 *   off: the inhibit silences every terrain and obstacle alert for the rest
 *   of the trace, and a display toggle must not hide that it does.
 * - The service worker caches the terrain worker's 204 beside its tiles: a
 *   204 is the open sea, as immutable as a tile, and uncached every sea tile
 *   read offline FAILED and drew as "no terrain data".
 * - The map's bottom-left column stands on the map's foot (the time strips
 *   and their chips) on every layout: a strip spans a phone and reaches the
 *   legend on a desktop map narrower than about 900 px. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('the terrain chrome', () => {
	it('annunciates the inhibit with the shading off', () => {
		const src = readFileSync('src/lib/components/TerrainLegend.svelte', 'utf8');
		const inhibited = src.slice(src.indexOf('const inhibited = $derived('), src.indexOf('</script>'));
		expect(inhibited).not.toContain('terrainAwareness');
		expect(src).toMatch(/\{:else if inhibited\}\s*<div class="terrain-legend map-readout no-print">\s*<div class="note inhb">\{t\.navigation\.alertTerrainInhibited\}<\/div>/);
	});

	it("caches the terrain worker's 204 beside its tiles", () => {
		const src = readFileSync('vite.config.ts', 'utf8');
		const route = src.slice(src.indexOf("url.pathname.startsWith('/terrain/')"));
		const opts = route.slice(0, route.indexOf('},\n\t\t\t\t\t},'));
		expect(opts).toContain("cacheName: 'terrain-tiles'");
		expect(opts).toContain('cacheableResponse: { statuses: [0, 200, 204] }');
	});

	it("stands the map's bottom-left column on the map's foot, on every layout", () => {
		const src = readFileSync('src/lib/components/MapView.svelte', 'utf8');
		const rules = [...src.matchAll(/\.corner-bl \{[^}]*\}/g)].map((m) => m[0]);
		// ONE rule: a layout-scoped override is how the phone column once
		// stood on a different sum of strip heights than the desktop's.
		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatch(/bottom: calc\(var\(--foot-b\) \+ var\(--map-foot-h, 0px\) \+ min\(var\(--map-foot-h, 0px\), 6px\)\)/);
	});
});
