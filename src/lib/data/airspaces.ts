/* Loader and types for the generated airspaces dataset
 * (public/data/fr-airspaces.json from cmd/fr). The loadOverlay helpers
 * below handle the FAA and pruatlas overlays, which use the same row
 * schema. */

import type { AirspaceCategory, Publisher } from '$lib/state/layers.svelte';
import { formatFreqMHz } from '$lib/format/radio';
import {
	NO_ENTRY,
	parseEntryConditions,
	type EntryConditions,
} from '$lib/data/airspaceEntry';
import {
	floorMinFt,
	ceilingMaxFt,
	fromTriple,
	type VLimit,
	type VerticalLimit,
} from '$lib/vertical/limits';

export type { VerticalLimit, VLimit };

export interface AirspaceRadio {
	freq: string;
	unit: string;
	call: string;
	/** True while a service-closure NOTAM withdraws this frequency (stamped by
	 *  the resolver, state/freqOverride.svelte.ts; never present on dataset
	 *  rows). The pure route / format modules read this one bit: a closed row
	 *  keeps its published value for display but is UNUSABLE as a contact, so
	 *  the ladder falls back to the published data underneath. Provenance
	 *  rides the resolver's own EffectiveAirspaceRadio. */
	closed?: boolean;
}

export interface Airspace {
	/** Shared parent designation; multiple Airspace rows can share an `id`
	 *  when the source data splits a single MOA / restricted area into a
	 *  parent ring plus exclusion sub-rings (e.g. all 8 "POWDER RIVER 2
	 *  LOW MOA" rows). Used for NOTAM-to-airspace activation matching. */
	id: string;
	/** Per-row unique selection identifier (`id + '|' + name`). Distinct
	 *  for every parent/exclusion sub-ring even when `id` is shared.
	 *  Used wherever a single row needs to be addressed: selection,
	 *  airspaceIndex lookup, highlight, ui.detail. */
	key: string;
	type: string;
	name: string;
	airClass: string;
	upper: VerticalLimit | null;
	lower: VerticalLimit | null;
	/** Canonical datum-aware limits, precomputed from the triples at load
	 *  time so the hot predicates (map altitude filter, route walks) do
	 *  float comparisons only. The raw triples above stay for the frozen
	 *  display strings (classACeilingLabel in the route YAML). */
	vUpper: VLimit | null;
	vLower: VLimit | null;
	/** AIXM Max / Mnm auxiliary limits; fr activity zones publish them
	 *  (e.g. a winch site "1000 ft ASFC, max 3300 ft ASFC"), every other
	 *  pipeline emits null. */
	vMax: VLimit | null;
	vMnm: VLimit | null;
	workHr: string;
	rmkWorkHr: string;
	rmk: string;
	/** The published entry conditions, per traffic category, parsed once at
	 *  load like the vertical limits (type R only; NO_ENTRY elsewhere).
	 *  Feeds both the live alert tier and the profile's forbidden-crossing
	 *  tier through the one shared `zoneEntryAction`. */
	entry: EntryConditions;
	radio: AirspaceRadio[];
	ring: [number, number][];
	/** External FIR boundary arcs, any publisher: the runs of the ring
	 *  NOT shared with a same-state same-type sibling FIR, split off by
	 *  the generators (internal/firarcs). Convention-neutral semantic
	 *  data: under the SIA convention the deco layer draws the ink
	 *  FIR-limit form along these and the de-emphasized grey form along
	 *  the internal chains; a future theme would restyle both without
	 *  touching the data. EMPTY = every run internal (a fully-surrounded
	 *  ring, e.g. a US interior centre, prints entirely de-emphasized);
	 *  absent = no siblings, full-ring ink. */
	arcs?: [number, number][][];
	/** AIXM txtLocalType verbatim (e.g. "VOL", "TRVL", "UAC" for D-OTHER
	 *  activity zones, "FBZ" / "TMZ" / etc. for RAS subtypes). Empty when
	 *  the source has no txtLocalType. Surfaced on the detail panel when
	 *  it adds info beyond the emitted `type`. */
	subtype: string;
	category: AirspaceCategory;
	/** Publisher of this row. Tagged at load time by the per-source
	 *  fetcher so the Layers tab can hide whole datasets without
	 *  rebuilding the merged list. */
	source: Publisher;
	/** Relative ring area (degree²); used to order airspaces, smallest on top. */
	area: number;
	/** Axis-aligned ring bounding box; a cheap pre-filter for spatial queries. */
	bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

interface RawAirspaces {
	fields: string[];
	rows: unknown[][];
}

const AIRSPACE_CATEGORY: Record<string, AirspaceCategory> = {
	TMA: 'controlled', CTR: 'controlled', CTA: 'controlled', ATZ: 'controlled',
	CLASS: 'controlled',
	// LTA (Lower Traffic Area) is the French national control area filling the
	// lower region FL 115 - FL 195 outside the named TMA / CTA / AWY; class D
	// or E. The 500k chart groups it with TMA / CTA (Legende2026, "Espaces
	// aeriens controles"). cmd/fr types it from txtLocalType, not codeActivity.
	LTA: 'controlled',
	TRSA: 'controlled', SATA: 'controlled', UTA: 'controlled',
	// French RAS subtypes that are still controlled airspace:
	// DLG-ATS = delegated ATS (one ANSP runs another's airspace),
	// FRA = Free Route Airspace (IFR routing aid in upper levels).
	'DLG-ATS': 'controlled', FRA: 'controlled',
	R: 'restricted', D: 'restricted', P: 'restricted',
	MOA: 'restricted', W: 'restricted', A: 'restricted',
	ADIZ: 'restricted', TFR: 'restricted',
	// CBA (Cross-Border Area) files with the restricted family: the
	// Legende2026 prints it in the R / D hatch row, not beside TRA.
	CBA: 'restricted',
	// D-OTHER sporting / recreational zones; cmd/airspaces splits these
	// by codeActivity. The generic ACTIVITY bucket carries the majority
	// (paragliding launch points, balloon centres, glider winch sites).
	// FBZ (Free Balloon Zone) is meteorological balloon activity at
	// high flight levels; same icon family.
	ACTIVITY: 'activity', PARAGLIDER: 'activity', PARACHUTE: 'activity',
	BALLOON: 'activity', GLIDER: 'activity', TOWING: 'activity',
	FBZ: 'activity',
	// French RAS subtypes (TMZ = Transponder Mandatory Zone, RMZ = Radio
	// Mandatory Zone) get their own category alongside controlled airspace.
	// TMZ-RMZ is a single zone that demands both.
	TMZ: 'trafficmgmt', RMZ: 'trafficmgmt', 'TMZ-RMZ': 'trafficmgmt',
	// TSA rides beside TRA (Belgium publishes TRA/TSA volumes).
	TRA: 'transit', TSA: 'transit',
	// The US centres (FAA ARTCC, foreign ACC rows in the FAA dataset) are
	// FIR-equivalents: they share the FIR comb symbol and the FIR / UIR
	// Layers-tab toggle, and their panels carry Item A) briefings (isFirLike).
	FIR: 'fir', UIR: 'fir', OCA: 'fir', ARTCC: 'fir', ACC: 'fir',
	// FIC = the FIR-level FIS sectors (PARIS / MARSEILLE Information and
	// the overseas equivalents; cmd/fr splits them off SIV by their
	// FIR-ident+FS codeId). Same family and Layers toggle as the APP SIVs,
	// but NOT charted: their limits ride the FIR boundaries and the 500k
	// prints "SIV APP" limits only, so the resolver draws them as nothing.
	SIV: 'siv', FIC: 'siv',
};

export function airspaceCategory(type: string): AirspaceCategory {
	return AIRSPACE_CATEGORY[type] ?? 'controlled';
}

/* satisfies (not an annotation) keeps the keys literal so the FR mirror in
 * $lib/i18n is key-checked against this canonical English table. */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/data.ts
export const AIRSPACE_TYPE_LABELS = {
	TMA: 'Terminal Control Area',
	CTR: 'Control Zone',
	CTA: 'Control Area',
	LTA: 'Lower Traffic Area',
	ATZ: 'Aerodrome Traffic Zone',
	R: 'Restricted Area',
	D: 'Danger Area',
	P: 'Prohibited Area',
	TRA: 'Temporary Reserved Area',
	TSA: 'Temporary Segregated Area',
	CBA: 'Cross-Border Area',
	FIR: 'Flight Information Region',
	UIR: 'Upper Information Region',
	SIV: 'Flight Information Sector',
	FIC: 'Flight Information Centre sector',
	OCA: 'Oceanic Control Area',
	ACC: 'Area Control Centre',
	ARTCC: 'Air Route Traffic Control Center',
	CLASS: 'Controlled Airspace',
	TRSA: 'Terminal Radar Service Area',
	SATA: 'Special Air Traffic Area',
	UTA: 'Upper Control Area',
	ADIZ: 'Air Defense Identification Zone',
	TFR: 'Temporary Flight Restriction',
	MOA: 'Military Operations Area',
	W: 'Warning Area',
	A: 'Alert Area',
	ACTIVITY: 'Aerial activity (sporting / recreational)',
	PARAGLIDER: 'Paragliding activity',
	PARACHUTE: 'Parachute dropping',
	BALLOON: 'Balloon activity',
	GLIDER: 'Glider winch launch',
	TOWING: 'Glider towing',
	TMZ: 'Transponder Mandatory Zone',
	RMZ: 'Radio Mandatory Zone',
	'TMZ-RMZ': 'Transponder + Radio Mandatory Zone',
	FBZ: 'Free Balloon Zone',
	'DLG-ATS': 'Delegated ATS airspace',
	FRA: 'Free Route Airspace',
} satisfies Record<string, string>;
// i18n-ignore-end

export function airspaceTypeLabel(type: string): string {
	// The table's keys are literal (for the i18n mirror); the data field is an
	// open string, so widen at the read.
	return (AIRSPACE_TYPE_LABELS as Record<string, string>)[type] ?? type;
}

/** Whether a type is a special-use zone whose designator (R / D / P) is drawn
 *  as a letter in the restricted-airspace red: on the vertical-profile column
 *  badge and in the right-click airspace menus. */
export function isZoneType(type: string): boolean {
	return type === 'R' || type === 'D' || type === 'P';
}

/** FIR-family row for NOTAM-ownership purposes: category 'fir' covers FIR /
 *  UIR / OCA plus the US centres (ARTCC: KZNY, KZAB, ...; and the foreign
 *  ACC rows of the FAA dataset), which a NOTAM's Item A) files under. */
export function isFirLike(a: Pick<Airspace, 'category' | 'type'>): boolean {
	return a.category === 'fir';
}

/** The ICAO location indicator a FIR-like row answers to: the id itself when
 *  it leads with four letters (LFFF, KZNY), the leading four letters of the
 *  suffixed national ids (uk EGTT001 → EGTT, EGGXOCA1 → EGGX); null when the
 *  id has no four-letter head (fr OCA4521) or the row is not FIR-like.
 *  France files its FIR and UIR under the same indicator (both LFFF), so the
 *  two rows deliberately resolve to the same briefing. */
export function firIdent(a: Pick<Airspace, 'id' | 'category' | 'type'>): string | null {
	if (!isFirLike(a)) {
		return null;
	}
	const m = /^([A-Z]{4})/.exec(a.id.toUpperCase());
	return m ? m[1] : null;
}

/** The single-letter chip drawn on an airspace's vertical-profile column.
 *  A Restricted / Danger / Prohibited area shows its designator (R / D / P)
 *  in the restricted-airspace red; any other airspace shows its ICAO class
 *  letter (A-G) in the accent colour. Null when the airspace has neither. */
export function airspaceBadge(
	a: Pick<Airspace, 'type' | 'airClass'>,
): { text: string; kind: 'class' | 'zone' } | null {
	if (isZoneType(a.type)) {
		return { text: a.type, kind: 'zone' };
	}
	return a.airClass ? { text: a.airClass, kind: 'class' } : null;
}

/** The nav-log schedule's one chip per row: `airspaceBadge`'s model made
 *  TOTAL over every schedule-relevant category (everything but the FIR
 *  family, which `scheduleRelevant` excludes). R / D / P keep the profile's
 *  zone chip (CBA joins them: a red zone-style "CBA" chip, the Legende2026
 *  files CBA with the R / D family) and classed controlled airspace its
 *  ICAO class chip, matching `airspaceBadge` exactly; every other row chips
 *  by category: the type code on the category ink (restricted W / A / MOA /
 *  ADIZ / TFR, transit TRA / TSA, trafficmgmt TMZ / RMZ, classless
 *  controlled on the accent), and SIV / activity zones an EMPTY filled
 *  square (text ''), the SIA chart's own boundary mark. Null only for
 *  category 'fir'. */
export interface AirspaceScheduleBadge {
	text: string;
	kind: 'class' | 'zone' | 'category';
	category: AirspaceCategory;
}

export function airspaceScheduleBadge(
	a: Pick<Airspace, 'type' | 'airClass' | 'category'>,
): AirspaceScheduleBadge | null {
	switch (a.category) {
		case 'fir':
			return null;
		case 'controlled':
			return a.airClass
				? { text: a.airClass, kind: 'class', category: a.category }
				: { text: a.type, kind: 'category', category: a.category };
		case 'restricted':
			return isZoneType(a.type) || a.type === 'CBA'
				? { text: a.type, kind: 'zone', category: a.category }
				: { text: a.type, kind: 'category', category: a.category };
		case 'siv':
		case 'activity':
			// The empty filled square: the chart's own SIV boundary mark, and
			// the activity family's swatch; the type text follows the chip.
			return { text: '', kind: 'category', category: a.category };
		default:
			// transit, trafficmgmt: the type code on the category ink.
			return { text: a.type, kind: 'category', category: a.category };
	}
}

/** ICAO Annex 11 airspace class summaries (A–G). satisfies (not an
 *  annotation) keeps the keys literal so the FR mirror in $lib/i18n is
 *  key-checked against this canonical English table. */
// i18n-ignore-start: canonical English class notes, FR mirror in $lib/i18n/fr/data.ts
export const AIRSPACE_CLASS_DESC = {
	A: 'IFR only: all flights separated; ATC clearance required.',
	B: 'IFR & VFR: all flights separated; ATC clearance required.',
	C: 'IFR & VFR: IFR separated from all, VFR from IFR; clearance required.',
	D: 'IFR & VFR: IFR separated from IFR; traffic info to VFR; clearance required.',
	E: 'IFR & VFR: IFR separated from IFR; clearance for IFR only.',
	F: 'IFR & VFR: advisory separation for IFR where practicable.',
	G: 'Uncontrolled: no separation; traffic information on request.',
} satisfies Record<string, string>;
// i18n-ignore-end

/* The datum-blind altitudeToFeet / formatVerticalLimit helpers are gone:
 * every consumer reads the precomputed vLower / vUpper (VLimit) through
 * the vertical core's endpoint helpers and formatVLimit. */

/* RAI (Radiodiffusion Automatique d'Information): the auto-info broadcast a
 * military / activable controlled airspace cites in its OWN remark as the single
 * frequency to monitor for its activation status, e.g. Orléans TMA's "Activity
 * known on RAI 122.7", "Deactivation announced by RAI 129.925", "RAI FREQ
 * 122.400", "RAI frequency 118.125". The official VAC cites this one frequency;
 * the AIXM, by contrast, Sae-links the whole controlling military approach's
 * frequency set (civil + military VHF and the 225-400 MHz UHF band) onto every
 * part of the airspace, so the raw radio list carries a dozen frequencies. The
 * nav-log and the radio/airspace schedule narrow to the RAI; the detail panel
 * keeps the full list and flags it. */

/** The RAI frequency a remark cites, or null. Keyed on the literal "RAI" token
 *  so the value bound to it is taken and a neighbouring FIS frequency is not
 *  (Mont-de-Marsan: "RAI 119.7. Activity known on PYRENEES INFO 126.525, ..."
 *  yields 119.7, not 126.525). An optional FREQ / FREQUENCY / FRÉQUENCE word and
 *  a trailing "MHz" are tolerated. */
export function raiFrequency(rmk: string): string | null {
	const m = /\bRAI\b[\s:]*(?:FR[EÉ]Q(?:UENCE|UENCY)?\.?\s*)?(\d{3}\.\d{1,3})/i.exec(rmk);
	return m ? m[1] : null;
}

/** Index in the airspace's radio list of its RAI frequency, or null when the
 *  remark cites none or the cited value isn't among the (AIXM-lumped) radios.
 *  Taken from the published `radio` order, which resolveAirspaceRadios
 *  preserves, so the index stays valid after a frequency-change override. */
export function raiRadioIndex(airspace: Pick<Airspace, 'rmk' | 'radio'>): number | null {
	const rai = raiFrequency(airspace.rmk);
	if (!rai) {
		return null;
	}
	const want = formatFreqMHz(rai);
	const i = airspace.radio.findIndex((r) => formatFreqMHz(r.freq) === want);
	return i >= 0 ? i : null;
}

/** Narrow a radio list to its single RAI entry by the index from raiRadioIndex,
 *  or return it unchanged when idx is null (no RAI cited / not present). The
 *  nav-log and radio/airspace schedule show only the RAI; the detail panel keeps
 *  the full list. Generic so it composes with the override-resolved
 *  EffectiveAirspaceRadio. */
export function narrowToRai<R>(radio: R[], idx: number | null): R[] {
	if (idx === null || idx < 0 || idx >= radio.length) {
		return radio;
	}
	return [radio[idx]];
}

/** Relative polygon area (shoelace, degree²); for smallest-on-top ordering. */
function ringArea(ring: [number, number][]): number {
	let a = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const [lat1, lon1] = ring[i];
		const [lat2, lon2] = ring[(i + 1) % n];
		a += lon1 * lat2 - lon2 * lat1;
	}
	return Math.abs(a) / 2;
}

