/* An aerodrome's QNH and temperature from a model's surface fields (the
 * performance page's forecast conditions, runwayPerf.ts). Pure.
 *
 * QNH is the altimeter setting at which an altimeter on the ground reads the
 * elevation, which is the station pressure reduced to mean sea level through
 * the ICAO STANDARD atmosphere (ICAO Doc 7488): not the model's own
 * mean-sea-level pressure, which is reduced through the model's temperatures
 * and drifts from QNH by a few hPa over a cold or a hot field. Reduced from
 * the model's own ground, it is the setting at that grid point; the ISA
 * carries it to the field's elevation unchanged, the carry up and the
 * reduction down being one formula, so it is the field's QNH too.
 *
 * The ground is the one under the HOUR (aerodromeForecast's modelElevationM,
 * our service's hourly `elevation`): a chain answers each hour from one
 * model while its column states the first one's ground, and reduced from
 * another model's ground the QNH is off by 0.12 hPa a metre, 30 hPa at
 * Courchevel where AROME's ground and ARPEGE's lie 250 m apart. */

/** ICAO standard atmosphere: sea-level temperature (K), lapse rate (K/m),
 *  and the exponent g / (R L) of the troposphere's pressure law. */
const T0_K = 288.15;
const LAPSE_K_PER_M = 0.0065;
const EXPONENT = 9.80665 / (287.05287 * LAPSE_K_PER_M);

/** The ICAO standard atmosphere's sea-level pressure (hPa). */
const P0_HPA = 1013.25;

/** The pressure altitude (ft) of a pressure (hPa): where that pressure lies
 *  in the ICAO standard atmosphere's troposphere (Doc 7488), what an
 *  altimeter set to 1013.25 hPa reads there. The ISA deviation is measured
 *  against the standard temperature at THIS altitude, never at a height
 *  above the sea. */
export function isaPressureAltFt(pressureHpa: number): number {
	return ((T0_K / LAPSE_K_PER_M) * (1 - (pressureHpa / P0_HPA) ** (1 / EXPONENT))) / 0.3048;
}

/** The QNH (hPa) of a station pressure measured at an elevation (m). */
export function qnhFromStationPressure(pressureHpa: number, elevationM: number): number {
	return pressureHpa * (1 - (LAPSE_K_PER_M * elevationM) / T0_K) ** -EXPONENT;
}

/** A QNH as a report states it: rounded DOWN to the whole hectopascal, the
 *  METAR rule of ICAO Annex 3 (restated in States' AIP ENR 1.7, Hungary's:
 *  "QNH 995.6 hPa is given as QNH 995"), the side that never understates a
 *  pressure altitude. */
export function reportedQnh(qnhHpa: number): number {
	return Math.floor(qnhHpa);
}

/** A 2 m temperature carried from the model's ground to the field's
 *  elevation at the standard lapse rate (6.5 °C per kilometre): an IFS grid
 *  point stands hundreds of metres off an aerodrome in hilly country. */
export function temperatureAtElevation(tempC: number, modelElevationM: number, fieldElevationM: number): number {
	return tempC + LAPSE_K_PER_M * (modelElevationM - fieldElevationM);
}
