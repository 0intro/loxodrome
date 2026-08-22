/* The aircraft editor draft (src/lib/aircraft/edit.ts): string-typed
 * draft <-> Aircraft conversions over every committed data sheet, grid
 * orientation, the empty-field defaults, error-to-page mapping; plus
 * saveEditedAircraft's key semantics driving the real fleet state module
 * (the same way routeUndo.spec.ts drives route.svelte). */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
	parseAircraftYaml,
	parseAircraftDoc,
	stringifyAircraftYaml,
	aircraftKey,
	type Aircraft,
} from '$lib/aircraft/schema';
import {
	aircraftToDraft,
	duplicateDraft,
	draftToAircraft,
	draftEnvelopePoints,
	decimalStep,
	errorPage,
	referenceFigures,
	blankFuelDraft,
	blankMassBalanceDraft,
	blankClosedFormPerformanceDraft,
	blankTablePerformanceDraft,
	type AircraftDraft,
	type PerfGridDraft,
	type TablePerformanceDraft,
} from '$lib/aircraft/edit';
import { verdictConfig, KG_TO_LB } from '$lib/aircraft/performance';
import {
	aircraftState,
	saveEditedAircraft,
	isLibraryKey,
	isShadowed,
	isUserOnly,
} from '$lib/state/aircraft.svelte';

// Every committed sheet, from the meta file index (aircraftData.spec.ts
// pins that index against the directory), so a new sheet is covered by the
// round-trip automatically.
const FILES: string[] = (
	JSON.parse(
		readFileSync(new URL('../public/data/aircraft.meta.json', import.meta.url), 'utf-8'),
	) as { files: string[] }
).files;

function loadText(file: string): string {
	return readFileSync(new URL(`../public/data/aircraft/${file}`, import.meta.url), 'utf-8');
}

function typeOnlyDraft(type = 'X'): AircraftDraft {
	const d = aircraftToDraft(null);
	d.type = type;
	return d;
}

/** A complete grid with distinguishable cells: cell (ai, ii) holds
 *  [base+ai*100+ii*10, +1] / [+2, +3]. */
function grid(altitudesFt: string[], isaOffsetsC: string[], base: number): PerfGridDraft {
	return {
		altitudesFt,
		isaOffsetsC,
		cells: altitudesFt.map((_, ai) =>
			isaOffsetsC.map((_2, ii) => ({
				massMaxRoll: String(base + ai * 100 + ii * 10),
				massMaxD15: String(base + ai * 100 + ii * 10 + 1),
				massMinRoll: String(base + ai * 100 + ii * 10 + 2),
				massMinD15: String(base + ai * 100 + ii * 10 + 3),
			})),
		),
	};
}

function tableDraft(takeoff: PerfGridDraft, landing: PerfGridDraft): TablePerformanceDraft {
	const p = blankTablePerformanceDraft();
	p.massMaxKg = '900';
	p.massMinKg = '700';
	p.takeoff = takeoff;
	p.landing = landing;
	return p;
}

describe('draft round-trip', () => {
	it.each(FILES)('%s converts to a draft and back, canonical-YAML-identical', (f) => {
		const a = parseAircraftYaml(loadText(f));
		const r = draftToAircraft(aircraftToDraft(a));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(stringifyAircraftYaml(r.aircraft)).toBe(stringifyAircraftYaml(a));
		}
	});

	it('parseAircraftDoc is the post-parse half of parseAircraftYaml', () => {
		const text = loadText('f-gjqk.yaml');
		expect(parseAircraftDoc(parse(text))).toEqual(parseAircraftYaml(text));
	});

	it('carries the operator through the draft round-trip', () => {
		const a = parseAircraftYaml(loadText('f-gjqk.yaml'));
		a.identity.operator = 'Aéroclub Test';
		const d = aircraftToDraft(a);
		expect(d.operator).toBe('Aéroclub Test');
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.aircraft.identity.operator).toBe('Aéroclub Test');
			expect(stringifyAircraftYaml(r.aircraft)).toBe(stringifyAircraftYaml(a));
		}
	});
});