/** Axis-aligned bounding box of a ring (single pass min/max). Inlined here
 *  rather than imported from notam/geometry.ts to keep that module's
 *  pointInRing import one-directional. */
function ringBbox(
	ring: [number, number][],
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
	let minLat = Infinity;
	let minLon = Infinity;
	let maxLat = -Infinity;
	let maxLon = -Infinity;
	for (const [lat, lon] of ring) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
	}
	return { minLat, minLon, maxLat, maxLon };
}

// Row layout (see cmd/airspaces/build.go outputFields):
/** FAA "value not provided" sentinels (`-9998`, `-9999`) sometimes survive
 *  into faa-airspaces.json as `['STD', '-9998', '']` triples. cmd/faa
 *  now drops them at build time, but read-time defence keeps stale data
 *  from rendering "Limits -9998 - -9998". The check matches only the exact
 *  sentinel values so genuine sub-sea-level MSL altitudes (Dead Sea airfields)
 *  survive. */
function cleanVerticalLimit(triple: unknown): VerticalLimit | null {
	if (!triple || !Array.isArray(triple) || triple.length < 3) {
		return null;
	}
	const t = triple as VerticalLimit;
	const n = parseFloat(t[1]);
	if (n === -9998 || n === -9999) {
		return null;
	}
	return t;
}

