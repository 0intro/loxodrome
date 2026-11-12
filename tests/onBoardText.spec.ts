/* How the departure's fuel on board reads (components/flightprep/
 * onBoardText.ts): the fuel control's button naming the source, the form's
 * result sentence, the table cell's figure and title, from one reading. */

import { describe, expect, it } from 'vitest';
import { i18n } from '$lib/state/i18n.svelte';
import type { OnBoard } from '$lib/aircraft/onBoard';
import type { TripLoadsComputation } from '$lib/components/flightprep/shared';
import { flownText, onBoardCell, onBoardResult, onBoardSource } from '$lib/components/flightprep/onBoardText';

/** The no-break space formatDayMonth holds a day and its month with. */
const NB = '\u00a0';

const ESTIMATE: OnBoard = {
	kind: 'estimate',
	litres: 64.583,
	anchorL: 100,
	flownMin: 85,
	flights: 2,
	addedL: 0,
	burntL: 35.417,
	lph: 25,
	overflowL: 0,
};

/** The computation as these functions read it. */
function comp(onBoard: OnBoard, stale = false): TripLoadsComputation {
	return {
		onBoard,
		onBoardStale: stale,
		flightDate: '2026-10-06',
		reading:
			onBoard.kind === 'unknown'
				? null
				: { aircraft: 'F-GORQ', readOn: '2026-10-06', last: { kind: 'full' }, flights: [], lph: null, measuredL: null },
		aircraft: { identity: { registration: 'F-GORQ', type: 'DR400' }, fuel: { usableL: 100, presets: [] } },
	} as unknown as TripLoadsComputation;
}

describe('flownText', () => {
	it('hours and minutes as the log writes them', () => {
		i18n.locale = 'en';
		expect(flownText(85)).toBe('1 h 25 min');
		expect(flownText(45)).toBe('45 min');
		expect(flownText(120)).toBe('2 h');
	});
});

describe('the source, the result, the cell', () => {
	it('nothing read: the way in, an empty cell', () => {
		i18n.locale = 'en';
		const c = comp({ kind: 'unknown' });
		expect(onBoardSource(c)).toEqual({ text: 'Fuel on board…', ink: null });
		expect(onBoardCell(c)).toEqual({ text: '', ink: null, title: undefined });
		expect(onBoardResult(c).text).toContain('State the last refuel');
	});

	it('the journey log: its day, an estimate marked as one, the sentence as the title', () => {
		i18n.locale = 'en';
		const c = comp(ESTIMATE);
		expect(onBoardSource(c)).toEqual({ text: `Journey log, 6${NB}Oct`, ink: null });
		expect(onBoardResult(c)).toEqual({
			text: '1 h 25 min in 2 flights, about 35.4 L at 25 L/h: about 64.6 L on board.',
			ink: null,
		});
		expect(onBoardCell(c)).toEqual({
			text: '≈ 64.6',
			ink: null,
			title: `Journey log, 6${NB}Oct. 1 h 25 min in 2 flights, about 35.4 L at 25 L/h: about 64.6 L on board.`,
		});
		// Read another day than the flight's: the caution ink, the figure kept.
		expect(onBoardSource(comp(ESTIMATE, true)).ink).toBe('warn');
		expect(onBoardCell(comp(ESTIMATE, true))).toMatchObject({ text: '≈ 64.6', ink: 'warn' });
	});

	it('litres added, more than fits, no flight since', () => {
		i18n.locale = 'en';
		const over = comp({ ...ESTIMATE, litres: 75, flownMin: 90, addedL: 15, burntL: 37.5, overflowL: 2.5 });
		expect(onBoardResult(over)).toEqual({
			text: '1 h 30 min in 2 flights, about 37.5 L at 25 L/h, 15 L added: about 75.0 L on board. The journey log adds 2.5 L more than the tanks hold: counted full at that point.',
			ink: 'warn',
		});
		expect(onBoardSource(over).ink).toBe('warn');
		const none = comp({ ...ESTIMATE, litres: 100, flownMin: 0, flights: 0, burntL: 0 });
		expect(onBoardResult(none).text).toBe('No flight since: 100.0 L on board.');
	});

	it('measured, incomplete, another aircraft, a refuel missing', () => {
		i18n.locale = 'en';
		const measured = comp({ kind: 'measured', litres: 52 });
		expect(onBoardSource(measured)).toEqual({ text: `Measured, 6${NB}Oct`, ink: null });
		expect(onBoardCell(measured)).toMatchObject({ text: '52.0', ink: null });
		const tabs = comp({ kind: 'unresolved', reason: 'noTabs' });
		expect(onBoardSource(tabs)).toEqual({ text: 'Journey log incomplete', ink: 'warn' });
		expect(onBoardCell(tabs)).toMatchObject({ text: '—', ink: 'warn' });
		expect(onBoardResult(tabs).text).toContain('states no tabs quantity');
		expect(onBoardResult(comp({ kind: 'unresolved', reason: 'aboveTank' })).text).toBe(
			'A figure is above the 100 L the tanks hold: check it.',
		);
		const other = comp({ kind: 'otherAircraft', aircraft: 'F-GKQC' });
		expect(onBoardSource(other)).toEqual({ text: 'Read for F-GKQC', ink: 'warn' });
		expect(onBoardResult(other).text).toBe(
			'This reading is for F-GKQC, not F-GORQ: clear it to read this aircraft’s journey log.',
		);
		const missing = comp({ kind: 'impossible', anchorL: 20, flownMin: 60, addedL: 0, burntL: 25, lph: 25 });
		expect(onBoardSource(missing).ink).toBe('danger');
		expect(onBoardResult(missing)).toEqual({
			text: 'The journey log burns 25.0 L in 1 h, more than the 20.0 L it puts in the tanks: a refuel is missing from it.',
			ink: 'danger',
		});
	});

	it('in French', () => {
		i18n.locale = 'fr';
		expect(onBoardSource(comp(ESTIMATE)).text).toBe(`Carnet de route, 6${NB}oct.`);
		expect(onBoardResult(comp(ESTIMATE)).text).toContain('1 h 25 min en 2 vols, environ 35.4 L à 25 L/h');
		expect(onBoardSource(comp({ kind: 'unknown' })).text).toBe('Carburant à bord…');
		i18n.locale = 'en';
	});
});

describe('formatDayMonth', () => {
	it('day and month held together, on the UTC calendar', async () => {
		const { formatDayMonth } = await import('$lib/i18n/intl');
		expect(formatDayMonth('en', '2026-10-06')).toBe(`6${NB}Oct`);
		expect(formatDayMonth('fr', '2026-10-06')).toBe(`6${NB}oct.`);
		expect(formatDayMonth('en', '2026-12-31')).toBe(`31${NB}Dec`);
		expect(formatDayMonth('en', 'not a day')).toBe('not a day');
	});
});
