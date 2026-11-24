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
 * (the tick-free doc invariant).
 *
 * The chart DRAWS what the list shows: visibleNotams() and the display
 * join, filters and period applied. The crossings strip, the forbidden
 * rescue and the forbidden marks are VERDICTS, and read the raw briefing
 * over the source's verdict window instead, the planned flight's for the
 * route: a list filter or a bounded look-ahead removed a NO-GO row. */

import { t } from '$lib/state/i18n.svelte';
import { profileLayers } from '$lib/state/profileLayers.svelte';
import { routeSettings, type Waypoint } from '$lib/state/route.svelte';
import { activeEvalWindow, notamState, rawNotamsDuring, visibleNotams } from '$lib/state/notam.svelte';
import { activatedAirspaceLinksRaw } from '$lib/state/notamLinks.svelte';
import { bandNotes, bandStates, crossingRanges } from '$lib/state/activity.svelte';
import { activationRepresented, routeNotamBands, routeSupBands, routeZsmBands } from '$lib/state/routeCrossings.svelte';
import { crossingNoteLines } from './zoneStateText';
import { bandHatch } from './profileBand';
import type { PlacedSupBand } from '$lib/route/supProfile';
import type { PlacedZsmBand } from '$lib/route/zsmProfile';
import { bandIntersects } from '$lib/vertical/limits';
import { dataState, getObstacles } from '$lib/state/data.svelte';
import { profileObstacleMarks, type ObstacleMark } from '$lib/route/minAltitude';
import {
	computeNotamProfileBands,
	notamObstacleMarks,
	placeNotamBands,
	type NotamCorridorBand,
	type NotamObstacleMark,
	type PlacedNotamBand,
} from '$lib/route/notamProfile';
import {
	bandCrossings,
	terrainFtNear,
	type AltitudeVertex,
	type BandCrossing,
	type PlacedBand,
} from '$lib/route/routeProfile';
import { gatedAirspaceBandKeys, rescuedBandKeys } from '$lib/route/airspaceFilter';
import { airspaceGroupShown } from '$lib/data/airspaces';
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
	/** The window the verdicts are judged over: the planned flight's for
	 *  the route (planScope.flight.briefingWindow), the viewing period for
	 *  the trace. */
	verdictWindow: () => { from: number; to: number };
	/** What the briefing leaves unknown of the zones activated by NOTAM, for
	 *  the route (state/briefing.svelte.ts briefingActivityUnknown). The
	 *  trace, a flight already flown, has no planned flight to judge. */
	activityUnknown?: (() => { notam: boolean; rtba: boolean }) | undefined;
	/** The instant the flight reaches a distance, by which each crossing is
	 *  judged at its own time (state/activity.svelte.ts crossingClock). A
	 *  null clock, or an absent one, judges them over the verdict window. */
	crossingClock?: (() => ((nm: number) => number) | null) | undefined;
}

export interface ProfileOverlays {
	/** Corridor obstacles with their locale-aware tooltip; null while the
	 *  layer is off or the lazy dataset is absent. */
	readonly profileObstacles: (ObstacleMark & { tip: string })[] | null;
	/** Track-crossing NOTAM bands (the context menus read these raw), empty
	 *  while the NOTAMs layer is off. */
	readonly notamBandsRaw: NotamCorridorBand[];
	/** The bands placed against the terrain, null when there are none or the
	 *  NOTAMs layer is off. */
	readonly profileNotamBands: PlacedNotamBand[] | null;
	/** The placed NOTAM bands of the RAW briefing over the verdict window,
	 *  whatever the NOTAMs layer and the list filters say: the crossings
	 *  strip's own, and what a click on one of its NOTAM rows resolves
	 *  against. Null when there are none. */
	readonly crossingNotamBands: PlacedNotamBand[] | null;
	/** Temporary obstacles from obstacle NOTAMs (bare positions). */
	readonly profileNotamObstacles: (NotamObstacleMark & { tip: string })[] | null;
	/** band key -> tooltip line for each band the chart hatches, its zone
	 *  active where the flight crosses it, read as the strip reads it
	 *  (profileBand.ts bandHatch): a verdict, which the NOTAMs toggle and the
	 *  list's filters leave alone. */
	readonly bandActivations: Map<string, string> | null;
	/** The keys of the airspace bands active over the verdict window, as
	 *  the alerts read them, UNGATED: what the forbidden verdict is graded
	 *  against, on the chart as well as in the strip. */
	readonly activeBandKeys: ReadonlySet<string>;
	/** What the strip says of each crossing beside its word, by band key
	 *  (zoneStateText.ts crossingNoteLines), null on the trace. */
	readonly crossingNotes: Map<string, string[]> | null;
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

/** The empty band list, one reference, so a derived answering it while the
 *  layer is off or the source is short invalidates nothing downstream. */
const NO_NOTAM_BANDS: NotamCorridorBand[] = [];

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

