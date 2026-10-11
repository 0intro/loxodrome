/* What the schema cannot see in a data sheet's figures. The schema checks
 * structure (every number present, a complete grid, limits in order), not
 * physics, and a sheet is a transcription of a flight manual, where a
 * transposed cell or a slipped digit is the error that creeps in. These are
 * the readings such a slip produces:
 * - a table distance falling as the altitude or the temperature rises;
 * - a ground roll not shorter than its distance over 15 m;
 * - a distance at the lightest mass longer than at the heaviest;
 * - tables charted above the envelope's heaviest mass;
 * - a fitted configuration doing any of the first two over the operating
 *   range (sea level to 8000 ft, ISA -20 to ISA +20), or reading no distance;
 * - an envelope outline crossing itself (its points out of order);
 * - a twin's accelerate-stop distance falling as the altitude or the
 *   temperature rises, longer at its lightest mass, or shorter than the
 *   ground roll; its one-engine climb RISING with them, or poorer at its
 *   lightest mass; either table charted above the envelope's top; Vmc not
 *   below Vyse.
 *
 * Warnings, never errors: the editor lists them and never blocks a save. A
 * manual can misprint too: the C182T's POH has its landing distance fall
 * from 1300 ft at sea level to 1265 ft at 1000 ft, 0 °C, in every copy, which
 * these checks found in the generic sheet copying it. The empty aircraft
 * alone is no check, since several manuals' sample weighing sits outside the
 * envelope (the C152's forward of it, the DA 40 NG's and the Elixir's below
 * it). Pure; the editor words each warning. */

import {
	computeAccelerateStop,
	computeClosedFormPerformance,
	computeTablePerformance,
	isaTemperatureC,
	referenceConfig,
	type PerfConditions,
	type PerfPhase,
} from './performance';
import type { Aircraft, ClosedFormMetric, EnvelopePoint, MetricTable, PerfTable, TemperatureAxis } from './schema';

export type DistanceMetric = 'roll' | 'd15';
export type TableMass = 'max' | 'min';

/** A table reading's place, as the editor's grid shows it. */
export interface GridCell {
	phase: PerfPhase;
	altFt: number;
	/** On the table's own axis: an ISA offset, or an outside air temperature. */
	tempC: number;
	axis: TemperatureAxis;
}

/** A fitted configuration, by phase and flaps as its card is titled. */
export interface FitRef {
	phase: PerfPhase;
	flapsDeg: number;
}

/** A twin's one-figure table, by what it holds. */
export type MetricTableRef = 'asd' | 'climb' | 'takeoff-climb';

/** A one-figure table's cell, on the table's own axis. */
export interface MetricCellRef {
	table: MetricTableRef;
	altFt: number;
	tempC: number;
	axis: TemperatureAxis;
}

export type PlausibilityWarning =
	/** Shorter than at the altitude below (same column) or the column before
	 *  (same altitude), that neighbour's place and figure in `from*`. */
	| {
			kind: 'grid-falls';
			cell: GridCell;
			mass: TableMass;
			metric: DistanceMetric;
			along: 'altitude' | 'temperature';
			fromAltFt: number;
			fromTempC: number;
			fromM: number;
			toM: number;
	  }
	| { kind: 'grid-roll-long'; cell: GridCell; mass: TableMass; rollM: number; d15M: number }
	| { kind: 'grid-min-long'; cell: GridCell; metric: DistanceMetric; minM: number; maxM: number }
	| { kind: 'table-mass-above-envelope'; massMaxKg: number; envelopeTopKg: number }
	/** Falling with the temperature at `altFt`, or with the altitude at
	 *  `tempC` (outside air): the fit's slope there. */
	| { kind: 'fit-falls'; config: FitRef; metric: DistanceMetric; along: 'altitude' | 'temperature'; altFt: number; tempC: number }
	| { kind: 'fit-roll-long'; config: FitRef; altFt: number; tempC: number }
	| { kind: 'fit-not-positive'; config: FitRef; metric: DistanceMetric; altFt: number; tempC: number }
	| { kind: 'envelope-crosses' }
	/** A distance falling, or a climb rising, against the altitude below or
	 *  the column before, that neighbour's place and figure in `from*`. */
	| {
			kind: 'metric-wrong-way';
			cell: MetricCellRef;
			mass: TableMass;
			along: 'altitude' | 'temperature';
			fromAltFt: number;
			fromTempC: number;
			from: number;
			to: number;
	  }
	/** A distance longer, or a climb poorer, at the lightest mass. */
	| { kind: 'metric-mass-wrong-way'; cell: MetricCellRef; min: number; max: number }
	| { kind: 'metric-mass-above-envelope'; table: MetricTableRef; massMaxKg: number; envelopeTopKg: number }
	| { kind: 'vmc-not-below-vyse'; vmcKt: number; vyseKt: number }
	/** At sea level, ISA, the accelerate-stop table's heaviest mass. */
	| { kind: 'asd-short'; asdM: number; rollM: number };

