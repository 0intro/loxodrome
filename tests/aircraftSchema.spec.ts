/* Unit tests for the aircraft data-sheet YAML (src/lib/aircraft/schema.ts):
 * parsing, defaults, grid validation, readable failures, round-trip. */

import { describe, it, expect } from 'vitest';
import {
	parseAircraftYaml,
	stringifyAircraftYaml,
	aircraftKey,
	enduranceMin,
	fuelDensityKgPerL,
	gradientFtPerNM,
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
			expect(p.takeoff.isaOffsetsC).toEqual([0, 20]);
			expect(p.takeoff.rows[0]).toMatchObject({ altFt: 0, isaOffsetC: 0 });
			expect(p.takeoff.rows[3]).toMatchObject({ altFt: 4000, isaOffsetC: 20 });
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

	it('knows the Jet A-1 grade (reserved for future turbine / diesel types)', () => {
		const a = parseAircraftYaml(
			'version: 1\naircraft: { type: X }\nfuel: { capacityL: 100, types: [JET A-1] }\n',
		);
		expect(a.fuel!.type).toBe('JET A-1');
		expect(fuelDensityKgPerL(a.fuel!)).toBe(0.8);
	});

	it('ignores unknown keys at every level', () => {
		const a = parseAircraftYaml(
			'version: 1\nextra: 1\naircraft: { type: X, color: blue }\nfuel: { capacityL: 10, vendor: shell }\n',
		);
		expect(a.identity.type).toBe('X');
		expect(a.fuel!.capacityL).toBe(10);
	});

	it.each([
		['version: 2\naircraft: { type: X }', /unsupported version 2/],
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

	it('rejects two default configs for the same phase', () => {
		const metric = '{ coefficients: [1, 2, 3, 4], headwindPerKt: 0.01, tailwindPerKt: 0.02 }';
		const cfg = `      massExponent: 2\n      distance15m: ${metric}\n      groundRoll: ${metric}`;
		const doc = `
version: 1
aircraft: { type: PA28 }
performance:
  kind: closed-form
  massReferenceLb: 2325
  configs:
    - phase: takeoff
      flapsDeg: 0
      default: true
${cfg}
    - phase: takeoff
      flapsDeg: 25
      default: true
${cfg}
`;
		expect(() => parseAircraftYaml(doc)).toThrow(/at most one default per phase/);
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

	it('round-trips a closed-form document with presets', () => {
		const doc = `
version: 1
aircraft: { registration: F-GIEQ, type: PA28-161 }
fuel:
  capacityL: 182
  usableL: 180
  consumptionLph: 36
  presets:
    - { name: tabs, label: To tabs, litres: 128 }
performance:
  kind: closed-form
  flaplessLandingFactor: 1.5
  massReferenceLb: 2325
  configs:
    - phase: takeoff
      flapsDeg: 25
      default: true
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
	});
});
