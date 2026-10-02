/* The publisher registry: one row per source of national aeronautical data,
 * and the one statement of what each one publishes.
 *
 * Every per-publisher list in the app used to be written out by hand: the
 * Layers toggles, the AIRAC slot matrix, a pair of meta loaders and a pair of
 * URLs per dataset, the per-kind source lists, the About metas, the NOTAM
 * FIR and citation tables. Adding the four eAIP States took a commit
 * touching 29 files, and a list nothing type-checks had already gone stale
 * once (thirteen dead Layers toggles, commit efee79e4). The rows below are
 * what those lists are now derived from, so a new publisher is a row.
 *
 * What stays out: France and the FAA, whose datasets carry their own
 * schemas and loaders (their `datasets` are empty and their wiring
 * explicit), and each dataset's MERGE ORDER, which is a precedence
 * decision per kind and is kept as an explicit list where it is used
 * (data.svelte.ts), pinned against this table by tests/publishers.spec.ts.
 *
 * Pure and locale-free: the Layers labels are product names, invariant in
 * every language. */

/** A dataset a publisher files as `/data/<id>-<file>.json`, with an AIRAC
 *  `.next` twin and `.meta.json` sidecars (the slot picker's inputs). */
export type DatasetKind = 'airspaces' | 'airports' | 'navaids' | 'obstacles' | 'facilities' | 'nature';

/** One publisher. */
export interface PublisherSpec {
	/** Dataset prefix, Layers toggle and publisher tag on every row. */
	readonly id: string;
	/** ICAO prefixes of the FIRs a NOTAM concerning this publisher's airspace
	 *  is filed under (its Q-line FIR), which is how a NOTAM's text is routed
	 *  to the rows it may name. Empty for a publisher no NOTAM is routed to. */
	readonly firs: readonly string[];
	/** ICAO prefixes its restricted, danger and prohibited areas are cited
	 *  with in NOTAM text, in the common "<prefix>[DRP]nn" grammar ("EG D129",
	 *  "LZR 51"). Empty where the citation grammar is the publisher's own
	 *  (France) or where nothing is cited. */
	readonly cites: readonly string[];
	/** The datasets read through the generic pipeline, AIRAC-slotted. */
	readonly datasets: readonly DatasetKind[];
	/** The Layers-tab sub-label: the publisher and its product, as the
	 *  publisher names them. */
	readonly layers: string;
	/** Where its data lies, generously: [minLon, minLat, maxLon, maxLat]
	 *  boxes (the sidecar's order) around every piece its datasets occupy.
	 *  What the coverage gate judges a country on when its sidecar did not
	 *  answer and its own envelope is unknown (state/coverage.svelte.ts
	 *  publisherInCoverage): the country still loads, and whether its
	 *  failure matters to the pilot is read from where it is. Wider than the
	 *  data by a degree at least; tests/publisherAreas.spec.ts fails when a
	 *  committed sidecar reaches past it. */
	readonly area: readonly (readonly [number, number, number, number])[];
}

