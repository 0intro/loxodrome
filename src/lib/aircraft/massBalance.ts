/* Mass & balance: station sums, CG, the CG envelope test, the fuel-burn CG
 * travel and the most fuel a payload can take within its limits. Mirrors
 * the workbook's "Masse et centrage" tabs: takeoff = empty + stations +
 * fuel; landing = takeoff minus the burn-off; fuel mass = litres x density.
 * The fuel sits at the sheet's fuel arm, or in its tanks, filled in the
 * order listed and burnt in reverse (fuelSlots), so where it sits follows
 * from the litres aboard alone. Which fuel each takeoff carries is the trip
 * loads' (tripLoads.ts). Pure (no Svelte, no I/O). */

import { occurrenceKeys } from '$lib/data/dedup';
import type { AircraftMassBalance, EnvelopePoint, MassStation } from './schema';

/** Where the fuel aboard goes, in order: a sheet's tanks as it lists them,
 *  each taking up to its usable litres, or its one fuel arm taking all
 *  (`label` '', unbounded). Filled first to last, burnt last to first. */
export interface FuelSlot {
	label: string;
	armM: number;
	usableL: number;
}

/** A sheet's fuel slots (FuelSlot). */
export function fuelSlots(mb: Pick<AircraftMassBalance, 'fuelArmM' | 'fuelTanks'>): FuelSlot[] {
	if (mb.fuelTanks) {
		return mb.fuelTanks.map((t) => ({ label: t.label, armM: t.armM, usableL: t.usableL }));
	}
	return [{ label: '', armM: mb.fuelArmM ?? 0, usableL: Infinity }];
}

/** The litres in each slot with `litres` aboard, index-aligned with the
 *  slots: each filled in turn; past the last one's usable litres the rest
 *  stays with the last (a quantity no tank holds is the caller's to refuse). */
export function fuelBySlot(slots: readonly FuelSlot[], litres: number): number[] {
	let left = Math.max(0, litres);
	return slots.map((slot, i) => {
		const l = i === slots.length - 1 ? left : Math.min(left, slot.usableL);
		left -= l;
		return l;
	});
}

/** The moment of `litres` aboard, kg m. */
export function fuelMomentKgM(slots: readonly FuelSlot[], litres: number, densityKgPerL: number): number {
	const by = fuelBySlot(slots, litres);
	return slots.reduce((m, slot, i) => m + by[i] * densityKgPerL * slot.armM, 0);
}

export interface StationLoad {
	/** 'empty' and 'fuel' are the synthetic rows, labelled at render (i18n);
	 *  'station' rows carry the data sheet's station label. A sheet with tanks
	 *  has one 'fuel' row per tank, labelled with the tank's name. */
	kind: 'empty' | 'station' | 'fuel';
	/** The station's load key (stationKeys); '' for the empty row and the one
	 *  fuel row, the tank's index for a tank's. */
	key: string;
	/** The station or tank label; '' for the empty row and the one fuel row. */
	label: string;
	/** A fuel row's litres. */
	litres?: number | undefined;
	massKg: number;
	armM: number;
	momentKgM: number;
	/** The station's own maximum (a baggage compartment's), when the sheet
	 *  states one; never on the synthetic rows. */
	maxMassKg?: number | undefined;
	/** The load is above that maximum (the maximum itself is allowed). */
	overMax: boolean;
}

export interface MbPoint {
	massKg: number;
	armM: number;
	momentKgM: number;
}

export interface MassBalanceInput {
	mb: AircraftMassBalance;
	/** Index-aligned with mb.stations. */
	stationMassesKg: number[];
	fuelL: number;
	burnL: number;
	densityKgPerL: number;
}

export interface MassBalanceResult {
	/** Empty aircraft, the stations, then fuel (in that order). */
	rows: StationLoad[];
	/** The litres at takeoff. */
	fuelL: number;
	fuelMassKg: number;
	burnMassKg: number;
	/** The moment the burn-off takes away: at the fuel arm, or from the tanks
	 *  burnt first. */
	burnMomentKgM: number;
	takeoff: MbPoint;
	landing: MbPoint;
	zeroFuel: MbPoint;
	takeoffInside: boolean;
	landingInside: boolean;
	zeroFuelInside: boolean;
	/** No station is loaded above its maximum. */
	stationsWithinMax: boolean;
}

