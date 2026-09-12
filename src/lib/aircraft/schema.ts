/* Aircraft data-sheet YAML: types + parse / stringify. One document per
 * aircraft, laid out like a POH extract: identity, fuel, cruise, climb /
 * descent, mass and balance (stations + CG envelope), performance (a POH
 * distance table with
 * trilinear interpolation, or a fitted closed-form model). Pure (no Svelte,
 * no I/O) so it is unit-testable and shared by the committed-library loader
 * and the UI import / export. Unknown keys are ignored on load; partial
 * documents (no mass and balance, no performance) are valid and simply
 * disable the matching pages. Units are native aeronautical ones and live in
 * the field names: kg, m, L, kt, ft, deg C; distances in metres. */

import { parse, stringify } from 'yaml';
import { fileName, fileToken } from '$lib/files/fileName';

export const AIRCRAFT_DOC_VERSION = 1;

const HEADER_COMMENT =
	' Aircraft data sheet (Loxodrome). Sections: aircraft (identity), fuel,\n' +
	' cruise, climb / descent (speed + vertical rate, drawn on the route\n' +
	' vertical profile), massAndBalance (stations + CG envelope), performance\n' +
	' (kind: table with POH rows, or closed-form with fitted coefficients).\n' +
	' Units are in the field names: kg, m, L, kt, ft, ft/min, deg C; distances\n' +
	' in metres. Unknown keys are ignored; every section except aircraft may be\n' +
	' omitted (partial data sheet).\n' +
	' Verify every figure against the aircraft flight manual before use.';

export interface AircraftIdentity {
	/** Selection key when present; a type-only data sheet may omit it. */
	registration?: string | undefined;
	type: string;
	/** ICAO Doc 8643 aircraft type designator, e.g. DR40, P28A. */
	icaoType?: string | undefined;
	name?: string | undefined;
	/** Operator or flying club; groups the fleet list. */
	operator?: string | undefined;
}

export interface FuelPreset {
	/** Machine key, e.g. 'tabs'. */
	name: string;
	/** Display label, e.g. 'To tabs'. */
	label?: string | undefined;
	litres: number;
}

/** The fuel grades a light aircraft tanks here, with typical 15 deg C
 *  densities. The density is never stored in a data sheet; the selected
 *  type determines it through this table. */
export const FUEL_TYPE_INFO = {
	'100LL': { label: 'AVGAS 100LL', densityKgPerL: 0.72 },
	UL91: { label: 'AVGAS UL91', densityKgPerL: 0.72 },
	'SUPER AERO+': { label: 'UL Aéro Super+', densityKgPerL: 0.75 },
	// No committed plane tanks it yet; here for future turbine / diesel types.
	'JET A-1': { label: 'Jet A-1', densityKgPerL: 0.8 },
} as const;

export type FuelType = keyof typeof FUEL_TYPE_INFO;

export const FUEL_TYPES = Object.keys(FUEL_TYPE_INFO) as FuelType[];

export interface AircraftFuel {
	capacityL: number;
	/** Usable fuel; defaults to capacityL. Feasibility + the full preset use it. */
	usableL: number;
	/** The fuel grades this plane takes (the data sheet's list, first =
	 *  default). Defaults to ['100LL']. */
	types: FuelType[];
	/** The sheet's grade; one of `types` (defaults to the first). The grade
	 *  actually tanked is per-plane state layered over this default
	 *  (tankedFuelType in state/aircraft.svelte.ts): selecting what is in
	 *  the tanks is operational, never a data-sheet edit. */
	type: FuelType;
	consumptionLph?: number | undefined;
	presets: FuelPreset[];
}

/** The sheet grade's density (kg/L at 15 deg C). Mass consumers use the
 *  tanked grade instead, via tankedFuelDensityKgPerL in state/aircraft. */
export function fuelDensityKgPerL(fuel: AircraftFuel): number {
	return FUEL_TYPE_INFO[fuel.type].densityKgPerL;
}

export interface AircraftCruise {
	speedKt: number;
}

