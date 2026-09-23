/* The NOTAM Viewer's pointer hit-testing.
 *
 * Same RULE as the flight app's (map/areaRank.ts, which both call and neither
 * restates), different GATHER: this map draws NOTAMs, airspaces, SUP AIP zones
 * and aerodromes, and nothing else. It has no SIGMETs, no METAR stations, no
 * VAC panels, no navaids or obstacles, and no route pins, because it ships
 * none of those datasets.
 *
 * The gather is written out rather than passed in as a list of probes: this
 * runs on every pointer move through the cursor loop, and a parameterised
 * gather would allocate a closure per kind per frame, which is the cost
 * docs/performance-2026-08.md finding 2 was written about.
 *
 * The rule it must not break is docs/map-hit-testing.md's: a FILLED AREA NEVER
 * TAKES THE CLICK ITSELF. Every path this map draws is interactive:false and
 * resolved here, in two tiers, aimed targets first and then the smallest drawn
 * shape. tests/mapClickTargets.spec.ts enforces the first half structurally
 * over this directory.
 */

import type L from 'leaflet';
import type { Airport } from '$lib/data/airports';
import type { Airspace } from '$lib/data/airspaces';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { airportHit, airportsAt } from './airportLayer';
import { airspaceAreaAt } from './airspaceLayer';
import { AREA_PANE_Z, bestArea, rankArea, type AreaCandidate } from './areaRank';
import { notamAreaAt, notamAreasAt } from '$lib/state/notamHit.svelte';
import { supaipAreaAt, supaipZonesAt, type VisibleZone } from '$lib/state/supaip.svelte';
import { airspaceStackAt } from '$lib/state/airspaceStack';

/** The topmost clickable feature under a point. A subset of the flight app's
 *  FeatureHit, by construction: the kinds this map can draw. */
export type NotamFeatureHit =
	| { kind: 'airport'; id: string }
	| { kind: 'notam'; index: number }
	| { kind: 'supaip'; id: string; zone: number }
	| { kind: 'airspace'; key: string; category: Airspace['category'] };

/** The area tier: the smallest DRAWN shape under the point, whatever kind drew
 *  it. Every kind is asked (no short-circuit), because the answer is the
 *  smallest of them and not the first. */
function areaAt(map: L.Map, lat: number, lon: number): NotamFeatureHit | null {
	const candidates: AreaCandidate<NotamFeatureHit>[] = [];
	const notam = notamAreaAt(lat, lon);
	if (notam) {
		candidates.push({
			hit: { kind: 'notam', index: notam.it.index },
			areaM2: rankArea(notam.areaM2),
			z: AREA_PANE_Z.notam,
		});
	}
	const supaip = supaipAreaAt(lat, lon);
	if (supaip) {
		candidates.push({
			hit: { kind: 'supaip', id: supaip.zone.sup.id, zone: supaip.zone.zoneIndex },
			areaM2: rankArea(supaip.areaM2),
			z: AREA_PANE_Z.supaip,
		});
	}
	const airspace = airspaceAreaAt(map, lat, lon);
	if (airspace) {
		candidates.push({
			hit: {
				kind: 'airspace',
				key: airspace.airspace.key,
				category: airspace.airspace.category,
			},
			areaM2: rankArea(airspace.areaM2),
			z: AREA_PANE_Z.airspace,
		});
	}
	return bestArea(candidates);
}

/** Resolve the single feature a click should select: the aerodrome aimed at,
 *  else the smallest area under the point. Null when the point hits nothing.
 *  The point tier short-circuits, which is what keeps an aerodrome clickable
 *  through a NOTAM area lying over it. */
export function notamFeatureAt(map: L.Map, lat: number, lon: number): NotamFeatureHit | null {
	const airport = airportHit(map, lat, lon);
	if (airport) {
		return { kind: 'airport', id: airport.ident };
	}
	return areaAt(map, lat, lon);
}

/** Everything stacked under a point, for the right-click "what is here?" menu.
 *
 *  The two surfaces gate differently, exactly as the flight app's do. The
 *  click is WYSIWYG and follows what is drawn; the menu is a location query,
 *  so its AREA sections list from the DATASETS regardless of the layer
 *  toggles, subset only by the data filters. With every checkbox off, the full
 *  stack over a point is still one right-click away. */
export interface NotamContextFeatures {
	airports: Airport[];
	notams: IndexedNotam[];
	supaip: VisibleZone[];
	airspaces: Airspace[];
}

export function notamContextFeaturesAt(
	map: L.Map,
	lat: number,
	lon: number,
): NotamContextFeatures {
	return {
		airports: airportsAt(map, lat, lon),
		notams: notamAreasAt(map, lat, lon),
		supaip: supaipZonesAt(lat, lon),
		// From the dataset, narrowed by the altitude filter alone: the menu
		// answers "what is here", not "what did you leave switched on".
		airspaces: airspaceStackAt(lat, lon),
	};
}
