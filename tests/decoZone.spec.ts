/* The decoration paint's plain record of a row (map/decoZone.ts): what a
 * worker can be handed. Pins the flat lat / lon layout, the one resolution
 * of the spec and the label, the arcs only for the FIR comb with an EMPTY
 * list kept apart from none (every run internal against no arcs at all), and
 * the cache keyed by the row OBJECT, since a republished dataset can bring a
 * key back with new geometry. */

import { describe, expect, it } from 'vitest';
import type { Airspace } from '$lib/data/airspaces';
import { airspaceLabel, symbolFor } from '$lib/map/airspaceSymbology';
import { ringComplement } from '$lib/map/decoGeometry';
import { decoZoneOf } from '$lib/map/decoZone';

function row(over: Partial<Airspace> & { ring: [number, number][] }): Airspace {
	const lats = over.ring.map((v) => v[0]);
	const lons = over.ring.map((v) => v[1]);
	return {
		id: 'LFR45',
		key: 'LFR45|R 45',
		name: '45',
		type: 'R',
		airClass: '',
		subtype: '',
		source: 'fr',
		category: 'restricted',
		upper: null,
		workHr: '',
		area: 0.01,
		bbox: { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) },
		...over,
	} as unknown as Airspace;
}

const SQUARE: [number, number][] = [
	[48.7, 2.2],
	[48.7, 2.4],
	[48.9, 2.4],
	[48.9, 2.2],
];

describe('decoZoneOf', () => {
	it('flattens the ring as lat / lon pairs and resolves the spec and label once', () => {
		const a = row({ ring: SQUARE });
		const z = decoZoneOf(a);
		expect([...z.ring]).toEqual([48.7, 2.2, 48.7, 2.4, 48.9, 2.4, 48.9, 2.2]);
		expect(z.ring).toBeInstanceOf(Float64Array);
		expect(z.key).toBe(a.key);
		expect(z.area).toBe(a.area);
		expect(z.bbox).toEqual(a.bbox);
		expect(z.spec).toBe(symbolFor(a));
		expect(z.label).toEqual(airspaceLabel(a));
		expect(z.arcs).toBeNull();
		expect(z.internal).toBeNull();
	});

	it('is made once per row object, and anew for a new object under the same key', () => {
		const a = row({ ring: SQUARE });
		expect(decoZoneOf(a)).toBe(decoZoneOf(a));
		const republished = row({ ring: SQUARE.map(([lat, lon]) => [lat + 1, lon] as [number, number]) });
		expect(republished.key).toBe(a.key);
		expect(decoZoneOf(republished)).not.toBe(decoZoneOf(a));
		expect(decoZoneOf(republished).ring[0]).toBe(49.7);
	});

	it('carries a FIR comb row its arcs and internal chains, flat', () => {
		const arcs: [number, number][][] = [[SQUARE[0], SQUARE[1], SQUARE[2]]];
		const fir = row({ type: 'FIR', category: 'fir', id: 'LFFF', key: 'LFFF|PARIS', ring: SQUARE, arcs });
		expect(symbolFor(fir).marks?.kind).toBe('comb');
		const z = decoZoneOf(fir);
		expect(z.arcs?.map((a) => [...a])).toEqual([[48.7, 2.2, 48.7, 2.4, 48.9, 2.4]]);
		expect(z.internal?.map((a) => [...a])).toEqual(ringComplement(SQUARE, arcs).map((c) => c.flat()));
	});

	it('keeps an empty arc list apart from none: every run of the ring internal', () => {
		const fir = row({ type: 'FIR', category: 'fir', id: 'KZDC', key: 'KZDC|WASHINGTON', source: 'faa', ring: SQUARE, arcs: [] });
		const z = decoZoneOf(fir);
		expect(z.arcs).toEqual([]);
		expect(z.internal?.map((a) => [...a])).toEqual([[...SQUARE, SQUARE[0]].flat()]);
	});

	it('carries no arcs where the marks are not the comb, the only paint that reads them', () => {
		const arcs: [number, number][][] = [[SQUARE[0], SQUARE[1]]];
		const r = row({ ring: SQUARE, arcs });
		expect(symbolFor(r).marks?.kind).not.toBe('comb');
		expect(decoZoneOf(r).arcs).toBeNull();
		expect(decoZoneOf(r).internal).toBeNull();
	});
});
