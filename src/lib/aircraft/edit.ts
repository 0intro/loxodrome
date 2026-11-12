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
	FUEL_TYPE_INFO,
	parseAircraftDoc,
	perfRowKey,
	type Aircraft,
	type AircraftFuel,
	type AircraftMassBalance,
	type AircraftPerformance,
	type AircraftVerticalSpeed,
	type AccelerateStop,
	type ClosedFormMetric,
	type MetricTable,
	type OneEngineInoperative,
	type EnvelopePoint,
	type FuelType,
	type PerfTable,
	type TakeoffProcedure,
	type TemperatureAxis,
} from './schema';
import {
	computeAccelerateStop,
	computeClosedFormPerformance,
	computeTablePerformance,
	isaTemperatureC,
	referenceConfig,
	KG_TO_LB,
	type PerfConditions,
	type PerfPhase,
} from './performance';
import { oeiNetCeiling, type NetCeiling } from './oneEngine';
import { fuelMomentKgM, type FuelSlot } from './massBalance';

export type AircraftEditorPage = 'general' | 'mb' | 'perf' | 'yaml';

export interface FuelPresetDraft {
	name: string;
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

/** One of the manual's other cruise settings, as typed. */
export interface CruiseSettingDraft {
	name: string;
	speedKt: string;
	consumptionLph: string;
}

export interface CruiseDraft {
	speedKt: string;
	/** The default setting's name in the manual, '' for none. */
	name: string;
	settings: CruiseSettingDraft[];
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
	/** Empty = no published limit. */
	maxMassKg: string;
}

export interface EnvelopePointDraft {
	armM: string;
	massKg: string;
}

/** One fuel tank, in the order the fuel goes in. */
export interface FuelTankDraft {
	label: string;
	armM: string;
	capacityL: string;
	/** Empty = usable equals capacity (the schema default). */
	usableL: string;
}

export interface MassBalanceDraft {
	emptyMassKg: string;
	emptyArmM: string;
	stations: StationDraft[];
	/** The one fuel arm; not read while the tanks list holds rows. */
	fuelArmM: string;
	/** The tanks, in the order filled (two or more), or none: the fuel arm. */
	fuelTanks: FuelTankDraft[];
	envelope: EnvelopePointDraft[];
	/** Empty = no limit below the envelope's top. */
	maxLandingMassKg: string;
	/** Empty = no zero-fuel limit. */
	maxZeroFuelMassKg: string;
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
	/** What the temperature columns are: ISA offsets or outside air
	 *  temperatures (the rows' YAML key). */
	axis: TemperatureAxis;
	temperaturesC: string[];
	/** cells[altIdx][tempIdx]; the editors keep it rectangular. */
	cells: PerfCellDraft[][];
}

/** One cell of a one-figure grid, at its two masses, as typed. */
export interface MetricCellDraft {
	massMax: string;
	massMin: string;
}

/** A one-figure table (accelerate-stop, one engine inoperative climb): its
 *  own masses, the axes, the rectangular cells. */
export interface MetricTableDraft {
	massMaxKg: string;
	massMinKg: string;
	altitudesFt: string[];
	axis: TemperatureAxis;
	temperaturesC: string[];
	/** cells[altIdx][tempIdx]; the editors keep it rectangular. */
	cells: MetricCellDraft[][];
}

export interface AccelerateStopDraft extends MetricTableDraft {
	/** No anchor = no headwind credit (the schema's absent key). */
	headwind: WindAnchorDraft[];
	/** Empty = the default (10). */
	tailwindPctPer2Kt: string;
}

/** A twin's one engine inoperative section, as typed. */
export interface OneEngineDraft {
	vmcKt: string;
	vyseKt: string;
	/** Empty = not stated. */
	vxseKt: string;
	climb: MetricTableDraft | null;
	takeoffClimb: MetricTableDraft | null;
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
	accelerateStop: AccelerateStopDraft | null;
}

export interface TablePerformanceDraft extends PerformanceCommonDraft {
	kind: 'table';
	massMaxKg: string;
	massMinKg: string;
	/** The configuration the tables were charted at; empty = not stated. */
	takeoffFlapsDeg: string;
	takeoffProcedure: '' | TakeoffProcedure;
	landingFlapsDeg: string;
	/** The manual holds its lightest mass and coldest column below them. */
	holdBelowTable: boolean;
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
	/** Take-off only; empty = not stated. */
	procedure: '' | TakeoffProcedure;
	/** Landing only: the config the landing verdict reads. */
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
	/** A generic library sheet's id, '' for every other plane. Carried so a
	 *  generic sheet round-trips; never typed (the editor shows no field). */
	generic: string;
	/** '2' for a twin. A select, never a box. */
	engines: '1' | '2';
	fuel: FuelDraft | null;
	cruise: CruiseDraft | null;
	climb: VerticalSpeedDraft | null;
	descent: VerticalSpeedDraft | null;
	massBalance: MassBalanceDraft | null;
	performance: PerformanceDraft | null;
	/** Kept while the engines read 1, written only for a twin, so a slip of
	 *  the select loses nothing. */
	oneEngine: OneEngineDraft | null;
	notes: string;
	source: string;
}

export type DraftResult =
	| { ok: true; aircraft: Aircraft }
	| { ok: false; errors: string[] };

/* ---- blank factories (the editor's Add buttons) ---- */

export function blankPresetDraft(): FuelPresetDraft {
	return { name: '', litres: '' };
}

export function blankFuelDraft(): FuelDraft {
	return { capacityL: '', usableL: '', types: ['100LL'], type: '100LL', consumptionLph: '', presets: [] };
}

export function blankCruiseDraft(): CruiseDraft {
	return { speedKt: '', name: '', settings: [] };
}

export function blankCruiseSettingDraft(): CruiseSettingDraft {
	return { name: '', speedKt: '', consumptionLph: '' };
}

export function blankVerticalSpeedDraft(): VerticalSpeedDraft {
	return { speedKt: '', rateFtMin: '' };
}

export function blankStationDraft(): StationDraft {
	return { label: '', armM: '', defaultMassKg: '', maxMassKg: '' };
}

export function blankEnvelopePointDraft(): EnvelopePointDraft {
	return { armM: '', massKg: '' };
}

export function blankFuelTankDraft(): FuelTankDraft {
	return { label: '', armM: '', capacityL: '', usableL: '' };
}

export function blankMassBalanceDraft(): MassBalanceDraft {
	return {
		emptyMassKg: '',
		emptyArmM: '',
		stations: [],
		fuelArmM: '',
		fuelTanks: [],
		envelope: [blankEnvelopePointDraft(), blankEnvelopePointDraft(), blankEnvelopePointDraft()],
		maxLandingMassKg: '',
		maxZeroFuelMassKg: '',
	};
}

export function blankPerfCell(): PerfCellDraft {
	return { massMaxRoll: '', massMaxD15: '', massMinRoll: '', massMinD15: '' };
}

function blankGridDraft(): PerfGridDraft {
	return {
		altitudesFt: ['', ''],
		axis: 'isa-offset',
		temperaturesC: ['', ''],
		cells: [
			[blankPerfCell(), blankPerfCell()],
			[blankPerfCell(), blankPerfCell()],
		],
	};
}

export function blankMetricCell(): MetricCellDraft {
	return { massMax: '', massMin: '' };
}

export function blankMetricTableDraft(): MetricTableDraft {
	return {
		massMaxKg: '',
		massMinKg: '',
		altitudesFt: ['', ''],
		axis: 'isa-offset',
		temperaturesC: ['', ''],
		cells: [
			[blankMetricCell(), blankMetricCell()],
			[blankMetricCell(), blankMetricCell()],
		],
	};
}

export function blankAccelerateStopDraft(): AccelerateStopDraft {
	return { ...blankMetricTableDraft(), headwind: [], tailwindPctPer2Kt: '' };
}

export function blankOneEngineDraft(): OneEngineDraft {
	return { vmcKt: '', vyseKt: '', vxseKt: '', climb: blankMetricTableDraft(), takeoffClimb: null };
}

export function blankTablePerformanceDraft(): TablePerformanceDraft {
	return {
		kind: 'table',
		marginFactor: '',
		grassFactor: '',
		wetFactor: '',
		flaplessLandingFactor: '',
		accelerateStop: null,
		massMaxKg: '',
		massMinKg: '',
		takeoffFlapsDeg: '',
		takeoffProcedure: '',
		landingFlapsDeg: '',
		holdBelowTable: false,
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
		procedure: '',
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
		accelerateStop: null,
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
		presets: f.presets.map((p) => ({ name: p.name, litres: String(p.litres) })),
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
			maxMassKg: s.maxMassKg == null ? '' : String(s.maxMassKg),
		})),
		fuelArmM: m.fuelArmM == null ? '' : String(m.fuelArmM),
		fuelTanks: (m.fuelTanks ?? []).map((t) => ({
			label: t.label,
			armM: String(t.armM),
			capacityL: String(t.capacityL),
			usableL: t.usableL === t.capacityL ? '' : String(t.usableL),
		})),
		envelope: m.envelope.map((p) => ({ armM: String(p.armM), massKg: String(p.massKg) })),
		maxLandingMassKg: m.maxLandingMassKg == null ? '' : String(m.maxLandingMassKg),
		maxZeroFuelMassKg: m.maxZeroFuelMassKg == null ? '' : String(m.maxZeroFuelMassKg),
	};
}

