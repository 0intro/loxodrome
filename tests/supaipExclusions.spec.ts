// A SUP zone's exclusion sectors on the map and in the panel: how a sector
// sits in its zone's band (data/supaip.ts exclusionSpan), the hole a sector
// through the whole band cuts in the drawn zone (map/supaipLayer.ts
// makeSupZoneLayer) and in the click and menu hit tests (supaipZonesAt), and
// the panel's words.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { excludedDesignator, exclusionSpan, type SupAipExclusion, type SupAipZone } from '$lib/data/supaip';
import { ensureSupaip, supaipById } from '$lib/state/data.svelte';
import { supaipZonesAt } from '$lib/state/supaip.svelte';
import { makeSupZoneLayer } from '$lib/map/supaipLayer';
import { fromTriple, type VerticalLimit } from '$lib/vertical/limits';
import { en } from '$lib/i18n/en';
import { fr } from '$lib/i18n/fr';

const polygons: unknown[] = [];

vi.mock('leaflet', () => {
	const layer = () => ({ addTo: () => layer() });
	return {
		default: {
			polygon: (latlngs: unknown) => {
				polygons.push(latlngs);
				return layer();
			},
			circle: () => layer(),
			layerGroup: () => ({ addLayer: () => {}, clearLayers: () => {} }),
		},
	};
});

const SFC: VerticalLimit = ['HEI', '0', 'FT'];
const ALT_2500: VerticalLimit = ['ALT', '2500', 'FT'];

const RING: [number, number][] = [
	[48.3, -5.2],
	[48.3, -4.8],
	[48.6, -4.8],
	[48.6, -5.2],
];

function sector(lower: VerticalLimit, upper: VerticalLimit): SupAipExclusion {
	return {
		name: 'OUESSANT',
		geometry: { type: 'circle', center: [48.45, -5.0], radiusM: 5556 },
		bbox: { minLat: 48.4, minLon: -5.08, maxLat: 48.5, maxLon: -4.92 },
		lower,
		upper,
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
		hours: [],
	};
}

function zone(lower: VerticalLimit, upper: VerticalLimit, exclusions: SupAipExclusion[]): SupAipZone {
	return {
		name: 'ZRT CORSEN',
		geometry: { type: 'polygon', ring: RING },
		bbox: { minLat: 48.3, minLon: -5.2, maxLat: 48.6, maxLon: -4.8 },
		lower,
		upper,
		vLower: fromTriple(lower),
		vUpper: fromTriple(upper),
		geometrySource: 'pdf-polygon',
		activations: [],
		sameAs: '',
		exclusions,
		excluded: [],
		standing: [],
	};
}

describe('exclusionSpan', () => {
	it('reads how a sector sits in its zone band, whatever the ground', () => {
		const ouessant = sector(SFC, ALT_2500);
		// 077/2026: CORSEN C1 from the surface to 2500 ft like its sector,
		// C2 from 2500 ft up.
		expect(exclusionSpan(zone(SFC, ALT_2500, []), ouessant)).toBe('through');
		expect(exclusionSpan(zone(ALT_2500, ['STD', '095', 'FL'], []), ouessant)).toBe('beside');
		// 228/2026: a sector to 1500 ft above the surface in a zone to FL 115.
		expect(exclusionSpan(zone(SFC, ['STD', '115', 'FL'], []), sector(SFC, ['HEI', '1500', 'FT']))).toBe(
			'within',
		);
		// A sector's top above the surface beside a zone's top on the same
		// ground: the ground under it decides, so the sector stays within.
		expect(exclusionSpan(zone(SFC, ['HEI', '1500', 'FT'], []), sector(SFC, ['HEI', '1500', 'FT']))).toBe(
			'within',
		);
		expect(exclusionSpan(zone(['ALT', '3000', 'FT'], ['STD', '095', 'FL'], []), ouessant)).toBe('beside');
	});
});

