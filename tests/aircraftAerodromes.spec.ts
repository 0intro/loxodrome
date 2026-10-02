/* Trip-chain aerodrome lists (src/lib/aircraft/aerodromes.ts): the
 * performance page's ident walk (perfIcaos), the printed dossier's weather
 * stops (tripWxStops), both over the real orderedTrips / orphanAlternates
 * pairing, and the print prefetch's grid stops (perfWxStops). */

import { describe, it, expect } from 'vitest';
import { perfIcaos, perfWxStops, pickedRunwayEnd, runwayEnds, tripWxStops } from '$lib/aircraft/aerodromes';
import type { Airport, Runway } from '$lib/data/airports';
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

// A designator can repeat at one aerodrome: 260 helipads publish their pad as
// H1 / H1, and LIAF Foligno lays a glider strip 17/35GLD beside its 17/35.
// The performance page keyed its runway options on the designator and threw
// (Svelte's duplicate key), and a pick of the second 17 resolved to the first.
describe('runwayEnds on a repeated designator', () => {
	function rwy(le: string, he: string, lengthFt: number, surface: string): Runway {
		return {
			le,
			he,
			lengthFt,
			widthFt: null,
			surface,
			lit: false,
			leLdaFt: null,
			leToraFt: null,
			leTodaFt: null,
			leAsdaFt: null,
			heLdaFt: null,
			heToraFt: null,
			heTodaFt: null,
			heAsdaFt: null,
			leLighting: null,
			heLighting: null,
			lePos: null,
			hePos: null,
		};
	}
	const liaf = {
		ident: 'LIAF',
		runways: [rwy('17', '35', 4593, 'ASPH'), rwy('17', '35GLD', 3609, 'GRASS')],
	} as unknown as Airport;

	it('keys a designator two runways carry by its runway, whatever their order', () => {
		// Keyed by position (17, 17#2), a dataset release listing the grass
		// strip first silently moved a stored pick onto the other runway.
		const ends = runwayEnds(liaf);
		expect(ends.map((e) => e.id)).toEqual(['17', '35', '17', '35GLD']);
		expect(ends.map((e) => e.key)).toEqual(['17@17/35', '35', '17@17/35GLD', '35GLD']);
		expect(ends.map((e) => e.grass)).toEqual([false, false, true, true]);
		const reordered: Airport = { ...liaf, runways: [...liaf.runways].reverse() };
		expect(pickedRunwayEnd(runwayEnds(reordered), '17@17/35GLD')?.grass).toBe(true);
	});

	it('shows a repeated designator with its runway, and a unique one alone', () => {
		expect(runwayEnds(liaf).map((e) => e.label)).toEqual(['17 (17/35)', '35', '17 (17/35GLD)', '35GLD']);
	});

	it('leaves a field with unique designators exactly as before', () => {
		const lfpn = { ident: 'LFPN', runways: [rwy('07', '25', 3609, 'ASPH')] } as unknown as Airport;
		for (const e of runwayEnds(lfpn)) {
			expect(e.key).toBe(e.id);
			expect(e.label).toBe(e.id);
		}
	});

	it('lists a pad published as H1 / H1 once, one direction-less surface', () => {
		// Two options reading "H1 (H1/H1)" offered a choice that was none.
		const pad = { ident: '01XA', runways: [rwy('H1', 'H1', 60, 'CONC')] } as unknown as Airport;
		expect(runwayEnds(pad).map((e) => [e.key, e.label])).toEqual([['H1', 'H1']]);
		// Its designator names it alone: a NOTAM's figure for it still reads.
		expect(runwayEnds(pad, new Map([['H1', { tora: 40 }]]))[0].distances.toraM).toBe(40);
	});

	it('places no NOTAM figure on a designator two runways carry', () => {
		// The NOTAM names "RWY 17" and cannot say which runway: placed on
		// both, the grass strip took the paved runway's TORA. The resolver
		// contests it, and the ends keep the AIP's figures under that mark.
		const ends = runwayEnds(liaf, new Map([['17', { tora: 1000 }], ['35GLD', { tora: 900 }]]));
		expect(ends.filter((e) => e.id === '17').map((e) => e.distances.toraM)).not.toContain(1000);
		expect(ends.find((e) => e.id === '35GLD')?.distances.toraM).toBe(900);
	});

	it('resolves a stored pick by its key, an old bare designator to the first', () => {
		const ends = runwayEnds(liaf);
		expect(pickedRunwayEnd(ends, '17@17/35GLD')?.grass).toBe(true);
		expect(pickedRunwayEnd(ends, '17')?.runway.le).toBe('17');
		expect(pickedRunwayEnd(ends, '17')?.grass).toBe(false);
		// The development builds' positional form still reads.
		expect(pickedRunwayEnd(ends, '17#2')?.grass).toBe(true);
		expect(pickedRunwayEnd(ends, '17#3')).toBeNull();
		expect(pickedRunwayEnd(ends, null)).toBeNull();
	});

	it('lists a runway published twice once, and no placeholder end', () => {
		// KY68, MI75 and SJS2 repeat a row exactly: two options read "H1
		// (H1/)" and the second was keyed by position. And 46 heliports
		// publish "-" for the end they do not have, offered as a runway.
		const ky68 = { ident: 'KY68', runways: [rwy('H1', '', 42, 'Turf'), rwy('H1', '', 42, 'Turf')] } as unknown as Airport;
		expect(runwayEnds(ky68).map((e) => [e.key, e.label])).toEqual([['H1', 'H1']]);
		const pads = { ident: '33WV', runways: [rwy('H1', '-', 40, 'CON'), rwy('H2', '-', 40, 'CON')] } as unknown as Airport;
		expect(runwayEnds(pads).map((e) => [e.key, e.label])).toEqual([
			['H1', 'H1'],
			['H2', 'H2'],
		]);
		// Nor the baseline's other placeholders: XX (FNCX, NZFG), unknown,
		// error, 0 and 00, each offered as a runway to pick.
		for (const ph of ['XX', 'unknown', 'Unknown', 'error', '0', '00']) {
			const odd = { ident: 'ZZ01', runways: [rwy('09', ph, 600, 'ASP')] } as unknown as Airport;
			expect(runwayEnds(odd).map((e) => [e.key, e.label]), ph).toEqual([['09', '09']]);
		}
		// One designator on two surfaces the pair cannot tell apart: the
		// surface says which, and no empty end reads as a slash.
		const two = { ident: 'XX01', runways: [rwy('H1', '', 42, 'Turf'), rwy('H1', '', 42, 'CON')] } as unknown as Airport;
		expect(runwayEnds(two).map((e) => e.label)).toEqual(['H1 (H1, Turf)', 'H1 (H1, CON)']);
	});

	it('keeps a pick made at its runway when the dataset changes around it', () => {
		// The glider strip withdrawn, 17 is unique again and keyed bare: the
		// pick stored as 17@17/35 resolved to nothing, the pilot's choice
		// falling back to the automatic one, possibly the opposite end.
		const paved = { ident: 'LIAF', runways: [liaf.runways[0]] } as unknown as Airport;
		expect(pickedRunwayEnd(runwayEnds(paved), '17@17/35')?.id).toBe('17');
		// The same runway listed the other way round.
		const flipped = { ident: 'LIAF', runways: [rwy('35', '17', 4593, 'ASPH'), liaf.runways[1]] } as unknown as Airport;
		const e = pickedRunwayEnd(runwayEnds(flipped), '17@17/35');
		expect([e?.id, e?.grass]).toEqual(['17', false]);
		// But never moved onto another runway: the strip picked is gone.
		expect(pickedRunwayEnd(runwayEnds(paved), '17@17/35GLD')).toBeNull();
	});
});

describe('runwayEnds grass factor by surface', () => {
	const field = (surface: string): Airport =>
		({
			ident: 'ZZ02',
			runways: [
				{
					le: '09',
					he: '27',
					lengthFt: 2300,
					widthFt: null,
					surface,
					lit: false,
					leLdaFt: null,
					leToraFt: null,
					leTodaFt: null,
					leAsdaFt: null,
					heLdaFt: null,
					heToraFt: null,
					heTodaFt: null,
					heAsdaFt: null,
					leLighting: null,
					heLighting: null,
					lePos: null,
					hePos: null,
				},
			],
		}) as unknown as Airport;

	it('applies the grass factor unless the runway is known to be paved', () => {
		// A surface nobody can read, or one paved only in part, takes the
		// factor: it used to read as paved and never got it.
		for (const [surface, cls, grass] of [
			['ASPH', 'hard', false],
			['GRASS', 'soft', true],
			['ASP+GRS', 'mixed', true],
			['UNK', 'unknown', true],
			['', 'unknown', true],
			['GRV', 'soft', true],
		] as const) {
			for (const e of runwayEnds(field(surface))) {
				expect([e.surfaceClass, e.grass], surface).toEqual([cls, grass]);
			}
		}
	});
});
