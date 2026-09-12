/* Aircraft editor draft: a string-typed mirror of the data-sheet schema so
 * partially-typed input never fights the user, with the optional sections
 * (fuel / cruise / climb / descent / mass and balance / performance)
 * present-or-absent as
 * null. The table-performance draft holds the two axes explicitly and a
 * rectangular cells matrix, so grid completeness is structural; flattening
 * happens on conversion. draftToAircraft builds a YAML-document-shaped
 * record and validates it through parseAircraftDoc, so every error message
 * stays canonical (field-path prefixed). Pure (no Svelte, no I/O). */

import {
	AIRCRAFT_DOC_VERSION,
	parseAircraftDoc,
	type Aircraft,
	type AircraftFuel,
	type AircraftMassBalance,
	type AircraftPerformance,
	type AircraftVerticalSpeed,
	type ClosedFormMetric,
	type EnvelopePoint,
	type FuelType,
	type PerfTable,
} from './schema';
import {
	computeClosedFormPerformance,
	computeTablePerformance,
	verdictConfig,
	KG_TO_LB,
	type PerfConditions,
	type PerfPhase,
} from './performance';

export type AircraftEditorPage = 'general' | 'mb' | 'perf' | 'yaml';

export interface FuelPresetDraft {
	name: string;
	label: string;
	litres: string;
}

export interface FuelDraft {
	capacityL: string;
	/** Empty = usable equals capacity (the schema default). */
	usableL: string;
	types: FuelType[];
	type: FuelType;
	consumptionLph: string;
	presets: FuelPresetDraft[];
}

export interface CruiseDraft {
	speedKt: string;
}

/** Climb / descent regime: speed flown + the vertical rate it yields. */
export interface VerticalSpeedDraft {
	speedKt: string;
	rateFtMin: string;
}

export interface StationDraft {
	label: string;
	armM: string;
	defaultMassKg: string;
}

export interface EnvelopePointDraft {
	armM: string;
	massKg: string;
}

export interface MassBalanceDraft {
	emptyMassKg: string;
	emptyArmM: string;
	stations: StationDraft[];
	fuelArmM: string;
	envelope: EnvelopePointDraft[];
}

export interface WindAnchorDraft {
	kt: string;
	factor: string;
}

export interface PerfCellDraft {
	massMaxRoll: string;
	massMaxD15: string;
	massMinRoll: string;
	massMinD15: string;
}

export interface PerfGridDraft {
	altitudesFt: string[];
	isaOffsetsC: string[];
	/** cells[altIdx][isaIdx]; the editors keep it rectangular. */
	cells: PerfCellDraft[][];
}

interface PerformanceCommonDraft {
	/** Empty = the schema default (1.3). */
	marginFactor: string;
	/** Empty = 1.15. */
	grassFactor: string;
	/** Empty = 1.15. */
	wetFactor: string;
	/** Empty = absent. */
	flaplessLandingFactor: string;
}

export interface TablePerformanceDraft extends PerformanceCommonDraft {
	kind: 'table';
	massMaxKg: string;
	massMinKg: string;
	takeoffHeadwind: WindAnchorDraft[];
	landingHeadwind: WindAnchorDraft[];
	/** Empty = the schema default (10). */
	tailwindPctPer2Kt: string;
	takeoff: PerfGridDraft;
	landing: PerfGridDraft;
}

export interface ClosedFormMetricDraft {
	coefficients: [string, string, string, string];
	headwindPerKt: string;
	tailwindPerKt: string;
}

export interface ClosedFormConfigDraft {
	phase: 'takeoff' | 'landing';
	flapsDeg: string;
	isDefault: boolean;
	/** Empty = 0 (no mass term). */
	massExponent: string;
	distance15m: ClosedFormMetricDraft;
	groundRoll: ClosedFormMetricDraft;
}

export interface ClosedFormPerformanceDraft extends PerformanceCommonDraft {
	kind: 'closed-form';
	massReferenceLb: string;
	configs: ClosedFormConfigDraft[];
}

export type PerformanceDraft = TablePerformanceDraft | ClosedFormPerformanceDraft;

export interface AircraftDraft {
	registration: string;
	type: string;
	icaoType: string;
	name: string;
	operator: string;
	fuel: FuelDraft | null;
	cruise: CruiseDraft | null;
	climb: VerticalSpeedDraft | null;
	descent: VerticalSpeedDraft | null;
	massBalance: MassBalanceDraft | null;
	performance: PerformanceDraft | null;
	notes: string;
	source: string;
}