/** Coerce a raw dataset row cell (JSON string / number / null) to a string. */
function cell(v: unknown): string {
	return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

// [id, type, name, class, upper, lower, max, mnm, workHr, rmkWorkHr, rmk, radio, ring, subtype]
/** Positional row -> Airspace (exported for tests/airspacesLoader.spec.ts;
 *  the loaders below are the runtime callers). */
export function rowToAirspace(r: unknown[], source: Publisher): Airspace | null {
	const ring = r[12] as [number, number][] | undefined;
	if (!ring || ring.length < 3) {
		return null;
	}
	const type = cell(r[1]);
	const rawRadio = (r[11] as unknown[][] | undefined) ?? [];
	const id = cell(r[0]);
	const name = cell(r[2]);
	const upper = cleanVerticalLimit(r[4]);
	const lower = cleanVerticalLimit(r[5]);
	// fr / faa / pruatlas datasets encode "unlimited" as the legacy FL999
	// (fr also has one FL9999 row); uk / es encode it as null in legacy
	// data (unknowable at load) and all pipelines emit the explicit UNL
	// triple going forward.
	const vOpts = {
		legacyFl999Unl: source === 'fr' || source === 'faa' || source === 'pruatlas',
	};
	return {
		id,
		// `id` alone isn't unique; see Airspace.key. Names differ even when
		// ids collide, so `id|name` is a stable per-row identifier.
		key: `${id}|${name}`,
		type,
		name,
		airClass: cell(r[3]),
		upper,
		lower,
		vUpper: fromTriple(upper, vOpts),
		vLower: fromTriple(lower, vOpts),
		vMax: fromTriple(cleanVerticalLimit(r[6]), vOpts),
		vMnm: fromTriple(cleanVerticalLimit(r[7]), vOpts),
		workHr: cell(r[8]),
		rmkWorkHr: cell(r[9]),
		rmk: cell(r[10]),
		entry: type === 'R' ? parseEntryConditions(cell(r[10]), cell(r[8])) : NO_ENTRY,
		radio: rawRadio.map((x) => ({
			freq: cell(x[0]),
			unit: cell(x[1]),
			call: cell(x[2]),
		})),
		ring,
		// r[13] only exists on rows from cmd/airspaces (which always emits
		// it, possibly empty); older overlay artefacts use a 13-field
		// schema so r[13] is undefined for those rows.
		subtype: cell(r[13]),
		// r[14] (arcs): FIR-family rows with same-state same-type
		// siblings, any publisher. An EMPTY array is meaningful (every
		// run internal: a fully-surrounded ring like a US interior
		// centre renders entirely in the de-emphasized form), so only
		// null / absent map to "no arcs" (exactOptionalPropertyTypes:
		// omit, never assign undefined).
		...(Array.isArray(r[14])
			? { arcs: r[14] as [number, number][][] }
			: {}),
		category: airspaceCategory(type),
		source,
		area: ringArea(ring),
		bbox: ringBbox(ring),
	};
}

/** Default URL; the caller may override to fetch the pre-release
 *  fr-airspaces.next.json once it becomes active. */
export const AIRSPACES_URL = '/data/fr-airspaces.json';

export async function loadAirspaces(url: string = AIRSPACES_URL): Promise<Airspace[]> {
	// Absolute path; same shared /data/ location as airports.json.
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`${url}: HTTP ${res.status}`);
	}
	const data = (await res.json()) as RawAirspaces;
	const out: Airspace[] = [];
	for (const row of data.rows) {
		const a = rowToAirspace(row, 'fr');
		if (a) {
			out.push(a);
		}
	}
	return out;
}

