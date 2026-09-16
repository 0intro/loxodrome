/* NOAA sunrise / sunset.
 *
 * Self-contained port of the NOAA Global Monitoring Division sunrise/sunset
 * equations (the NOAA Solar Calculator spreadsheet routine, after Meeus,
 * Astronomical Algorithms ch. 25): the events are the hour angle at zenith
 * 90.833 deg (90 deg + 34' standard refraction + 16' solar semidiameter)
 * on either side of solar noon. Three fixed-point iterations from a
 * 12:00 UTC seed (recomputing the solar position at each estimate) converge
 * well under a second; accuracy is well within a minute at temperate
 * latitudes.
 *
 * Used by the flight-dossier overview page's "Sunrise" / "Sunset" rows and
 * the derived day/night final-reserve default, from each trip endpoint's
 * coordinates and the selected flight date. Validated against the
 * workbook's CSA() values in tests/sun.spec.ts. Pure; no I/O. */

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** cos of the event zenith (90.833 deg), i.e. sin of the -0.833 deg sun altitude. */
const COS_ZENITH = Math.cos(90.833 * DEG2RAD);
/** Civil twilight: the sun 6 degrees below the horizon (EASA Part-DEF
 *  'night' runs from the end of evening to the beginning of morning civil
 *  twilight). */
const COS_CIVIL_ZENITH = Math.cos(96 * DEG2RAD);

export type SunEvent =
	| { kind: 'time'; minutesUtc: number }
	| { kind: 'polar-day' }
	| { kind: 'polar-night' };

export interface SunTimes {
	sunrise: SunEvent;
	sunset: SunEvent;
}

/** Sunrise and sunset at (lat, lon) on the UTC civil date 'YYYY-MM-DD'.
 *  `minutesUtc` is minutes after 00:00 UTC of that date, deliberately not
 *  normalized (an extreme longitude can push it past the day boundary;
 *  display wraps). 'polar-day' = the sun never sets, 'polar-night' = it
 *  never rises (both events agree). Null on a malformed date or non-finite
 *  / out-of-range coordinates. */
export function sunTimesUtc(latDeg: number, lonDeg: number, isoDate: string): SunTimes | null {
	return horizonTimesUtc(latDeg, lonDeg, isoDate, COS_ZENITH);
}

/** Civil dawn and dusk at (lat, lon) on the UTC civil date, the same NOAA
 *  machinery at the 96-degree zenith: `sunrise` is the beginning of morning
 *  civil twilight, `sunset` the end of the evening one. At this zenith
 *  'polar-day' means the sun never dips 6 degrees below the horizon
 *  (continuous civil day, never night) and 'polar-night' that it never
 *  climbs above that depression (continuous night). */
export function civilTwilightUtc(latDeg: number, lonDeg: number, isoDate: string): SunTimes | null {
	return horizonTimesUtc(latDeg, lonDeg, isoDate, COS_CIVIL_ZENITH);
}

/** True when the instant `atMs` (epoch ms UTC) falls in EASA night at
 *  (lat, lon): past the end of evening civil twilight or before the start
 *  of the morning one, on the instant's own UTC civil date. Polar kinds
 *  resolve directly (continuous civil day = never night, and conversely);
 *  minutes compare wrap-safe, since `minutesUtc` is deliberately not
 *  normalized. False on unresolvable input: an unknowable night must not
 *  dim a cockpit display. */
export function isCivilNightUtc(latDeg: number, lonDeg: number, atMs: number): boolean {
	if (!Number.isFinite(atMs)) {
		return false;
	}
	const iso = new Date(atMs).toISOString().slice(0, 10);
	const t = civilTwilightUtc(latDeg, lonDeg, iso);
	if (!t) {
		return false;
	}
	if (t.sunrise.kind === 'polar-day' || t.sunset.kind === 'polar-day') {
		return false;
	}
	if (t.sunrise.kind === 'polar-night' || t.sunset.kind === 'polar-night') {
		return true;
	}
	const dayStartMs = Date.parse(iso + 'T00:00:00Z');
	const nowMin = (atMs - dayStartMs) / 60_000;
	const wrap = (m: number): number => ((m % 1440) + 1440) % 1440;
	const now = wrap(nowMin);
	const dawn = wrap(t.sunrise.minutesUtc);
	const dusk = wrap(t.sunset.minutesUtc);
	// Daylight spans [dawn, dusk], possibly wrapping midnight UTC at an
	// extreme longitude; night is its complement.
	const day = dawn <= dusk ? now >= dawn && now < dusk : now >= dawn || now < dusk;
	return !day;
}

/** Aeronautical-night margin around sunrise/sunset, minutes, per the French
 *  prescription under the [97 SERA] "Nuit" definition (arrêté du 11.12.2014
 *  relatif à la mise en œuvre de SERA, Annexe I): between 30 and 60 degrees
 *  of latitude night begins 30 min after sunset and ends 30 min before
 *  sunrise; at latitudes at or below 30 degrees the margin is 15 min. Above
 *  60 degrees the margin model does not apply: callers use the
 *  civil-twilight definition there (the EASA Part-DEF base), and this
 *  margin only backs the fuel rule's fallback when no twilight column is
 *  supplied. Unknown latitude (null) keeps the temperate 30 min. */
export function nightMarginMin(latDeg: number | null): number {
	return latDeg != null && Math.abs(latDeg) <= 30 ? 15 : 30;
}

