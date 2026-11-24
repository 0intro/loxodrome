/* How the departure's fuel on board reads (aircraft/onBoard.ts decides, this
 * words): the fuel control's button naming where the figure comes from, the
 * form's result sentence, the table cell's figure and its title. One place,
 * so the button, the cells and the lines under the table cannot word one
 * reading three ways. */

import { aircraftKey } from '$lib/aircraft/schema';
import { fmtDayMonth, t } from '$lib/state/i18n.svelte';
import { load1, num1 } from './tripText';
import type { OnBoardLineInput } from './mbLines';
import type { TripLoadsComputation } from './shared';

/** The ink a reading reads in: muted (nothing to check), the caution ink
 *  (a figure to check: read another day, incomplete, another aircraft, more
 *  added than fits), the danger ink (a refuel missing from the log). */
export type OnBoardInk = 'warn' | 'danger' | null;

/** A flight time in hours and minutes, "1 h 25 min". */
export function flownText(min: number): string {
	const total = Math.max(0, Math.round(min));
	return t.flightprep.durationHm({ h: Math.floor(total / 60), m: total % 60 });
}

/** The button under the departure's fuel control: where its figure comes
 *  from, or the way in when nothing was read. */
export function onBoardSource(comp: TripLoadsComputation): { text: string; ink: OnBoardInk } {
	const r = comp.onBoard;
	const day = comp.reading ? fmtDayMonth(comp.reading.readOn) : '';
	switch (r.kind) {
		case 'unknown':
			return { text: t.flightprep.onBoardButton, ink: null };
		case 'estimate':
			return {
				text: t.flightprep.onBoardSourceLog(day),
				ink: comp.onBoardStale || r.overflowL > 0 ? 'warn' : null,
			};
		case 'measured':
			return { text: t.flightprep.onBoardSourceMeasured(day), ink: comp.onBoardStale ? 'warn' : null };
		case 'unresolved':
			return { text: t.flightprep.onBoardSourceIncomplete, ink: 'warn' };
		case 'otherAircraft':
			return { text: t.flightprep.onBoardSourceOther(r.aircraft), ink: 'warn' };
		case 'impossible':
			return { text: t.flightprep.onBoardSourceImpossible, ink: 'danger' };
	}
}

/** What the reading gives, as one sentence: the form's result line and the
 *  provenance the cells carry as their title. */
export function onBoardResult(comp: TripLoadsComputation): { text: string; ink: OnBoardInk } {
	const r = comp.onBoard;
	switch (r.kind) {
		case 'unknown':
			return { text: t.flightprep.onBoardResultUnknown, ink: null };
		case 'estimate': {
			const added = r.addedL > 0 ? load1(r.addedL) : null;
			const head =
				r.flownMin > 0
					? t.flightprep.onBoardResultEstimate({
							flown: flownText(r.flownMin),
							n: r.flights,
							burnt: num1(r.burntL),
							lph: load1(r.lph),
							added,
							litres: num1(r.litres),
						})
					: t.flightprep.onBoardResultNoFlight({ added, litres: num1(r.litres) });
			return r.overflowL > 0
				? { text: `${head} ${t.flightprep.onBoardOverflow(num1(r.overflowL))}`, ink: 'warn' }
				: { text: head, ink: null };
		}
		case 'measured':
			return { text: t.flightprep.onBoardResultMeasured(num1(r.litres)), ink: null };
		case 'unresolved': {
			const text =
				r.reason === 'noAnchor'
					? t.flightprep.onBoardNoAnchor
					: r.reason === 'noTabs'
						? t.flightprep.onBoardNoTabs
						: r.reason === 'noLitres'
							? t.flightprep.onBoardNoLitres
							: r.reason === 'noConsumption'
								? t.flightprep.onBoardNoConsumption
								: t.flightprep.onBoardAboveTank(comp.aircraft.fuel?.usableL ?? 0);
			return { text, ink: 'warn' };
		}
		case 'otherAircraft':
			return { text: t.flightprep.onBoardOther({ reg: r.aircraft, current: aircraftKey(comp.aircraft) }), ink: 'warn' };
		case 'impossible':
			return {
				text: t.flightprep.onBoardResultImpossible({
					flown: flownText(r.flownMin),
					burnt: num1(r.burntL),
					available: num1(r.anchorL + r.addedL),
				}),
				ink: 'danger',
			};
	}
}

/** The departure's "on board before refuelling" cell: "≈ 64.6" for the
 *  journey log's estimate, the figure itself when measured, empty while
 *  nothing is known (an untouched plan prints as it always did); its title
 *  the source and what it gives. */
export function onBoardCell(comp: TripLoadsComputation): { text: string; ink: OnBoardInk; title: string | undefined } {
	const r = comp.onBoard;
	const title = r.kind === 'unknown' ? undefined : `${onBoardSource(comp).text}. ${onBoardResult(comp).text}`;
	if (r.kind === 'estimate') {
		return { text: t.flightprep.aboutLitres(num1(r.litres)), ink: onBoardSource(comp).ink, title };
	}
	if (r.kind === 'measured') {
		return { text: num1(r.litres), ink: comp.onBoardStale ? 'warn' : null, title };
	}
	return { text: r.kind === 'unknown' ? '' : '—', ink: r.kind === 'unknown' ? null : onBoardSource(comp).ink, title };
}

/** What the lines under the tables say of the reading (mbLines.ts), none
 *  without one. */
export function onBoardLineInput(comp: TripLoadsComputation): OnBoardLineInput | undefined {
	return comp.reading
		? { reading: comp.onBoard, readOn: comp.reading.readOn, flightDate: comp.flightDate, stale: comp.onBoardStale }
		: undefined;
}
