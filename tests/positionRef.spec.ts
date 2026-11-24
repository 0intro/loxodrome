/* The position reading (src/lib/nav/positionRef.ts): which reference names
 * the position, and how ("OHD Étampes", "NW Étampes", "4 NM NW Étampes"),
 * docs/nav-live.md "The position reference". */

import { describe, expect, it } from 'vitest';
import type { Airport } from '$lib/data/airports';
import type { Navaid } from '$lib/data/navaids';
import type { Place } from '$lib/data/places';
import { equirectangularDistanceM, M_PER_DEG } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import {
	aerodromeRefs,
	buildRefIndex,
	formatPositionRef,
	navaidRefs,
	positionRef,
	positionRefFigure,
	townRefs,
	vrpLabel,
	type RefPoint,
} from '$lib/nav/positionRef';

// Degrees of latitude for a distance, by the distance's own constants.
const DEG_PER_NM = NM_TO_METERS / M_PER_DEG;

function town(id: string, label: string, lat: number, lon: number, pop: number): RefPoint {
	return { kind: 'town', id, label, lat, lon, pop };
}
function vrp(id: string, label: string, lat: number, lon: number): RefPoint {
	return { kind: 'vrp', id, label, lat, lon, pop: null };
}

const ETAMPES = town('fr:91223', 'Étampes', 48, 2, 26857);

describe('positionRef', () => {
	it('reads overhead under a mile, the direction to three miles, the distance beyond', () => {
		const index = buildRefIndex([ETAMPES]);
		const at = (nm: number) => positionRef(index, 48 + nm * DEG_PER_NM, 2);
		// A hair past each boundary: a position a whole mile out comes back
		// from the floating point a hair either side of it.
		expect(positionRefFigure(at(0.99)!)).toBe('OHD');
		expect(positionRefFigure(at(1.00000001)!)).toBe('N');
		expect(positionRefFigure(at(2.99999999)!)).toBe('N');
		expect(positionRefFigure(at(3.01)!)).toBe('3 NM N');
		expect(formatPositionRef(at(4.2)!)).toBe('4 NM N Étampes');
		expect(formatPositionRef(at(0.2)!)).toBe('OHD Étampes');
	});

	it('takes the bearing from the reference to the position, as one of eight points', () => {
		const index = buildRefIndex([ETAMPES]);
		const d = 2 * DEG_PER_NM;
		const nw = positionRef(index, 48 + d * Math.SQRT1_2, 2 - (d * Math.SQRT1_2) / Math.cos((48 * Math.PI) / 180));
		expect(formatPositionRef(nw!)).toBe('NW Étampes');
	});

	it('names a feature within ten miles before any town, a town overhead before all', () => {
		const at = (nm: number) => [vrp('v', 'Neuville de Poitou', 46 + nm * DEG_PER_NM, 0), town('t', 'Poitiers', 46 - 2 * DEG_PER_NM, 0, 88000)];
		expect(positionRef(buildRefIndex(at(9.9)), 46, 0)?.label).toBe('Neuville de Poitou');
		expect(positionRef(buildRefIndex(at(10.1)), 46, 0)?.label).toBe('Poitiers');
		// Overhead the town, it wins whatever is within ten miles.
		expect(positionRef(buildRefIndex(at(5)), 46 - 2 * DEG_PER_NM, 0)?.form).toBe('ohd');
	});

	it('names a town of 5,000 before a smaller one, within fifteen miles', () => {
		const small = town('s', 'Bourg', 45 + 3 * DEG_PER_NM, 5, 2000);
		const large = town('l', 'Ville', 45 + 12 * DEG_PER_NM, 5, 8000);
		expect(positionRef(buildRefIndex([small, large]), 45, 5)?.label).toBe('Ville');
		expect(positionRef(buildRefIndex([small]), 45, 5)?.label).toBe('Bourg');
		const far = town('f', 'Loin', 45 + 15.5 * DEG_PER_NM, 5, 90000);
		expect(positionRef(buildRefIndex([far]), 45, 5)).toBeNull();
	});

	it('finds what a brute-force scan finds, across the antimeridian too', () => {
		// A fixed seed: the same points every run.
		let seed = 12345;
		const rand = (): number => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};
		const points: RefPoint[] = [];
		for (let i = 0; i < 400; i++) {
			const lon = 179 + rand() * 2;
			const p = { lat: -17 + rand() * 2, lon: lon > 180 ? lon - 360 : lon };
			points.push(
				rand() < 0.5
					? vrp(`v${i}`, `V${i}`, p.lat, p.lon)
					: town(`t${i}`, `T${i}`, p.lat, p.lon, Math.round(1000 + rand() * 9000)),
			);
		}
		const index = buildRefIndex(points);
		const brute = (lat: number, lon: number): string | null => {
			const d = points.map((p) => ({ p, nm: equirectangularDistanceM(lat, lon, p.lat, p.lon) / NM_TO_METERS }));
			const pick = (f: (x: { p: RefPoint; nm: number }) => boolean) =>
				d.filter(f).sort((a, b) => a.nm - b.nm || (a.p.id < b.p.id ? -1 : 1))[0];
			const best =
				pick((x) => x.nm < 1) ??
				pick((x) => x.p.kind !== 'town' && x.nm <= 10) ??
				pick((x) => x.p.kind === 'town' && (x.p.pop ?? 0) >= 5000 && x.nm <= 15) ??
				pick((x) => x.p.kind === 'town' && x.nm <= 15);
			return best ? best.p.id : null;
		};
		for (let i = 0; i < 200; i++) {
			const lon = 179 + rand() * 2;
			const q = { lat: -17 + rand() * 2, lon: lon > 180 ? lon - 360 : lon };
			expect(positionRef(index, q.lat, q.lon)?.id ?? null, `${q.lat}, ${q.lon}`).toBe(brute(q.lat, q.lon));
		}
	});
});

