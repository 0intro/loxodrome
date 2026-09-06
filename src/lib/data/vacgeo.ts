/* Where each French VAC panel sits on the ground (cmd/vacgeo, contract in
 * docs/fr-vacgeo.md).
 *
 * One row per geographic panel of one Atlas VAC plate: which page it is on,
 * the rectangle of that page which is a map, and the affine that turns a
 * point of that rectangle into a position. Over a panel's own extent the
 * mapping is linear to far better than the chart's drafting accuracy, so
 * six coefficients say the whole of it and nothing has to be warped. Six
 * rather than four because a ground-movement chart is rotated.
 *
 * Every row in the file has already been checked to contain the aerodrome
 * it claims to show, against the ARP the plate prints and against
 * fr-airports.json (cmd/vacgeo/build.go). A plate that could not be placed
 * has no row, which is why a missing panel is silence rather than an
 * approximation.
 *
 * Pure: no Svelte. state/vacGeo.svelte.ts owns the lazy load. */

/** The chart families that carry a graticule. GMC is emitted only when a
 *  ground-movement sheet turns out to have one; most do not. */
export type VacPanelKind = 'APP' | 'ATT' | 'GMC';

/** Atlas VAC product: 2 is the aerodrome plate, keyed by ICAO indicator, 3
 *  the helistation one, keyed by the SIA codeId. */
export type VacSection = 2 | 3;

/** The mapping from page points to degrees, six coefficients:
 *
 *	lon = A*x + C*y + E
 *	lat = B*x + D*y + F
 *
 * Six rather than two scales, because a ground-movement chart is ROTATED
 * (LFPL's is turned about 75 degrees, its runway drawn up the page). A
 * graticule panel is the case where B and C are zero. */
export type VacAffine = readonly [number, number, number, number, number, number];

export interface VacPanel {
	ident: string;
	section: VacSection;
	/** 1-based page of the plate, which is what the PDF reader asks for. */
	page: number;
	kind: VacPanelKind;
	/** The map rectangle in PDF points, origin bottom left: [x0,y0,x1,y1]. */
	clip: readonly [number, number, number, number];
	aff: VacAffine;
	/** The envelope the affine implies over the clip, which is what the map
	 *  culls on. For a rotated panel it is bigger than the panel. */
	south: number;
	west: number;
	north: number;
	east: number;
}

/** One corner of a panel, in degrees. */
export function panelAt(p: VacPanel, x: number, y: number): [lat: number, lon: number] {
	const [a, b, c, d, e, f] = p.aff;
	return [b * x + d * y + f, a * x + c * y + e];
}

/** Where on the page a position falls, in PDF points, by running the panel's
 *  own affine backwards. Null when the affine is degenerate.
 *
 *  panelAt is `lat = b*x + d*y + f` and `lon = a*x + c*y + e`, so this is the
 *  2x2 solve of the same pair. */
export function panelPointAt(p: VacPanel, lat: number, lon: number): [number, number] | null {
	const [a, b, c, d, e, f] = p.aff;
	const det = a * d - c * b;
	if (det === 0) {
		return null;
	}
	const dx = lon - e;
	const dy = lat - f;
	return [(d * dx - c * dy) / det, (a * dy - b * dx) / det];
}

/** Is that position on the chart itself?
 *
 *  Not a test against `south`/`north`/`west`/`east`, which is the box the map
 *  culls on: a ground chart is ROTATED, LFPL's by about 75 degrees, so its
 *  envelope is the box round a tilted quad and the corners of that box are
 *  map rather than chart. Only the clip rectangle in page space is the
 *  chart. */
export function panelContains(p: VacPanel, lat: number, lon: number): boolean {
	const at = panelPointAt(p, lat, lon);
	if (!at) {
		return false;
	}
	const [x, y] = at;
	const [x0, y0, x1, y1] = p.clip;
	return x >= Math.min(x0, x1) && x <= Math.max(x0, x1) && y >= Math.min(y0, y1) && y <= Math.max(y0, y1);
}

export const FR_VACGEO_URL = '/data/fr-vacgeo.json';
export const FR_VACGEO_NEXT_URL = '/data/fr-vacgeo.next.json';

