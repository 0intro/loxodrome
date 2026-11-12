/* The eight points of the compass a position is read by ("LFOX, 5 NM SW";
 * "4 NM NW Étampes"): the ICAO Doc 8400 abbreviations, which are
 * locale-invariant. Pure. */

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export type CompassPoint = (typeof POINTS)[number];

/** The point nearest a bearing in degrees, any value wrapped: each point
 *  spans 45°, N from 337.5° up to 22.5°, a bearing on a boundary going to
 *  the point clockwise of it. */
export function compassPoint(deg: number): CompassPoint {
	const d = ((deg % 360) + 360) % 360;
	return POINTS[Math.round(d / 45) % POINTS.length];
}
