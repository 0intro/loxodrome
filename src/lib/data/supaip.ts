/* Loader and types for the generated French SUP AIP dataset
 * (public/data/fr-supaip.json from cmd/supaip). One supplement per row,
 * positional layout matching outputFields in cmd/supaip/api.go. A supplement
 * carries listing metadata plus a list of named zones (CTR / TMA / ZRT ...),
 * each with its own area geometry parsed from the PDF (polygon, multipolygon,
 * or circle), bounding box, and vertical limits as airspace-style
 * [code, value, uom] triples, precomputed into datum-aware VLimits at
 * load like the airspace loader does. */

import { fromTriple, type VerticalLimit, type VLimit } from '$lib/vertical/limits';

export type SupAipGeometry =
	| { type: 'polygon'; ring: [number, number][] }
	| { type: 'multipolygon'; rings: [number, number][][] }
	| { type: 'circle'; center: [number, number]; radiusM: number };

export type SupAipSource =
	| 'pdf-polygon'
	| 'pdf-circle'
	| 'pdf-mixed'
	// Belgian eSUP pages are HTML, not PDFs (cmd/be).
	| 'html-polygon'
	| 'html-position'
	| 'none';

/** One scheduled activation window for a zone, parsed from the PDF's
 * "DATES ET HEURES D'ACTIVITÉ" section. `date` is a single day (YYYY-MM-DD);
 * `dateTo` is set for a "Du ... au ..." range. `from` / `to` are "HH:MM" UTC,
 * empty for an all-day / H24 window. */
export interface SupAipActivation {
	date: string;
	dateTo?: string;
	from?: string;
	to?: string;
}

export interface SupBbox {
	minLat: number;
	minLon: number;
	maxLat: number;
	maxLon: number;
}

/** One named sub-area of a supplement (e.g. "CTR LE MANS Temporaire"). */
export interface SupAipZone {
	name: string;
	geometry: SupAipGeometry | null;
	bbox: SupBbox | null;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	/** Canonical datum-aware limits, precomputed at load. No legacy-FL999
	 *  normalization here: cmd/supaip's historic UNL encoding (FL660) is
	 *  indistinguishable from a genuinely printed FL660 and is fixed at
	 *  the source; regenerated data carries the explicit UNL triple. */
	vLower: VLimit | null;
	vUpper: VLimit | null;
	geometrySource: SupAipSource;
	/** Scheduled activation windows; empty when the PDF stated none. */
	activations: SupAipActivation[];
	/** The designators whose published lateral limits the zone adopts, for a
	 *  zone the supplement states "Identiques à celles de la zone LF-D5"
	 *  with no coordinates of its own; empty otherwise. Such a zone has no
	 *  geometry: the referenced airspace is already on the map, so the panel
	 *  states the reference rather than the map drawing a duplicate ring. */
	sameAs: string;
}

/** One "Activité réelle connue de" entry: the unit holding a zone's real-time
 * status and the frequencies to reach it on. `note` carries a non-numeric value
 * ("fréquences de contrôle") when the SUP gives one instead of figures. */
export interface SupAipContact {
	unit: string;
	freqs: string[];
	note?: string;
}

/** The CONDITIONS DE PÉNÉTRATION rule: a classified `kind` plus the verbatim
 * (French) rule text. */
export interface SupAipPenetration {
	kind: 'circumvent' | 'forbidden' | 'conditional' | 'other';
	text: string;
}

export interface SupAip {
	/** Stable unique id: "<region>-<year>-<NNN>". */
	id: string;
	/** "012/2026". */
	title: string;
	/** Parsed from title; drives the cross-link to NOTAM "AIP SUP NNN/YY". */
	number: number;
	year: number;
	/** Region key: metropole, car-sam-nam, pac-n, pac-p, run. */
	region: string;
	descriptionFr: string;
	descriptionEn: string;
	lieu: string;
	/** Absolute SIA PDF URL (French). */
	urlPdf: string;
	/** Absolute SIA PDF URL (English), '' when no _en.pdf exists. */
	urlPdfEn: string;
	/** Validity window, YYYY-MM-DD, or null when the listing omitted it. */
	validFrom: string | null;
	validTo: string | null;
	ifr: boolean;
	vfr: boolean;
	/** AIRAC supplement (lf_sup_a_*). */
	airac: boolean;
	/** Affected FIR / aerodrome ICAO idents, parsed from the PDF. */
	fir: string[];
	adhp: string[];
	/** Named sub-zones, each an independently-drawable area. */
	zones: SupAipZone[];
	/** Union bounding box over all zones, or null. */
	bbox: SupBbox | null;
	geometrySource: SupAipSource;
	parseConfidence: string;
	/** Machine-readable parse-quality codes (sorted, possibly empty). */
	warnings: string[];
	/** SUP-level coordination block parsed from the PDF (cmd/supaip contacts.go):
	 * the real-activity radio contacts, the penetration rule, and the managing
	 * unit. Empty / null when the supplement carries none. */
	contacts: SupAipContact[];
	penetration: SupAipPenetration | null;
	manager: string;
}