export type DraftResult =
	| { ok: true; aircraft: Aircraft }
	| { ok: false; errors: string[] };

/* ---- blank factories (the editor's Add buttons) ---- */

export function blankPresetDraft(): FuelPresetDraft {
	return { name: '', label: '', litres: '' };
}

export function blankFuelDraft(): FuelDraft {
	return { capacityL: '', usableL: '', types: ['100LL'], type: '100LL', consumptionLph: '', presets: [] };
}

export function blankCruiseDraft(): CruiseDraft {
	return { speedKt: '' };
}

export function blankVerticalSpeedDraft(): VerticalSpeedDraft {
	return { speedKt: '', rateFtMin: '' };
}

export function blankStationDraft(): StationDraft {
	return { label: '', armM: '', defaultMassKg: '' };
}

export function blankEnvelopePointDraft(): EnvelopePointDraft {
	return { armM: '', massKg: '' };
}

export function blankMassBalanceDraft(): MassBalanceDraft {
	return {
		emptyMassKg: '',
		emptyArmM: '',
		stations: [],
		fuelArmM: '',
		envelope: [blankEnvelopePointDraft(), blankEnvelopePointDraft(), blankEnvelopePointDraft()],
	};
}

export function blankPerfCell(): PerfCellDraft {
	return { massMaxRoll: '', massMaxD15: '', massMinRoll: '', massMinD15: '' };
}

function blankGridDraft(): PerfGridDraft {
	return {
		altitudesFt: ['', ''],
		isaOffsetsC: ['', ''],
		cells: [
			[blankPerfCell(), blankPerfCell()],
			[blankPerfCell(), blankPerfCell()],
		],
	};
}

export function blankTablePerformanceDraft(): TablePerformanceDraft {
	return {
		kind: 'table',
		marginFactor: '',
		grassFactor: '',
		wetFactor: '',
		flaplessLandingFactor: '',
		massMaxKg: '',
		massMinKg: '',
		takeoffHeadwind: [{ kt: '0', factor: '1' }],
		landingHeadwind: [{ kt: '0', factor: '1' }],
		tailwindPctPer2Kt: '',
		takeoff: blankGridDraft(),
		landing: blankGridDraft(),
	};
}

function blankMetricDraft(): ClosedFormMetricDraft {
	return { coefficients: ['', '', '', ''], headwindPerKt: '', tailwindPerKt: '' };
}

export function blankClosedFormConfigDraft(phase: 'takeoff' | 'landing'): ClosedFormConfigDraft {
	return {
		phase,
		flapsDeg: '',
		isDefault: false,
		massExponent: '',
		distance15m: blankMetricDraft(),
		groundRoll: blankMetricDraft(),
	};
}

export function blankClosedFormPerformanceDraft(): ClosedFormPerformanceDraft {
	return {
		kind: 'closed-form',
		marginFactor: '',
		grassFactor: '',
		wetFactor: '',
		flaplessLandingFactor: '',
		massReferenceLb: '',
		configs: [blankClosedFormConfigDraft('takeoff')],
	};
}

/* ---- aircraft -> draft ---- */

function fuelToDraft(f: AircraftFuel): FuelDraft {
	return {
		capacityL: String(f.capacityL),
		// Matches what stringifyAircraftYaml omits; the parsed value cannot
		// distinguish "omitted" from "explicitly equal" anyway.
		usableL: f.usableL === f.capacityL ? '' : String(f.usableL),
		types: [...f.types],
		type: f.type,
		consumptionLph: f.consumptionLph == null ? '' : String(f.consumptionLph),
		presets: f.presets.map((p) => ({ name: p.name, label: p.label ?? '', litres: String(p.litres) })),
	};
}

function massBalanceToDraft(m: AircraftMassBalance): MassBalanceDraft {
	return {
		emptyMassKg: String(m.emptyMassKg),
		emptyArmM: String(m.emptyArmM),
		stations: m.stations.map((s) => ({
			label: s.label,
			armM: String(s.armM),
			defaultMassKg: String(s.defaultMassKg),
		})),
		fuelArmM: String(m.fuelArmM),
		envelope: m.envelope.map((p) => ({ armM: String(p.armM), massKg: String(p.massKg) })),
	};
}

