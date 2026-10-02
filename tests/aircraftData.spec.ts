/* The committed aircraft library under public/data/aircraft/: every YAML
 * data sheet parses, the meta sidecar (which doubles as the file index)
 * matches the directory, and a few figures are pinned to the source
 * workbook so a stray edit is caught. */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseAircraftYaml, aircraftKey, type Aircraft, type TablePerformance } from '$lib/aircraft/schema';
import { performanceMassKg } from '$lib/components/flightprep/shared';
import { interpolateTable } from '$lib/aircraft/performance';
import type { AircraftMeta } from '$lib/data/meta';

const meta = JSON.parse(
	readFileSync(new URL('../public/data/aircraft.meta.json', import.meta.url), 'utf-8'),
) as AircraftMeta;

function load(file: string): Aircraft {
	return parseAircraftYaml(
		readFileSync(new URL(`../public/data/aircraft/${file}`, import.meta.url), 'utf-8'),
	);
}

describe('committed aircraft library', () => {
	it('meta.files matches the directory and aircraftCount', () => {
		const dir = readdirSync(new URL('../public/data/aircraft/', import.meta.url)).sort();
		expect([...meta.files].sort()).toEqual(dir);
		expect(meta.aircraftCount).toBe(meta.files.length);
	});

	it('every committed file parses with a unique key', () => {
		const keys = meta.files.map((f) => aircraftKey(load(f)));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('counts in the meta match the parsed types', () => {
		const byType: Record<string, number> = {};
		for (const f of meta.files) {
			const t = load(f).identity.type;
			byType[t] = (byType[t] ?? 0) + 1;
		}
		expect(byType).toEqual(meta.counts);
	});

	it('pins the ICAO Doc 8643 type designators', () => {
		// DR40 covers every DR-400 variant (incl. the Rotax /100 and the /140B);
		// both fixed-gear PA-28s are P28A (the -181 Archer included, not P28B);
		// the retractable Arrow is P28R; the Cirrus SR22 is SR22.
		expect(load('f-gorq.yaml').identity.icaoType).toBe('DR40');
		expect(load('f-gnpj.yaml').identity.icaoType).toBe('DR40');
		expect(load('f-gikp.yaml').identity.icaoType).toBe('DR40');
		expect(load('f-gieq.yaml').identity.icaoType).toBe('P28A');
		expect(load('f-girv.yaml').identity.icaoType).toBe('P28A');
		expect(load('f-brue.yaml').identity.icaoType).toBe('P28R');
		expect(load('f-hpcp.yaml').identity.icaoType).toBe('SR22');
	});

	it('every icaoType is a designator listed in FAA JO 7360.1', () => {
		// The pins above are the wrong-but-valid guard; this membership
		// check catches typos on ANY committed tail. The FAA order (public
		// domain, unlike Doc 8643 itself) covers the types commonly
		// receiving ATC services, a subset of Doc 8643: a real designator
		// missing here means verify against Doc 8643, then refresh the
		// dataset (cmd/designators).
		const data = JSON.parse(
			readFileSync(new URL('../public/data/faa-designators.json', import.meta.url), 'utf-8'),
		) as { designators: string[]; types: [string, string, string][] };
		const designators = new Set(data.designators);
		for (const f of meta.files) {
			const icao = load(f).identity.icaoType;
			if (icao) {
				expect(designators.has(icao), `${f}: icaoType ${icao} not in FAA JO 7360.1`).toBe(true);
			}
		}
	});

	it('the FAA designator dataset agrees with its meta sidecar', () => {
		const data = JSON.parse(
			readFileSync(new URL('../public/data/faa-designators.json', import.meta.url), 'utf-8'),
		) as { designators: string[]; types: [string, string, string][] };
		const dsMeta = JSON.parse(
			readFileSync(new URL('../public/data/faa-designators.meta.json', import.meta.url), 'utf-8'),
		) as { designatorCount: number; modelCount: number };
		expect(data.designators).toEqual([...new Set(data.designators)].sort());
		expect(data.designators.length).toBe(dsMeta.designatorCount);
		expect(data.types.length).toBe(dsMeta.modelCount);
		const designators = new Set(data.designators);
		for (const [code] of data.types) {
			expect(designators.has(code), `tuple code ${code} missing from the designator set`).toBe(true);
		}
	});

	it('pins F-GJQK to the 2026 weighing + 912iSc conversion', () => {
		const a = load('f-gjqk.yaml');
		expect(a.identity.registration).toBe('F-GJQK');
		// Re-engined to the 912iSc: typed and named as sister ship F-GIKP.
		expect(a.identity.type).toBe('DR400/100');
		expect(a.identity.name).toBe('Robin DR400/100 912iSc Sport');
		// Re-engined to the Rotax 912iSc (as F-GIKP): mogas-capable, 17 L/h.
		expect(a.fuel!.consumptionLph).toBe(17);
		expect(a.fuel!.types).toEqual(['100LL', 'UL91', 'SUPER AERO+']);
		expect(a.fuel!.type).toBe('100LL');
		expect(a.cruise!.speedKt).toBe(100);
		// Weighing of 2026-06-10 at Vannes (LFRV): 540.5 kg @ 0.397 m.
		expect(a.massBalance!.emptyMassKg).toBe(540.5);
		expect(a.massBalance!.emptyArmM).toBe(0.397);
		expect(a.massBalance!.fuelArmM).toBe(1.12);
		// The 912iSc STC condemns the /120's baggage compartment and allows one
		// rear seat (its weighing report lists three seats): two stations, as
		// on F-GIKP.
		expect(a.massBalance!.stations.map((s) => s.label)).toEqual(['Front seats', 'Rear seats']);
		// 912iSc STC centrogramme (as F-GIKP), 865 kg max: forward-top 0.513 @ 865,
		// floor below the weighed empty mass.
		expect(a.massBalance!.envelope).toHaveLength(5);
		expect(a.massBalance!.envelope[2]).toEqual({ armM: 0.513, massKg: 865 });
		expect(a.massBalance!.envelope[0].massKg).toBeLessThan(a.massBalance!.emptyMassKg);
		const p = a.performance!;
		expect(p.kind).toBe('table');
		if (p.kind === 'table') {
			expect(p.massMaxKg).toBe(865);
			expect(p.takeoff.rows).toHaveLength(9);
			expect(p.landing.rows).toHaveLength(9);
			// The STC keeps the /120 POH cells: sea level, ISA, mass max -> 235 / 535 m.
			const sl = p.takeoff.rows.find((r) => r.altFt === 0 && r.isaOffsetC === 0)!;
			expect(sl.massMax).toEqual([235, 535]);
		}
	});

	it('pins the certified DR400/120 envelope on the four stock /120s', () => {
		// MdV DR400/120 chapter II e): 0.205 m at 750 kg and below, 0.428 m at
		// 900 kg, aft 0.564 m; F-GORQ's weighing report prints the same.
		for (const f of ['f-gorq.yaml', 'f-gkqc.yaml', 'f-gldt.yaml', 'f-gsbq.yaml']) {
			expect(load(f).massBalance!.envelope).toEqual([
				{ armM: 0.205, massKg: 500 },
				{ armM: 0.205, massKg: 750 },
				{ armM: 0.428, massKg: 900 },
				{ armM: 0.564, massKg: 900 },
				{ armM: 0.564, massKg: 500 },
			]);
		}
	});

	it('pins the 912iS STC envelope on its six tails, one floor below every empty mass', () => {
		// EASA STC 10059108, supplement section 6: 0.205 m at 750 kg and below,
		// 0.513 m at 865 kg, aft 0.564 m, no minimum mass (F-GLDS weighs 530 kg).
		for (const f of ['f-gikp.yaml', 'f-gjqk.yaml', 'f-gkrd.yaml', 'f-glds.yaml', 'f-gnna.yaml', 'f-hato.yaml']) {
			const mb = load(f).massBalance!;
			expect(mb.envelope).toEqual([
				{ armM: 0.205, massKg: 500 },
				{ armM: 0.205, massKg: 750 },
				{ armM: 0.513, massKg: 865 },
				{ armM: 0.564, massKg: 865 },
				{ armM: 0.564, massKg: 500 },
			]);
			expect(mb.envelope[0].massKg).toBeLessThan(mb.emptyMassKg);
		}
	});

	it('pins the published station maxima, each from its manual or placard', () => {
		const maxima = (f: string) =>
			Object.fromEntries(
				load(f)
					.massBalance!.stations.filter((s) => s.maxMassKg != null)
					.map((s) => [s.label, s.maxMassKg]),
			);
		expect(maxima('f-gieq.yaml')).toEqual({ Baggage: 23 }); // VB-1375 2.11 d)
		expect(maxima('f-girv.yaml')).toEqual({ Baggage: 91 }); // VB-1086 2.11 b)
		for (const f of ['f-gorq.yaml', 'f-gkqc.yaml', 'f-gldt.yaml', 'f-gsbq.yaml']) {
			expect(maxima(f)).toEqual({ Baggage: 40 }); // DR400/120 placard
		}
		expect(maxima('f-glds.yaml')).toEqual({ Baggage: 40 }); // the DR400/100 coffre
		expect(maxima('f-hpcp.yaml')).toEqual({ Baggage: 59 }); // POH 13772-002: 130 lb
		// The /120 manual's edition 10 (2.05 loading plan) states 135 kg aft; the
		// 1975 edition F-GKRD carries states none.
		expect(maxima('f-gnna.yaml')).toEqual({ 'Rear seats': 135 });
		expect(maxima('f-hato.yaml')).toEqual({ 'Rear seats': 135 });
		// No published limit found for these stations (and the 912iSc tails
		// carry no baggage station at all).
		for (const f of ['f-brue.yaml', 'f-gnpj.yaml', 'f-gikp.yaml', 'f-gkrd.yaml']) {
			expect(maxima(f)).toEqual({});
		}
	});

	it('pins F-GORQ empty mass / arm', () => {
		const a = load('f-gorq.yaml');
		expect(a.massBalance!.emptyMassKg).toBe(570);
		expect(a.massBalance!.emptyArmM).toBe(0.348);
	});

	it('pins the manual-sourced climb sections (912iSc tails have none)', () => {
		// MdV DR400/120 page 5.3: Vz 3,0 m/s (590 ft/min) at 140 km/h (76 kt).
		expect(load('f-gorq.yaml').climb).toEqual({ speedKt: 76, rateFtMin: 590 });
		// VB-1375 figure 5-17 / VB-1086 figure 5-15 sea-level standard reads.
		expect(load('f-gieq.yaml').climb).toEqual({ speedKt: 79, rateFtMin: 675 });
		expect(load('f-girv.yaml').climb).toEqual({ speedKt: 76, rateFtMin: 735 });
		// Cirrus POH 13772-002 enroute rate of climb, SL ISA at 3400 lb.
		expect(load('f-hpcp.yaml').climb).toEqual({ speedKt: 101, rateFtMin: 1398 });
		// The 912iSc STC supplement publishes climb speeds but no rate, and the
		// original /120 chart is invalid for the re-engined airframe: no climb
		// section, the profile falls back to its 3-degree default.
		expect(load('f-gikp.yaml').climb).toBeUndefined();
		expect(load('f-gjqk.yaml').climb).toBeUndefined();
		// Descent is deliberately absent everywhere: the manuals publish no
		// cruise-descent figure and the sheets stay manual-faithful.
		expect(load('f-gorq.yaml').descent).toBeUndefined();
	});

	it('pins F-GKQC (Aiglons DR400/120: own weighing over the shared /120 data)', () => {
		const a = load('f-gkqc.yaml');
		expect(a.identity.type).toBe('DR400/120');
		expect(a.identity.operator).toBe('Aéroclub Les Aiglons');
		// Per-tail 2015 weighing; the rest of the sheet is the shared /120 data.
		expect(a.massBalance!.emptyMassKg).toBe(599);
		expect(a.massBalance!.emptyArmM).toBe(0.268);
		expect(a.massBalance!.stations.map((s) => s.label)).toEqual([
			'Front seats',
			'Rear seats',
			'Baggage',
		]);
		const p = a.performance!;
		expect(p.kind).toBe('table');
		if (p.kind === 'table') {
			expect(p.massMaxKg).toBe(900);
			// Same /120 POH as F-GORQ: sea level, ISA, mass max -> 235 / 535 m.
			const sl = p.takeoff.rows.find((r) => r.altFt === 0 && r.isaOffsetC === 0)!;
			expect(sl.massMax).toEqual([235, 535]);
		}
	});

	it('pins F-GLDS (Sadi Lecointe 912iS: 865 kg, 40 kg coffre at 1.10 m)', () => {
		const a = load('f-glds.yaml');
		expect(a.identity.type).toBe('DR400/100');
		expect(a.identity.operator).toBe('Aéroclub Sadi Lecointe');
		expect(a.massBalance!.emptyMassKg).toBe(530);
		// MdV DR400/100 1.08: 110 L total, 100 L usable, 10 L unusable (which the
		// weighing report includes in the empty mass).
		expect(a.fuel!.capacityL).toBe(110);
		expect(a.fuel!.usableL).toBe(100);
		// A 2-seat + coffre airframe: the second station is the 40 kg coffre.
		expect(a.massBalance!.stations.map((s) => ({ label: s.label, armM: s.armM }))).toEqual([
			{ label: 'Front seats', armM: 0.41 },
			{ label: 'Baggage', armM: 1.1 },
		]);
		// Shared 912iSc STC centrogramme + 865 kg cap (as F-GIKP).
		expect(a.massBalance!.envelope[2]).toEqual({ armM: 0.513, massKg: 865 });
		const p = a.performance!;
		if (p.kind === 'table') {
			expect(p.massMaxKg).toBe(865);
		}
	});

	it('pins F-GIKP (DR400/100, 865 kg anchor, 17 L/h, mogas-capable)', () => {
		const a = load('f-gikp.yaml');
		expect(a.fuel!.consumptionLph).toBe(17);
		// The Rotax 912iSc takes the unleaded grades too; the others are 100LL-only.
		expect(a.fuel!.types).toEqual(['100LL', 'UL91', 'SUPER AERO+']);
		expect(a.fuel!.type).toBe('100LL');
		const p = a.performance!;
		if (p.kind === 'table') {
			expect(p.massMaxKg).toBe(865);
		}
		// The 912iSc STC condemns the /120's baggage compartment: two stations.
		expect(a.massBalance!.stations.map((s) => s.label)).toEqual(['Front seats', 'Rear seats']);
		expect(a.massBalance!.envelope[2]).toEqual({ armM: 0.513, massKg: 865 });
		// The STC supplement's limit lines arrow downward (no minimum mass):
		// the floor sits below the empty mass so a light zero-fuel state stays
		// judged by the arm limits only.
		expect(a.massBalance!.envelope[0]).toEqual({ armM: 0.205, massKg: 500 });
		expect(a.massBalance!.envelope[0].massKg).toBeLessThan(a.massBalance!.emptyMassKg);
	});

	it('pins F-GIEQ (PA28-161: manual fuel figures, tabs preset, closed form)', () => {
		const a = load('f-gieq.yaml');
		// VB-1375 2.21: 50 US gal total, 48 usable; 7.13: 17 US gal (64 L)
		// usable per tank at the base of the filler neck indicator.
		expect(a.fuel!.capacityL).toBe(189);
		expect(a.fuel!.usableL).toBe(182);
		expect(a.fuel!.presets).toEqual([{ name: 'tabs', litres: 128 }]);
		// VB-1375 2.13, not the weighing report's rounded sketch (2,10 / 890).
		expect(a.massBalance!.envelope).toEqual([
			{ armM: 2.108, massKg: 500 },
			{ armM: 2.108, massKg: 885 },
			{ armM: 2.21, massKg: 1055 },
			{ armM: 2.362, massKg: 1055 },
			{ armM: 2.362, massKg: 500 },
		]);
		const p = a.performance!;
		expect(p.kind).toBe('closed-form');
		if (p.kind === 'closed-form') {
			expect(p.massReferenceLb).toBe(2325);
			expect(p.configs).toHaveLength(3);
			const landing = p.configs.find((c) => c.phase === 'landing')!;
			expect(landing.massExponent).toBe(0);
			expect(landing.flapsDeg).toBe(40);
			for (const c of p.configs.filter((x) => x.phase === 'takeoff')) {
				expect(c.massExponent).toBe(2);
			}
			// The manual's two take-offs, in sheet order (an older build
			// falls back to the LAST take-off config, flaps 25, as before).
			expect(p.configs.map((c) => [c.phase, c.flapsDeg, c.procedure, c.default])).toEqual([
				['takeoff', 0, 'normal', undefined],
				['takeoff', 25, 'short-field', undefined],
				['landing', 40, undefined, true],
			]);
		}
	});

	it('pins F-GIRV (PA28-181: manual fuel figures, closed form, landing mass grid)', () => {
		const a = load('f-girv.yaml');
		expect(a.identity.registration).toBe('F-GIRV');
		expect(aircraftKey(a)).toBe('F-GIRV');
		expect(a.fuel!.capacityL).toBe(189);
		expect(a.fuel!.usableL).toBe(182);
		// VB-1086 2.25 placard and 8.21 c): 64 L usable per tank to the tabs.
		expect(a.fuel!.presets).toEqual([{ name: 'tabs', litres: 128 }]);
		// M&B: the 2015-05-20 weighing + the manual's section 6 envelope.
		expect(a.massBalance!.emptyMassKg).toBe(748.5);
		expect(a.massBalance!.emptyArmM).toBe(2.236);
		expect(a.massBalance!.fuelArmM).toBe(2.413);
		expect(a.massBalance!.stations.map((s) => s.label)).toEqual(['Front seats', 'Rear seats', 'Baggage']);
		expect(a.massBalance!.envelope).toHaveLength(5);
		expect(a.massBalance!.envelope[2]).toEqual({ armM: 2.25, massKg: 1157 });
		const p = a.performance!;
		expect(p.kind).toBe('closed-form');
		if (p.kind === 'closed-form') {
			expect(p.massReferenceLb).toBe(2550);
			expect(p.configs).toHaveLength(3);
			const landing = p.configs.find((c) => c.phase === 'landing')!;
			expect(landing.flapsDeg).toBe(40);
			expect(landing.massExponent).toBe(1);
			for (const c of p.configs.filter((x) => x.phase === 'takeoff')) {
				expect(c.massExponent).toBe(2);
			}
			expect(p.configs.map((c) => [c.phase, c.flapsDeg, c.procedure, c.default])).toEqual([
				['takeoff', 0, 'normal', undefined],
				['takeoff', 25, 'short-field', undefined],
				['landing', 40, undefined, true],
			]);
		}
		// When no M&B resolves (e.g. the fuel plan is incomplete) the
		// performance page falls back to the chart reference mass.
		expect(performanceMassKg(null, a)).toBeCloseTo(2550 / 2.20462, 3);
	});

	it('pins F-HPCP (SR22: POH table resampled to ISA offsets, 3400 / 2900 lb)', () => {
		const a = load('f-hpcp.yaml');
		expect(a.identity.type).toBe('SR22');
		expect(a.identity.operator).toBe('Aéroclub Sadi Lecointe');
		expect(a.massBalance!.emptyMassKg).toBe(1071.0);
		expect(a.fuel!.usableL).toBe(348); // 92 US gal (G3 wing)
		// POH section 7: each tank to the tab below its filler, 30 US gal usable.
		expect(a.fuel!.presets).toEqual([{ name: 'tabs', litres: 227 }]);
		const p = a.performance as TablePerformance;
		expect(p.kind).toBe('table');
		expect(p.massMaxKg).toBe(1542);
		expect(p.massMinKg).toBe(1315);
		// The POH ISA column at sea level / 3400 lb: over-50 ft = 1594 ft = 486 m.
		const r = interpolateTable(p, 'takeoff', 1542, 0, 15);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.distances.distance15mM).toBeCloseTo(486, 0);
	});

	it('pins F-GNPJ (DR400/140B: /160 table interpolated to 1000 kg, reproduces the chart example)', () => {
		const a = load('f-gnpj.yaml');
		expect(a.identity.type).toBe('DR400/140B');
		expect(a.identity.operator).toBe('Aéroclub Les Aiglons');
		expect(a.massBalance!.emptyMassKg).toBe(604);
		const p = a.performance as TablePerformance;
		expect(p.massMaxKg).toBe(1000);
		expect(p.massMinKg).toBe(850);
		// The manual's worked example: 950 kg / 2000 ft / +5 C -> ~550 m take-off,
		// ~510 m landing over the 15 m obstacle.
		const to = interpolateTable(p, 'takeoff', 950, 2000, 5);
		const ld = interpolateTable(p, 'landing', 950, 2000, 5);
		expect(to.ok && ld.ok).toBe(true);
		if (to.ok) {
			expect(to.distances.distance15mM).toBeGreaterThan(520);
			expect(to.distances.distance15mM).toBeLessThan(580);
		}
		if (ld.ok) {
			expect(ld.distances.distance15mM).toBeGreaterThan(495);
			expect(ld.distances.distance15mM).toBeLessThan(540);
		}
	});

	it('pins F-BRUE (PA28R-200: handbook DA nomograms, 2600 lb)', () => {
		const a = load('f-brue.yaml');
		expect(a.identity.type).toBe('PA28R-200');
		expect(a.identity.operator).toBe('Aéroclub Les Aiglons');
		expect(a.massBalance!.emptyMassKg).toBe(703);
		expect(a.massBalance!.emptyArmM).toBe(2.169);
		const p = a.performance as TablePerformance;
		expect(p.massMaxKg).toBe(1179);
		// The configuration the handbook charts at, which the page shows.
		expect([p.takeoffFlapsDeg, p.landingFlapsDeg, p.takeoffProcedure]).toEqual([25, 40, undefined]);
		// Handbook sea-level anchors (2600 lb): take-off 25 deg flaps 1600 ft =
		// 488 m over 50 ft, landing 40 deg flaps 1380 ft = 421 m.
		const to = interpolateTable(p, 'takeoff', 1179, 0, 15);
		const ld = interpolateTable(p, 'landing', 1179, 0, 15);
		expect(to.ok).toBe(true);
		expect(ld.ok).toBe(true);
		if (to.ok) expect(to.distances.distance15mM).toBeCloseTo(488, 0);
		if (ld.ok) expect(ld.distances.distance15mM).toBeCloseTo(421, 0);
	});
});