/** Each station's load key: its label, with #2, #3... on a label the sheet
 *  repeats (occurrenceKeys). The loads are stored by it (the flight-prep
 *  state, the plan file's mass_balance.loads), so two stations of one name
 *  (a user plane may have them: the schema accepts it, and refusing it would
 *  drop a stored plane) each keep their own load instead of sharing one,
 *  which put one mass at two arms. A unique label is its own key, so every
 *  stored load reads as it always did. Index-aligned with mb.stations. */
export function stationKeys(mb: Pick<AircraftMassBalance, 'stations'>): string[] {
	return occurrenceKeys(mb.stations, (s) => s.label);
}

/** Where the loads stored for a sheet's stations go when an edit changes
 *  them (the aircraft editor's save): old load key -> new key, null for a
 *  station taken out. Loads are keyed by label, so a renamed station would
 *  drop its load, and taking out the first of two same-named stations would
 *  hand its load to the other (its `#2` key becomes the bare label). Two
 *  edits read without doubt: ONE label changed in place, and ONE station
 *  taken out with the others kept in order, of two same-named ones the one
 *  whose arm is no longer among that name's (an arm edited elsewhere in the
 *  same save decides nothing). Anything else (several labels changed at once,
 *  a removal beside an addition, same-named stations the arms cannot tell
 *  apart) is ambiguous, so it is null and every load stays on its label, as
 *  before; so is an edit that changes no key. Keys index-aligned on both
 *  sides, so a repeat's `#2` follows its station. */
export function stationKeyRemap(
	before: Pick<AircraftMassBalance, 'stations'>,
	after: Pick<AircraftMassBalance, 'stations'>,
): Map<string, string | null> | null {
	const was = before.stations;
	const now = after.stations;
	const oldKeys = stationKeys(before);
	const newKeys = stationKeys(after);
	if (was.length === now.length) {
		const renamed = was.filter((s, i) => s.label !== now[i].label).length;
		return renamed === 1 ? new Map(oldKeys.map((k, i) => [k, newKeys[i]])) : null;
	}
	if (was.length !== now.length + 1) {
		return null;
	}
	// The station at `gone` was taken out: the others line up, one place up.
	const fits = was
		.map((_, i) => i)
		.filter((i) => was.every((s, j) => j === i || s.label === now[j < i ? j : j - 1].label));
	let gone = fits[0];
	if (fits.length > 1) {
		// Labels alone fit several: same-named stations side by side. The one
		// taken out is the one whose arm that name no longer has.
		const label = was[gone].label;
		const arms = (list: MassStation[]): string =>
			JSON.stringify(list.filter((s) => s.label === label).map((s) => s.armM).sort((a, b) => a - b));
		const left = arms(now);
		const decided = fits.filter((i) => arms(was.filter((_, j) => j !== i)) === left);
		if (decided.length !== 1) {
			return null;
		}
		gone = decided[0];
	}
	if (gone === undefined) {
		return null;
	}
	return new Map(oldKeys.map((k, j) => [k, j === gone ? null : newKeys[j < gone ? j : j - 1]]));
}

/** The mass at each station, index-aligned with mb.stations: its stored load
 *  by its key, else the station's default. */
export function stationMasses(
	mb: Pick<AircraftMassBalance, 'stations'>,
	loads: Readonly<Record<string, number>>,
): number[] {
	const keys = stationKeys(mb);
	return mb.stations.map((s, i) => loads[keys[i]] ?? s.defaultMassKg);
}

/** The aircraft without fuel: empty mass plus the stations, index-aligned
 *  with mb.stations (a missing entry takes the station's default, as
 *  computeMassBalance does). One payload's fixed point, which every fuel state
 *  of it moves away from (withFuelL). */