function gridToDraft(t: PerfTable): PerfGridDraft {
	// Rows are parse-sorted by (altFt, isaOffsetC) over the complete grid,
	// so the row for (altIdx, isaIdx) sits at altIdx * nIsa + isaIdx.
	const nIsa = t.isaOffsetsC.length;
	return {
		altitudesFt: t.altitudesFt.map(String),
		isaOffsetsC: t.isaOffsetsC.map(String),
		cells: t.altitudesFt.map((_, ai) =>
			t.isaOffsetsC.map((_2, ii) => {
				const r = t.rows[ai * nIsa + ii];
				return {
					massMaxRoll: String(r.massMax[0]),
					massMaxD15: String(r.massMax[1]),
					massMinRoll: String(r.massMin[0]),
					massMinD15: String(r.massMin[1]),
				};
			}),
		),
	};
}

function metricToDraft(m: ClosedFormMetric): ClosedFormMetricDraft {
	return {
		coefficients: [
			String(m.coefficients[0]),
			String(m.coefficients[1]),
			String(m.coefficients[2]),
			String(m.coefficients[3]),
		],
		headwindPerKt: String(m.headwindPerKt),
		tailwindPerKt: String(m.tailwindPerKt),
	};
}

function performanceToDraft(p: AircraftPerformance): PerformanceDraft {
	const common: PerformanceCommonDraft = {
		marginFactor: String(p.marginFactor),
		grassFactor: String(p.grassFactor),
		wetFactor: String(p.wetFactor),
		flaplessLandingFactor: p.flaplessLandingFactor == null ? '' : String(p.flaplessLandingFactor),
	};
	if (p.kind === 'table') {
		return {
			...common,
			kind: 'table',
			massMaxKg: String(p.massMaxKg),
			massMinKg: String(p.massMinKg),
			takeoffHeadwind: p.wind.takeoffHeadwind.map((a) => ({ kt: String(a[0]), factor: String(a[1]) })),
			landingHeadwind: p.wind.landingHeadwind.map((a) => ({ kt: String(a[0]), factor: String(a[1]) })),
			tailwindPctPer2Kt: String(p.wind.tailwindPctPer2Kt),
			takeoff: gridToDraft(p.takeoff),
			landing: gridToDraft(p.landing),
		};
	}
	return {
		...common,
		kind: 'closed-form',
		massReferenceLb: String(p.massReferenceLb),
		configs: p.configs.map((c) => ({
			phase: c.phase,
			flapsDeg: String(c.flapsDeg),
			isDefault: c.default === true,
			massExponent: String(c.massExponent),
			distance15m: metricToDraft(c.distance15m),
			groundRoll: metricToDraft(c.groundRoll),
		})),
	};
}

/** Draft for an existing aircraft, or the blank create draft for null. */
export function aircraftToDraft(a: Aircraft | null): AircraftDraft {
	if (!a) {
		return {
			registration: '',
			type: '',
			icaoType: '',
			name: '',
			operator: '',
			fuel: null,
			cruise: null,
			climb: null,
			descent: null,
			massBalance: null,
			performance: null,
			notes: '',
			source: '',
		};
	}
	const vspeedToDraft = (v: AircraftVerticalSpeed): VerticalSpeedDraft => ({
		speedKt: String(v.speedKt),
		rateFtMin: String(v.rateFtMin),
	});
	return {
		registration: a.identity.registration ?? '',
		type: a.identity.type,
		icaoType: a.identity.icaoType ?? '',
		name: a.identity.name ?? '',
		operator: a.identity.operator ?? '',
		fuel: a.fuel ? fuelToDraft(a.fuel) : null,
		cruise: a.cruise ? { speedKt: String(a.cruise.speedKt) } : null,
		climb: a.climb ? vspeedToDraft(a.climb) : null,
		descent: a.descent ? vspeedToDraft(a.descent) : null,
		massBalance: a.massBalance ? massBalanceToDraft(a.massBalance) : null,
		performance: a.performance ? performanceToDraft(a.performance) : null,
		notes: a.notes ?? '',
		source: a.source ?? '',
	};
}

/** Duplicate draft: a copy with the registration cleared, so the user must
 *  pick a new key before the save-time collision check passes. */
export function duplicateDraft(a: Aircraft): AircraftDraft {
	return { ...aircraftToDraft(a), registration: '' };
}

/* ---- draft -> aircraft ---- */

function str(s: string): string | undefined {
	const t = s.trim();
	return t === '' ? undefined : t;
}

// Empty = key omitted; NaN flows through so reqNumber produces the canonical
// "must be a finite number". Number, not parseFloat, so '12abc' fails.
function num(s: string): number | undefined {
	const t = s.trim();
	return t === '' ? undefined : Number(t);
}

