/* Loader and types for the generated airports dataset (public/data/airports.json). */

import type { Publisher } from '$lib/state/layers.svelte';

export interface LightLine {
	/** Position: EDGE / THR / END / CL / TDZ / SWYCL / OTHER. */
	psn: string;
	/** Colour: WHI / RED / GRN / BLU / YEL (may be '' when unpublished). */
	colour: string;
	/** Intensity: LIH / LIM / LIL (may be '' when unpublished). */
	intst: string;
}

/** One runway direction's AD 2.14 approach-and-runway lighting. */
export interface RunwayLighting {
	/** Runway light lines (AIXM `Rls`). */
	lines: LightLine[];
	/** VASIS/PAPI approach-slope indicator (AIXM `Rdn`): [type, side], or null. */
	papi: [string, string] | null;
	/** Approach lighting system (AIXM `Rda`): [type, lengthMetres], or null. */
	als: [string, number | null] | null;
}

export interface Runway {
	le: string;
	he: string;
	lengthFt: number | null;
	widthFt: number | null;
	surface: string;
	lit: boolean;
	/** Per-direction declared distances from AIXM (France `<Rdd>`,
	 *  UK + Spain `RunwayDeclaredDistance` via `RunwayCentrelinePoint`).
	 *  `null` for OurAirports-sourced rows and for directions the
	 *  publisher doesn't list (asymmetric publication: LEMD 14R has
	 *  TORA / TODA / ASDA but no LDA; 32L has LDA but no TORA). */
	leLdaFt: number | null;
	leToraFt: number | null;
	leTodaFt: number | null;
	leAsdaFt: number | null;
	heLdaFt: number | null;
	heToraFt: number | null;
	heTodaFt: number | null;
	heAsdaFt: number | null;
	/** Per-direction AD 2.14 lighting (Rls light lines + Rda approach lighting
	 *  + Rdn VASIS/PAPI). Null for the OurAirports / UK / ES rows and for a
	 *  direction with no published lighting. */
	leLighting: RunwayLighting | null;
	heLighting: RunwayLighting | null;
	/** The physical ends, [lat, lon], from the French AIXM's runway
	 *  centreline points. Null for every other source, and for a French
	 *  strip the AIXM files none for. */
	lePos: readonly [number, number] | null;
	hePos: readonly [number, number] | null;
}

/** Aerodrome public-access classification, derived from the GAT FlightClass
 *  rows in the AIXM `<Ahu>`.
 *  - `cap`; open to general civilian air traffic ("ouvert à la CAP")
 *  - `restricted`; private use only or no civilian access ("usage restreint")
 *  - `null`; unknown (non-French / pre-AIXM rows) */
export type AirportAccess = 'cap' | 'restricted' | null;

/** One radio service for an aerodrome. Same shape as `AirspaceRadio`.
 *  - `freq`; published MHz string (e.g. "119.3"), formatted to 3 decimals
 *    at display time via `formatFreqMHz`.
 *  - `unit`; curated service label (TWR / APP / ATIS / AFIS / A/A / GND / …),
 *    coalesced on in the nav-log.
 *  - `call`; spoken call sign (e.g. "GRENOBLE - TOUR"); may be empty. */
export interface AirportRadio {
	freq: string;
	unit: string;
	call: string;
}

export interface Airport {
	ident: string;
	type: string;
	name: string;
	lat: number;
	lon: number;
	elevFt: number | null;
	/** Published transition altitude (ft), from the AIXM overlays only (the
	 *  OurAirports baseline has no such column). null = not published; a
	 *  meaningful absence for France, where only aerodromes under a TMA carry
	 *  one (AIP ENR 1.7). */
	transitionAltFt: number | null;
	country: string;
	city: string;
	iata: string;
	runways: Runway[];
	access: AirportAccess;
	military: boolean;
	/** Shared civil + military aerodrome (AIXM controlType JOINT, or a French
	 *  STATE + GAT field). AIXM-only; false for the OurAirports baseline. */
	joint: boolean;
	/** Civilian VFR operations allowed (codeRule contains V on a GAT FlightClass). */
	vfr: boolean;
	/** Civilian IFR operations allowed (codeRule contains I on a GAT FlightClass). */
	ifr: boolean;
	/** Curated radio frequencies. OurAirports supplies the worldwide baseline
	 *  (airport-frequencies.csv); the FR / UK AIXM overlay replaces it with
	 *  authoritative data where available (Spain stays OurAirports-only). */
	radios: AirportRadio[];
	/** Highest-priority AIXM publisher that contributed to this row, or
	 *  null for OurAirports-only entries (the worldwide baseline). Used
	 *  by the Layers tab's per-publisher visibility toggle. Late-merging
	 *  publishers win: FR < UK < ES < BE (matches mergeAixmOverlay's order). */
	source: Publisher | null;
	/** Published chart links (VAC / ADC / IAC / ...), STORED in the dataset.
	 *  Belgium only: skeyes' chart PDFs carry per-amendment version suffixes
	 *  that cannot be derived at runtime, so cmd/be re-extracts them every
	 *  cycle; the other publishers derive their links at render (chartLink).
	 *  Always an array (empty for every non-BE row) so mergeAixmOverlay's
	 *  hand-built rows can't silently drop the column. */
	charts: AirportChart[];
}

