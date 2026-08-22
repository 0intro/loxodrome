/* Pure (Leaflet type-only) hit-testing for the map's pointer interactions.
 * featureAt resolves the single topmost clickable feature under a point;
 * contextFeaturesAt gathers every feature stacked there for the right-click
 * menu. Kept out of MapView so the airport > navaid > obstacle > SUP AIP >
 * airspace ordering lives in one place (it drives both the click selection and
 * the hover cursor) and can be unit-tested.
 *
 * The two surfaces gate differently on purpose: featureAt is WYSIWYG (you
 * click what you see, so its hit-tests follow the layer toggles, with the
 * documented activated / NOTAM-linked / station exceptions), while the
 * context menu is a "what's here?" location query: its AREA features
 * (airspaces, SUP AIP zones) list from the datasets regardless of the
 * Layers-tab toggles, subset only by the data filters. Point features
 * (airports / navaids / obstacles / stations) follow the map in both: their
 * gathers are pixel-radius near-click tests only meaningful for drawn
 * glyphs, and the obstacle / navaid datasets lazy-load. */

import type L from 'leaflet';
import type { Airport } from '$lib/data/airports';
import { airspacesOver, type Airspace } from '$lib/data/airspaces';
import type { Obstacle } from '$lib/data/obstacles';
import type { Navaid } from '$lib/data/navaids';
import type { IndexedNotam } from '$lib/state/notam.svelte';
import { airportHit, airportsAt, nearestAirportUngated } from './airportLayer';
import { navaidHit, navaidsAt, nearestNavaidUngated } from './navaidLayer';
import { natureHit } from './natureLayer';
import { obstacleHit, obstaclesAt } from './obstacleLayer';
import { airspaceAt } from './airspaceLayer';
import { stationNear } from './metarLayer';
import type { MapStation } from '$lib/state/metarStations.svelte';
import { notamAreasAt } from '$lib/state/notamHit.svelte';
import { supaipAt, supaipZonesAt, type VisibleZone } from '$lib/state/supaip.svelte';
import { sigmetAt, sigmetsAt } from '$lib/state/sigmets.svelte';
import type { Sigmet } from '$lib/weather/sigmet';
import { activeRoute, type Waypoint } from '$lib/state/route.svelte';
import { airportByIdent, getAirspaces } from '$lib/state/data.svelte';
import { activeAltitudeBand } from '$lib/state/filter.svelte';
import { airspaceInBand } from '$lib/state/profile.svelte';

/** The topmost clickable feature under a point. The airspace variant
 *  carries its category so the hover handler can suppress the pointer
 *  cursor over FIR/UIR while a click still selects them. */
export type FeatureHit =
	| { kind: 'station'; id: string; lat: number; lon: number; name?: string | undefined }
	| { kind: 'airport'; id: string }
	| { kind: 'nature'; id: string }
	| { kind: 'navaid'; id: string }
	| { kind: 'obstacle'; id: string }
	| { kind: 'supaip'; id: string; zone: number }
	| { kind: 'sigmet'; id: string }
	| { kind: 'airspace'; key: string; category: Airspace['category'] };

/** A click on a METAR station dot needs to hit the DOT, not the whole barb:
 *  the hover badge uses stationNear's loose default, but at planning zooms a
 *  loose click radius would misdirect clicks meant for a nearby airfield. */
const STATION_CLICK_PX = 10;

/** Resolve the single feature a click should select, in draw order: METAR
 *  station dots (z 415) over airports (z 400) over navaids (z 390) over
 *  obstacles (z 380) over SUP AIP (z 360) over airspaces (z 350). Returns
 *  null when the point hits nothing. Short-circuits so a lower layer's
 *  hit-test only runs once the layers above it miss; this is why airports
 *  stay clickable through a SUP AIP zone. */
