/* The map's foot (MapView .map-foot): ONE box holding the time strips, or
 * the chips they fold into, that publishes ONE height for what stands on it
 * (the bottom-left column, the corner credit) and that the fit measures. It
 * replaced two heights each strip published itself and three calc formulas
 * summing them with different gaps, one per consumer and layout. Pinned at
 * the source, the popupMenu.spec idiom: layout is nothing the node project
 * renders. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe("the map's foot", () => {
	it('is one box, the radar strip over the replay strip, publishing one height', () => {
		const mapView = read('src/lib/components/MapView.svelte');
		const open = mapView.match(/<div class="map-foot no-print"[^>]*>/g) ?? [];
		expect(open).toHaveLength(1);
		const tag = open[0] ?? '';
		expect(tag).toContain('bind:offsetHeight={footH}');
		expect(mapView).toMatch(/<div class="map-wrap" bind:this=\{mapWrap\} style:--map-foot-h=\{`\$\{footH\}px`\}>/);
		const foot = mapView.slice(mapView.indexOf(tag));
		const body = foot.slice(0, foot.indexOf('</div>'));
		expect(body.replace(/\s+/g, ' ')).toContain('<RadarTimeline /> <ReplayStrip />');
	});

	it('leaves no strip publishing a height of its own', () => {
		for (const p of [
			'src/lib/components/MapView.svelte',
			'src/lib/components/RadarTimeline.svelte',
			'src/lib/components/ReplayStrip.svelte',
			'src/app.css',
		]) {
			const src = read(p);
			expect(src).not.toContain('--radar-strip-h');
			expect(src).not.toContain('--replay-strip-h');
		}
	});

	it('stands the corner credit on it, on every layout, with length fallbacks', () => {
		const css = read('src/app.css');
		const rule = /\.map-wrap \.leaflet-container \.leaflet-bottom \{[^}]*\}/.exec(css)?.[0] ?? '';
		expect(rule).toContain('bottom: calc(var(--map-foot-h, 0px) + min(var(--map-foot-h, 0px), var(--foot-b, 0px)));');
		// A bare 0 fallback inside a calc drops the whole declaration.
		expect(rule).not.toMatch(/var\(--[a-z-]+, 0\)/);
		expect(css).not.toMatch(/:root\.mobile-ui \.leaflet-container \.leaflet-bottom/);
	});

	it('keeps clear of the desktop detail panel, which overlays the map', () => {
		const mapView = read('src/lib/components/MapView.svelte');
		expect(mapView).toContain('const footInset = $derived(!ui.isMobile && detailOpen() ? panelWidths.detail : 0);');
		expect(mapView).toContain('style:--foot-inset={`${footInset}px`}');
		const rule = /\.map-foot \{[^}]*\}/.exec(mapView)?.[0] ?? '';
		expect(rule).toContain('right: calc(max(8px, var(--sar, 0px)) + var(--foot-inset, 0px));');
		expect(rule).toContain('bottom: var(--foot-b);');
		expect(rule).toContain('pointer-events: none;');
	});

	it('is what a fit keeps clear of, on both layouts', () => {
		const focus = read('src/lib/map/focus.ts');
		const fn = focus.slice(focus.indexOf('function chromeInsets('), focus.indexOf('export function fitBoundsClear('));
		expect(fn).toContain("querySelectorAll('.map-foot > *')");
		expect(fn).not.toContain('isMobile');
	});
});
