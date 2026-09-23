/* Loader and types for the generated obstacles dataset
 * (public/data/fr-obstacles.json). Mirrors src/lib/data/airports.ts in
 * shape: positional row layout, language-neutral type codes, English label
 * dictionary. cmd/fr emits this file from the SIA AIXM 4.5 export's <Obs>
 * elements. */

import { isPublisher, type ObstacleGroup, type Publisher } from '$lib/state/layers.svelte';

/** All language-neutral obstacle type codes cmd/obstacles emits. */
export type ObstacleType =
	| 'windturbine'
	| 'pylon'
	| 'mast'
	| 'watertower'
	| 'tower'
	| 'building'
	| 'chimney'
	| 'silo'
	| 'antenna'
	| 'cable'
	| 'lighthouse'
	| 'flarestack'
	| 'mine'
	| 'bridge'
	| 'powerplant'
	| 'crane'
	| 'church'
	| 'lattice'
	| 'portal'
	| 'derrick'
	| 'other';

export interface Obstacle {
	id: string;
	type: ObstacleType;
	name: string;
	lat: number;
	lon: number;
	/** Summit elevation in feet AMSL: the obstacle TOP, used directly by
	 *  the minimum-safe-altitude scan (never add `hgt` to it). */
	elev: number | null;
	/** Height above ground in feet (AGL/ASFC); drives the Legende2026
	 *  glyph choice (>= 500 ft = high obstacle). */
	hgt: number | null;
	lit: boolean;
	group: boolean;
	/** Free-text remark describing the structure. The SIA AIXM emits some
	 *  remarks bilingually as "French\\English" (format/remark.ts splits it);
	 *  empty when the source has none (most obstacles). */
	rmk: string;
	/** Publisher derived from the id prefix: `uk:` / `es:` namespaces
	 *  are added at emit time by cmd/uk / cmd/es; cmd/fr emits bare
	 *  SIA mids so the absence of a colon means FR. Drives the Layers
	 *  tab's per-publisher visibility toggle. */
	source: Publisher;
}

/** Human-readable English labels for each obstacle type. */
// i18n-ignore-start: canonical English labels, FR mirror in $lib/i18n/fr/data.ts
export const OBSTACLE_LABELS: Record<ObstacleType, string> = {
	windturbine: 'Wind turbine',
	pylon: 'Pylon',
	mast: 'Mast',
	watertower: 'Water tower',
	tower: 'Tower',
	building: 'Building',
	chimney: 'Chimney',
	silo: 'Silo',
	antenna: 'Antenna',
	cable: 'Cable',
	lighthouse: 'Lighthouse',
	flarestack: 'Flare stack',
	mine: 'Mining heap',
	bridge: 'Bridge pillar',
	powerplant: 'Power plant',
	crane: 'Crane',
	church: 'Church',
	lattice: 'Lattice tower',
	portal: 'Gantry',
	derrick: 'Derrick',
	other: 'Other obstacle',
};
// i18n-ignore-end

/** Which Layers-tab group does each obstacle type belong to? Wind turbines
 *  get their own toggle (10,723 of 13,766; ~78%); everything else lives in
 *  the "Other obstacles" toggle. */
export function obstacleGroup(type: ObstacleType): ObstacleGroup {
	return type === 'windturbine' ? 'windturbines' : 'other';
}

// Positional row layout, matching obstaclesOutputFields in cmd/fr/obstacles.go.
type ObstacleRow = readonly [
	id: string,
	type: string,
	name: string,
	lat: number,
	lon: number,
	elev: number | null,
	hgt: number | null,
	lit: boolean,
	group: boolean,
	// Tolerance-loaded trailing column; an older file without it leaves the
	// element undefined.
	rmk?: string,
];

interface RawObstacles {
	fields: string[];
	rows: readonly ObstacleRow[];
}

/** Which publisher a row came from, read off its id prefix.
 *
 *  France is the fallback because its ids are "<Type>:<mid>" rather than
 *  "<publisher>:<id>", so an unrecognised prefix is French by
 *  construction. The consequence is that adding a dataset without adding
 *  its code to PUBLISHERS first files every one of its rows under France:
 *  they hide behind the France toggle and never appear behind their own.
 *  Nothing warns, which is why this is exported and tested. */
