/* How far the vector overlays draw beyond the screen (map/svgPadding.ts), on
 * Leaflet itself in Node. What it pins:
 *   - every SVG renderer draws half the viewport beyond each side once
 *     padSvgRenderers has run, the one Leaflet makes for a pane on its own as
 *     one a layer names, made before the call or after; a canvas renderer
 *     keeps Leaflet's tenth;
 *   - both map views call it before they make their map. */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installLeafletNode } from './helpers/leafletNode';

installLeafletNode();
const L = (await import('leaflet')).default;
const { padSvgRenderers, SVG_PADDING } = await import('$lib/map/svgPadding');

describe('padSvgRenderers', () => {
	it('gives every SVG renderer half the viewport beyond each side, and no canvas one', () => {
		// The classes themselves: Leaflet's L.svg() factory answers null
		// where the platform has no SVG, as Node has not.
		const before = new L.SVG({ pane: 'route' });
		padSvgRenderers();
		expect(SVG_PADDING).toBe(0.5);
		expect(new L.SVG({ pane: 'notams' }).options.padding).toBe(SVG_PADDING);
		expect(new L.SVG().options.padding).toBe(SVG_PADDING);
		expect(before.options.padding).toBe(SVG_PADDING);
		expect(new L.Canvas().options.padding).toBe(0.1);
	});

	it('runs in both map views before their map is made', () => {
		for (const view of ['MapView.svelte', 'NotamMapView.svelte']) {
			const src = fs.readFileSync(path.join('src/lib/components', view), 'utf8');
			const pad = src.indexOf('padSvgRenderers();');
			const map = src.indexOf('L.map(');
			expect(pad, view).toBeGreaterThan(0);
			expect(pad, view).toBeLessThan(map);
		}
	});
});
