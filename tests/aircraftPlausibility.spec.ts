/* The editor's figures to check (aircraft/plausibility.ts) and the default
 * load it draws on the M&B preview (edit.ts draftDefaultLoad). The schema
 * checks structure, not physics: these are the readings only a transcription
 * slip produces, listed as warnings that never block a save. Every committed
 * sheet is checked and none trips: the one that did was the generic C182T's
 * landing table, falling from 1300 ft at sea level to 1265 ft at 1000 ft and
 * 0 °C, a misprint every copy of its POH carries (Figure 5-12), which the
 * sheet now reads as its neighbours give (docs/generic-aircraft.md). */

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aircraftToDraft, draftDefaultLoad } from '$lib/aircraft/edit';
import { envelopeCrosses, plausibilityPage, plausibilityWarnings } from '$lib/aircraft/plausibility';
import { parseAircraftYaml, type Aircraft } from '$lib/aircraft/schema';

function library(): [string, Aircraft][] {
	const out: [string, Aircraft][] = [];
	for (const dir of ['public/data/aircraft', 'public/data/aircraft/generic']) {
		for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
			if (f.endsWith('.yaml')) {
				out.push([`${dir}/${f}`, parseAircraftYaml(readFileSync(new URL(`../${dir}/${f}`, import.meta.url), 'utf8'))]);
			}
		}
	}
	return out;
}

const SHEET = `version: 1
aircraft: { registration: F-TEST, type: DR400/120 }
massAndBalance:
  emptyMassKg: 570
  emptyArmM: 0.348
  fuelArmM: 1.12
  stations:
    - { label: Front seats, armM: 0.41, defaultMassKg: 80 }
    - { label: Rear seats, armM: 1.19, defaultMassKg: 10 }
  envelope:
    - { armM: 0.205, massKg: 500 }
    - { armM: 0.564, massKg: 500 }
    - { armM: 0.564, massKg: 900 }
    - { armM: 0.35, massKg: 900 }
performance:
  kind: table
  massMaxKg: 900
  massMinKg: 700
  wind: { takeoffHeadwind: [[0, 1]], landingHeadwind: [[0, 1]] }
  takeoff:
    - { altFt: 0, isaOffsetC: 0, massMax: [235, 485], massMin: [150, 315] }
    - { altFt: 0, isaOffsetC: 20, massMax: [265, 545], massMin: [170, 355] }
    - { altFt: 4000, isaOffsetC: 0, massMax: [300, 615], massMin: [190, 400] }
    - { altFt: 4000, isaOffsetC: 20, massMax: [340, 695], massMin: [215, 450] }
  landing:
    - { altFt: 0, isaOffsetC: 0, massMax: [250, 515], massMin: [205, 450] }
    - { altFt: 0, isaOffsetC: 20, massMax: [265, 545], massMin: [215, 470] }
    - { altFt: 4000, isaOffsetC: 0, massMax: [275, 565], massMin: [225, 490] }
    - { altFt: 4000, isaOffsetC: 20, massMax: [295, 595], massMin: [240, 515] }
`;

const sheet = (edit: (yaml: string) => string = (y) => y): Aircraft => parseAircraftYaml(edit(SHEET));

