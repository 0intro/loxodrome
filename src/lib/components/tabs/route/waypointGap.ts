/* Where a waypoint dropped at a height lands in the Route tab's list. */

/** The gap (0 = before the first, n = after the last) a drop at `y` lands
 *  in among the waypoint rows, top to bottom. The whole first row is
 *  "before the first" and the whole last row "after the last", their half
 *  rows being too small to hit and a pointer past the list's edge finding
 *  no row; an interior row splits at its centre. The leg rows between are
 *  no dead zone: a drop over one lands by the next row's test. */
export function waypointGap(rows: readonly { top: number; bottom: number }[], y: number): number {
	const last = rows.length - 1;
	for (let k = 0; k < rows.length; k++) {
		const r = rows[k];
		const split = k === 0 ? r.bottom : k === last ? r.top : (r.top + r.bottom) / 2;
		if (y < split) {
			return k;
		}
	}
	return rows.length;
}