/** One stored chart link: `code` is the chart family from the filename
 *  stem (VAC / ADC / AOC / IAC / SID / STAR / ...), `title` the published
 *  row title, `url` the absolute PDF URL on the always-current eAIP_Main
 *  base. */
export interface AirportChart {
	code: string;
	title: string;
	url: string;
}

// Positional row layouts, matching outputFields / runwayFields /
// frequencyFields in cmd/airports/build.go. Drift between the Go emitter and
// these tuples surfaces as a TS error at the loader, not a silent runtime
// miscast. The trailing columns are tolerance-loaded: an older file without
// `frequencies` (index 15) leaves r[15] undefined (defaulted to an empty
// list), and `transition_alt_ft` (index 16) exists only in the AIXM overlays
// (fr/uk/es), so the 16-column worldwide baseline leaves r[16] undefined
// (defaulted to null).
type RunwayRow = readonly [
	le: string,
	he: string,
	lengthFt: number | null,
	widthFt: number | null,
	surface: string,
	lit: 0 | 1,
	leLdaFt: number | null,
	leToraFt: number | null,
	leTodaFt: number | null,
	leAsdaFt: number | null,
	heLdaFt: number | null,
	heToraFt: number | null,
	heTodaFt: number | null,
	heAsdaFt: number | null,
	// Tolerance-loaded trailing lighting columns (fr AIXM only; the worldwide /
	// UK / ES rows omit them, defaulted to null).
	leLgt?: RawLighting | null,
	heLgt?: RawLighting | null,
	// The physical runway ends, [lat, lon] (fr AIXM <Rcp> only; every other
	// source omits them, defaulted to null).
	lePos?: readonly [number, number] | null,
	hePos?: readonly [number, number] | null,
];

type FreqRow = readonly [freq: string, unit: string, call: string];

type ChartRow = readonly [code: string, title: string, url: string];

type AirportRow = readonly [
	ident: string,
	type: string,
	name: string,
	lat: number,
	lon: number,
	elevFt: number | null,
	isoCountry: string,
	municipality: string,
	iata: string,
	runways: readonly RunwayRow[],
	access: AirportAccess,
	military: boolean,
	vfr: boolean,
	ifr: boolean,
	joint: boolean,
	frequencies: readonly FreqRow[],
	transitionAltFt?: number | null,
	charts?: readonly ChartRow[],
];

interface RawAirports {
	fields: string[];
	runwayFields: string[];
	frequencyFields?: string[];
	rows: readonly AirportRow[];
}

function rowToAirport(r: AirportRow): Airport {
	return {
		ident: r[0],
		type: r[1],
		name: r[2],
		lat: r[3],
		lon: r[4],
		elevFt: r[5],
		country: r[6],
		city: r[7],
		iata: r[8],
		runways: r[9].map(rowToRunway),
		access: r[10],
		military: r[11],
		vfr: r[12],
		ifr: r[13],
		joint: r[14] === true,
		// Tolerance-loaded trailing columns; an older / baseline file
		// without them leaves the elements undefined.
		radios: (r[15] ?? []).map(rowToRadio),
		transitionAltFt: r[16] ?? null,
		source: null,
		charts: (r[17] ?? []).map(rowToChart),
	};
}

function rowToChart(c: ChartRow): AirportChart {
	return { code: c[0], title: c[1], url: c[2] };
}

function rowToRadio(f: FreqRow): AirportRadio {
	return { freq: f[0], unit: f[1], call: f[2] };
}