export function featureAt(map: L.Map, lat: number, lon: number): FeatureHit | null {
	// A METAR station dot (pane 415, above the aerodrome symbol) is its own
	// clickable feature with a dedicated weather panel: every station hit
	// selects the station, which links to its aerodrome when the ident is in
	// the airports dataset. Probed first with a tight tolerance (the dot, not
	// the loose hover radius) so a click meant for a nearby airfield is not
	// captured; clickable with the airports layer off.
	const station = stationNear(map, lat, lon, STATION_CLICK_PX);
	if (station) {
		const m = station.metar;
		return { kind: 'station', id: m.icaoId, lat: m.lat, lon: m.lon, name: m.name ?? undefined };
	}
	const airport = airportHit(map, lat, lon);
	if (airport) {
		return { kind: 'airport', id: airport.ident };
	}
	// Nature symbols sit in the z-395 pane, above navaids.
	const nature = natureHit(map, lat, lon);
	if (nature) {
		return { kind: 'nature', id: nature.id };
	}
	const navaid = navaidHit(map, lat, lon);
	if (navaid) {
		return { kind: 'navaid', id: navaid.id };
	}
	const obstacle = obstacleHit(map, lat, lon);
	if (obstacle) {
		return { kind: 'obstacle', id: obstacle.id };
	}
	const supaip = supaipAt(lat, lon);
	if (supaip) {
		return { kind: 'supaip', id: supaip.sup.id, zone: supaip.zoneIndex };
	}
	// SIGMET advisories draw above every polygon overlay (z 435) but yield
	// to all the point features above; they win only over the airspaces.
	const sigmet = sigmetAt(lat, lon);
	if (sigmet) {
		return { kind: 'sigmet', id: sigmet.id };
	}
	const airspace = airspaceAt(map, lat, lon);
	if (airspace) {
		return { kind: 'airspace', key: airspace.key, category: airspace.category };
	}
	return null;
}

/** Every feature stacked under a point, for the right-click context menu. */
export interface ContextFeatures {
	notams: IndexedNotam[];
	stations: MapStation[];
	airports: Airport[];
	navaids: Navaid[];
	airspaces: Airspace[];
	obstacles: Obstacle[];
	supaips: VisibleZone[];
	sigmets: Sigmet[];
	waypoints: Waypoint[];
	leg: number | null;
}

/* A right-click on a route waypoint pin should also offer the airport / navaid
 * the pin is anchored to. The pin is a 26 px disc centred on the feature, so at
 * a low planning zoom the feature can be hidden by its per-type zoom gate or sit
 * far outside airportsAt / navaidsAt's 500 m radius (13 px is tens of km at zoom
 * 6); either way those gathers miss it. We instead test the click against each
 * pin in pixels, then resolve the exact anchored feature through the ungated
 * index lookups (the same ones snapping uses), guarded by the waypoint's refId
 * so a coincidental neighbour is never substituted. Only the active route draws
 * pins, so only its waypoints count. */
const PIN_HIT_PX = 14;

function routeAnchoredFeaturesAt(
	map: L.Map,
	lat: number,
	lon: number,
): { airports: Airport[]; navaids: Navaid[] } {
	const airports: Airport[] = [];
	const navaids: Navaid[] = [];
	const pinned = activeRoute().waypoints.filter((w) => w.kind !== 'free' && w.refId);
	if (pinned.length === 0) {
		return { airports, navaids };
	}
	const click = map.latLngToLayerPoint([lat, lon]);
	for (const wp of pinned) {
		const p = map.latLngToLayerPoint([wp.lat, wp.lon]);
		const dx = p.x - click.x;
		const dy = p.y - click.y;
		if (dx * dx + dy * dy > PIN_HIT_PX * PIN_HIT_PX) {
			continue;
		}
		if (wp.kind === 'airport') {
			const r = nearestAirportUngated(wp.lat, wp.lon, 250);
			if (r && r.airport.ident.toUpperCase() === wp.refId) {
				airports.push(r.airport);
			}
		} else {
			const r = nearestNavaidUngated(wp.lat, wp.lon, 250);
			if (r && r.navaid.id === wp.refId) {
				navaids.push(r.navaid);
			}
		}
	}
	return { airports, navaids };
}

/** Active-route waypoints whose pin sits under the click, nearest first.
 *  Mirrors routeAnchoredFeaturesAt's pixel hit-test but returns the waypoints
 *  themselves, so the context menu can offer "Remove waypoint". Only the active
 *  route draws pins, so only its waypoints are removable here. */
function routeWaypointsAt(map: L.Map, lat: number, lon: number): Waypoint[] {
	const wps = activeRoute().waypoints;
	if (wps.length === 0) {
		return [];
	}
	const click = map.latLngToLayerPoint([lat, lon]);
	const hits: { wp: Waypoint; d2: number }[] = [];
	for (const wp of wps) {
		const p = map.latLngToLayerPoint([wp.lat, wp.lon]);
		const dx = p.x - click.x;
		const dy = p.y - click.y;
		const d2 = dx * dx + dy * dy;
		if (d2 <= PIN_HIT_PX * PIN_HIT_PX) {
			hits.push({ wp, d2 });
		}
	}
	hits.sort((a, b) => a.d2 - b.d2);
	return hits.map((h) => h.wp);
}