/** Fail-soft sibling loader; an HTTP error OR a non-JSON 200 (Vite's
 *  dev server returns index.html for missing files, not 404) returns
 *  [] so the rest of the overlay still renders. Used by every overlay
 *  loader below. */
async function loadOverlay(url: string, source: Publisher): Promise<Airspace[]> {
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`${url}: HTTP ${res.status}`);
		return [];
	}
	const ct = res.headers.get('content-type') ?? '';
	if (!ct.includes('json')) {
		// Vite's SPA fallback serves index.html with Content-Type
		// text/html when the static file is absent; treat it as missing.
		console.warn(`${url}: not JSON (got ${ct || 'no content-type'})`);
		return [];
	}
	const data = (await res.json()) as RawAirspaces;
	const out: Airspace[] = [];
	for (const row of data.rows) {
		const a = rowToAirspace(row, source);
		if (a) {
			out.push(a);
		}
	}
	return out;
}

/** Worldwide FIR/UIR overlay from cmd/pruatlas (EUROCONTROL pruatlas
 *  upstream). Same row schema as airspaces.json. */
export function loadPruatlasFirs(): Promise<Airspace[]> {
	return loadOverlay('/data/pruatlas-firs.json', 'pruatlas');
}

/** US airspace overlay from cmd/faa (FAA Boundary + Special_Use + Class).
 *  Same row schema as airspaces.json. */