export function obstacleSourceFromId(id: string): Publisher {
	const i = id.indexOf(':');
	if (i <= 0) {
		return 'fr';
	}
	const code = id.slice(0, i).toLowerCase();
	return isPublisher(code) ? code : 'fr';
}

function rowToObstacle(r: ObstacleRow): Obstacle {
	const type = r[1] as ObstacleType;
	return {
		id: r[0],
		type: OBSTACLE_LABELS[type] ? type : 'other',
		name: r[2],
		lat: r[3],
		lon: r[4],
		elev: r[5],
		hgt: r[6],
		lit: r[7],
		group: r[8],
		rmk: r[9] ?? '',
		source: obstacleSourceFromId(r[0]),
	};
}

/** Default URL; the caller may override to fetch the pre-release
 *  fr-obstacles.next.json once it becomes active. */
export const OBSTACLES_URL = '/data/fr-obstacles.json';

/** UK obstacles overlay (cmd/uk; NATS UK ICAO Obstacle Dataset Area 1). */
export const UK_OBSTACLES_URL = '/data/uk-obstacles.json';

/** UK obstacles pre-release URL (cmd/uk -target auto). */
export const UK_OBSTACLES_NEXT_URL = '/data/uk-obstacles.next.json';

/** Spain obstacles overlay (cmd/es; ENAIRE per-aerodrome obstacle slices). */
export const ES_OBSTACLES_URL = '/data/es-obstacles.json';

/** Spain obstacles pre-release URL (cmd/es -target auto). */
export const ES_OBSTACLES_NEXT_URL = '/data/es-obstacles.next.json';

/** Belgium & Luxembourg obstacles overlay (cmd/be; skeyes eAIP ENR 5.4,
 *  the significant en-route obstacles only). */
export const BE_OBSTACLES_URL = '/data/be-obstacles.json';

/** Belgium & Luxembourg obstacles pre-release URL (cmd/be, eAIP_Next). */
export const BE_OBSTACLES_NEXT_URL = '/data/be-obstacles.next.json';

/** Germany obstacles overlay (cmd/de; DFS eTOD Obstacles Area 1, >100m). */
export const DE_OBSTACLES_URL = '/data/de-obstacles.json';

/** Germany obstacles pre-release URL (cmd/de -target auto). */
export const DE_OBSTACLES_NEXT_URL = '/data/de-obstacles.next.json';

/** Austria obstacles overlay (cmd/at; Austro Control Obstacle Data Set
 *  (ICAO) Area 1, AIXM 5.1.1). */
export const AT_OBSTACLES_URL = '/data/at-obstacles.json';

/** Austria obstacles pre-release URL (cmd/at -target auto). */
export const AT_OBSTACLES_NEXT_URL = '/data/at-obstacles.next.json';

/** US obstacles, the FAA Digital Obstacle File above its height floor. */
export const FAA_OBSTACLES_URL = '/data/faa-obstacles.json';
export const FAA_OBSTACLES_NEXT_URL = '/data/faa-obstacles.next.json';

/** Swiss obstacles. FOCA publishes the register openly even though the
 *  Swiss AIRSPACE is sold through skybriefing, so this is the one
 *  publisher here that contributes obstacles alone. */
export const CH_OBSTACLES_URL = '/data/ch-obstacles.json';
export const CH_OBSTACLES_NEXT_URL = '/data/ch-obstacles.next.json';

/** Finnish obstacles (cmd/fi; Fintraffic ANS Area 1, the whole territory
 *  at or above 100 m AGL). The Finnish AIP is published as PDF, so like
 *  Switzerland this publisher contributes obstacles alone. */
export const FI_OBSTACLES_URL = '/data/fi-obstacles.json';
export const FI_OBSTACLES_NEXT_URL = '/data/fi-obstacles.next.json';

/** Load the obstacles artefact. Fail-soft: an HTTP error OR a non-JSON
 *  200 (Vite dev's SPA fallback) returns [] so the map can still
 *  render the rest of the overlays. */
export async function loadObstacles(
	url: string = OBSTACLES_URL,
): Promise<Obstacle[]> {
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
	const data = (await res.json()) as RawObstacles;
	return data.rows.map(rowToObstacle);
}
