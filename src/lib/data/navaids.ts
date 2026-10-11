/* Loader and types for the generated navaids dataset
 * (public/data/fr-navaids.json + uk/es). Mirrors src/lib/data/obstacles.ts
 * in shape: positional row layout, language-neutral type codes, English
 * label dictionary. cmd/{fr,uk,es} emit these files from the AIXM navaid
 * elements (Vor / Dme / Ndb / Tcn / Dpn and the AIXM 5.1 equivalents);
 * VOR-DME / VORTAC composition is already folded server-side. */

import { formatFreqMHz } from '$lib/format/radio';
import { isPublisher, type NavaidGroup, type Publisher } from '$lib/state/layers.svelte';
import { readDataJsonSoft } from '$lib/data/fetchData';

/** All navaid type codes the per-country navaids builders emit. */
export type NavaidType =
	| 'VOR'
	| 'VOR-DME'
	| 'VORTAC'
	| 'DME'
	| 'TACAN'
	| 'NDB'
	| 'ILS'
	| 'ILS-DME'
	| 'LOC'
	| 'MKR'
	| 'WAYPOINT'
	| 'VFR_REPORTING_POINT';

export interface Navaid {
	id: string;
	type: NavaidType;
	/** 3-5 letter ICAO identifier (e.g. "CGN", "ABB"). */
	ident: string;
	/** Human-readable site name; empty for most waypoints (ident == name). */
	name: string;
	lat: number;
	lon: number;
	/** Frequency string as emitted: "113.65" (MHz for the VOR / ILS family),
	 *  "414" (kHz for NDB), or "" for TACAN / DME / waypoints. */
	freq: string;
	/** TACAN / DME channel ("83Y") or "". */
	channel: string;
	/** Feet AMSL, or null when the source omitted it. */
	elev: number | null;
	/** Publisher derived from the id prefix: `uk:` / `es:` namespaces are
	 *  added at emit time by cmd/uk / cmd/es; cmd/fr emits "<Type>:<mid>"
	 *  ids whose prefix is a type word (never uk/es), so they resolve to
	 *  FR. Drives the Layers tab's per-publisher visibility toggle. */
	source: Publisher;
}

/** Human-readable English labels for each navaid type. */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/data.ts
export const NAVAID_LABELS: Record<NavaidType, string> = {
	VOR: 'VOR',
	'VOR-DME': 'VOR/DME',
	VORTAC: 'VORTAC',
	DME: 'DME',
	TACAN: 'TACAN',
	NDB: 'NDB',
	ILS: 'ILS',
	'ILS-DME': 'ILS/DME',
	LOC: 'Localizer',
	MKR: 'Marker beacon',
	WAYPOINT: 'Waypoint',
	VFR_REPORTING_POINT: 'VFR reporting point',
};
// i18n-ignore-end

/** ILS-family types share the dedicated "ILS / LOC" Layers-tab toggle. */
const ILS_TYPES = new Set<NavaidType>(['ILS', 'ILS-DME', 'LOC', 'MKR']);

/** Which Layers-tab group does each navaid type belong to? RNAV waypoints
 *  (the ~86% majority) get their own toggle; ILS / ILS-DME / LOC get a
 *  dedicated toggle; the radio navaids share the main "navaids" toggle. */
export function navaidGroup(type: NavaidType): NavaidGroup {
	if (type === 'WAYPOINT') {
		return 'waypoints';
	}
	if (type === 'VFR_REPORTING_POINT') {
		return 'reporting';
	}
	if (ILS_TYPES.has(type)) {
		return 'ils';
	}
	return 'navaids';
}

/** True for the VOR / ILS family that carries a VHF frequency in MHz.
 *  NDB carries kHz; TACAN / DME carry only a channel. */
function isMhzType(type: NavaidType): boolean {
	return type !== 'NDB' && type !== 'WAYPOINT' && type !== 'VFR_REPORTING_POINT';
}

/** One-line frequency / channel label for the detail panel and lists.
 *  "113.650 MHz", "414 kHz", "CH 83Y", or a "MHz / CH" pair for VOR-DME.
 *  The MHz branch goes through formatFreqMHz like every other frequency the
 *  app prints, so a station reads the same here as in the nav log's radial
 *  line; the datasets carry one or two decimals and the two surfaces used to
 *  disagree on all 266 French stations. kHz is not a channel resolution and
 *  is left as published. */
export function navaidFreqLabel(n: Navaid): string {
	const parts: string[] = [];
	if (n.freq) {
		parts.push(n.type === 'NDB' ? `${n.freq} kHz` : `${formatFreqMHz(n.freq)} MHz`);
	}
	if (n.channel) {
		parts.push(`CH ${n.channel}`);
	}
	if (parts.length === 0 && !isMhzType(n.type)) {
		return '';
	}
	return parts.join(' / ');
}

// Positional row layout, matching navaidsOutputFields in cmd/fr/navaids.go.
type NavaidRow = readonly [
	id: string,
	type: string,
	ident: string,
	name: string,
	lat: number,
	lon: number,
	freq: string,
	channel: string,
	elev: number | null,
];

interface RawNavaids {
	fields: string[];
	rows: readonly NavaidRow[];
}

function navaidSourceFromId(id: string): Publisher {
	const i = id.indexOf(':');
	if (i <= 0) {
		return 'fr';
	}
	const code = id.slice(0, i).toLowerCase();
	// France's ids are "<Type>:<mid>" rather than "<publisher>:<id>", so
	// anything that is not a known publisher prefix is French.
	return isPublisher(code) ? code : 'fr';
}

function rowToNavaid(r: NavaidRow): Navaid {
	const type = r[1] as NavaidType;
	return {
		id: r[0],
		type: NAVAID_LABELS[type] ? type : 'WAYPOINT',
		ident: r[2],
		name: r[3],
		lat: r[4],
		lon: r[5],
		freq: r[6] ?? '',
		channel: r[7] ?? '',
		elev: r[8],
		source: navaidSourceFromId(r[0]),
	};
}

/** Default URL; the caller may override to fetch the pre-release
 *  fr-navaids.next.json once it becomes active. */
export const NAVAIDS_URL = '/data/fr-navaids.json';

/** France navaids pre-release URL (cmd/fr -target auto). */
export const NAVAIDS_NEXT_URL = '/data/fr-navaids.next.json';

/** US radio navaids + designated points, from the FAA AIS hub. */
export const FAA_NAVAIDS_URL = '/data/faa-navaids.json';
export const FAA_NAVAIDS_NEXT_URL = '/data/faa-navaids.next.json';

// Kosovo has no navaid dataset and never will: KANS publishes ENR 4.1 and
// it reads NIL, so cmd/eaip does not read the section (cmd/eaip/states.go).
// A URL here would be fetched at every boot and answer 404 for ever.

/** Load the navaids artefact. Fail-soft for what the deployment does not
 *  hold (an absent file, Vite dev's SPA fallback included), which returns []
 *  so the map can still render the rest of the overlays; every other failure
 *  REJECTS, a refusal to be asked again and a document that does not parse
 *  a fact, never an empty list the store would keep as the country's rows. */
export async function loadNavaids(
	url: string = NAVAIDS_URL,
): Promise<Navaid[]> {
	const data = await readDataJsonSoft<RawNavaids>(url);
	return data ? data.rows.map(rowToNavaid) : [];
}
