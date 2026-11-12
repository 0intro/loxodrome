/* Map layer visibility state: the active base layer and overlay toggles.
 * The user-facing choices persist as ONE versioned doc under
 * 'loxodrome:layers' (v1: baseLayer, chartStack, airportTypes, airspace,
 * airspaceLabels, publisher, obstacles, navaids, nature, supaip, vac,
 * terrainAwareness), seeded at
 * module init through a validator and written by PersistHost's $effect via
 * persistLayers(). The doc is SPARSE (docs/preferences.md): it holds only
 * the fields, and inside a record only the leaves, that differ from
 * DEFAULTS, and the key goes when none does. So it records what the pilot
 * chose, not a snapshot of every default in force the day they chose it,
 * and a later change of a default reaches every choice nobody made.
 * chartSource is a dev-session tile-source selector and stays session-only.
 * The URL wins over the stored seed ON SCREEN: a present #map= hash
 * re-applies base layer + chart stack in MapView's onMount / hashchange
 * handlers (applyLinkLayers), but those two stay the LINK's rather than the
 * pilot's in storage until the pilot changes them (persistLayers). */

import { readJson, removeItem, writeJson } from './persist';

export type BaseLayerId = 'osm' | 'topo' | 'planign' | 'ign' | 'google' | 'bing';

/** Aeronautical chart layer id (see map/chartOverlays.ts). One id per
 *  independently stackable per-country tile layer. */
export type ChartLayerId = 'fr500' | 'fr250' | 'fr1000' | 'frvv500' | 'frheli100' | 'frenr61' | 'frenr62' | 'nl500' | 'cz500' | 'dk500' | 'dk250' | 'no250' | 'si250' | 'ee500' | 'is500' | 'hu500' | 'ro500' | 'ba500' | 'al500' | 'bg500' | 'at500' | 'es500' | 'us1000' | 'us500' | 'us250' | 'us125' | 'swissIcao';

/** Where chart tiles come from: the public Cloudflare Worker or the local
 *  oaci-wmts dev server (:8080). Only switchable in dev builds; production
 *  is hardwired to 'public'. */
export type ChartSource = 'public' | 'local';

/** Airport visibility groups, each a Layers-tab checkbox. `airports` holds the
 *  large / medium / small fixed-wing aerodromes (toggled together); the other
 *  four each map to a single OurAirports type, `closed` being the abandoned
 *  aerodromes the chart still prints as "AD désaffecté". Every group is on by
 *  default: a heliport, a seaplane base or a disused field is an aerodrome the
 *  chart draws, so the map draws it too, and the per-type zoom ladder in
 *  airportLayer.ts is what keeps the low zooms readable. */
export type AirportGroup = 'airports' | 'heliports' | 'seaplane' | 'balloon' | 'closed';

export type AirspaceCategory =
	| 'controlled'
	| 'restricted'
	| 'activity'
	| 'trafficmgmt'
	| 'transit'
	| 'siv'
	| 'fir';

/** Upstream data publishers, in one list so the runtime can enumerate
 *  them: the row loaders read a publisher back off an id prefix
 *  (obstacleSourceFromId / navaidSourceFromId) and a hand-kept second
 *  copy of this list there silently mislabels every row of a newly added
 *  publisher. Pruatlas contributes airspaces only, so its toggle does
 *  not affect airports, navaids or obstacles. The list itself is the
 *  publisher registry's ($lib/data/publishers). */
import { PUBLISHERS, everyPublisher, isPublisher, type Publisher } from '$lib/data/publishers';
export { PUBLISHERS, isPublisher, type Publisher };

export type ObstacleGroup = 'windturbines' | 'other';

/** Navaid visibility groups, each a Layers-tab checkbox. `navaids` holds the
 *  radio navaids (VOR / VOR-DME / VORTAC / DME / TACAN / NDB); `ils` holds the
 *  landing aids (ILS / ILS-DME / LOC); `waypoints` holds the dense RNAV
 *  designated-point majority; `reporting` holds the VFR reporting points. */
export type NavaidGroup = 'navaids' | 'ils' | 'waypoints' | 'reporting';

/** The prohibited-low-overflight families, each a Layers-tab checkbox:
 *  `nature` = parcs nationaux / réserves naturelles (SIA PRN); `sensitive`
 *  = industrial / nuclear / prison sites (SIA SUR); `bird` = bird
 *  concentration areas (Belgian eAIP ENR 5.6). Drawn as point symbols. */
export type NatureGroup = 'nature' | 'sensitive' | 'bird';

/** The SIA VAC panels drawn over the map, one toggle per chart family:
 *  the visual approach sheet, the visual landing one, and the ground
 *  movement chart where it carries a graticule (docs/vac-overlay.md). */
export type VacGroup = 'app' | 'att' | 'gmc';