type RawBbox = [number, number, number, number] | null;

interface RawZone {
	name: string;
	geometry: SupAipGeometry | null;
	bbox: RawBbox;
	lower: VerticalLimit | null;
	upper: VerticalLimit | null;
	geometrySource: string;
	activations?: SupAipActivation[];
	sameAs?: string;
}

// Positional row layout, matching outputFields in cmd/supaip/api.go.
type SupAipRow = readonly [
	id: string,
	title: string,
	region: string,
	descriptionFr: string,
	descriptionEn: string,
	lieu: string,
	urlPdf: string,
	validFrom: string,
	validTo: string,
	ifr: boolean,
	vfr: boolean,
	airac: boolean,
	fir: string[],
	adhp: string[],
	zones: RawZone[],
	bbox: RawBbox,
	geometrySource: string,
	parseConfidence: string,
	warnings: string[],
	urlPdfEn: string,
	contacts: SupAipContact[],
	penetration: SupAipPenetration | null,
	manager: string,
];

interface RawSupAip {
	fields: string[];
	rows: readonly SupAipRow[];
}

function toBbox(b: RawBbox): SupBbox | null {
	return b ? { minLat: b[0], minLon: b[1], maxLat: b[2], maxLon: b[3] } : null;
}

function rowToSupAip(r: SupAipRow): SupAip {
	const title = r[1];
	const slash = title.indexOf('/');
	const number = slash > 0 ? parseInt(title.slice(0, slash), 10) : NaN;
	const year = slash > 0 ? parseInt(title.slice(slash + 1), 10) : NaN;
	const zones: SupAipZone[] = (r[14] ?? []).map((z) => ({
		name: z.name ?? '',
		geometry: z.geometry ?? null,
		bbox: toBbox(z.bbox),
		lower: z.lower ?? null,
		upper: z.upper ?? null,
		vLower: fromTriple(z.lower ?? null),
		vUpper: fromTriple(z.upper ?? null),
		geometrySource: (z.geometrySource as SupAipSource) ?? 'none',
		activations: z.activations ?? [],
		sameAs: z.sameAs ?? '',
	}));
	return {
		id: r[0],
		title,
		number,
		year,
		region: r[2],
		descriptionFr: r[3] ?? '',
		descriptionEn: r[4] ?? '',
		lieu: r[5] ?? '',
		urlPdf: r[6] ?? '',
		urlPdfEn: r[19] ?? '',
		validFrom: r[7] || null,
		validTo: r[8] || null,
		ifr: !!r[9],
		vfr: !!r[10],
		airac: !!r[11],
		fir: r[12] ?? [],
		adhp: r[13] ?? [],
		zones,
		bbox: toBbox(r[15]),
		geometrySource: (r[16] as SupAipSource) ?? 'none',
		parseConfidence: r[17] ?? 'none',
		warnings: r[18] ?? [],
		contacts: r[20] ?? [],
		penetration: r[21] ?? null,
		manager: r[22] ?? '',
	};
}

export const SUPAIP_URL = '/data/fr-supaip.json';

/** Belgian AIP Supplements (cmd/be, the skeyes eSUP section). Same row
 *  schema; region 'be', English-only subjects, urlPdfEn carrying the
 *  supplement's HTML page (no PDF twins exist). */
export const BE_SUPAIP_URL = '/data/be-supaip.json';

/** Load the SUP AIP artefact. Fail-soft: an HTTP error or a non-JSON 200
 *  (Vite dev's SPA fallback) returns [] so the rest of the map still
 *  renders. */
export async function loadSupAip(url: string = SUPAIP_URL): Promise<SupAip[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawSupAip;
	return data.rows.map(rowToSupAip);
}
