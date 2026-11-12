/* Unit tests for the aircraft data-sheet YAML (src/lib/aircraft/schema.ts):
 * parsing, defaults, grid validation, readable failures, round-trip. */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
	parseAircraftYaml,
	stringifyAircraftYaml,
	aircraftDocVersion,
	aircraftKey,
	engineCount,
	enduranceMin,
	fuelDensityKgPerL,
	gradientFtPerNM,
	isMultiEngine,
	type ClosedFormPerformance,
	type TablePerformance,
} from '$lib/aircraft/schema';

const TABLE_DOC = `
version: 1
aircraft:
  registration: F-TEST
  type: DR400/120
  name: Test Dauphin
  operator: Aéroclub Test
fuel:
  capacityL: 100
  consumptionLph: 24
cruise:
  speedKt: 100
climb:
  speedKt: 78
  rateFtMin: 650
descent:
  speedKt: 110
  rateFtMin: 500
massAndBalance:
  emptyMassKg: 579
  emptyArmM: 0.35
  stations:
    - { label: Front seats, armM: 0.41, defaultMassKg: 80 }
    - { label: Rear seats, armM: 1.19, defaultMassKg: 10 }
  fuelArmM: 1.12
  envelope:
    - { armM: 0.2, massKg: 660 }
    - { armM: 0.428, massKg: 900 }
    - { armM: 0.564, massKg: 660 }
performance:
  kind: table
  massMaxKg: 900
  massMinKg: 700
  wind:
    takeoffHeadwind: [[0, 1], [10, 0.85]]
    landingHeadwind: [[0, 1], [10, 0.78]]
  takeoff:
    - { altFt: 4000, isaOffsetC: 0, massMax: [345, 720], massMin: [195, 415] }
    - { altFt: 0, isaOffsetC: 0, massMax: [235, 535], massMin: [145, 315] }
    - { altFt: 0, isaOffsetC: 20, massMax: [285, 590], massMin: [165, 345] }
    - { altFt: 4000, isaOffsetC: 20, massMax: [390, 800], massMin: [220, 460] }
  landing:
    - { altFt: 0, isaOffsetC: 0, massMax: [200, 460], massMin: [155, 385] }
    - { altFt: 0, isaOffsetC: 20, massMax: [210, 485], massMin: [165, 400] }
    - { altFt: 4000, isaOffsetC: 0, massMax: [225, 505], massMin: [175, 420] }
    - { altFt: 4000, isaOffsetC: 20, massMax: [240, 535], massMin: [185, 440] }
`;