function rowToRunway(w: RunwayRow): Runway {
	return {
		le: w[0],
		he: w[1],
		lengthFt: w[2],
		widthFt: w[3],
		surface: w[4],
		lit: w[5] === 1,
		leLdaFt: w[6],
		leToraFt: w[7],
		leTodaFt: w[8],
		leAsdaFt: w[9],
		heLdaFt: w[10],
		heToraFt: w[11],
		heTodaFt: w[12],
		heAsdaFt: w[13],
		leLighting: rowToLighting(w[14]),
		heLighting: rowToLighting(w[15]),
		lePos: rowToPos(w[16]),
		hePos: rowToPos(w[17]),
	};
}

function rowToPos(
	p: readonly [number, number] | null | undefined,
): readonly [number, number] | null {
	return Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
		? [p[0], p[1]]
		: null;
}

/** The raw per-end lighting object emitted by cmd/fr (null when unlit). */
interface RawLighting {
	lines: (readonly [string, string, string])[];
	papi?: readonly [string, string];
	als?: readonly [string, number | null];
}

function rowToLighting(raw: RawLighting | null | undefined): RunwayLighting | null {
	if (!raw) {
		return null;
	}
	return {
		lines: raw.lines.map((l) => ({ psn: l[0], colour: l[1], intst: l[2] })),
		papi: raw.papi ? [raw.papi[0], raw.papi[1]] : null,
		als: raw.als ? [raw.als[0], raw.als[1]] : null,
	};
}

/** Worldwide OurAirports baseline URL. cmd/airports emits this file. */
export const AIRPORTS_URL = '/data/airports.json';

/** French AIXM airport enrichment URL. cmd/fr emits this file. Caller may
 *  override to fetch the pre-release fr-airports.next.json. */
export const FR_AIRPORTS_URL = '/data/fr-airports.json';

/** UK AIXM airport enrichment URL. cmd/uk emits this file. */
export const UK_AIRPORTS_URL = '/data/uk-airports.json';

/** UK AIXM airport enrichment pre-release URL (cmd/uk -target auto). */
export const UK_AIRPORTS_NEXT_URL = '/data/uk-airports.next.json';

/** Spain AIXM airport enrichment URL. cmd/es emits this file. */
export const ES_AIRPORTS_URL = '/data/es-airports.json';

/** Spain AIXM airport enrichment pre-release URL (cmd/es -target auto). */
export const ES_AIRPORTS_NEXT_URL = '/data/es-airports.next.json';

/** Belgium & Luxembourg airport enrichment URL. cmd/be emits this file
 *  (skeyes eAIP AD 2 aerodromes + AD 3 heliports, chart links included). */
export const BE_AIRPORTS_URL = '/data/be-airports.json';

/** Belgium & Luxembourg pre-release URL (cmd/be, eAIP_Next slot). */
export const BE_AIRPORTS_NEXT_URL = '/data/be-airports.next.json';

/** Germany airport enrichment URL. cmd/de emits this file (DFS AIXM 5.1.1
 *  AirportHeliport + Runway + Service). */
export const DE_AIRPORTS_URL = '/data/de-airports.json';

/** Germany pre-release URL (cmd/de -target auto). */
export const DE_AIRPORTS_NEXT_URL = '/data/de-airports.next.json';

/** Austria airport enrichment URL. cmd/at emits this file from the Austro
 *  Control Luftraumstruktur KML (position, elevation, longest runway). */
export const AT_AIRPORTS_URL = '/data/at-airports.json';

/** Austria pre-release URL (cmd/at -target auto). */
export const AT_AIRPORTS_NEXT_URL = '/data/at-airports.next.json';

/** Georgia aerodromes. */
export const GE_AIRPORTS_URL = '/data/ge-airports.json';
export const GE_AIRPORTS_NEXT_URL = '/data/ge-airports.next.json';

/** Netherlands aerodromes, split by LVNL across civil / military / joint
 *  layers, which is the status the OurAirports baseline lacks. */
export const NL_AIRPORTS_URL = '/data/nl-airports.json';
export const NL_AIRPORTS_NEXT_URL = '/data/nl-airports.next.json';

/** Italy aerodromes (open flightmaps). */
export const IT_AIRPORTS_URL = '/data/it-airports.json';
export const IT_AIRPORTS_NEXT_URL = '/data/it-airports.next.json';