export function loadFaaAirspaces(): Promise<Airspace[]> {
	return loadOverlay('/data/faa-airspaces.json', 'faa');
}

/** UK airspace overlay from cmd/uk (NATS AIXM 5.1 ICAO AIP Dataset).
 *  Same row schema as fr-airspaces.json. Fail-soft: returns [] when
 *  the file is absent (before an operator commits the first UK
 *  cycle, the file isn't yet in the repo). Caller may override the
 *  URL to fetch the pre-release uk-airspaces.next.json once it
 *  becomes active. */
export function loadUkAirspaces(url: string = '/data/uk-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'uk');
}

export const UK_AIRSPACES_URL = '/data/uk-airspaces.json';
export const UK_AIRSPACES_NEXT_URL = '/data/uk-airspaces.next.json';

/** Spain airspace overlay from cmd/es (ENAIRE AIXM 5.1). Same row
 *  schema as fr-airspaces.json; fail-soft for the same reason as
 *  loadUkAirspaces. Caller may override the URL to fetch the
 *  pre-release es-airspaces.next.json. */
export function loadEsAirspaces(url: string = '/data/es-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'es');
}

export const ES_AIRSPACES_URL = '/data/es-airspaces.json';
export const ES_AIRSPACES_NEXT_URL = '/data/es-airspaces.next.json';

