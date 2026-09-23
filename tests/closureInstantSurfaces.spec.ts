/* WHICH instant each NOTAM-state surface judges at, pinned where the call is
 * made (source pins, the popupMenu.spec idiom: the components need a DOM, and
 * a changed argument keeps every resolver spec green). The resolvers' own
 * defaults are pinned behaviourally in closureInstant.spec; these are the
 * surfaces that pass an instant of their own, or that read a default a
 * mutation could quietly widen to the briefing window, whose look-ahead is
 * unbounded by default and would take next month's change for today's.
 *
 * - about the PLANNED FLIGHT (plannedFlightAt()): the performance page's
 *   runways and field, the fuel plan's grades, the saved nav log's
 *   frequencies;
 * - at the POSE's instant (the band's): the live contact chain's departure
 *   and destination, the overflown aerodrome;
 * - at the drawn instant (drawnStateAt()): the fuel panel's default, the
 *   closed-sector overlay;
 * - scoped by notamPublisher over the A) locations too: the by-name and
 *   citation links, whose Antilles NOTAMs ride Q) TTZP. */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\s+/g, ' ');

describe('the planned flight', () => {
	it('is what the performance page judges runways and the field over', () => {
		const src = read('src/lib/components/flightprep/PerformancePage.svelte');
		expect(src).toContain('resolveAerodromeRunways(airport, plannedFlightAt())');
		expect(src).toContain('resolveAerodromeState(airport, plannedFlightAt())');
	});

	it('is what the fuel plan reads the grades over', () => {
		expect(read('src/lib/components/flightprep/FuelPlanPage.svelte')).toContain(
			"resolveAerodromeFuel(icao, 'fr', plannedFlightAt())",
		);
	});

	it("is what the saved nav log's frequencies are resolved over", () => {
		expect(read('src/lib/route/navlogExport.ts')).toContain('resolveAirportRadios(ap, plannedFlightAt())');
	});
});

describe("the pose's instant", () => {
	it('is what the live contact chain reads its two aerodromes at', () => {
		const src = read('src/lib/state/navLive.svelte.ts');
		expect(src).toContain('departure: aerodromeUnit(route.waypoints[0], { fromMs: tMs, toMs: tMs })');
		expect(src).toMatch(/destination: aerodromeUnit\(route\.waypoints\[route\.waypoints\.length - 1\], \{ fromMs: tMs, toMs: tMs,? \}/);
	});

	it('is what the overflown aerodrome is read at', () => {
		expect(read('src/lib/state/navOverflight.svelte.ts')).toContain(
			'airportContactUnit(hit.airport, { fromMs: nav.playheadMs, toMs: nav.playheadMs })',
		);
	});
});

describe('the drawn instant', () => {
	it("is the fuel panel's default", () => {
		expect(read('src/lib/state/fuelOverride.svelte.ts')).toMatch(
			/function defaultAt\(\): ResolveAt \{ return drawnStateAt\(\); \}/,
		);
	});

	it('is what the closed-sector overlay judges at', () => {
		const src = read('src/lib/state/freqOverride.svelte.ts');
		const fn = src.slice(src.indexOf('export function closedAirspaceLinks('));
		expect(fn.slice(0, 400)).toContain('const at = drawnStateAt();');
	});
});

describe('the publisher a NOTAM links under', () => {
	it('reads the A) locations too, by name and by citation', () => {
		const src = read('src/lib/state/notamLinks.svelte.ts');
		expect(src).toContain('notamPublisher(notam.qualifier.fir, notam.icaoCodes)');
		expect(src).toContain("extractCitedDesignators( notam.fullContent, notam.qualifier?.fir ?? '', notam.icaoCodes, )");
	});
});
