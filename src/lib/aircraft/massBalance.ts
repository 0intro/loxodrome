/* Mass & balance: station sums, CG, the fuel / burn-off modes, the CG
 * envelope test and the fuel-burn CG travel. Mirrors the workbook's "Masse
 * et centrage" tabs: takeoff = empty + stations + fuel; landing = takeoff
 * minus the burn-off at the fuel arm; fuel mass = litres x density. Pure
 * (no Svelte, no I/O). */

import type { AircraftFuel, AircraftMassBalance, EnvelopePoint } from './schema';

export type FuelMode =
	| { kind: 'full' }
	| { kind: 'minimum' }
	| { kind: 'preset'; name: string }
	| { kind: 'custom'; litres: number };

export type BurnMode = 'all' | 'trip';

/** Resolve a fuel mode to litres. 'full' is the usable fuel; 'minimum' is the
 *  refuelling plan's heaviest feasible load (null when there is none);
 *  'custom' clamps to the usable fuel; an unknown preset is null. */
export function fuelLitresForMode(
	fuel: AircraftFuel,
	mode: FuelMode,
	minimumL: number | null,
): number | null {
	switch (mode.kind) {
		case 'full':
			return fuel.usableL;
		case 'minimum':
			return minimumL;
		case 'preset': {
			const p = fuel.presets.find((x) => x.name === mode.name);
			return p ? p.litres : null;
		}
		case 'custom':
			return Math.max(0, Math.min(mode.litres, fuel.usableL));
	}
}

/** Burn-off litres: 'all' burns the whole takeoff fuel; 'trip' burns the
 *  plan's total burn-off-with-wind minutes at the consumption (the
 *  workbook's "Delestage Trajet"), clamped to the fuel on board. Null when
 *  the trip burn is unknown (no fuel plan). */
export function burnLitresForMode(
	mode: BurnMode,
	fuelL: number,
	tripBurnOffMin: number | null,
	consumptionLph: number | null,
): number | null {
	if (mode === 'all') {
		return fuelL;
	}
	if (tripBurnOffMin == null || consumptionLph == null || consumptionLph <= 0) {
		return null;
	}
	return Math.min(fuelL, tripBurnOffMin * (consumptionLph / 60));
}

export interface StationLoad {
	/** 'empty' and 'fuel' are the synthetic rows, labelled at render (i18n);
	 *  'station' rows carry the data sheet's station label. */
	kind: 'empty' | 'station' | 'fuel';
	/** The station label; '' for the synthetic empty / fuel rows. */
	label: string;
	massKg: number;
	armM: number;
	momentKgM: number;
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
	fuelMassKg: number;
	burnMassKg: number;
	takeoff: MbPoint;
	landing: MbPoint;
	zeroFuel: MbPoint;
	takeoffInside: boolean;
	landingInside: boolean;
	zeroFuelInside: boolean;
}

export function computeMassBalance(input: MassBalanceInput): MassBalanceResult {
	const { mb, densityKgPerL } = input;
	const rows: StationLoad[] = [
		{
			kind: 'empty',
			label: '',
			massKg: mb.emptyMassKg,
			armM: mb.emptyArmM,
			momentKgM: mb.emptyMassKg * mb.emptyArmM,
		},
	];
	for (const [i, s] of mb.stations.entries()) {
		const massKg = input.stationMassesKg[i] ?? s.defaultMassKg;
		rows.push({ kind: 'station', label: s.label, massKg, armM: s.armM, momentKgM: massKg * s.armM });
	}
	const fuelMassKg = input.fuelL * densityKgPerL;
	const burnMassKg = Math.min(input.burnL, input.fuelL) * densityKgPerL;
	rows.push({
		kind: 'fuel',
		label: '',
		massKg: fuelMassKg,
		armM: mb.fuelArmM,
		momentKgM: fuelMassKg * mb.fuelArmM,
	});
	const point = (massKg: number, momentKgM: number): MbPoint => ({
		massKg,
		momentKgM,
		armM: massKg > 0 ? momentKgM / massKg : 0,
	});
	const takeoff = point(
		rows.reduce((s, r) => s + r.massKg, 0),
		rows.reduce((s, r) => s + r.momentKgM, 0),
	);
	const landing = point(takeoff.massKg - burnMassKg, takeoff.momentKgM - burnMassKg * mb.fuelArmM);
	const zeroFuel = point(takeoff.massKg - fuelMassKg, takeoff.momentKgM - fuelMassKg * mb.fuelArmM);
	return {
		rows,
		fuelMassKg,
		burnMassKg,
		takeoff,
		landing,
		zeroFuel,
		takeoffInside: pointInEnvelope(mb.envelope, takeoff.armM, takeoff.massKg),
		landingInside: pointInEnvelope(mb.envelope, landing.armM, landing.massKg),
		zeroFuelInside: pointInEnvelope(mb.envelope, zeroFuel.armM, zeroFuel.massKg),
	};
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

/** Fuel-burn CG travel from takeoff down to zero fuel. The path is
 *  arm = (M0 * a0 - burned * fuelArm) / (M0 - burned), a hyperbola in the
 *  (arm, mass) plane, so it is sampled; endpoints are exact. */
export function cgTravel(
	takeoff: MbPoint,
	fuelArmM: number,
	fuelMassKg: number,
	samples = 16,
): { armM: number; massKg: number }[] {
	const out: { armM: number; massKg: number }[] = [];
	const steps = Math.max(1, samples - 1);
	for (let i = 0; i <= steps; i++) {
		const burned = (fuelMassKg * i) / steps;
		const massKg = takeoff.massKg - burned;
		const momentKgM = takeoff.momentKgM - burned * fuelArmM;
		out.push({ armM: massKg > 0 ? momentKgM / massKg : 0, massKg });
	}
	return out;
}