/** One climb or descent regime from the flight manual: the speed flown and
 *  the vertical rate it yields (climb: the sea-level rate at maximum weight;
 *  descent: the planned cruise-descent rate). */
export interface AircraftVerticalSpeed {
	speedKt: number;
	rateFtMin: number;
}

/** Still-air slope of a climb / descent regime in ft per NM:
 *  ft/min x 60 / kt (kt = NM/h). Feeds the route vertical profile's drawn
 *  ramps; the 3-degree default applies when the sheet has no section. */
export function gradientFtPerNM(v: AircraftVerticalSpeed): number {
	return (v.rateFtMin * 60) / v.speedKt;
}

export interface MassStation {
	label: string;
	armM: number;
	defaultMassKg: number;
}

export interface EnvelopePoint {
	armM: number;
	massKg: number;
}

export interface AircraftMassBalance {
	emptyMassKg: number;
	emptyArmM: number;
	stations: MassStation[];
	fuelArmM: number;
	/** CG envelope polygon, (arm, mass) vertices, implicitly closed. */
	envelope: EnvelopePoint[];
}

export interface PerformanceCommon {
	/** Safety margin applied on top of the factored distances (default 1.3). */
	marginFactor: number;
	/** Grass runway factor (default 1.15). */
	grassFactor: number;
	/** Wet runway factor (default 1.15). */
	wetFactor: number;
	/** Landing without flaps factor (e.g. 1.5 = add 50 percent). */
	flaplessLandingFactor?: number | undefined;
}

/** Headwind factor anchors [knots, factor], ascending knots, first [0, 1].
 *  Linearly interpolated between anchors, clamped past the last. */
export type HeadwindFactorTable = ReadonlyArray<readonly [number, number]>;

export interface TableWind {
	takeoffHeadwind: HeadwindFactorTable;
	landingHeadwind: HeadwindFactorTable;
	/** Tailwind: add this percent per 2 kt, continuously (default 10). */
	tailwindPctPer2Kt: number;
}

/** One POH row; cells are [ground roll m, distance over 15 m] at each mass. */
export interface PerfTableRow {
	altFt: number;
	/** Relative to ISA at that altitude (ISA = 15 - 2 * alt / 1000). */
	isaOffsetC: number;
	massMax: readonly [number, number];
	massMin: readonly [number, number];
}

/** A complete POH grid for one phase, validated + sorted at parse time. */
export interface PerfTable {
	/** Ascending, >= 2 entries. */
	altitudesFt: number[];
	/** Ascending, >= 2 entries. */
	isaOffsetsC: number[];
	/** Sorted by (altFt, isaOffsetC); one row per grid cell. */
	rows: PerfTableRow[];
}

export interface TablePerformance extends PerformanceCommon {
	kind: 'table';
	massMaxKg: number;
	massMinKg: number;
	wind: TableWind;
	takeoff: PerfTable;
	landing: PerfTable;
}

/** distanceM = ((a*PA + b) * tempC + (c*PA + d))
 *              * (massKg * KG_TO_LB / massReferenceLb)^massExponent
 *              * (1 - headwindPerKt * kt) or (1 + tailwindPerKt * kt). */
export interface ClosedFormMetric {
	/** [a, b, c, d]. */
	coefficients: readonly [number, number, number, number];
	headwindPerKt: number;
	tailwindPerKt: number;
}

export interface ClosedFormConfig {
	phase: 'takeoff' | 'landing';
	flapsDeg: number;
	/** Drives the runway verdict; at most one per phase (else the phase's last). */
	default?: boolean | undefined;
	/** Mass-law exponent, >= 0 (absent = 0): 0 = no mass term (a chart
	 *  without a mass grid), 2 = the classic mass-squared law. */
	massExponent: number;
	distance15m: ClosedFormMetric;
	groundRoll: ClosedFormMetric;
}

export interface ClosedFormPerformance extends PerformanceCommon {
	kind: 'closed-form';
	massReferenceLb: number;
	configs: ClosedFormConfig[];
}

export type AircraftPerformance = TablePerformance | ClosedFormPerformance;

