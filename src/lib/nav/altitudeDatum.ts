/* Which vertical datum a device's GNSS altitude is on, and the conversion to
 * the one the rest of the application speaks.
 *
 * The W3C Geolocation API defines `coords.altitude` as a height above the
 * WGS84 ELLIPSOID, and Android and the desktop browsers report it that way.
 * Apple platforms do not: `CLLocation.altitude` is documented as an altitude
 * above MEAN SEA LEVEL (the ellipsoidal figure is a separate property added
 * later), and every browser on macOS, iOS and iPadOS goes through Core
 * Location, so it is the operating system that decides, not the browser. Over
 * metropolitan France the two differ by 145 to 167 ft, which is the whole
 * point: an application that corrects blindly makes the most likely mounted
 * device, an iPhone, wrong by that much in the other direction.
 *
 * So the datum is resolved rather than assumed, and the resolution is
 * VISIBLE: the readout names the datum in force and the separation applied,
 * which a pilot can check on the ground against the field elevation.
 *
 * The tri-state preference mirrors the LangPref idiom in i18n/locale.ts:
 * 'auto' follows the platform, the other two pin it. Pure, no Svelte, no DOM
 * (detection lives in ui/platform.ts); tests/navAltitudeDatum.spec.ts. */

import { geoidHeightFt } from './geoid';

/** What a device's reported GNSS altitude is measured from. */
export type AltDatum = 'ellipsoid' | 'msl';

/** The user's choice; 'auto' defers to the platform default. */
export type AltDatumPref = 'auto' | AltDatum;

/** Resolve the preference against the platform's own answer. */
export function resolveAltDatum(pref: AltDatumPref, platform: AltDatum): AltDatum {
	return pref === 'auto' ? platform : pref;
}

/** The correction (ft) applied to a reported altitude to reach MSL: the
 *  negated geoid undulation on an ellipsoidal device, zero on one already
 *  reporting MSL. Sign is the one to ADD to the reported value. */
export function altCorrectionFt(lat: number, lon: number, datum: AltDatum): number {
	return datum === 'ellipsoid' ? -geoidHeightFt(lat, lon) : 0;
}

/** A reported GNSS altitude (ft) referenced to mean sea level, so it can be
 *  compared with a chart, an airspace limit or a field elevation. Null in,
 *  null out: a device that reports no altitude gets no invented one. */
export function mslAltFt(
	altFt: number | null | undefined,
	lat: number,
	lon: number,
	datum: AltDatum,
): number | null {
	if (altFt == null || !Number.isFinite(altFt)) {
		return null;
	}
	return altFt + altCorrectionFt(lat, lon, datum);
}

/** A reported GNSS altitude (ft) referenced to the WGS84 ELLIPSOID, which is
 *  what an IGC B record's GNSS altitude column is defined on (FAI/IGC
 *  Technical Specification A4.1.3, "Altitude in metres above the WGS84
 *  ellipsoid"); docs/trace-files.md. The mirror of mslAltFt, and NOT the
 *  negated altCorrectionFt: the correction is zero on whichever datum the
 *  device already reports, so each direction has its own zero case. */
export function ellipsoidAltFt(
	altFt: number | null | undefined,
	lat: number,
	lon: number,
	datum: AltDatum,
): number | null {
	if (altFt == null || !Number.isFinite(altFt)) {
		return null;
	}
	return altFt + (datum === 'msl' ? geoidHeightFt(lat, lon) : 0);
}