	// NOTAM bands: zero-width track crossings of a NOTAM set's published
	// geometry. An activation NOTAM whose zones the chart hatches is
	// excluded from the bands (its own geometry is the coarse Q circle).
	// The chart draws visibleNotams()'s, which follow the filters and the
	// period and, through the copies below, the NOTAMs layer. The crossings
	// strip is a verdict and walks the RAW briefing over the verdict window
	// whatever any of them say. Being $derived, each runs only for a reader,
	// so the trace profile, which shows no strip, pays for the verdict walk
	// only through its forbidden marks.
	// The exclusion and the verdict's recipes are the ones the Overview and
	// the dossier read (state/routeCrossings.svelte.ts).
	const notamBandsAll = $derived.by<NotamCorridorBand[]>(() => {
		if (!src.enough()) {
			return NO_NOTAM_BANDS;
		}
		void notamState.tick; // validity edges drop off while the modal sits open
		return computeNotamProfileBands(src.bandWaypoints(), visibleNotams(), activationRepresented);
	});
	// The verdict window as two numbers, so a window that holds through the
	// minute tick (a flight still to come) re-runs nothing downstream.
	const verdictSpan = $derived.by(() => {
		void notamState.tick;
		return src.verdictWindow();
	});
	const verdictFrom = $derived(verdictSpan.from);
	const verdictTo = $derived(verdictSpan.to);
	const crossingNotamBands = $derived.by(() =>
		src.enough()
			? routeNotamBands(src.bandWaypoints(), rawNotamsDuring({ from: verdictFrom, to: verdictTo }), src.terrain())
			: null,
	);
	const drawnNotamBands = $derived.by(() =>
		notamBandsAll.length > 0 ? placeNotamBands(notamBandsAll, src.terrain()) : null,
	);
	const notamBandsRaw = $derived(profileLayers.notams ? notamBandsAll : NO_NOTAM_BANDS);
	const profileNotamBands = $derived(profileLayers.notams ? drawnNotamBands : null);

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
			// it could be standing on, and above no ground while that is unread.
			(d) => terrainFtNear(src.terrain(), d, sampleCeilingFt),
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

	// The supplements' zones the route crosses (route/supProfile.ts), from
	// those in force over a range: the chart's over the viewing period, the
	// strip's over the verdict window.
	function supBands(from: number, to: number): PlacedSupBand[] | null {
		return src.enough() ? routeSupBands(src.bandWaypoints(), from, to, src.terrain()) : null;
	}
	const drawnSupBands = $derived.by(() => {
		const { from, to } = activeEvalWindow();
		return supBands(from, to);
	});
	const crossingSupBands = $derived(supBands(verdictFrom, verdictTo));

	// The raptor zones the route crosses (route/zsmProfile.ts), from those
	// active over a range, the chart's and the strip's as the supplements'.
	function zsmBands(from: number, to: number): PlacedZsmBand[] | null {
		return src.enough() ? routeZsmBands(src.bandWaypoints(), from, to, src.terrain()) : null;
	}
	const drawnZsmBands = $derived.by(() => {
		const { from, to } = activeEvalWindow();
		return zsmBands(from, to);
	});
	const crossingZsmBands = $derived(zsmBands(verdictFrom, verdictTo));

	// What the briefing leaves unknown, as two primitives: the verdict
	// behind them re-runs with each fix of a recording, and the crossings
	// below only when one of these flips.
	const unknownNotam = $derived(src.activityUnknown?.().notam ?? null);
	const unknownRtba = $derived(src.activityUnknown?.().rtba ?? null);

	// Each zone's state over the verdict window, read as the alerts read it
	// (state/activity.svelte.ts bandStates): the airspace bands' apart, the
	// gate's rescue reading them alone, and the NOTAM bands' beside them for
	// the strip.
	const unknownAnswer = () =>
		unknownNotam === null || unknownRtba === null ? null : { notam: unknownNotam, rtba: unknownRtba };
	// Each crossing at its own time while the source's clock runs
	// (crossingRanges), else over the whole verdict window.
	const clock = $derived(src.crossingClock?.() ?? null);
	const otherBands = $derived([...(crossingNotamBands ?? []), ...(crossingSupBands ?? []), ...(crossingZsmBands ?? [])]);
	const airspaceRanges = $derived(clock ? crossingRanges(src.placedBands(), clock) : null);
	const otherRanges = $derived(clock && otherBands.length > 0 ? crossingRanges(otherBands, clock) : null);
	const airspaceStates = $derived(
		bandStates(src.placedBands(), { fromMs: verdictFrom, toMs: verdictTo }, unknownAnswer(), airspaceRanges),
	);
	const notamStates = $derived(
		otherBands.length > 0
			? bandStates(otherBands, { fromMs: verdictFrom, toMs: verdictTo }, unknownAnswer(), otherRanges)
			: null,
	);
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's value, rebuilt whole
	const states = $derived(notamStates ? new Map([...airspaceStates, ...notamStates]) : airspaceStates);