function gridDoc(g: PerfGridDraft): unknown[] {
	const rows: unknown[] = [];
	for (const [ai, alt] of g.altitudesFt.entries()) {
		for (const [ii, isa] of g.isaOffsetsC.entries()) {
			const c = g.cells[ai]?.[ii] ?? blankPerfCell();
			rows.push({
				altFt: num(alt),
				isaOffsetC: num(isa),
				massMax: [num(c.massMaxRoll), num(c.massMaxD15)],
				massMin: [num(c.massMinRoll), num(c.massMinD15)],
			});
		}
	}
	return rows;
}

function metricDoc(m: ClosedFormMetricDraft): unknown {
	return {
		coefficients: m.coefficients.map(num),
		headwindPerKt: num(m.headwindPerKt),
		tailwindPerKt: num(m.tailwindPerKt),
	};
}

function performanceDraftDoc(p: PerformanceDraft): Record<string, unknown> {
	const out: Record<string, unknown> = {
		kind: p.kind,
		marginFactor: num(p.marginFactor),
		grassFactor: num(p.grassFactor),
		wetFactor: num(p.wetFactor),
		flaplessLandingFactor: num(p.flaplessLandingFactor),
	};
	if (p.kind === 'table') {
		out.massMaxKg = num(p.massMaxKg);
		out.massMinKg = num(p.massMinKg);
		out.wind = {
			takeoffHeadwind: p.takeoffHeadwind.map((a) => [num(a.kt), num(a.factor)]),
			landingHeadwind: p.landingHeadwind.map((a) => [num(a.kt), num(a.factor)]),
			tailwindPctPer2Kt: num(p.tailwindPctPer2Kt),
		};
		out.takeoff = gridDoc(p.takeoff);
		out.landing = gridDoc(p.landing);
	} else {
		out.massReferenceLb = num(p.massReferenceLb);
		out.configs = p.configs.map((c) => ({
			phase: c.phase,
			flapsDeg: num(c.flapsDeg),
			default: c.isDefault ? true : undefined,
			massExponent: num(c.massExponent),
			distance15m: metricDoc(c.distance15m),
			groundRoll: metricDoc(c.groundRoll),
		}));
	}
	return out;
}

/** Convert + validate a draft. Builds a document-shaped record (empty
 *  optional fields omitted, so the schema defaults apply) and runs it
 *  through parseAircraftDoc for the canonical error messages. */
export function draftToAircraft(d: AircraftDraft): DraftResult {
	const doc: Record<string, unknown> = { version: AIRCRAFT_DOC_VERSION };
	doc.aircraft = {
		registration: str(d.registration),
		type: str(d.type),
		icaoType: str(d.icaoType),
		name: str(d.name),
		operator: str(d.operator),
	};
	if (d.fuel) {
		doc.fuel = {
			capacityL: num(d.fuel.capacityL),
			usableL: num(d.fuel.usableL),
			// Always emitted: an empty list must hit the canonical error, not
			// the silent ['100LL'] default of an absent key.
			types: [...d.fuel.types],
			type: d.fuel.type,
			consumptionLph: num(d.fuel.consumptionLph),
			presets:
				d.fuel.presets.length === 0
					? undefined
					: d.fuel.presets.map((p) => ({ name: str(p.name), label: str(p.label), litres: num(p.litres) })),
		};
	}
	if (d.cruise) {
		doc.cruise = { speedKt: num(d.cruise.speedKt) };
	}
	if (d.climb) {
		doc.climb = { speedKt: num(d.climb.speedKt), rateFtMin: num(d.climb.rateFtMin) };
	}
	if (d.descent) {
		doc.descent = { speedKt: num(d.descent.speedKt), rateFtMin: num(d.descent.rateFtMin) };
	}
	if (d.massBalance) {
		doc.massAndBalance = {
			emptyMassKg: num(d.massBalance.emptyMassKg),
			emptyArmM: num(d.massBalance.emptyArmM),
			stations: d.massBalance.stations.map((s) => ({
				label: str(s.label),
				armM: num(s.armM),
				defaultMassKg: num(s.defaultMassKg),
			})),
			fuelArmM: num(d.massBalance.fuelArmM),
			envelope: d.massBalance.envelope.map((p) => ({ armM: num(p.armM), massKg: num(p.massKg) })),
		};
	}
	if (d.performance) {
		doc.performance = performanceDraftDoc(d.performance);
	}
	doc.notes = str(d.notes);
	doc.source = str(d.source);
	try {
		return { ok: true, aircraft: parseAircraftDoc(doc) };
	} catch (e) {
		return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
	}
}

/* ---- editor helpers ---- */

/** The rows of a draft envelope that already hold finite numbers, for the
 *  live chart preview while the rest is being typed. */