describe('create drafts', () => {
	it('the blank draft fails on the missing type, mapped to the General page', () => {
		const r = draftToAircraft(aircraftToDraft(null));
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/aircraft\.type/);
			expect(errorPage(r.errors[0])).toBe('general');
		}
	});

	it('a type-only draft yields a minimal sheet keyed by the type', () => {
		const r = draftToAircraft(typeOnlyDraft(' PA28-181 '));
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.aircraft.identity.registration).toBeUndefined();
			expect(r.aircraft.identity.type).toBe('PA28-181'); // trimmed
			expect(r.aircraft.fuel).toBeUndefined();
			expect(r.aircraft.cruise).toBeUndefined();
			expect(r.aircraft.massBalance).toBeUndefined();
			expect(r.aircraft.performance).toBeUndefined();
			expect(r.aircraft.notes).toBeUndefined();
			expect(aircraftKey(r.aircraft)).toBe('PA28-181');
		}
	});

	it('duplicateDraft clears only the registration', () => {
		const a = parseAircraftYaml(loadText('f-gjqk.yaml'));
		const d = duplicateDraft(a);
		expect(d.registration).toBe('');
		d.registration = 'F-COPY';
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.aircraft).toEqual({
				...a,
				identity: { ...a.identity, registration: 'F-COPY' },
			});
		}
	});
});

describe('conversion rules', () => {
	it('usableL: empty means capacity, in both directions', () => {
		const d = typeOnlyDraft();
		d.fuel = blankFuelDraft();
		d.fuel.capacityL = '100';
		let r = draftToAircraft(d);
		expect(r.ok && r.aircraft.fuel!.usableL).toBe(100);
		d.fuel.usableL = '90';
		r = draftToAircraft(d);
		expect(r.ok && r.aircraft.fuel!.usableL).toBe(90);
		if (r.ok) {
			expect(aircraftToDraft(r.aircraft).fuel!.usableL).toBe('90');
		}
		const full = parseAircraftYaml('version: 1\naircraft: { type: X }\nfuel: { capacityL: 100 }');
		expect(aircraftToDraft(full).fuel!.usableL).toBe('');
	});

	it('empty performance factors fall back to the schema defaults', () => {
		const d = typeOnlyDraft();
		d.performance = tableDraft(grid(['0', '4000'], ['0', '20'], 100), grid(['0', '4000'], ['0', '20'], 500));
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const p = r.aircraft.performance!;
			expect(p.marginFactor).toBe(1.3);
			expect(p.grassFactor).toBe(1.15);
			expect(p.wetFactor).toBe(1.15);
			expect(p.flaplessLandingFactor).toBeUndefined();
			if (p.kind === 'table') {
				expect(p.wind.tailwindPctPer2Kt).toBe(10);
			}
		}
	});

	it('rejects trailing junk in numbers (Number, not parseFloat)', () => {
		const d = typeOnlyDraft();
		d.cruise = { speedKt: '100abc' };
		const r = draftToAircraft(d);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/cruise\.speedKt must be a finite number/);
		}
	});

	it('climb / descent round-trip; a bad rate maps to the General page', () => {
		const d = typeOnlyDraft();
		d.climb = { speedKt: '78', rateFtMin: '650' };
		d.descent = { speedKt: '110', rateFtMin: '500' };
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.aircraft.climb).toEqual({ speedKt: 78, rateFtMin: 650 });
			expect(r.aircraft.descent).toEqual({ speedKt: 110, rateFtMin: 500 });
			const back = aircraftToDraft(r.aircraft);
			expect(back.climb).toEqual({ speedKt: '78', rateFtMin: '650' });
			expect(back.descent).toEqual({ speedKt: '110', rateFtMin: '500' });
		}
		d.climb.rateFtMin = '';
		const bad = draftToAircraft(d);
		expect(bad.ok).toBe(false);
		if (!bad.ok) {
			expect(bad.errors[0]).toMatch(/climb\.rateFtMin/);
			expect(errorPage(bad.errors[0])).toBe('general');
		}
	});

	it('trims strings and omits the empty ones', () => {
		const d = typeOnlyDraft();
		d.registration = ' F-X ';
		d.name = '   ';
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.aircraft.identity.registration).toBe('F-X');
			expect(r.aircraft.identity.name).toBeUndefined();
		}
	});
});

