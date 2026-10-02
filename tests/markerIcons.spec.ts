/* Pins for the NOTAM position-pin pictograms (markerIcons.ts): the seven
 * activity kinds render the official SIA artwork from activityGlyphData.ts
 * (the same outlines the airspace-deco layer paints), the obstacle / hazard
 * kinds keep their Material Design paths, and glyphless pins stay bare.
 * Shape fidelity of the artwork itself is pinned by airspaceGlyphs.spec.ts
 * and verified against the chart legend (docs/airspace-symbology.md). */

import { describe, it, expect, vi } from 'vitest';
import { GLYPH_ART, type ActivityGlyphKind } from '$lib/map/activityGlyphData';
import { positionIcon } from '$lib/map/markerIcons';

vi.mock('leaflet', () => ({
	default: {
		divIcon: (opts: Record<string, unknown>) => opts,
	},
}));

function html(icon: unknown): string {
	return (icon as { html: string }).html;
}

/** The nested pictogram fragment inside the pin, '' when the pin is bare. */
function glyphFragment(h: string): string {
	const m = h.match(/<svg x="4\.5"[^>]*>.*?<\/svg>/s);
	return m ? m[0] : '';
}

// classifyObstacle() kind -> official artwork, as bridged by markerIcons.
const ACTIVITY_PINS: Array<[string, ActivityGlyphKind]> = [
	['voltige', 'aerobatics'],
	['parachute', 'parachute'],
	['balloon', 'balloon'],
	['glider', 'glider'],
	['aeromodelisme', 'modelAircraft'],
	['paragliding', 'paraglider'],
	['drone', 'drone'],
	['ulm', 'ulm'],
];

describe('positionIcon activity pictograms', () => {
	it.each(ACTIVITY_PINS)('%s renders the official %s artwork', (kind, art) => {
		const frag = glyphFragment(html(positionIcon('psn', kind, true)));
		expect(frag).not.toBe('');
		// The exact traced path data, not a Material Design lookalike.
		for (const p of GLYPH_ART[art].parts) {
			expect(frag).toContain(`d="${p.d}"`);
		}
		// Interior holes need the even-odd rule to stay open.
		if (GLYPH_ART[art].parts.some((p) => p.eo)) {
			expect(frag).toContain('fill-rule="evenodd"');
		}
		// The unit-frame artwork never rides the MDI 24x24 box.
		expect(frag).not.toContain('viewBox="0 0 24 24"');
	});

	it('paints knockouts paper-white and floors hairline strokes', () => {
		const frag = glyphFragment(html(positionIcon('psn', 'paragliding', true)));
		expect(frag).toContain('fill="#fff"');
		const widths = [...frag.matchAll(/stroke-width="([\d.]+)"/g)].map((m) =>
			Number(m[1]),
		);
		expect(widths.length).toBeGreaterThan(0);
		// 0.8 css px at the pin's 16 px window is about 0.1 glyph units; the
		// artwork's 0.016-unit hairlines must be floored up to stay visible.
		for (const w of widths) {
			expect(w).toBeGreaterThanOrEqual(0.09);
		}
	});
});

describe('positionIcon non-activity pins', () => {
	it('keeps the Material Design art for obstacle kinds', () => {
		const frag = glyphFragment(html(positionIcon('psn', 'antenna', true)));
		expect(frag).toContain('viewBox="0 0 24 24"');
		expect(frag).toContain('d="M12 7.5C12.69');
	});

	it('draws a bare pin for unknown kinds and with type icons off', () => {
		expect(glyphFragment(html(positionIcon('psn', 'nonsense', true)))).toBe('');
		expect(glyphFragment(html(positionIcon('psn', '', true)))).toBe('');
		expect(glyphFragment(html(positionIcon('psn', 'voltige', false)))).toBe('');
	});

	it('keeps qualifier-line pins plain', () => {
		expect(glyphFragment(html(positionIcon('qualifierLine', 'voltige', true)))).toBe('');
	});

	it('badges stacked markers, collapsing counts past 9', () => {
		expect(html(positionIcon('psn', 'voltige', true, 2))).toContain('>2</text>');
		expect(html(positionIcon('psn', 'voltige', true, 12))).toContain('>9+</text>');
		expect(html(positionIcon('psn', 'voltige', true, 1))).not.toContain('<text');
	});
});