/** The editor page each warning's figures are typed on. */
export function plausibilityPage(w: PlausibilityWarning): 'mb' | 'perf' {
	return w.kind === 'envelope-crosses' ? 'mb' : 'perf';
}

const PHASES: PerfPhase[] = ['takeoff', 'landing'];
const MASSES: TableMass[] = ['max', 'min'];
const METRICS: DistanceMetric[] = ['roll', 'd15'];

function figure(row: PerfTable['rows'][number], mass: TableMass, metric: DistanceMetric): number {
	return (mass === 'max' ? row.massMax : row.massMin)[metric === 'roll' ? 0 : 1];
}

function tableWarnings(t: PerfTable, phase: PerfPhase): PlausibilityWarning[] {
	const out: PlausibilityWarning[] = [];
	const nT = t.temperaturesC.length;
	// Rows are parse-sorted by (altitude, temperature) over the full grid.
	const row = (ai: number, ti: number): PerfTable['rows'][number] => t.rows[ai * nT + ti];
	for (let ai = 0; ai < t.altitudesFt.length; ai++) {
		for (let ti = 0; ti < nT; ti++) {
			const r = row(ai, ti);
			const cell: GridCell = { phase, altFt: r.altFt, tempC: r.tempC, axis: t.axis };
			for (const mass of MASSES) {
				for (const metric of METRICS) {
					const toM = figure(r, mass, metric);
					const neighbours: ['altitude' | 'temperature', PerfTable['rows'][number] | null][] = [
						['altitude', ai > 0 ? row(ai - 1, ti) : null],
						['temperature', ti > 0 ? row(ai, ti - 1) : null],
					];
					for (const [along, from] of neighbours) {
						if (from && toM < figure(from, mass, metric)) {
							out.push({
								kind: 'grid-falls',
								cell,
								mass,
								metric,
								along,
								fromAltFt: from.altFt,
								fromTempC: from.tempC,
								fromM: figure(from, mass, metric),
								toM,
							});
						}
					}
				}
				if (figure(r, mass, 'roll') >= figure(r, mass, 'd15')) {
					out.push({ kind: 'grid-roll-long', cell, mass, rollM: figure(r, mass, 'roll'), d15M: figure(r, mass, 'd15') });
				}
			}
			for (const metric of METRICS) {
				if (figure(r, 'min', metric) > figure(r, 'max', metric)) {
					out.push({ kind: 'grid-min-long', cell, metric, minM: figure(r, 'min', metric), maxM: figure(r, 'max', metric) });
				}
			}
		}
	}
	return out;
}

/** The operating range a fit is read over: the pressure altitudes, and the
 *  ISA offsets at each. */
const FIT_ALTITUDES_FT = [0, 2000, 4000, 6000, 8000];
const FIT_ISA_OFFSETS_C = [-20, 0, 20];

function fitAt(m: ClosedFormMetric, altFt: number, tempC: number): number {
	const [a, b, c, d] = m.coefficients;
	return (a * altFt + b) * tempC + (c * altFt + d);
}