export function draftEnvelopePoints(mb: MassBalanceDraft): EnvelopePoint[] {
	const out: EnvelopePoint[] = [];
	for (const p of mb.envelope) {
		const arm = p.armM.trim();
		const mass = p.massKg.trim();
		if (arm === '' || mass === '') {
			continue;
		}
		const armM = Number(arm);
		const massKg = Number(mass);
		if (Number.isFinite(armM) && Number.isFinite(massKg) && massKg > 0) {
			out.push({ armM, massKg });
		}
	}
	return out;
}

/* ---- reference figures (the editor's live sanity readout) ---- */

export interface ReferenceFigureRow {
	phase: PerfPhase;
	/** Closed-form: the verdict config's flaps, for the row label. */
	flapsDeg: number | null;
	rollM: number;
	d15M: number;
	/** A table grid not anchored at sea level / ISA still computes, flagged. */
	extrapolated: boolean;
}

export interface ReferenceFigures {
	massKg: number;
	/** The closed-form reference mass as stated in the sheet. */
	massLb: number | null;
	rows: ReferenceFigureRow[];
}

const REFERENCE_PHASES: PerfPhase[] = ['takeoff', 'landing'];

/** Unfactored distances at sea level, ISA, max mass, no wind, dry hard
 *  runway: directly comparable with the POH page the sheet was typed from,
 *  and computed through the real interpolation / evaluation pipeline so a
 *  transposed cell shows up immediately. Null when nothing is computable. */
export function referenceFigures(perf: AircraftPerformance): ReferenceFigures | null {
	const massKg = perf.kind === 'table' ? perf.massMaxKg : perf.massReferenceLb / KG_TO_LB;
	const conditions: PerfConditions = {
		massKg,
		pressureAltFt: 0,
		temperatureC: 15,
		headwindKt: 0,
		surface: { grass: false, wet: false },
	};
	const rows: ReferenceFigureRow[] = [];
	for (const phase of REFERENCE_PHASES) {
		if (perf.kind === 'table') {
			const r = computeTablePerformance(perf, phase, conditions);
			if (r.ok) {
				const f = r.value.flags;
				rows.push({
					phase,
					flapsDeg: null,
					rollM: r.value.groundRoll.rawM,
					d15M: r.value.distance15m.rawM,
					extrapolated:
						f.massExtrapolated || f.altitudeExtrapolatedBelow || f.temperatureExtrapolated,
				});
			}
		} else {
			const config = verdictConfig(perf, phase);
			if (config) {
				const r = computeClosedFormPerformance(perf, config, conditions);
				if (r.ok) {
					rows.push({
						phase,
						flapsDeg: config.flapsDeg,
						rollM: r.value.groundRoll.rawM,
						d15M: r.value.distance15m.rawM,
						extrapolated: false,
					});
				}
			}
		}
	}
	if (rows.length === 0) {
		return null;
	}
	return { massKg, massLb: perf.kind === 'closed-form' ? perf.massReferenceLb : null, rows };
}

/** Spinner step for a numeric draft field: one unit of the value's last
 *  decimal place ('0.41' -> '0.01', '2.045' -> '0.001', '0.0000537' ->
 *  '0.0000001', '5e-7' -> '0.0000001', integers and blanks -> '1'), so the
 *  up/down arrows nudge the decimals instead of jumping whole integers. The
 *  value is always on its own step grid, so the step never makes the input
 *  invalid. */
export function decimalStep(value: string): string {
	const t = value.trim();
	// Exponent notation ('5e-7', '5.37e-7'): one unit of the effective last
	// decimal place, 10^(exponent - mantissa decimals), so the value stays
	// on its own step grid instead of getting the invalid step '1'.
	const e = /^-?\d+(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(t);
	if (e) {
		const k = Number(e[2]) - (e[1]?.length ?? 0);
		return k >= 0 ? String(10 ** k) : (10 ** k).toFixed(-k);
	}
	const m = /\.(\d+)$/.exec(t);
	if (!m) {
		return '1';
	}
	return `0.${'0'.repeat(m[1].length - 1)}1`;
}

const ERROR_PREFIX = 'Invalid aircraft file: ';

/** The editor page a validation message belongs to, by its field path. */
export function errorPage(message: string): 'general' | 'mb' | 'perf' {
	const m = message.startsWith(ERROR_PREFIX) ? message.slice(ERROR_PREFIX.length) : message;
	if (m.startsWith('massAndBalance')) {
		return 'mb';
	}
	if (m.startsWith('performance')) {
		return 'perf';
	}
	return 'general';
}