/** The persisted subset of `layers`: every user-facing Layers-tab choice.
 *  chartSource stays outside (dev-session selector, see its docstring). */
interface LayersChoices {
	baseLayer: BaseLayerId;
	chartStack: ChartLayerId[];
	airportTypes: Record<AirportGroup, boolean>;
	airspace: Record<AirspaceCategory, boolean>;
	airspaceLabels: boolean;
	publisher: Record<Publisher, boolean>;
	obstacles: Record<ObstacleGroup, boolean>;
	navaids: Record<NavaidGroup, boolean>;
	nature: Record<NatureGroup, boolean>;
	supaip: boolean;
	vac: Record<VacGroup, boolean>;
	terrainAwareness: boolean;
}

/** The out-of-the-box choices. Never handed to $state directly
 *  (initialLayers clones every object), so a toggle can never write into
 *  the defaults. */
const DEFAULTS: LayersChoices = {
	baseLayer: 'osm',
	chartStack: [],
	airportTypes: {
		airports: true,
		heliports: true,
		seaplane: true,
		balloon: true,
		closed: true,
	},
	airspace: {
		controlled: false,
		restricted: false,
		activity: false,
		trafficmgmt: false,
		transit: false,
		siv: false,
		fir: false,
	},
	airspaceLabels: true,
	publisher: everyPublisher(true),
	obstacles: {
		windturbines: false,
		other: false,
	},
	navaids: {
		navaids: false,
		ils: false,
		waypoints: false,
		reporting: false,
	},
	nature: {
		nature: false,
		bird: false,
		sensitive: false,
	},
	supaip: false,
	vac: {
		app: false,
		att: false,
		gmc: false,
	},
	terrainAwareness: true,
};

const LAYERS_KEY = 'loxodrome:layers';
const LAYERS_PERSIST_VERSION = 1;

/* Known ids, compiler-checked against the unions above (the viewHash.ts
 * `satisfies` idiom), kept local so this state module imports no map
 * module: a new base / chart id fails the build here until the stored-doc
 * validator knows it. */
const BASE_ID_SET = {
	osm: 1,
	topo: 1,
	planign: 1,
	ign: 1,
	google: 1,
	bing: 1,
} as const satisfies Record<BaseLayerId, 1>;
const CHART_ID_SET = {
	fr500: 1,
	fr250: 1,
	fr1000: 1,
	frvv500: 1,
	frheli100: 1,
	frenr61: 1,
	frenr62: 1,
	nl500: 1,
	cz500: 1,
	dk500: 1,
	dk250: 1,
	no250: 1,
	si250: 1,
	ee500: 1,
	is500: 1,
	hu500: 1,
	ro500: 1,
	ba500: 1,
	al500: 1,
	bg500: 1,
	at500: 1,
	es500: 1,
	us1000: 1,
	us500: 1,
	us250: 1,
	us125: 1,
	swissIcao: 1,
} as const satisfies Record<ChartLayerId, 1>;

/** Overlay a stored boolean record onto its defaults: only own boolean
 *  values are taken and only at the default's own keys, so a stale doc can
 *  neither add fields nor corrupt one with a non-boolean. */
function boolRecord<K extends string>(
	defaults: Readonly<Record<K, boolean>>,
	raw: unknown,
): Record<K, boolean> {
	const out: Record<K, boolean> = { ...defaults };
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
		for (const k of Object.keys(out) as K[]) {
			const v = (raw as Record<string, unknown>)[k];
			if (typeof v === 'boolean') {
				out[k] = v;
			}
		}
	}
	return out;
}

/** The boot state: DEFAULTS overlaid with the validated stored doc. Each
 *  field falls back independently (missing / wrong-version doc, unknown
 *  baseLayer, non-boolean values); chartStack keeps known ids only, first
 *  occurrence wins. Runs once at module init; MapView's onMount then
 *  applies a present #map= hash on top, so the URL always wins over
 *  storage. Every returned object is fresh (never DEFAULTS itself). */
function initialLayers(): LayersChoices {
	return choicesFrom(readJson<Record<string, unknown>>(LAYERS_KEY));
}