describe('the figures to check', () => {
	it('finds nothing on a sheet as the manual prints it', () => {
		expect(plausibilityWarnings(sheet())).toEqual([]);
	});

	it('finds nothing in the committed library', () => {
		const found = library().flatMap(([file, a]) => plausibilityWarnings(a).map((w) => ({ file, w })));
		expect(found).toEqual([]);
	});

	it('found the C182T POH’s misprint, as printed', () => {
		const c182t = library().find(([f]) => f.endsWith('/c182t.yaml'))![1];
		const p = c182t.performance!;
		if (p.kind !== 'table') {
			throw new Error('the C182T sheet holds a table');
		}
		// 1335 ft corrected back to the printed 1265 ft (385.6 m).
		const printed = p.landing.rows.map((r) =>
			r.altFt === 1000 && r.tempC === 0 ? { ...r, massMax: [r.massMax[0], 385.6] as const, massMin: [r.massMin[0], 385.6] as const } : r,
		);
		const w = plausibilityWarnings({ ...c182t, performance: { ...p, landing: { ...p.landing, rows: printed } } });
		expect(w).toEqual([
			expect.objectContaining({ kind: 'grid-falls', mass: 'max', metric: 'd15', along: 'altitude', fromM: 396.2, toM: 385.6 }),
			expect.objectContaining({ kind: 'grid-falls', mass: 'min', metric: 'd15', along: 'altitude', fromM: 396.2, toM: 385.6 }),
		]);
		expect(w[0]).toMatchObject({ cell: { phase: 'landing', altFt: 1000, tempC: 0, axis: 'oat' }, fromAltFt: 0 });
	});

	it('flags a distance falling with the altitude or the temperature, at the cell after the slip', () => {
		// 4000 ft ISA's 615 slipped to 475, under the 485 at sea level below it
		// (its right neighbour, 695, still rises from it).
		const w = plausibilityWarnings(sheet((y) => y.replace('massMax: [300, 615]', 'massMax: [300, 475]')));
		expect(w).toEqual([
			expect.objectContaining({
				kind: 'grid-falls',
				cell: { phase: 'takeoff', altFt: 4000, tempC: 0, axis: 'isa-offset' },
				mass: 'max',
				metric: 'd15',
				along: 'altitude',
				fromM: 485,
				toM: 475,
			}),
		]);
		const across = plausibilityWarnings(sheet((y) => y.replace('massMax: [265, 545], massMin: [170', 'massMax: [225, 545], massMin: [170')));
		expect(across).toEqual([
			expect.objectContaining({ kind: 'grid-falls', mass: 'max', metric: 'roll', along: 'temperature', fromM: 235, toM: 225 }),
		]);
	});

	it('flags a ground roll not shorter than its distance over 15 m, and a light mass longer than the heavy one', () => {
		const swapped = plausibilityWarnings(sheet((y) => y.replace('massMax: [250, 515]', 'massMax: [515, 250]')));
		expect(swapped.map((w) => w.kind)).toContain('grid-roll-long');
		expect(swapped.find((w) => w.kind === 'grid-roll-long')).toMatchObject({ mass: 'max', rollM: 515, d15M: 250 });
		// The grid's last cell, which no other reading is compared with.
		const masses = plausibilityWarnings(sheet((y) => y.replace('massMin: [240, 515]', 'massMin: [300, 515]')));
		expect(masses).toEqual([
			expect.objectContaining({ kind: 'grid-min-long', metric: 'roll', minM: 300, maxM: 295 }),
		]);
	});

	it('flags tables charted above the envelope’s heaviest mass', () => {
		const w = plausibilityWarnings(sheet((y) => y.replace('massMaxKg: 900', 'massMaxKg: 9000')));
		expect(w).toEqual([{ kind: 'table-mass-above-envelope', massMaxKg: 9000, envelopeTopKg: 900 }]);
		expect(plausibilityPage(w[0])).toBe('perf');
	});

	it('flags an envelope whose points are out of order, on the M&B page', () => {
		const w = plausibilityWarnings(
			sheet((y) => y.replace('- { armM: 0.564, massKg: 900 }\n    - { armM: 0.35, massKg: 900 }', '- { armM: 0.35, massKg: 900 }\n    - { armM: 0.564, massKg: 900 }')),
		);
		expect(w).toEqual([{ kind: 'envelope-crosses' }]);
		expect(plausibilityPage(w[0])).toBe('mb');
		expect(envelopeCrosses([{ armM: 0, massKg: 0 }, { armM: 1, massKg: 0 }, { armM: 1, massKg: 1 }])).toBe(false);
	});

	it('reads a fitted configuration over the operating range', () => {
		const fit = (coefs: string) =>
			parseAircraftYaml(`version: 1
aircraft: { type: PA-28-181 }
performance:
  kind: closed-form
  massReferenceLb: 2550
  configs:
    - phase: takeoff
      flapsDeg: 0
      distance15m: { coefficients: ${coefs}, headwindPerKt: 0.01, tailwindPerKt: 0.05 }
      groundRoll: { coefficients: [0.0000005, 0.9, 0.025, 290], headwindPerKt: 0.01, tailwindPerKt: 0.05 }
`);
		expect(plausibilityWarnings(fit('[0.000001, 1.9, 0.055, 520]'))).toEqual([]);
		// The temperature term's sign slipped: the distance falls as it warms.
		expect(plausibilityWarnings(fit('[0.000001, -1.9, 0.055, 520]'))).toEqual([
			expect.objectContaining({ kind: 'fit-falls', metric: 'd15', along: 'temperature', altFt: 0, config: { phase: 'takeoff', flapsDeg: 0 } }),
		]);
		// A slipped digit in the constant: shorter than its own ground roll.
		expect(plausibilityWarnings(fit('[0.000001, 1.9, 0.055, 52]')).map((w) => w.kind)).toEqual(['fit-roll-long']);
	});
});