export function zeroFuelPoint(
	mb: Pick<AircraftMassBalance, 'emptyMassKg' | 'emptyArmM' | 'stations'>,
	stationMassesKg: readonly number[],
): MbPoint {
	let massKg = mb.emptyMassKg;
	let momentKgM = mb.emptyMassKg * mb.emptyArmM;
	for (const [i, s] of mb.stations.entries()) {
		const m = stationMassesKg[i] ?? s.defaultMassKg;
		massKg += m;
		momentKgM += m * s.armM;
	}
	return { massKg, momentKgM, armM: massKg > 0 ? momentKgM / massKg : 0 };
}

/** A point with `fuelKg` added at one arm (negative removes it). */
export function withFuel(point: MbPoint, fuelArmM: number, fuelKg: number): MbPoint {
	const massKg = point.massKg + fuelKg;
	const momentKgM = point.momentKgM + fuelKg * fuelArmM;
	return { massKg, momentKgM, armM: massKg > 0 ? momentKgM / massKg : 0 };
}

/** The zero-fuel point with `litres` aboard, where the sheet's slots put
 *  them. */
export function withFuelL(
	zeroFuel: MbPoint,
	slots: readonly FuelSlot[],
	litres: number,
	densityKgPerL: number,
): MbPoint {
	const massKg = zeroFuel.massKg + Math.max(0, litres) * densityKgPerL;
	const momentKgM = zeroFuel.momentKgM + fuelMomentKgM(slots, litres, densityKgPerL);
	return { massKg, momentKgM, armM: massKg > 0 ? momentKgM / massKg : 0 };
}

export function computeMassBalance(input: MassBalanceInput): MassBalanceResult {
	const { mb, densityKgPerL } = input;
	const rows: StationLoad[] = [
		{
			kind: 'empty',
			key: '',
			label: '',
			massKg: mb.emptyMassKg,
			armM: mb.emptyArmM,
			momentKgM: mb.emptyMassKg * mb.emptyArmM,
			overMax: false,
		},
	];
	const keys = stationKeys(mb);
	for (const [i, s] of mb.stations.entries()) {
		const massKg = input.stationMassesKg[i] ?? s.defaultMassKg;
		rows.push({
			kind: 'station',
			key: keys[i],
			label: s.label,
			massKg,
			armM: s.armM,
			momentKgM: massKg * s.armM,
			maxMassKg: s.maxMassKg,
			overMax: s.maxMassKg != null && massKg > s.maxMassKg,
		});
	}
	const slots = fuelSlots(mb);
	const fuelMassKg = input.fuelL * densityKgPerL;
	const burnL = Math.min(input.burnL, input.fuelL);
	const burnMassKg = burnL * densityKgPerL;
	const byTank = fuelBySlot(slots, input.fuelL);
	for (const [i, slot] of slots.entries()) {
		const massKg = byTank[i] * densityKgPerL;
		rows.push({
			kind: 'fuel',
			key: mb.fuelTanks ? String(i) : '',
			label: slot.label,
			litres: byTank[i],
			massKg,
			armM: slot.armM,
			momentKgM: massKg * slot.armM,
			overMax: false,
		});
	}
	const point = (massKg: number, momentKgM: number): MbPoint => ({
		massKg,
		momentKgM,
		armM: massKg > 0 ? momentKgM / massKg : 0,
	});
	const takeoff = point(
		rows.reduce((s, r) => s + r.massKg, 0),
		rows.reduce((s, r) => s + r.momentKgM, 0),
	);
	const fuelMoment = fuelMomentKgM(slots, input.fuelL, densityKgPerL);
	const burnMomentKgM = fuelMoment - fuelMomentKgM(slots, input.fuelL - burnL, densityKgPerL);
	const landing = point(takeoff.massKg - burnMassKg, takeoff.momentKgM - burnMomentKgM);
	const zeroFuel = point(takeoff.massKg - fuelMassKg, takeoff.momentKgM - fuelMoment);
	return {
		rows,
		fuelL: input.fuelL,
		fuelMassKg,
		burnMassKg,
		burnMomentKgM,
		takeoff,
		landing,
		zeroFuel,
		takeoffInside: pointInEnvelope(mb.envelope, takeoff.armM, takeoff.massKg),
		landingInside: pointInEnvelope(mb.envelope, landing.armM, landing.massKg),
		zeroFuelInside: pointInEnvelope(mb.envelope, zeroFuel.armM, zeroFuel.massKg),
		stationsWithinMax: rows.every((r) => !r.overMax),
	};
}

