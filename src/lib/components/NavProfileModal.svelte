<script lang="ts" module>
	/* Session cache of the trace profile window (zoom + touched flags), ONE
	 * slot: there is a single active trace. Keyed by the trace's identity
	 * (point count + first/last timestamps) so a new import or recording
	 * drops it; restored on reopen, which is what makes the detail panel's
	 * "Back to trace profile" round trip land on the exact view left
	 * behind. Fit forgets it (the route modal's savedViews contract). */
	interface SavedTraceView {
		key: string;
		fromNM: number;
		toNM: number;
		floorFt: number;
		ceilingFt: number;
		distTouched: boolean;
		altTouched: boolean;
	}
	let savedTraceView: SavedTraceView | null = null;
</script>

<script lang="ts">
	/* Vertical profile of the recorded GPS trace: terrain, the airspaces flown
	 * through, the recorded-altitude line, and the overflown features (airports /
	 * navaids / reporting points + route waypoints). Reuses RouteProfile.svelte
	 * with route interactions off (showWaypointDots=false, no leg drag / winds)
	 * and a replay playhead synced to nav.playheadMs. Mirrors RouteProfileModal. */
	import { tick, untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import { isPrintingSurface, printSurface } from '$lib/ui/surfacePrint.svelte';
	import { tracePrintStem } from '$lib/state/printName';
	import { loadedTraceSubject } from '$lib/state/traceFile';
	import { PRINT_NAV_PLOT_H, PRINT_PLOT_W } from '$lib/ui/print';
	import RangeSlider from './RangeSlider.svelte';
	import RouteProfile from './RouteProfile.svelte';
	import ProfileAxisOverlay from './ProfileAxisOverlay.svelte';
	import { profileAirspaceGroupsRestrict } from '$lib/state/profileAirspaceFilter.svelte';
	import { TRACE_BAND_FILTER_GROUPS } from '$lib/data/airspaces';
	import ProfileAirspacesPopover from './ProfileAirspacesPopover.svelte';
	import ProfileLayersPopover from './ProfileLayersPopover.svelte';
	import ProfileReadout from './ProfileReadout.svelte';
	import ProfileStackMenu, { type StackNotamRow } from './ProfileStackMenu.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		navProfileModal,
		closeNavProfile,
		openNavProfile,
	} from '$lib/state/navProfileModal.svelte';
	import { openRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import Segmented from './Segmented.svelte';
	import {
		nav,
		poseAltMslFt,
		setPlayhead,
		togglePlay,
		traceAltDatum,
	} from '$lib/state/navRecording.svelte';
	import { activeRoute } from '$lib/state/route.svelte';
	import { adjacentReplayEvent, replayEvents } from '$lib/state/navLive.svelte';
	import {
		thinTrace,
		buildTraceProfileDoc,
		distNMAtTime,
		timeMsAtDistNM,
		traceAsWaypoints,
	} from '$lib/nav/traceProfile';
	import { hasAbsoluteTime, positionAt, traceEndMs, traceStartMs } from '$lib/nav/trace';
	import {
		ensureAirspaces,
		getAirspaces,
		ensureAirports,
		getAirports,
		ensureNavaids,
		getNavaids,
		ensureObstacles,
		airspaceByKey,
		airportByIdent,
		navaidById,
		obstacleById,
		dataState,
	} from '$lib/state/data.svelte';
	import {
		markDetailReturn,
		navigateToAirport,
		navigateToAirspace,
		navigateToNavaid,
		navigateToNotam,
		navigateToObstacle,
		ui,
	} from '$lib/state/ui.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { placementOf, surfaceSurvivesDetail, workspace } from '$lib/state/workspace.svelte';
	import { focusNotam } from '$lib/map/notamLayer';
	import { flyToBoundsVisible, flyToVisible } from '$lib/map/focus';
	import { exactFt } from '$lib/vertical/limits';
	import type { AirspaceCorridorBand } from '$lib/route/airspaces';
	import {
		sampleCeilingFt,
		sampleFloorFt,
		sampleProfile,
		type TerrainSample,
	} from '$lib/map/terrain';
	import {
		computeCeilingFt,
		followScrollLeft,
		stripPlotWidth,
		terrainFtAt,
		zoomScrollLeft,
	} from '$lib/route/routeProfile';
	import { createProfileWindow } from './profileWindow.svelte';
	import { createProfileOverlays } from './profileOverlays.svelte';
	import { fmtAlt, fmtClockUtcSec, fmtDurationMin, fmtDurationMs, fmtNM } from '$lib/route/format';
	import { routeSettings } from '$lib/state/route.svelte';
	import { profileLayers } from '$lib/state/profileLayers.svelte';
	import { notamState } from '$lib/state/notam.svelte';

	const enough = $derived(nav.points.length >= 2);
	// The recorded altitude is drawn against airspace bands whose limits are
	// AMSL and FL, so it is plotted on MSL, not on whatever datum the device
	// happened to report (nav/altitudeDatum.ts). The chart says which.
	const thinned = $derived(enough ? thinTrace(nav.points, 600, poseAltMslFt) : []);
	const altDatum = $derived(traceAltDatum());

	/* Header transport: replay is drivable from the chart, so a docked profile
	 * does not depend on the Navigation tab being the one on screen. */
	const traceStart = $derived(traceStartMs(nav.points));
	const traceEnd = $derived(traceEndMs(nav.points));
	const canReplay = $derived(
		!nav.recording && traceStart !== null && traceEnd !== null && traceEnd > traceStart,
	);
	const elapsedMin = $derived(
		traceStart === null ? 0 : Math.max(0, (nav.playheadMs - traceStart) / 60000),
	);
	// Debrief jump targets (the Navigation tab's pair). The canReplay guard
	// runs first so the events derived stays unevaluated while recording.
	const events = $derived(replayEvents());
	const prevEvent = $derived(canReplay ? adjacentReplayEvent(events, nav.playheadMs, -1) : null);
	const nextEvent = $derived(canReplay ? adjacentReplayEvent(events, nav.playheadMs, 1) : null);

	function jumpToEvent(e: { ms: number } | null): void {
		if (!e) {
			return;
		}
		setPlayhead(e.ms);
		locked = true;
	}

	// Load the datasets the profile needs while the modal is open.
	$effect(() => {
		if (!navProfileModal.open) {
			return;
		}
		if (!dataState.airspacesLoaded) {
			void ensureAirspaces().catch(() => {
				/* surfaced via dataState.airspacesError */
			});
		}
		if (!dataState.airportsLoaded) {
			void ensureAirports().catch(() => {});
		}
		if (!dataState.navaidsLoaded) {
			void ensureNavaids().catch(() => {});
		}
	});

	// Self-contained terrain fetch. The shared routeTerrain cache is keyed by
	// route id and pruned against routes.list (MapView.pruneRouteTerrain), so a
	// synthetic trace id would be aborted every time a route or the map updates.
	// The trace profile therefore fetches its own centerline, aborting on
	// supersede / close. The output is $state; the fetch bookkeeping is read-free
	// so this effect never subscribes to its own writes.
	let terrainSamples = $state<TerrainSample[]>([]);
	let terrainStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');

	$effect(() => {
		if (!navProfileModal.open || !enough) {
			return;
		}
		const coords = thinned.map((p) => ({ lat: p.lat, lon: p.lon }));
		terrainStatus = 'loading';
		const ctrl = new AbortController();
		void sampleProfile(coords, { signal: ctrl.signal })
			.then((s) => {
				if (!ctrl.signal.aborted) {
					terrainSamples = s;
					terrainStatus = 'ready';
				}
			})
			.catch(() => {
				if (!ctrl.signal.aborted) {
					terrainSamples = [];
					terrainStatus = 'error';
				}
			});
		return () => ctrl.abort();
	});
	const terrain = $derived(terrainSamples);
	/** A flown trace has no planning corridor, so the ground it FILLS is the
	 *  highest terrain in each sample's own footprint under the track: the
	 *  ridge between two sample points stops disappearing. The hairline over
	 *  it is the point value. */
	const groundFill = $derived<TerrainSample[] | undefined>(
		terrainSamples.length > 0
			? terrainSamples.map((t) => ({ ...t, elevFt: sampleCeilingFt(t) }))
			: undefined,
	);
	const terrainLoading = $derived(terrainStatus === 'loading');
	const terrainError = $derived(terrainStatus === 'error');

	const airspaces = $derived(dataState.airspacesLoaded ? getAirspaces() : null);
	const airports = $derived(dataState.airportsLoaded ? getAirports() : null);
	const navaids = $derived(dataState.navaidsLoaded ? getNavaids() : null);
	const routeWps = $derived.by(() => {
		const r = activeRoute();
		return r && r.waypoints.length >= 2 ? r.waypoints : null;
	});

	const doc = $derived(
		buildTraceProfileDoc({
			thinned,
			airspaces,
			terrain,
			route: routeWps,
			airports,
			navaids,
			typeLabels: t.data.airspaceTypes,
		}),
	);
	const totalNM = $derived(doc.totalNM);
	const fitCeilingFt = $derived(doc.fitCeilingFt);

	// The overlay adapter's distance axis: pts/cumNM come straight from the
	// thinned vertices (1:1, the projectPointToRoute contract).
	const tracePts = $derived(thinned.map((p) => ({ lat: p.lat, lon: p.lon })));
	const traceCumNM = $derived(thinned.map((p) => p.cumNM));

	// Corridor obstacles: the dataset lazy-loads when first needed; the map's
	// layer/publisher toggles are display-only and deliberately don't apply.
	$effect(() => {
		if (navProfileModal.open && profileLayers.obstacles && !dataState.obstaclesLoaded) {
			void ensureObstacles().catch(() => {
				/* surfaced via dataState.obstaclesError */
			});
		}
	});

	// The overlay deriveds (obstacle marks, NOTAM bands + activation hatch,
	// temporary NOTAM obstacles): the shared createProfileOverlays, run over
	// the thinned trace polyline instead of route waypoints (same
	// visibleNotams() basis, same min-alt corridor width, shared
	// profileLayers toggles), so the two profiles agree by construction;
	// docs/route-profile.md "Trace profile".
	const overlays = createProfileOverlays({
		enough: () => enough,
		pts: () => tracePts,
		cumNM: () => traceCumNM,
		bandWaypoints: () => traceAsWaypoints(thinned),
		terrain: () => terrain,
		// RAW, always: the activation join feeds the forbidden verdict, which
		// feeds the airspace gate's rescue. Handing it a gated array would
		// close that loop on itself (RouteProfileModal carries the long note).
		corridorBands: () => doc.corridorBands,
		placedBands: () => doc.placedBands,
		// The RECORDED altitude, so a forbidden crossing here means the
		// flight actually entered it: exactly what a debrief must keep on
		// screen whatever the filter rows say.
		pathVertices: () => doc.altitudePath.vertices,
		vfr: () => routeSettings.vfr,
	});

	// The altitude slider's track top, declared AFTER the overlays it reads:
	// the drawn bands, so zooming out reaches what is on the chart and the
	// airspace filter's level-band half actually shrinks the range.
	const dataCeilingFt = $derived(
		Math.max(
			fitCeilingFt,
			computeCeilingFt(
				doc.altitudePath.vertices.map((v) => v.altFt),
				terrain.flatMap((s) => (s.elevFt == null ? [] : [s.elevFt])),
				// The bands actually drawn: zooming out reaches the chart.
				overlays.shownBands,
			),
		),
	);

	/* Following a link out of the chart into a detail panel. With the map
	 * beside it (a docked profile) both stay up, so nothing moves and no
	 * breadcrumb is needed: seeing the chart and the panel at once is the
	 * whole point of docking. A profile that covers the map still has to get
	 * out of the way, and the panel's "Back to trace profile" arrow returns
	 * from that, reopening it with the saved window. On a PHONE nothing
	 * survives: the detail is the pane's third occupant and takes the dock
	 * this chart is sitting in, so the breadcrumb is what gets the pilot back
	 * to it (surfaceSurvivesDetail). */
	function leaveForDetail(): void {
		if (surfaceSurvivesDetail('navProfile')) {
			return;
		}
		markDetailReturn({
			label: () => t.detail.backToTraceProfile,
			reopen: openNavProfile,
		});
		closeNavProfile();
	}

	// Click-through navigation (the RouteProfileModal handlers with the
	// 'trace' origin): navigate, center the map on the feature, then hand
	// over to leaveForDetail.
	function onObstacleClick(id: string): void {
		navigateToObstacle(id);
		const o = obstacleById(id);
		if (o) {
			flyToVisible([o.lat, o.lon]);
		}
		leaveForDetail();
	}
	function onNotamClick(index: number): void {
		navigateToNotam(index);
		const n = notamState.notams[index];
		if (mapState.map && n) {
			focusNotam(mapState.map, n);
		}
		leaveForDetail();
	}
	// Overflown-feature label click: the identity rides doc.featureRefs
	// (index-parallel). Every branch centers the map; airport / navaid refs
	// carry only ids, so the position resolves through the dataset accessors.
	function onFeature(i: number): void {
		const ref = doc.featureRefs[i];
		if (!ref) {
			return;
		}
		if (ref.kind === 'airport') {
			navigateToAirport(ref.id);
				const a = airportByIdent(ref.id);
			if (a) {
				flyToVisible([a.lat, a.lon]);
			}
		} else if (ref.kind === 'navaid') {
			navigateToNavaid(ref.id);
				const n = navaidById(ref.id);
			if (n) {
				flyToVisible([n.lat, n.lon]);
			}
		} else {
			flyToVisible([ref.lat, ref.lon]);
		}
		leaveForDetail();
	}

	// Right-click context menu listing the airspaces AND NOTAM bands under
	// the cursor (the RouteProfileModal port, the mirror-file convention):
	// bands are seek-owned in trace mode, so this menu IS their navigation.
	// The rows are assembled here; ProfileStackMenu (the extra snippet)
	// renders them above the modal.
	let ctxMenu = $state<{
		open: boolean;
		x: number;
		y: number;
		bands: AirspaceCorridorBand[];
		notams: StackNotamRow[];
		/** Empty result BELOW every charted floor at this distance: the
		 *  pilot's conclusion is Classe G, so the empty row says so. */
		belowCharted: boolean;
	}>({
		open: false,
		x: 0,
		y: 0,
		bands: [],
		notams: [],
		belowCharted: false,
	});
	let ctxHoverKey = $state<string | null>(null);

	function onProfileContextMenu(distNM: number, altFt: number, clientX: number, clientY: number): void {
		// Containment at the cursor: AGL/ASFC limits resolve against the
		// terrain under the cursor's distance, so a terrain-hugging zone
		// lists exactly where its band is drawn.
		// Each edge of a band resolves against its own end of the ground,
		// exactly as the drawn band does, so the menu lists what the chart
		// shows.
		const floorGroundFt = terrainFtAt(terrain, distNM, sampleFloorFt);
		const ceilGroundFt = terrainFtAt(terrain, distNM, sampleCeilingFt);
		const bands = overlays.shownCorridorBands
			.filter(
				(b) =>
					b.spans.some((s) => distNM >= s.enterNM - 1e-6 && distNM <= s.leaveNM + 1e-6) &&
					altFt >= (b.vLower ? (exactFt(b.vLower, floorGroundFt) ?? b.vLower.ft) : Number.NEGATIVE_INFINITY) &&
					altFt <= (b.vUpper ? (exactFt(b.vUpper, ceilGroundFt) ?? b.vUpper.ft) : Number.POSITIVE_INFINITY),
			)
			.sort((a, b) => (a.vLower?.ft ?? 0) - (b.vLower?.ft ?? 0));
		// NOTAM bands under the cursor: same containment; an unknown-extent
		// band (dashed full-height) matches at any altitude over its span.
		const notams = overlays.notamBandsRaw
			.filter(
				(b) =>
					b.spans.some((s) => distNM >= s.enterNM - 1e-6 && distNM <= s.leaveNM + 1e-6) &&
					(!b.knownExtent ||
						(altFt >=
							(b.vLower ? (exactFt(b.vLower, floorGroundFt) ?? b.vLower.ft) : Number.NEGATIVE_INFINITY) &&
							altFt <=
								(b.vUpper ? (exactFt(b.vUpper, ceilGroundFt) ?? b.vUpper.ft) : Number.POSITIVE_INFINITY))),
			)
			.map((b) => ({ id: b.id, index: b.index, vLower: b.vLower, vUpper: b.vUpper, known: b.knownExtent }));
		// "Classe G" phrasing for an empty result: charted volumes exist at
		// this distance and the click sits below every one of their floors.
		// Over the UNGATED set: an absence the pilot's own filter created
		// must never be dressed up as a statement about the AIP.
		const over = doc.corridorBands.filter((b) =>
			b.spans.some((s) => distNM >= s.enterNM - 1e-6 && distNM <= s.leaveNM + 1e-6),
		);
		const belowCharted =
			bands.length === 0 &&
			over.length > 0 &&
			over.every((b) => b.vLower != null && altFt < (exactFt(b.vLower, floorGroundFt) ?? b.vLower.ft));
		ctxMenu = { open: true, x: clientX, y: clientY, bands, notams, belowCharted };
	}
	function closeCtxMenu(): void {
		ctxMenu.open = false;
		ctxHoverKey = null;
	}
	// Serves the ctx rows AND the band labels (onBandClick={onCtxSelect}):
	// navigates, centers the map on the zone (the panel crosshair's bbox
	// recipe), then hands over to leaveForDetail.
	function onCtxSelect(key: string): void {
		navigateToAirspace(key);
		const a = airspaceByKey(key);
		if (mapState.map && a) {
			flyToBoundsVisible(
				mapState.map,
				[
					[a.bbox.minLat, a.bbox.minLon],
					[a.bbox.maxLat, a.bbox.maxLon],
				],
				40,
				12,
			);
		}
		leaveForDetail();
	}

	// Profile cursor: hoverNM (along-track distance under the cursor) is reported
	// by RouteProfile; the docked readout reads the recorded fix there.
	let hoverNM = $state<number | null>(null);
	// Locked = the readout is pinned to the aircraft's point (a chart seek or a
	// transport jump put it there); hover no longer overrides it. Cleared by
	// clicking the panel to unlock, or on modal close. The lock is the READOUT's
	// state alone: it never gates the marker below.
	let locked = $state(false);
	// The aircraft on the chart: the replay playhead (the live tip while
	// recording, where the playhead rides the last fix), drawn whenever there is
	// a trace, exactly like the map's aircraft marker (currentPose) and the route
	// profile's ownship. A chart seek moves the aircraft here and locks the
	// readout on it; unlock releases the readout only, and the aircraft stays
	// where the seek put it, as the map's marker does. Gating this on the lock or
	// on playback hid the aircraft on a paused or scrubbed replay until the chart
	// was clicked once.
	const playheadNM = $derived(enough ? distNMAtTime(doc.timeline, nav.playheadMs) : null);
	// Absolute wall-clock present (live recording / GPX with <time>) vs a
	// synthesised 1 Hz clock from epoch 0 on a time-less GPX; gates "time of
	// day" (the shared trace helper: thinning keeps the first point, so the
	// test over nav.points equals the old one over doc.timeline).
	const hasClock = $derived(hasAbsoluteTime(nav.points));
	// The readout follows the hovered point while hovering, else reads the
	// aircraft's point (the playhead: a click/drag seek or a transport jump moves
	// it, and it runs during replay), so the figures keep showing after the
	// pointer leaves and a paused replay still says where the aircraft is.
	const cursor = $derived.by(() => {
		const activeNM = locked ? playheadNM : (hoverNM ?? playheadNM);
		if (activeNM == null || !enough) {
			return null;
		}
		const ms = timeMsAtDistNM(doc.timeline, activeNM);
		const fix = positionAt(nav.points, ms);
		return {
			distNM: activeNM,
			ms,
			elapsedMs: ms - doc.timeline[0].timeMs,
			altFt: fix?.altFt ?? null,
			speedKt: fix?.speedKt ?? null,
		};
	});

	/** UTC Zulu clock + browser-local, e.g. "10:14:07Z (12:14)". */
	function fmtClock(ms: number): string {
		const d = new Date(ms);
		const p = (n: number): string => String(n).padStart(2, '0');
		return `${fmtClockUtcSec(ms)}Z (${p(d.getHours())}:${p(d.getMinutes())})`;
	}

	// Readout rows. Ground and AGL resolve against the trace's own terrain
	// fetch at the readout distance (the route readout's pair), so the trace
	// answers "how high above what" too.
	const cursorRows = $derived.by(() => {
		const c = cursor;
		if (!c) {
			return [];
		}
		const groundFt = terrain.length > 0 ? terrainFtAt(terrain, c.distNM) : null;
		const rows: { label: string; value: string }[] = [];
		if (hasClock) {
			rows.push({ label: t.navigation.timeOfDay, value: fmtClock(c.ms) });
		}
		rows.push({ label: t.navigation.elapsed, value: fmtDurationMs(c.elapsedMs) });
		// i18n-ignore-start: ICAO unit tokens (ft, kt, NM) and the em-dash placeholder
		rows.push({
			label: t.navigation.altitude,
			value: c.altFt != null ? `${Math.round(c.altFt)} ft` : '—',
		});
		rows.push({
			label: t.route.readoutGround,
			value: groundFt != null ? `${fmtAlt(groundFt)} ft` : '—',
		});
		rows.push({
			label: 'AGL',
			value: c.altFt != null && groundFt != null ? `${fmtAlt(c.altFt - groundFt)} ft` : '—',
		});
		rows.push({
			label: t.navigation.groundSpeed,
			value: c.speedKt != null ? `${Math.round(c.speedKt)} kt` : '—',
		});
		rows.push({ label: t.navigation.distance, value: `${fmtNM(c.distNM)} NM` });
		// i18n-ignore-end
		return rows;
	});

	function onSeek(nm: number): void {
		// While recording the pose is the live tip: a chart seek would be
		// silently undone by the next fix, so it must not move the playhead
		// (the header transport is gated the same way).
		if (!canReplay) {
			return;
		}
		setPlayhead(timeMsAtDistNM(doc.timeline, nm));
		locked = true;
	}

	// Zoom / pan windows over each axis: the shared window state machine
	// (createProfileWindow, the RouteProfileModal one); each axis tracks the
	// full data range until its slider is dragged. This modal's persistence
	// rule stays its own: NO per-change save (a trace has no identity to key
	// a Map by), the close effect below stores the one savedTraceView slot,
	// and Fit forgets it. The slider bubbles are all-feet by contract
	// (docs/route-profile.md). applyPan reaches the chart for the plot
	// keyboard AND the two-finger pan: a fresh ONE-finger drag scrubs (the
	// chart gates touchPan on onCursor), while a pinch pans by its centroid
	// and zooms, so the window stays touch-reachable where the phone hides
	// the sliders.
	const win = createProfileWindow({
		totalNM: () => totalNM,
		dataCeilingFt: () => dataCeilingFt,
		fitCeilingFt: () => fitCeilingFt,
		enough: () => enough,
		fmtAltBubble: (v: number) => {
			// i18n-ignore: unit token
			return `${fmtAlt(v)} ft`;
		},
		onFitForget: () => {
			savedTraceView = null; // Fit forgets the saved window
		},
	});

	// The trace's identity for the saved-window slot: point count + first and
	// last timestamps (a live recording changes it every fix, so a growing
	// trace simply refits on reopen, today's behavior).
	const traceKey = $derived(
		nav.points.length === 0
			? ''
			: `${nav.points.length}:${nav.points[0].timeMs}:${nav.points[nav.points.length - 1].timeMs}`,
	);

	$effect(() => {
		void totalNM; // reframe on open / trace change
		if (!navProfileModal.open) {
			// Save a touched window for the reopen round trip ("Back to trace
			// profile"), then reset; an untouched view keeps refitting.
			untrack(() => {
				if (win.distTouched || win.altTouched) {
					savedTraceView = {
						key: traceKey,
						fromNM: win.viewFromNM,
						toNM: win.viewToNM,
						floorFt: win.viewFloorFt,
						ceilingFt: win.viewCeilingFt,
						distTouched: win.distTouched,
						altTouched: win.altTouched,
					};
				}
			});
			win.distTouched = false;
			win.altTouched = false;
			locked = false;
			return;
		}
		if (savedTraceView && savedTraceView.key === untrack(() => traceKey)) {
			const s = savedTraceView;
			win.viewFromNM = s.fromNM;
			win.viewToNM = s.toNM;
			win.viewFloorFt = s.floorFt;
			win.viewCeilingFt = s.ceilingFt;
			win.distTouched = s.distTouched;
			win.altTouched = s.altTouched;
			return;
		}
		if (!win.distTouched) {
			win.viewFromNM = 0;
			win.viewToNM = totalNM;
		}
		if (!win.altTouched) {
			win.viewFloorFt = 0;
			win.viewCeilingFt = untrack(() => fitCeilingFt);
		}
	});

	// Landscape print of just the chart (RouteProfileModal idiom): tag <html>
	// so the print rules hide the rest of the app. The landscape @page is the
	// print job's, installed only while this surface is the one printing (the
	// pageCss prop below), because @page cannot be scoped and an open surface
	// would otherwise re-size every other surface's job.
	$effect(() => {
		if (!navProfileModal.open) {
			return;
		}
		const el = document.documentElement;
		el.classList.add('nav-profile-print');
		return () => el.classList.remove('nav-profile-print');
	});

	/* The popovers sit above every surface (they must clear their own box,
	 * which is 1100 at full screen), so they cannot be left floating when the
	 * layout underneath them moves: close them when this surface changes
	 * placement, and when a modal surface takes the screen. They are also
	 * anchored to a button rect read once, so a stage resize would detach
	 * them from it. */
	$effect(() => {
		void placementOf('navProfile');
		void workspace.overlay;
		layersOpen = false;
		airspacesOpen = false;
		closeCtxMenu();
	});

	// i18n-ignore: injected print CSS, not user-visible text
	const PAGE_CSS = '@media print { @page { size: A4 landscape; margin: 10mm; } }';

	/* Printing builds the chart at the PAGE, not at the dock it happens to be
	 * sitting in: the SVG fits its labels against the pixel size it is given,
	 * so a chart built small prints truncated ones however large the paper is
	 * (print.ts). The window is untouched, so the sheet shows what the screen
	 * shows. This surface has only its title above the chart, hence a taller
	 * plot than the route profile's. */
	const printing = $derived(isPrintingSurface('navProfile'));
	// Paper carries the aircraft only as a PINNED point. The route profile's
	// print mounts never carry the ownship marker, and an unpinned trace print
	// never did either (the marker used to ride the lock), so a replay paused
	// anywhere must not stamp the sheet; a point the pilot pinned is their
	// annotation and prints with its readout (the readout's no-print below).
	const drawnPlayheadNM = $derived(printing && !locked ? null : playheadNM);

	/* ---- the phone strip: RouteProfileModal's rendition, mirrored (the
	 * contract is there and in docs/route-profile.md "Phones: the strip").
	 * One documented difference: a TAP seeks (the scrub's capture rect)
	 * and a one-finger drag scrolls, the browser's, so the strip carries no
	 * touch scrub; the follow rides the drawn playhead, live or replayed.
	 * No persistence: the trace view's slot keeps the altitude window
	 * alone and the strip reopens on the aircraft. */
	const compact = $derived(ui.isMobile && !printing);
	const STRIP_ZOOM_MAX = 8;
	let stripZoom = $state(1);
	const stripW = $derived(compact ? stripPlotWidth(totalNM, win.plotW, stripZoom) : 0);
	const stripPxPerNM = $derived(totalNM > 0 ? stripW / totalNM : 0);
	let scrollEl = $state<HTMLDivElement>();
	let followArmed = $state(true);
	let touching = false;
	let userScrollUntil = 0;
	let aimedLeft = -1;
	function markUserScroll(ms: number): void {
		userScrollUntil = Math.max(userScrollUntil, performance.now() + ms);
	}
	function scrollStripTo(left: number): void {
		if (!scrollEl) {
			return;
		}
		aimedLeft = Math.round(left);
		scrollEl.scrollLeft = aimedLeft;
	}
	$effect(() => {
		if (!compact || !followArmed || drawnPlayheadNM == null || !scrollEl || stripW <= 0) {
			return;
		}
		scrollStripTo(followScrollLeft(drawnPlayheadNM * stripPxPerNM, win.plotW, stripW));
	});
	function onStripScroll(): void {
		if (!scrollEl) {
			return;
		}
		const own = touching || performance.now() < userScrollUntil;
		if (own && followArmed && Math.abs(scrollEl.scrollLeft - aimedLeft) > 1) {
			followArmed = false;
		}
	}
	function onStripZoom(anchorNM: number, factor: number): void {
		const next = Math.min(STRIP_ZOOM_MAX, Math.max(1, stripZoom / factor));
		if (next === stripZoom || !scrollEl) {
			return;
		}
		const boxX = anchorNM * stripPxPerNM - scrollEl.scrollLeft;
		const following = followArmed && drawnPlayheadNM != null;
		stripZoom = next;
		if (following) {
			return;
		}
		const w = stripPlotWidth(totalNM, win.plotW, next);
		void tick().then(() => {
			scrollStripTo(zoomScrollLeft(anchorNM, boxX, w / Math.max(1e-6, totalNM), w, win.plotW));
		});
	}
	function stripZoomHandler(axis: 'dist' | 'alt', anchor: number, factor: number): void {
		if (axis === 'alt') {
			win.applyZoom('alt', anchor, factor);
		} else {
			onStripZoom(anchor, factor);
		}
	}
	function stripPanHandler(dxNM: number, dyFt: number): void {
		if (dyFt !== 0) {
			win.applyPan(0, dyFt);
		}
		if (dxNM !== 0 && scrollEl) {
			markUserScroll(300);
			// Clamped to the box. A DRAG sends a per-move delta that maps
			// back to its own pixels and never reaches this, but the arrow
			// keys send a tenth of the WINDOW, which in the strip is a tenth
			// of the whole plan: at zoom 8 one press threw the chart two
			// screenfuls, where the same key on desktop moves a tenth of what
			// is on screen.
			const dPx = dxNM * stripPxPerNM;
			// Unclamped until the box has been measured: a cap of 0 would
			// swallow the pan rather than bound it.
			const cap = win.plotW > 0 ? win.plotW * 0.9 : Infinity;
			scrollEl.scrollLeft += Math.abs(dPx) > cap ? Math.sign(dPx) * cap : dPx;
		}
	}
	function fitStrip(): void {
		stripZoom = 1;
		followArmed = true;
		win.fitReset();
		if (drawnPlayheadNM == null) {
			void tick().then(() => scrollStripTo(0));
		}
	}
	/* A reopen or a NEW trace rests the strip on the aircraft again. Keyed on
	 * the trace's identity, never on traceKey, which counts its points: a
	 * live recording grows one a second, and resetting on that took the
	 * pilot's own pan and pinch back at every fix, which is a chart that
	 * cannot be read in flight at all. */
	const traceIdentity = $derived(nav.points[0]?.timeMs ?? null);
	$effect(() => {
		void navProfileModal.open;
		void traceIdentity;
		untrack(() => {
			stripZoom = 1;
			followArmed = true;
		});
	});

	// Layers popover: one header icon button; ProfileLayersPopover (the extra
	// snippet) renders the anchored panel + backdrop above the modal box. Only
	// the applicable rows here; the toggles are the SHARED profileLayers, so
	// the preference follows across both profile modals.
	let layersOpen = $state(false);
	let layersBtn = $state<HTMLButtonElement>();

	// Airspaces popover: its twin, its own button. Layers is what the chart
	// draws OVER the airspace bands; this is which bands there are at all,
	// so one list would have mixed two questions (and run to fifteen rows).
	let airspacesOpen = $state(false);
	let airspacesBtn = $state<HTMLButtonElement>();
	// The button wears its emphasis while the ROWS hide something. The
	// toolbar's own level-band chip already says, app-wide and the whole
	// time it is enabled, that a band is in force, so repeating it here
	// would leave this control emphasised for everyone out of the box and
	// say nothing.
	const filtering = $derived(profileAirspaceGroupsRestrict());

	// Closing the modal (any path) dismisses the menu and the popover.
	$effect(() => {
		if (!navProfileModal.open) {
			layersOpen = false;
			airspacesOpen = false;
			ctxMenu.open = false;
			ctxHoverKey = null;
		}
	});
</script>

<!-- The phone pane's actions sheet: what the 36 px head cannot seat. -->
{#snippet stripActions({ close }: { close: () => void })}
	<button
		class="item"
		onclick={() => {
			close();
			fitStrip();
		}}
	>
		<Icon name="maximize" size={16} />
		{t.route.fitTip}
	</button>
	<button
		class="item"
		onclick={() => {
			close();
			void printSurface('navProfile');
		}}
	>
		<Icon name="printer" size={16} />
		{t.route.print}
	</button>
{/snippet}

<SurfaceShell
	id="navProfile"
	onClose={closeNavProfile}
	onEscape={() => {
		if (layersOpen || airspacesOpen) {
			layersOpen = false;
			airspacesOpen = false;
		} else if (ctxMenu.open) {
			closeCtxMenu();
		} else {
			closeNavProfile();
		}
	}}
	label={t.navigation.profileTitle}
	boxClass="nav-profile-box"
	pageCss={() => PAGE_CSS}
	printName={() => tracePrintStem('profile', loadedTraceSubject(), traceStart)}
	actions={compact && enough ? stripActions : undefined}
>
	{#snippet header()}
		<!-- The hop back to the route profile (the mirror of its own switch):
		     LEADING the header like its sibling's, so the control sits at the
		     same pixel in both windows and never moves under the pointer
		     across the swap. Absent without a plannable route, never
		     disabled. -->
		{#if activeRoute().waypoints.length >= 2}
			<div class="no-print">
				<Segmented
					options={[
						{ value: 'route', label: t.tabs.route },
						{ value: 'trace', label: t.navigation.trace },
					]}
					value="trace"
					onSelect={(v) => {
						if (v === 'route') {
							openRouteProfile();
						}
					}}
					ariaLabel={t.navigation.profileSwitchAria}
				/>
			</div>
		{/if}
		<!-- The phone pane's head (RouteProfileModal's rule): the title
		     yields to the profile hop, the figures and the datum line yield
		     to the transport, and Fit / Print fold into the actions sheet. -->
		{#if !compact || activeRoute().waypoints.length < 2}
			<h2>{t.navigation.profileTitle}</h2>
		{/if}
		<!-- What the profile covers, and any dataset still arriving. Beside the
		     title rather than above the chart: as a body row it cost the plot a
		     line it could not spare on a phone, and it says nothing that changes
		     as the chart is read. -->
		{#if enough}
			<div class="figures">
				<span>{fmtNM(totalNM)} NM</span>
				<span>{nav.points.length} {t.navigation.points}</span>
				{#if !dataState.airspacesLoaded}
					<span class="cap">{t.navlog.loadingAirspaces}</span>
				{:else if terrainLoading}
					<span class="cap">{t.route.terrainLoading}</span>
				{:else if terrainError}
					<span class="cap">{t.route.terrainUnavailable}</span>
				{:else if profileLayers.obstacles && dataState.obstaclesLoading}
					<span class="cap">{t.layers.loadingObstacles}</span>
				{/if}
			</div>
		{/if}
		<!-- The altitude drawn here is GNSS, referenced to MSL so it can be
		     read against the airspace bands behind it, and it is still not an
		     altimeter indication. The caption says both, on paper too.
		     Screen gets the one-line form with the provenance on its tooltip:
		     the full sentence wrapped to a paragraph in a docked header and
		     took 214 of a phone's 324 px, leaving no chart. Paper gets the
		     sentence whole, where the profile is a record. -->
		<p
			class="datum no-print"
			title={t.navigation.profileDatum(t.navigation.altDatumApplied[altDatum])}
		>
			{t.navigation.profileDatumShort}
		</p>
		<p class="datum print-only">
			{t.navigation.profileDatum(t.navigation.altDatumApplied[altDatum])}
		</p>
		{#if enough}
			<div class="controls no-print">
				{#if canReplay}
					<!-- Transport in the header: with the chart docked beside the
					 map the pilot works from here, and the Navigation tab that
					 owns the full controls is usually not the one on screen. -->
					<!-- The phone pane's head seats Play alone: the event jumps
					     and the clocks live on the Flight page's replay section. -->
					{#if !compact}
						<button
							class="modal-close"
							title={t.navigation.eventJumpTip}
							aria-label={t.navigation.prevEvent}
							disabled={prevEvent == null}
							onclick={() => jumpToEvent(prevEvent)}
						>
							<Icon name="chevron-left" />
						</button>
					{/if}
					<button
						class="modal-close"
						title={nav.playing ? t.navigation.pause : t.navigation.play}
						aria-label={nav.playing ? t.navigation.pause : t.navigation.play}
						onclick={togglePlay}
					>
						<Icon name={nav.playing ? 'pause' : 'play'} />
					</button>
					{#if !compact}
						<button
							class="modal-close"
							title={t.navigation.eventJumpTip}
							aria-label={t.navigation.nextEvent}
							disabled={nextEvent == null}
							onclick={() => jumpToEvent(nextEvent)}
						>
							<Icon name="chevron-right" />
						</button>
						<span class="elapsed">{fmtDurationMin(elapsedMin)}</span>
					{/if}
					{#if hasClock && !compact}
						<!-- The playhead's time of day, the figure a debrief correlates
						     against clocks outside the app. -->
						<span class="elapsed" title={t.navigation.timeOfDay}
							>{fmtClockUtcSec(nav.playheadMs)}Z</span
						>
					{/if}
				{/if}
				<button
					class="modal-close"
					bind:this={layersBtn}
					title={t.tabs.layers}
					aria-label={t.tabs.layers}
					aria-expanded={layersOpen}
					onclick={() => (layersOpen = !layersOpen)}
				>
					<Icon name="layers" />
				</button>
				<!-- Which airspace bands the chart plots at all: the Garmin
					 navigators' Airspace page (docs/route-profile.md "Airspace
					 filter"). Beside Layers on EVERY form factor, never folded
					 into the actions sheet: SurfaceShell reserves the header for
					 a popover anchored to its own button, which would lose its
					 anchor the moment a bottom sheet closed. The `set` emphasis
					 is the rule the toolbar's level-band chip follows: a
					 decluttered chart says so without being opened. -->
				<button
					class="modal-close"
					class:set={filtering}
					bind:this={airspacesBtn}
					title={t.layers.airspaces}
					aria-label={t.layers.airspaces}
					aria-expanded={airspacesOpen}
					onclick={() => (airspacesOpen = !airspacesOpen)}
				>
					<Icon name="filter" />
				</button>
				{#if !compact}
					<button class="modal-close" title={t.route.fitTip} aria-label={t.route.fitAria} onclick={win.fitReset}>
						<Icon name="maximize" />
					</button>
					<button
						class="modal-close"
						title={t.route.print}
						aria-label={t.route.print}
						onclick={() => void printSurface('navProfile')}
					>
						<Icon name="printer" />
					</button>
				{/if}
			</div>
		{/if}
	{/snippet}

	<div class="body" class:strip={compact}>
		{#if !enough}
			<p class="muted">{t.navigation.noTrace}</p>
		{:else}
			<div class="plot-stack">
				<div class="plot-row">
					<RangeSlider
						orientation="vertical"
						min={0}
						max={dataCeilingFt}
						low={win.viewFloorFt}
						high={win.viewCeilingFt}
						minSpan={1000}
						step={500}
						snap={50}
						format={win.fmtAltBubble}
						ariaLow={t.route.sliderAltBottomAria}
						ariaHigh={t.route.sliderAltTopAria}
						onChange={win.onAltWindow}
					/>
					<div class="plot-area" bind:clientWidth={win.plotW} bind:clientHeight={win.plotH}>
						{#if win.ready}
							<!-- The touch and wheel marks only say whose scroll a scroll event is;
							     the scroller is not a control and the chart inside keeps its own
							     roles. -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="plot-scroll"
								class:strip={compact}
								bind:this={scrollEl}
								onscroll={onStripScroll}
								ontouchstart={() => {
									touching = true;
								}}
								ontouchend={() => {
									touching = false;
									markUserScroll(1500);
								}}
								ontouchcancel={() => {
									touching = false;
									markUserScroll(1500);
								}}
								onwheel={() => markUserScroll(400)}
							>
							<RouteProfile
								bands={overlays.shownBands}
								{terrain}
								{groundFill}
								waypoints={[]}
								altitudePath={doc.altitudePath}
								legAltsFt={[]}
								fromNM={compact ? 0 : win.viewFromNM}
								toNM={compact ? totalNM : win.viewToNM}
								floorFt={win.viewFloorFt}
								ceilingFt={win.viewCeilingFt}
								widthPx={printing ? PRINT_PLOT_W : compact ? stripW : win.plotW}
								heightPx={printing ? PRINT_NAV_PLOT_H : win.plotH}
								{compact}
								showWaypointDots={false}
								vfr={routeSettings.vfr}
								features={doc.features}
								obstacles={overlays.profileObstacles}
								notamBands={overlays.profileNotamBands}
								notamObstacles={overlays.profileNotamObstacles}
								terrainTint={profileLayers.terrainTint}
								bandActivations={overlays.bandActivations}
								activeBandKeys={overlays.activeBandKeys}
								{onNotamClick}
								{onObstacleClick}
								onFeatureClick={onFeature}
								onBandClick={onCtxSelect}
								onContextMenu={onProfileContextMenu}
								highlightKey={ctxHoverKey}
								playheadNM={drawnPlayheadNM}
								onCursor={(nm: number | null) => {
									hoverNM = nm;
								}}
								{onSeek}
								onZoom={compact ? stripZoomHandler : win.applyZoom}
								onPan={compact ? stripPanHandler : win.applyPan}
								onFit={compact ? fitStrip : win.fitReset}
								pinned={locked}
							/>
							</div>
							{#if compact}
								<ProfileAxisOverlay floorFt={win.viewFloorFt} ceilingFt={win.viewCeilingFt} heightPx={win.plotH} />
							{/if}
							{#if compact && !followArmed && drawnPlayheadNM != null}
								<button
									class="follow-chip no-print"
									onclick={() => {
										followArmed = true;
									}}
								>
									<Icon name="navigation" size={12} />
									{t.navigation.follow}
								</button>
							{/if}
						{:else}
							<p class="muted sizing">{t.route.sizing}</p>
						{/if}
						{#if cursor}
							<!-- The aircraft's figures at rest, the pinned point's when locked;
							     paper takes the pinned one alone (drawnPlayheadNM's rule). -->
							<ProfileReadout class={locked ? 'locked' : 'no-print'} rows={cursorRows}>
								{#if locked}
									<!-- The whole panel is the unlock control: a transparent full-panel
									     button (real button = keyboard + a11y) behind the pointer-transparent
									     text; the accent border + tooltip signal the locked state. -->
									<button
										class="unlock-overlay"
										onclick={() => {
											locked = false;
											hoverNM = null;
										}}
										title={t.navigation.unlock}
										aria-label={t.navigation.unlock}
									></button>
								{/if}
							</ProfileReadout>
						{/if}
					</div>
				</div>
				<div class="plot-hrow">
					<RangeSlider
						orientation="horizontal"
						min={0}
						max={totalNM}
						low={win.viewFromNM}
						high={win.viewToNM}
						minSpan={win.distMinSpan}
						step={win.distStep}
						snap={1}
						format={win.fmtDistBubble}
						ariaLow={t.route.sliderDistStartAria}
						ariaHigh={t.route.sliderDistEndAria}
						onChange={win.onDistWindow}
					/>
				</div>
			</div>
		{/if}
	</div>

	{#snippet extra()}
		{#if layersOpen}
			<ProfileLayersPopover
				rows={['obstacles', 'terrainTint', 'notams']}
				anchorEl={layersBtn}
				onClose={() => (layersOpen = false)}
			/>
		{/if}
		{#if airspacesOpen}
			<ProfileAirspacesPopover
				rows={TRACE_BAND_FILTER_GROUPS}
				anchorEl={airspacesBtn}
				onClose={() => (airspacesOpen = false)}
			/>
		{/if}
		{#if ctxMenu.open}
			<ProfileStackMenu
				bands={ctxMenu.bands}
				notams={ctxMenu.notams}
				belowCharted={ctxMenu.belowCharted}
				x={ctxMenu.x}
				y={ctxMenu.y}
				onSelectBand={onCtxSelect}
				onSelectNotam={onNotamClick}
				onHoverBand={(key: string | null) => (ctxHoverKey = key)}
				onClose={closeCtxMenu}
			/>
		{/if}
	{/snippet}
</SurfaceShell>

<style>
	.body {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
		padding: 12px 16px 16px;
	}

	.figures {
		display: flex;
		flex: 0 0 auto;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 12px;
		margin-left: 12px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.cap {
		color: var(--text-muted);
	}

	/* The altitude provenance, beside the title rather than under the chart:
	   it qualifies every figure on the plot, so it has to be read first. */
	.datum {
		flex: 1;
		overflow: hidden;
		margin: 0 0 0 10px;
		font-size: 11px;
		line-height: 1.3;
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The full sentence, paper only: it may wrap there, and it should. */
	.datum.print-only {
		display: none;
		white-space: normal;
	}

	@media print {
		.datum.print-only {
			display: block;
		}
	}

	.controls {
		display: flex;
		gap: 4px;
		align-items: center;
	}

	/* Elapsed trace time beside the transport, tabular so it does not jitter
	   as the replay runs. */
	.elapsed {
		margin-right: 4px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.plot-stack {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
	}

	.plot-row {
		display: flex;
		flex: 1;
		min-height: 0;
	}

	.plot-area {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	/* Rendered inside ProfileReadout's box through the children snippet, so
	   the rule keeps this component's scope. */
	.unlock-overlay {
		position: absolute;
		inset: 0;
		margin: 0;
		padding: 0;
		background: transparent;
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
		pointer-events: auto;
	}

	.plot-hrow {
		padding-left: 30px;
	}

	/* The vertical slider widens to 44px under touch-ui (RangeSlider), so
	   the offset follows (the mobile audit's 14px x-axis misalignment). */
	:global(:root.touch-ui) .plot-hrow {
		padding-left: 44px;
	}

	/* Phones: the chart owns the dock (the RouteProfileModal block's twin;
	   keyed off :root.mobile-ui, never a media query). One finger scrubs
	   here, so the window rides the pinch (zoom + centroid pan), the
	   keyboard and Fit. */
	:global(:root.mobile-ui) .plot-row :global(.rslider),
	:global(:root.mobile-ui) .plot-hrow {
		display: none;
	}

	.sizing {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		font-size: 13px;
		color: var(--text-muted);
	}

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	/* Sizing hangs off the shell-owned box (SurfaceShell renders .nav-profile-box),
	   so it must be :global; a scoped .modal-box rule can't reach it. */
	:global(.nav-profile-box) {
		--modal-width: min(1180px, 96vw);

		height: min(86vh, 760px);
	}

	h2 {
		margin: 0;
		flex: 1;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	/* Landscape print: only the chart, fit to the page (RouteProfileModal idiom). */
	@media print {
		:global(html.nav-profile-print #app) {
			display: none !important;
		}

		:global(html.nav-profile-print .modal-backdrop) {
			display: none !important;
		}

		:global(html.nav-profile-print .nav-profile-box) {
			position: static !important;
			inset: auto !important;
			transform: none !important;
			width: auto;
			height: auto;
			max-width: none;
			max-height: none;
			overflow: visible;
			border: none;
			border-radius: 0;
			box-shadow: none;
			background: #fff;
			color: #000;
		}

		:global(html.nav-profile-print) .body {
			overflow: visible;
		}

		.no-print {
			display: none !important;
		}

		.plot-row :global(.rslider),
		.plot-hrow {
			display: none !important;
		}

		.plot-stack,
		.plot-row {
			display: block;
		}

		.plot-area {
			overflow: visible !important;
			border: none !important;
		}
	}

	/* ---- phones: the strip (RouteProfileModal's rules, mirrored) -------
	   Off the `strip` class the template stamps while NOT printing, so
	   paper needs no counter-rules. The title's figures and the datum
	   line yield to the transport in the 36 px pane head. */
	:global(:root.mobile-ui) .figures,
	:global(:root.mobile-ui) .datum.no-print {
		display: none;
	}

	.body.strip {
		position: relative;
		padding: 0;
	}

	.body.strip .plot-stack {
		min-height: 0;
	}

	.body.strip .plot-area {
		border: 0;
		border-radius: 0;
	}

	.plot-scroll.strip {
		height: 100%;
		overflow-x: auto;
		overflow-y: hidden;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}

	.plot-scroll.strip::-webkit-scrollbar {
		display: none;
	}

	.follow-chip {
		position: absolute;
		bottom: 8px;
		left: 8px;
		z-index: 2;
		display: inline-flex;
		gap: 5px;
		align-items: center;
		min-height: 28px;
		padding: 2px 10px;
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		color: var(--accent);
		cursor: pointer;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--accent);
		border-radius: 14px;
		box-shadow: 0 1px 3px rgb(0 0 0 / 20%);
	}

	.follow-chip::after {
		position: absolute;
		inset: -8px;
		content: '';
	}
</style>