/** A stored doc (or null) read over DEFAULTS, as initialLayers describes. */
function choicesFrom(raw: Record<string, unknown> | null): LayersChoices {
	const s: Record<string, unknown> = raw !== null && raw.v === LAYERS_PERSIST_VERSION ? raw : {};
	const chartStack: ChartLayerId[] = [];
	if (Array.isArray(s.chartStack)) {
		for (const id of s.chartStack) {
			if (
				typeof id === 'string' &&
				Object.hasOwn(CHART_ID_SET, id) &&
				!chartStack.includes(id as ChartLayerId)
			) {
				chartStack.push(id as ChartLayerId);
			}
		}
	}
	return {
		baseLayer:
			typeof s.baseLayer === 'string' && Object.hasOwn(BASE_ID_SET, s.baseLayer)
				? (s.baseLayer as BaseLayerId)
				: DEFAULTS.baseLayer,
		chartStack,
		airportTypes: boolRecord(DEFAULTS.airportTypes, s.airportTypes),
		airspace: boolRecord(DEFAULTS.airspace, s.airspace),
		airspaceLabels:
			typeof s.airspaceLabels === 'boolean' ? s.airspaceLabels : DEFAULTS.airspaceLabels,
		publisher: boolRecord(DEFAULTS.publisher, s.publisher),
		obstacles: boolRecord(DEFAULTS.obstacles, s.obstacles),
		navaids: boolRecord(DEFAULTS.navaids, s.navaids),
		nature: boolRecord(DEFAULTS.nature, s.nature),
		supaip: typeof s.supaip === 'boolean' ? s.supaip : DEFAULTS.supaip,
		vac: boolRecord(DEFAULTS.vac, s.vac),
		terrainAwareness:
			typeof s.terrainAwareness === 'boolean' ? s.terrainAwareness : DEFAULTS.terrainAwareness,
	};
}

export const layers = $state<{
	baseLayer: BaseLayerId;
	airportTypes: Record<AirportGroup, boolean>;
	airspace: Record<AirspaceCategory, boolean>;
	/** Designator labels on visible airspaces ("R 212", "TMA RENNES 4");
	 *  drawn by airspaceDecoLayer, zoom-gated, de-collided. */
	airspaceLabels: boolean;
	publisher: Record<Publisher, boolean>;
	obstacles: Record<ObstacleGroup, boolean>;
	navaids: Record<NavaidGroup, boolean>;
	/** Nature reserves / parks (PRN) and sensitive sites (SUR), separate toggles. */
	nature: Record<NatureGroup, boolean>;
	/** SUP AIP temporary-area overlay (French aeronautical supplements). */
	supaip: boolean;
	/** The French VAC panels drawn in place over the map, per chart family.
	 *  Where two overlap the landing sheet draws over the approach one, its
	 *  larger scale being the closer answer. */
	vac: Record<VacGroup, boolean>;
	/** The relative-terrain shading (map/terrainAwareLayer.ts,
	 *  docs/terrain-awareness.md): the ground and the obstacles around the
	 *  aircraft coloured by their height against its GPS altitude, while a
	 *  recording or a replay supplies a pose. On by default: it draws nothing
	 *  without one, so a session that never flies sees no change. */
	terrainAwareness: boolean;
	/** The aeronautical chart stack, ORDERED: checking a layer appends it on
	 *  top, unchecking removes it, re-checking moves it back to the top. Where
	 *  two layers overlap (e.g. the France/Spain border, or fr250 over fr500)
	 *  the later entry draws above the earlier: the check order IS the
	 *  z-order. Ids in map/chartOverlays.ts. */
	chartStack: ChartLayerId[];
	/** Tile source for the chart layers: 'public' (Cloudflare Worker) or
	 *  'local' (oaci-wmts on :8080). Dev-only selector; production builds
	 *  never offer 'local' and only list layers with a public source. */
	chartSource: ChartSource;
}>({
	...initialLayers(),
	chartSource: 'public',
});

/* The two choices a #map= link carries, the base map and the chart stack,
 * are the SENDER's. The map shows them (a present #map= is the whole view),
 * but storage keeps the pilot's own until the pilot changes one of them on
 * screen: stored as they arrived, a shared link replaced the pilot's chart
 * stack, and a bare one, which encodes the OSM default and an empty stack,
 * erased the choice outright, for the next visit without a hash to open on
 * OSM with no charts (docs/preferences.md rule 2: nothing automatic writes
 * the user's key). `own*` is what storage holds for each; `link*` is what a
 * link put on screen, null once the pilot has changed it or when no link
 * did. Plain module state: persistLayers reads it, nothing renders it. */
let ownBase: BaseLayerId = layers.baseLayer;
let ownCharts: ChartLayerId[] = [...layers.chartStack];
let linkBase: BaseLayerId | null = null;
let linkCharts: string | null = null;

/** Show a #map= link's base map and chart stack (MapView, at mount and on
 *  hashchange): on screen at once, in storage only once the pilot changes
 *  them (persistLayers). */
export function applyLinkLayers(baseLayer: BaseLayerId, chartStack: ChartLayerId[]): void {
	layers.baseLayer = baseLayer;
	layers.chartStack = chartStack;
	linkBase = baseLayer;
	linkCharts = JSON.stringify(chartStack);
}

