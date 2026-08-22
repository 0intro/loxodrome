/* The distance-profile modals' shared overlay deriveds (RouteProfileModal
 * over the active route, NavProfileModal over the thinned trace): corridor
 * obstacle marks, NOTAM bands, temporary NOTAM obstacles, and the
 * activation join onto the airspace corridor bands. One builder taking a
 * source adapter (the distance axis is the only difference: route
 * waypoints + doc.wpPoints vs the trace polyline + its cumNM), so the two
 * profiles agree by construction (docs/route-profile.md "Trace profile").
 * The dossier print (flightprep/PrintDoc.svelte) keeps its own copy
 * deliberately: it prints all layers unconditionally, with no toggles and
 * no tick, and is out of scope here.
 *
 * Reactivity: everything is $derived state read through getters, created
 * in the calling component's context. The NOTAM layers track the minute
 * tick (validity edges drop off while a modal sits open) and every filter
 * through visibleNotams(); they are kept OUT of the profile docs on
 * purpose, so a filter keystroke never re-runs the heavy airspace walks
 * (the tick-free doc invariant). */

import { t } from '$lib/state/i18n.svelte';
import { profileLayers } from '$lib/state/profileLayers.svelte';
import { routeSettings, type Waypoint } from '$lib/state/route.svelte';
import { activeEvalWindow, notamState, visibleNotams } from '$lib/state/notam.svelte';
import { activatedAirspaceIds, activatedAirspaceLinks } from '$lib/state/notamLinks.svelte';
import { isActivationQCode } from '$lib/notam/qcode';
import { dataState, getObstacles } from '$lib/state/data.svelte';
import { profileObstacleMarks, type ObstacleMark } from '$lib/route/minAltitude';
import {
	bandActivationInfo,
	computeNotamProfileBands,
	notamObstacleMarks,
	placeNotamBands,
	type NotamCorridorBand,
	type NotamObstacleMark,
	type PlacedNotamBand,
} from '$lib/route/notamProfile';
import { terrainFtAt } from '$lib/route/routeProfile';
import type { AirspaceCorridorBand } from '$lib/route/airspaces';
import type { TerrainSample } from '$lib/map/terrain';

export interface ProfileOverlaySource {
	/** Enough data to draw (>= 2 points); every layer gates on it. */
	enough: () => boolean;
	/** Track polyline + cumulative distances (1:1, index-aligned) for the
	 *  point-mark walks: the route's waypoints + doc.wpPoints distances, or
	 *  the thinned trace + its cumNM. */
	pts: () => { lat: number; lon: number }[];
	cumNM: () => number[];
	/** The NOTAM band walk's waypoint list: the route's own waypoints, or
	 *  traceAsWaypoints over the thinned trace. */
	bandWaypoints: () => Waypoint[];
	/** The profile's terrain samples (AGL band edges + obstacle tops). */
	terrain: () => TerrainSample[];
	/** The doc's airspace corridor bands (the activation join). */
	corridorBands: () => AirspaceCorridorBand[];
}

export interface ProfileOverlays {
	/** Corridor obstacles with their locale-aware tooltip; null while the
	 *  layer is off or the lazy dataset is absent. */
	readonly profileObstacles: (ObstacleMark & { tip: string })[] | null;
	/** Track-crossing NOTAM bands (the context menus read these raw). */
	readonly notamBandsRaw: NotamCorridorBand[];
	/** The bands placed against the terrain; null when there are none. */
	readonly profileNotamBands: PlacedNotamBand[] | null;
	/** Temporary obstacles from obstacle NOTAMs (bare positions). */
	readonly profileNotamObstacles: (NotamObstacleMark & { tip: string })[] | null;
	/** band key -> "Activated by ..." tooltip line, UNGATED: activation is
	 *  a fact about the airspace, and the route modal's crossings strip
	 *  reads it even with the NOTAMs overlay toggled off. */
	readonly bandActivationsRaw: Map<string, string> | null;
	/** The chart's copy: hatch + tooltip suffix are NOTAM content and
	 *  follow the NOTAMs overlay toggle. */
	readonly bandActivations: Map<string, string> | null;
}

// Locale-aware tooltip: type label + name, top AMSL, height AGL, LGTD.
function obstacleTip(m: ObstacleMark): string {
	const typeLabel = t.data.obstacleTypes[m.type];
	const head = m.name && m.name !== typeLabel ? `${typeLabel} ${m.name}` : typeLabel;
	// i18n-ignore-start: ICAO abbreviations + units (ft AMSL / AGL, LGTD), locale-invariant
	const agl = m.hgt != null ? ` (${Math.round(m.hgt)} ft AGL)` : '';
	return `${head}\n${Math.round(m.topFt)} ft AMSL${agl}${m.lit ? '\nLGTD' : ''}`;
	// i18n-ignore-end
}

