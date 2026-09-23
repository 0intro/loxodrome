/* The OPERA grid's projection, pinned against PROJ: the golden values below
 * were produced by pyproj (PROJ 9) for the composite's own projdef
 * `+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84`,
 * and the four corners are the ODIM /where group of a live frame
 * (2026-09-20T08:10Z), which the ODIM convention puts at the grid's edges.
 * The 2 km grid is the same rectangle at half the resolution, pinned as an
 * invariant against the 1 km one. */
import { describe, expect, it } from 'vitest';
import { OPERA_GRID, OPERA_GRID_2KM, gridColRow, gridContains, laeaForward } from '$lib/weather/laea';

const GOLDEN: [number, number, number, number][] = [
	// lon, lat, x, y (metres)
	[2.55, 49.01, 1405394.322, -2737777.771],
	[-4.42, 48.45, 889710.824, -2720991.51],
	[7.22, 43.66, 1724762.95, -3354949.436],
	[10, 55, 1950000, -2100000],
	[-10, 35, 120716.405, -4064567.455],
	[30, 70, 2707283.288, -319041.746],
	[0, 0, 699510.095, -7896468.732],
	[25, 60, 2780384.199, -1452630.325],
	[-20, 40, -554738.19, -3240227.467],
	[-60, 20, -4632097.306, -2599030.409],
	[80, 75, 3572390.313, 1104981.019],
];

/** The ODIM corners of a live frame: UL, UR, LL, LR (4 decimals, ~10 m). */
const CORNERS: [number, number][] = [
	[67.0228, -39.5358],
	[67.621, 57.812],
	[31.7462, -10.4346],
	[31.9877, 29.421],
];

describe('laeaForward', () => {
	it('reproduces PROJ to the millimetre over the grid', () => {
		for (const [lon, lat, x, y] of GOLDEN) {
			const p = laeaForward(lat, lon)!;
			expect(Math.abs(p.x - x), `${lon},${lat} x`).toBeLessThan(0.001);
			expect(Math.abs(p.y - y), `${lon},${lat} y`).toBeLessThan(0.001);
		}
	});

	it('puts the ODIM corners of a live frame at the grid edges', () => {
		// The grid is 3800 x 4400 km with its corner at (0, 0).
		const xy: [number, number][] = [
			[0, 0],
			[3800000, 0],
			[0, -4400000],
			[3800000, -4400000],
		];
		CORNERS.forEach(([lat, lon], i) => {
			const p = laeaForward(lat, lon)!;
			expect(Math.abs(p.x - xy[i][0])).toBeLessThan(5);
			expect(Math.abs(p.y - xy[i][1])).toBeLessThan(5);
		});
	});

	it('has no image at the antipode of the centre, nor anywhere on the far hemisphere', () => {
		expect(laeaForward(-55, -170)).toBeNull();
		// A few hundredths of a degree from the antipode the projection ran
		// to ten thousand kilometres with the sign flipping across it, and a
		// viewport there read as the whole grid.
		expect(laeaForward(-55, -169.9)).toBeNull();
		expect(laeaForward(-55, -170.1)).toBeNull();
		expect(laeaForward(-60, 0)).toBeNull();
		// The near hemisphere still projects, however far from the grid.
		expect(laeaForward(-20, 10)).not.toBeNull();
		expect(laeaForward(35, -100)).not.toBeNull();
	});

	it('refuses exactly the far hemisphere, a degree either side of the terminator', () => {
		// The guard is 90 degrees from the projection centre (55 N, 10 E) on
		// the authalic sphere. The probes above sit 115 to 180 degrees out, so
		// a guard relaxed to refuse only past 96 degrees passed every one of
		// them while a viewport at 40 S 20 E, 95 degrees out, projected onto
		// the grid again. The terminator crosses 10 E at 35.24 S and the
		// equator at 100 E and 80 W; each probe is a quarter of a degree or
		// less from it, so the guard cannot move by more without one failing.
		const inside: [number, number][] = [
			[-34.99, 10],
			[0, 99.7],
			[0, -79.7],
		];
		const outside: [number, number][] = [
			[-35.49, 10],
			[0, 100.3],
			[0, -80.3],
			[-40, 20],
		];
		for (const [lat, lon] of inside) {
			expect(laeaForward(lat, lon), `${lat}, ${lon}`).not.toBeNull();
		}
		for (const [lat, lon] of outside) {
			expect(laeaForward(lat, lon), `${lat}, ${lon}`).toBeNull();
		}
	});
});

describe('gridColRow', () => {
	it('places Paris CDG on its cell (the ODIM corner, half a cell from the TIFF tie point)', () => {
		const g = gridColRow(49.01, 2.55, OPERA_GRID)!;
		expect(g.col).toBeCloseTo(1405.39, 2);
		expect(g.row).toBeCloseTo(2737.78, 2);
	});

	it('knows the grid extent', () => {
		expect(OPERA_GRID.tileCols * OPERA_GRID.tileRows).toBe(OPERA_GRID.tileCount);
		expect(gridContains(0, 0, OPERA_GRID)).toBe(true);
		expect(gridContains(3799.99, 4399.99, OPERA_GRID)).toBe(true);
		expect(gridContains(3800, 0, OPERA_GRID)).toBe(false);
		expect(gridContains(-0.1, 5, OPERA_GRID)).toBe(false);
		expect(gridContains(5, 4400, OPERA_GRID)).toBe(false);
	});
});

describe('the 2 km grid', () => {
	it('is the same rectangle at half the resolution, its tiles covering it', () => {
		expect(OPERA_GRID_2KM.cols * OPERA_GRID_2KM.cellM).toBe(OPERA_GRID.cols * OPERA_GRID.cellM);
		expect(OPERA_GRID_2KM.rows * OPERA_GRID_2KM.cellM).toBe(OPERA_GRID.rows * OPERA_GRID.cellM);
		expect(OPERA_GRID_2KM.tileCols * OPERA_GRID_2KM.tileRows).toBe(OPERA_GRID_2KM.tileCount);
		expect(Math.ceil(OPERA_GRID_2KM.cols / OPERA_GRID_2KM.tile)).toBe(OPERA_GRID_2KM.tileCols);
		expect(Math.ceil(OPERA_GRID_2KM.rows / OPERA_GRID_2KM.tile)).toBe(OPERA_GRID_2KM.tileRows);
		expect(Math.ceil(OPERA_GRID.cols / OPERA_GRID.tile)).toBe(OPERA_GRID.tileCols);
		expect(Math.ceil(OPERA_GRID.rows / OPERA_GRID.tile)).toBe(OPERA_GRID.tileRows);
	});

	it('reads every point at exactly half the 1 km column and row', () => {
		const points: [number, number][] = [
			[49.01, 2.55],
			[48.45, -4.42],
			[43.66, 7.22],
			[55, 10],
			[35, -10],
			[70, 30],
			...CORNERS,
		];
		for (const [lat, lon] of points) {
			const a = gridColRow(lat, lon, OPERA_GRID)!;
			const b = gridColRow(lat, lon, OPERA_GRID_2KM)!;
			expect(b.col).toBeCloseTo(a.col / 2, 9);
			expect(b.row).toBeCloseTo(a.row / 2, 9);
		}
		expect(gridContains(1899.99, 2199.99, OPERA_GRID_2KM)).toBe(true);
		expect(gridContains(1900, 0, OPERA_GRID_2KM)).toBe(false);
		expect(gridContains(5, 2200, OPERA_GRID_2KM)).toBe(false);
	});
});