export interface Aircraft {
	identity: AircraftIdentity;
	fuel?: AircraftFuel | undefined;
	cruise?: AircraftCruise | undefined;
	climb?: AircraftVerticalSpeed | undefined;
	descent?: AircraftVerticalSpeed | undefined;
	massBalance?: AircraftMassBalance | undefined;
	performance?: AircraftPerformance | undefined;
	notes?: string | undefined;
	source?: string | undefined;
}

/** Selection / shadowing key: the registration, else the type. */
export function aircraftKey(a: Aircraft): string {
	return a.identity.registration ?? a.identity.type;
}

/** What an exported data sheet is called, wherever it is written: the tab's
 *  download and the flights bundle's `aircraft/` member (docs/file-names.md).
 *  The key in its canonical form, upper case as a registration is written
 *  everywhere else, plus the kind token that tells this YAML from a plan's:
 *  "F-GORQ_aircraft.yaml". One definition, because three copies of the slug
 *  is how the tab came to emit a bare "-.yaml" for a key of punctuation. */
export function aircraftFileName(key: string): string {
	return fileName([fileToken(key), 'aircraft'], 'yaml');
}

/** Still-air endurance in minutes from usable fuel and consumption, or null. */
export function enduranceMin(a: Aircraft): number | null {
	const f = a.fuel;
	if (!f || f.consumptionLph == null || f.consumptionLph <= 0) {
		return null;
	}
	return (f.usableL / f.consumptionLph) * 60;
}

function fail(msg: string): never {
	throw new Error(`Invalid aircraft file: ${msg}`);
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) {
		fail(`${what} must be a mapping`);
	}
	return v as Record<string, unknown>;
}

function asList(v: unknown, what: string): unknown[] {
	if (!Array.isArray(v)) {
		fail(`${what} must be a list`);
	}
	return v;
}

function reqNumber(v: unknown, what: string): number {
	if (typeof v !== 'number' || !Number.isFinite(v)) {
		fail(`${what} must be a finite number`);
	}
	return v;
}

function reqPositive(v: unknown, what: string): number {
	const n = reqNumber(v, what);
	if (n <= 0) {
		fail(`${what} must be > 0`);
	}
	return n;
}

function reqString(v: unknown, what: string): string {
	if (typeof v !== 'string' || v === '') {
		fail(`${what} must be a non-empty string`);
	}
	return v;
}

function optString(v: unknown): string | undefined {
	return typeof v === 'string' && v !== '' ? v : undefined;
}

function parseFuel(raw: unknown): AircraftFuel {
	const f = asRecord(raw, 'fuel');
	const capacityL = reqPositive(f.capacityL, 'fuel.capacityL');
	const usableL = f.usableL === undefined ? capacityL : reqPositive(f.usableL, 'fuel.usableL');
	if (usableL > capacityL) {
		fail('fuel.usableL must be <= fuel.capacityL');
	}
	const isFuelType = (v: unknown): v is FuelType =>
		typeof v === 'string' && v in FUEL_TYPE_INFO;
	let types: FuelType[] = ['100LL'];
	if (f.types !== undefined) {
		const list = asList(f.types, 'fuel.types');
		if (list.length === 0) {
			fail('fuel.types must not be empty');
		}
		types = list.map((v, i) => {
			if (!isFuelType(v)) {
				fail(`fuel.types[${i}] must be one of ${FUEL_TYPES.join(', ')}`);
			}
			return v;
		});
	}
	let type = types[0];
	if (f.type !== undefined) {
		if (!isFuelType(f.type) || !types.includes(f.type)) {
			fail(`fuel.type must be one of the plane's fuel.types (${types.join(', ')})`);
		}
		type = f.type;
	}
	const consumptionLph =
		f.consumptionLph === undefined ? undefined : reqPositive(f.consumptionLph, 'fuel.consumptionLph');
	const presets: FuelPreset[] = [];
	if (f.presets !== undefined) {
		for (const [i, rawP] of asList(f.presets, 'fuel.presets').entries()) {
			const p = asRecord(rawP, `fuel.presets[${i}]`);
			const litres = reqPositive(p.litres, `fuel.presets[${i}].litres`);
			if (litres > usableL) {
				fail(`fuel.presets[${i}].litres must be <= fuel.usableL`);
			}
			presets.push({
				name: reqString(p.name, `fuel.presets[${i}].name`),
				label: optString(p.label),
				litres,
			});
		}
	}
	return { capacityL, usableL, types, type, consumptionLph, presets };
}

