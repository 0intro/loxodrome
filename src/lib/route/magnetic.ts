/* World Magnetic Model 2025 (WMM2025) — magnetic declination only.
 *
 * Self-contained port of the public NOAA/BGS geomag spherical-harmonic
 * synthesis (the canonical `geomag.c` E0000 routine; structure follows the
 * compact WMM_Tiny reference, with the full geodetic->spherical conversion
 * incl. altitude restored so it matches the official altitude-bearing test
 * values). Coefficients are the WMM2025 Gauss coefficients from NOAA NCEI
 * (WMM.COF, epoch 2025.0, valid 2025.0-2030.0).
 *
 * Used by the nav log to turn the geometric TRUE track into a magnetic track
 * (Rm = trueTrack - declination). Validated against the official WMM2025 test
 * values in tests/magnetic.spec.ts. Pure; no I/O. */

const WMM_EPOCH = 2025.0;
/* Length of the model's validity window in years. Per the NOAA/NCEI validity
 * statement, WMM2025 is valid 2025.0-2030.0 (it expires 2029-12-31; the
 * WMM2030 coefficient set is due before then). The linear secular-variation
 * term is fitted for that window only, so synthesis clamps dt at the validity
 * end rather than extrapolating an unbounded drift; past 2030.0 the model
 * answers with the frozen 2030.0 declination and magneticModelExpired flags
 * it for the UI advisories. */
const WMM_VALID_YEARS = 5.0;
const DEG2RAD = Math.PI / 180;

const A = 6378.137; // WGS84 semi-major axis (km)
const B = 6356.7523142; // WGS84 semi-minor axis (km)
const RE = 6371.2; // geomagnetic reference radius (km)
const A2 = A * A;
const B2 = B * B;
const C2 = A2 - B2;
const A4 = A2 * A2;
const B4 = B2 * B2;
const C4 = A4 - B4;

/* WMM2025 Gauss coefficients [g_n^m, h_n^m, dg/dt, dh/dt], ordered n = 1..12,
 * m = 0..n (the order WMM.COF lists them). Source: NOAA NCEI WMM2025 (WMM.COF,
 * released 2024-11-13). */
