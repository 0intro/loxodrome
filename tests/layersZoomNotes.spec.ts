/* The Layers tab's "Visible at zoom N and above" notes, read off the
 * sources (the phoneLandscape.spec.ts idiom). The nature zones' note said 7
 * after their layer moved to the glyph gate (8), so at zoom 7 a pilot read
 * an empty map as no park or bird area in view. The note now passes the
 * layer's own gate. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

/** The fieldset of the Layers tab whose legend reads `legend`. */
function fieldset(legend: string): string {
	const tab = read('src/lib/components/tabs/LayersTab.svelte');
	const at = tab.indexOf(`<legend>${legend}</legend>`);
	expect(at, legend).toBeGreaterThan(0);
	return tab.slice(at, tab.indexOf('</fieldset>', at));
}

describe('the nature zones note', () => {
	it('states the zoom the layer draws from', () => {
		const layer = read('src/lib/map/natureLayer.ts');
		expect(layer).toContain('export const NATURE_MIN_ZOOM = GATE_GLYPH;');
		expect(layer).toContain('bulkVisible: (zoom) => zoom >= NATURE_MIN_ZOOM,');
		expect(fieldset('{t.layers.natureLegend}')).toContain(
			'<p class="muted">{t.layers.visibleFromZoom(NATURE_MIN_ZOOM)}</p>',
		);
	});
});