function gridToDraft(t: PerfTable): PerfGridDraft {
	// Rows are parse-sorted by (altFt, tempC) over the complete grid, so the
	// row for (altIdx, tempIdx) sits at altIdx * nTemp + tempIdx.
	const nTemp = t.temperaturesC.length;
	return {
		altitudesFt: t.altitudesFt.map(String),
		axis: t.axis,
		temperaturesC: t.temperaturesC.map(String),
		cells: t.altitudesFt.map((_, ai) =>
			t.temperaturesC.map((_2, ii) => {
				const r = t.rows[ai * nTemp + ii];
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

function metricTableToDraft(t: MetricTable): MetricTableDraft {
	const nTemp = t.temperaturesC.length;
	return {
		massMaxKg: String(t.massMaxKg),
		massMinKg: String(t.massMinKg),
		altitudesFt: t.altitudesFt.map(String),
		axis: t.axis,
		temperaturesC: t.temperaturesC.map(String),
		cells: t.altitudesFt.map((_, ai) =>
			t.temperaturesC.map((_2, ii) => {
				const r = t.rows[ai * nTemp + ii];
				return { massMax: String(r.massMax), massMin: String(r.massMin) };
			}),
		),
	};
}

function accelerateStopToDraft(a: AccelerateStop): AccelerateStopDraft {
	return {
		...metricTableToDraft(a),
		headwind: (a.headwind ?? []).map((x) => ({ kt: String(x[0]), factor: String(x[1]) })),
		tailwindPctPer2Kt: a.tailwindPctPer2Kt == null ? '' : String(a.tailwindPctPer2Kt),
	};
}

function oneEngineToDraft(o: OneEngineInoperative): OneEngineDraft {
	return {
		vmcKt: String(o.vmcKt),
		vyseKt: String(o.vyseKt),
		vxseKt: o.vxseKt == null ? '' : String(o.vxseKt),
		climb: o.climb ? metricTableToDraft(o.climb) : null,
		takeoffClimb: o.takeoffClimb ? metricTableToDraft(o.takeoffClimb) : null,
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
		accelerateStop: p.accelerateStop ? accelerateStopToDraft(p.accelerateStop) : null,
	};
	if (p.kind === 'table') {
		return {
			...common,
			kind: 'table',
			massMaxKg: String(p.massMaxKg),
			massMinKg: String(p.massMinKg),
			takeoffFlapsDeg: p.takeoffFlapsDeg == null ? '' : String(p.takeoffFlapsDeg),
			takeoffProcedure: p.takeoffProcedure ?? '',
			landingFlapsDeg: p.landingFlapsDeg == null ? '' : String(p.landingFlapsDeg),
			holdBelowTable: p.holdBelowTable === true,
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
			procedure: c.procedure ?? '',
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
			generic: '',
			engines: '1',
			fuel: null,
			cruise: null,
			climb: null,
			descent: null,
			massBalance: null,
			performance: null,
			oneEngine: null,
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
		generic: a.identity.generic ?? '',
		engines: a.identity.engines === 2 ? '2' : '1',
		fuel: a.fuel ? fuelToDraft(a.fuel) : null,
		cruise: a.cruise
			? {
					speedKt: String(a.cruise.speedKt),
					name: a.cruise.name ?? '',
					settings: (a.cruise.settings ?? []).map((s) => ({
						name: s.name,
						speedKt: String(s.speedKt),
						consumptionLph: String(s.consumptionLph),
					})),
				}
			: null,
		climb: a.climb ? vspeedToDraft(a.climb) : null,
		descent: a.descent ? vspeedToDraft(a.descent) : null,
		massBalance: a.massBalance ? massBalanceToDraft(a.massBalance) : null,
		performance: a.performance ? performanceToDraft(a.performance) : null,
		oneEngine: a.oneEngineInoperative ? oneEngineToDraft(a.oneEngineInoperative) : null,
		notes: a.notes ?? '',
		source: a.source ?? '',
	};
}

/** Duplicate draft: a copy with the registration cleared, so the user must
 *  pick a new key before the save-time collision check passes. A copy of a
 *  GENERIC sheet is one aircraft: it drops the flag, and its empty mass and
 *  arm (the manual's sample weighing) and its notes (which describe that
 *  sample) start blank, so the draft is invalid until the aircraft's own
 *  weighing is typed; the source citation stays, its figures being the
 *  manual's. The editor also asks it a registration (`requireRegistration`). */
export function duplicateDraft(a: Aircraft): AircraftDraft {
	const d: AircraftDraft = { ...aircraftToDraft(a), registration: '', generic: '' };
	if (a.identity.generic === undefined) {
		return d;
	}
	return {
		...d,
		notes: '',
		massBalance: d.massBalance ? { ...d.massBalance, emptyMassKg: '', emptyArmM: '' } : null,
	};
}

export interface DraftOptions {
	/** A copy of a generic sheet: refused without a registration. */
	requireRegistration?: boolean | undefined;
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
	const key = perfRowKey(g.axis);
	for (const [ai, alt] of g.altitudesFt.entries()) {
		for (const [ii, temp] of g.temperaturesC.entries()) {
			const c = g.cells[ai]?.[ii] ?? blankPerfCell();
			rows.push({
				altFt: num(alt),
				// The axis key even for an empty column: a row without it reads
				// as an ISA row, so an outside-air table's empty column was "a
				// mix of isaOffsetC and temperatureC rows". NaN names the box.
				[key]: num(temp) ?? Number.NaN,
				massMax: [num(c.massMaxRoll), num(c.massMaxD15)],
				massMin: [num(c.massMinRoll), num(c.massMinD15)],
			});
		}
	}
	return rows;
}

function metricTableDraftDoc(t: MetricTableDraft): Record<string, unknown> {
	const rows: unknown[] = [];
	const key = perfRowKey(t.axis);
	for (const [ai, alt] of t.altitudesFt.entries()) {
		for (const [ii, temp] of t.temperaturesC.entries()) {
			const c = t.cells[ai]?.[ii] ?? blankMetricCell();
			// The axis key even for an empty column (gridDoc's reason).
			rows.push({ altFt: num(alt), [key]: num(temp) ?? Number.NaN, massMax: num(c.massMax), massMin: num(c.massMin) });
		}
	}
	return { massMaxKg: num(t.massMaxKg), massMinKg: num(t.massMinKg), rows };
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
	if (p.accelerateStop) {
		const a = p.accelerateStop;
		out.accelerateStop = {
			...metricTableDraftDoc(a),
			headwind: a.headwind.length > 0 ? a.headwind.map((x) => [num(x.kt), num(x.factor)]) : undefined,
			tailwindPctPer2Kt: num(a.tailwindPctPer2Kt),
		};
	}
	if (p.kind === 'table') {
		out.massMaxKg = num(p.massMaxKg);
		out.massMinKg = num(p.massMinKg);
		out.takeoffFlapsDeg = num(p.takeoffFlapsDeg);
		out.takeoffProcedure = p.takeoffProcedure || undefined;
		out.landingFlapsDeg = num(p.landingFlapsDeg);
		out.holdBelowTable = p.holdBelowTable || undefined;
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
			// Each phase's own key only: a flag left from before a phase switch
			// is not written.
			procedure: c.phase === 'takeoff' && c.procedure ? c.procedure : undefined,
			default: c.phase === 'landing' && c.isDefault ? true : undefined,
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
export function draftToAircraft(d: AircraftDraft, opts: DraftOptions = {}): DraftResult {
	if (opts.requireRegistration && str(d.registration) === undefined) {
		return {
			ok: false,
			errors: [`${ERROR_PREFIX}aircraft.registration is required: a copy of a generic sheet is one aircraft`],
		};
	}
	const doc: Record<string, unknown> = { version: AIRCRAFT_DOC_VERSION };
	doc.aircraft = {
		registration: str(d.registration),
		type: str(d.type),
		icaoType: str(d.icaoType),
		name: str(d.name),
		operator: str(d.operator),
		generic: str(d.generic),
		engines: d.engines === '2' ? 2 : undefined,
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
					: d.fuel.presets.map((p) => ({ name: str(p.name), litres: num(p.litres) })),
		};
	}
	if (d.cruise) {
		doc.cruise = {
			speedKt: num(d.cruise.speedKt),
			...(d.cruise.name.trim() !== '' ? { name: d.cruise.name.trim() } : {}),
			...(d.cruise.settings.length > 0
				? {
						settings: d.cruise.settings.map((s) => ({
							name: s.name.trim(),
							speedKt: num(s.speedKt),
							consumptionLph: num(s.consumptionLph),
						})),
					}
				: {}),
		};
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
				maxMassKg: num(s.maxMassKg),
			})),
			...(d.massBalance.fuelTanks.length > 0
				? {
						fuelTanks: d.massBalance.fuelTanks.map((t) => ({
							label: str(t.label),
							armM: num(t.armM),
							capacityL: num(t.capacityL),
							usableL: num(t.usableL),
						})),
					}
				: { fuelArmM: num(d.massBalance.fuelArmM) }),
			envelope: d.massBalance.envelope.map((p) => ({ armM: num(p.armM), massKg: num(p.massKg) })),
			maxLandingMassKg: num(d.massBalance.maxLandingMassKg),
			maxZeroFuelMassKg: num(d.massBalance.maxZeroFuelMassKg),
		};
	}
	if (d.performance) {
		doc.performance = performanceDraftDoc(d.performance);
	}
	if (d.engines === '2' && d.oneEngine) {
		const o = d.oneEngine;
		doc.oneEngineInoperative = {
			vmcKt: num(o.vmcKt),
			vyseKt: num(o.vyseKt),
			vxseKt: num(o.vxseKt),
			climb: o.climb ? metricTableDraftDoc(o.climb) : undefined,
			takeoffClimb: o.takeoffClimb ? metricTableDraftDoc(o.takeoffClimb) : undefined,
		};
	}
	doc.notes = str(d.notes);
	doc.source = str(d.source);
	try {
		return { ok: true, aircraft: parseAircraftDoc(doc) };
	} catch (e) {
		return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
	}
}

/* ---- every gap at once ---- */

/** The `pattern` of a required text box: the sheet trims its text, so a box
 *  of spaces is an empty one, which the browser's `required` alone would let
 *  stand unmarked while the footer counted it. */
export const SOME_TEXT = '.*\\S.*';

/** A box the draft still needs, by the path the schema's message would name. */
export interface DraftGap {
	page: 'general' | 'mb' | 'perf';
	path: string;
}

/** Every box the schema would refuse as it stands: a required one left
 *  empty, and any holding something that is no number. The schema stops at
 *  its first error, so a section built from scratch used to reveal its empty
 *  boxes one at a time; this sweeps them all, by the schema's own rules, on
 *  its own paths (`tests/aircraftDraftGaps.spec.ts` empties every box of every
 *  library sheet and holds the two in agreement). What spans several boxes
 *  (a usable fuel above the capacity, an envelope of two vertices, a grid's
 *  repeated altitude) stays the schema's to say, once these are filled. */
export function draftGaps(d: AircraftDraft, opts: DraftOptions = {}): DraftGap[] {
	const gaps: DraftGap[] = [];
	const add = (path: string): void => {
		gaps.push({
			page: path.startsWith('massAndBalance')
				? 'mb'
				: path.startsWith('performance') || path.startsWith('oneEngineInoperative')
					? 'perf'
					: 'general',
			path,
		});
	};
	const text = (v: string, path: string): void => {
		if (v.trim() === '') {
			add(path);
		}
	};
	// An optional box may stay empty, never hold a non-number.
	const number = (v: string, path: string, required = true): void => {
		const s = v.trim();
		if (s === '' ? required : !Number.isFinite(Number(s))) {
			add(path);
		}
	};
	if (opts.requireRegistration) {
		text(d.registration, 'aircraft.registration');
	}
	text(d.type, 'aircraft.type');
	if (d.fuel) {
		number(d.fuel.capacityL, 'fuel.capacityL');
		number(d.fuel.usableL, 'fuel.usableL', false);
		number(d.fuel.consumptionLph, 'fuel.consumptionLph', false);
		d.fuel.presets.forEach((p, i) => {
			number(p.litres, `fuel.presets[${i}].litres`);
			text(p.name, `fuel.presets[${i}].name`);
		});
	}
	if (d.cruise) {
		number(d.cruise.speedKt, 'cruise.speedKt');
		d.cruise.settings.forEach((s, i) => {
			text(s.name, `cruise.settings[${i}].name`);
			number(s.speedKt, `cruise.settings[${i}].speedKt`);
			number(s.consumptionLph, `cruise.settings[${i}].consumptionLph`);
		});
	}
	for (const [key, v] of [
		['climb', d.climb],
		['descent', d.descent],
	] as const) {
		if (v) {
			number(v.speedKt, `${key}.speedKt`);
			number(v.rateFtMin, `${key}.rateFtMin`);
		}
	}
	const m = d.massBalance;
	if (m) {
		m.stations.forEach((s, i) => {
			const at = `massAndBalance.stations[${i}]`;
			number(s.defaultMassKg, `${at}.defaultMassKg`);
			number(s.maxMassKg, `${at}.maxMassKg`, false);
			text(s.label, `${at}.label`);
			number(s.armM, `${at}.armM`);
		});
		m.envelope.forEach((p, i) => {
			number(p.armM, `massAndBalance.envelope[${i}].armM`);
			number(p.massKg, `massAndBalance.envelope[${i}].massKg`);
		});
		number(m.emptyMassKg, 'massAndBalance.emptyMassKg');
		number(m.maxLandingMassKg, 'massAndBalance.maxLandingMassKg', false);
		number(m.maxZeroFuelMassKg, 'massAndBalance.maxZeroFuelMassKg', false);
		number(m.emptyArmM, 'massAndBalance.emptyArmM');
		if (m.fuelTanks.length > 0) {
			m.fuelTanks.forEach((t, i) => {
				const at = `massAndBalance.fuelTanks[${i}]`;
				number(t.capacityL, `${at}.capacityL`);
				number(t.usableL, `${at}.usableL`, false);
				text(t.label, `${at}.label`);
				number(t.armM, `${at}.armM`);
			});
		} else {
			number(m.fuelArmM, 'massAndBalance.fuelArmM');
		}
	}
	// A one-figure table's boxes, on the paths its rows go out under
	// (metricTableDraftDoc: altitude by altitude); `figure` false: a climb
	// rate, any finite number.
	const metricTable = (t: MetricTableDraft, at: string): void => {
		number(t.massMaxKg, `${at}.massMaxKg`);
		number(t.massMinKg, `${at}.massMinKg`);
		const nT = t.temperaturesC.length;
		t.altitudesFt.forEach((alt, ai) => number(alt, `${at}.rows[${ai * nT}].altFt`));
		t.temperaturesC.forEach((temp, ti) => number(temp, `${at}.rows[${ti}].${perfRowKey(t.axis)}`));
		t.cells.forEach((row, ai) =>
			row.forEach((c, ti) => {
				number(c.massMax, `${at}.rows[${ai * nT + ti}].massMax`);
				number(c.massMin, `${at}.rows[${ai * nT + ti}].massMin`);
			}),
		);
	};
	const p = d.performance;
	if (p) {
		for (const k of ['marginFactor', 'grassFactor', 'wetFactor', 'flaplessLandingFactor'] as const) {
			number(p[k], `performance.${k}`, false);
		}
		if (p.accelerateStop) {
			const a = p.accelerateStop;
			metricTable(a, 'performance.accelerateStop');
			a.headwind.forEach((x, i) => {
				number(x.kt, `performance.accelerateStop.headwind[${i}][0]`);
				number(x.factor, `performance.accelerateStop.headwind[${i}][1]`);
			});
			number(a.tailwindPctPer2Kt, 'performance.accelerateStop.tailwindPctPer2Kt', false);
		}
		if (p.kind === 'table') {
			number(p.massMaxKg, 'performance.massMaxKg');
			number(p.massMinKg, 'performance.massMinKg');
			number(p.takeoffFlapsDeg, 'performance.takeoffFlapsDeg', false);
			number(p.landingFlapsDeg, 'performance.landingFlapsDeg', false);
			for (const key of ['takeoffHeadwind', 'landingHeadwind'] as const) {
				p[key].forEach((a, i) => {
					number(a.kt, `performance.wind.${key}[${i}][0]`);
					number(a.factor, `performance.wind.${key}[${i}][1]`);
				});
			}
			number(p.tailwindPctPer2Kt, 'performance.wind.tailwindPctPer2Kt', false);
			for (const phase of ['takeoff', 'landing'] as const) {
				const g = p[phase];
				const nT = g.temperaturesC.length;
				// The rows go out altitude by altitude (gridDoc): an axis box
				// is named by the first row it heads.
				g.altitudesFt.forEach((alt, ai) => number(alt, `performance.${phase}[${ai * nT}].altFt`));
				g.temperaturesC.forEach((temp, ti) => number(temp, `performance.${phase}[${ti}].${perfRowKey(g.axis)}`));
				g.cells.forEach((row, ai) =>
					row.forEach((c, ti) => {
						const at = `performance.${phase}[${ai * nT + ti}]`;
						number(c.massMaxRoll, `${at}.massMax[0]`);
						number(c.massMaxD15, `${at}.massMax[1]`);
						number(c.massMinRoll, `${at}.massMin[0]`);
						number(c.massMinD15, `${at}.massMin[1]`);
					}),
				);
			}
		} else {
			p.configs.forEach((c, i) => {
				const at = `performance.configs[${i}]`;
				number(c.massExponent, `${at}.massExponent`, false);
				number(c.flapsDeg, `${at}.flapsDeg`);
				for (const metric of ['distance15m', 'groundRoll'] as const) {
					c[metric].coefficients.forEach((v, k) => number(v, `${at}.${metric}.coefficients[${k}]`));
					number(c[metric].headwindPerKt, `${at}.${metric}.headwindPerKt`);
					number(c[metric].tailwindPerKt, `${at}.${metric}.tailwindPerKt`);
				}
			});
			number(p.massReferenceLb, 'performance.massReferenceLb');
		}
	}
	const o = d.engines === '2' ? d.oneEngine : null;
	if (o) {
		number(o.vmcKt, 'oneEngineInoperative.vmcKt');
		number(o.vyseKt, 'oneEngineInoperative.vyseKt');
		number(o.vxseKt, 'oneEngineInoperative.vxseKt', false);
		if (o.climb) {
			metricTable(o.climb, 'oneEngineInoperative.climb');
		}
		if (o.takeoffClimb) {
			metricTable(o.takeoffClimb, 'oneEngineInoperative.takeoffClimb');
		}
	}
	return gaps;
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

/** A point of the M&B preview's default load. */
export interface DraftLoadPoint {
	armM: number;
	massKg: number;
	momentKgM: number;
}

/** Where a typical load sits while the arms are typed: the empty aircraft
 *  with every station at its default mass, without fuel (the zero-fuel
 *  point) and with the full usable fuel at the sheet grade's density (the
 *  take-off point, null without a fuel section, a fuel arm or every tank's
 *  arm and litres), the fuel where the sheet's tanks put it. Read from the
 *  draft as typed, so it moves with every keystroke; null until the empty
 *  point and every station hold finite numbers. */
export function draftDefaultLoad(d: AircraftDraft): {
	zeroFuel: DraftLoadPoint;
	takeoff: DraftLoadPoint | null;
	/** Where the fuel goes (massBalance.ts FuelSlot), for the burn line. */
	slots: FuelSlot[];
	fuelL: number;
	fuelMassKg: number;
	densityKgPerL: number;
} | null {
	const mb = d.massBalance;
	if (!mb) {
		return null;
	}
	const n = (s: string): number | null => {
		const v = s.trim() === '' ? NaN : Number(s);
		return Number.isFinite(v) ? v : null;
	};
	const emptyKg = n(mb.emptyMassKg);
	const emptyArmM = n(mb.emptyArmM);
	if (emptyKg === null || emptyKg <= 0 || emptyArmM === null) {
		return null;
	}
	let massKg = emptyKg;
	let momentKgM = emptyKg * emptyArmM;
	for (const s of mb.stations) {
		const kg = n(s.defaultMassKg);
		const armM = n(s.armM);
		if (kg === null || kg < 0 || armM === null) {
			return null;
		}
		massKg += kg;
		momentKgM += kg * armM;
	}
	const zeroFuel = { armM: momentKgM / massKg, massKg, momentKgM };
	// The tanks as typed (an empty usable figure is the capacity), or the one
	// fuel arm; a tank short of its arm or litres puts no fuel anywhere.
	const slots: FuelSlot[] | null =
		mb.fuelTanks.length > 0
			? mb.fuelTanks.every((t) => n(t.armM) !== null && (n(t.usableL) ?? n(t.capacityL)) !== null)
				? mb.fuelTanks.map((t) => ({ label: t.label, armM: n(t.armM)!, usableL: (n(t.usableL) ?? n(t.capacityL))! }))
				: null
			: n(mb.fuelArmM) !== null
				? [{ label: '', armM: n(mb.fuelArmM)!, usableL: Infinity }]
				: null;
	// An empty usable figure is the capacity (the schema default).
	const litres = d.fuel ? (n(d.fuel.usableL) ?? n(d.fuel.capacityL)) : null;
	const densityKgPerL = d.fuel ? FUEL_TYPE_INFO[d.fuel.type].densityKgPerL : 0;
	if (!d.fuel || slots === null || litres === null || litres <= 0) {
		return { zeroFuel, takeoff: null, slots: slots ?? [], fuelL: 0, fuelMassKg: 0, densityKgPerL };
	}
	const fuelMassKg = litres * densityKgPerL;
	const takeoffKg = massKg + fuelMassKg;
	const takeoffMoment = momentKgM + fuelMomentKgM(slots, litres, densityKgPerL);
	return {
		zeroFuel,
		takeoff: { armM: takeoffMoment / takeoffKg, massKg: takeoffKg, momentKgM: takeoffMoment },
		slots,
		fuelL: litres,
		fuelMassKg,
		densityKgPerL,
	};
}

/* ---- reference figures (the editor's live sanity readout) ---- */

export interface ReferenceFigureRow {
	phase: PerfPhase;
	/** The reference config's flaps (the normal take-off), or the setting a
	 *  table was charted at, for the row label; null when unstated. */
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
	/** A twin's accelerate-stop distance at the same conditions, at its own
	 *  table's heaviest mass, and that mass; null without one. */
	asd: { m: number; massKg: number; extrapolated: boolean } | null;
	/** A twin's one-engine net ceiling at ISA (CAT.POL.A.315(b)(2)), at its
	 *  climb table's heaviest mass, and that mass; null without one. */
	oeiCeiling: { ceiling: NetCeiling; massKg: number } | null;
}

const REFERENCE_PHASES: PerfPhase[] = ['takeoff', 'landing'];

/** Unfactored distances at sea level, ISA, max mass, no wind, dry hard
 *  runway: directly comparable with the POH page the sheet was typed from,
 *  and computed through the real interpolation / evaluation pipeline so a
 *  transposed cell shows up immediately. Null when nothing is computable. */
export function referenceFigures(
	perf: AircraftPerformance,
	oei: OneEngineInoperative | null = null,
): ReferenceFigures | null {
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
					// The configuration the table was charted at, when stated.
					flapsDeg: (phase === 'takeoff' ? perf.takeoffFlapsDeg : perf.landingFlapsDeg) ?? null,
					rollM: r.value.groundRoll.rawM,
					d15M: r.value.distance15m.rawM,
					extrapolated:
						f.massExtrapolated || f.altitudeExtrapolatedBelow || f.temperatureExtrapolated,
				});
			}
		} else {
			const config = referenceConfig(perf, phase);
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
	const asdTable = perf.accelerateStop;
	const asdRun = asdTable ? computeAccelerateStop(perf, { ...conditions, massKg: asdTable.massMaxKg }) : null;
	const climb = oei?.climb;
	const ceiling =
		oei && climb
			? oeiNetCeiling(oei, climb.massMaxKg, (alt) => ({ pressureAltFt: alt, temperatureC: isaTemperatureC(alt) }))
			: null;
	return {
		massKg,
		massLb: perf.kind === 'closed-form' ? perf.massReferenceLb : null,
		rows,
		asd:
			asdTable && asdRun?.ok
				? {
						m: asdRun.figure.rawM,
						massKg: asdTable.massMaxKg,
						extrapolated:
							asdRun.flags.massExtrapolated ||
							asdRun.flags.altitudeExtrapolatedBelow ||
							asdRun.flags.temperatureExtrapolated,
					}
				: null,
		oeiCeiling: ceiling && climb ? { ceiling, massKg: climb.massMaxKg } : null,
	};
}

/** The editor's draft carried over onto its sheet as stored meanwhile (the
 *  Aircraft tab's inline basics, a revert, an import, a sync), a three-way
 *  merge against the base the draft was seeded from: every part the pilot has
 *  not changed since takes the new value, every part they changed keeps
 *  theirs, so a Save never writes stale figures over a change made elsewhere.
 *  Objects merge key by key; an array or a value is one part. `conflict` says
 *  some part changed on both sides, differently: the pilot's is kept. */
export function rebaseDraft<T>(current: T, base: T, next: T): { draft: T; conflict: boolean } {
	let conflict = false;
	const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
	const isObject = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === 'object' && !Array.isArray(v);
	const merge = (cur: unknown, was: unknown, now: unknown): unknown => {
		if (same(cur, was)) {
			return now;
		}
		if (same(now, was) || same(cur, now)) {
			return cur;
		}
		if (isObject(cur) && isObject(was) && isObject(now)) {
			const out: Record<string, unknown> = {};
			for (const k of new Set([...Object.keys(cur), ...Object.keys(now)])) {
				out[k] = merge(cur[k], was[k], now[k]);
			}
			return out;
		}
		conflict = true;
		return cur;
	};
	return { draft: merge(current, base, next) as T, conflict };
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
	if (m.startsWith('performance') || m.startsWith('oneEngineInoperative')) {
		return 'perf';
	}
	return 'general';
}