const COF: readonly (readonly [number, number, number, number])[] = [
	[-29351.8, 0.0, 12.0, 0.0],
	[-1410.8, 4545.4, 9.7, -21.5],
	[-2556.6, 0.0, -11.6, 0.0],
	[2951.1, -3133.6, -5.2, -27.7],
	[1649.3, -815.1, -8.0, -12.1],
	[1361.0, 0.0, -1.3, 0.0],
	[-2404.1, -56.6, -4.2, 4.0],
	[1243.8, 237.5, 0.4, -0.3],
	[453.6, -549.5, -15.6, -4.1],
	[895.0, 0.0, -1.6, 0.0],
	[799.5, 278.6, -2.4, -1.1],
	[55.7, -133.9, -6.0, 4.1],
	[-281.1, 212.0, 5.6, 1.6],
	[12.1, -375.6, -7.0, -4.4],
	[-233.2, 0.0, 0.6, 0.0],
	[368.9, 45.4, 1.4, -0.5],
	[187.2, 220.2, 0.0, 2.2],
	[-138.7, -122.9, 0.6, 0.4],
	[-142.0, 43.0, 2.2, 1.7],
	[20.9, 106.1, 0.9, 1.9],
	[64.4, 0.0, -0.2, 0.0],
	[63.8, -18.4, -0.4, 0.3],
	[76.9, 16.8, 0.9, -1.6],
	[-115.7, 48.8, 1.2, -0.4],
	[-40.9, -59.8, -0.9, 0.9],
	[14.9, 10.9, 0.3, 0.7],
	[-60.7, 72.7, 0.9, 0.9],
	[79.5, 0.0, -0.0, 0.0],
	[-77.0, -48.9, -0.1, 0.6],
	[-8.8, -14.4, -0.1, 0.5],
	[59.3, -1.0, 0.5, -0.8],
	[15.8, 23.4, -0.1, 0.0],
	[2.5, -7.4, -0.8, -1.0],
	[-11.1, -25.1, -0.8, 0.6],
	[14.2, -2.3, 0.8, -0.2],
	[23.2, 0.0, -0.1, 0.0],
	[10.8, 7.1, 0.2, -0.2],
	[-17.5, -12.6, 0.0, 0.5],
	[2.0, 11.4, 0.5, -0.4],
	[-21.7, -9.7, -0.1, 0.4],
	[16.9, 12.7, 0.3, -0.5],
	[15.0, 0.7, 0.2, -0.6],
	[-16.8, -5.2, -0.0, 0.3],
	[0.9, 3.9, 0.2, 0.2],
	[4.6, 0.0, -0.0, 0.0],
	[7.8, -24.8, -0.1, -0.3],
	[3.0, 12.2, 0.1, 0.3],
	[-0.2, 8.3, 0.3, -0.3],
	[-2.5, -3.3, -0.3, 0.3],
	[-13.1, -5.2, 0.0, 0.2],
	[2.4, 7.2, 0.3, -0.1],
	[8.6, -0.6, -0.1, -0.2],
	[-8.7, 0.8, 0.1, 0.4],
	[-12.9, 10.0, -0.1, 0.1],
	[-1.3, 0.0, 0.1, 0.0],
	[-6.4, 3.3, 0.0, 0.0],
	[0.2, 0.0, 0.1, -0.0],
	[2.0, 2.4, 0.1, -0.2],
	[-1.0, 5.3, -0.0, 0.1],
	[-0.6, -9.1, -0.3, -0.1],
	[-0.9, 0.4, 0.0, 0.1],
	[1.5, -4.2, -0.1, 0.0],
	[0.9, -3.8, -0.1, -0.1],
	[-2.7, 0.9, -0.0, 0.2],
	[-3.9, -9.1, -0.0, -0.0],
	[2.9, 0.0, 0.0, 0.0],
	[-1.5, 0.0, -0.0, -0.0],
	[-2.5, 2.9, 0.0, 0.1],
	[2.4, -0.6, 0.0, -0.0],
	[-0.6, 0.2, 0.0, 0.1],
	[-0.1, 0.5, -0.1, -0.0],
	[-0.6, -0.3, 0.0, -0.0],
	[-0.1, -1.2, -0.0, 0.1],
	[1.1, -1.7, -0.1, -0.0],
	[-1.0, -2.9, -0.1, 0.0],
	[-0.2, -1.8, -0.1, 0.0],
	[2.6, -2.3, -0.1, 0.0],
	[-2.0, 0.0, 0.0, 0.0],
	[-0.2, -1.3, 0.0, -0.0],
	[0.3, 0.7, -0.0, 0.0],
	[1.2, 1.0, -0.0, -0.1],
	[-1.3, -1.4, -0.0, 0.1],
	[0.6, -0.0, -0.0, -0.0],
	[0.6, 0.6, 0.1, -0.0],
	[0.5, -0.1, -0.0, -0.0],
	[-0.1, 0.8, 0.0, 0.0],
	[-0.4, 0.1, 0.0, -0.0],
	[-0.2, -1.0, -0.1, -0.0],
	[-1.3, 0.1, -0.0, 0.0],
	[-0.7, 0.2, -0.1, -0.1],
];

const MAXORD = 12;

function zero2d(): number[][] {
	return Array.from({ length: 13 }, () => new Array<number>(13).fill(0));
}

// Module-level model state, built once from COF (un-normalized Gauss
// coefficients + the recursion constants k). The snorm array doubles as the
// per-evaluation Legendre working buffer (overwritten each call, like the C
// reference); snorm[0] stays 1. Calls are sequential, so sharing it is safe.
const c = zero2d();
const cd = zero2d();
const k = zero2d();
const fn = new Array<number>(13).fill(0);
const fm = new Array<number>(13).fill(0);
const snorm = new Array<number>(169).fill(0);
let initialized = false;