/** The mass at touchdown, what a maximum landing mass limits: the landing
 *  point is after the whole burn-off (the sheet's convention), so what it
 *  counts as burnt but may still be aboard at touchdown is added back, whole
 *  (`addBackL`, conservative): the taxi allowance, burnt after it, since
 *  nothing says how a typed taxi splits between the two ends, and the trip's
 *  contingency, which the flight may never use. Never more fuel than was
 *  loaded. */
export function touchdownMassKg(
	zeroFuelMassKg: number,
	fuelL: number,
	burnL: number,
	addBackL: number | null,
	densityKgPerL: number,
): number {
	const touchdownFuelL = Math.min(fuelL, Math.max(0, fuelL - burnL) + (addBackL ?? 0));
	return zeroFuelMassKg + touchdownFuelL * densityKgPerL;
}

/** The most fuel one payload can take within its limits, the "Maximum within
 *  limits" fuel target. */
export interface MaxFuel {
	/** Whole litres, at most the usable fuel (the exact usable when that fits);
	 *  null when no quantity keeps the fuel-dependent limits. */
	litres: number | null;
	/** What stops more fuel: the tank, the envelope's maximum mass, the CG
	 *  envelope, or the maximum landing mass. */
	limitedBy: 'usable' | 'massMax' | 'cg' | 'landingMass' | null;
	/** The zero-fuel point is outside the envelope: no fuel quantity changes
	 *  it, so it is flagged rather than folded into `litres`. */
	zeroFuelOutside: boolean;
	/** The zero-fuel mass is above the sheet's `maxZeroFuelMassKg`, likewise. */
	zeroFuelOverMax: boolean;
}

/** Why one payload breaks a limit with `fuelL` litres at takeoff, or null
 *  when it keeps them all: its takeoff above the envelope's maximum mass or
 *  outside the envelope and, when the trip's burn-off is known, its landing
 *  outside the envelope or its touchdown mass (the landing point plus
 *  `addBackL`, touchdownMassKg) above `maxLandingMassKg`. */
export function fuelLimitFault(
	mb: AircraftMassBalance,
	zeroFuel: MbPoint,
	densityKgPerL: number,
	fuelL: number,
	burnL: number | null,
	addBackL: number | null,
): MaxFuel['limitedBy'] {
	const topKg = Math.max(...mb.envelope.map((p) => p.massKg));
	const slots = fuelSlots(mb);
	const to = withFuelL(zeroFuel, slots, fuelL, densityKgPerL);
	if (to.massKg > topKg + 1e-9) {
		return 'massMax';
	}
	if (!pointInEnvelope(mb.envelope, to.armM, to.massKg)) {
		return 'cg';
	}
	if (burnL != null) {
		const landingFuelL = Math.max(0, fuelL - burnL);
		const ldg = withFuelL(zeroFuel, slots, landingFuelL, densityKgPerL);
		if (!pointInEnvelope(mb.envelope, ldg.armM, ldg.massKg)) {
			return 'cg';
		}
		if (
			mb.maxLandingMassKg != null &&
			touchdownMassKg(zeroFuel.massKg, fuelL, burnL, addBackL, densityKgPerL) > mb.maxLandingMassKg + 1e-9
		) {
			return 'landingMass';
		}
	}
	return null;
}

/** The largest fuel load keeping this payload within its limits
 *  (fuelLimitFault). Scanned down from the usable fuel in whole litres (the
 *  exact usable first), so the figure shown is the figure tested, and the
 *  first quantity keeping every limit is the largest one, however the fuel
 *  moves the CG (at one arm or through tanks at several). */
