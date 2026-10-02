/* pointGrid.ts: a bucket index over a point dataset (obstacles, navaids) for
 * the proximity matches that pair a NOTAM coordinate with the rows a few
 * hundred metres from it (state/notamObstacleLinks, state/notamNavaidLinks).
 *
 * Those matches used to scan every loaded row for every NOTAM coordinate:
 * about 100,000 obstacles times each obstacle NOTAM's positions, which froze
 * the page for 20 s on a 7,500-NOTAM briefing and took 1.2 s on a France one
 * (docs/performance-2026-09.md). The index answers the same box query from
 * the handful of cells around the point.
 *
 * rowsInBox is a drop-in for the linear prefilter it replaces: the rows
 * whose |dlat| and |dlon| are within the box, in DATASET order, so a caller
 * that confirms each candidate with its own distance test gets exactly the
 * list, and the order, the scan gave. The index is built once per array and
 * cached on its identity (the merges publish a new array when a country
 * arrives, the firRowsForIdent idiom). Pure, no Svelte: rows are plain. */

export interface LatLon {
	lat: number;
	lon: number;
}

const CELL_DEG = 0.05;
const LON_CELLS = Math.ceil(360 / CELL_DEG);

interface Grid {
	cells: Map<number, number[]>;
}

const grids = new WeakMap<readonly LatLon[], Grid>();

function rowOf(lat: number): number {
	return Math.floor((lat + 90) / CELL_DEG);
}

function colOf(lon: number): number {
	return Math.min(LON_CELLS - 1, Math.max(0, Math.floor((lon + 180) / CELL_DEG)));
}

function gridFor(rows: readonly LatLon[]): Grid {
	const hit = grids.get(rows);
	if (hit) {
		return hit;
	}
	const cells = new Map<number, number[]>();
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const k = rowOf(r.lat) * LON_CELLS + colOf(r.lon);
		const list = cells.get(k);
		if (list) {
			list.push(i);
		} else {
			cells.set(k, [i]);
		}
	}
	const g = { cells };
	grids.set(rows, g);
	return g;
}

/** The rows within |lat - row.lat| <= dLatDeg and |lon - row.lon| <= dLonDeg,
 *  in dataset order. No wrap across the antimeridian, like the scan it
 *  replaces; a box too wide for the cells to help (a pole) falls back to that
 *  scan. */
export function rowsInBox<T extends LatLon>(
	rows: readonly T[],
	lat: number,
	lon: number,
	dLatDeg: number,
	dLonDeg: number,
): T[] {
	if (!(dLonDeg < 90) || !(dLatDeg < 90)) {
		return rows.filter((p) => Math.abs(p.lat - lat) <= dLatDeg && Math.abs(p.lon - lon) <= dLonDeg);
	}
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return [];
	}
	const g = gridFor(rows);
	const idx: number[] = [];
	const r0 = rowOf(lat - dLatDeg);
	const r1 = rowOf(lat + dLatDeg);
	const c0 = colOf(lon - dLonDeg);
	const c1 = colOf(lon + dLonDeg);
	for (let r = r0; r <= r1; r++) {
		for (let c = c0; c <= c1; c++) {
			const list = g.cells.get(r * LON_CELLS + c);
			if (!list) {
				continue;
			}
			for (const i of list) {
				const p = rows[i];
				if (Math.abs(p.lat - lat) > dLatDeg || Math.abs(p.lon - lon) > dLonDeg) {
					continue;
				}
				idx.push(i);
			}
		}
	}
	idx.sort((a, b) => a - b);
	return idx.map((i) => rows[i]);
}