describe('makeSupZoneLayer', () => {
	it('cuts a hole where a sector goes through the zone band', () => {
		polygons.length = 0;
		makeSupZoneLayer(zone(SFC, ALT_2500, [sector(SFC, ALT_2500)]), {});
		const [rings] = polygons[0] as [number, number][][][];
		expect(rings).toHaveLength(2);
		expect(rings[0]).toEqual(RING);
		expect(rings[1]).toHaveLength(64);
		polygons.length = 0;
		makeSupZoneLayer(zone(SFC, ['STD', '115', 'FL'], [sector(SFC, ['HEI', '1500', 'FT'])]), {});
		expect(polygons).toEqual([RING]);
	});

	it('cuts the ring of a multipolygon zone holding the sector', () => {
		polygons.length = 0;
		const z = zone(SFC, ALT_2500, [sector(SFC, ALT_2500)]);
		const far: [number, number][] = [
			[47.0, -3.0],
			[47.0, -2.8],
			[47.2, -2.8],
		];
		z.geometry = { type: 'multipolygon', rings: [far, RING] };
		makeSupZoneLayer(z, {});
		const shapes = polygons[0] as [number, number][][][];
		expect(shapes.map((rings) => rings.length)).toEqual([1, 2]);
		expect(shapes[1][0]).toEqual(RING);
	});

	it('cuts it in a circle zone too, set as a ring', () => {
		polygons.length = 0;
		const z = zone(SFC, ALT_2500, [sector(SFC, ALT_2500)]);
		z.geometry = { type: 'circle', center: [48.45, -5.0], radiusM: 20000 };
		makeSupZoneLayer(z, {});
		const [rings] = polygons[0] as [number, number][][][];
		expect(rings.map((r) => r.length)).toEqual([64, 64]);
	});
});

describe('supaipZonesAt over a sector', () => {
	const raw = (name: string, upper: VerticalLimit, excl: VerticalLimit) => ({
		name,
		geometry: { type: 'polygon', ring: RING },
		bbox: [48.3, -5.2, 48.6, -4.8],
		lower: SFC,
		upper,
		geometrySource: 'pdf-polygon',
		activations: [],
		exclusions: [
			{
				name: 'OUESSANT',
				geometry: { type: 'circle', center: [48.45, -5.0], radiusM: 5556 },
				bbox: [48.4, -5.08, 48.5, -4.92],
				lower: SFC,
				upper: excl,
			},
		],
	});
	const c1 = {
		...raw('ZRT CORSEN C1', ALT_2500, ALT_2500),
		excluded: [{ id: 'LFR13A1', whenActive: true }, { zone: 'ZRT CORSEN C3' }, {}],
	};
	const row = [
		'metropole-2026-077', '077/2026', 'metropole', '', '', '', '', '2026-01-01', '2026-12-31',
		false, true, false, [], [],
		[c1, raw('ZRT CORSEN C3', ['STD', '115', 'FL'], ['HEI', '1500', 'FT'])],
		[48.3, -5.2, 48.6, -4.8], 'pdf-polygon', 'high', [], '', [], null, '',
	];

	beforeAll(async () => {
		vi.stubGlobal('fetch', (url: unknown) =>
			Promise.resolve(
				new Response(JSON.stringify({ fields: [], rows: String(url).includes('fr-supaip') ? [row] : [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
			),
		);
		await ensureSupaip();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-10T12:00:00Z'));
	});

	afterAll(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('reads the airspaces a zone excludes, a zone without any none', () => {
		const zones = supaipById('metropole-2026-077')?.zones ?? [];
		expect(zones.map((z) => z.excluded)).toEqual([
			[
				{ id: 'LFR13A1', zone: undefined, whenActive: true },
				{ id: undefined, zone: 'ZRT CORSEN C3', whenActive: false },
			],
			[],
		]);
	});

	it('finds no zone where a sector goes through its whole band', () => {
		const names = (lat: number, lon: number) => supaipZonesAt(lat, lon).map((it) => it.zone.name);
		expect(names(48.45, -5.0)).toEqual(['ZRT CORSEN C3']);
		expect(names(48.35, -4.85)).toEqual(['ZRT CORSEN C1', 'ZRT CORSEN C3']);
	});
});

describe('the panel words an excluded airspace', () => {
	it('by its designator, in both languages', () => {
		expect(excludedDesignator('LFR13A1', { type: 'R', name: '13 A1' })).toBe('LF-R 13 A1');
		expect(excludedDesignator('LFP047', null)).toBe('LF-P047');
		expect([en.detail.zoneExceptLead, en.detail.zoneExceptWhileActive(2)]).toEqual(['Except', 'while active']);
		expect([fr.detail.zoneExceptLead, fr.detail.zoneExceptWhileActive(1)]).toEqual([
			'Sauf',
			'lorsqu’elle est active',
		]);
		expect(fr.detail.zoneExceptWhileActive(2)).toBe('lorsqu’elles sont actives');
	});
});

describe('the panel words a sector', () => {
	it('in both languages', () => {
		expect(en.detail.zoneExcept('Séderon', 'SFC – 1500 ft ASFC, SR - SS')).toBe(
			'Except Séderon: SFC – 1500 ft ASFC, SR - SS',
		);
		expect(fr.detail.zoneExcept('Séderon', 'SFC – 1500 ft ASFC, SR - SS')).toBe(
			'Sauf Séderon : SFC – 1500 ft ASFC, SR - SS',
		);
	});
});
