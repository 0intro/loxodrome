/* laea.ts: the grid of the EUMETNET OPERA composites, a Lambert azimuthal
 * equal-area projection on the WGS84 ELLIPSOID, which is what the product's
 * own /where/projdef states: `+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000
 * +y_0=-2100000 +units=m +ellps=WGS84`. The forward is Snyder's oblique
 * ellipsoidal case (Map Projections: A Working Manual, USGS PP 1395, 1987,
 * pp. 187-190: the authalic latitude, Rq and D), checked against PROJ to a
 * few micrometres over the whole grid (tests/laea.spec.ts). The spherical
 * shortcut is 1 to 2 km off over France, one to two cells, which is why it
 * is not taken.
 *
 * The grid convention is ODIM's (the /where group): the UPPER-LEFT CORNER of
 * the upper-left pixel sits at projected (0, 0), x grows east and y grows
 * north, so pixel (col, row) spans x in [1000 col, 1000 (col + 1)] and y in
 * [-1000 (row + 1), -1000 row], row 0 being the northern edge. The GeoTIFF
 * twin's tie point says (-500, 500), half a pixel away (the PixelIsPoint /
 * PixelIsArea slip of its converter); the ODIM statement is the producer's
 * own and is the one followed (docs/precipitation-radar.md, "The grid").
 * Pure: no Leaflet, no state, no catalog. */

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);
const DEG = Math.PI / 180;
const LAT0 = 55 * DEG;
const LON0 = 10 * DEG;
const X0 = 1950000;
const Y0 = -2100000;

/** Snyder's q (eq. 3-12): the authalic-latitude kernel. */
function q(phi: number): number {
	const s = Math.sin(phi);
	return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
}

const QP = q(Math.PI / 2);
const BETA1 = Math.asin(q(LAT0) / QP);
const RQ = A * Math.sqrt(QP / 2);
const M1 = Math.cos(LAT0) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2);
const D = (A * M1) / (RQ * Math.cos(BETA1));
const SIN_B1 = Math.sin(BETA1);
const COS_B1 = Math.cos(BETA1);

/** One of the composite grids: the same projected rectangle (3800 x 4400
 *  km, the ODIM corner at (0, 0)) cut into cells of `cellM` metres and
 *  512-px tiles. Built-ins rather than something read off a fetch, so a
 *  frame on another grid is REFUSED (files/tiff.ts isOperaLayout) and never
 *  drawn misplaced; every geometry function takes the grid EXPLICITLY, a
 *  default being a silent placement bug waiting for one missed call site. */
export interface OperaGrid {
	readonly cols: number;
	readonly rows: number;
	readonly cellM: number;
	readonly tile: number;
	readonly tileCols: number;
	readonly tileRows: number;
	readonly tileCount: number;
}

/** The CIRRUS grid (1 km) the DBZH composite is published on: 3800 columns
 *  by 4400 rows, in 512 px tiles (8 x 9 = 72). */
export const OPERA_GRID: OperaGrid = {
	cols: 3800,
	rows: 4400,
	cellM: 1000,
	tile: 512,
	tileCols: 8,
	tileRows: 9,
	tileCount: 72,
};

/** The 2 km grid the RATE composite is published on: the same rectangle at
 *  half the resolution, 1900 x 2200 in 512 px tiles (4 x 5 = 20). Its
 *  GeoTIFF tie point reads (-1000, 1000), the same half-pixel converter
 *  slip as the 1 km twin's (-500, 500), so the ODIM corner applies. */
export const OPERA_GRID_2KM: OperaGrid = {
	cols: 1900,
	rows: 2200,
	cellM: 2000,
	tile: 512,
	tileCols: 4,
	tileRows: 5,
	tileCount: 20,
};

/** Projected metres of a geographic point, or null over the FAR HEMISPHERE
 *  (more than 90 degrees from the projection centre, ten thousand kilometres
 *  from any cell): the azimuthal projection maps that half of the Earth to
 *  an outer ring whose coordinates run to ten thousand kilometres and flip
 *  sign across the antipode, so a viewport near 55 S 170 W read as spanning
 *  the whole grid and painted phantom cells on it. `den` is 1 plus the
 *  cosine of the angular distance. */
export function laeaForward(latDeg: number, lonDeg: number): { x: number; y: number } | null {
	const phi = latDeg * DEG;
	const lam = lonDeg * DEG - LON0;
	const beta = Math.asin(Math.max(-1, Math.min(1, q(phi) / QP)));
	const sb = Math.sin(beta);
	const cb = Math.cos(beta);
	const cl = Math.cos(lam);
	const den = 1 + SIN_B1 * sb + COS_B1 * cb * cl;
	if (den < 1) {
		return null;
	}
	const b = RQ * Math.sqrt(2 / den);
	return {
		x: X0 + b * D * cb * Math.sin(lam),
		y: Y0 + (b / D) * (COS_B1 * sb - SIN_B1 * cb * cl),
	};
}

/** Fractional grid column / row of a geographic point (the cell is the
 *  floor of each), or null over the far hemisphere. May fall outside the
 *  grid. */
export function gridColRow(latDeg: number, lonDeg: number, grid: OperaGrid): { col: number; row: number } | null {
	const p = laeaForward(latDeg, lonDeg);
	if (!p) {
		return null;
	}
	return { col: p.x / grid.cellM, row: -p.y / grid.cellM };
}

/** Whether a fractional cell lies on the composite. */
export function gridContains(col: number, row: number, grid: OperaGrid): boolean {
	return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows;
}