function parseMassBalance(raw: unknown): AircraftMassBalance {
	const m = asRecord(raw, 'massAndBalance');
	const stations: MassStation[] = [];
	for (const [i, rawS] of asList(m.stations, 'massAndBalance.stations').entries()) {
		const s = asRecord(rawS, `massAndBalance.stations[${i}]`);
		const defaultMassKg = reqNumber(s.defaultMassKg, `massAndBalance.stations[${i}].defaultMassKg`);
		if (defaultMassKg < 0) {
			fail(`massAndBalance.stations[${i}].defaultMassKg must be >= 0`);
		}
		stations.push({
			label: reqString(s.label, `massAndBalance.stations[${i}].label`),
			armM: reqNumber(s.armM, `massAndBalance.stations[${i}].armM`),
			defaultMassKg,
		});
	}
	const envelope: EnvelopePoint[] = [];
	for (const [i, rawP] of asList(m.envelope, 'massAndBalance.envelope').entries()) {
		const p = asRecord(rawP, `massAndBalance.envelope[${i}]`);
		envelope.push({
			armM: reqNumber(p.armM, `massAndBalance.envelope[${i}].armM`),
			massKg: reqPositive(p.massKg, `massAndBalance.envelope[${i}].massKg`),
		});
	}
	if (envelope.length < 3) {
		fail('massAndBalance.envelope needs at least 3 vertices');
	}
	return {
		emptyMassKg: reqPositive(m.emptyMassKg, 'massAndBalance.emptyMassKg'),
		emptyArmM: reqNumber(m.emptyArmM, 'massAndBalance.emptyArmM'),
		stations,
		fuelArmM: reqNumber(m.fuelArmM, 'massAndBalance.fuelArmM'),
		envelope,
	};
}

function parseCellPair(v: unknown, what: string): readonly [number, number] {
	const list = asList(v, what);
	if (list.length !== 2) {
		fail(`${what} must be [ground roll m, distance over 15 m]`);
	}
	return [reqPositive(list[0], `${what}[0]`), reqPositive(list[1], `${what}[1]`)];
}

function parsePerfTable(raw: unknown, what: string): PerfTable {
	const rows: PerfTableRow[] = [];
	for (const [i, rawR] of asList(raw, what).entries()) {
		const r = asRecord(rawR, `${what}[${i}]`);
		rows.push({
			altFt: reqNumber(r.altFt, `${what}[${i}].altFt`),
			isaOffsetC: reqNumber(r.isaOffsetC, `${what}[${i}].isaOffsetC`),
			massMax: parseCellPair(r.massMax, `${what}[${i}].massMax`),
			massMin: parseCellPair(r.massMin, `${what}[${i}].massMin`),
		});
	}
	const altitudesFt = [...new Set(rows.map((r) => r.altFt))].sort((a, b) => a - b);
	const isaOffsetsC = [...new Set(rows.map((r) => r.isaOffsetC))].sort((a, b) => a - b);
	if (altitudesFt.length < 2 || isaOffsetsC.length < 2) {
		fail(`${what} needs at least 2 altitudes and 2 ISA offsets`);
	}
	if (rows.length !== altitudesFt.length * isaOffsetsC.length) {
		fail(`${what} must cover the full altitude x ISA-offset grid`);
	}
	const seen = new Set(rows.map((r) => `${r.altFt}|${r.isaOffsetC}`));
	if (seen.size !== rows.length) {
		fail(`${what} has duplicate (altitude, ISA offset) rows`);
	}
	rows.sort((a, b) => a.altFt - b.altFt || a.isaOffsetC - b.isaOffsetC);
	return { altitudesFt, isaOffsetsC, rows };
}