describe('parseAircraftYaml', () => {
	it('parses a table-performance document and applies the defaults', () => {
		const a = parseAircraftYaml(TABLE_DOC);
		expect(a.identity).toEqual({
			registration: 'F-TEST',
			type: 'DR400/120',
			name: 'Test Dauphin',
			operator: 'Aéroclub Test',
		});
		expect(a.fuel!.usableL).toBe(100); // defaults to capacity
		expect(a.fuel!.types).toEqual(['100LL']); // default grade list
		expect(a.fuel!.type).toBe('100LL');
		expect(fuelDensityKgPerL(a.fuel!)).toBe(0.72);
		expect(a.fuel!.presets).toEqual([]);
		expect(a.cruise!.speedKt).toBe(100);
		expect(a.climb).toEqual({ speedKt: 78, rateFtMin: 650 });
		expect(a.descent).toEqual({ speedKt: 110, rateFtMin: 500 });
		expect(gradientFtPerNM(a.climb!)).toBeCloseTo(500, 9); // 650 * 60 / 78
		expect(gradientFtPerNM(a.descent!)).toBeCloseTo(272.727, 3);
		expect(a.massBalance!.stations).toHaveLength(2);
		expect(a.massBalance!.envelope).toHaveLength(3);
		const p = a.performance!;
		expect(p.kind).toBe('table');
		if (p.kind === 'table') {
			expect(p.marginFactor).toBe(1.3);
			expect(p.grassFactor).toBe(1.15);
			expect(p.wetFactor).toBe(1.15);
			expect(p.wind.tailwindPctPer2Kt).toBe(10);
			// Axes derived, sorted ascending; rows sorted by (alt, offset).
			expect(p.takeoff.altitudesFt).toEqual([0, 4000]);
			expect(p.takeoff.axis).toBe('isa-offset');
			expect(p.takeoff.temperaturesC).toEqual([0, 20]);
			expect(p.takeoff.rows[0]).toMatchObject({ altFt: 0, tempC: 0 });
			expect(p.takeoff.rows[3]).toMatchObject({ altFt: 4000, tempC: 20 });
		}
		expect(aircraftKey(a)).toBe('F-TEST');
		expect(enduranceMin(a)).toBeCloseTo(250, 9);
	});

	it('parses a partial document; the key falls back to the type', () => {
		const a = parseAircraftYaml(
			'version: 1\naircraft: { type: PA28-181 }\nfuel: { capacityL: 182 }\n',
		);
		expect(a.massBalance).toBeUndefined();
		expect(a.performance).toBeUndefined();
		expect(a.cruise).toBeUndefined();
		expect(a.climb).toBeUndefined();
		expect(a.descent).toBeUndefined();
		expect(aircraftKey(a)).toBe('PA28-181');
		expect(enduranceMin(a)).toBeNull(); // no consumption
	});

	it('knows the Jet A-1 grade at the density the flight manuals load it at', () => {
		const a = parseAircraftYaml(
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, types: [JET A-1] }\n',
		);
		expect(a.fuel!.type).toBe('JET A-1');
		// DA 40 NG AFM 6.01.15-E Rev. 3, 6.4.3: 0.84 kg/liter (7.01 lb/US gal).
		expect(fuelDensityKgPerL(a.fuel!)).toBe(0.84);
	});

	it('reads a fuel grade listed twice once', () => {
		// The Aircraft tab and the editor key their grade lists on the grade,
		// where Svelte throws on a repeat. Normalised rather than refused: a
		// stored plane that no longer parses is dropped at boot.
		const a = parseAircraftYaml(
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, types: [100LL, UL91, 100LL] }\n',
		);
		expect(a.fuel!.types).toEqual(['100LL', 'UL91']);
	});

	it('ignores unknown keys at every level', () => {
		const a = parseAircraftYaml(
			'version: 1\nextra: 1\naircraft: { type: X, color: blue }\nfuel: { capacityL: 10, vendor: shell }\n',
		);
		expect(a.identity.type).toBe('X');
		expect(a.fuel!.capacityL).toBe(10);
	});

	it.each([
		['version: 3\naircraft: { type: X }', /unsupported version 3 \(expected 1 or 2\)/],
		['version: 1\naircraft: {}', /aircraft\.type/],
		['version: 1', /aircraft must be a mapping/],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 1, emptyArmM: 0, stations: [], fuelArmM: 1, envelope: [{ armM: 0, massKg: 1 }, { armM: 1, massKg: 1 }] }',
			/envelope needs at least 3 vertices/,
		],
		[
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, usableL: 120 }',
			/usableL must be <= /,
		],
		[
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, presets: [{ name: tabs, litres: 128 }] }',
			/presets\[0\]\.litres must be <= /,
		],
		[
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, types: [JETA1] }',
			/fuel\.types\[0\] must be one of/,
		],
		[
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, types: [100LL], type: UL91 }',
			/fuel\.type must be one of the plane's/,
		],
		[
			'version: 1\naircraft: { type: X }\nclimb: { speedKt: 0, rateFtMin: 650 }',
			/climb\.speedKt must be > 0/,
		],
		[
			'version: 1\naircraft: { type: X }\ndescent: { speedKt: 110 }',
			/descent\.rateFtMin/,
		],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 600, emptyArmM: 0.3, stations: [{ label: Baggage, armM: 1.9, defaultMassKg: 0, maxMassKg: 0 }], fuelArmM: 1.12, envelope: [{ armM: 0.2, massKg: 500 }, { armM: 0.5, massKg: 900 }, { armM: 0.5, massKg: 500 }] }',
			/stations\[0\]\.maxMassKg must be > 0/,
		],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 600, emptyArmM: 0.3, stations: [{ label: Baggage, armM: 1.9, defaultMassKg: 30, maxMassKg: 23 }], fuelArmM: 1.12, envelope: [{ armM: 0.2, massKg: 500 }, { armM: 0.5, massKg: 900 }, { armM: 0.5, massKg: 500 }] }',
			/stations\[0\]\.defaultMassKg must be <= maxMassKg/,
		],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 600, emptyArmM: 0.3, stations: [{ label: Front, armM: 0.4, defaultMassKg: 80 }], fuelArmM: 1.12, envelope: [{ armM: 0.2, massKg: 500 }, { armM: 0.5, massKg: 900 }, { armM: 0.5, massKg: 500 }], maxLandingMassKg: 600 }',
			/maxLandingMassKg must be above emptyMassKg/,
		],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 600, emptyArmM: 0.3, stations: [{ label: Front, armM: 0.4, defaultMassKg: 80 }], fuelArmM: 1.12, envelope: [{ armM: 0.2, massKg: 500 }, { armM: 0.5, massKg: 900 }, { armM: 0.5, massKg: 500 }], maxLandingMassKg: 950 }',
			/maxLandingMassKg must be <= the envelope's maximum mass \(900\)/,
		],
		[
			'version: 1\naircraft: { type: X }\nmassAndBalance: { emptyMassKg: 600, emptyArmM: 0.3, stations: [{ label: Front, armM: 0.4, defaultMassKg: 80 }], fuelArmM: 1.12, envelope: [{ armM: 0.2, massKg: 500 }, { armM: 0.5, massKg: 900 }, { armM: 0.5, massKg: 500 }], maxZeroFuelMassKg: -1 }',
			/maxZeroFuelMassKg must be > 0/,
		],
	])('fails readably on bad data', (doc, re) => {
		expect(() => parseAircraftYaml(doc)).toThrow(re);
	});

	it('rejects an incomplete performance grid', () => {
		// Drop one row of the 2x2 takeoff grid.
		const doc = TABLE_DOC.replace(
			'    - { altFt: 4000, isaOffsetC: 20, massMax: [390, 800], massMin: [220, 460] }\n',
			'',
		);
		expect(() => parseAircraftYaml(doc)).toThrow(/full altitude x ISA-offset grid/);
	});

	describe('outside-air-temperature tables', () => {
		const OAT_DOC = `
version: 1
aircraft: { type: C172S }
performance:
  kind: table
  massMaxKg: 1157
  massMinKg: 998
  wind: { takeoffHeadwind: [[0, 1], [9, 0.9]], landingHeadwind: [[0, 1], [9, 0.9]] }
  takeoff:
    - { altFt: 2000, temperatureC: 0, massMax: [300, 500], massMin: [250, 420] }
    - { altFt: 0, temperatureC: 10, massMax: [260, 450], massMin: [210, 370] }
    - { altFt: 0, temperatureC: 0, massMax: [250, 430], massMin: [200, 360] }
    - { altFt: 2000, temperatureC: 10, massMax: [320, 540], massMin: [265, 450] }
  landing:
    - { altFt: 0, isaOffsetC: 0, massMax: [170, 400], massMin: [170, 400] }
    - { altFt: 0, isaOffsetC: 20, massMax: [180, 420], massMin: [180, 420] }
    - { altFt: 2000, isaOffsetC: 0, massMax: [180, 420], massMin: [180, 420] }
    - { altFt: 2000, isaOffsetC: 20, massMax: [190, 440], massMin: [190, 440] }
`;
		const takeoffRow = '    - { altFt: 2000, temperatureC: 10, massMax: [320, 540], massMin: [265, 450] }\n';

		it('reads the axis from the row key, one per table, rows sorted', () => {
			const p = parseAircraftYaml(OAT_DOC).performance as TablePerformance;
			expect(p.takeoff.axis).toBe('oat');
			expect(p.takeoff.temperaturesC).toEqual([0, 10]);
			expect(p.takeoff.rows.map((r) => [r.altFt, r.tempC])).toEqual([
				[0, 0],
				[0, 10],
				[2000, 0],
				[2000, 10],
			]);
			// The landing table keeps its own (ISA-offset) axis.
			expect(p.landing.axis).toBe('isa-offset');
			expect(p.landing.temperaturesC).toEqual([0, 20]);
		});

		it('writes each table back under its own key and round-trips', () => {
			const a = parseAircraftYaml(OAT_DOC);
			const text = stringifyAircraftYaml(a);
			expect(text).toContain('temperatureC: 10');
			expect(text).toContain('isaOffsetC: 20');
			expect(parseAircraftYaml(text)).toEqual(a);
		});

		it.each([
			[OAT_DOC.replace(takeoffRow, takeoffRow.replace('temperatureC', 'isaOffsetC')), /mixes isaOffsetC and temperatureC rows/],
			[OAT_DOC.replace(takeoffRow, takeoffRow.replace('temperatureC: 10,', 'temperatureC: 10, isaOffsetC: 10,')), /has both isaOffsetC and temperatureC/],
			[OAT_DOC.replace(takeoffRow, ''), /full altitude x temperature grid/],
			[OAT_DOC.replace(takeoffRow, takeoffRow.replace('altFt: 2000, temperatureC: 10', 'altFt: 0, temperatureC: 10')).replace(
				'    - { altFt: 2000, temperatureC: 0,', '    - { altFt: 2000, temperatureC: 10,'), /duplicate \(altitude, temperature\) rows/],
		])('refuses a malformed temperature axis (%#)', (doc, re) => {
			expect(() => parseAircraftYaml(doc)).toThrow(re);
		});
	});

	describe('generic sheets', () => {
		const GENERIC = 'version: 1\naircraft: { type: C172S, name: Generic probe, generic: c172s }\n';

		it('keys a generic sheet apart from any registration or type', () => {
			const a = parseAircraftYaml(GENERIC);
			expect(a.identity.generic).toBe('c172s');
			expect(aircraftKey(a)).toBe('generic:c172s');
			const text = stringifyAircraftYaml(a);
			expect(text).toContain('generic: c172s');
			expect(parseAircraftYaml(text)).toEqual(a);
			// No flag, no change: the type stays a registration-less sheet's key.
			expect(aircraftKey(parseAircraftYaml('version: 1\naircraft: { type: C172S }\n'))).toBe('C172S');
		});

		it.each([
			[GENERIC.replace('generic: c172s', 'generic: true'), /aircraft\.generic/],
			[GENERIC.replace('generic: c172s', "generic: ''"), /aircraft\.generic/],
			[GENERIC.replace('type: C172S', 'registration: F-HXYZ, type: C172S'), /a generic sheet \(aircraft\.generic\) has no registration/],
		])('refuses a malformed generic identity (%#)', (doc, re) => {
			expect(() => parseAircraftYaml(doc)).toThrow(re);
		});
	});

	it('rejects a headwind table that does not start at [0, 1]', () => {
		const doc = TABLE_DOC.replace('takeoffHeadwind: [[0, 1], [10, 0.85]]', 'takeoffHeadwind: [[10, 0.85]]');
		expect(() => parseAircraftYaml(doc)).toThrow(/must start with the \[0, 1\] anchor/);
	});

	it('rejects closed-form coefficients that are not [a, b, c, d]', () => {
		const doc = `
version: 1
aircraft: { type: PA28 }
performance:
  kind: closed-form
  massReferenceLb: 2325
  configs:
    - phase: takeoff
      flapsDeg: 25
      massExponent: 2
      distance15m: { coefficients: [1, 2, 3], headwindPerKt: 0.01, tailwindPerKt: 0.02 }
      groundRoll: { coefficients: [1, 2, 3, 4], headwindPerKt: 0.01, tailwindPerKt: 0.02 }
`;
		expect(() => parseAircraftYaml(doc)).toThrow(/coefficients must be \[a, b, c, d\]/);
	});

	it('massExponent defaults to 0, accepts fractions, round-trips', () => {
		const metric = '{ coefficients: [1, 2, 3, 4], headwindPerKt: 0.01, tailwindPerKt: 0.02 }';
		const cfg = (head: string) => `    - phase: takeoff\n${head}      distance15m: ${metric}\n      groundRoll: ${metric}`;
		const doc = `
version: 1
aircraft: { type: PA28 }
performance:
  kind: closed-form
  massReferenceLb: 2325
  configs:
${cfg('      flapsDeg: 25\n')}
${cfg('      flapsDeg: 40\n      massExponent: 1.5\n')}
`;
		const a = parseAircraftYaml(doc);
		const p = a.performance!;
		if (p.kind !== 'closed-form') {
			throw new Error('expected closed-form');
		}
		expect(p.configs.map((c) => c.massExponent)).toEqual([0, 1.5]);
		const out = stringifyAircraftYaml(a);
		expect(out).toContain('massExponent');
		expect(parseAircraftYaml(out)).toEqual(a);
	});

	it('rejects a negative or non-numeric massExponent', () => {
		const metric = '{ coefficients: [1, 2, 3, 4], headwindPerKt: 0.01, tailwindPerKt: 0.02 }';
		const doc = (exp: string) => `
version: 1
aircraft: { type: PA28 }
performance:
  kind: closed-form
  massReferenceLb: 2325
  configs:
    - phase: landing
      flapsDeg: 40
      massExponent: ${exp}
      distance15m: ${metric}
      groundRoll: ${metric}
`;
		expect(() => parseAircraftYaml(doc('-1'))).toThrow(/massExponent must be >= 0/);
		expect(() => parseAircraftYaml(doc('squared'))).toThrow(/massExponent/);
	});

	const closedDoc = (configs: string): string => `
version: 1
aircraft: { type: PA28 }
performance:
  kind: closed-form
  massReferenceLb: 2325
  configs:
${configs}`;
	const metric = '{ coefficients: [1, 2, 3, 4], headwindPerKt: 0.01, tailwindPerKt: 0.02 }';
	const body = `      massExponent: 2\n      distance15m: ${metric}\n      groundRoll: ${metric}`;

	it('rejects two default landing configs', () => {
		const doc = closedDoc(`    - phase: landing
      flapsDeg: 25
      default: true
${body}
    - phase: landing
      flapsDeg: 40
      default: true
${body}
`);
		expect(() => parseAircraftYaml(doc)).toThrow(/at most one default landing config/);
	});

	it("drops a take-off config's default, which procedures replace, without refusing the sheet", () => {
		// The PA28 sheets marked their short-field chart default: a pilot's
		// copy saved then must keep loading, two such flags included.
		const doc = closedDoc(`    - phase: takeoff
      flapsDeg: 0
      default: true
${body}
    - phase: takeoff
      flapsDeg: 25
      default: true
${body}
    - phase: landing
      flapsDeg: 40
      default: true
${body}
`);
		const p = parseAircraftYaml(doc).performance as ClosedFormPerformance;
		expect(p.configs.map((c) => c.default)).toEqual([undefined, undefined, true]);
		expect(stringifyAircraftYaml(parseAircraftYaml(doc)).match(/default: true/g)).toHaveLength(1);
	});

	it('reads a take-off procedure, refuses an unknown one, ignores one on a landing config', () => {
		const doc = (proc: string, phase = 'takeoff'): string =>
			closedDoc(`    - phase: ${phase}
      flapsDeg: 25
      procedure: ${proc}
${body}
`);
		expect((parseAircraftYaml(doc('short-field')).performance as ClosedFormPerformance).configs[0].procedure).toBe(
			'short-field',
		);
		expect((parseAircraftYaml(doc('normal')).performance as ClosedFormPerformance).configs[0].procedure).toBe('normal');
		expect(() => parseAircraftYaml(doc('steep'))).toThrow(/configs\[0\]\.procedure must be normal or short-field/);
		expect(
			(parseAircraftYaml(doc('short-field', 'landing')).performance as ClosedFormPerformance).configs[0].procedure,
		).toBeUndefined();
	});

	it('reads the configuration a table was charted at, absent when unstated', () => {
		const stated = parseAircraftYaml(
			TABLE_DOC.replace('  massMinKg: 700\n', '  massMinKg: 700\n  takeoffFlapsDeg: 25\n  takeoffProcedure: short-field\n  landingFlapsDeg: 40\n'),
		).performance as TablePerformance;
		expect([stated.takeoffFlapsDeg, stated.takeoffProcedure, stated.landingFlapsDeg]).toEqual([25, 'short-field', 40]);
		const plain = parseAircraftYaml(TABLE_DOC).performance as TablePerformance;
		expect([plain.takeoffFlapsDeg, plain.takeoffProcedure, plain.landingFlapsDeg]).toEqual([undefined, undefined, undefined]);
		expect(() => parseAircraftYaml(TABLE_DOC.replace('  massMinKg: 700\n', '  massMinKg: 700\n  takeoffFlapsDeg: up\n')),
		).toThrow(/takeoffFlapsDeg/);
		expect(() =>
			parseAircraftYaml(TABLE_DOC.replace('  massMinKg: 700\n', '  massMinKg: 700\n  takeoffProcedure: steep\n')),
		).toThrow(/takeoffProcedure must be normal or short-field/);
	});

	it('reads holdBelowTable as a boolean, false the same as absent', () => {
		const withHold = (v: string) => TABLE_DOC.replace('  massMinKg: 700\n', `  massMinKg: 700\n  holdBelowTable: ${v}\n`);
		expect((parseAircraftYaml(withHold('true')).performance as TablePerformance).holdBelowTable).toBe(true);
		expect((parseAircraftYaml(withHold('false')).performance as TablePerformance).holdBelowTable).toBeUndefined();
		expect((parseAircraftYaml(TABLE_DOC).performance as TablePerformance).holdBelowTable).toBeUndefined();
		expect(() => parseAircraftYaml(withHold('lowest'))).toThrow(/holdBelowTable must be true or false/);
	});
});