/** Belgium & Luxembourg airspace overlay from cmd/be (skeyes eAIP; the
 *  joint AIP covers both countries). Same row schema as
 *  fr-airspaces.json; fail-soft like loadUkAirspaces. FIR / UIR rows are
 *  absent on purpose: pruatlas ships the EBBU ring. */
export function loadBeAirspaces(url: string = '/data/be-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'be');
}

export const BE_AIRSPACES_URL = '/data/be-airspaces.json';
export const BE_AIRSPACES_NEXT_URL = '/data/be-airspaces.next.json';

/** Germany airspace overlay from cmd/de (DFS AIXM 5.1.1 StrokedBorders).
 *  Same row schema as fr-airspaces.json; fail-soft like loadUkAirspaces.
 *  FIR / UIR rows are absent on purpose: pruatlas ships the German rings. */
export function loadDeAirspaces(url: string = '/data/de-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'de');
}

export const DE_AIRSPACES_URL = '/data/de-airspaces.json';
export const DE_AIRSPACES_NEXT_URL = '/data/de-airspaces.next.json';

/** Austria airspace overlay from cmd/at (Austro Control Luftraumstruktur
 *  KML). Same row schema as fr-airspaces.json; fail-soft like
 *  loadUkAirspaces. The LOVV ring comes from pruatlas. */