describe('grid mechanics', () => {
	it('flattens cells altitude-major and round-trips the orientation', () => {
		const d = typeOnlyDraft();
		d.performance = tableDraft(
			grid(['0', '4000'], ['-20', '0', '20'], 100),
			grid(['0', '4000'], ['-20', '0', '20'], 500),
		);
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok && r.aircraft.performance?.kind === 'table') {
			const t = r.aircraft.performance.takeoff;
			expect(t.altitudesFt).toEqual([0, 4000]);
			expect(t.isaOffsetsC).toEqual([-20, 0, 20]);
			// Cell (ai 1, ii 1) = alt 4000, ISA 0 holds 210/211 + 212/213.
			const row = t.rows.find((x) => x.altFt === 4000 && x.isaOffsetC === 0)!;
			expect(row.massMax).toEqual([210, 211]);
			expect(row.massMin).toEqual([212, 213]);
			const back = aircraftToDraft(r.aircraft).performance as TablePerformanceDraft;
			expect(back.takeoff.cells[1][1].massMaxRoll).toBe('210');
			expect(back.landing.cells[0][2].massMinD15).toBe('523');
		}
	});

	it('duplicate axis values hit a canonical grid error', () => {
		// Duplicates collapse the derived unique axes, so the schema's axis /
		// grid-coverage checks fire (the messages stay canonical, perf-mapped).
		const d = typeOnlyDraft();
		d.performance = tableDraft(
			grid(['0', '0'], ['0', '20'], 100),
			grid(['0', '4000'], ['0', '20'], 500),
		);
		let r = draftToAircraft(d);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/performance\.takeoff needs at least 2 altitudes and 2 ISA offsets/);
			expect(errorPage(r.errors[0])).toBe('perf');
		}
		d.performance = tableDraft(
			grid(['0', '0', '4000'], ['0', '20'], 100),
			grid(['0', '4000'], ['0', '20'], 500),
		);
		r = draftToAircraft(d);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/performance\.takeoff must cover the full altitude x ISA-offset grid/);
			expect(errorPage(r.errors[0])).toBe('perf');
		}
	});

	it('an empty cell is a finite-number error on the cell path', () => {
		const d = typeOnlyDraft();
		const takeoff = grid(['0', '4000'], ['0', '20'], 100);
		takeoff.cells[0][0].massMaxRoll = '';
		d.performance = tableDraft(takeoff, grid(['0', '4000'], ['0', '20'], 500));
		const r = draftToAircraft(d);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/performance\.takeoff\[0\]\.massMax\[0\] must be a finite number/);
		}
	});
});

describe('editor helpers', () => {
	it('errorPage maps field paths to pages, with or without the parser prefix', () => {
		expect(errorPage('Invalid aircraft file: massAndBalance.envelope needs at least 3 vertices')).toBe('mb');
		expect(errorPage('performance.configs must not be empty')).toBe('perf');
		expect(errorPage('Invalid aircraft file: fuel.types must not be empty')).toBe('general');
		expect(errorPage('Invalid aircraft file: aircraft.type must be a non-empty string')).toBe('general');
		expect(errorPage('Invalid aircraft file: the document must be a mapping')).toBe('general');
	});

	it('a two-vertex envelope maps to the M&B page end to end', () => {
		const d = typeOnlyDraft();
		d.massBalance = blankMassBalanceDraft();
		d.massBalance.emptyMassKg = '579';
		d.massBalance.emptyArmM = '0.35';
		d.massBalance.fuelArmM = '1.12';
		d.massBalance.envelope = [
			{ armM: '0.2', massKg: '660' },
			{ armM: '0.5', massKg: '900' },
		];
		const r = draftToAircraft(d);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.errors[0]).toMatch(/envelope needs at least 3 vertices/);
			expect(errorPage(r.errors[0])).toBe('mb');
		}
	});

	it('decimalStep is one unit of the last decimal place (plane-data precisions)', () => {
		expect(decimalStep('0.41')).toBe('0.01'); // station arm
		expect(decimalStep('2.045')).toBe('0.001'); // PA28 front-seat arm
		expect(decimalStep('1.15')).toBe('0.01'); // grass factor
		expect(decimalStep('0.0127')).toBe('0.0001'); // headwind per kt
		expect(decimalStep('341.1')).toBe('0.1'); // closed-form d
		expect(decimalStep('0.0000537')).toBe('0.0000001'); // closed-form a
		expect(decimalStep('-0.000189')).toBe('0.000001'); // negative coefficient
		expect(decimalStep('900')).toBe('1'); // integer mass
		expect(decimalStep('-20')).toBe('1'); // ISA offset
		expect(decimalStep(' 0.205 ')).toBe('0.001'); // trimmed
		expect(decimalStep('')).toBe('1');
		expect(decimalStep('0.')).toBe('1'); // mid-typing
	});

	it('decimalStep handles exponent notation (the step never invalidates the input)', () => {
		expect(decimalStep('5e-7')).toBe('0.0000001'); // String(0.0000005)
		expect(decimalStep('5.37e-7')).toBe('0.000000001'); // mantissa decimals add up
		expect(decimalStep('-5e-7')).toBe('0.0000001');
		expect(decimalStep('5e3')).toBe('1000');
		expect(decimalStep('5.3e2')).toBe('10');
		expect(decimalStep('5e0')).toBe('1');
	});

	it('draftEnvelopePoints keeps only complete finite rows', () => {
		const mb = blankMassBalanceDraft();
		mb.envelope = [
			{ armM: '0.2', massKg: '660' },
			{ armM: '', massKg: '900' },
			{ armM: '0.5', massKg: 'abc' },
			{ armM: '0.56', massKg: '660' },
			{ armM: '0.3', massKg: '0' },
		];
		expect(draftEnvelopePoints(mb)).toEqual([
			{ armM: 0.2, massKg: 660 },
			{ armM: 0.56, massKg: 660 },
		]);
	});
});