function parseHeadwindTable(raw: unknown, what: string): HeadwindFactorTable {
	const anchors: [number, number][] = [];
	for (const [i, rawA] of asList(raw, what).entries()) {
		const a = asList(rawA, `${what}[${i}]`);
		if (a.length !== 2) {
			fail(`${what}[${i}] must be [knots, factor]`);
		}
		anchors.push([reqNumber(a[0], `${what}[${i}][0]`), reqPositive(a[1], `${what}[${i}][1]`)]);
	}
	if (anchors.length === 0 || anchors[0][0] !== 0 || anchors[0][1] !== 1) {
		fail(`${what} must start with the [0, 1] anchor`);
	}
	for (let i = 1; i < anchors.length; i++) {
		if (anchors[i][0] <= anchors[i - 1][0]) {
			fail(`${what} knots must be ascending`);
		}
	}
	return anchors;
}

function parseCommon(p: Record<string, unknown>): PerformanceCommon {
	return {
		marginFactor: p.marginFactor === undefined ? 1.3 : reqPositive(p.marginFactor, 'performance.marginFactor'),
		grassFactor: p.grassFactor === undefined ? 1.15 : reqPositive(p.grassFactor, 'performance.grassFactor'),
		wetFactor: p.wetFactor === undefined ? 1.15 : reqPositive(p.wetFactor, 'performance.wetFactor'),
		flaplessLandingFactor:
			p.flaplessLandingFactor === undefined
				? undefined
				: reqPositive(p.flaplessLandingFactor, 'performance.flaplessLandingFactor'),
	};
}

function parseClosedFormMetric(raw: unknown, what: string): ClosedFormMetric {
	const m = asRecord(raw, what);
	const list = asList(m.coefficients, `${what}.coefficients`);
	if (list.length !== 4) {
		fail(`${what}.coefficients must be [a, b, c, d]`);
	}
	return {
		coefficients: [
			reqNumber(list[0], `${what}.coefficients[0]`),
			reqNumber(list[1], `${what}.coefficients[1]`),
			reqNumber(list[2], `${what}.coefficients[2]`),
			reqNumber(list[3], `${what}.coefficients[3]`),
		],
		headwindPerKt: reqNumber(m.headwindPerKt, `${what}.headwindPerKt`),
		tailwindPerKt: reqNumber(m.tailwindPerKt, `${what}.tailwindPerKt`),
	};
}

function parsePerformance(raw: unknown): AircraftPerformance {
	const p = asRecord(raw, 'performance');
	const common = parseCommon(p);
	if (p.kind === 'table') {
		const massMaxKg = reqPositive(p.massMaxKg, 'performance.massMaxKg');
		const massMinKg = reqPositive(p.massMinKg, 'performance.massMinKg');
		if (massMinKg >= massMaxKg) {
			fail('performance.massMinKg must be < performance.massMaxKg');
		}
		const w = asRecord(p.wind, 'performance.wind');
		return {
			...common,
			kind: 'table',
			massMaxKg,
			massMinKg,
			wind: {
				takeoffHeadwind: parseHeadwindTable(w.takeoffHeadwind, 'performance.wind.takeoffHeadwind'),
				landingHeadwind: parseHeadwindTable(w.landingHeadwind, 'performance.wind.landingHeadwind'),
				tailwindPctPer2Kt:
					w.tailwindPctPer2Kt === undefined
						? 10
						: reqPositive(w.tailwindPctPer2Kt, 'performance.wind.tailwindPctPer2Kt'),
			},
			takeoff: parsePerfTable(p.takeoff, 'performance.takeoff'),
			landing: parsePerfTable(p.landing, 'performance.landing'),
		};
	}
	if (p.kind === 'closed-form') {
		const configs: ClosedFormConfig[] = [];
		const defaults = { takeoff: 0, landing: 0 };
		for (const [i, rawC] of asList(p.configs, 'performance.configs').entries()) {
			const c = asRecord(rawC, `performance.configs[${i}]`);
			if (c.phase !== 'takeoff' && c.phase !== 'landing') {
				fail(`performance.configs[${i}].phase must be takeoff or landing`);
			}
			const isDefault = c.default === true;
			if (isDefault) {
				defaults[c.phase]++;
			}
			let massExponent = 0;
			if (c.massExponent !== undefined) {
				massExponent = reqNumber(c.massExponent, `performance.configs[${i}].massExponent`);
				if (massExponent < 0) {
					fail(`performance.configs[${i}].massExponent must be >= 0`);
				}
			}
			configs.push({
				phase: c.phase,
				flapsDeg: reqNumber(c.flapsDeg, `performance.configs[${i}].flapsDeg`),
				default: isDefault ? true : undefined,
				massExponent,
				distance15m: parseClosedFormMetric(c.distance15m, `performance.configs[${i}].distance15m`),
				groundRoll: parseClosedFormMetric(c.groundRoll, `performance.configs[${i}].groundRoll`),
			});
		}
		if (configs.length === 0) {
			fail('performance.configs must not be empty');
		}
		if (defaults.takeoff > 1 || defaults.landing > 1) {
			fail('performance.configs allows at most one default per phase');
		}
		return {
			...common,
			kind: 'closed-form',
			massReferenceLb: reqPositive(p.massReferenceLb, 'performance.massReferenceLb'),
			configs,
		};
	}
	fail('performance.kind must be table or closed-form');
}