interface VacGeoDoc {
	fields: string[];
	rows: unknown[][];
}

const KINDS: Record<string, VacPanelKind> = { APP: 'APP', ATT: 'ATT', GMC: 'GMC' };

function pair(v: unknown): [number, number] | null {
	return Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number'
		? [v[0], v[1]]
		: null;
}

/** Decode one row, resolving columns by name so an inserted column cannot
 *  shift the reader silently. */
function rowToPanel(row: unknown[], idx: Record<string, number>): VacPanel | null {
	const ident = row[idx.ident];
	const kind = KINDS[String(row[idx.kind])];
	const section = row[idx.section];
	const page = row[idx.page];
	const clip = row[idx.clip];
	const sw = pair(row[idx.sw]);
	const ne = pair(row[idx.ne]);
	const aff = row[idx.aff];
	if (
		typeof ident !== 'string' ||
		!kind ||
		(section !== 2 && section !== 3) ||
		typeof page !== 'number' ||
		!Array.isArray(clip) ||
		clip.length !== 4 ||
		clip.some((v) => typeof v !== 'number') ||
		!sw ||
		!ne ||
		!Array.isArray(aff) ||
		aff.length !== 6 ||
		aff.some((v) => typeof v !== 'number')
	) {
		return null;
	}
	return {
		ident: ident.toUpperCase(),
		section,
		page,
		kind,
		clip: [clip[0] as number, clip[1] as number, clip[2] as number, clip[3] as number],
		aff: [aff[0], aff[1], aff[2], aff[3], aff[4], aff[5]] as VacAffine,
		south: Math.min(sw[0], ne[0]),
		north: Math.max(sw[0], ne[0]),
		west: Math.min(sw[1], ne[1]),
		east: Math.max(sw[1], ne[1]),
	};
}

/** Load and decode the dataset. Fail-soft in the two ways every dataset
 *  loader here is: a non-OK response and a non-JSON 200 (Vite dev serves
 *  the SPA shell for a missing file) both read as "no panels". */
export async function loadFrVacGeo(url: string): Promise<VacPanel[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`vacgeo: ${url} -> ${res.status}`);
		return [];
	}
	if (!res.headers.get('content-type')?.includes('json')) {
		return [];
	}
	const doc = (await res.json()) as VacGeoDoc;
	if (!Array.isArray(doc?.rows) || !Array.isArray(doc?.fields)) {
		return [];
	}
	const idx: Record<string, number> = {};
	doc.fields.forEach((f, i) => {
		idx[f] = i;
	});
	const out: VacPanel[] = [];
	for (const row of doc.rows) {
		const p = rowToPanel(row, idx);
		if (p) {
			out.push(p);
		}
	}
	return out;
}

/** The panel's own scale, in points of paper to the degree of latitude.
 *  What the layer sizes its render from.
 *
 * Read off the AFFINE, not off the envelope: a rotated panel's envelope is
 * bigger than the panel, so measuring it that way would read a
 * ground-movement chart as several times coarser than it is and hold it
 * back until the map was zoomed past it. */
export function panelPtPerDegLat(p: VacPanel): number {
	const [, b, , d] = p.aff;
	const perPt = Math.hypot(b, d);
	return perPt > 0 ? 1 / perPt : 0;
}

/** The map zoom at which one point of the panel is about one CSS pixel, so
 *  the chart reads at its drawn size. Below it the panel is smaller than
 *  the paper it was engraved for and its detail is unreadable, which is why
 *  the layer holds panels back rather than tiling the map with postage
 *  stamps. */
export function panelNativeZoom(p: VacPanel): number {
	const ptPerDeg = panelPtPerDegLat(p);
	if (ptPerDeg <= 0) {
		return 20;
	}
	// Web Mercator: the whole world is 256 * 2^z pixels across 360 degrees
	// of longitude, and a degree of latitude is a degree of longitude times
	// sec(phi) there.
	const lat = ((p.south + p.north) / 2) * (Math.PI / 180);
	const pxPerDegLatAtZ0 = (256 / 360) / Math.cos(lat);
	return Math.log2(ptPerDeg / pxPerDegLatAtZ0);
}
