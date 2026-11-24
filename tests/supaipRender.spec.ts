/* Corpus-driven SUP AIP rendering audit: every zone of the committed
 * fr-supaip.json (2026 onward, the corpus the cmd/supaip audit covers) is
 * pushed through the loader and makeSupGeometryLayer with an
 * argument-capturing Leaflet mock, so the exact shapes the map would draw are
 * pinned against the dataset: a polygon carries its whole ring, a
 * multipolygon one polygon per ring (never holes), a circle its exact metre
 * radius; a by-reference zone (sameAs) carries no geometry and never reaches
 * the layer, and the structural invariants (ring size, radius, bbox
 * presence) hold for every zone. Each supplement's zone count is pinned on
 * its own (tests/fixtures/supaip-zones.json). */

import { beforeAll, describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';

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

import { ES_SUPAIP_URL, loadSupAip, SUPAIP_URL, type SupAip } from '$lib/data/supaip';
import { makeSupGeometryLayer } from '$lib/map/supaipLayer';

const PIN = new URL('./fixtures/supaip-zones.json', import.meta.url);

/** A supplement's zones, and those of them published by reference alone
 *  (sameAs, no geometry of their own). */
type ZoneCount = [zones: number, byReference: number];

/** Each 2026 supplement's ZoneCount, by id. */
function zonePin(list: SupAip[]): Record<string, ZoneCount> {
	const out: Record<string, ZoneCount> = {};
	for (const s of list) {
		if (s.year >= 2026) {
			out[s.id] = [s.zones.length, s.zones.filter((z) => z.sameAs && !z.geometry).length];
		}
	}
	return out;
}

/** The pin's file: one supplement a line, by id. */
function renderPin(pin: Record<string, ZoneCount>): string {
	const lines = Object.keys(pin)
		.sort()
		.map((id) => `  ${JSON.stringify(id)}: [${pin[id][0]}, ${pin[id][1]}]`);
	return `{\n${lines.join(',\n')}\n}\n`;
}

const realFetch = globalThis.fetch;
let sups: SupAip[] = [];
let esSups: SupAip[] = [];

// Both committed files through the app's own loader. One fetch stub answers
// each URL with its own file off disk, and stands for the two loads alone.
beforeAll(async () => {
	vi.stubGlobal('fetch', (url: string) =>
		Promise.resolve(
			new Response(readFileSync(new URL(`../public${url}`, import.meta.url), 'utf-8'), {
				headers: { 'content-type': 'application/json' },
			}),
		),
	);
	try {
		[sups, esSups] = await Promise.all([loadSupAip(SUPAIP_URL), loadSupAip(ES_SUPAIP_URL)]);
	} finally {
		vi.unstubAllGlobals();
	}
});

describe('the corpus loads', () => {
	it('leaves fetch as it found it', () => {
		expect(globalThis.fetch).toBe(realFetch);
	});
});

describe('SUP AIP corpus rendering (2026 onward)', () => {
	it('draws every zone as exactly its stated shape', () => {
		const recent = sups.filter((s) => s.year >= 2026);
		expect(recent.length).toBeGreaterThan(150);
		for (const sup of recent) {
			for (const z of sup.zones) {
				if (z.sameAs) {
					// A by-reference zone states designators; usually it has
					// no coordinates of its own (135/2026's ZRT 34 prints
					// both, and both are kept).
					expect(z.sameAs).toMatch(/^(LF-[RDPT]|TRA|CBA)/);
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
	});

	// Each supplement's zones, and those of them published by reference
	// alone, pinned per supplement against tests/fixtures/supaip-zones.json:
	// a rebuild moves the pin only where it adds, drops or re-reads a row,
	// and the failure names every row that moved. Once each is checked
	// against its PDF, rewrite the pin with
	//
	//	UPDATE_SUPAIP_PIN=1 npm test -- tests/supaipRender.spec.ts
	//
	// and commit it with the data.
	it('moves each supplement\'s zone count only with the data', () => {
		const got = zonePin(sups);
		if (process.env.UPDATE_SUPAIP_PIN) {
			writeFileSync(PIN, renderPin(got));
		}
		const want = JSON.parse(readFileSync(PIN, 'utf-8')) as Record<string, ZoneCount>;
		const moved = [...new Set([...Object.keys(want), ...Object.keys(got)])]
			.sort()
			.filter((id) => JSON.stringify(want[id]) !== JSON.stringify(got[id]))
			.map((id) => `${id}: ${JSON.stringify(want[id] ?? null)} -> ${JSON.stringify(got[id] ?? null)}`);
		expect(moved, 'UPDATE_SUPAIP_PIN=1 npm test -- tests/supaipRender.spec.ts').toEqual([]);
	});

	it('keeps every ring inside its own bbox', () => {
		for (const sup of sups.filter((s) => s.year >= 2026)) {
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

describe('ES SUP AIP corpus (cmd/es)', () => {
	it('draws every zone as exactly its stated shape', () => {
		expect(esSups.length).toBeGreaterThan(150);
		let zones = 0;
		for (const sup of esSups) {
			expect(sup.region).toBe('es');
			for (const z of sup.zones) {
				zones++;
				expect(z.geometry).not.toBeNull();
				expect(z.bbox).not.toBeNull();
				const g = z.geometry;
				if (g === null) {
					continue;
				}
				polygons.length = 0;
				circles.length = 0;
				makeSupGeometryLayer(g, {});
				if (g.type === 'polygon') {
					expect(g.ring.length).toBeGreaterThanOrEqual(4);
					expect(g.ring[0]).toEqual(g.ring[g.ring.length - 1]);
					expect(polygons).toHaveLength(1);
					expect(polygons[0].latlngs).toEqual(g.ring);
				} else if (g.type === 'multipolygon') {
					expect(polygons).toHaveLength(1);
					expect(polygons[0].latlngs).toEqual(g.rings.map((r) => [r]));
				} else {
					expect(g.radiusM).toBeGreaterThan(0);
					expect(circles).toHaveLength(1);
					expect(circles[0].radius).toBe(g.radiusM);
				}
			}
		}
		// The corpus size, moved only with a verified dataset change.
		expect(zones).toBeGreaterThan(400);
	});

	it('keeps every vertex inside Spain and inside its own bbox', () => {
		for (const sup of esSups) {
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
					// A vertex outside Spanish territory would be a misread
					// column or a swapped pair.
					expect(lat).toBeGreaterThan(27);
					expect(lat).toBeLessThan(45);
					expect(lon).toBeGreaterThan(-19);
					expect(lon).toBeLessThan(5);
					expect(lat).toBeGreaterThanOrEqual(b.minLat - 1e-6);
					expect(lat).toBeLessThanOrEqual(b.maxLat + 1e-6);
					expect(lon).toBeGreaterThanOrEqual(b.minLon - 1e-6);
					expect(lon).toBeLessThanOrEqual(b.maxLon + 1e-6);
				}
			}
		}
	});

	it('carries the local subject, both editions and a parseable validity', () => {
		// A supplement with no end date, so the pin outlives the cycle it
		// was taken in: 101/2026's four turbines of Montes de Cierzo I.
		const farm = esSups.find((s) => s.number === 101 && s.year === 2026);
		expect(farm).toBeDefined();
		// descriptionFr is the LOCAL-language slot: Spanish here.
		expect(farm!.descriptionFr).toContain('Parque Eólico');
		expect(farm!.descriptionEn).not.toBe('');
		expect(farm!.urlPdf).toMatch(/LE_SUP_A_2026_101_es\.pdf$/);
		expect(farm!.urlPdfEn).toMatch(/_en\.pdf$/);
		expect(farm!.zones).toHaveLength(4);
		// The SPA hides a zone whose validity does not parse, so an EST
		// end date must still be a plain ISO day.
		for (const s of esSups) {
			if (s.validFrom !== null) {
				expect(s.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
			if (s.validTo !== null) {
				expect(s.validTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			}
		}
	});
});