	// The chart's hatch: each band whose zone is active where the flight
	// crosses it, as the strip reads it (profileBand.ts bandHatch). It is the
	// zone's state, a verdict, so the NOTAMs toggle and the list's filters
	// leave it alone. The trace, with no planned flight, reads its period.
	const bandActivations = $derived.by<Map<string, string> | null>(() =>
		bandHatch(
			states,
			// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's input, rebuilt whole
			new Map(src.corridorBands().map((b) => [b.key, b.id])),
			activatedAirspaceLinksRaw({ from: verdictFrom, to: verdictTo }),
			src.activityUnknown ? 'flight' : 'period',
			{ fromMs: verdictFrom, toMs: verdictTo },
		),
	);

	// What the strip says of each crossing beside its word
	// (zoneStateText.ts crossingNoteLines): the state with its period, who
	// knows, and a later change raising it before the verdict window ends,
	// the margin of a late flight. The trace, a flight already flown, has
	// none.
	const crossingNotes = $derived.by<Map<string, string[]> | null>(() => {
		if (!src.activityUnknown) {
			return null;
		}
		const at = { fromMs: verdictFrom, toMs: verdictTo };
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's input, rebuilt whole
		const crossed = new Set(crossings.map((c) => c.key));
		const bands = [...src.placedBands(), ...otherBands].filter((b) => crossed.has(b.key));
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's input, rebuilt whole
		const ranges = new Map([...(airspaceRanges ?? []), ...(otherRanges ?? [])]);
		const notes = bandNotes(bands, at, unknownAnswer(), ranges, verdictTo);
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's output, rebuilt whole
		const out = new Map<string, string[]>();
		for (const b of bands) {
			const a = states.get(b.key);
			const n = notes.get(b.key);
			if (!a || !n) {
				continue;
			}
			const exit = clock && b.spans.length > 0 ? clock(Math.max(...b.spans.map((s) => s.leaveNM))) : null;
			const lines = crossingNoteLines(a, n.known, n.next, exit, ranges.get(b.key) ?? at, n.note);
			if (lines.length > 0) {
				out.set(b.key, lines);
			}
		}
		return out.size > 0 ? out : null;
	});

	const activeBandKeys = $derived.by<ReadonlySet<string>>(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- derived output, rebuilt whole
		const out = new Set<string>();
		for (const [key, a] of airspaceStates) {
			if (a.state === 'active') {
				out.add(key);
			}
		}
		return out;
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
		return bandCrossings([...src.placedBands(), ...otherBands], path, {
			vfr: src.vfr(),
			states,
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
	// The supplement bands the chart draws: the pilot's rows and the level
	// band by their own type and limits, every NO-GO crossing kept.
	const profileSupBands = $derived.by<PlacedSupBand[] | null>(() => {
		if (!drawnSupBands) {
			return null;
		}
		const band = activeAltitudeBand();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's local lookup
		const forbidden = new Set(crossings.filter((c) => c.forbidden).map((c) => c.key));
		const shown = drawnSupBands.filter(
			(b) =>
				forbidden.has(b.key) ||
				(airspaceGroupShown(b, profileAirspaceGroups) && (!band || bandIntersects(b.vLower, b.vUpper, band))),
		);
		return shown.length > 0 ? shown : null;
	});
	// The raptor zone bands the chart draws: no row names them, so the level
	// band alone hides one.
	const profileZsmBands = $derived.by<PlacedZsmBand[] | null>(() => {
		if (!drawnZsmBands) {
			return null;
		}
		const band = activeAltitudeBand();
		const shown = band ? drawnZsmBands.filter((b) => bandIntersects(b.vLower, b.vUpper, band)) : drawnZsmBands;
		return shown.length > 0 ? shown : null;
	});
	const gatedBands = $derived(
		shownKeys ? src.placedBands().filter((b) => shownKeys.has(b.key)) : src.placedBands(),
	);
	const shownBands = $derived(
		profileSupBands || profileZsmBands
			? [...gatedBands, ...(profileSupBands ?? []), ...(profileZsmBands ?? [])]
			: gatedBands,
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
		get crossingNotamBands() {
			return crossingNotamBands;
		},
		get profileNotamObstacles() {
			return profileNotamObstacles;
		},
		get bandActivations() {
			return bandActivations;
		},
		get activeBandKeys() {
			return activeBandKeys;
		},
		get crossingNotes() {
			return crossingNotes;
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
