/* Trip-chain aerodrome lists (src/lib/aircraft/aerodromes.ts): the
 * performance page's ident walk (perfIcaos), the printed dossier's weather
 * stops (tripWxStops), both over the real orderedTrips / orphanAlternates
 * pairing, and the print prefetch's grid stops (perfWxStops). */

import { describe, it, expect } from 'vitest';
import { perfIcaos, perfWxStops, tripWxStops } from '$lib/aircraft/aerodromes';
import { orderedTrips, orphanAlternates } from '$lib/aircraft/trips';

interface W {
	kind: string;
	ident?: string | undefined;
	lat: number;
	lon: number;
}

interface R {
	id: string;
	alternate?: boolean | undefined;
	waypoints: W[];
}

const ap = (ident: string, lat = 0, lon = 0): W => ({ kind: 'airport', ident, lat, lon });
const free = (lat = 0, lon = 0): W => ({ kind: 'free', lat, lon });
const route = (id: string, waypoints: W[], alternate?: boolean): R => ({
	id,
	alternate,
	waypoints,
});

describe('perfIcaos', () => {
	it('walks each trip departure + arrival, then the alternate destination', () => {
		const list = [
			route('t1', [ap('LFPL'), free(48.5, 3.8), ap('LFQH')]),
			route('a1', [ap('LFQH'), ap('LFQB')], true),
			route('t2', [ap('LFQH'), ap('LFPL')]),
		];
		expect(perfIcaos(orderedTrips(list), [])).toEqual(['LFPL', 'LFQH', 'LFQB']);
	});

	it('skips intermediate airport waypoints (stopovers are separate routes)', () => {
		const list = [route('t1', [ap('LFPL'), ap('LFXI'), ap('LFQH')])];
		expect(perfIcaos(orderedTrips(list), [])).toEqual(['LFPL', 'LFQH']);
	});

	it('ignores airport-less routes and appends deduped manual adds', () => {
		const list = [
			route('t1', [free(48, 2), free(49, 3)]),
			route('t2', [ap('LFPL'), ap('LFPL')]),
		];
		expect(perfIcaos(orderedTrips(list), ['LFAB', 'LFPL'])).toEqual(['LFPL', 'LFAB']);
	});
});

describe('tripWxStops', () => {
	const lfpl = ap('LFPL', 48.82, 2.63);
	const lfqh = ap('LFQH', 48.09, 5.05);
	const lfqb = ap('LFQB', 48.32, 4.02);

	it('carries the contributing waypoint coordinates in trip order', () => {
		const list = [
			route('t1', [lfpl, free(48.5, 3.8), lfqh]),
			route('a1', [lfqh, lfqb], true),
			route('t2', [lfqh, lfpl]),
		];
		expect(tripWxStops(orderedTrips(list), orphanAlternates(list))).toEqual([
			{ icao: 'LFPL', lat: 48.82, lon: 2.63 },
			{ icao: 'LFQH', lat: 48.09, lon: 5.05 },
			{ icao: 'LFQB', lat: 48.32, lon: 4.02 },
		]);
	});

	it('appends orphan alternates after the trips', () => {
		const list = [
			route('a0', [lfqb, ap('LFAB', 49.0, 1.0)], true),
			route('t1', [lfpl, lfqh]),
		];
		const icaos = tripWxStops(orderedTrips(list), orphanAlternates(list)).map((s) => s.icao);
		expect(icaos).toEqual(['LFPL', 'LFQH', 'LFAB']);
	});

	it('keeps the first-seen coordinates on a dedupe', () => {
		const list = [
			route('t1', [ap('LFPL', 48.82, 2.63), lfqh]),
			route('t2', [lfqh, ap('LFPL', 48.83, 2.64)]),
		];
		const stops = tripWxStops(orderedTrips(list), orphanAlternates(list));
		expect(stops.find((s) => s.icao === 'LFPL')).toEqual({
			icao: 'LFPL',
			lat: 48.82,
			lon: 2.63,
		});
	});

	it('skips routes and alternates without airport waypoints', () => {
		const list = [
			route('t1', [free(48, 2), free(49, 3)]),
			route('a1', [free(48, 2), free(47, 1)], true),
			route('t2', [lfpl, lfqh]),
		];
		expect(tripWxStops(orderedTrips(list), orphanAlternates(list)).map((s) => s.icao)).toEqual([
			'LFPL',
			'LFQH',
		]);
	});
});

describe('perfWxStops', () => {
	const known: Record<string, { lat: number; lon: number }> = {
		LFPL: { lat: 48.82, lon: 2.63 },
		LFQH: { lat: 48.09, lon: 5.05 },
		LFQB: { lat: 48.32, lon: 4.02 },
	};
	const pos = (icao: string) => known[icao] ?? null;

	it('places every ident the dataset knows, in order', () => {
		expect(perfWxStops(['LFPL', 'LFQH'], pos)).toEqual([
			{ icao: 'LFPL', lat: 48.82, lon: 2.63 },
			{ icao: 'LFQH', lat: 48.09, lon: 5.05 },
		]);
	});

	it('covers a manually added ident, which no waypoint carries', () => {
		const list = [route('t1', [ap('LFPL'), ap('LFQH')])];
		const icaos = perfIcaos(orderedTrips(list), ['LFQB']);
		expect(perfWxStops(icaos, pos).map((s) => s.icao)).toEqual(['LFPL', 'LFQH', 'LFQB']);
	});

	it('drops an ident the dataset cannot place (its column has no elevation either)', () => {
		expect(perfWxStops(['LFPL', 'XXXX'], pos).map((s) => s.icao)).toEqual(['LFPL']);
	});
});