/** The margin model's latitude ceiling: above it the sunset-margin
 *  approximation breaks down toward the polar summer and the civil-twilight
 *  definition takes over (the timelineAtNight composition). */
const AERO_NIGHT_MARGIN_MAX_LAT = 60;

/** True when the instant falls in AERONAUTICAL night at (lat, lon): the
 *  period FCL.010 / Part-DEF defer to the appropriate authority, which for
 *  France is sunset + margin to sunrise - margin (`nightMarginMin`; the
 *  arrêté du 11.12.2014), switching to the EASA civil-twilight base above
 *  60 degrees: the exact per-instant composition of the fuel rule's
 *  per-aerodrome timelineAtNight. The logbook's night time and
 *  night-landing counting (FCL.060(b)(2)) read THIS; the night-dim trigger
 *  keeps isCivilNightUtc, a display comfort rather than a licensing figure.
 *  False on unresolvable input. */
export function isAeroNightUtc(latDeg: number, lonDeg: number, atMs: number): boolean {
	if (!Number.isFinite(atMs)) {
		return false;
	}
	if (Math.abs(latDeg) > AERO_NIGHT_MARGIN_MAX_LAT) {
		return isCivilNightUtc(latDeg, lonDeg, atMs);
	}
	const iso = new Date(atMs).toISOString().slice(0, 10);
	const s = sunTimesUtc(latDeg, lonDeg, iso);
	if (!s) {
		return false;
	}
	if (s.sunrise.kind === 'polar-day' || s.sunset.kind === 'polar-day') {
		return false;
	}
	if (s.sunrise.kind === 'polar-night' || s.sunset.kind === 'polar-night') {
		return true;
	}
	const margin = nightMarginMin(latDeg);
	const dayStartMs = Date.parse(iso + 'T00:00:00Z');
	const wrap = (m: number): number => ((m % 1440) + 1440) % 1440;
	const now = wrap((atMs - dayStartMs) / 60_000);
	const dawn = wrap(s.sunrise.minutesUtc - margin);
	const dusk = wrap(s.sunset.minutesUtc + margin);
	// Daylight (with the margins folded in) spans [dawn, dusk], possibly
	// wrapping midnight UTC at an extreme longitude; night is its complement.
	const day = dawn <= dusk ? now >= dawn && now < dusk : now >= dawn || now < dusk;
	return !day;
}

function horizonTimesUtc(
	latDeg: number,
	lonDeg: number,
	isoDate: string,
	cosZenith: number,
): SunTimes | null {
	if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90) {
		return null;
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
		return null;
	}
	const epochMs = Date.parse(isoDate + 'T00:00:00Z');
	if (!Number.isFinite(epochMs)) {
		return null;
	}
	const jd0 = epochMs / 86400000 + 2440587.5;
	return {
		sunrise: sunEvent(jd0, latDeg, lonDeg, -1, cosZenith),
		sunset: sunEvent(jd0, latDeg, lonDeg, 1, cosZenith),
	};
}

/** One crossing of the given zenith (cosine): solar noon + dir * hour angle
 *  (dir -1 sunrise/dawn, +1 sunset/dusk), iterated to a fixed point. */
function sunEvent(
	jd0: number,
	latDeg: number,
	lonDeg: number,
	dir: -1 | 1,
	cosZenith: number,
): SunEvent {
	let minutes = 720;
	for (let i = 0; i < 3; i++) {
		const sun = solarPosition(jd0 + minutes / 1440);
		const cosH =
			(cosZenith - Math.sin(latDeg * DEG2RAD) * Math.sin(sun.declRad)) /
			(Math.cos(latDeg * DEG2RAD) * Math.cos(sun.declRad));
		if (cosH < -1) {
			return { kind: 'polar-day' };
		}
		if (cosH > 1) {
			return { kind: 'polar-night' };
		}
		const haDeg = Math.acos(cosH) * RAD2DEG;
		minutes = 720 - 4 * lonDeg - sun.eotMin + dir * 4 * haDeg;
	}
	return { kind: 'time', minutesUtc: minutes };
}

/** Apparent declination and equation of time at a Julian date (Meeus ch. 25,
 *  low-accuracy series: geometric mean longitude + equation of center, with
 *  the nutation/aberration correction on the apparent longitude). */
function solarPosition(jd: number): { declRad: number; eotMin: number } {
	const T = (jd - 2451545) / 36525;
	const L0 = norm360(280.46646 + T * (36000.76983 + 0.0003032 * T));
	const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
	const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
	const Mr = M * DEG2RAD;
	const C =
		Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
		Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
		Math.sin(3 * Mr) * 0.000289;
	const omega = (125.04 - 1934.136 * T) * DEG2RAD;
	const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * DEG2RAD;
	const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
	const eps = (eps0 + 0.00256 * Math.cos(omega)) * DEG2RAD;
	const declRad = Math.asin(Math.sin(eps) * Math.sin(lambda));
	const y = Math.tan(eps / 2) ** 2;
	const L0r = L0 * DEG2RAD;
	const eotMin =
		4 *
		RAD2DEG *
		(y * Math.sin(2 * L0r) -
			2 * e * Math.sin(Mr) +
			4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
			0.5 * y * y * Math.sin(4 * L0r) -
			1.25 * e * e * Math.sin(2 * Mr));
	return { declRad, eotMin };
}

function norm360(deg: number): number {
	return ((deg % 360) + 360) % 360;
}
