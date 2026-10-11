/* The en-route one-engine check (route/oeiCeiling.ts) on the generic
 * PA-34-200 Seneca: each leg's MSA against the net ceiling at a mass, in the
 * standard atmosphere or the forecast's air at the leg's level (its
 * deviation from ISA carried through the column, its QNH's offset kept), a
 * hot day lowering it, a cold one raising it. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { isaTempC } from '$lib/weather/openMeteo';
import { legAirAt, oeiLegCheck, oeiLegChecks, shownCeilingFt, type LegAir } from '$lib/route/oeiCeiling';

const seneca = parseAircraftYaml(readFileSync('public/data/aircraft/generic/pa34-200.yaml', 'utf-8'));
const oei = seneca.oneEngineInoperative!;
const MTOM = 1905.08;

/** The forecast's air at a level: `paFt` its pressure altitude, its
 *  temperature `dev` off the forecast's own ISA. */
function air(altitudeFt: number, paFt: number, dev: number): LegAir {
	return { altitudeFt, tempC: isaTempC(paFt) + dev, isaDevC: dev };
}

describe('the air over a leg', () => {
	it('is the standard atmosphere without a forecast', () => {
		const at = legAirAt(null);
		expect(at(0)).toEqual({ pressureAltFt: 0, temperatureC: 15 });
		expect(at(5000).temperatureC).toBeCloseTo(5, 6);
	});

	it('carries the forecast deviation through the column and keeps its QNH offset', () => {
		// Read at 5000 ft where the pressure altitude is 4700 ft (a high QNH),
		// ISA +10.
		const at = legAirAt(air(5000, 4700, 10));
		expect(at(5000).pressureAltFt).toBeCloseTo(4700, 0);
		expect(at(5000).temperatureC).toBeCloseTo(isaTempC(4700) + 10, 6);
		// 5000 ft lower, the air is 10 degrees warmer at the app's lapse.
		expect(at(0).pressureAltFt).toBeCloseTo(-300, 0);
		expect(at(0).temperatureC - at(5000).temperatureC).toBeCloseTo(10, 6);
	});
});

describe('a leg against its MSA', () => {
	it('holds under the net ceiling and flags above it (4200 lb, ISA)', () => {
		const low = oeiLegCheck(oei, MTOM, 3000, null)!;
		expect(low.ceiling.kind).toBe('ceiling');
		// The manual's 50 ft/min service ceiling at 4200 lb is 3650 ft.
		expect(low.ceiling.altFt).toBeGreaterThan(3550);
		expect(low.ceiling.altFt).toBeLessThan(3700);
		expect(low.below).toBe(false);
		expect(low.isaDevC).toBeNull();
		expect(shownCeilingFt(low.ceiling.altFt)).toBe(3600);
		const high = oeiLegCheck(oei, MTOM, 4000, null)!;
		expect(high.below).toBe(true);
	});

	it('lowers the ceiling on a hot day and raises it on a cold one', () => {
		const std = oeiLegCheck(oei, MTOM, 3000, air(3000, 3000, 0))!;
		const hot = oeiLegCheck(oei, MTOM, 3000, air(3000, 3000, 15))!;
		const cold = oeiLegCheck(oei, MTOM, 3000, air(3000, 3000, -15))!;
		expect(hot.ceiling.altFt).toBeLessThan(std.ceiling.altFt - 500);
		expect(hot.below).toBe(true);
		expect(hot.isaDevC).toBe(15);
		expect(cold.ceiling.altFt).toBeGreaterThan(std.ceiling.altFt + 500);
		expect(cold.below).toBe(false);
	});

	it('reads the ceiling above the sea, the pressure altitude offset kept', () => {
		const std = oeiLegCheck(oei, MTOM, 3000, air(5000, 5000, 0))!;
		const highQnh = oeiLegCheck(oei, MTOM, 3000, air(5000, 4700, 0))!;
		expect(highQnh.ceiling.altFt - std.ceiling.altFt).toBeCloseTo(300, -1);
	});

	it('says no net climb at all when even the sea level fails', () => {
		// ISA +40, past the table's hottest column (extrapolated): about
		// 4800 ft of density altitude at sea level, where the 4200 lb climb
		// is under the 0.5 % margin (ISA +30 still holds there, barely).
		const c = oeiLegCheck(oei, MTOM, 500, air(1000, 1000, 40))!;
		expect(c.ceiling.kind).toBe('below');
		expect(c.below).toBe(true);
	});

	it('judges a lighter twin higher, and nothing without an MSA or a climb table', () => {
		const light = oeiLegCheck(oei, 1542.22, 9000, null)!;
		expect(light.ceiling.altFt).toBeGreaterThan(9500);
		expect(light.below).toBe(false);
		expect(oeiLegCheck(oei, MTOM, null, null)).toBeNull();
		expect(oeiLegCheck({ ...oei, climb: undefined }, MTOM, 3000, null)).toBeNull();
	});

	it('checks every leg with its own air', () => {
		const legs = oeiLegChecks(oei, MTOM, [3000, null, 3000], [null, null, air(3000, 3000, 15)]);
		expect(legs.map((l) => l?.below ?? null)).toEqual([false, null, true]);
	});
});