describe('a twin’s figures to check', () => {
	const twinText = readFileSync(new URL('./fixtures/aircraft-twin.yaml', import.meta.url), 'utf8');
	const twin = (edit: (yaml: string) => string = (y) => y): Aircraft => parseAircraftYaml(edit(twinText));
	const kinds = (a: Aircraft) => plausibilityWarnings(a).map((w) => w.kind);

	it('finds nothing on the fixture twin, nor on the generic Seneca', () => {
		expect(plausibilityWarnings(twin())).toEqual([]);
		const seneca = parseAircraftYaml(readFileSync(new URL('../public/data/aircraft/generic/pa34-200.yaml', import.meta.url), 'utf8'));
		expect(plausibilityWarnings(seneca)).toEqual([]);
	});

	it('flags an accelerate-stop distance falling with the altitude, or longer at its light mass', () => {
		const falls = twin((y) => y.replace('{ altFt: 4000, temperatureC: 0, massMax: 600, massMin: 380 }', '{ altFt: 4000, temperatureC: 0, massMax: 480, massMin: 300 }'));
		const w = plausibilityWarnings(falls).find((x) => x.kind === 'metric-wrong-way');
		expect(w).toMatchObject({ kind: 'metric-wrong-way', cell: { table: 'asd', altFt: 4000, tempC: 0 }, mass: 'max', along: 'altitude', from: 500, to: 480 });
		expect(plausibilityPage(w!)).toBe('perf');
		const light = twin((y) => y.replace('massMax: 500, massMin: 320', 'massMax: 500, massMin: 520'));
		expect(kinds(light)).toContain('metric-mass-wrong-way');
	});

	it('flags a one-engine climb rising with the temperature, or poorer at its light mass', () => {
		const rises = twin((y) => y.replace('{ altFt: 0, isaOffsetC: 20, massMax: 120, massMin: 340 }', '{ altFt: 0, isaOffsetC: 20, massMax: 200, massMin: 440 }'));
		const w = plausibilityWarnings(rises).filter((x) => x.kind === 'metric-wrong-way');
		expect(w.map((x) => [x.kind === 'metric-wrong-way' && x.cell.table, x.kind === 'metric-wrong-way' && x.along])).toContainEqual(['climb', 'temperature']);
		const poor = twin((y) => y.replace('massMax: 190, massMin: 420', 'massMax: 190, massMin: 150'));
		expect(plausibilityWarnings(poor).find((x) => x.kind === 'metric-mass-wrong-way')).toMatchObject({ cell: { table: 'climb', altFt: 0 }, min: 150, max: 190 });
	});

	it('flags Vmc not below Vyse, an accelerate-stop shorter than the roll, a table above the envelope', () => {
		expect(plausibilityWarnings(twin((y) => y.replace('vmcKt: 69.5', 'vmcKt: 95')))).toContainEqual({ kind: 'vmc-not-below-vyse', vmcKt: 95, vyseKt: 91.3 });
		const short = twin((y) => y.replace('massMax: 500, massMin: 320', 'massMax: 250, massMin: 200').replace('massMax: 560, massMin: 360', 'massMax: 260, massMin: 210').replace('massMax: 600, massMin: 380', 'massMax: 300, massMin: 250').replace('massMax: 680, massMin: 430', 'massMax: 310, massMin: 260'));
		expect(plausibilityWarnings(short).find((x) => x.kind === 'asd-short')).toMatchObject({ asdM: 255, rollM: 320 });
		const heavy = twin((y) => y.replace('  climb:\n    massMaxKg: 1905', '  climb:\n    massMaxKg: 1950'));
		expect(plausibilityWarnings(heavy)).toContainEqual({ kind: 'metric-mass-above-envelope', table: 'climb', massMaxKg: 1950, envelopeTopKg: 1905 });
	});
});

describe('the default load on the M&B preview', () => {
	it('weighs the stations at their defaults, without fuel and with the full usable fuel', () => {
		const d = aircraftToDraft(
			parseAircraftYaml(SHEET.replace('massAndBalance:', 'fuel: { capacityL: 110, usableL: 100, type: 100LL, types: [100LL] }\nmassAndBalance:')),
		);
		const load = draftDefaultLoad(d)!;
		expect(load.zeroFuel.massKg).toBeCloseTo(570 + 80 + 10, 6);
		expect(load.zeroFuel.armM).toBeCloseTo((570 * 0.348 + 80 * 0.41 + 10 * 1.19) / 660, 9);
		expect(load.fuelMassKg).toBeCloseTo(72, 9); // 100 L of 100LL at 0.72 kg/L
		expect(load.takeoff!.massKg).toBeCloseTo(732, 6);
		expect(load.takeoff!.armM).toBeCloseTo((660 * load.zeroFuel.armM + 72 * 1.12) / 732, 9);
	});

	it('takes the capacity for an empty usable figure, and draws no take-off without fuel', () => {
		const d = aircraftToDraft(
			parseAircraftYaml(SHEET.replace('massAndBalance:', 'fuel: { capacityL: 110, type: 100LL, types: [100LL] }\nmassAndBalance:')),
		);
		expect(draftDefaultLoad(d)!.fuelMassKg).toBeCloseTo(79.2, 9);
		expect(draftDefaultLoad(aircraftToDraft(sheet()))!.takeoff).toBeNull();
	});

	it('waits for every figure it reads', () => {
		const d = aircraftToDraft(sheet());
		d.massBalance!.stations[1].armM = '';
		expect(draftDefaultLoad(d)).toBeNull();
		d.massBalance!.stations[1].armM = '1.19';
		d.massBalance!.emptyMassKg = 'abc';
		expect(draftDefaultLoad(d)).toBeNull();
	});
});
