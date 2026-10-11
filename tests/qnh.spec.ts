/* An aerodrome's forecast QNH and temperature from a model's surface fields
 * (src/lib/weather/qnh.ts): the station pressure reduced through the ICAO
 * standard atmosphere, rounded down as a report rounds it, and the 2 m
 * temperature carried to the field at the standard lapse rate. */

import { describe, expect, it } from 'vitest';
import { qnhFromStationPressure, reportedQnh, temperatureAtElevation } from '$lib/weather/qnh';

describe('the forecast QNH', () => {
	it('is the station pressure at sea level', () => {
		expect(qnhFromStationPressure(1013.25, 0)).toBeCloseTo(1013.25, 6);
	});

	it('reads the ISA back: the standard pressure at an elevation is QNH 1013.25', () => {
		// ISA at 1 000 m: 898.75 hPa.
		expect(qnhFromStationPressure(898.746, 1000)).toBeCloseTo(1013.25, 1);
		// ISA at 110.8 m, about 13 hPa above sea level.
		expect(qnhFromStationPressure(1000, 110.8)).toBeCloseTo(1013.2, 1);
	});

	it('is what Lognes reads off AROME on 2026-10-06 (996.4 hPa at its 102 m ground)', () => {
		const q = qnhFromStationPressure(996.4, 102);
		expect(q).toBeCloseTo(1008.5, 1);
		expect(reportedQnh(q)).toBe(1008);
	});

	it('rounds down like a METAR, never up', () => {
		expect(reportedQnh(995.6)).toBe(995);
		expect(reportedQnh(1013.99)).toBe(1013);
		expect(reportedQnh(1014)).toBe(1014);
	});
});

describe('the forecast temperature', () => {
	it('warms 6.5 degrees per kilometre down from the model ground to the field', () => {
		expect(temperatureAtElevation(10, 500, 100)).toBeCloseTo(12.6, 6);
		expect(temperatureAtElevation(10, 100, 500)).toBeCloseTo(7.4, 6);
		expect(temperatureAtElevation(10, 300, 300)).toBe(10);
	});
});
