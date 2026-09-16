/* Marching-squares isolines over the wind lattice's temperature field, for
 * the 0 degC isotherm overlay. Pure and grid-agnostic: values come row-major
 * over ys x xs lattice coordinates (latitude rows, longitude columns here),
 * null marks a missing sample and mutes its four cells. Crossing points are
 * linearly interpolated along cell edges and the per-cell segments are then
 * chained into polylines; the saddle ambiguity resolves on the cell-centre
 * average, so a given field always draws the same way. */

export interface IsoGrid {
	/** Column coordinates (e.g. longitudes), ascending. */
	xs: number[];
	/** Row coordinates (e.g. latitudes). */
	ys: number[];
	/** values[j][i] belongs to (xs[i], ys[j]); null = missing. */
	values: (number | null)[][];
}

type Pt = [number, number];

function interp(a: number, b: number, va: number, vb: number, iso: number): number {
	const d = vb - va;
	if (d === 0) {
		return (a + b) / 2;
	}
	return a + ((iso - va) / d) * (b - a);
}

const key = (p: Pt): string => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** All iso-value polylines of the field, as [x, y] chains. */
export function isolines(grid: IsoGrid, iso: number): Pt[][] {
	const segments: [Pt, Pt][] = [];
	const { xs, ys, values } = grid;
	for (let j = 0; j < ys.length - 1; j++) {
		for (let i = 0; i < xs.length - 1; i++) {
			const v00 = values[j]?.[i];
			const v10 = values[j]?.[i + 1];
			const v01 = values[j + 1]?.[i];
			const v11 = values[j + 1]?.[i + 1];
			if (v00 == null || v10 == null || v01 == null || v11 == null) {
				continue;
			}
			const x0 = xs[i];
			const x1 = xs[i + 1];
			const y0 = ys[j];
			const y1 = ys[j + 1];
			// Bit order: v00 v10 v11 v01 (clockwise from the top-left corner).
			let idx = 0;
			if (v00 > iso) idx |= 8;
			if (v10 > iso) idx |= 4;
			if (v11 > iso) idx |= 2;
			if (v01 > iso) idx |= 1;
			if (idx === 0 || idx === 15) {
				continue;
			}
			const top: Pt = [interp(x0, x1, v00, v10, iso), y0];
			const right: Pt = [x1, interp(y0, y1, v10, v11, iso)];
			const bottom: Pt = [interp(x0, x1, v01, v11, iso), y1];
			const left: Pt = [x0, interp(y0, y1, v00, v01, iso)];
			switch (idx) {
				case 1:
				case 14:
					segments.push([left, bottom]);
					break;
				case 2:
				case 13:
					segments.push([bottom, right]);
					break;
				case 3:
				case 12:
					segments.push([left, right]);
					break;
				case 4:
				case 11:
					segments.push([top, right]);
					break;
				case 6:
				case 9:
					segments.push([top, bottom]);
					break;
				case 7:
				case 8:
					segments.push([left, top]);
					break;
				case 5:
				case 10: {
					// Saddle: split by the centre average.
					const centreHigh = (v00 + v10 + v01 + v11) / 4 > iso;
					if ((idx === 5) === centreHigh) {
						segments.push([left, top], [bottom, right]);
					} else {
						segments.push([left, bottom], [top, right]);
					}
					break;
				}
			}
		}
	}
	return chain(segments);
}

/** Join shared-endpoint segments into polylines (endpoints quantised). */
function chain(segments: [Pt, Pt][]): Pt[][] {
	const adj = new Map<string, { p: Pt; segs: number[] }>();
	segments.forEach(([a, b], idx) => {
		for (const p of [a, b]) {
			const k = key(p);
			const e = adj.get(k);
			if (e) {
				e.segs.push(idx);
			} else {
				adj.set(k, { p, segs: [idx] });
			}
		}
	});
	const used = new Array<boolean>(segments.length).fill(false);
	const lines: Pt[][] = [];
	for (let start = 0; start < segments.length; start++) {
		if (used[start]) {
			continue;
		}
		used[start] = true;
		const line: Pt[] = [segments[start][0], segments[start][1]];
		// Extend forward from the tail, then backward from the head.
		for (const dir of [1, 0] as const) {
			for (;;) {
				const endPt = dir === 1 ? line[line.length - 1] : line[0];
				const entry = adj.get(key(endPt));
				const nextIdx = entry?.segs.find((s) => !used[s]);
				if (nextIdx === undefined) {
					break;
				}
				used[nextIdx] = true;
				const [a, b] = segments[nextIdx];
				const next = key(a) === key(endPt) ? b : a;
				if (dir === 1) {
					line.push(next);
				} else {
					line.unshift(next);
				}
			}
		}
		lines.push(line);
	}
	return lines;
}
