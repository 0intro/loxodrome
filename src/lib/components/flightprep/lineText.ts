/* How the fuel plan and the mass & balance pages word their lines (mbLines.ts
 * decides WHAT to say, purely; this says it) and each fuel-set takeoff's
 * window. One place, so the two pages, which show the same takeoffs, cannot
 * word them two ways. */

import type { TakeoffWindow, TripFix, TripLoad } from '$lib/aircraft/tripLoads';
import { FUEL_EPS_L } from '$lib/aircraft/fuel';
import { fmtDayMonth, t } from '$lib/state/i18n.svelte';
import { fmtArm, type FuelComputation, type TripLoadsComputation } from './shared';
import type { FuelLine, MassLine } from './mbLines';
import { refusalText } from './stopFuel';
import { capitalize, landingAt, load1, num1, takeoffAt, tripTitle } from './tripText';

/** What wording a line needs beyond itself. */
export interface LineWords {
	fuel: FuelComputation;
	comp: TripLoadsComputation;
	/** Several trips: a fuel line names its trip. */
	multi: boolean;
	/** The tanked grade, named (gradeLabel); '' without one. */
	grade: string;
}

/** Who a fuel line is about: "Trip 2, LFQH → LFGP", or with one trip
 *  "LFPL → LFQH". */
export function who(w: LineWords, k: number, what: string): string {
	return w.multi ? t.flightprep.subjTrip({ n: k + 1, what }) : capitalize(what);
}

/** The verified fixes as one sentence, or the word that none cures it. */
export function fixesText(fuel: FuelComputation, fixes: readonly TripFix[]): string {
	if (fixes.length === 0) {
		return t.flightprep.fixNone;
	}
	const clauses = fixes.map((f) => {
		const at = takeoffAt(fuel, f.chainIndex);
		if (f.kind === 'raiseStart') {
			return (f.coversBlock ? t.flightprep.fixRaise : t.flightprep.fixRaiseThen)({ at, litres: f.litres });
		}
		const refuel =
			f.target === 'minimum'
				? t.flightprep.fixRefuelAtMinimum(at)
				: f.target === 'max'
					? t.flightprep.fixRefuelAtMax(at)
					: t.flightprep.fixRefuelAt(at);
		// A refuel curing the trips up to the short one only: say the rest
		// wants another, as the raise does.
		return f.coversBlock ? refuel : refuel + t.flightprep.fixThenFurther;
	});
	return `${capitalize(clauses.join(t.flightprep.fixOr))}.`;
}

/** A litre figure on a window: whole litres, one decimal where the window is
 *  narrower than a litre (takeoffWindow). */
function litres(v: number): string {
	return load1(v);
}

/** What the pump wants arranged there, appended to a window's line. */
function accessTail(access: FuelLine & { kind: 'window' }): string {
	return access.access === 'onRequest'
		? `, ${t.flightprep.accessOnRequestLower}`
		: access.access === 'noHours'
			? `, ${t.flightprep.accessNoHoursLower}`
			: '';
}

/** A window's fuel at takeoff: "66 to 69 L", "66 L", "at most 69 L". */
function windowLitres(w: TakeoffWindow): string {
	if (w.neededL === null) {
		return t.flightprep.windowAtMost(litres(w.maxL ?? 0));
	}
	if (w.maxL === null || w.maxL - w.neededL < 1e-9) {
		return t.flightprep.windowLitresOne(litres(w.neededL));
	}
	return t.flightprep.windowLitres({ lo: litres(w.neededL), hi: litres(w.maxL) });
}

/** A window's uplift: "about +26 to +28 L AVGAS 100LL", "at most +35 L, none
 *  needed". */
function windowUplift(w: TakeoffWindow, grade: string): string | null {
	const u = w.uplift;
	if (!u) {
		return null;
	}
	// Without a grade the phrase would end on a space.
	if (u.lo === 0) {
		return t.flightprep.windowUpliftUpTo({ hi: litres(u.hi), grade }).trim();
	}
	if (u.hi - u.lo < 1e-9) {
		return t.flightprep.windowUpliftOne({ n: litres(u.lo), grade }).trim();
	}
	return t.flightprep.windowUplift({ lo: litres(u.lo), hi: litres(u.hi), grade }).trim();
}

/** The plan's own fuel there: its uplift over what is on board, or at a
 *  departure whose tanks nobody stated, its fuel at takeoff. */
function windowPlan(w: LineWords, win: TakeoffWindow): string {
	if (win.chainIndex === 0 && win.carriedL === null) {
		const startL = w.comp.loads.trips[0]?.startL ?? null;
		return startL !== null ? `${load1(startL)} L` : '—';
	}
	return win.planUpliftL === null
		? '—'
		: win.planUpliftL > 0
			? t.flightprep.upliftShort(String(win.planUpliftL))
			: t.flightprep.planNothingAdded;
}