function init(): void {
	let entry = 0;
	for (let n = 1; n <= MAXORD; n++) {
		for (let m = 0; m <= n; m++) {
			const [gnm, hnm, dgnm, dhnm] = COF[entry++];
			c[m][n] = gnm;
			cd[m][n] = dgnm;
			if (m !== 0) {
				c[n][m - 1] = hnm;
				cd[n][m - 1] = dhnm;
			}
		}
	}

	// Convert Schmidt semi-normalized Gauss coefficients to un-normalized.
	snorm[0] = 1;
	for (let n = 1; n <= MAXORD; n++) {
		snorm[n] = (snorm[n - 1] * (2 * n - 1)) / n;
		let j = 2;
		for (let m = 0; m <= n; m++) {
			k[m][n] = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
			if (m > 0) {
				const flnmj = ((n - m + 1) * j) / (n + m);
				snorm[n + m * 13] = snorm[n + (m - 1) * 13] * Math.sqrt(flnmj);
				j = 1;
				c[n][m - 1] *= snorm[n + m * 13];
				cd[n][m - 1] *= snorm[n + m * 13];
			}
			c[m][n] *= snorm[n + m * 13];
			cd[m][n] *= snorm[n + m * 13];
		}
		fn[n] = n + 1;
		fm[n] = n;
	}
	k[1][1] = 0;
	initialized = true;
}

/** Magnetic declination D in degrees (positive East) at the given geodetic
 *  position and decimal year, from WMM2025. `altKm` is geodetic height above
 *  the WGS84 ellipsoid (default 0). */
export function magneticDeclinationDeg(
	glat: number,
	glon: number,
	timeYears: number,
	altKm = 0,
): number {
	if (!initialized) {
		init();
	}
	// Secular variation clamped at the validity end (see WMM_VALID_YEARS).
	const dt = Math.min(timeYears - WMM_EPOCH, WMM_VALID_YEARS);
	const rlon = glon * DEG2RAD;
	const rlat = glat * DEG2RAD;
	const srlon = Math.sin(rlon);
	const srlat = Math.sin(rlat);
	const crlon = Math.cos(rlon);
	const crlat = Math.cos(rlat);
	const srlat2 = srlat * srlat;
	const crlat2 = crlat * crlat;

	const sp = new Array<number>(13).fill(0);
	const cp = new Array<number>(13).fill(0);
	const pp = new Array<number>(13).fill(0);
	const dp = zero2d();
	const tc = zero2d();
	sp[1] = srlon;
	cp[0] = 1;
	cp[1] = crlon;
	pp[0] = 1;

	// Geodetic -> spherical (full conversion incl. altitude).
	const q = Math.sqrt(A2 - C2 * srlat2);
	const q1 = altKm * q;
	const q2 = ((q1 + A2) / (q1 + B2)) ** 2;
	const ct = srlat / Math.sqrt(q2 * crlat2 + srlat2);
	const st = Math.sqrt(1 - ct * ct);
	const r2 = altKm * altKm + 2 * q1 + (A4 - C4 * srlat2) / (q * q);
	const r = Math.sqrt(r2);
	const d = Math.sqrt(A2 * crlat2 + B2 * srlat2);
	const ca = (altKm + d) / r;
	const sa = (C2 * crlat * srlat) / (r * d);

	for (let m = 2; m <= MAXORD; m++) {
		sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1];
		cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1];
	}

	const aor = RE / r;
	let ar = aor * aor;
	let br = 0;
	let bt = 0;
	let bp = 0;
	let bpp = 0;

	for (let n = 1; n <= MAXORD; n++) {
		ar = ar * aor;
		for (let m = 0; m <= n; m++) {
			// Un-normalized associated Legendre polynomials + derivatives.
			if (n === m) {
				snorm[n + m * 13] = st * snorm[n - 1 + (m - 1) * 13];
				dp[m][n] = st * dp[m - 1][n - 1] + ct * snorm[n - 1 + (m - 1) * 13];
			} else if (n === 1 && m === 0) {
				snorm[n + m * 13] = ct * snorm[n - 1 + m * 13];
				dp[m][n] = ct * dp[m][n - 1] - st * snorm[n - 1 + m * 13];
			} else if (n > 1 && n !== m) {
				if (m > n - 2) {
					snorm[n - 2 + m * 13] = 0;
					dp[m][n - 2] = 0;
				}
				snorm[n + m * 13] =
					ct * snorm[n - 1 + m * 13] - k[m][n] * snorm[n - 2 + m * 13];
				dp[m][n] =
					ct * dp[m][n - 1] - st * snorm[n - 1 + m * 13] - k[m][n] * dp[m][n - 2];
			}

			// Time-adjust the Gauss coefficients to the requested year.
			tc[m][n] = c[m][n] + dt * cd[m][n];
			if (m !== 0) {
				tc[n][m - 1] = c[n][m - 1] + dt * cd[n][m - 1];
			}

			// Accumulate the spherical-harmonic field terms.
			const par = ar * snorm[n + m * 13];
			let temp1: number;
			let temp2: number;
			if (m === 0) {
				temp1 = tc[m][n] * cp[m];
				temp2 = tc[m][n] * sp[m];
			} else {
				temp1 = tc[m][n] * cp[m] + tc[n][m - 1] * sp[m];
				temp2 = tc[m][n] * sp[m] - tc[n][m - 1] * cp[m];
			}
			bt = bt - ar * temp1 * dp[m][n];
			bp += fm[m] * temp2 * par;
			br += fn[n] * temp1 * par;

			// Geographic-pole special case (st == 0).
			if (st === 0 && m === 1) {
				pp[n] = n === 1 ? pp[n - 1] : ct * pp[n - 1] - k[m][n] * pp[n - 2];
				bpp += fm[m] * temp2 * ar * pp[n];
			}
		}
	}

	if (st === 0) {
		bp = bpp;
	} else {
		bp /= st;
	}

	// Rotate the field from spherical to geodetic and take the declination.
	const bx = -bt * ca - br * sa;
	const by = bp;
	return Math.atan2(by, bx) / DEG2RAD;
}

