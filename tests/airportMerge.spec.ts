import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	mergeAixmOverlay,
	mergeAixmOverlays,
	applyFrAutoInfoFrequency,
	applyDeMilitaryStatus,
	dropStaleBaseline,
} from '$lib/data/airportMerge';
import { airportStatus } from '$lib/map/airportSymbols';
import type { Airport, Runway } from '$lib/data/airports';

function ap(p: Partial<Airport>): Airport {
	return {
		ident: 'XXXX',
		type: 'small_airport',
		name: '',
		lat: 0,
		lon: 0,
		elevFt: null,
		transitionAltFt: null,
		country: '',
		city: '',
		iata: '',
		runways: [],
		access: null,
		military: false,
		joint: false,
		vfr: false,
		ifr: false,
		radios: [],
		charts: [],
		pads: [],
		source: null,
		...p,
	};
}

describe('mergeAixmOverlay', () => {
	it('enriches a baseline aerodrome that shares the ICAO ident', () => {
		const base = [ap({ ident: 'LFPG', type: 'large_airport', name: 'baseline' })];
		const fr = [ap({ ident: 'LFPG', name: 'CDG', military: true, source: 'fr' })];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(1);
		expect(out[0].ident).toBe('LFPG');
		expect(out[0].type).toBe('large_airport'); // OurAirports type kept
		expect(out[0].name).toBe('CDG'); // AIXM wins
		expect(out[0].military).toBe(true);
		expect(out[0].source).toBe('fr');
	});

	it('keeps the authoritative AIXM frequencies when present, else the baseline', () => {
		const base = [
			ap({ ident: 'LFPG', radios: [{ freq: '120.9', unit: 'TWR', call: 'CDG' }] }),
			ap({ ident: 'LFPO', radios: [{ freq: '118.7', unit: 'TWR', call: 'ORLY' }] }),
		];
		const fr = [
			// LFPG: AIXM publishes its own radios -> they win.
			ap({ ident: 'LFPG', radios: [{ freq: '119.250', unit: 'TWR', call: 'DE GAULLE' }], source: 'fr' }),
			// LFPO: AIXM has no radios -> the OurAirports baseline survives.
			ap({ ident: 'LFPO', radios: [], source: 'fr' }),
		];
		const out = mergeAixmOverlay(base, fr);
		const byId = Object.fromEntries(out.map((a) => [a.ident, a]));
		expect(byId.LFPG.radios).toEqual([{ freq: '119.250', unit: 'TWR', call: 'DE GAULLE' }]);
		expect(byId.LFPO.radios).toEqual([{ freq: '118.7', unit: 'TWR', call: 'ORLY' }]);
	});

	it('lets a runway-less overlay enrich the baseline instead of thinning it', () => {
		// cmd/at publishes the position, name and elevation of an Austrian
		// aerodrome; its runways and radios stay with OurAirports.
		const base = [
			ap({
				ident: 'LOWW',
				type: 'large_airport',
				name: 'baseline',
				runways: [
					{
						le: '11', he: '29', lengthFt: 11811, widthFt: 148, surface: 'ASPH', lit: true,
						leLdaFt: null, leToraFt: null, leTodaFt: null, leAsdaFt: null,
						heLdaFt: null, heToraFt: null, heTodaFt: null, heAsdaFt: null,
						leLighting: null, heLighting: null,
						lePos: null, hePos: null,
					},
				],
				radios: [{ freq: '121.200', unit: 'TWR', call: 'WIEN TOWER' }],
			}),
		];
		const at = [ap({ ident: 'LOWW', name: 'Wien-Schwechat', elevFt: 600, source: 'at' })];
		const out = mergeAixmOverlay(base, at);
		expect(out).toHaveLength(1);
		expect(out[0].name).toBe('Wien-Schwechat');
		expect(out[0].elevFt).toBe(600);
		expect(out[0].runways).toHaveLength(1);
		expect(out[0].radios).toEqual([{ freq: '121.200', unit: 'TWR', call: 'WIEN TOWER' }]);
		expect(out[0].source).toBe('at');
	});

	it('appends an AIXM aerodrome with no nearby baseline match', () => {
		const base = [ap({ ident: 'LFPG', lat: 49, lon: 2.5 })];
		const fr = [ap({ ident: 'LFXX', lat: 44, lon: 6, source: 'fr' })];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(2);
		expect(out.map((a) => a.ident).sort()).toEqual(['LFPG', 'LFXX']);
	});

	it('merges a co-located aerodrome listed under a different ident (LFPR vs LF51)', () => {
		// OurAirports LF51 (civil) and the SIA LFPR (military) are the same
		// field, ~60 m apart; without the proximity match both symbols draw.
		const base = [
			ap({
				ident: 'LF51',
				type: 'small_airport',
				name: 'Plan-de-Dieu-Orange Airfield',
				lat: 44.18,
				lon: 4.9189,
			}),
		];
		const fr = [
			ap({
				ident: 'LFPR',
				name: 'ORANGE PLAN DE DIEU',
				lat: 44.17944,
				lon: 4.91889,
				military: true,
				access: 'restricted',
				source: 'fr',
			}),
		];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(1); // no duplicate symbol
		expect(out[0].ident).toBe('LFPR'); // the SIA ICAO wins, so NOTAM links resolve
		expect(out[0].type).toBe('small_airport'); // OurAirports type kept
		expect(out[0].military).toBe(true);
		expect(out[0].name).toBe('ORANGE PLAN DE DIEU');
	});

	it('never lets a national code claim a baseline ident (SIA LF51 vs OurAirports LF51)', () => {
		// The SIA's own LF51 is VITRY EN ARTOIS (CLOSED), 300 km from the
		// OurAirports LF51 above. The two LFnn registries only look alike, so
		// the exact-ident pass must ignore it and the pair must stay distinct.
		const base = [
			ap({
				ident: 'LF51',
				type: 'small_airport',
				name: 'Plan-de-Dieu-Orange Airfield',
				lat: 44.18,
				lon: 4.9189,
				elevFt: 383,
			}),
		];
		const fr = [
			ap({
				ident: 'LF51',
				type: 'closed',
				name: 'VITRY EN ARTOIS (CLOSED)',
				lat: 50.33,
				lon: 2.9925,
				source: 'fr',
			}),
		];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(2);
		const plan = out.find((a) => a.name.startsWith('Plan-de-Dieu'));
		expect(plan?.elevFt).toBe(383); // baseline untouched, not overwritten
		expect(plan?.source).toBeNull();
	});

	it('still proximity-merges a national-code aerodrome onto its baseline row', () => {
		// The guard above only skips the ident pass: the SIA LF39 CREIL
		// (CLOSED) sits on the OurAirports LFPC Creil Air Base, so the pair is
		// one field and the AIP's closed-ness wins.
		const base = [
			ap({ ident: 'LFPC', type: 'small_airport', name: 'Creil Air Base', lat: 49.2535, lon: 2.5191 }),
		];
		const fr = [
			ap({ ident: 'LF39', type: 'closed', name: 'CREIL (CLOSED)', lat: 49.2535, lon: 2.5192, source: 'fr' }),
		];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(1);
		expect(out[0].ident).toBe('LF39');
		expect(out[0].type).toBe('closed');
	});

	it('reopens a baseline-closed field the national AIP still publishes', () => {
		// OurAirports D346 carries the Ostfildern-Ruit hospital pad as closed;
		// the DFS AIP publishes it 152 m away as ED1983, abandoned NO. The AIP
		// decides closed-ness, so the merged row is a live heliport and follows
		// the Heliports layer instead of the Closed one.
		const base = [
			ap({
				ident: 'D346',
				type: 'closed',
				name: 'Ostfildern-Ruit Medius Hospital Heliport',
				lat: 48.74116,
				lon: 9.25644,
			}),
		];
		const de = [
			ap({
				ident: 'ED1983',
				type: 'heliport',
				name: 'OSTFILDERN-RUIT MEDIUS KLINIK',
				lat: 48.74181,
				lon: 9.25461,
				access: 'cap',
				vfr: true,
				source: 'de',
			}),
		];
		const out = mergeAixmOverlay(base, de);
		expect(out).toHaveLength(1);
		expect(out[0].ident).toBe('ED1983');
		expect(out[0].type).toBe('heliport');
		expect(out[0].vfr).toBe(true);
	});

	it('closes a baseline-open field the national AIP marks abandoned', () => {
		// EDCK Köthen: OurAirports still lists it as a small airport, the DFS
		// AIXM carries aixm:abandoned YES (emitted as type "closed").
		const base = [ap({ ident: 'EDCK', type: 'small_airport', name: 'Köthen Airport' })];
		const de = [ap({ ident: 'EDCK', type: 'closed', name: 'KOETHEN', source: 'de' })];
		const out = mergeAixmOverlay(base, de);
		expect(out).toHaveLength(1);
		expect(out[0].type).toBe('closed');
		expect(out[0].name).toBe('KOETHEN');
	});

	it('does not merge aerodromes beyond the proximity radius', () => {
		// ~2.2 km apart: distinct fields, both kept.
		const base = [ap({ ident: 'LF99', lat: 44.18, lon: 4.92 })];
		const fr = [ap({ ident: 'LFZZ', lat: 44.2, lon: 4.92, source: 'fr' })];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(2);
	});

	it('does not let a proximity match steal a baseline claimed by an exact ICAO match', () => {
		// Two baseline fields share a cell; FR exact-matches one and has a
		// different-ident aerodrome on top of the other.
		const base = [
			ap({ ident: 'LFAA', lat: 44.18, lon: 4.918 }),
			ap({ ident: 'LF77', lat: 44.181, lon: 4.918 }),
		];
		const fr = [
			ap({ ident: 'LFAA', lat: 44.18, lon: 4.918, military: true, source: 'fr' }),
			ap({ ident: 'LFBB', lat: 44.181, lon: 4.918, military: true, source: 'fr' }),
		];
		const out = mergeAixmOverlay(base, fr);
		expect(out).toHaveLength(2);
		const byId = Object.fromEntries(out.map((a) => [a.ident, a]));
		expect(byId.LFAA?.military).toBe(true); // exact match enriched in place
		expect(byId.LFBB).toBeDefined(); // LF77 replaced by LFBB via proximity
		expect(byId.LF77).toBeUndefined();
	});
});