/** The refuelling list's line for one fuel-set takeoff: the fuel to take off
 *  with, the uplift that means over what is on board, and the plan's own
 *  figure. */
export function windowLineText(w: LineWords, line: FuelLine & { kind: 'window' }): string {
	const win = line.window;
	const at = takeoffAt(w.fuel, win.chainIndex);
	if (win.state === 'aboveMaxOnArrival') {
		return t.flightprep.windowAboveOnArrival({
			at,
			aboard: num1(win.carriedL ?? 0),
			max: litres(win.maxL ?? 0),
		});
	}
	const uplift = windowUplift(win, w.grade);
	const p = { at, litres: windowLitres(win), plan: windowPlan(w, win) };
	const text = uplift ? t.flightprep.windowLineUplift({ ...p, uplift }) : t.flightprep.windowLine(p);
	return `${text}${accessTail(line)}`;
}

/** A fuel line in words, and the ink it reads in. */
export function fuelText(w: LineWords, line: FuelLine): { text: string; ink: 'danger' | 'warn' | 'muted' } {
	const fuel = w.fuel;
	switch (line.kind) {
		case 'noConsumption':
			return { text: t.flightprep.lineNoConsumption, ink: 'warn' };
		case 'short': {
			const subj = who(w, line.trip, tripTitle(fuel, line.trip));
			const head = line.dry
				? t.flightprep.lineDry(subj)
				: t.flightprep.lineShort({ who: subj, landing: num1(line.landingL), reserve: num1(line.reserveL) });
			return { text: `${head} ${fixesText(fuel, line.fixes)}`, ink: 'danger' };
		}
		case 'unavailable': {
			const at = takeoffAt(fuel, line.trip);
			const text =
				line.target === 'tabs'
					? t.flightprep.lineUnavailableTabs(at)
					: line.target === 'max'
						? t.flightprep.lineUnavailableMax(at)
						: t.flightprep.lineUnavailableMinimum(at);
			return { text, ink: 'danger' };
		}
		case 'aboveUsable':
			return {
				text: t.flightprep.lineAboveUsable({
					at: takeoffAt(fuel, line.trip),
					asked: load1(line.requestedL),
					usable: w.comp.aircraft.fuel?.usableL ?? 0,
				}),
				ink: 'warn',
			};
		case 'noDefuel':
			return {
				text: t.flightprep.lineNoDefuel({
					at: takeoffAt(fuel, line.trip),
					onBoard: num1(line.carriedL),
					asked: load1(line.requestedL),
				}),
				ink: 'muted',
			};
		case 'refusedTick': {
			const pt = w.comp.points[line.trip];
			const at = takeoffAt(fuel, line.trip);
			const reason =
				pt?.refusal && pt.ident ? refusalText(pt.ident, pt.refusal, w.comp.aircraft.fuel?.types ?? []) : at;
			return { text: t.flightprep.lineRefusedTick({ at, reason }), ink: 'warn' };
		}
		case 'avgasPassengers':
			return { text: t.flightprep.lineAvgasPassengers, ink: 'muted' };
		case 'onBoard':
			return onBoardLineText(w, line);
		case 'aboardUnknown':
			return { text: t.flightprep.lineAboardUnknown(takeoffAt(fuel, line.trip)), ink: 'danger' };
		case 'aboveMaxAboard':
			return {
				text: t.flightprep.lineAboardAboveMax({
					at: takeoffAt(fuel, line.trip),
					aboard: num1(line.aboardL),
					max: load1(line.maxL),
				}),
				ink: 'warn',
			};
		case 'window':
			return { text: windowLineText(w, line), ink: 'muted' };
		case 'emptyWindow': {
			const at = takeoffAt(fuel, line.trip);
			// The tanks' wording only where the tanks are the ceiling (no limit
			// below them, or no mass and balance): limits binding lower are
			// what the need meets first, however far past the tanks it runs
			// (145 L needed, 55 L within the limits of 100 L tanks).
			const tank = line.limitedBy === 'usable' || line.limitedBy === null;
			const text =
				line.beyondTank && tank
					? t.flightprep.windowBeyondTank({ at, needed: litres(line.neededL), usable: litres(line.maxL) })
					: t.flightprep.windowEmpty({ at, needed: litres(line.neededL), max: litres(line.maxL) });
			return { text, ink: 'danger' };
		}
	}
}

/** The departure's reading in words: what it gives and where from, or why
 *  it gives nothing, a figure read another day said too, and always the
 *  check the figure is no substitute for. */