function fitWarnings(perf: Extract<NonNullable<Aircraft['performance']>, { kind: 'closed-form' }>): PlausibilityWarning[] {
	const out: PlausibilityWarning[] = [];
	for (const c of perf.configs) {
		const config: FitRef = { phase: c.phase, flapsDeg: c.flapsDeg };
		const metrics: [DistanceMetric, ClosedFormMetric][] = [
			['roll', c.groundRoll],
			['d15', c.distance15m],
		];
		// One warning per rule and metric: the first place it shows.
		const said = new Set<string>();
		const say = (key: string, w: PlausibilityWarning): void => {
			if (!said.has(key)) {
				said.add(key);
				out.push(w);
			}
		};
		for (const altFt of FIT_ALTITUDES_FT) {
			for (const offset of FIT_ISA_OFFSETS_C) {
				const tempC = isaTemperatureC(altFt) + offset;
				for (const [metric, m] of metrics) {
					const [a, b, cc] = m.coefficients;
					if (fitAt(m, altFt, tempC) <= 0) {
						say(`np-${metric}`, { kind: 'fit-not-positive', config, metric, altFt, tempC });
					}
					// The slopes: d/dT = a PA + b, d/dPA = a T + c.
					if (a * altFt + b < 0) {
						say(`ft-${metric}`, { kind: 'fit-falls', config, metric, along: 'temperature', altFt, tempC });
					}
					if (a * tempC + cc < 0) {
						say(`fa-${metric}`, { kind: 'fit-falls', config, metric, along: 'altitude', altFt, tempC });
					}
				}
				if (fitAt(c.groundRoll, altFt, tempC) >= fitAt(c.distance15m, altFt, tempC)) {
					say('rl', { kind: 'fit-roll-long', config, altFt, tempC });
				}
			}
		}
	}
	return out;
}

/** A one-figure table read the way its figure should go: a distance
 *  (`rises`) longer up and hotter and at the heavier mass, a climb shorter. */
function metricWarnings(t: MetricTable, table: MetricTableRef, rises: boolean): PlausibilityWarning[] {
	const out: PlausibilityWarning[] = [];
	const nT = t.temperaturesC.length;
	const row = (ai: number, ti: number): MetricTable['rows'][number] => t.rows[ai * nT + ti];
	const wrong = (to: number, from: number): boolean => (rises ? to < from : to > from);
	for (let ai = 0; ai < t.altitudesFt.length; ai++) {
		for (let ti = 0; ti < nT; ti++) {
			const r = row(ai, ti);
			const cell: MetricCellRef = { table, altFt: r.altFt, tempC: r.tempC, axis: t.axis };
			for (const mass of MASSES) {
				const to = mass === 'max' ? r.massMax : r.massMin;
				const neighbours: ['altitude' | 'temperature', MetricTable['rows'][number] | null][] = [
					['altitude', ai > 0 ? row(ai - 1, ti) : null],
					['temperature', ti > 0 ? row(ai, ti - 1) : null],
				];
				for (const [along, nb] of neighbours) {
					const from = nb ? (mass === 'max' ? nb.massMax : nb.massMin) : null;
					if (nb && from !== null && wrong(to, from)) {
						out.push({ kind: 'metric-wrong-way', cell, mass, along, fromAltFt: nb.altFt, fromTempC: nb.tempC, from, to });
					}
				}
			}
			if (rises ? r.massMin > r.massMax : r.massMin < r.massMax) {
				out.push({ kind: 'metric-mass-wrong-way', cell, min: r.massMin, max: r.massMax });
			}
		}
	}
	return out;
}

/** The take-off ground roll at sea level, ISA, at a mass: the table's, or
 *  the normal take-off configuration's of a fitted sheet; null where there
 *  is no figure. */
function takeoffRollM(perf: NonNullable<Aircraft['performance']>, massKg: number): number | null {
	const c: PerfConditions = { massKg, pressureAltFt: 0, temperatureC: 15, headwindKt: 0, surface: { grass: false, wet: false } };
	if (perf.kind === 'table') {
		const r = computeTablePerformance(perf, 'takeoff', c);
		return r.ok ? r.value.groundRoll.rawM : null;
	}
	const config = referenceConfig(perf, 'takeoff');
	const r = config ? computeClosedFormPerformance(perf, config, c) : null;
	return r?.ok ? r.value.groundRoll.rawM : null;
}