describe('mergeAixmOverlay: a runway surface nobody can read', () => {
	function rwy(le: string, he: string, surface: string, lengthFt: number | null = 8000): Runway {
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
	const merged = (baseRunways: Runway[], axRunways: Runway[]): string[] =>
		mergeAixmOverlay(
			[ap({ ident: 'LEMD', runways: baseRunways })],
			[ap({ ident: 'LEMD', runways: axRunways, source: 'es' })],
		)[0].runways.map((r) => r.surface);

	it('takes the baseline surface for the same runway (ENAIRE publishes none)', () => {
		expect(merged([rwy('14L', '32R', 'ASP')], [rwy('14L', '32R', '')])).toEqual(['ASP']);
	});

	it('matches the ends with or without a leading zero, either way round', () => {
		expect(merged([rwy('9', '27', 'ASP')], [rwy('09', '27', '')])).toEqual(['ASP']);
		expect(merged([rwy('27', '09', 'TURF')], [rwy('09', '27', 'OTHER')])).toEqual(['TURF']);
	});

	it('never overwrites a surface the overlay states', () => {
		expect(merged([rwy('09', '27', 'ASP')], [rwy('09', '27', 'GRASS')])).toEqual(['GRASS']);
	});

	it('recovers nothing from a baseline that cannot say either, or another runway', () => {
		expect(merged([rwy('09', '27', 'UNK')], [rwy('09', '27', '')])).toEqual(['']);
		// LECU's grass 09M/27M is not its paved 09/27.
		expect(merged([rwy('09', '27', 'ASP')], [rwy('09M', '27M', '')])).toEqual(['']);
	});

	it('matches the same runway renumbered, never a neighbour of another length', () => {
		// ENAIRE's LELC 04R/22L is OurAirports' 05R/23L, same length.
		expect(merged([rwy('05R', '23L', 'ASPH', 7546)], [rwy('04R', '22L', '', 7546)])).toEqual(['ASPH']);
		// A step apart but 2,000 ft shorter: another runway, nothing taken.
		expect(merged([rwy('05', '23', 'ASP', 9000)], [rwy('06', '24', '', 7000)])).toEqual(['']);
		// Suffixes must agree.
		expect(merged([rwy('05L', '23R', 'ASP', 7546)], [rwy('04R', '22L', '', 7546)])).toEqual(['']);
	});

	it('keeps the overlay list itself when there is nothing to recover', () => {
		const ax = [rwy('09', '27', 'ASPH')];
		const out = mergeAixmOverlay([ap({ ident: 'LEMD', runways: [rwy('09', '27', 'ASP')] })], [
			ap({ ident: 'LEMD', runways: ax, source: 'es' }),
		]);
		expect(out[0].runways).toBe(ax);
	});
});

describe('mergeAixmOverlays (every overlay in one pass)', () => {
	// The fold it replaces: mergeAixmOverlay rebuilds its lookups from the
	// view it is given, so folding it over the overlays IS the per-call
	// semantics the one-pass merge must reproduce, row for row and field for
	// field, including what later overlays see of earlier ones (appended
	// rows, rows a proximity merge moved or re-idented, duplicate idents).
	const fold = (base: Airport[], overlays: Airport[][]): Airport[] =>
		overlays.reduce((acc, o) => mergeAixmOverlay(acc, o), base);

	/** Deterministic generator (mulberry32). */
	function rng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

	function scenario(seed: number): { base: Airport[]; overlays: Airport[][] } {
		const r = rng(seed);
		const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
		const icao = () => 'LF' + LETTERS[Math.floor(r() * 26)] + LETTERS[Math.floor(r() * 26)];
		// A small area so cells are shared and neighbours are within 400 m.
		const pos = () => ({ lat: 47 + r() * 0.3, lon: 2 + r() * 0.3 });
		const base: Airport[] = [];
		for (let i = 0; i < 400; i++) {
			const ident = r() < 0.6 ? icao() : `LF${String(Math.floor(r() * 100)).padStart(2, '0')}`;
			base.push(ap({ ident, name: `base ${i}`, ...pos() }));
		}
		const overlays: Airport[][] = [];
		const nOverlays = 3 + Math.floor(r() * 4);
		for (let k = 0; k < nOverlays; k++) {
			const rows: Airport[] = [];
			const n = Math.floor(r() * 60);
			for (let i = 0; i < n; i++) {
				const kind = r();
				// Sources are distinct per overlay, which is also what makes a
				// wrong row choice visible in the merged output.
				const source = (['fr', 'uk', 'es', 'be', 'de', 'at'] as const)[k % 6];
				if (kind < 0.3 && base.length > 0) {
					// An exact ICAO match (or the same ident as some row).
					const b = pick(base);
					rows.push(ap({ ident: b.ident, name: `o${k}-${i}`, source, lat: b.lat + (r() - 0.5) * 0.02, lon: b.lon + (r() - 0.5) * 0.02 }));
				} else if (kind < 0.6 && base.length > 0) {
					// A national code sitting within a few hundred metres of a row.
					const b = pick(base);
					rows.push(ap({ ident: `LF${Math.floor(r() * 1000)}`, name: `o${k}-${i}`, source, lat: b.lat + (r() - 0.5) * 0.004, lon: b.lon + (r() - 0.5) * 0.004 }));
				} else if (kind < 0.7 && rows.length > 0) {
					// A duplicate of an ident this overlay already carries.
					const b = pick(rows);
					rows.push(ap({ ident: b.ident, name: `o${k}-${i}`, source, ...pos() }));
				} else {
					// A fresh aerodrome, ICAO or not, which later overlays may match.
					rows.push(ap({ ident: r() < 0.5 ? icao() : `X${Math.floor(r() * 50)}`, name: `o${k}-${i}`, source, ...pos() }));
				}
			}
			overlays.push(rows);
		}
		return { base, overlays };
	}

	it('equals folding mergeAixmOverlay, over random overlays', () => {
		for (let seed = 1; seed <= 60; seed++) {
			const { base, overlays } = scenario(seed);
			expect(mergeAixmOverlays(base, overlays)).toEqual(fold(base, overlays));
		}
	});

	it('equals the fold on real idents and positions (the SIA aerodromes)', () => {
		// The shipped file is positional ({fields, rows}); ident, name, lat and
		// lon are what the lookups read, so a view built from them exercises
		// the real density and ident mix (ICAO plus national codes).
		const doc = JSON.parse(readFileSync('public/data/fr-airports.json', 'utf8')) as {
			fields: string[];
			rows: unknown[][];
		};
		const f = (name: string) => doc.fields.indexOf(name);
		const real = doc.rows.map((r) =>
			ap({ ident: String(r[f('ident')]), name: String(r[f('name')]), lat: Number(r[f('lat')]), lon: Number(r[f('lon')]) }),
		);
		expect(real.length).toBeGreaterThan(500);
		// A baseline that lists some fields under local codes (the LF51 case),
		// then overlapping overlays of the same fields, one of them empty.
		const base = real.map((a, i) => ap({ ...a, name: `base ${i}`, ident: i % 3 === 0 ? `LF${i % 97}` : a.ident }));
		const overlays = [
			real.slice(0, 500).map((a) => ({ ...a, source: 'fr' as const })),
			real.slice(250, 700).map((a) => ({ ...a, source: 'uk' as const, lat: a.lat + 0.001 })),
			[],
			real.slice(100, 400).map((a) => ({ ...a, source: 'de' as const, ident: `ED${a.ident.slice(2)}` })),
		];
		expect(mergeAixmOverlays(base, overlays)).toEqual(fold(base, overlays));
	});

	it('breaks an exact distance tie by row order, as a rebuilt grid would', () => {
		// Row 0 is moved by the first overlay onto the very spot row 1 sits
		// on, in another cell. A later national code equidistant from both
		// must take row 0, the lower index, which is the order a grid
		// rebuilt from the view lists them in; re-filing the moved row at the
		// END of its new cell would hand it row 1.
		const base = [
			ap({ ident: 'LFAA', lat: 47.0, lon: 2.0 }),
			ap({ ident: 'LF01', lat: 47.53, lon: 2.53 }),
		];
		const overlays = [
			[ap({ ident: 'LFAA', source: 'fr', lat: 47.53, lon: 2.53 })],
			[ap({ ident: 'LF999', source: 'uk', lat: 47.531, lon: 2.53 })],
		];
		const out = mergeAixmOverlays(base, overlays);
		expect(out).toEqual(fold(base, overlays));
		expect(out[0].ident).toBe('LF999');
		expect(out[1].ident).toBe('LF01');
	});

	it('returns a copy when there is nothing to merge', () => {
		const base = [ap({ ident: 'LFPG' })];
		const out = mergeAixmOverlays(base, [[], []]);
		expect(out).toEqual(base);
		expect(out).not.toBe(base);
	});
});

describe('dropStaleBaseline', () => {
	it('drops a baseline field the national AIXM does not list (LFSY)', () => {
		const merged = [
			ap({ ident: 'LFPG', country: 'FR', source: 'fr' }), // SIA-listed
			ap({ ident: 'LFSY', country: 'FR', source: null }), // OurAirports-only, stale
		];
		const out = dropStaleBaseline(merged, ['fr']);
		expect(out.map((a) => a.ident)).toEqual(['LFPG']);
	});

	it('keeps every AIXM-sourced row unconditionally', () => {
		const merged = [
			ap({ ident: 'LFPG', country: 'FR', source: 'fr' }),
			ap({ ident: 'EGLL', country: 'GB', source: 'uk' }),
			ap({ ident: 'LEMD', country: 'ES', source: 'es' }),
		];
		expect(dropStaleBaseline(merged, ['fr', 'uk', 'es'])).toHaveLength(3);
	});

	it('does not drop a baseline field when its authority did not load', () => {
		const merged = [ap({ ident: 'LFSY', country: 'FR', source: null })];
		expect(dropStaleBaseline(merged, [])).toHaveLength(1);
		expect(dropStaleBaseline(merged, ['uk', 'es'])).toHaveLength(1);
	});

	it('leaves baseline fields outside the authoritative countries alone', () => {
		const merged = [
			ap({ ident: 'KJFK', country: 'US', source: null }),
			ap({ ident: 'NTAA', country: 'PF', source: null }), // French overseas: additive
		];
		expect(dropStaleBaseline(merged, ['fr', 'uk', 'es'])).toHaveLength(2);
	});

	it('scopes by iso_country, not ICAO prefix (no foreign-ident collisions)', () => {
		const merged = [
			ap({ ident: 'GE00', country: 'US', source: null }), // US field, not Ceuta
			ap({ ident: 'GCV', country: 'BR', source: null }), // Brazil, not Canaries
			ap({ ident: 'ES-0051', country: 'ES', source: null }), // Spanish placeholder ident
		];
		const out = dropStaleBaseline(merged, ['es']);
		expect(out.map((a) => a.ident)).toEqual(['GE00', 'GCV']); // only ES-0051 dropped
	});

	it('claims the home territory only, not crown dependencies', () => {
		const merged = [
			ap({ ident: 'EGBB', country: 'GB', source: null }), // GB, unmatched -> drop
			ap({ ident: 'EGJJ', country: 'JE', source: null }), // Jersey: additive -> keep
		];
		const out = dropStaleBaseline(merged, ['uk']);
		expect(out.map((a) => a.ident)).toEqual(['EGJJ']);
	});
});

describe('applyFrAutoInfoFrequency', () => {
	const AA = { freq: '123.5', unit: 'A/A', call: '' };

	it('adds A/A 123.500 to a French small aerodrome with no frequency', () => {
		const out = applyFrAutoInfoFrequency([ap({ ident: 'LFXX', type: 'small_airport', source: 'fr' })]);
		expect(out[0].radios).toEqual([AA]);
	});

	it('invents no frequency for a French heliport (the legend rule reads "sur AD")', () => {
		// The SIA publishes no radio for the ~250 hospital helipads it carries;
		// an helistation is not an aerodrome, so it gets no A/A channel.
		const out = applyFrAutoInfoFrequency([
			ap({ ident: 'LF075', type: 'heliport', source: 'fr' }),
			ap({ ident: 'LFWD', type: 'heliport', source: 'fr' }),
		]);
		expect(out.every((a) => a.radios.length === 0)).toBe(true);
	});

	it('gives an altiport 123.065 instead (Legende2026; curated ident set)', () => {
		// The SIA AIXM carries no altiport marker, so membership is the
		// curated FR_ALTIPORTS set; Courchevel gets the altiport frequency,
		// a plain mountain airfield keeps 123.500.
		const out = applyFrAutoInfoFrequency([
			ap({ ident: 'LFLJ', type: 'small_airport', source: 'fr' }),
			ap({ ident: 'LFKD', type: 'small_airport', source: 'fr' }),
		]);
		expect(out[0].radios).toEqual([{ freq: '123.065', unit: 'A/A', call: '' }]);
		expect(out[1].radios).toEqual([AA]);
	});

	it('leaves a French field that already publishes a frequency untouched', () => {
		const radios = [{ freq: '118.7', unit: 'TWR', call: 'ORLY' }];
		const out = applyFrAutoInfoFrequency([
			ap({ ident: 'LFPO', type: 'small_airport', source: 'fr', radios }),
		]);
		expect(out[0].radios).toEqual(radios);
	});

	it('does not touch medium / large French fields with no frequency', () => {
		const out = applyFrAutoInfoFrequency([
			ap({ ident: 'LFM1', type: 'medium_airport', source: 'fr' }),
			ap({ ident: 'LFL1', type: 'large_airport', source: 'fr' }),
		]);
		expect(out[0].radios).toEqual([]);
		expect(out[1].radios).toEqual([]);
	});

	it('only applies to French (source fr) fields', () => {
		const out = applyFrAutoInfoFrequency([
			ap({ ident: 'XXXX', type: 'small_airport', source: null }),
			ap({ ident: 'EGYY', type: 'small_airport', source: 'uk' }),
			ap({ ident: 'LEYY', type: 'small_airport', source: 'es' }),
		]);
		expect(out.every((a) => a.radios.length === 0)).toBe(true);
	});

	it('keeps a real baseline frequency for a field the SIA mis-types as small (Jersey)', () => {
		// SIA lists EGJJ as a small field with no frequency; OurAirports carries
		// its real tower, so after the merge the field keeps it (no A/A added).
		const base = [
			ap({ ident: 'EGJJ', type: 'large_airport', radios: [{ freq: '119.45', unit: 'TWR', call: 'JERSEY' }] }),
		];
		const fr = [ap({ ident: 'EGJJ', type: 'small_airport', radios: [], source: 'fr' })];
		const merged = applyFrAutoInfoFrequency(mergeAixmOverlay(base, fr));
		expect(merged[0].radios).toEqual([{ freq: '119.45', unit: 'TWR', call: 'JERSEY' }]);
	});
});

describe('applyDeMilitaryStatus', () => {
	it('flags a German military aerodrome the DFS AIXM never publishes', () => {
		// ETNN Nörvenich reaches the app as an OurAirports row only, the DFS
		// dataset being the civil AIP; the ICAO chart draws it military.
		const out = applyDeMilitaryStatus([
			ap({ ident: 'ETNN', type: 'medium_airport', name: 'Nörvenich Air Base' }),
		]);
		expect(out[0].military).toBe(true);
		expect(out[0].joint).toBe(false);
		expect(airportStatus(out[0])).toBe('military');
	});

	it('flags the five fields the AIP gives a civil category too', () => {
		const out = applyDeMilitaryStatus([
			ap({ ident: 'ETSI', name: 'Ingolstadt Manching Airport' }),
			ap({ ident: 'ETNL', name: 'Rostock-Laage Airport' }),
		]);
		expect(out.map((a) => a.joint)).toEqual([true, true]);
		expect(out.map((a) => a.military)).toEqual([true, true]);
		expect(out.map(airportStatus)).toEqual(['joint', 'joint']);
	});

	it('reads military even when the baseline calls the field open to the public', () => {
		// airportStatus() treats military + access "cap" as the French joint
		// bridge, so the table leaves access alone rather than writing "cap".
		const out = applyDeMilitaryStatus([ap({ ident: 'ETAR', access: null, vfr: true })]);
		expect(airportStatus(out[0])).toBe('military');
	});

	it('leaves a row an AIXM publisher claimed alone', () => {
		const out = applyDeMilitaryStatus([ap({ ident: 'ETNN', source: 'de' })]);
		expect(out[0].military).toBe(false);
	});

	it('leaves an unlisted ET ident alone', () => {
		// ETOR and the other former bases OurAirports carries keep their
		// baseline status.
		const out = applyDeMilitaryStatus([ap({ ident: 'ETOR', type: 'closed' })]);
		expect(out[0].military).toBe(false);
		expect(out[0].joint).toBe(false);
	});

	it('lists only idents the committed baseline actually carries', () => {
		// An OurAirports ident change or removal would otherwise drop a
		// military symbol silently.
		const doc = JSON.parse(readFileSync('public/data/airports.json', 'utf8')) as {
			fields: string[];
			rows: unknown[][];
		};
		const identCol = doc.fields.indexOf('ident');
		const idents = new Set(doc.rows.map((r) => String(r[identCol])));
		const listed = applyDeMilitaryStatus(
			[...idents].filter((i) => i.startsWith('ET')).map((ident) => ap({ ident })),
		).filter((a) => a.military);
		expect(listed).toHaveLength(28);
		expect(listed.filter((a) => a.joint)).toHaveLength(5);
	});
});