function onBoardLineText(
	w: LineWords,
	line: FuelLine & { kind: 'onBoard' },
): { text: string; ink: 'danger' | 'warn' | 'muted' } {
	const at = takeoffAt(w.fuel, line.trip);
	const r = line.reading;
	const day = fmtDayMonth(line.readOn);
	const parts: string[] = [];
	let ink: 'danger' | 'warn' | 'muted' = 'muted';
	switch (r.kind) {
		case 'estimate':
			parts.push(t.flightprep.lineOnBoardLog({ at, litres: num1(r.litres), day }));
			if (r.overflowL > 0) {
				parts.push(t.flightprep.lineOnBoardOverflow(num1(r.overflowL)));
				ink = 'warn';
			}
			break;
		case 'measured':
			parts.push(t.flightprep.lineOnBoardMeasured({ at, litres: num1(r.litres), day }));
			break;
		case 'unresolved':
			parts.push(t.flightprep.lineOnBoardIncomplete(at));
			ink = 'warn';
			break;
		case 'otherAircraft':
			parts.push(t.flightprep.lineOnBoardOther({ at, reg: r.aircraft }));
			ink = 'warn';
			break;
		case 'impossible':
			parts.push(t.flightprep.lineOnBoardImpossible(at));
			ink = 'danger';
			break;
		case 'unknown':
			break;
	}
	if (line.stale && (r.kind === 'estimate' || r.kind === 'measured')) {
		parts.push(t.flightprep.lineOnBoardStale(fmtDayMonth(line.flightDate)));
		if (ink === 'muted') {
			ink = 'warn';
		}
	}
	parts.push(t.flightprep.onBoardCheck);
	return { text: parts.join(' '), ink };
}

/** A mass line in words, under its trip's own chart, whose heading names
 *  the trip: "Takeoff from LFQH", never "Trip 2, takeoff from LFQH". */
export function massText(fuel: FuelComputation, line: MassLine): string {
	switch (line.kind) {
		case 'aboveMax': {
			const head = t.flightprep.lineAboveMax({
				who: capitalize(t.flightprep.subjTakeoff(takeoffAt(fuel, line.trip))),
				kg: num1(line.massKg),
				max: line.maxKg,
			});
			return line.maxWithinL !== null
				? `${head} ${t.flightprep.lineMaxWithin({ at: takeoffAt(fuel, line.at), litres: line.maxWithinL })}`
				: head;
		}
		case 'cgOut':
			return t.flightprep.lineCgOut({
				who: capitalize(
					line.phase === 'takeoff'
						? t.flightprep.subjTakeoff(takeoffAt(fuel, line.trip))
						: t.flightprep.subjLanding(landingAt(fuel, line.trip)),
				),
				arm: fmtArm(line.armM),
			});
		case 'zeroFuelOut':
			return t.flightprep.lineZeroFuelOut({
				who: capitalize(t.flightprep.subjZeroFuel),
				arm: fmtArm(line.armM),
			});
		case 'touchdownOver':
			return t.flightprep.lineTouchdownOver({
				who: capitalize(t.flightprep.subjLanding(landingAt(fuel, line.trip))),
				kg: num1(line.touchdownKg),
				max: line.maxKg,
			});
		case 'zeroFuelOver':
			return t.flightprep.lineZeroFuelOver({
				who: capitalize(t.flightprep.subjZeroFuel),
				kg: num1(line.massKg),
				max: line.maxKg,
			});
		case 'station':
			return t.flightprep.lineStationOver({ station: line.label, kg: num1(line.massKg), max: line.maxKg });
	}
}

/** Whether trip `tr`'s start breaks its window, on the unrounded figures:
 *  below what the block needs, above what the limits allow. */
export function startOutside(tr: TripLoad): { below: boolean; above: boolean } {
	const start = tr.startL;
	const need = tr.blockMinimumL;
	const max = tr.maxWithinLimits?.litres ?? null;
	return {
		below: start !== null && need !== null && start < need - FUEL_EPS_L,
		above: start !== null && max !== null && start > max + FUEL_EPS_L,
	};
}

/** A sheet's window, short, beside its fuel control: "needed 66 L, maximum
 *  within limits 69 L"; each half says whether the plan's start breaks it. */
export function sheetWindowParts(
	win: TakeoffWindow,
	tr: TripLoad,
): { needed: { text: string; bad: boolean } | null; max: { text: string; bad: boolean } | null } {
	const out = startOutside(tr);
	const needed = win.neededL === null ? null : { text: t.flightprep.sheetNeeded(litres(win.neededL)), bad: out.below };
	const max = !win.limitsChecked
		? null
		: win.maxL === null
			? { text: t.flightprep.sheetMaxNone, bad: true }
			: { text: t.flightprep.sheetMax(litres(win.maxL)), bad: out.above };
	return { needed, max };
}