/** Put every persisted choice back at its default, in place. For the NOTAM
 *  Viewer, which calls it once at boot, before it mounts: this module seeds
 *  itself from 'loxodrome:layers' at init, and on loxodrome.fr/notam that is
 *  the FLIGHT APP'S document, on the origin the two share. The viewer persists
 *  no layer choice of its own (it mounts no PersistHost) and offers no control
 *  for the publishers at all, so a country unticked next door vanished from
 *  its map with nothing here to bring it back, and a base map left on Google
 *  Satellite opened on Google Satellite. Pinned by decision instead
 *  (docs/notam-viewer.md "The preferences it reads"): every session starts
 *  where the canonical notam-viewer.net, an origin of its own, starts anyway.
 *  The chart source is dev-session state and is left alone. */
export function resetLayerChoices(): void {
	Object.assign(layers, choicesFrom(null));
	ownBase = layers.baseLayer;
	ownCharts = [...layers.chartStack];
	linkBase = null;
	linkCharts = null;
}

/** The current choices as fresh plain objects. Reads every persisted
 *  field, which is exactly what makes the caller's $effect track the whole
 *  subset. */
function snapshotChoices(): LayersChoices {
	return {
		baseLayer: layers.baseLayer,
		chartStack: [...layers.chartStack],
		airportTypes: { ...layers.airportTypes },
		airspace: { ...layers.airspace },
		airspaceLabels: layers.airspaceLabels,
		publisher: { ...layers.publisher },
		obstacles: { ...layers.obstacles },
		navaids: { ...layers.navaids },
		nature: { ...layers.nature },
		supaip: layers.supaip,
		vac: { ...layers.vac },
		terrainAwareness: layers.terrainAwareness,
	};
}

/** What differs from DEFAULTS, and only that: a scalar when it differs, a
 *  record's differing leaves, the chart stack while it is not the default
 *  (empty) stack. choicesFrom overlays a doc field by field and leaf by
 *  leaf, so this is exactly what it reads back. */
function differingChoices(snap: LayersChoices): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of Object.keys(DEFAULTS) as (keyof LayersChoices)[]) {
		const value: unknown = snap[field];
		const def: unknown = DEFAULTS[field];
		if (Array.isArray(value)) {
			if (JSON.stringify(value) !== JSON.stringify(def)) {
				out[field] = value;
			}
		} else if (typeof value === 'object' && value !== null) {
			const leaves: Record<string, unknown> = {};
			for (const [leaf, v] of Object.entries(value)) {
				if (v !== (def as Record<string, unknown>)[leaf]) {
					leaves[leaf] = v;
				}
			}
			if (Object.keys(leaves).length > 0) {
				out[field] = leaves;
			}
		} else if (value !== def) {
			out[field] = value;
		}
	}
	return out;
}

/** Mirror the Layers choices to storage: what differs from DEFAULTS
 *  (differingChoices), the key removed once nothing does. A doc written by an
 *  older build held every value; it reads the same, and its next write keeps
 *  only what differs. The base map and the chart stack are the pilot's own
 *  while they still show what a link put there (applyLinkLayers), and
 *  whatever is on screen once the pilot has changed them. Discrete toggles
 *  need no debounce; called from PersistHost's $effect, whose tracking is
 *  snapshotChoices' reads. */
export function persistLayers(): void {
	const snap = snapshotChoices();
	if (linkBase !== null && snap.baseLayer === linkBase) {
		snap.baseLayer = ownBase;
	} else {
		linkBase = null;
		ownBase = snap.baseLayer;
	}
	if (linkCharts !== null && JSON.stringify(snap.chartStack) === linkCharts) {
		snap.chartStack = [...ownCharts];
	} else {
		linkCharts = null;
		ownCharts = [...snap.chartStack];
	}
	const diff = differingChoices(snap);
	if (Object.keys(diff).length === 0) {
		removeItem(LAYERS_KEY);
	} else {
		writeJson(LAYERS_KEY, { v: LAYERS_PERSIST_VERSION, ...diff });
	}
}

/** Toggle a chart layer: absent -> append on top; present -> remove.
 *  (Re-checking therefore moves a layer to the top of the stack.) */
export function toggleChartLayer(id: ChartLayerId): void {
	const i = layers.chartStack.indexOf(id);
	if (i >= 0) {
		layers.chartStack.splice(i, 1);
	} else {
		layers.chartStack.push(id);
	}
}

/** True when any airport group is enabled, i.e. the airport overlay belongs on
 *  the map. Replaces the old single `airportsVisible` flag; consumed by the
 *  airport layer effect, the "hide airport NOTAM markers" gate, and the detail
 *  panels that only surface airport links while airports are shown. */
export function airportsAnyVisible(): boolean {
	const g = layers.airportTypes;
	return g.airports || g.heliports || g.seaplane || g.balloon || g.closed;
}