describe('stringifyAircraftYaml', () => {
	it('round-trips a table document to a deep-equal value', () => {
		const a = parseAircraftYaml(TABLE_DOC);
		expect(parseAircraftYaml(stringifyAircraftYaml(a))).toEqual(a);
	});

	it('omits an unset operator from the YAML', () => {
		const a = parseAircraftYaml(TABLE_DOC.replace(/^ {2}operator: .*\n/m, ''));
		expect(a.identity.operator).toBeUndefined();
		expect(stringifyAircraftYaml(a)).not.toContain('operator:');
	});

	it('round-trips a station maximum, and keeps its absence absent', () => {
		const doc = TABLE_DOC.replace(
			'    - { label: Rear seats, armM: 1.19, defaultMassKg: 10 }\n',
			'    - { label: Rear seats, armM: 1.19, defaultMassKg: 10 }\n    - { label: Baggage, armM: 1.9, defaultMassKg: 0, maxMassKg: 40 }\n',
		);
		const a = parseAircraftYaml(doc);
		expect(a.massBalance!.stations.map((s) => s.maxMassKg)).toEqual([undefined, undefined, 40]);
		const text = stringifyAircraftYaml(a);
		expect(text.match(/maxMassKg/g)).toHaveLength(1);
		expect(parseAircraftYaml(text)).toEqual(a);
	});

	it('round-trips the maximum landing and zero-fuel masses, and keeps their absence absent', () => {
		const a = parseAircraftYaml(TABLE_DOC);
		expect(a.massBalance!.maxLandingMassKg).toBeUndefined();
		expect(a.massBalance!.maxZeroFuelMassKg).toBeUndefined();
		const plain = stringifyAircraftYaml(a);
		expect(plain).not.toMatch(/maxLandingMassKg|maxZeroFuelMassKg/);
		// The SR20's TCDS figures in kg (3000 / 2900 / 2900 lb), on a sheet
		// whose envelope tops out at 900 kg here: limits below it.
		const b = parseAircraftYaml(
			TABLE_DOC.replace(/^( {2}fuelArmM: .*\n)/m, '$1  maxLandingMassKg: 880\n  maxZeroFuelMassKg: 850\n'),
		);
		expect(b.massBalance!.maxLandingMassKg).toBe(880);
		expect(b.massBalance!.maxZeroFuelMassKg).toBe(850);
		const text = stringifyAircraftYaml(b);
		expect(parseAircraftYaml(text)).toEqual(b);
	});

	it('reads a null mass limit as no limit', () => {
		const a = parseAircraftYaml(
			TABLE_DOC.replace(/^( {2}fuelArmM: .*\n)/m, '$1  maxLandingMassKg: null\n'),
		);
		expect(a.massBalance!.maxLandingMassKg).toBeUndefined();
	});

	it('round-trips a closed-form document with presets', () => {
		const doc = `
version: 1
aircraft: { registration: F-GIEQ, type: PA28-161 }
fuel:
  capacityL: 182
  usableL: 180
  consumptionLph: 36
  presets:
    - { name: tabs, litres: 128 }
performance:
  kind: closed-form
  flaplessLandingFactor: 1.5
  massReferenceLb: 2325
  configs:
    - phase: takeoff
      flapsDeg: 25
      procedure: short-field
      massExponent: 2
      distance15m: { coefficients: [0.00045, 2.8, 0.067, 380], headwindPerKt: 0.018, tailwindPerKt: 0.06 }
      groundRoll: { coefficients: [0.00022, 1.4, 0.033, 180], headwindPerKt: 0.023, tailwindPerKt: 0.07 }
    - phase: landing
      flapsDeg: 40
      massExponent: 1
      distance15m: { coefficients: [0.00006, 0.66, 0.0085, 320], headwindPerKt: 0.015, tailwindPerKt: 0.022 }
      groundRoll: { coefficients: [0.00002, 0.58, 0.00625, 160], headwindPerKt: 0.018, tailwindPerKt: 0.028 }
`;
		const a = parseAircraftYaml(doc);
		expect(parseAircraftYaml(stringifyAircraftYaml(a))).toEqual(a);
		expect(stringifyAircraftYaml(a)).toContain('procedure: short-field');
	});

	it('round-trips the configuration a table was charted at', () => {
		const a = parseAircraftYaml(
			TABLE_DOC.replace('  massMinKg: 700\n', '  massMinKg: 700\n  takeoffFlapsDeg: 25\n  landingFlapsDeg: 40\n'),
		);
		const text = stringifyAircraftYaml(a);
		expect(text).toContain('takeoffFlapsDeg: 25');
		expect(text).not.toContain('takeoffProcedure');
		expect(parseAircraftYaml(text)).toEqual(a);
	});

	it('writes holdBelowTable only when it holds', () => {
		const held = parseAircraftYaml(TABLE_DOC.replace('  massMinKg: 700\n', '  massMinKg: 700\n  holdBelowTable: true\n'));
		expect(stringifyAircraftYaml(held)).toContain('holdBelowTable: true');
		expect(parseAircraftYaml(stringifyAircraftYaml(held))).toEqual(held);
		expect(stringifyAircraftYaml(parseAircraftYaml(TABLE_DOC))).not.toContain('holdBelowTable');
	});
});