/** Validate one already-parsed aircraft document (the post-YAML half of
 *  parseAircraftYaml; the editor's draft conversion feeds it directly so
 *  every error message stays canonical). */
export function parseAircraftDoc(doc: unknown): Aircraft {
	const root = asRecord(doc, 'the document');
	if (root.version !== AIRCRAFT_DOC_VERSION) {
		fail(`unsupported version ${JSON.stringify(root.version)} (expected ${AIRCRAFT_DOC_VERSION})`);
	}
	const id = asRecord(root.aircraft, 'aircraft');
	const identity: AircraftIdentity = {
		registration: optString(id.registration),
		type: reqString(id.type, 'aircraft.type'),
		icaoType: optString(id.icaoType),
		name: optString(id.name),
		operator: optString(id.operator),
	};
	const parseVSpeed = (v: unknown, path: string): AircraftVerticalSpeed => {
		const r = asRecord(v, path);
		return {
			speedKt: reqPositive(r.speedKt, `${path}.speedKt`),
			rateFtMin: reqPositive(r.rateFtMin, `${path}.rateFtMin`),
		};
	};
	return {
		identity,
		fuel: root.fuel === undefined ? undefined : parseFuel(root.fuel),
		cruise:
			root.cruise === undefined
				? undefined
				: { speedKt: reqPositive(asRecord(root.cruise, 'cruise').speedKt, 'cruise.speedKt') },
		climb: root.climb === undefined ? undefined : parseVSpeed(root.climb, 'climb'),
		descent: root.descent === undefined ? undefined : parseVSpeed(root.descent, 'descent'),
		massBalance: root.massAndBalance === undefined ? undefined : parseMassBalance(root.massAndBalance),
		performance: root.performance === undefined ? undefined : parsePerformance(root.performance),
		notes: optString(root.notes),
		source: optString(root.source),
	};
}

/** Parse + validate one aircraft YAML document. Tolerates unknown keys,
 *  applies the documented defaults, throws a readable Error on bad data. */
export function parseAircraftYaml(text: string): Aircraft {
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (e) {
		fail(e instanceof Error ? e.message : String(e));
	}
	return parseAircraftDoc(doc);
}

function fuelDoc(f: AircraftFuel): Record<string, unknown> {
	const out: Record<string, unknown> = { capacityL: f.capacityL };
	if (f.usableL !== f.capacityL) out.usableL = f.usableL;
	out.types = [...f.types];
	if (f.type !== f.types[0]) out.type = f.type;
	if (f.consumptionLph != null) out.consumptionLph = f.consumptionLph;
	if (f.presets.length > 0) {
		out.presets = f.presets.map((p) => {
			const preset: Record<string, unknown> = { name: p.name };
			if (p.label) preset.label = p.label;
			preset.litres = p.litres;
			return preset;
		});
	}
	return out;
}

