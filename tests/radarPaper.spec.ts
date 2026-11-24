/* The precipitation radar never reaches paper (ICAO Doc 8896 5.3.1.2 keeps
 * radar imagery out of flight documentation; docs/precipitation-radar.md).
 * The map never prints, and the print rule hides the pane of its own all
 * the same. Pinned from the sources, the radarCaution.spec precedent, the
 * readouts that carry a reading included: the hover badge and the context
 * menu's radar rows. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

describe('the radar off paper', () => {
	it('is hidden under print', () => {
		const css = read('src/app.css');
		const at = css.indexOf('@media print');
		expect(at).toBeGreaterThan(0);
		const block = css.slice(at, css.indexOf('\n}\n', at));
		expect(block).toMatch(/\.leaflet-radar-pane\s*{\s*display: none !important;/);
	});

	it('draws into the pane that rule names', () => {
		// Leaflet's createPane(name) classes the pane `leaflet-<name>-pane`,
		// which ensurePane (directDrawLayer) calls with the layer's PANE.
		const layer = read('src/lib/map/radarLayer.ts');
		expect(layer).toContain("const PANE = 'radar';");
		// ... and the layer really asks for THAT pane. Without this the
		// constant could stay while the layer drew into another, leaving the
		// print rule looking at an empty pane.
		expect(layer).toMatch(/paneName\s*=\s*PANE|ensurePane\([^)]*\bPANE\b/);
		expect(read('src/lib/map/directDrawLayer.ts')).toContain('createPane(name');
	});

	it('keeps the readings off paper: the hover badge and the context menu\'s rows', () => {
		// Both readouts carry a value in dBZ or mm/h with its frame's time.
		// The context menu sits outside the map, which is why its rows
		// carry no-print of their own.
		const map = read('src/lib/components/MapView.svelte');
		expect(map).toMatch(/class="wind-tip(?: [\w-]+)* no-print"/);
		const menu = read('src/lib/components/ContextMenu.svelte');
		const at = menu.indexOf('{t.map.radarHeading}');
		expect(at).toBeGreaterThan(0);
		const open = menu.lastIndexOf('<div', at);
		expect(menu.slice(open, at)).toContain('no-print');
		const row = menu.indexOf('radar-row', at);
		expect(menu.slice(menu.lastIndexOf('<div', row), row + 20)).toContain('no-print');
	});

	it('keeps the tab section that describes it off paper too', () => {
		// The pane rule hides the IMAGERY. The Weather tab's radar section is
		// ordinary sidebar text, and the browser's own print with no window
		// claimed prints the side panel, so the colour scale, the intensity words and the frame's
		// age and publication time would land on a sheet that reads as flight
		// documentation.
		const tab = read('src/lib/components/tabs/WeatherTab.svelte');
		const at = tab.indexOf('{t.weather.radar.legend}');
		expect(at).toBeGreaterThan(0);
		const open = tab.lastIndexOf('<fieldset', at);
		expect(tab.slice(open, at)).toContain('no-print');
	});
});