export function loadAtAirspaces(url: string = '/data/at-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'at');
}

export const AT_AIRSPACES_URL = '/data/at-airspaces.json';
export const AT_AIRSPACES_NEXT_URL = '/data/at-airspaces.next.json';

/** LPS SR Slovakia airspace overlay, scraped from the eAIP by cmd/eaip.
 *  Same row schema as fr-airspaces.json; fail-soft like
 *  loadUkAirspaces. */
export function loadSkAirspaces(url: string = '/data/sk-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'sk');
}

export const SK_AIRSPACES_URL = '/data/sk-airspaces.json';
export const SK_AIRSPACES_NEXT_URL = '/data/sk-airspaces.next.json';

/** AirNav Ireland airspace overlay, scraped from the eAIP by cmd/eaip.
 *  Same row schema as fr-airspaces.json; fail-soft like
 *  loadUkAirspaces. */
export function loadIeAirspaces(url: string = '/data/ie-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'ie');
}

export const IE_AIRSPACES_URL = '/data/ie-airspaces.json';
export const IE_AIRSPACES_NEXT_URL = '/data/ie-airspaces.next.json';

/** SMATSA Serbia and Montenegro airspace overlay, scraped from the eAIP by cmd/eaip.
 *  Same row schema as fr-airspaces.json; fail-soft like
 *  loadUkAirspaces. */