/** True once `date` lies past the WMM2025 validity end (2030.0): the
 *  declination is then held at the frozen 2030.0 value, and the consumers
 *  (About modal, nav-log MH provenance tooltip) surface a one-line
 *  advisory until the WMM2030 coefficients land. */
export function magneticModelExpired(date: Date): boolean {
	return decimalYearFromDate(date) > WMM_EPOCH + WMM_VALID_YEARS;
}

/** Decimal year (e.g. 2026.42) for a Date, in UTC. */
export function decimalYearFromDate(d: Date): number {
	const year = d.getUTCFullYear();
	const start = Date.UTC(year, 0, 1);
	const next = Date.UTC(year + 1, 0, 1);
	return year + (d.getTime() - start) / (next - start);
}

/** Magnetic track from a true track (deg) at a position/date: true minus the
 *  east-positive declination, normalised to [0, 360). */
export function magneticFromTrue(
	trueDeg: number,
	lat: number,
	lon: number,
	timeYears: number,
): number {
	const d = trueDeg - magneticDeclinationDeg(lat, lon, timeYears);
	return ((d % 360) + 360) % 360;
}

/** The nav-log recipe for a leg's magnetic angle: the variation is sampled at
 *  the leg midpoint. Pass the leg's true track for the magnetic course, or the
 *  wind-corrected true heading for the magnetic heading; the one shared
 *  helper keeps the route list, the nav log and the saved YAML agreeing. */
export function legMagneticTrackDeg(
	trueDeg: number,
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
	timeYears: number,
): number {
	return magneticFromTrue(trueDeg, (a.lat + b.lat) / 2, (a.lon + b.lon) / 2, timeYears);
}
