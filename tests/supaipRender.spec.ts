/* Corpus-driven SUP AIP rendering audit: every zone of the committed
 * fr-supaip.json (2026 onward, the corpus the cmd/supaip audit covers) is
 * pushed through the loader and makeSupGeometryLayer with an
 * argument-capturing Leaflet mock, so the exact shapes the map would draw are
 * pinned against the dataset: a polygon carries its whole ring, a
 * multipolygon one polygon per ring (never holes), a circle its exact metre
 * radius; a by-reference zone (sameAs) carries no geometry and never reaches
 * the layer, and the structural invariants (ring size, radius, bbox
 * presence) hold for every zone. */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

interface CapturedPolygon {
	latlngs: unknown;
}
const polygons: CapturedPolygon[] = [];
const circles: Array<{ center: [number, number]; radius: number }> = [];

vi.mock('leaflet', () => {
	const layer = () => ({
		addTo: () => layer(),
		on: () => layer(),
		remove: () => layer(),
		setStyle: () => layer(),
	});
	return {
		default: {
			polygon: (latlngs: unknown) => {
				polygons.push({ latlngs });
				return layer();
			},
			circle: (center: [number, number], opts: { radius: number }) => {
				circles.push({ center, radius: opts.radius });
				return layer();
			},
			layerGroup: () => ({ addLayer: () => {}, clearLayers: () => {}, remove: () => {} }),
		},
	};
});

import { loadSupAip, type SupAip } from '$lib/data/supaip';
import { makeSupGeometryLayer } from '$lib/map/supaipLayer';

async function loadCommitted(): Promise<SupAip[]> {
	const raw = readFileSync(
		new URL('../public/data/fr-supaip.json', import.meta.url),
		'utf-8',
	);
	const orig = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(
			new Response(raw, {
				headers: { 'content-type': 'application/json' },
			}),
		);
	try {
		return await loadSupAip();
	} finally {
		globalThis.fetch = orig;
	}
}

const supsPromise = loadCommitted();

describe('SUP AIP corpus rendering (2026 onward)', () => {
	it('draws every zone as exactly its stated shape', async () => {
		const sups = (await supsPromise).filter((s) => s.year >= 2026);
		expect(sups.length).toBeGreaterThan(150);
		let zones = 0;
		let refZones = 0;
		for (const sup of sups) {
			for (const z of sup.zones) {
				zones++;
				if (z.sameAs) {
					// A by-reference zone states designators; usually it has
					// no coordinates of its own (135/2026's ZRT 34 prints
					// both, and both are kept).
					expect(z.sameAs).toMatch(/^(LF-[RDPT]|TRA|CBA)/);
					if (!z.geometry) {
						refZones++;
						continue;
					}
				}
				if (!z.geometry) {
					continue;
				}
				expect(z.bbox).not.toBeNull();
				polygons.length = 0;
				circles.length = 0;
				makeSupGeometryLayer(z.geometry, {});
				const g = z.geometry;
				if (g.type === 'polygon') {
					expect(g.ring.length).toBeGreaterThanOrEqual(3);
					expect(polygons).toHaveLength(1);
					expect(polygons[0].latlngs).toEqual(g.ring);
				} else if (g.type === 'multipolygon') {
					expect(g.rings.length).toBeGreaterThanOrEqual(2);
					for (const r of g.rings) {
						expect(r.length).toBeGreaterThanOrEqual(3);
					}
					expect(polygons).toHaveLength(1);
					// One polygon per ring, never a hole: ring N is the sole
					// outer ring of polygon N.
					expect(polygons[0].latlngs).toEqual(g.rings.map((r) => [r]));
				} else {
					expect(g.radiusM).toBeGreaterThan(0);
					expect(circles).toHaveLength(1);
					expect(circles[0].radius).toBe(g.radiusM);
					expect(circles[0].center).toEqual(g.center);
				}
			}
		}
		// The 2026 corpus size, moved only with a verified dataset change
		// (the 2026-08 audit landed 668 zones, 18 of them purely by
		// reference; the 159/2025 fused-row fix then recovered 006/2026's
		// ZRT BIZERTE and one more ORION26 zone; the 2026-08-21 refresh
		// added supplements 178 to 184, pac-p 004 and run 002, nine new
		// ones carrying 52 zones between them, none by reference, and the
		// media-store sharding fix let pac-p 003 (MARARA26) be re-read
		// from its PDF, taking it from the one ZRT HAO polygon to that
		// plus the MAKEMO ALPHA / BRAVO and KATIU circles).
		expect(zones).toBe(725);
		expect(refZones).toBe(18);
	});

	it('keeps every ring inside its own bbox', async () => {
		const sups = (await supsPromise).filter((s) => s.year >= 2026);
		for (const sup of sups) {
			for (const z of sup.zones) {
				const g = z.geometry;
				const b = z.bbox;
				if (!g || !b) {
					continue;
				}
				const pts =
					g.type === 'polygon'
						? g.ring
						: g.type === 'multipolygon'
							? g.rings.flat()
							: [g.center];
				for (const [lat, lon] of pts) {
					expect(lat).toBeGreaterThanOrEqual(b.minLat - 1e-6);
					expect(lat).toBeLessThanOrEqual(b.maxLat + 1e-6);
					expect(lon).toBeGreaterThanOrEqual(b.minLon - 1e-6);
					expect(lon).toBeLessThanOrEqual(b.maxLon + 1e-6);
				}
			}
		}
	});
});
