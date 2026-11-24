/* The map's foot (MapView .map-foot): ONE box holding the time strips, or
 * the chips they fold into, that publishes ONE height for what stands on it
 * (the bottom-left column, the corner credit) and that the fit measures. It
 * replaced two heights each strip published itself and three calc formulas
 * summing them with different gaps, one per consumer and layout. On a
 * desktop map with room beside its box, the two corners keep their corners
 * instead (map/footStance.ts, tests/footStance.spec.ts). Pinned at the
 * source, the popupMenu.spec idiom: layout is nothing the node project
 * renders. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOOT_GAP_PX, FOOT_SIDE_PX } from '$lib/map/footStance';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe("the map's foot", () => {
	it('is one box, the radar strip over the replay strip, publishing one height', () => {
		const mapView = read('src/lib/components/MapView.svelte');
		const open = mapView.match(/<div class="map-foot no-print"[^>]*>/g) ?? [];
		expect(open).toHaveLength(1);
		const tag = open[0] ?? '';
		expect(tag).toContain('bind:offsetHeight={footH}');
		const wrap = /<div\s+class="map-wrap"[^>]*>/.exec(mapView)?.[0] ?? '';
		expect(wrap).toContain('bind:this={mapWrap}');
		expect(wrap).toContain('style:--map-foot-h={`${footH}px`}');
		expect(wrap).toContain('style:--corner-bl-h={`${cornerH}px`}');
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

	it('stands the corner credit on it where it stacks, with length fallbacks', () => {
		const css = read('src/app.css');
		const rule = /\n\.leaflet-container \.leaflet-bottom\.leaflet-right \{[^}]*\}/.exec(css)?.[0] ?? '';
		// The bottom-left column's own stance, mirrored: the same gap over the
		// foot, so the credit no longer sits flush on a strip as its caption.
		// Its fallbacks are the NOTAM Viewer's, which has no foot.
		expect(rule).toContain(
			'bottom: calc(var(--foot-b, 8px) + var(--map-foot-h, 0px) + min(var(--map-foot-h, 0px), 6px));',
		);
		const column = /\.corner-bl \{[^}]*\}/.exec(read('src/lib/components/MapView.svelte'))?.[0] ?? '';
		expect(column).toContain('bottom: calc(var(--foot-b) + var(--map-foot-h, 0px) + min(var(--map-foot-h, 0px), 6px));');
		expect(rule).toContain('right: max(8px, var(--sar, 0px));');
		expect(rule).toContain('left: 8px;');
		// A bare 0 fallback inside a calc drops the whole declaration.
		expect(rule).not.toMatch(/var\(--[a-z-]+, 0\)/);
		// Three stances: the two STACKED ones, the phone's included, stand on
		// the whole foot (a phone-only override once stood it on the radar
		// strip alone); the third keeps the corner beside the foot.
		const stances = [...css.matchAll(/\n[^\n{}]*\.leaflet-bottom[^{]*\{[^}]*\}/g)].map((m) => m[0]);
		expect(stances).toHaveLength(3);
		const stacked = stances.filter((s) => !s.includes('.credit-beside'));
		expect(stacked).toHaveLength(2);
		for (const s of stacked) {
			expect(s.replace(/\s+/g, ' ')).toContain('var(--foot-b, 8px) + var(--map-foot-h, 0px) + min(var(--map-foot-h, 0px), 6px)');
		}
		for (const s of stances) {
			expect(s).not.toMatch(/var\(--[a-z-]+, 0\)/);
		}
		// Never under the foot: making room there would move the strips
		// under a finger each time the credit is said and again when it folds.
		expect(css).not.toMatch(/\.map-wrap \.leaflet-container \.leaflet-bottom \{/);
	});

	it('stands the credit on the bottom-left column too on a phone, never the reverse', () => {
		// A phone's credit spans the map and covered the column's last line,
		// where the terrain legend annunciates the inhibit. The credit moves;
		// the column, which holds the undo chip, stands where it stood.
		const css = read('src/app.css');
		const phone = /:root\.mobile-ui \.leaflet-container \.leaflet-bottom\.leaflet-right \{[^}]*\}/.exec(css)?.[0] ?? '';
		expect(phone.replace(/\s+/g, ' ')).toContain(
			'bottom: calc( var(--foot-b, 8px) + var(--map-foot-h, 0px) + min(var(--map-foot-h, 0px), 6px) + var(--corner-bl-h, 0px) + min(var(--corner-bl-h, 0px), 6px) );',
		);
		const mapView = read('src/lib/components/MapView.svelte');
		expect(mapView).toContain('<div class="corner-bl" bind:offsetHeight={cornerH} bind:offsetWidth={cornerW}>');
		const column = /\.corner-bl \{[^}]*\}/.exec(mapView)?.[0] ?? '';
		expect(column).not.toContain('--corner-bl-h');
		expect(column).not.toMatch(/leaflet|credit/);
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

	it('keeps both corners beside it on a desktop map with room, the strips unmoved', () => {
		const mapView = read('src/lib/components/MapView.svelte');
		// What MapView measures, and what it decides with: never on a phone,
		// nothing while the foot is empty.
		const wrap = /<div\s+class="map-wrap"[^>]*>/.exec(mapView)?.[0] ?? '';
		expect(wrap).toContain('bind:clientWidth={mapW}');
		expect(wrap).toContain('class:corner-beside={cornerBesideFoot}');
		expect(wrap).toContain('class:credit-beside={creditBesideFoot}');
		expect(wrap).toContain('style:--foot-room={`${footRoomPx}px`}');
		expect(mapView).toMatch(/<div class="map-foot no-print"[^>]*bind:offsetWidth=\{footW\}/);
		expect(mapView).toContain(
			'const footRoomPx = $derived(!ui.isMobile && footH > 0 ? footRoom(mapW, footW, footInset) : 0);',
		);
		expect(mapView).toContain('const creditBesideFoot = $derived(footRoomPx > 0 && creditBeside(footRoomPx));');
		const column = mapView.slice(
			mapView.indexOf('const cornerBesideFoot = $derived.by('),
			mapView.indexOf('return cornerWasBeside;'),
		);
		expect(column).toMatch(/if \(ui\.isMobile\) \{\s*cornerWasBeside = false;/);
		expect(column).toMatch(/else if \(footH === 0\) \{[^}]*cornerWasBeside = true;/);
		expect(column).toContain('cornerWasBeside = columnBeside(cornerWasBeside, cornerW, footRoomPx);');

		// Beside, each stands on the strips' own baseline, and the credit's
		// box is the room, so it wraps there rather than reaching the strip.
		const besideColumn = /\.map-wrap\.corner-beside \.corner-bl \{[^}]*\}/.exec(mapView)?.[0] ?? '';
		expect(besideColumn).toContain('bottom: var(--foot-b);');
		expect(besideColumn).not.toContain('--map-foot-h');
		const css = read('src/app.css');
		const besideCredit =
			/\n\.map-wrap\.credit-beside \.leaflet-container \.leaflet-bottom\.leaflet-right \{[^}]*\}/.exec(css)?.[0] ?? '';
		expect(besideCredit).toContain('bottom: var(--foot-b, 8px);');
		expect(besideCredit).toContain('left: auto;');
		expect(besideCredit).toContain('width: var(--foot-room);');
		expect(besideCredit).not.toContain('--map-foot-h');
		// After the phone's stance, which it ties in specificity.
		expect(css.indexOf(besideCredit)).toBeGreaterThan(css.indexOf(':root.mobile-ui .leaflet-container .leaflet-bottom.leaflet-right {'));

		// The room is the arithmetic of the boxes as the CSS lays them out.
		const foot = /\.map-foot \{[^}]*\}/.exec(mapView)?.[0] ?? '';
		expect(foot).toContain(`left: ${FOOT_SIDE_PX}px;`);
		expect(foot).toContain(`right: calc(max(${FOOT_SIDE_PX}px, var(--sar, 0px)) + var(--foot-inset, 0px));`);
		const stacked = /\.corner-bl \{[^}]*\}/.exec(mapView)?.[0] ?? '';
		expect(stacked).toContain(`left: ${FOOT_SIDE_PX}px;`);
		expect(stacked).toContain(`min(var(--map-foot-h, 0px), ${FOOT_GAP_PX}px)`);
		expect(css).toContain(`right: max(${FOOT_SIDE_PX}px, var(--sar, 0px));`);
	});

	it('is what a fit keeps clear of, on both layouts', () => {
		const focus = read('src/lib/map/focus.ts');
		const fn = focus.slice(focus.indexOf('function chromeInsets('), focus.indexOf('export function fitBoundsClear('));
		expect(fn).toContain("querySelectorAll('.map-foot > *')");
		expect(fn).not.toContain('isMobile');
	});
});
