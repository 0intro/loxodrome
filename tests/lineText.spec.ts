import { describe, expect, it } from 'vitest';
import { i18n } from '$lib/state/i18n.svelte';
import { fuelText, windowLineText, type LineWords } from '$lib/components/flightprep/lineText';
import type { FuelLine } from '$lib/components/flightprep/mbLines';

/* A takeoff whose window is empty is worded by what binds it: the limits
 * where they sit below the tanks, however far past the tanks the need runs,
 * and the tanks only where they are the ceiling. (F-GORQ four aboard, the
 * whole plan in one load: 145 L needed, 55 L within the limits of its 100 L
 * tanks, read "more than the 55 L the tanks hold".) */

const words = {
	fuel: { inputColumns: [{ trip: { route: { waypoints: [{ ident: 'LFPL', lat: 48.75, lon: 2.62 }] } } }] },
	comp: {},
	multi: false,
	grade: 'AVGAS 100LL',
} as unknown as LineWords;

const empty = (over: Partial<FuelLine & { kind: 'emptyWindow' }>): FuelLine => ({
	kind: 'emptyWindow',
	trip: 0,
	neededL: 145,
	maxL: 55,
	limitedBy: 'massMax',
	bindingTrip: 0,
	beyondTank: true,
	...over,
});

describe('the empty window', () => {
	it('names the limits when they bind below the tanks, the need past the tanks or not', () => {
		i18n.locale = 'en';
		for (const beyondTank of [true, false]) {
			const { text, ink } = fuelText(words, empty({ beyondTank }));
			expect(text).toContain('more than the 55 L the limits allow');
			expect(text).not.toContain('tanks hold');
			expect(ink).toBe('danger');
		}
		for (const limitedBy of ['cg', 'landingMass'] as const) {
			expect(fuelText(words, empty({ limitedBy })).text).toContain('the limits allow');
		}
	});

	it('names the tanks where they are the ceiling', () => {
		i18n.locale = 'en';
		const tank = fuelText(words, empty({ maxL: 100, limitedBy: 'usable' })).text;
		expect(tank).toBe('LFPL: 145 L needed until the next refuel, more than the 100 L the tanks hold: refuel further on.');
		// No mass and balance section: the usable fuel is the window's top.
		expect(fuelText(words, empty({ maxL: 100, limitedBy: null })).text).toContain('the 100 L the tanks hold');
	});

	it('words it the same way in French', () => {
		i18n.locale = 'fr';
		expect(fuelText(words, empty({})).text).toContain('55 L');
		expect(fuelText(words, empty({})).text).not.toContain('réservoirs');
		expect(fuelText(words, empty({ maxL: 100, limitedBy: 'usable' })).text).toContain('réservoirs');
		i18n.locale = 'en';
	});
});

/** The no-break space formatDayMonth holds a day and its month with. */
const NB = '\u00a0';

/* The departure's fuel on board (aircraft/onBoard.ts), worded: what the
 * reading gives and where from, a figure read another day or adding more
 * than fits said in the caution ink, a refuel missing from the log in the
 * danger ink, and always the check the figure is no substitute for. */
describe('the departure\'s fuel on board', () => {
	const reading = (over: Record<string, unknown> = {}): FuelLine => ({
			kind: 'onBoard',
			trip: 0,
			reading: { kind: 'estimate', litres: 64.583, anchorL: 100, flownMin: 85, flights: 2, addedL: 0, burntL: 35.417, lph: 25, overflowL: 0 },
			readOn: '2026-10-06',
			flightDate: '2026-10-06',
			stale: false,
			...over,
		});

	it('an estimate, its day and the check', () => {
		i18n.locale = 'en';
		expect(fuelText(words, reading())).toEqual({
			text: `LFPL: about 64.6 L on board (journey log read on 6${NB}Oct). Check the fuel in the tanks before flight.`,
			ink: 'muted',
		});
	});

	it('read another day, or adding more than fits: the caution ink', () => {
		i18n.locale = 'en';
		const stale = fuelText(words, reading({ stale: true, flightDate: '2026-10-07' }));
		expect(stale.ink).toBe('warn');
		expect(stale.text).toContain(`Not read on the flight’s day (7${NB}Oct)`);
		const over = fuelText(
			words,
			reading({
				reading: { kind: 'estimate', litres: 75, anchorL: 100, flownMin: 90, flights: 2, addedL: 15, burntL: 37.5, lph: 25, overflowL: 2.5 },
			}),
		);
		expect(over.ink).toBe('warn');
		expect(over.text).toContain('The journey log adds 2.5 L more than the tanks hold.');
	});

	it('measured, incomplete, another aircraft, a refuel missing', () => {
		i18n.locale = 'en';
		expect(fuelText(words, reading({ reading: { kind: 'measured', litres: 52 } })).text).toBe(
			`LFPL: 52.0 L on board (measured on 6${NB}Oct). Check the fuel in the tanks before flight.`,
		);
		expect(fuelText(words, reading({ reading: { kind: 'unresolved', reason: 'noAnchor' } }))).toMatchObject({
			ink: 'warn',
		});
		const other = fuelText(words, reading({ reading: { kind: 'otherAircraft', aircraft: 'F-GKQC' } }));
		expect(other.ink).toBe('warn');
		expect(other.text).toContain('read for F-GKQC');
		const missing = fuelText(
			words,
			reading({ reading: { kind: 'impossible', anchorL: 20, flownMin: 60, addedL: 0, burntL: 25, lph: 25 } }),
		);
		expect(missing.ink).toBe('danger');
		expect(missing.text).toContain('a refuel is missing from it');
	});

	it('no refuel over nothing read; more aboard than the limits allow', () => {
		i18n.locale = 'en';
		expect(fuelText(words, { kind: 'aboardUnknown', trip: 0 })).toEqual({
			text: 'LFPL: no refuel, and the fuel on board is not known: the fuel at takeoff is unknown.',
			ink: 'danger',
		});
		expect(fuelText(words, { kind: 'aboveMaxAboard', trip: 0, aboardL: 80, maxL: 69 })).toEqual({
			text: 'LFPL: about 80.0 L already on board, above the 69 L the limits allow there: defuel or lighten the load.',
			ink: 'warn',
		});
	});

	it('the departure\'s window reads its uplift over what is on board', () => {
		i18n.locale = 'en';
		const line = {
			kind: 'window' as const,
			trip: 0,
			access: null,
			window: {
				chainIndex: 0,
				state: 'open' as const,
				neededL: 63,
				maxL: 100,
				limitedBy: 'usable' as const,
				bindingTrip: null,
				limitsChecked: true,
				beyondTank: false,
				carriedL: 40,
				uplift: { lo: 23, hi: 60 },
				planUpliftL: 23,
			},
		};
		expect(windowLineText(words, line)).toBe(
			'LFPL: take off with 63 to 100 L (about +23 to +60 L AVGAS 100LL). Your plan: +23 L.',
		);
	});

	it('words it the same way in French', () => {
		i18n.locale = 'fr';
		expect(fuelText(words, reading()).text).toBe(
			`LFPL\u202f: environ 64.6 L à bord (carnet de route relevé le 6${NB}oct.). Vérifiez le carburant dans les réservoirs avant le vol.`,
		);
		expect(fuelText(words, { kind: 'aboardUnknown', trip: 0 }).text).toContain('pas d’avitaillement');
		expect(fuelText(words, { kind: 'aboveMaxAboard', trip: 0, aboardL: 80, maxL: 69 }).text).toContain(
			'retirez du carburant',
		);
		i18n.locale = 'en';
	});
});