/** Squared pixel distance from (px,py) to segment (ax,ay)-(bx,by). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

const LEG_HIT_PX = 12;

/** Index of the active-route leg whose segment passes under the click within
 *  LEG_HIT_PX (nearest wins), as the insert-after position for
 *  insertWaypointAfter; null if none is close or the route has < 2 waypoints.
 *  Pixel-space like routeWaypointsAt; interactions.ts keeps Leaflet type-only
 *  (Node-testable), so the point-to-segment math is inline, not L.LineUtil. */
function routeLegAt(map: L.Map, lat: number, lon: number): number | null {
	const wps = activeRoute().waypoints;
	if (wps.length < 2) {
		return null;
	}
	const click = map.latLngToLayerPoint([lat, lon]);
	let bestIdx = -1;
	let bestD2 = Infinity;
	for (let i = 0; i + 1 < wps.length; i++) {
		const a = map.latLngToLayerPoint([wps[i].lat, wps[i].lon]);
		const b = map.latLngToLayerPoint([wps[i + 1].lat, wps[i + 1].lon]);
		const d2 = segDist2(click.x, click.y, a.x, a.y, b.x, b.y);
		if (d2 < bestD2) {
			bestD2 = d2;
			bestIdx = i;
		}
	}
	return bestIdx >= 0 && bestD2 <= LEG_HIT_PX * LEG_HIT_PX ? bestIdx : null;
}

/** Concatenation of `items` with later duplicates (same key) dropped. Keeps the
 *  pin-anchored features first and guards the menu against duplicate Svelte keys
 *  when a feature is both pin-anchored and gated-in. */
function dedupeBy<T>(items: T[], key: (x: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const k = key(item);
		if (!seen.has(k)) {
			seen.add(k);
			out.push(item);
		}
	}
	return out;
}

/** Every airspace containing the point, from the DATASET, not the map layer:
 *  the context menu lists the full stack regardless of the category /
 *  publisher toggles, the route-only filter and zoom (all display-only; each
 *  row's hover highlight draws a clone when its polygon is hidden). Only the
 *  altitude filter, a data filter, subsets it. Band-ordered like the map's
 *  own stack; one-shot per right-click, so the linear bbox-prefiltered scan
 *  is fine. */
function airspaceStackAt(lat: number, lon: number): Airspace[] {
	const all = getAirspaces();
	if (!all) {
		return [];
	}
	const stack = airspacesOver(all, lat, lon);
	const band = activeAltitudeBand();
	return band ? stack.filter((a) => airspaceInBand(a, band)) : stack;
}

export function contextFeaturesAt(map: L.Map, lat: number, lon: number): ContextFeatures {
	// Surface the airport / navaid a route waypoint pin is anchored to, ahead of
	// (and de-duped against) the zoom-gated gathers (see routeAnchoredFeaturesAt).
	const pinned = routeAnchoredFeaturesAt(map, lat, lon);
	const waypoints = routeWaypointsAt(map, lat, lon);
	// A METAR station dot also offers its airport (the airports gather is
	// layer-gated and misses it with the airports layer off); dedupeBy
	// absorbs the duplicate when both are visible.
	const station = stationNear(map, lat, lon, STATION_CLICK_PX);
	const stationAirport = station ? airportByIdent(station.metar.icaoId) : null;
	return {
		notams: notamAreasAt(map, lat, lon),
		stations: station ? [station] : [],
		airports: dedupeBy(
			[...(stationAirport ? [stationAirport] : []), ...pinned.airports, ...airportsAt(map, lat, lon)],
			(a) => a.ident.toUpperCase(),
		),
		navaids: dedupeBy([...pinned.navaids, ...navaidsAt(map, lat, lon)], (n) => n.id),
		airspaces: airspaceStackAt(lat, lon),
		obstacles: obstaclesAt(map, lat, lon),
		supaips: supaipZonesAt(lat, lon),
		sigmets: sigmetsAt(lat, lon),
		waypoints,
		// Leg insert only when not already on a pin (the pin's own actions win).
		leg: waypoints.length > 0 ? null : routeLegAt(map, lat, lon),
	};
}
