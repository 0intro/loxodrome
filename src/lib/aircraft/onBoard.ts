/* The fuel on board before the departure's refuel: estimated from the
 * aircraft's journey log (the last refuel, then every line since with its
 * flight time and the litres added before it), or measured at the aircraft.
 * Pure, no Svelte. flightprep/shared.ts hands the figure to the trip loads,
 * where the departure then behaves as a stop does: what is aboard, the
 * target, the uplift between them (tripLoads.ts).
 *
 * The log's flight time is the BLOCK time (EASA flight time, from the first
 * movement for the takeoff to the final stop, taxi included), so the burn is
 * that time at the consumption the plan burns with, nothing added. The log
 * is run line by line, the way the tanks lived it: the litres added before a
 * flight, held to the usable fuel (the excess counted, a log that says more
 * went in than fits is said), then the flight's burn, the level never allowed
 * below empty, where the log misses a refuel. Summing first and clamping the
 * end would over-state what is aboard (full, 0:30 flown, 15 L added, 1:00
 * flown: 77.5 L where the tanks hold 75).
 *
 * A TYPED figure above the tanks is a mistake to say, never a quantity to
 * clamp: 450 typed for 45 would read as full and ask for no uplift. */

import { FUEL_EPS_L } from './fuel';

/** What the last refuel the journey log states left in the tanks. */
export type LastRefuel = { kind: 'full' } | { kind: 'tabs' } | { kind: 'litres'; litres: number | null };

/** One line of the journey log since that refuel: its flight time in
 *  minutes (null: none, a line that only adds fuel) and the litres added
 *  before it (null: none). */
export interface LogFlight {
	min: number | null;
	addedL: number | null;
}

/** What the pilot stated about the departure's tanks. */
export interface OnBoardInputs {
	/** The aircraft the log was read for (aircraftKey): another aircraft's
	 *  tanks are not this one's, and a club may hand over another plane. */
	aircraft: string;
	/** The UTC day the log was read or the quantity measured, 'YYYY-MM-DD'. */
	readOn: string;
	/** null: the log not used (a measured quantity alone, or nothing yet). */
	last: LastRefuel | null;
	flights: LogFlight[];
	/** A consumption typed for the estimate, L/h; null = the sheet's. */
	lph: number | null;
	/** Measured at the aircraft (dipstick, gauges), litres; replaces the
	 *  estimate. */
	measuredL: number | null;
}

/** The aircraft's own figures the reading is judged against. */
export interface OnBoardSpec {
	/** The selected aircraft's key (aircraftKey). */
	aircraftKey: string;
	usableL: number;
	/** The sheet's tabs preset, null when it has none. */
	tabsL: number | null;
	/** The sheet's consumption, the one the fuel plan burns with. */
	sheetLph: number | null;
}

/** Why a reading gives no figure yet: no last refuel chosen, the sheet
 *  states no tabs, the quantity not typed, no consumption to burn the log's
 *  time with, or a typed figure above the tanks. */
export type OnBoardUnresolved = 'noAnchor' | 'noTabs' | 'noLitres' | 'noConsumption' | 'aboveTank';

export type OnBoard =
	/** Nothing stated: the departure's tanks are not known. */
	| { kind: 'unknown' }
	/** Read for another aircraft than the one selected: not this one's. */
	| { kind: 'otherAircraft'; aircraft: string }
	| { kind: 'measured'; litres: number }
	| {
			kind: 'estimate';
			litres: number;
			/** What the last refuel left. */
			anchorL: number;
			flownMin: number;
			/** The lines carrying a flight time. */
			flights: number;
			addedL: number;
			burntL: number;
			/** The consumption the log's time was burnt at. */
			lph: number;
			/** Litres the log adds beyond the usable fuel (held to it). */
			overflowL: number;
	  }
	| { kind: 'unresolved'; reason: OnBoardUnresolved }
	/** The log's time burns more than its fuel: a refuel is missing from
	 *  it. The whole log's figures, as the pilot reads them. */
	| { kind: 'impossible'; anchorL: number; flownMin: number; addedL: number; burntL: number; lph: number };

/** A non-negative finite figure, else 0 (the state keeps no other). */
const amount = (v: number | null): number => (v != null && Number.isFinite(v) && v > 0 ? v : 0);

export function computeOnBoard(inp: OnBoardInputs | null, spec: OnBoardSpec): OnBoard {
	if (!inp) {
		return { kind: 'unknown' };
	}
	if (inp.aircraft !== spec.aircraftKey) {
		return { kind: 'otherAircraft', aircraft: inp.aircraft };
	}
	const usable = spec.usableL;
	if (inp.measuredL != null) {
		return inp.measuredL > usable + FUEL_EPS_L
			? { kind: 'unresolved', reason: 'aboveTank' }
			: { kind: 'measured', litres: amount(inp.measuredL) };
	}
	const lines = inp.flights.filter((f) => amount(f.min) > 0 || amount(f.addedL) > 0);
	if (!inp.last) {
		return lines.length > 0 ? { kind: 'unresolved', reason: 'noAnchor' } : { kind: 'unknown' };
	}
	let anchorL: number;
	switch (inp.last.kind) {
		case 'full':
			anchorL = usable;
			break;
		case 'tabs':
			if (spec.tabsL == null) {
				return { kind: 'unresolved', reason: 'noTabs' };
			}
			anchorL = spec.tabsL;
			break;
		case 'litres':
			if (inp.last.litres == null) {
				return { kind: 'unresolved', reason: 'noLitres' };
			}
			anchorL = amount(inp.last.litres);
			break;
	}
	if (anchorL > usable + FUEL_EPS_L || lines.some((f) => amount(f.addedL) > usable + FUEL_EPS_L)) {
		return { kind: 'unresolved', reason: 'aboveTank' };
	}
	const flownMin = lines.reduce((s, f) => s + amount(f.min), 0);
	const addedL = lines.reduce((s, f) => s + amount(f.addedL), 0);
	const lph = inp.lph ?? spec.sheetLph;
	if (flownMin > 0 && (lph == null || !(lph > 0))) {
		return { kind: 'unresolved', reason: 'noConsumption' };
	}
	const rate = lph != null && lph > 0 ? lph : 0;
	const burntL = (flownMin * rate) / 60;
	let level = anchorL;
	let overflowL = 0;
	for (const f of lines) {
		level += amount(f.addedL);
		if (level > usable) {
			overflowL += level - usable;
			level = usable;
		}
		level -= (amount(f.min) * rate) / 60;
		if (level < -FUEL_EPS_L) {
			return { kind: 'impossible', anchorL, flownMin, addedL, burntL, lph: rate };
		}
	}
	return {
		kind: 'estimate',
		litres: Math.max(0, level),
		anchorL,
		flownMin,
		flights: lines.filter((f) => amount(f.min) > 0).length,
		addedL,
		burntL,
		lph: rate,
		overflowL,
	};
}

/** The litres a reading puts aboard, null when it gives none. */
export function aboardOf(r: OnBoard): number | null {
	return r.kind === 'measured' || r.kind === 'estimate' ? r.litres : null;
}

/** A reading taken on another day than the flight's: someone may have flown
 *  or refuelled since. Still used, and said. */
export function onBoardStale(readOn: string, flightDate: string): boolean {
	return readOn !== flightDate;
}