function perfTableDoc(t: PerfTable): unknown[] {
	return t.rows.map((r) => ({
		altFt: r.altFt,
		isaOffsetC: r.isaOffsetC,
		massMax: [...r.massMax],
		massMin: [...r.massMin],
	}));
}

function performanceDoc(p: AircraftPerformance): Record<string, unknown> {
	const out: Record<string, unknown> = { kind: p.kind };
	out.marginFactor = p.marginFactor;
	out.grassFactor = p.grassFactor;
	out.wetFactor = p.wetFactor;
	if (p.flaplessLandingFactor != null) out.flaplessLandingFactor = p.flaplessLandingFactor;
	if (p.kind === 'table') {
		out.massMaxKg = p.massMaxKg;
		out.massMinKg = p.massMinKg;
		out.wind = {
			takeoffHeadwind: p.wind.takeoffHeadwind.map((a) => [...a]),
			landingHeadwind: p.wind.landingHeadwind.map((a) => [...a]),
			tailwindPctPer2Kt: p.wind.tailwindPctPer2Kt,
		};
		out.takeoff = perfTableDoc(p.takeoff);
		out.landing = perfTableDoc(p.landing);
	} else {
		out.massReferenceLb = p.massReferenceLb;
		out.configs = p.configs.map((c) => {
			const cfg: Record<string, unknown> = { phase: c.phase, flapsDeg: c.flapsDeg };
			if (c.default) cfg.default = true;
			cfg.massExponent = c.massExponent;
			cfg.distance15m = {
				coefficients: [...c.distance15m.coefficients],
				headwindPerKt: c.distance15m.headwindPerKt,
				tailwindPerKt: c.distance15m.tailwindPerKt,
			};
			cfg.groundRoll = {
				coefficients: [...c.groundRoll.coefficients],
				headwindPerKt: c.groundRoll.headwindPerKt,
				tailwindPerKt: c.groundRoll.tailwindPerKt,
			};
			return cfg;
		});
	}
	return out;
}

/** Serialise an aircraft to YAML (header comment + known fields, canonical
 *  section order). parse(stringify(a)) round-trips to a deep-equal value. */
export function stringifyAircraftYaml(a: Aircraft): string {
	const doc: Record<string, unknown> = { version: AIRCRAFT_DOC_VERSION };
	const id: Record<string, unknown> = {};
	if (a.identity.registration) id.registration = a.identity.registration;
	id.type = a.identity.type;
	if (a.identity.icaoType) id.icaoType = a.identity.icaoType;
	if (a.identity.name) id.name = a.identity.name;
	if (a.identity.operator) id.operator = a.identity.operator;
	doc.aircraft = id;
	if (a.fuel) doc.fuel = fuelDoc(a.fuel);
	if (a.cruise) doc.cruise = { speedKt: a.cruise.speedKt };
	if (a.climb) doc.climb = { speedKt: a.climb.speedKt, rateFtMin: a.climb.rateFtMin };
	if (a.descent) doc.descent = { speedKt: a.descent.speedKt, rateFtMin: a.descent.rateFtMin };
	if (a.massBalance) {
		doc.massAndBalance = {
			emptyMassKg: a.massBalance.emptyMassKg,
			emptyArmM: a.massBalance.emptyArmM,
			stations: a.massBalance.stations.map((s) => ({
				label: s.label,
				armM: s.armM,
				defaultMassKg: s.defaultMassKg,
			})),
			fuelArmM: a.massBalance.fuelArmM,
			envelope: a.massBalance.envelope.map((p) => ({ armM: p.armM, massKg: p.massKg })),
		};
	}
	if (a.performance) doc.performance = performanceDoc(a.performance);
	if (a.notes) doc.notes = a.notes;
	if (a.source) doc.source = a.source;
	const body = stringify(doc, { lineWidth: 0 });
	const header = HEADER_COMMENT.split('\n')
		.map((l) => `#${l}`)
		.join('\n');
	return `${header}\n${body}`;
}
