/* What floats over the map, one family (app.css). The strips, the toast,
 * the chips, the readouts and Leaflet's own bar had four looks between
 * them: opaque or translucent, radius 4, 8 or 10,
 * a heavy shadow or none, and a fill a tap left behind on touch. The family
 * is defined ONCE in the shared sheet and the components wear it rather than
 * restating it, so a fifth look cannot creep back one component at a time.
 * Pinned at the source (the popupMenu.spec idiom), plus the zoom control's
 * retitle, which runs. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type L from 'leaflet';
import { retitleZoom } from '$lib/map/zoomControl';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const css = read('src/app.css');
const style = (p: string): string => {
	const src = read(p);
	return src.slice(src.indexOf('<style>'));
};
/** Every flat rule whose selector list is exactly `sel`. */
const rules = (sheet: string, sel: string): string[] =>
	[...sheet.matchAll(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`, 'g'))].map((m) => m[0]);

describe('the family, defined once in the shared sheet', () => {
	it('raised boxes take a finger and carry the shadow, flat ones carry none', () => {
		const bar = rules(css, '.map-bar');
		const chip = rules(css, '.foot-chip');
		const readout = rules(css, '.map-readout');
		expect([bar.length, chip.length, readout.length]).toEqual([1, 1, 1]);
		for (const r of [bar[0], chip[0]]) {
			expect(r).toContain('box-shadow: var(--shadow-1);');
			expect(r).toContain('border: 1px solid var(--border-strong);');
			expect(r).toContain('background: color-mix(in srgb, var(--surface) 92%, transparent);');
		}
		expect(readout[0]).not.toContain('box-shadow');
		expect(readout[0]).toContain('pointer-events: none;');
		expect(readout[0]).toContain('background: color-mix(in srgb, var(--surface) 88%, transparent);');
		expect(bar[0]).toContain('pointer-events: none;');
		expect(css).toMatch(/\.map-bar :is\(button, input\) \{\s*pointer-events: auto;\s*\}/);
	});

	it('fills a control on hover only where there is a hover', () => {
		expect(css).toMatch(/\.map-bar \.icon-btn:hover \{\s*background: transparent;\s*\}/);
		expect(css).toMatch(/@media \(hover: hover\) \{\s*\.map-bar \.icon-btn:hover:not\(:disabled\) \{/);
		expect(css).toMatch(/@media \(hover: hover\) \{\s*:root \.leaflet-bar a:hover \{/);
		expect(css).toMatch(/:root\.touch-ui \.map-bar \.text-btn \{\s*min-width: 44px;\s*min-height: 44px;\s*\}/);
	});

	it('is worn by the strips, the toast and the readouts, never restated', () => {
		// [file, the markup's class list, the root rule's selector]
		const wearers: [string, string, string][] = [
			['src/lib/components/RadarTimeline.svelte', 'class="radar-strip map-bar no-print"', '.radar-strip'],
			['src/lib/components/ReplayStrip.svelte', 'class="replay-strip map-bar no-print"', '.replay-strip'],
			['src/lib/components/UndoChip.svelte', 'class="undo-chip map-bar"', '.undo-chip'],
			['src/lib/components/TerrainLegend.svelte', 'class="terrain-legend map-readout no-print"', '.terrain-legend'],
			['src/lib/components/CursorCoords.svelte', 'class="badge map-readout"', '.badge'],
		];
		for (const [p, cls, sel] of wearers) {
			expect(read(p), p).toContain(cls);
			const root = rules(style(p), `\t${sel}`);
			expect(root.length, p).toBeGreaterThan(0);
			for (const r of root) {
				expect(r, p).not.toMatch(/box-shadow:|background:|border(?:-radius)?:|color: var\(--text\)/);
			}
			// No per-theme copy of a background the family's tokens carry.
			expect(style(p), p).not.toMatch(/\[data-theme="(?:dark|night)"\]\) \./);
		}
		expect(read('src/lib/components/UndoChip.svelte')).not.toContain('class="btn');
		expect(read('src/lib/components/ReplayStrip.svelte')).toContain('class="text-btn speed"');
		expect(read('src/lib/components/phone/MapButtons.svelte')).toContain('border-radius: var(--radius);');
	});
});

describe("Leaflet's bar", () => {
	it('wears the family in every theme, no night-only copy', () => {
		const bar = rules(css, ':root .leaflet-bar,\n:root .leaflet-touch .leaflet-bar');
		expect(bar).toHaveLength(1);
		expect(bar[0]).toContain('border-radius: var(--radius);');
		expect(bar[0]).toContain('box-shadow: var(--shadow-1);');
		expect(css).not.toMatch(/\[data-theme="night"\] \.leaflet-bar a/);
	});

	it('gives every bar control the touch floor, the recentre control included', () => {
		expect(css).toMatch(/:root\.touch-ui \.leaflet-bar a \{\s*width: 44px;\s*height: 44px;/);
		expect(css).not.toContain(':root.touch-ui .leaflet-control-zoom.leaflet-bar a');
	});
});

describe('the zoom control on a locale change', () => {
	function fakeZoom() {
		const attrs: Record<string, Record<string, string>> = {
			'.leaflet-control-zoom-in': {},
			'.leaflet-control-zoom-out': {},
		};
		const box = {
			querySelector: (sel: string) =>
				sel in attrs
					? {
							setAttribute: (k: string, v: string) => {
								attrs[sel][k] = v;
							},
						}
					: null,
		};
		const ctl = { options: { zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }, getContainer: () => box };
		return { ctl: ctl as unknown as L.Control.Zoom, attrs };
	}

	it('rewrites its two titles in place', () => {
		const { ctl, attrs } = fakeZoom();
		retitleZoom(ctl, { zoomInTitle: 'Zoom avant', zoomOutTitle: 'Zoom arrière' });
		expect(attrs['.leaflet-control-zoom-in']).toEqual({ title: 'Zoom avant', 'aria-label': 'Zoom avant' });
		expect(attrs['.leaflet-control-zoom-out']).toEqual({ title: 'Zoom arrière', 'aria-label': 'Zoom arrière' });
		expect(ctl.options.zoomInTitle).toBe('Zoom avant');
		expect(ctl.options.zoomOutTitle).toBe('Zoom arrière');
	});

	it('is built once per map, so it never lands under the recentre control', () => {
		const map = read('src/lib/components/MapView.svelte');
		const fx = map.slice(map.indexOf('const titles = { zoomInTitle: t.map.zoomIn'), map.indexOf('zoomCtlMap = m;'));
		expect(fx).toMatch(/if \(zoomCtl && zoomCtlMap === m\) \{\s*retitleZoom\(zoomCtl, titles\);\s*return;\s*\}\s*zoomCtl\?\.remove\(\);/);
	});
});