export function createProfileOverlays(src: ProfileOverlaySource): ProfileOverlays {
	// Corridor obstacles: min-alt-corridor marks over the AIP dataset (the
	// caller lazy-loads it; the map's layer/publisher toggles are
	// display-only and deliberately don't apply here).
	const profileObstacles = $derived.by<(ObstacleMark & { tip: string })[] | null>(() => {
		if (!profileLayers.obstacles || !src.enough()) {
			return null;
		}
		void dataState.obstaclesLoaded; // refire once the lazy dataset lands
		const obs = getObstacles();
		if (!obs) {
			return null;
		}
		return profileObstacleMarks(
			src.pts(),
			src.cumNM(),
			obs,
			routeSettings.minAltCorridorRadiusNM,
		).map((m) => ({ ...m, tip: obstacleTip(m) }));
	});

	// NOTAM bands: zero-width track crossings of visibleNotams()'s published
	// geometry. An activation NOTAM whose zones the chart hatches is
	// excluded from the bands (its own geometry is the coarse Q circle).
	const notamBandsRaw = $derived.by<NotamCorridorBand[]>(() => {
		if (!profileLayers.notams || !src.enough()) {
			return [];
		}
		void notamState.tick; // validity edges drop off while the modal sits open
		return computeNotamProfileBands(
			src.bandWaypoints(),
			visibleNotams(),
			(n) => isActivationQCode(n.qCode) && activatedAirspaceIds(n).length > 0,
		);
	});
	const profileNotamBands = $derived.by(() =>
		notamBandsRaw.length > 0 ? placeNotamBands(notamBandsRaw, src.terrain()) : null,
	);

	// Temporary obstacles from obstacle NOTAMs (bare positions, which never
	// band): min-alt corridor width like the permanent marks, top resolved
	// against the profile terrain. Gated by the NOTAMs toggle (they are
	// NOTAM content; the Obstacles toggle governs the AIP dataset layer).
	const profileNotamObstacles = $derived.by<(NotamObstacleMark & { tip: string })[] | null>(() => {
		if (!profileLayers.notams || !src.enough()) {
			return null;
		}
		void notamState.tick;
		const marks = notamObstacleMarks(
			src.pts(),
			src.cumNM(),
			visibleNotams(),
			routeSettings.minAltCorridorRadiusNM,
			(d) => terrainFtAt(src.terrain(), d),
		);
		if (marks.length === 0) {
			return null;
		}
		// i18n-ignore-start: NOTAM id + ICAO abbreviations and units, locale-invariant
		return marks.map((m) => ({
			...m,
			tip: `NOTAM ${m.notamId}\n${Math.round(m.topFt)} ft AMSL${
				m.hgtFt != null ? ` (${Math.round(m.hgtFt)} ft AGL)` : ''
			}`,
		}));
		// i18n-ignore-end
	});

	// Activated airspace bands: the activation links (already gated by the
	// evaluation window, RTBA per-zone) joined to the corridor bands by
	// airspace id; the value is the tooltip suffix line.
	const bandActivationsRaw = $derived.by<Map<string, string> | null>(() => {
		const links = activatedAirspaceLinks();
		if (links.size === 0) {
			return null;
		}
		const { from, to } = activeEvalWindow();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
		const out = new Map<string, string>();
		for (const b of src.corridorBands()) {
			const l = links.get(b.id);
			if (!l) {
				continue;
			}
			const info = bandActivationInfo(b.id, l, from, to);
			if (info.notamIds.length === 0) {
				continue;
			}
			const w = info.windows.length > 0 ? ` (${info.windows.join(', ')})` : '';
			out.set(b.key, `${t.route.bandActivatedBy} ${info.notamIds.join(', ')}${w}`);
		}
		return out.size > 0 ? out : null;
	});
	const bandActivations = $derived(profileLayers.notams ? bandActivationsRaw : null);

	return {
		get profileObstacles() {
			return profileObstacles;
		},
		get notamBandsRaw() {
			return notamBandsRaw;
		},
		get profileNotamBands() {
			return profileNotamBands;
		},
		get profileNotamObstacles() {
			return profileNotamObstacles;
		},
		get bandActivationsRaw() {
			return bandActivationsRaw;
		},
		get bandActivations() {
			return bandActivations;
		},
	};
}