/** A twin's tables and speeds: each one-figure table its own way, its
 *  masses against the envelope's top, Vmc below Vyse, the accelerate-stop
 *  distance beyond the ground roll. */
function twinWarnings(a: Aircraft): PlausibilityWarning[] {
	const out: PlausibilityWarning[] = [];
	const envelopeTopKg = a.massBalance ? Math.max(...a.massBalance.envelope.map((q) => q.massKg)) : null;
	const tables: [MetricTableRef, MetricTable | undefined, boolean][] = [
		['asd', a.performance?.accelerateStop, true],
		['climb', a.oneEngineInoperative?.climb, false],
		['takeoff-climb', a.oneEngineInoperative?.takeoffClimb, false],
	];
	for (const [table, t, rises] of tables) {
		if (!t) {
			continue;
		}
		out.push(...metricWarnings(t, table, rises));
		if (envelopeTopKg !== null && t.massMaxKg > envelopeTopKg) {
			out.push({ kind: 'metric-mass-above-envelope', table, massMaxKg: t.massMaxKg, envelopeTopKg });
		}
	}
	const oei = a.oneEngineInoperative;
	if (oei && oei.vmcKt >= oei.vyseKt) {
		out.push({ kind: 'vmc-not-below-vyse', vmcKt: oei.vmcKt, vyseKt: oei.vyseKt });
	}
	const perf = a.performance;
	if (perf?.accelerateStop) {
		const c: PerfConditions = {
			massKg: perf.accelerateStop.massMaxKg,
			pressureAltFt: 0,
			temperatureC: 15,
			headwindKt: 0,
			surface: { grass: false, wet: false },
		};
		const asd = computeAccelerateStop(perf, c);
		const rollM = takeoffRollM(perf, perf.accelerateStop.massMaxKg);
		if (asd?.ok && rollM !== null && asd.figure.rawM < rollM) {
			out.push({ kind: 'asd-short', asdM: Math.round(asd.figure.rawM), rollM: Math.round(rollM) });
		}
	}
	return out;
}

/** Does the outline cross itself? Two of its sides that share no corner
 *  cutting each other: what listing a point out of turn draws. */
export function envelopeCrosses(env: readonly EnvelopePoint[]): boolean {
	const n = env.length;
	const side = (p: EnvelopePoint, q: EnvelopePoint, r: EnvelopePoint): number =>
		Math.sign((q.armM - p.armM) * (r.massKg - p.massKg) - (q.massKg - p.massKg) * (r.armM - p.armM));
	for (let i = 0; i < n; i++) {
		for (let j = i + 2; j < n; j++) {
			if (i === 0 && j === n - 1) {
				continue; // the closing side meets the first at a corner
			}
			const a = env[i];
			const b = env[(i + 1) % n];
			const c = env[j];
			const d = env[(j + 1) % n];
			if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) {
				return true;
			}
		}
	}
	return false;
}

/** The figures to check on a sheet that validates. */
export function plausibilityWarnings(a: Aircraft): PlausibilityWarning[] {
	const out: PlausibilityWarning[] = [];
	const p = a.performance;
	if (p?.kind === 'table') {
		for (const phase of PHASES) {
			out.push(...tableWarnings(phase === 'takeoff' ? p.takeoff : p.landing, phase));
		}
		if (a.massBalance) {
			const envelopeTopKg = Math.max(...a.massBalance.envelope.map((q) => q.massKg));
			if (p.massMaxKg > envelopeTopKg) {
				out.push({ kind: 'table-mass-above-envelope', massMaxKg: p.massMaxKg, envelopeTopKg });
			}
		}
	} else if (p?.kind === 'closed-form') {
		out.push(...fitWarnings(p));
	}
	if (a.massBalance && envelopeCrosses(a.massBalance.envelope)) {
		out.push({ kind: 'envelope-crosses' });
	}
	out.push(...twinWarnings(a));
	return out;
}
