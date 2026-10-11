import { destinationPoint } from './geometry';
import { NM_TO_METERS } from './units';
import type { LatLon, NotamCoordinate } from './types';

/** Lateral width, in metres, drawn for an aerobatic display corridor whose
 *  source publishes only an axis and a length: the box is rendered as a thin
 *  fixed-width band centred on the axis; see parseNotams. A NOTAM that DOES
 *  publish a width ("LARGEUR : 500M DE PART ET D'AUTRE DE L'AXE") carries it
 *  in AerobaticAxis.widthM instead. */
export const AEROBATIC_CORRIDOR_WIDTH_M = 200;

/** Axis (true bearing, degrees), length (metres) and, when the source
 *  publishes one, total width (metres) of an aerobatic display line parsed
 *  from an E) section. */
export interface AerobaticAxis {
	bearingDeg: number;
	lengthM: number;
	widthM?: number;
}

/**
 * Parse French/English aerobatic ("VOLTIGE") display-line geometry from an E)
 * section: an axis bearing and a length along it. Handles the keyword variants
 * seen in SIA data: AXE / AXIS / ORIENTATION for the bearing (degree pair
 * "ddd/ddd", or runway form "AXE PISTE 10/28" -> 100 deg) and LONGUEUR /
 * LONGUEUR AXE / LENGTH for the length. Returns null when either piece is
 * missing; the caller then leaves the NOTAM as a point. The centre is the
 * NOTAM's PSN coordinate, parsed separately.
 */
export function parseAerobaticAxis(eContent: string): AerobaticAxis | null {
	// LENGHT and LLEN are real corpus corruptions (the SIA's English texts
	// of W1659/26 and W1750/26).
	const lenMatch = eContent.match(
		/\b(?:LONGUEUR(?:\s+AXE)?|LENG(?:TH|HT)|LLEN)\b\s*:?\s*(\d+(?:[.,]\d+)?)\s*(M|KM|NM|METRES?)\b/i,
	);
	if (!lenMatch) {
		return null;
	}
	let lengthM = parseFloat(lenMatch[1].replace(',', '.'));
	const unit = lenMatch[2].toUpperCase();
	if (unit === 'KM') {
		lengthM *= 1000;
	} else if (unit === 'NM') {
		lengthM *= NM_TO_METERS;
	}
	if (!(lengthM > 0)) {
		return null;
	}

	// Runway-designator axis ("AXE PISTE 10/28", "AXE : RWY 16R/34L"): the
	// two-digit designator is tens of degrees, so 10 -> 100 deg (its
	// reciprocal 28 -> 280 deg); parallel-runway letters are ignored.
	const rwyMatch = eContent.match(
		/\b(?:AXE|AXIS)\s*:?\s*(?:PISTE|RWY|RUNWAY)\s+(\d{2})[LRC]?\s*\/\s*\d{2}[LRC]?\b/i,
	);
	if (rwyMatch) {
		return withWidth(eContent, {
			bearingDeg: (parseInt(rwyMatch[1], 10) * 10) % 360,
			lengthM,
		});
	}

	// Degree axis ("AXE 057/237", "ORIENTATION : 081/261", "AXE : ORIENTE
	// 356/176", "AXIS : ORIENTED 020/200"; AXOS is a corpus corruption,
	// W1750/26): a bearing and its reciprocal; either end works as the box
	// orientation. The required slash pair keeps "LONGUEUR AXE : 2000M" from
	// being read as a bearing.
	const degMatch = eContent.match(
		/\b(?:AXE|AXIS|AXOS|ORIENTATION)\b\s*:?\s*(?:ORIENTEE?D?\s+)?(\d{2,3})\s*\/\s*(\d{2,3})\b/i,
	);
	if (degMatch) {
		return withWidth(eContent, {
			bearingDeg: parseInt(degMatch[1], 10) % 360,
			lengthM,
		});
	}

	return null;
}

/** Attach the published corridor width when the text states one: per-side
 *  when the each-side idiom follows ("500M DE PART ET D'AUTRE DE L'AXE",
 *  "500M EACH PART OF AXIS"), total otherwise. */
function withWidth(eContent: string, axis: AerobaticAxis): AerobaticAxis {
	const m = eContent.match(
		/\b(?:LARGEUR|WIDTH)\b\s*:?\s*(\d+(?:[.,]\d+)?)\s*(M|KM|NM|METRES?)\b(.{0,50})/i,
	);
	if (!m) {
		return axis;
	}
	let widthM = parseFloat(m[1].replace(',', '.'));
	const unit = m[2].toUpperCase();
	if (unit === 'KM') {
		widthM *= 1000;
	} else if (unit === 'NM') {
		widthM *= NM_TO_METERS;
	}
	if (!(widthM > 0)) {
		return axis;
	}
	if (/PART\s+ET\s+D'AUTRE|EACH\s+(?:PART|SIDE)|EITHER\s+SIDE/i.test(m[3])) {
		widthM *= 2;
	}
	return { ...axis, widthM };
}

/**
 * Build the four corners of an aerobatic display corridor: a rectangle centred
 * on `center`, `axis.lengthM` long along the bearing and `widthM` wide across
 * it. Corners are returned in ring order (no closing duplicate); the caller
 * treats the group as a polygon.
 */
export function aerobaticCorridorRing(
	center: LatLon,
	axis: AerobaticAxis,
	widthM: number,
): NotamCoordinate[] {
	const halfLen = axis.lengthM / 2;
	const halfWidth = widthM / 2;
	const end1 = destinationPoint(center.lat, center.lon, axis.bearingDeg, halfLen);
	const end2 = destinationPoint(
		center.lat,
		center.lon,
		axis.bearingDeg + 180,
		halfLen,
	);
	const right = axis.bearingDeg + 90;
	const left = axis.bearingDeg - 90;
	const corners: LatLon[] = [
		destinationPoint(end1.lat, end1.lon, right, halfWidth),
		destinationPoint(end2.lat, end2.lon, right, halfWidth),
		destinationPoint(end2.lat, end2.lon, left, halfWidth),
		destinationPoint(end1.lat, end1.lon, left, halfWidth),
	];
	return corners.map((c) => ({
		original: 'corridor',
		lat: c.lat,
		lon: c.lon,
		type: 'psn',
	}));
}
