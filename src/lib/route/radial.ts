/* Pure VOR radial (QDM / QDR) computation for the nav log.
 *
 * QDM / QDR are the leg's magnetic course expressed against a VOR, so they MATCH
 * the nav-log MC column exactly: the QDM (magnetic bearing TO the station) on a
 * leg arriving at a VOR is that leg's magnetic course, and the QDR (magnetic
 * bearing FROM the station, the radial) on a leg leaving a VOR is that leg's
 * magnetic course. Both use the same reference as the MC column: the great-circle
 * initial true track made magnetic at the leg's mid-point (WMM via
 * magneticFromTrue). Q-codes per ICAO Doc 8400; QDR = QDM +/- 180.
 *
 * (Referencing the bearing to the variation at the VOR instead would shift it by
 * the declination gradient across the leg, ~0.1 deg, enough to round to a
 * different whole degree than the MC column; not worth the mismatch, and well
 * inside the calibration-epoch caveat below.)
 *
 * Caveat: a published chart radial is aligned to the station's variation at its
 * last calibration epoch, which the current WMM may differ from by a degree or
 * so; no per-station variation is modelled (the navaid dataset carries none).
 *
 * Pure: no Svelte, no I/O, unit-testable in Node (mirrors navlog.ts). */

import { equirectangularDistanceM, initialBearingDeg } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { magneticFromTrue } from '$lib/route/magnetic';
import { fmtTrack } from '$lib/route/format';
import { formatFreqMHz } from '$lib/format/radio';
import { NAVAID_LABELS, type Navaid, type NavaidType } from '$lib/data/navaids';

/** The VOR family: the navaid types that radiate usable magnetic radials.
 *  Excludes NDB (no VOR-style radials), DME / TACAN (no bearing), ILS / LOC,
 *  and the RNAV waypoint pseudo-types. */
export function isVor(type: NavaidType): boolean {
	return type === 'VOR' || type === 'VOR-DME' || type === 'VORTAC';
}

/** Anything with coordinates: a Waypoint, a Navaid, or a bare point. */
export interface LatLonPoint {
	lat: number;
	lon: number;
}

function coincident(a: LatLonPoint, b: LatLonPoint): boolean {
	return Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lon - b.lon) < 1e-9;
}

/** A leg's magnetic course, identical to the nav-log MC column: the great-circle
 *  initial true track from a to b, made magnetic at the leg's mid-point. */
export function legMagneticCourse(a: LatLonPoint, b: LatLonPoint, timeYears: number): number {
	const trueTrack = initialBearingDeg(a.lat, a.lon, b.lat, b.lon);
	return magneticFromTrue(trueTrack, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2, timeYears);
}

/** "On field" radius for an airport waypoint's VOR: a VOR-family navaid within
 *  this distance of the airport position counts as the field's own station. 3 NM,
 *  not 2, because a large platform can put the navaid well away from the reference
 *  point the waypoint anchors to (VOR-DME CAV sits 2.39 NM from the LFOK ARP, at
 *  the west end of the Vatry platform), while 3 stays tight enough not to claim a
 *  neighbouring off-field VOR. */
export const ON_FIELD_VOR_RADIUS_NM = 3;

/** Nearest VOR-family navaid within `radiusNM` of (lat, lon), or null. Linear
 *  scan over `vors`, which MUST already be filtered to isVor; O(n) is fine for a
 *  few waypoints over a few thousand navaids. Equirectangular distance. */
export function nearestVor(
	lat: number,
	lon: number,
	vors: readonly Navaid[],
	radiusNM: number,
): Navaid | null {
	const radiusM = radiusNM * NM_TO_METERS;
	let best: Navaid | null = null;
	let bestM = Infinity;
	for (const n of vors) {
		const d = equirectangularDistanceM(lat, lon, n.lat, n.lon);
		if (d > radiusM) {
			continue;
		}
		if (d < bestM) {
			bestM = d;
			best = n;
		}
	}
	return best;
}

/** Station label for the radial line: type, ident, and 3-decimal frequency,
 *  e.g. "VOR/DME MLN 113.600". The frequency token is dropped when empty. */
export function radialStationLabel(n: Navaid): string {
	const head = `${NAVAID_LABELS[n.type]} ${n.ident}`;
	const freq = n.freq ? formatFreqMHz(n.freq) : '';
	return freq ? `${head} ${freq}` : head;
}

/** One VOR reference shown on a waypoint's row: a station label and a single
 *  Q-code bearing. */
export interface RadialEntry {
	/** "VOR/DME MLN 113.600" */
	stationLine: string;
	/** "QDR 070°" or "QDM 146°" */
	bearingLine: string;
	/** The station's Navaid.id, so a nav-log row can flash it on the map. */
	navaidId: string;
}

/** The radial entries for a waypoint's row, describing the leg LEAVING it. Both
 *  the QDR and the QDM equal that leg's magnetic course (see legMagneticCourse),
 *  so they match the nav-log MC column:
 *  - a QDR when this waypoint is (or is on field of) a VOR: the radial leaving
 *    that VOR; it sits on the VOR itself.
 *  - a QDM when the NEXT waypoint is (or is on field of) a VOR: the course to it;
 *    it sits here, on the previous fix (where you start tracking to it), not on
 *    the VOR.
 *  `ownVor` / `nextVor` are the resolved VOR for this and the next waypoint (null
 *  when none). Empty at the last fix or a zero-length leg. When the next fix
 *  resolves to the same VOR as this one, the QDM is dropped, so one station never
 *  shows both a QDM and a QDR. */
export function waypointRadialEntries(
	wp: LatLonPoint,
	ownVor: Navaid | null,
	nextWp: LatLonPoint | null,
	nextVor: Navaid | null,
	timeYears: number,
): RadialEntry[] {
	const entries: RadialEntry[] = [];
	if (!nextWp || (!ownVor && !nextVor) || coincident(wp, nextWp)) {
		return entries;
	}
	const course = fmtTrack(legMagneticCourse(wp, nextWp, timeYears));
	if (ownVor) {
		entries.push({
			stationLine: radialStationLabel(ownVor),
			bearingLine: `QDR ${course}`,
			navaidId: ownVor.id,
		});
	}
	if (nextVor && nextVor.id !== ownVor?.id) {
		entries.push({
			stationLine: radialStationLabel(nextVor),
			bearingLine: `QDM ${course}`,
			navaidId: nextVor.id,
		});
	}
	return entries;
}
