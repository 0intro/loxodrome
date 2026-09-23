/* The map wind lattice: a geographic grid snapped to power-of-2 degree
 * steps so panning re-hits the fetch cache, clamped to the model's native
 * grid (finer would draw duplicate cells) and to a point budget (the
 * multi-location request weight). Row-major over lats x lons, matching the
 * isotherm module's IsoGrid orientation. Pure. */

export interface Lattice {
	/** Row coordinates, ascending. */
	lats: number[];
	/** Column coordinates, ascending. */
	lons: number[];
	/** Row-major points: index j * lons.length + i is (lats[j], lons[i]). */
	points: { lat: number; lon: number }[];
	stepDeg: number;
}

/** Power-of-2 degree ladder (8 deg down to 1/32 deg). */
const LADDER = [0.03125, 0.0625, 0.125, 0.25, 0.5, 1, 2, 4, 8];

/** The smallest ladder step spanning at least targetPx on screen, never
 *  finer than the model grid. */
export function latticeStepDeg(degPerPx: number, minStepDeg: number, targetPx = 80): number {
	const raw = Math.max(degPerPx * targetPx, minStepDeg);
	for (const s of LADDER) {
		if (s >= raw) {
			return s;
		}
	}
	return LADDER[LADDER.length - 1];
}

const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;

/** Build the lattice covering the bounds (east < west reads as crossing the
 *  antimeridian). The step doubles until the point budget fits. */
export function buildLattice(
	bounds: { west: number; south: number; east: number; north: number },
	stepDeg: number,
	maxPoints = 126,
): Lattice {
	const east = bounds.east >= bounds.west ? bounds.east : bounds.east + 360;
	let step = stepDeg;
	for (;;) {
		const lats: number[] = [];
		for (let lat = Math.floor(bounds.south / step) * step; lat <= bounds.north + 1e-9; lat += step) {
			if (lat > -85 && lat < 85) {
				lats.push(Number(lat.toFixed(6)));
			}
		}
		const lons: number[] = [];
		for (let lon = Math.floor(bounds.west / step) * step; lon <= east + 1e-9; lon += step) {
			lons.push(Number(lon.toFixed(6)));
		}
		if (lats.length * lons.length > maxPoints && step < 16) {
			step *= 2;
			continue;
		}
		const points: { lat: number; lon: number }[] = [];
		for (const lat of lats) {
			for (const lon of lons) {
				points.push({ lat, lon: wrapLon(lon) });
			}
		}
		return { lats, lons, points, stepDeg: step };
	}
}
