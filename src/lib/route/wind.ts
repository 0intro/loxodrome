/* Wind triangle for a route leg: given a true course, true airspeed and the wind
 * (direction it blows FROM, true; speed), solve the wind correction angle and the
 * ground speed. Pure; the nav-log modal derives MH and ETE/W from it. */

const DEG = Math.PI / 180;

export interface WindSolution {
	/** Wind correction angle, degrees (true heading = true course + wcaDeg). */
	wcaDeg: number;
	/** Ground speed, knots (always > 0 when non-null). */
	gsKt: number;
}

/** Solve the wind triangle for one leg. `windDirDeg` is the direction the wind
 *  blows FROM (degrees true), matched to a true `trackTrueDeg`; speeds in knots.
 *  Returns null when the wind is too strong to hold the course (|sin WCA| > 1) or
 *  leaves no forward ground speed (GS <= 0, i.e. a headwind at or above the
 *  airspeed), or when the airspeed is non-positive. Calm (windSpeedKt = 0) gives
 *  wcaDeg 0 and gsKt = tasKt. */
export function windTriangle(
	trackTrueDeg: number,
	tasKt: number,
	windDirDeg: number,
	windSpeedKt: number,
): WindSolution | null {
	if (!(tasKt > 0)) {
		return null;
	}
	const ang = (windDirDeg - trackTrueDeg) * DEG;
	const swc = (windSpeedKt / tasKt) * Math.sin(ang);
	if (Math.abs(swc) > 1) {
		return null; // wind too strong to hold the course
	}
	const wca = Math.asin(swc);
	const gs = tasKt * Math.cos(wca) - windSpeedKt * Math.cos(ang);
	if (!(gs > 0)) {
		return null; // headwind at or above the airspeed; no forward progress
	}
	return { wcaDeg: wca / DEG, gsKt: gs };
}