describe('referenceFigures', () => {
	it('table kind reproduces the SL / ISA / max-mass grid anchors (F-GORQ)', () => {
		const perf = parseAircraftYaml(loadText('f-gorq.yaml')).performance!;
		const fig = referenceFigures(perf)!;
		expect(fig.massKg).toBe(900);
		expect(fig.massLb).toBeNull();
		expect(fig.rows.map((r) => r.phase)).toEqual(['takeoff', 'landing']);
		if (perf.kind === 'table') {
			for (const phase of ['takeoff', 'landing'] as const) {
				const anchor = perf[phase].rows.find((r) => r.altFt === 0 && r.isaOffsetC === 0)!.massMax;
				const row = fig.rows.find((r) => r.phase === phase)!;
				expect(row.rollM).toBeCloseTo(anchor[0], 9);
				expect(row.d15M).toBeCloseTo(anchor[1], 9);
				expect(row.extrapolated).toBe(false);
				expect(row.flapsDeg).toBeNull();
			}
		}
	});

	it('closed-form uses the verdict configs at the reference mass (F-GIEQ)', () => {
		const perf = parseAircraftYaml(loadText('f-gieq.yaml')).performance!;
		const fig = referenceFigures(perf)!;
		expect(fig.massLb).toBe(2325);
		expect(fig.massKg).toBeCloseTo(2325 / KG_TO_LB, 9);
		if (perf.kind === 'closed-form') {
			for (const phase of ['takeoff', 'landing'] as const) {
				const cfg = verdictConfig(perf, phase)!;
				const row = fig.rows.find((r) => r.phase === phase)!;
				expect(row.flapsDeg).toBe(cfg.flapsDeg);
				// At PA 0, 15 deg C and the reference mass, distance = b * 15 + d.
				expect(row.rollM).toBeCloseTo(cfg.groundRoll.coefficients[1] * 15 + cfg.groundRoll.coefficients[3], 9);
				expect(row.d15M).toBeCloseTo(cfg.distance15m.coefficients[1] * 15 + cfg.distance15m.coefficients[3], 9);
				expect(row.extrapolated).toBe(false);
			}
		}
	});

	it('a grid without a sea-level row still computes, flagged extrapolated', () => {
		const d = typeOnlyDraft();
		d.performance = tableDraft(
			grid(['2000', '4000'], ['0', '20'], 100),
			grid(['2000', '4000'], ['0', '20'], 500),
		);
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const fig = referenceFigures(r.aircraft.performance!)!;
			expect(fig.rows).toHaveLength(2);
			expect(fig.rows.every((row) => row.extrapolated)).toBe(true);
			expect(fig.rows.every((row) => Number.isFinite(row.rollM) && Number.isFinite(row.d15M))).toBe(true);
		}
	});

	it('closed-form with takeoff-only configs yields a single takeoff row', () => {
		const d = typeOnlyDraft();
		const p = blankClosedFormPerformanceDraft();
		p.massReferenceLb = '2000';
		const cfg = p.configs[0];
		cfg.flapsDeg = '0';
		for (const m of [cfg.distance15m, cfg.groundRoll]) {
			m.coefficients = ['0', '1', '0', '100'];
			m.headwindPerKt = '0.01';
			m.tailwindPerKt = '0.02';
		}
		d.performance = p;
		const r = draftToAircraft(d);
		expect(r.ok).toBe(true);
		if (r.ok) {
			const fig = referenceFigures(r.aircraft.performance!)!;
			expect(fig.rows).toHaveLength(1);
			expect(fig.rows[0].phase).toBe('takeoff');
			expect(fig.rows[0].d15M).toBeCloseTo(115, 9); // 1 * 15 + 100
		}
	});
});