/** US aerodromes, from the FAA AIS hub's US_Airport / Runways /
 *  Frequencies layers. Many are filed under a local FAA code rather than
 *  an ICAO indicator ("00A"), which is what mergeAixmOverlay's
 *  ICAO-shaped-ident rule and its proximity fallback exist for. */
export const FAA_AIRPORTS_URL = '/data/faa-airports.json';
export const FAA_AIRPORTS_NEXT_URL = '/data/faa-airports.next.json';

export async function loadAirports(url: string = AIRPORTS_URL): Promise<Airport[]> {
	// Absolute path so v1 (served at /) and v2 (served at /v2/) share the
	// single canonical /data/airports.json; see the deploy workflow.
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	const data = (await res.json()) as RawAirports;
	return data.rows.map(rowToAirport);
}

/** Load a per-country AIXM airport overlay as a parallel slice. Each
 *  row is tagged with `source = publisher` so the Layers tab's
 *  per-publisher toggle can later hide them. Fail-soft: an HTTP error
 *  OR a non-JSON 200 (Vite dev's SPA fallback) returns [] so the
 *  worldwide baseline still renders. */
export async function loadFrAirports(
	url: string = FR_AIRPORTS_URL,
	publisher: Publisher = 'fr',
): Promise<Airport[]> {
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
	const data = (await res.json()) as RawAirports;
	return data.rows.map((r) => ({ ...rowToAirport(r), source: publisher }));
}

/** Normalise OurAirports' inconsistent surface codes to readable labels. */
const SURFACE_LABELS: Record<string, string> = {
	ASP: 'Asphalt', ASPH: 'Asphalt', 'ASPH-G': 'Asphalt', BIT: 'Bitumen', MAC: 'Macadam',
	CON: 'Concrete', CONC: 'Concrete', PEM: 'Concrete',
	TURF: 'Grass', 'TURF-G': 'Grass', GRS: 'Grass', GRE: 'Grass', GRA: 'Grass', GRASS: 'Grass',
	GVL: 'Gravel', GRVL: 'Gravel',
	WATER: 'Water', WTR: 'Water',
	SNOW: 'Snow', ICE: 'Ice',
	SAND: 'Sand', CORAL: 'Coral',
	DIRT: 'Dirt', EARTH: 'Dirt',
	UNK: '', UNKNOWN: '',
};

export function formatSurface(raw: string): string {
	if (!raw) {
		return '';
	}
	const up = raw.toUpperCase().trim();
	if (SURFACE_LABELS[up] !== undefined) {
		return SURFACE_LABELS[up];
	}
	if (up.startsWith('ASP')) return 'Asphalt';
	if (up.startsWith('CON') || up.startsWith('PEM')) return 'Concrete';
	if (up.startsWith('TURF') || up.startsWith('GRS') || up.startsWith('GRA') || up.startsWith('GRE'))
		return 'Grass';
	if (up.startsWith('GVL') || up.startsWith('GRV')) return 'Gravel';
	return raw;
}