export function loadRsAirspaces(url: string = '/data/rs-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'rs');
}

export const RS_AIRSPACES_URL = '/data/rs-airspaces.json';
export const RS_AIRSPACES_NEXT_URL = '/data/rs-airspaces.next.json';

/** KANS Kosovo airspace overlay, scraped from the eAIP by cmd/eaip.
 *  Same row schema as fr-airspaces.json; fail-soft like
 *  loadUkAirspaces. */
export function loadXkAirspaces(url: string = '/data/xk-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'xk');
}

export const XK_AIRSPACES_URL = '/data/xk-airspaces.json';
export const XK_AIRSPACES_NEXT_URL = '/data/xk-airspaces.next.json';

/** Georgia airspace overlay. Same row schema as fr-airspaces.json;
 *  fail-soft like loadUkAirspaces. */
export function loadGeAirspaces(url: string = '/data/ge-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'ge');
}

export const GE_AIRSPACES_URL = '/data/ge-airspaces.json';
export const GE_AIRSPACES_NEXT_URL = '/data/ge-airspaces.next.json';

/** Netherlands airspace overlay from cmd/nl (LVNL open data). Same row
 *  schema as fr-airspaces.json; fail-soft like loadUkAirspaces. */
export function loadNlAirspaces(url: string = '/data/nl-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'nl');
}

export const NL_AIRSPACES_URL = '/data/nl-airspaces.json';
export const NL_AIRSPACES_NEXT_URL = '/data/nl-airspaces.next.json';

/** Italy airspace overlay from cmd/it. Community-maintained by the open
 *  flightmaps association rather than published by ENAV, which is why
 *  every surface that names it says so. */
export function loadItAirspaces(url: string = '/data/it-airspaces.json'): Promise<Airspace[]> {
	return loadOverlay(url, 'it');
}

export const IT_AIRSPACES_URL = '/data/it-airspaces.json';
export const IT_AIRSPACES_NEXT_URL = '/data/it-airspaces.next.json';

/** Ray-casting point-in-polygon test; ring is [[lat, lon], ...]. */
export function pointInRing(
	lat: number,
	lon: number,
	ring: [number, number][],
): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i][0];
		const xi = ring[i][1];
		const yj = ring[j][0];
		const xj = ring[j][1];
		if (
			yi > lat !== yj > lat &&
			lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
		) {
			inside = !inside;
		}
	}
	return inside;
}

/** Order airspaces highest-band first, breaking ties by smaller area.
 *  Datum-aware: UNL ceilings sort above any flight level and metre limits
 *  compare converted; a missing limit sorts as 0 (surface-ish), keeping
 *  today's tie behaviour for limit-less rows. */
export function compareAirspaceByBand(a: Airspace, b: Airspace): number {
	const aLower = a.vLower ? floorMinFt(a.vLower) : 0;
	const bLower = b.vLower ? floorMinFt(b.vLower) : 0;
	if (aLower !== bLower) {
		return bLower - aLower;
	}
	const aUpper = a.vUpper ? ceilingMaxFt(a.vUpper) : 0;
	const bUpper = b.vUpper ? ceilingMaxFt(b.vUpper) : 0;
	if (aUpper !== bUpper) {
		return bUpper - aUpper;
	}
	return a.area - b.area;
}

/** All airspaces whose ring contains the point, ordered highest-band first
 *  (the same vertical-stack order the map uses). Pure: it scans the list it
 *  is given, so a caller can drive it reactively from getAirspaces() without
 *  depending on the map layer's zoom or category visibility. The bbox is a
 *  cheap pre-filter, so only the handful of overlapping rings run the
 *  point-in-polygon test. */
export function airspacesOver(
	airspaces: Airspace[],
	lat: number,
	lon: number,
): Airspace[] {
	const out: Airspace[] = [];
	for (const a of airspaces) {
		const b = a.bbox;
		if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) {
			continue;
		}
		if (pointInRing(lat, lon, a.ring)) {
			out.push(a);
		}
	}
	return out.sort(compareAirspaceByBand);
}