describe('saveEditedAircraft', () => {
	const gjqk = parseAircraftYaml(loadText('f-gjqk.yaml'));
	// No committed sheet is type-keyed any more (F-GIRV took the PA28-181
	// slot); build one inline to keep covering the type-keyed library edge.
	const pa28 = (() => {
		const d = aircraftToDraft(null);
		d.type = 'PA28-181';
		const r = draftToAircraft(d);
		if (!r.ok) {
			throw new Error(r.errors[0]);
		}
		return r.aircraft;
	})();

	beforeEach(() => {
		aircraftState.library = [gjqk, pa28];
		aircraftState.libraryLoaded = true;
		aircraftState.user = {};
		aircraftState.selectedKey = null;
	});

	function plane(registration: string, type = 'DR400/120'): Aircraft {
		const d = aircraftToDraft(null);
		d.registration = registration;
		d.type = type;
		const r = draftToAircraft(d);
		if (!r.ok) {
			throw new Error(r.errors[0]);
		}
		return r.aircraft;
	}

	function reparse(a: Aircraft): Aircraft {
		return parseAircraftYaml(stringifyAircraftYaml(a));
	}

	it('create: a collision with a fleet key is rejected', () => {
		// The error is a deferred thunk (docs/i18n.md rule 7); its English
		// rendering stays the canonical message these pins read.
		expect(saveEditedAircraft(null, plane('F-GJQK'))?.()).toMatch(/already in the fleet/);
		expect(aircraftState.user).toEqual({});
		expect(aircraftState.selectedKey).toBeNull();
	});

	it('create: a fresh key inserts a user plane and selects it', () => {
		expect(saveEditedAircraft(null, plane('F-NEW'))).toBeNull();
		expect(isUserOnly('F-NEW')).toBe(true);
		expect(aircraftState.selectedKey).toBe('F-NEW');
	});

	it('edit same key: shadows the library plane; editing back drops the shadow', () => {
		const edited = reparse(gjqk);
		edited.fuel!.consumptionLph = 26;
		expect(saveEditedAircraft('F-GJQK', edited)).toBeNull();
		expect(isShadowed('F-GJQK')).toBe(true);
		expect(saveEditedAircraft('F-GJQK', reparse(gjqk))).toBeNull();
		expect(isShadowed('F-GJQK')).toBe(false);
	});

	it('edit re-key: a user-only plane moves and the selection follows', () => {
		saveEditedAircraft(null, plane('F-OLD'));
		expect(aircraftState.selectedKey).toBe('F-OLD');
		expect(saveEditedAircraft('F-OLD', plane('F-NEW'))).toBeNull();
		expect('F-OLD' in aircraftState.user).toBe(false);
		expect(isUserOnly('F-NEW')).toBe(true);
		expect(aircraftState.selectedKey).toBe('F-NEW');
	});

	it('edit re-key: fleet collisions and library keys are rejected', () => {
		saveEditedAircraft(null, plane('F-USR'));
		expect(saveEditedAircraft('F-USR', plane('F-GJQK'))?.()).toMatch(/already in the fleet/);
		// Adding a registration to the type-keyed library PA28-181 re-keys it.
		expect(saveEditedAircraft('PA28-181', plane('F-PAX', 'PA28-181'))?.()).toMatch(/library plane/);
		expect(isLibraryKey('PA28-181')).toBe(true);
		expect('F-PAX' in aircraftState.user).toBe(false);
	});
});