export function maxFuelWithinLimits(
	mb: AircraftMassBalance,
	usableL: number,
	stationMassesKg: readonly number[],
	densityKgPerL: number,
	burnL: number | null,
	addBackL: number | null,
): MaxFuel {
	const zf = zeroFuelPoint(mb, stationMassesKg);
	const zeroFuelOutside = !pointInEnvelope(mb.envelope, zf.armM, zf.massKg);
	const zeroFuelOverMax = mb.maxZeroFuelMassKg != null && zf.massKg > mb.maxZeroFuelMassKg + 1e-9;
	const fault = (fuelL: number): MaxFuel['limitedBy'] =>
		fuelLimitFault(mb, zf, densityKgPerL, fuelL, burnL, addBackL);
	if (fault(usableL) === null) {
		return { litres: usableL, limitedBy: 'usable', zeroFuelOutside, zeroFuelOverMax };
	}
	let blocked = fault(usableL);
	for (let l = Math.floor(usableL - 1e-9); l >= 0; l--) {
		const f = fault(l);
		if (f === null) {
			return { litres: l, limitedBy: blocked, zeroFuelOutside, zeroFuelOverMax };
		}
		blocked = f;
	}
	return { litres: null, limitedBy: null, zeroFuelOutside, zeroFuelOverMax };
}

/** Ray-casting point-in-polygon over the (arm, mass) envelope; points on the
 *  boundary count as inside. */
export function pointInEnvelope(
	envelope: ReadonlyArray<EnvelopePoint>,
	armM: number,
	massKg: number,
): boolean {
	const n = envelope.length;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const a = envelope[i];
		const b = envelope[j];
		// On-segment test first (the limit lines themselves are flyable).
		const cross = (b.armM - a.armM) * (massKg - a.massKg) - (b.massKg - a.massKg) * (armM - a.armM);
		const len2 = (b.armM - a.armM) ** 2 + (b.massKg - a.massKg) ** 2;
		if (len2 > 0 && Math.abs(cross) <= 1e-9 * Math.sqrt(len2)) {
			const dot =
				(armM - a.armM) * (b.armM - a.armM) + (massKg - a.massKg) * (b.massKg - a.massKg);
			if (dot >= 0 && dot <= len2) {
				return true;
			}
		}
		if (
			a.massKg > massKg !== b.massKg > massKg &&
			armM < ((b.armM - a.armM) * (massKg - a.massKg)) / (b.massKg - a.massKg) + a.armM
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** Fuel-burn CG travel from takeoff down to zero fuel. At one arm the path
 *  is arm = (M0 * a0 - burned * fuelArm) / (M0 - burned), a hyperbola in the
 *  (arm, mass) plane; through tanks, one such arc per tank, burnt last to
 *  first. So it is sampled, with the endpoints and each tank's empty point
 *  exact. */
export function cgTravel(
	takeoff: MbPoint,
	slots: readonly FuelSlot[],
	fuelL: number,
	densityKgPerL: number,
	samples = 16,
): { armM: number; massKg: number }[] {
	const zeroFuelMoment = takeoff.momentKgM - fuelMomentKgM(slots, fuelL, densityKgPerL);
	const at = (litres: number): { armM: number; massKg: number } => {
		const massKg = takeoff.massKg - (fuelL - litres) * densityKgPerL;
		const momentKgM = zeroFuelMoment + fuelMomentKgM(slots, litres, densityKgPerL);
		return { armM: massKg > 0 ? momentKgM / massKg : 0, massKg };
	};
	// The litres left where a tank runs dry, between full and empty.
	const kinks: number[] = [];
	let filled = 0;
	for (const slot of slots.slice(0, -1)) {
		filled += slot.usableL;
		if (filled > 0 && filled < fuelL) {
			kinks.push(filled);
		}
	}
	const steps = Math.max(1, samples - 1);
	const litres = new Set<number>();
	for (let i = 0; i <= steps; i++) {
		litres.add(fuelL - (fuelL * i) / steps);
	}
	for (const k of kinks) {
		litres.add(k);
	}
	return [...litres].sort((a, b) => b - a).map(at);
}