// i18n-ignore-start: locale-invariant publisher and product names
export const PUBLISHER_TABLE = [
	// France: the SIA AIXM 4.5 export, its own schemas and loaders.
	{
		id: 'fr', firs: ['LF', 'TF', 'SO', 'NT', 'NW', 'FM'], cites: [], datasets: [], layers: 'SIA AIXM 4.5',
		// Metropole and Corsica, then the overseas pieces: Wallis, Polynesia
		// and its FIR, a Pacific outlier the data carries, the Antilles and
		// Guiana, Saint-Pierre, the Indian Ocean, Kerguelen, New Caledonia.
		area: [
			[-10, 37, 12, 53], [-180, -16, -175, -12], [-158, -31, -119, 5], [-151, 16, -148, 19],
			[-66, 1, -34, 24], [-64, 43, -50, 54], [39, -31, 59, -9], [66, -46, 69, -43], [160, -27, 174, -13],
		],
	},
	{
		id: 'uk', firs: ['EG'], cites: ['EG'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'NATS AIXM 5.1',
		area: [[-31, 44, -29, 62], [-16, 44, 7, 62]],
	},
	{
		id: 'es', firs: ['LE', 'GC'], cites: ['LE', 'GC'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'ENAIRE AIXM 5.1',
		area: [[-26, 18, 6, 47]],
	},
	// Belgium and Luxembourg share one AIP and the Brussels FIR.
	{
		id: 'be', firs: ['EB', 'EL'], cites: ['EB', 'EL'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities', 'nature'],
		layers: 'skeyes eAIP',
		area: [[0, 47, 8, 53]],
	},
	{
		id: 'de', firs: ['ED'], cites: ['ED'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'DFS AIXM 5.1.1',
		area: [[4, 46, 17, 57]],
	},
	{
		id: 'at', firs: ['LO'], cites: ['LO'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles'],
		layers: 'Austro Control KML + AIXM 5.1.1',
		area: [[8, 45, 19, 51]],
	},
	// EUROCONTROL's FIR rings: airspace only, loaded as a worldwide overlay.
	{ id: 'pruatlas', firs: [], cites: [], datasets: [], layers: 'EUROCONTROL pruatlas', area: [[-180, -90, 180, 90]] },
	// The FAA: its own gated loaders (the United States is far from home).
	{
		id: 'faa', firs: [], cites: [], datasets: [], layers: 'FAA Boundary + Class + SUA + NAVAID + DOF',
		// The Americas and the oceanic FIRs either side of the dateline, and
		// the outlying points the data carries (Ascension, Diego Garcia).
		area: [[-180, -32, -30, 90], [91, -31, 180, 79], [-16, -9, -13, -6], [71, -9, 74, -6], [179, 85, 180, 88]],
	},
	// Georgia's obstacles are a separate product, not in the AIP data set.
	{
		id: 'ge', firs: ['UG'], cites: ['UG'],
		datasets: ['airspaces', 'airports', 'navaids', 'facilities'],
		layers: 'Sakaeronavigatsia AIXM 5.1.1',
		area: [[38, 40, 48, 45]],
	},
	// LVNL publishes no obstacle dataset.
	{ id: 'nl', firs: ['EH'], cites: ['EH'], datasets: ['airspaces', 'airports', 'navaids'], layers: 'LVNL open data', area: [[-2, 49, 9, 57]] },
	// Switzerland: the obstacle register alone (docs/aip-sources.md).
	{ id: 'ch', firs: [], cites: [], datasets: ['obstacles'], layers: 'FOCA obstacle register (AIXM)', area: [[4, 44, 12, 49]] },
	// Romania: the airspace of ENR 2.1, 5.1 and 5.2 and of each aerodrome's AD
	// 2.17, the navaids and points of ENR 4.1 and 4.4, and the aerodromes of
	// AD 2 and AD 3, rebuilt from the PDF AIP (cmd/ro), and the Area 1
	// obstacle data set published beside it. Its aerodrome charts are linked
	// through $lib/data/aipCharts.
	{
		id: 'ro', firs: ['LR'], cites: ['LR'], datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'ROMATSA AIP + obstacle data set (Area 1)',
		area: [[19, 42, 32, 50]],
	},
	// Finland: the eAIP (cmd/eaip) and the obstacle register (cmd/fi).
	{
		id: 'fi', firs: ['EF'], cites: ['EF'], datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'Fintraffic ANS eAIP + obstacle register (Area 1)',
		area: [[18, 58, 33, 72]],
	},
	// Italy: community data, never routed a NOTAM as if it were the Italian AIP.
	{
		id: 'it', firs: [], cites: [],
		datasets: ['airspaces', 'airports', 'navaids', 'nature'],
		layers: 'open flightmaps OFMX (community)',
		area: [[5, 33, 21, 49]],
	},
	// The eAIP cohort (cmd/eaip).
	{ id: 'sk', firs: ['LZ'], cites: ['LZ'], datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'], layers: 'LPS SR eAIP', area: [[15, 46, 24, 51]] },
	// Ireland: its ENR 5.4 points at the IAA's two obstacle registers (cmd/ie).
	{
		id: 'ie', firs: ['EI'], cites: ['EI'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'],
		layers: 'AirNav Ireland eAIP + IAA obstacle registers',
		area: [[-16, 47, -4, 58]],
	},
	{ id: 'rs', firs: ['LY'], cites: ['LY'], datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'], layers: 'SMATSA eAIP', area: [[17, 40, 24, 48]] },
	// Kosovo's ENR 4.1 reads NIL: its navaids are its ENR 4.4 name-codes.
	{ id: 'xk', firs: ['BK'], cites: ['BK'], datasets: ['airspaces', 'airports', 'navaids', 'facilities'], layers: 'KANS eAIP', area: [[19, 41, 23, 45]] },
	// Iceland: for non-commercial use only (GEN 0.1.5), which Loxodrome is.
	{ id: 'is', firs: ['BI'], cites: ['BI'], datasets: ['airspaces', 'airports', 'navaids', 'obstacles', 'facilities'], layers: 'Avians eAIP', area: [[-77, 59, 1, 90], [29, 81, 31, 83]] },
	// Sweden: LFV's Digital AIM WFS (cmd/se), CC BY 4.0.
	{
		id: 'se', firs: ['ES'], cites: ['ES'],
		datasets: ['airspaces', 'airports', 'navaids', 'obstacles'],
		layers: 'LFV Digital AIM (WFS)',
		area: [[9, 53, 26, 71]],
	},
] as const satisfies readonly PublisherSpec[];
// i18n-ignore-end

/** Every publisher, in the Layers tab's order. */
export const PUBLISHERS = PUBLISHER_TABLE.map((p) => p.id);

/** Upstream data publisher. The same set drives the airspace, airport,
 *  navaid and obstacle filters; a single Publisher toggle hides everything
 *  that came from that publisher. */
export type Publisher = (typeof PUBLISHER_TABLE)[number]['id'];

type Row = (typeof PUBLISHER_TABLE)[number];

/** A publisher whose datasets the generic pipeline reads. */
export type RegistryPublisher = Extract<Row, { readonly datasets: readonly [DatasetKind, ...DatasetKind[]] }>['id'];

/** A publisher a NOTAM can be routed to by its Q-line FIR. */
export type NotamPublisher = Extract<Row, { readonly firs: readonly [string, ...string[]] }>['id'];

/** A record holding one value for every publisher: the default Layers
 *  flags and each layer's visibility table, exhaustive by construction. */
export function everyPublisher<T>(value: T): Record<Publisher, T> {
	return Object.fromEntries(PUBLISHERS.map((p) => [p, value])) as Record<Publisher, T>;
}

/** Is this string one of the known publishers? */
export function isPublisher(v: string): v is Publisher {
	return (PUBLISHERS as readonly string[]).includes(v);
}

function row(id: Publisher): PublisherSpec {
	const r = PUBLISHER_TABLE.find((p) => p.id === id);
	if (!r) {
		// i18n-ignore: a programming error, never shown to a user
		throw new Error(`unknown publisher ${id}`);
	}
	return r;
}

/** A publisher's own territory, generously (PublisherSpec.area). */
export function publisherArea(id: Publisher): readonly (readonly [number, number, number, number])[] {
	return row(id).area;
}

/** Does the publisher file this dataset through the generic pipeline? */
export function publishes(id: Publisher, kind: DatasetKind): boolean {
	return row(id).datasets.includes(kind);
}

/** The publishers whose datasets the generic pipeline reads, in table
 *  order. */
export const REGISTRY_PUBLISHERS = PUBLISHER_TABLE.filter((p) => p.datasets.length > 0).map(
	(p) => p.id,
) as RegistryPublisher[];

/** The datasets merged across publishers, and the MERGE PRECEDENCE of each:
 *  a row a higher publisher carries wins over its republication lower down
 *  (mergeAirspaces, mergeAixmOverlay). A precedence is a decision, not a
 *  derivation, so it is written out: Austria ahead of Germany for airspace
 *  (the LOWS2 TMA bands over the Salzburg volumes DFS republishes), the FAA
 *  among the obstacles and navaids but last among the aerodromes. France and
 *  the FAA sit here with their explicit sources; every registry publisher
 *  filing a kind must appear in its list exactly once, which
 *  tests/publishers.spec.ts pins. The aerodrome directories are not merged
 *  (each loads alone when a panel opens), so they have no order. */
export const MERGE_ORDER = {
	airports: ['fr', 'uk', 'es', 'be', 'de', 'at', 'ge', 'nl', 'it', 'se', 'sk', 'ie', 'rs', 'xk', 'fi', 'is', 'ro', 'faa'],
	airspaces: ['fr', 'uk', 'es', 'be', 'at', 'de', 'ge', 'nl', 'it', 'sk', 'ie', 'rs', 'xk', 'se', 'fi', 'is', 'ro'],
	obstacles: ['fr', 'uk', 'es', 'be', 'de', 'at', 'faa', 'ch', 'fi', 'se', 'sk', 'ie', 'rs', 'is', 'ro'],
	navaids: ['fr', 'uk', 'es', 'be', 'de', 'at', 'faa', 'ge', 'nl', 'it', 'sk', 'ie', 'rs', 'xk', 'se', 'fi', 'is', 'ro'],
	nature: ['fr', 'be', 'it'],
} as const satisfies Record<Exclude<DatasetKind, 'facilities'>, readonly Publisher[]>;

/** The publishers with a slot in the AIRAC matrix: the registry's, plus
 *  France and the FAA with their explicit sources. */
export const AIRAC_PUBLISHERS = ['fr', 'faa', ...REGISTRY_PUBLISHERS] as const;

/** The publishers filing one dataset kind, in table order. */
export function publishersOf(kind: DatasetKind): RegistryPublisher[] {
	return REGISTRY_PUBLISHERS.filter((id) => publishes(id, kind));
}

/** The file stem of a dataset kind: the aerodrome directory is filed as
 *  `aerodrome-facilities`. */
function fileOf(kind: DatasetKind): string {
	return kind === 'facilities' ? 'aerodrome-facilities' : kind;
}

/** A dataset's URL, current slot or the AIRAC pre-release. */
export function datasetUrl(id: Publisher, kind: DatasetKind, next = false): string {
	return `/data/${id}-${fileOf(kind)}${next ? '.next' : ''}.json`;
}

/** A dataset's sidecar URL, current slot or the AIRAC pre-release. */
export function datasetMetaUrl(id: Publisher, kind: DatasetKind, next = false): string {
	return `/data/${id}-${fileOf(kind)}${next ? '.next' : ''}.meta.json`;
}

/** The publisher whose FIR a Q-line FIR belongs to, or null when no
 *  dataset here is routed NOTAMs by that FIR. */
export function firPublisher(fir: string): NotamPublisher | null {
	const f = fir.toUpperCase();
	for (const p of PUBLISHER_TABLE) {
		if ((p.firs as readonly string[]).some((prefix) => f.startsWith(prefix))) {
			return p.id as NotamPublisher;
		}
	}
	return null;
}

/** The citation prefixes of a publisher using the common grammar. */
export function citationPrefixes(id: Publisher): readonly string[] {
	return row(id).cites;
}

/** The Layers-tab sub-label. */
export function layersLabel(id: Publisher): string {
	return row(id).layers;
}
