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
import {
	bandCrossings,
	terrainFtAt,
	type AltitudeVertex,
	type BandCrossing,
	type PlacedBand,
} from '$lib/route/routeProfile';
import { gatedAirspaceBandKeys, rescuedBandKeys } from '$lib/route/airspaceFilter';
import { profileAirspaceGroups } from '$lib/state/profileAirspaceFilter.svelte';
import { activeAltitudeBand } from '$lib/state/filter.svelte';
import { sampleCeilingFt } from '$lib/map/terrain';
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
	/** The doc's airspace corridor bands, RAW: the activation join and the
	 *  airspace gate's own input. Never hand this the gated array; see the
	 *  `crossings` note below. */
	corridorBands: () => AirspaceCorridorBand[];
	/** The doc's placed bands, RAW: the chart's input and the gate's output. */
	placedBands: () => PlacedBand[];
	/** The drawn line: the plan's altitude path, or the trace's recorded
	 *  one. What "penetrates" is measured against. */
	pathVertices: () => AltitudeVertex[];
	/** routeSettings.vfr: the class-E penetration exemption and the
	 *  forbidden tier both read it. */
	vfr: () => boolean;
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
	/** The activated keys as a bare set, UNGATED like bandActivationsRaw:
	 *  what the forbidden verdict is graded against, on the chart as well
	 *  as in the strip. */
	readonly activeBandKeys: ReadonlySet<string>;
	/** Every volume the drawn line penetrates, airspace AND NOTAM bands,
	 *  computed over the FULL band set: a verdict must not change when a
	 *  display toggle flips, which is also Garmin's own rule ("Alert
	 *  settings do not alter the depiction of airspace", and the reverse).
	 *  The route modal renders it as the crossings strip and is its only
	 *  reader; being $derived it is simply never computed on the trace
	 *  profile, which shows no strip (docs/route-profile.md "Trace
	 *  profile"). The airspace gate below deliberately does NOT read it. */
	readonly crossings: BandCrossing[];
	/** The bands the chart draws, and the SAME set as corridor rows for the
	 *  stack menu: one key set, so the menu can never list a band the chart
	 *  did not draw (docs/route-profile.md "Cursor readout"). */
	readonly shownBands: PlacedBand[];
	readonly shownCorridorBands: AirspaceCorridorBand[];
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
			// An obstacle top stated as a height sits above the HIGHEST ground
			// it could be standing on.
			(d) => terrainFtAt(src.terrain(), d, sampleCeilingFt),
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
	const activeBandKeys = $derived.by<ReadonlySet<string>>(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
		return new Set(bandActivationsRaw?.keys() ?? []);
	});

	// Crossings: over the FULL band set, always, so a display toggle can
	// never delete a NO-GO row from the strip. Nothing here feeds the
	// airspace gate below, which grades its own rescue from the bands that
	// gate actually dropped; see its own note.
	const crossings = $derived.by<BandCrossing[]>(() => {
		const path = src.pathVertices();
		if (path.length < 2) {
			return [];
		}
		return bandCrossings([...src.placedBands(), ...(profileNotamBands ?? [])], path, {
			vfr: src.vfr(),
			activeKeys: activeBandKeys,
		});
	});

	/* The pilot's filter rows + the toolbar level band, with every forbidden
	 * crossing rescued back in. TWO passes on purpose. The cheap one knows
	 * nothing of the drawn line and answers null while neither gate hides
	 * anything, so a default install does no work at all; the expensive one
	 * is then asked only of the bands the cheap one DROPPED, and even there
	 * the O(1) forbidden test runs before any penetration walk.
	 *
	 * It deliberately does NOT read `crossings`: that set carries the NOTAM
	 * bands too and so tracks the minute tick and every NOTAM filter, none
	 * of which can change which AIRSPACE bands are drawn. Reading it here
	 * put a ~30-band, 600-vertex penetration walk on the trace profile's
	 * tick, for an answer that never moved. */
	const shownKeys = $derived.by<Set<string> | null>(() => {
		const gate = gatedAirspaceBandKeys(src.corridorBands(), {
			groups: profileAirspaceGroups,
			band: activeAltitudeBand(),
		});
		if (!gate || gate.hidden.size === 0) {
			// Nothing hidden IS the identity case, whether the controls are
			// inert (gate null) or simply hide nothing on this route: the
			// caller keeps its own arrays, their identity included, so the
			// deriveds below do not invalidate on a set that says "all".
			return null;
		}
		const hidden = src.placedBands().filter((b) => gate.hidden.has(b.key));
		for (const key of rescuedBandKeys(hidden, src.pathVertices(), {
			vfr: src.vfr(),
			activeKeys: activeBandKeys,
		})) {
			gate.shown.add(key);
		}
		return gate.shown;
	});
	const shownBands = $derived(
		shownKeys ? src.placedBands().filter((b) => shownKeys.has(b.key)) : src.placedBands(),
	);
	const shownCorridorBands = $derived(
		shownKeys ? src.corridorBands().filter((b) => shownKeys.has(b.key)) : src.corridorBands(),
	);

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
		get activeBandKeys() {
			return activeBandKeys;
		},
		get crossings() {
			return crossings;
		},
		get shownBands() {
			return shownBands;
		},
		get shownCorridorBands() {
			return shownCorridorBands;
		},
	};
}