function navaid(over: Partial<Navaid>): Navaid {
	return { id: 'x', type: 'VFR_REPORTING_POINT', ident: '', name: '', lat: 0, lon: 0, freq: '', channel: '', elev: null, rmk: '', ad: '', source: 'uk', ...over };
}

describe('the references', () => {
	it('names a reporting point by its landmark, never a code, a letter or a relative position', () => {
		const cases: [Partial<Navaid>, string][] = [
			[{ source: 'fr', name: 'BI-N', rmk: 'VRP-Neuville de Poitou' }, 'Neuville de Poitou'],
			[{ source: 'fr', name: 'BB-W', rmk: 'VRP-260°/15 NM BB, 080°/14 NM MA#Limite CTR 1 BORA-BORA' }, ''],
			[{ source: 'fr', name: 'CHP', rmk: 'VRP-South of "Petit Nice" beach. Point reserved' }, ''],
			[{ source: 'fr', name: 'BG-S2', rmk: 'VRP-' }, ''],
			[{ source: 'de', ident: 'S', name: 'EDFH SIERRA' }, 'EDFH SIERRA'],
			[{ source: 'de', ident: 'EDHI', name: 'MSA EDHI' }, ''],
			[{ source: 'de', ident: 'DF430', name: 'FAP RWY 25R 3.2' }, ''],
			[{ source: 'at', ident: 'HI', name: 'HIMBERG' }, 'HIMBERG'],
			[{ source: 'at', ident: 'O', name: 'OSCAR' }, ''],
			[{ source: 'nl', ident: 'EHKDE', name: 'ECHO' }, ''],
			[{ source: 'ge', ident: 'N', name: 'NOVEMBER 1' }, ''],
			[{ source: 'ge', ident: 'KO201', name: 'SID 25 UGKO' }, ''],
			[{ source: 'uk', ident: 'VP015', name: 'AUDLEY END RAILWAY STATION' }, 'AUDLEY END RAILWAY STATION'],
			[{ source: 'ie', ident: 'BALLYMUN CENTRE', name: '' }, 'BALLYMUN CENTRE'],
			[{ source: 'faa', ident: 'LIZZI', name: '' }, ''],
		];
		for (const [n, want] of cases) {
			expect(vrpLabel(navaid(n)), JSON.stringify(n)).toBe(want);
		}
	});

	it('reads the radio aids by identifier, and the reporting points with a landmark only', () => {
		const refs = navaidRefs([
			navaid({ id: 'a', type: 'VOR-DME', ident: 'TSU', name: 'TOUSSUS' }),
			navaid({ id: 'b', type: 'DME', ident: 'XYZ' }),
			navaid({ id: 'c', type: 'WAYPOINT', ident: 'ABOBO' }),
			navaid({ id: 'd', source: 'fr', rmk: 'VRP-Neuville de Poitou' }),
			navaid({ id: 'e', source: 'nl', name: 'ECHO' }),
		]);
		expect(refs.map((r) => [r.kind, r.label])).toEqual([
			['navaid', 'TSU'],
			['vrp', 'Neuville de Poitou'],
		]);
	});

	it('names an open fixed-wing aerodrome by its ICAO indicator, else its name', () => {
		const refs = aerodromeRefs([
			{ ident: 'LFOX', name: 'ETAMPES MONDESIR', type: 'small_airport', lat: 48.38, lon: 2.08 } as Airport,
			{ ident: 'N12', name: 'Lakewood', type: 'small_airport', lat: 40, lon: -74 } as Airport,
			{ ident: 'LFPI', name: 'ISSY', type: 'heliport', lat: 48.83, lon: 2.27 } as Airport,
			{ ident: 'LFQZ', name: 'GONE', type: 'closed', lat: 49, lon: 3 } as Airport,
		]);
		expect(refs.map((r) => r.label)).toEqual(['LFOX', 'Lakewood']);
	});

	it('reads the towns of a thousand people or more', () => {
		const p = (name: string, pop: number | null) => ({ id: name, name, pop, lat: 0, lon: 0 }) as Place;
		expect(townRefs([p('A', 999), p('B', 1000), p('C', null)]).map((r) => r.label)).toEqual(['B']);
	});
});
