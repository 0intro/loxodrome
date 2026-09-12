/* Pins what the map frames when centring on one NOTAM: the drawn extent,
 * radius circles included, capped so a small entry keeps its surroundings,
 * and the wider cap for an entry that draws nothing but its pin (whose box
 * is a point, so the cap is the zoom).
 * Leaflet is mocked (it touches `window` at import); focusNotam and
 * fitToNotams build plain bounds arrays, so an empty stub is enough, and
 * the real map/focus.ts runs on top of a map stub. The state modules stay
 * real: notamLayer imports selectNotam from ui.svelte, and in this node
 * environment `document` is undefined, so the panel inset is zero. */

import { describe, expect, it, vi } from 'vitest';
import type L from 'leaflet';
import type { Notam, NotamCoordinate } from '$lib/notam/types';
import { NM_TO_METERS } from '$lib/notam/units';
import { FIR_WIDE_RADIUS_NM, M_PER_DEG } from '$lib/notam/geometry';

vi.mock('leaflet', () => ({ default: {} }));

import { fitToNotams, focusNotam } from '$lib/map/notamLayer';

type Bounds = [[number, number], [number, number]];
interface FitOptions {
	paddingTopLeft: [number, number];
	paddingBottomRight: [number, number];
	maxZoom?: number;
}

/** A map stub recording the flight it is asked for. */
function fakeMap(zoom = 8) {
	const flyToBounds = vi.fn<(b: Bounds, o: FitOptions) => void>();
	const fitBounds = vi.fn<(b: Bounds, o: FitOptions) => void>();
	const map = {
		getZoom: () => zoom,
		getSize: () => ({ x: 800, y: 600 }),
		flyToBounds,
		fitBounds,
	} as unknown as L.Map;
	return { map, flyToBounds, fitBounds };
}

function coord(
	type: 'psn' | 'qualifierLine',
	lat: number,
	lon: number,
	radius?: number,
): NotamCoordinate {
	return {
		lat,
		lon,
		original: '',
		type,
		...(radius != null ? { radius, radiusUnit: 'NM' as const } : {}),
	};
}

function entry(over: Partial<Notam>): Notam {
	return {
		id: 'A0001/26',
		icaoCodes: ['LFFF'],
		qCode: 'QWULW',
		isPolygon: false,
		coordinates: [],
		qualifier: null,
		...over,
	} as unknown as Notam;
}

const PAD_10NM_DEG = (10 * NM_TO_METERS) / M_PER_DEG;

describe('focusNotam', () => {
	it('frames a position with its radius circle, not the bare point', () => {
		const { map, flyToBounds } = fakeMap();
		focusNotam(map, entry({ coordinates: [coord('psn', 48, 2, 10)] }));
		const [bounds, opts] = flyToBounds.mock.calls[0];
		expect(bounds[0][0]).toBeCloseTo(48 - PAD_10NM_DEG, 6);
		expect(bounds[1][0]).toBeCloseTo(48 + PAD_10NM_DEG, 6);
		expect(opts).toEqual({
			paddingTopLeft: [40, 40],
			paddingBottomRight: [40, 40],
			maxZoom: 13,
		});
	});

	it('frames a ring at the extent cap', () => {
		const { map, flyToBounds } = fakeMap();
		focusNotam(
			map,
			entry({
				isPolygon: true,
				coordinates: [
					coord('psn', 48, 2),
					coord('psn', 48.1, 2),
					coord('psn', 48.1, 2.1),
				],
			}),
		);
		expect(flyToBounds.mock.calls[0][1].maxZoom).toBe(13);
	});

	it('frames a radius-less position wider, its box being a point', () => {
		const { map, flyToBounds } = fakeMap();
		focusNotam(map, entry({ coordinates: [coord('psn', 48, 2)] }));
		expect(flyToBounds.mock.calls[0][1].maxZoom).toBe(11);
	});

	it('caps the zoom the same however far the map is zoomed in', () => {
		const { map, flyToBounds } = fakeMap(16);
		focusNotam(map, entry({ coordinates: [coord('psn', 48, 2)] }));
		expect(flyToBounds.mock.calls[0][1].maxZoom).toBe(11);
	});

	it('centres a whole-FIR entry instead of framing its 999 NM circle', () => {
		const { map, flyToBounds } = fakeMap();
		focusNotam(
			map,
			entry({
				coordinates: [coord('qualifierLine', 48, 2, FIR_WIDE_RADIUS_NM)],
			}),
		);
		const [bounds, opts] = flyToBounds.mock.calls[0];
		expect(bounds[1][0]).toBeCloseTo(48 + 1e-4, 8);
		// The sentinel circle is not drawn either, so nothing is framed.
		expect(opts.maxZoom).toBe(11);
	});

	it('moves nothing for an entry with no coordinates', () => {
		const { map, flyToBounds } = fakeMap();
		focusNotam(map, entry({}));
		expect(flyToBounds).not.toHaveBeenCalled();
	});
});

describe('fitToNotams', () => {
	it('unions the drawn extents, whole-FIR circles excluded', () => {
		const { map, fitBounds } = fakeMap();
		fitToNotams(map, [
			{ notam: entry({ coordinates: [coord('psn', 48, 2, 10)] }), index: 0 },
			{
				notam: entry({
					coordinates: [coord('qualifierLine', 44, 6, FIR_WIDE_RADIUS_NM)],
				}),
				index: 1,
			},
		]);
		const [bounds, opts] = fitBounds.mock.calls[0];
		expect(bounds[0][0]).toBeCloseTo(44 - 1e-4, 6);
		expect(bounds[1][0]).toBeCloseTo(48 + PAD_10NM_DEG, 6);
		expect(opts.maxZoom).toBe(13);
	});

	it('frames a list that drew no extent at all like one pin', () => {
		const { map, fitBounds } = fakeMap();
		fitToNotams(map, [
			{ notam: entry({ coordinates: [coord('psn', 48, 2)] }), index: 0 },
		]);
		expect(fitBounds.mock.calls[0][1].maxZoom).toBe(11);
	});

	it('does nothing for an empty list', () => {
		const { map, fitBounds } = fakeMap();
		fitToNotams(map, []);
		expect(fitBounds).not.toHaveBeenCalled();
	});
});
