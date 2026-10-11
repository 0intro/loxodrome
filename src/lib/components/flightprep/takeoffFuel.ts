/* The fuel at each takeoff, read and written: the one path for the control
 * both pages show (the fuel plan page's table and each trip's sheet on
 * the M&B page), the cure buttons under a sheet's mass lines and the
 * strategies' "Use this plan". A takeoff is a chain index: the departure (0)
 * is the plan's own fuel target (or no refuel, taking off with what is on
 * board), every later one the stop before that trip, named by its aerodrome
 * (shared.ts stopKeys); a stop without a key (a trip the fuel plan cannot
 * place) reads and writes nothing. */

import {
	applyRefuelStops,
	flightPrep,
	setMb,
	setStopFuel,
	setStopTarget,
	stopInputs,
	type MbFuelMode,
} from '$lib/state/flightPrep.svelte';
import { strategyTargets } from '$lib/aircraft/tripLoads';
import type { RefuelStrategy } from '$lib/aircraft/fuel';
import type { TripLoadsComputation } from './shared';

/** A takeoff's target, or 'none' where it takes off with what is on board:
 *  the fuel carried over at a stop, the tanks as read at the departure. */
export type TakeoffMode = MbFuelMode | 'none';

/** The target at chain takeoff `k`; null at a stop without a key. */
export function takeoffMode(comp: TripLoadsComputation, k: number): TakeoffMode | null {
	if (k === 0) {
		return flightPrep.mb.refuel ? flightPrep.mb.fuelMode : 'none';
	}
	const key = comp.stopKeys[k];
	if (key == null) {
		return null;
	}
	const st = stopInputs(key);
	return st.refuel ? st.mode : 'none';
}

/** The Custom figure typed at chain takeoff `k` (null: the empty box, which
 *  is the Minimum). */
export function takeoffLitres(comp: TripLoadsComputation, k: number): number | null {
	if (k === 0) {
		return flightPrep.mb.customLitres;
	}
	const key = comp.stopKeys[k];
	return key == null ? null : stopInputs(key).litres;
}

export function setTakeoffTarget(comp: TripLoadsComputation, k: number, mode: TakeoffMode): void {
	if (k === 0) {
		// The target is kept through a no refuel, as a stop's is through its
		// tick, so a typed Custom figure comes back with it.
		setMb(mode === 'none' ? { refuel: false } : { fuelMode: mode, refuel: true });
		return;
	}
	const key = comp.stopKeys[k];
	if (key != null) {
		setStopTarget(key, mode === 'none' ? null : mode);
	}
}

export function setTakeoffLitres(comp: TripLoadsComputation, k: number, litres: number | null): void {
	if (k === 0) {
		setMb({ customLitres: litres });
		return;
	}
	const key = comp.stopKeys[k];
	if (key != null) {
		setStopFuel(key, { litres });
	}
}

/** "Use this plan": the strategy's stops refuelled (a stop not refuelled yet
 *  at the Minimum, the strategy's own row; one already refuelled keeping its
 *  target), the other stops carrying over, the departure the pilot's own (a
 *  no refuel there taking the Minimum, which adds nothing when what is aboard
 *  covers it); then any takeoff whose target so kept would break a limit the
 *  fuel decides moved to its Maximum within limits (tripLoads.ts
 *  strategyTargets, asked before anything is written). */
export function applyStrategy(comp: TripLoadsComputation, s: RefuelStrategy): void {
	const targets = strategyTargets(comp.input, s.stops);
	const keys = comp.stopKeys;
	const ticked = s.stops.flatMap((stop) => {
		const key = keys[stop + 1];
		return key ? [key] : [];
	});
	const all = keys.slice(1).flatMap((key) => (key ? [key] : []));
	applyRefuelStops(ticked, all);
	for (const [k, target] of targets.entries()) {
		if (target?.kind === 'max' && takeoffMode(comp, k) !== 'max') {
			setTakeoffTarget(comp, k, 'max');
		} else if (k === 0 && target?.kind === 'minimum' && takeoffMode(comp, 0) === 'none') {
			setTakeoffTarget(comp, 0, 'minimum');
		}
	}
}