describe('multi-engine sheets', () => {
	const TWIN = readFileSync(new URL('./fixtures/aircraft-twin.yaml', import.meta.url), 'utf-8');
	const single = (extra: string): string => `version: 1\naircraft: { type: X${extra} }\n`;

	it('reads the engines, the accelerate-stop table and the one engine inoperative section', () => {
		const a = parseAircraftYaml(TWIN);
		expect([a.identity.engines, isMultiEngine(a), engineCount(a)]).toEqual([2, true, 2]);
		const asd = a.performance!.accelerateStop!;
		expect([asd.massMaxKg, asd.massMinKg, asd.axis, asd.altitudesFt, asd.temperaturesC]).toEqual([1905, 1360, 'oat', [0, 4000], [0, 30]]);
		expect(asd.rows[0]).toEqual({ altFt: 0, tempC: 0, massMax: 500, massMin: 320 });
		expect(asd.headwind).toEqual([[0, 1], [8.7, 0.9]]);
		expect(asd.tailwindPctPer2Kt).toBeUndefined();
		const o = a.oneEngineInoperative!;
		expect([o.vmcKt, o.vyseKt, o.vxseKt, o.takeoffClimb]).toEqual([69.5, 91.3, undefined, undefined]);
		// A climb rate reads below zero above the ceiling.
		expect(o.climb!.rows.map((r) => r.massMax)).toEqual([190, 120, -90, -160]);
		expect(o.climb!.axis).toBe('isa-offset');
	});

	it('writes version 2 for a sheet stating twin data, 1 otherwise, and round-trips it', () => {
		const a = parseAircraftYaml(TWIN);
		expect(aircraftDocVersion(a)).toBe(2);
		const text = stringifyAircraftYaml(a);
		expect(text).toMatch(/^version: 2$/m);
		expect(text).toMatch(/^ {2}engines: 2$/m);
		expect(parseAircraftYaml(text)).toEqual(a);
		// Each part alone takes the sheet to version 2.
		expect(aircraftDocVersion(parseAircraftYaml(single(', engines: 2')))).toBe(2);
		const asdOnly = { ...parseAircraftYaml(TABLE_DOC) };
		asdOnly.performance = { ...asdOnly.performance!, accelerateStop: a.performance!.accelerateStop };
		expect(aircraftDocVersion(asdOnly)).toBe(2);
		expect(aircraftDocVersion(parseAircraftYaml(TABLE_DOC))).toBe(1);
		// A version-1 document stating twin data (hand-written) is read, and
		// written back at 2.
		expect(stringifyAircraftYaml(parseAircraftYaml(TWIN.replace('version: 2', 'version: 1')))).toMatch(/^version: 2$/m);
	});

	it('reads one engine as a single, writing nothing', () => {
		const a = parseAircraftYaml(single(', engines: 1'));
		expect([a.identity.engines, isMultiEngine(a), engineCount(a)]).toEqual([undefined, false, 1]);
		expect(stringifyAircraftYaml(a)).not.toMatch(/engines/);
	});

	it('keeps every committed single byte for byte, the header included', () => {
		// The header is part of every synced plane's payload: a change to it
		// would push every plane again, and an older app back.
		const HEADER = [
			'# Aircraft data sheet (Loxodrome). Sections: aircraft (identity), fuel,',
			'# cruise, climb / descent (speed + vertical rate, drawn on the route',
			'# vertical profile), massAndBalance (stations + CG envelope), performance',
			'# (kind: table with POH rows, or closed-form with fitted coefficients).',
			'# Units are in the field names: kg, m, L, kt, ft, ft/min, deg C; distances',
			'# in metres. Unknown keys are ignored; every section except aircraft may be',
			'# omitted (partial data sheet).',
			'# Verify every figure against the aircraft flight manual before use.',
		].join('\n');
		for (const f of readdirSync(new URL('../public/data/aircraft', import.meta.url))) {
			if (!f.endsWith('.yaml')) continue;
			const a = parseAircraftYaml(readFileSync(new URL(`../public/data/aircraft/${f}`, import.meta.url), 'utf-8'));
			const text = stringifyAircraftYaml(a);
			expect(text.startsWith(`${HEADER}\nversion: 1\n`), f).toBe(true);
			expect(text, f).not.toMatch(/engines|accelerateStop|oneEngineInoperative/);
		}
	});

	it.each([
		[single(', engines: 3'), /aircraft\.engines must be 1 or 2/],
		[single(', engines: two'), /aircraft\.engines must be a finite number/],
		[`${single('')}oneEngineInoperative: { vmcKt: 70, vyseKt: 91 }\n`, /oneEngineInoperative needs aircraft\.engines: 2/],
		[`${single(', engines: 2')}oneEngineInoperative: { vyseKt: 91 }\n`, /oneEngineInoperative\.vmcKt must be a finite number/],
		[`${single(', engines: 2')}oneEngineInoperative: { vmcKt: 70 }\n`, /oneEngineInoperative\.vyseKt must be a finite number/],
		[
			`${single(', engines: 2')}oneEngineInoperative: { vmcKt: 70, vyseKt: 91, climb: { massMaxKg: 1500, massMinKg: 1600, rows: [] } }\n`,
			/oneEngineInoperative\.climb\.massMinKg must be < oneEngineInoperative\.climb\.massMaxKg/,
		],
		[
			`${single(', engines: 2')}oneEngineInoperative: { vmcKt: 70, vyseKt: 91, climb: { massMaxKg: 1600, massMinKg: 1500, rows: [{ altFt: 0, isaOffsetC: 0, massMax: 100, massMin: 200 }] } }\n`,
			/oneEngineInoperative\.climb\.rows needs at least 2 altitudes and 2 ISA offsets/,
		],
		[
			TWIN.replace('massMax: 500, massMin: 320', 'massMax: 0, massMin: 320'),
			/performance\.accelerateStop\.rows\[0\]\.massMax must be > 0/,
		],
		[
			TWIN.replace('- { altFt: 0, temperatureC: 30, massMax: 560', '- { altFt: 0, isaOffsetC: 30, massMax: 560'),
			/performance\.accelerateStop\.rows mixes isaOffsetC and temperatureC rows/,
		],
		[
			TWIN.replace('      - { altFt: 4000, temperatureC: 30, massMax: 680, massMin: 430 }\n', ''),
			/performance\.accelerateStop\.rows must cover the full altitude x temperature grid/,
		],
		[TWIN.replace('headwind: [[0, 1], [8.7, 0.9]]', 'headwind: [[0, 0.9]]'), /performance\.accelerateStop\.headwind must start with the \[0, 1\] anchor/],
	])('refuses a twin sheet readably', (doc, re) => {
		expect(() => parseAircraftYaml(doc)).toThrow(re);
	});
});