export function prettyAirportType(type: string): string {
	const s = type.replace(/_/g, ' ');
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The frequencies to OFFER for a field, which is none for a closed one.
 *  A closed aerodrome keeps whatever channels its row was published with
 *  (EDCK still carries Langen Information and Koethen Radio), and the detail
 *  panel keeps printing them as the published record; but nothing that
 *  PROPOSES a frequency may hand the pilot a field that is not there to
 *  answer. Flying to one stays perfectly ordinary, a disused strip is a
 *  classic visual landmark, so the gate is on the radio alone and never on
 *  the waypoint. THE definition of the rule, shared by the nav log's radio
 *  column and its export, the live contact chain and the overflown-aerodrome
 *  scan. An ident the dataset does not know yields the same empty list, so a
 *  lookup can be chained straight into it. */
export function contactRadios(a: Airport | null | undefined): AirportRadio[] {
	return a && a.type !== 'closed' ? a.radios : [];
}

/* ----------------------------------------------------------------------------
 * Aerodrome chart links
 *
 * The detail panel links each airport to its official charts; the scheme
 * differs by publisher:
 *
 *  - France (SIA): a direct per-aerodrome "Carte VAC" PDF, at a URL keyed on
 *    the current AIRAC cycle. There is no stable redirect; the path's dated
 *    segment rotates every 28 days, so we compute the active AIRAC effective
 *    date from the worldwide 28-day cycle (anchored at cycle 2401, effective
 *    25 Jan 2024). The PDF endpoint returns the same 404 for "unknown ICAO"
 *    and "no VAC published" (military / grass fields), so the link is gated on
 *    civilian airport types.
 *  - France IFR (SIA): the instrument charts (IAC / SID / STAR / ADC) live in
 *    the eAIP proper, not the Atlas VAC: each IFR aerodrome has an
 *    FR-AD-2.<ICAO> HTML page (AD 3 for the two IFR heliports) embedding
 *    every chart as an individual PDF, on the same AIRAC-dated tree as the
 *    VAC. Only the -fr-FR variant exists (its content is bilingual), and the
 *    chart section carries a uniform anchor (AD-2.24.eAIP.<ICAO>, heliports
 *    AD-3.23...). VFR-only fields have no such page (404), so the link is
 *    gated on the AIXM `ifr` flag; the LF prefix excludes the overseas
 *    territories (and Jersey), whose ifr rows belong to other eAIPs.
 *  - UK (NATS): no derivable per-chart URL (UK charts carry internal
 *    graphic-reference numbers), so we link the official AD 2 aerodrome
 *    page, which lists the VAC plus the aerodrome and approach charts.
 *    AIRAC-dated.
 *  - Spain (ENAIRE): no stable per-chart PDF URL (VAC sheets are numbered
 *    irregularly, some sit in per-chart subfolders, co-located fields share
 *    a combined folder, and busy IFR airports have no VAC at all), and the
 *    per-aerodrome HTML page 404s once a field is amended. ENAIRE's own AD 2
 *    pages cite a hash-routed viewer (`/AIP/#ICAO`) as the aerodrome's chart
 *    list, so we link that. Stable URL (no AIRAC date).
 *
 * `chartLink` (the best VFR / general chart link) and `ifrChartLink` (the
 * France-only instrument-chart link beside it) are the two resolvers the
 * panel calls.
 * ------------------------------------------------------------------------- */

import { currentAiracString, currentAiracIso } from '$lib/data/airac';

/** Airport types that carry a published aerodrome chart set. Heliports,
 *  seaplane bases, balloon sites and closed fields generally don't (and the
 *  ENAIRE dataset alone has ~200 heliports with no AD 2 page). */
function isChartedAerodromeType(type: string): boolean {
	return (
		type === 'large_airport' ||
		type === 'medium_airport' ||
		type === 'small_airport'
	);
}

/** Which SIA Atlas VAC publishes an ident's visual approach plate. The atlas
 *  is two products under one tree, the aerodromes keyed by ICAO and the
 *  hélistations by the SIA `codeId` cmd/fr uses as the ident of an aerodrome
 *  published without a location indicator; a few large fields carry both.
 *  `null` = neither, which is a third of the French aerodromes we draw.
 *  Membership is data, not a guess: it comes from the atlas' own index,
 *  stored per ident by cmd/adcharts (`AerodromeCharts.vac`). */
export type VacAtlas = 'ad' | 'hel' | 'both';

/** Direct PDF URL of one SIA Atlas VAC plate, against the currently active
 *  AIRAC cycle. Section 2 is the aerodrome product (`VAC`, keyed by ICAO),
 *  section 3 the hélistation one (`VACH`, keyed by the SIA code); each
 *  product spells its own path, which is why the directory is not simply
 *  the section number. Only a code the atlas index carries resolves. */
export function siaAtlasVacUrl(code: string, section: 2 | 3): string {
	const id = code.toUpperCase();
	const product = section === 3 ? 'VACH' : 'VAC';
	return (
		'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_' +
		currentAiracString() +
		`/Atlas-VAC/PDF_AIPparSSection/${product}/AD/AD-${section}.` + id + '.pdf'
	);
}

/** Direct PDF URL of the SIA Carte VAC for the given ICAO (the aerodrome
 *  product), against the currently active AIRAC cycle. */
export function siaVacUrl(icao: string): string {
	return siaAtlasVacUrl(icao, 2);
}

/** html/eAIP/ directory (trailing slash) of the SIA eAIP tree in force at
 *  `now`. Both dated segments rotate with the AIRAC cycle; the AD 2 page
 *  links and the stored fr-adcharts chart paths resolve against it. */
export function siaEaipHtmlBase(now: number = Date.now()): string {
	return (
		'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_' +
		currentAiracString(now) +
		'/FRANCE/AIRAC-' + currentAiracIso(now) + '/html/eAIP/'
	);
}

/** SIA eAIP per-aerodrome page (AD 2, or AD 3 for heliports), anchored at
 *  its "charts related to the aerodrome" section (AD 2.24 / AD 3.23), which
 *  lists every instrument chart (IAC / SID / STAR / ADC / ...) as an
 *  individual PDF. Only the -fr-FR variant exists; its content is
 *  bilingual. */
export function siaAdUrl(icao: string, heliport: boolean, now: number = Date.now()): string {
	const id = icao.toUpperCase();
	const section = heliport ? 'AD-3' : 'AD-2';
	const chartSection = heliport ? 'AD-3.23' : 'AD-2.24';
	return (
		siaEaipHtmlBase(now) +
		'FR-' + section + '.' + id + '-fr-FR.html' +
		'#' + chartSection + '.eAIP.' + id
	);
}

/** Root of the UK NATS eAIP publication for the AIRAC cycle in force at
 *  `now` (trailing slash). The AD 2 / AD 3 pages sit under html/eAIP/ and
 *  the stored uk-adcharts chart paths (graphics/<n>.pdf) resolve against
 *  it. Rotates every cycle; there is no stable alias. */
export function natsEaipBase(now: number = Date.now()): string {
	return (
		'https://www.aurora.nats.co.uk/htmlAIP/Publications/' + currentAiracIso(now) + '-AIRAC/'
	);
}

/** UK NATS eAIP per-aerodrome page (AD 2 aerodromes, AD 3 heliports),
 *  keyed on the current AIRAC effective date. Lists the VAC plus all
 *  aerodrome / approach charts. Covers Great Britain, Northern Ireland
 *  and the Crown Dependencies (Jersey EGJJ, Guernsey EGJB, Alderney
 *  EGJA), all published in the UK AIP. */
export function natsAdUrl(icao: string, heliport: boolean, now: number = Date.now()): string {
	const section = heliport ? 'AD-3' : 'AD-2';
	return natsEaipBase(now) + 'html/eAIP/EG-' + section + '.' + icao.toUpperCase() + '-en-GB.html';
}

/** skeyes (Belgium & Luxembourg) eAIP per-aerodrome page: the AD 2
 *  (aerodromes) or AD 3 (heliports) section listing every published chart
 *  beside the aerodrome data. The eAIP_Main alias always serves the
 *  current cycle, so the URL is stable (no AIRAC date). */
export function skeyesAdUrl(icao: string, heliport: boolean): string {
	const section = heliport ? 'AD-3' : 'AD-2';
	return (
		'https://ops.skeyes.be/html/belgocontrol_static/eaip/eAIP_Main/html/eAIP/EB-' +
		section + '.' + icao.toUpperCase() + '-en-GB.html'
	);
}

/** ENAIRE (Spain) AIP viewer page listing an aerodrome's charts (visual
 *  approach / VAC, aerodrome, approach, etc.), keyed only on the ICAO.
 *  ENAIRE exposes no stable per-chart PDF URL: VAC sheets are numbered
 *  irregularly (VAC_1 / VAC_2), some live in per-chart subfolders,
 *  co-located fields share a combined folder (e.g. `LECU_LEVS`), and busy
 *  airports publish no VAC. ENAIRE's own AD 2 pages link this hash-routed
 *  viewer as "the list of charts related to the aerodrome", so it is the
 *  one reliable, derivable target (works for `GC*` / `GE*` too). Stable
 *  URL (no AIRAC date). */
export function enaireChartsUrl(icao: string): string {
	return 'https://aip.enaire.es/AIP/#' + icao.toUpperCase();
}

/** DFS German VFR eAIP landing page. Unlike the other publishers this is
 *  NOT aerodrome-specific: DFS exposes no machine-readable per-aerodrome
 *  index and its eAIP uses opaque hash URLs, so the link opens the eAIP for
 *  the pilot to search the field (see docs/de-aip.md). */
export const DFS_VFR_EAIP_URL = 'https://aip.dfs.de/BasicVFR/';

/** An external chart link for the airport detail panel. The label and
 *  tooltip are translated at render from `kind` (docs/i18n.md rule 6a),
 *  keeping this module locale-free. */
export interface ChartLink {
	/** Absolute URL, opened in a new tab. */
	url: string;
	/** Which chart product the link opens: the SIA Carte VAC PDF, the SIA
	 *  eAIP AD 2 / AD 3 aerodrome page (the instrument charts), the UK
	 *  NATS AD 2 aerodrome page, the ENAIRE AIP charts viewer, the skeyes
	 *  eAIP AD 2 / AD 3 aerodrome page, the Austro Control eAIP AD 2 / AD 3
	 *  section PDF, or the DFS German VFR eAIP (not aerodrome-specific: DFS
	 *  publishes no per-aerodrome deep link). */
	kind:
		| 'fr-vac'
		| 'fr-ad'
		| 'uk-ad'
		| 'es-ad'
		| 'be-ad'
		| 'de-ad'
		| 'de-ad-page'
		| 'at-ad'
		| 'us-dtpp';
}

/** Resolve the best official chart link for an airport, or `null` when none
 *  applies. France keeps its direct SIA Atlas VAC PDF; the UK links its AD 2
 *  aerodrome page and Spain its ENAIRE AIP charts page, both of which list
 *  the VAC plus all charts. Every gate is dataset membership rather than a
 *  guess: `frVac` for France, `source` for UK / Spain (membership in the
 *  national AIXM dataset guarantees a published AD 2 section), so a
 *  baseline-only EG/LE strip absent from the NATS / ENAIRE AIP gets no dead
 *  link. */
export function chartLink(
	airport: Airport,
	now: number = Date.now(),
	atAdUrl: string | null = null,
	deAdUrl: string | null = null,
	ukHasCharts: boolean = false,
	usAdUrl: string | null = null,
	frVac: VacAtlas | null = null,
): ChartLink | null {
	// France: the SIA Atlas VAC plate, offered only for an ident the atlas'
	// own index carries (`frVac`, from the lazily-loaded fr-adcharts
	// dataset). It replaced a shape-and-type heuristic that linked 117 of
	// the 536 French aerodromes we draw to a 404, Cazaux and Villacoublay
	// among them, and it is what reaches the hélistation plates, which are
	// keyed by the SIA code and outnumber the aerodromes we could guess.
	// A field the panel opens before the index lands gets no link yet, the
	// same beat as its "All charts" list.
	if (frVac) {
		const section = frVac === 'hel' || (frVac === 'both' && airport.type === 'heliport') ? 3 : 2;
		return { url: siaAtlasVacUrl(airport.ident, section), kind: 'fr-vac' };
	}
	// United States: the FAA d-TPP chart resolved by the caller (the
	// airport diagram, else the first chart). US airports arrive from the
	// OurAirports baseline with no `source`, so this gates on the country
	// and a resolved dataset row rather than a publisher tag.
	if (airport.country === 'US' && usAdUrl) {
		return { url: usAdUrl, kind: 'us-dtpp' };
	}
	const icao = airport.ident.toUpperCase();
	// Austria: the AD 2 / AD 3 section PDF of the eAIP edition in force,
	// resolved by the caller from the at-adcharts dataset (the edition
	// directory is dated by its own validity, so the URL is stored, not
	// derived). Its presence is proof the aerodrome has an AIP section,
	// which is the gate: the KML also carries private heliports that the
	// AIP does not publish.
	if (airport.source === 'at' && atAdUrl) {
		return { url: atAdUrl, kind: 'at-ad' };
	}
	// Belgium & Luxembourg: the skeyes AD 2 / AD 3 page. Stored charts are
	// proof of a published chart section, so a heliport with charts (a few
	// have a VAC) gets its AD 3 link even though heliports are otherwise
	// unchartered.
	if (airport.source === 'be' && (isChartedAerodromeType(airport.type) || airport.charts.length > 0)) {
		return { url: skeyesAdUrl(icao, airport.type === 'heliport'), kind: 'be-ad' };
	}
	// UK: NATS AD 2 (aerodromes) / AD 3 (the five published heliports)
	// page. A stored uk-adcharts chart list is proof of a published chart
	// section, so a heliport with charts (London Heliport EGLW) gets its
	// AD 3 link even though heliports are otherwise unchartered.
	if (airport.source === 'uk' && (isChartedAerodromeType(airport.type) || ukHasCharts)) {
		return { url: natsAdUrl(icao, airport.type === 'heliport', now), kind: 'uk-ad' };
	}
	// Spain: the ENAIRE AIP charts viewer, keyed by ICAO. The viewer lists
	// an aerodrome's or heliport's charts (visual, approach, ...); ENAIRE
	// publishes its AD 3 heliports in the same viewer, so heliports pass
	// too, matching France / Belgium / Austria.
	if (
		airport.source === 'es' &&
		(isChartedAerodromeType(airport.type) || airport.type === 'heliport')
	) {
		return { url: enaireChartsUrl(icao), kind: 'es-ad' };
	}
	// Germany: the DFS VFR eAIP aerodrome page, resolved by the caller
	// from the de-adcharts permalink index (a stable redirect stub, so
	// the URL is stored, not derived). Its presence is proof the field is
	// published, so a heliport in the index (the HEL AD section) links its
	// page too. A charted aerodrome the index omits falls back to the
	// generic eAIP landing page, kind 'de-ad', "search the field".
	if (airport.source === 'de') {
		if (deAdUrl) {
			return { url: deAdUrl, kind: 'de-ad-page' };
		}
		if (isChartedAerodromeType(airport.type)) {
			return { url: DFS_VFR_EAIP_URL, kind: 'de-ad' };
		}
	}
	return null;
}

/** Resolve the instrument-chart link for an airport, or `null` when none
 *  applies: rendered beside `chartLink`'s (France shows "Carte VAC ·
 *  Cartes IFR"). France-only: the UK / ENAIRE / skeyes pages `chartLink`
 *  already opens list the instrument charts themselves. Gated on the AIXM
 *  `ifr` flag, which today implies dataset membership (the OurAirports
 *  baseline carries no flight-rule flags); exactly the ifr aerodromes have
 *  an eAIP AD 2 page (VFR-only fields 404). `hasEaipCharts` (stored
 *  fr-adcharts rows exist for the ident) widens the gate like the skeyes
 *  heliport rule: the scrape is proof the page exists, which reaches the
 *  few military-run pages whose civil ifr flag is false (LFRJ). The LF
 *  prefix excludes the overseas territories (NT/NW/TF/FM/SOCA) and
 *  Jersey, whose ifr rows belong to other eAIPs; France's two ifr
 *  heliports (LFWF, LFWM) sit in AD 3. */
export function ifrChartLink(
	airport: Airport,
	now: number = Date.now(),
	hasEaipCharts = false,
): ChartLink | null {
	if ((!airport.ifr && !hasEaipCharts) || !airport.ident.toUpperCase().startsWith('LF')) {
		return null;
	}
	const heliport = airport.type === 'heliport';
	if (!heliport && !isChartedAerodromeType(airport.type)) {
		return null;
	}
	return { url: siaAdUrl(airport.ident, heliport, now), kind: 'fr-ad' };
}

/* ----------------------------------------------------------------------------
 * Stored-chart grouping (the Belgian per-chart rows)
 * ------------------------------------------------------------------------- */

/** One family of stored chart links, keyed by the `AirportChart.code`
 *  extracted from the published filename ('' when the row had none). */
export interface ChartGroup {
	code: string;
	charts: AirportChart[];
}

/** Display order of the known chart families: the instrument charts first
 *  (the reason the list is grouped), then visual, then the aerodrome /
 *  obstacle sheets, then the minimum-altitude surveillance charts (the
 *  SIA's AMG / AMSR / MVA naming generations and skeyes' ATCSMAC), with
 *  the SIA coding tables and text pages last (reference material, not
 *  charts). Codes outside this list (MIA, ATS, MISC, '' , future
 *  families) trail in first-appearance order. */
const CHART_FAMILY_ORDER = [
	'IAC', 'SID', 'STAR', 'DEP', 'ARC',
	'VAC', 'ENV',
	'ADC', 'GMC', 'APDC', 'AOC', 'PATC',
	'AMG', 'AMSR', 'MVA', 'ATCSMAC',
	'COM',
	'DATA', 'TEXT',
];

/** Group stored chart rows by family for the panel's collapsed list,
 *  preserving the published order inside each family. Locale-free: the
 *  panel translates each `code` to its ICAO Annex 4 chart name. */
export function groupChartsByFamily(charts: AirportChart[]): ChartGroup[] {
	const byCode = new Map<string, AirportChart[]>();
	for (const c of charts) {
		const list = byCode.get(c.code);
		if (list) {
			list.push(c);
		} else {
			byCode.set(c.code, [c]);
		}
	}
	const groups: ChartGroup[] = [];
	for (const code of CHART_FAMILY_ORDER) {
		const list = byCode.get(code);
		if (list) {
			groups.push({ code, charts: list });
			byCode.delete(code);
		}
	}
	for (const [code, list] of byCode) {
		groups.push({ code, charts: list });
	}
	return groups;
}
