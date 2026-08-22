<script lang="ts" module>
	/* Per-route session cache of the profile window (zoom / pan + touched
	 * flags), so a band-click round trip or a route switch keeps the view.
	 * Route ids are never reused; entries of deleted routes are pruned on
	 * restore, a materially changed route (length moved > 0.5 NM) drops its
	 * entry, and Fit forgets it. */
	interface SavedProfileView {
		fromNM: number;
		toNM: number;
		floorFt: number;
		ceilingFt: number;
		distTouched: boolean;
		altTouched: boolean;
		totalNM: number;
	}
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- deliberately non-reactive session cache, read imperatively on open / route switch, never rendered
	const savedViews = new Map<string, SavedProfileView>();
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from './Icon.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import { isPrintingSurface, printSurface } from '$lib/ui/surfacePrint.svelte';
	import { routePrintStem } from '$lib/state/printName';
	import { PRINT_PLOT_W, PRINT_ROUTE_PLOT_H } from '$lib/ui/print';
	import RouteSwitcher from './RouteSwitcher.svelte';
	import RouteProfile from './RouteProfile.svelte';
	import RangeSlider from './RangeSlider.svelte';
	import ProfileLayersPopover from './ProfileLayersPopover.svelte';
	import ProfileReadout from './ProfileReadout.svelte';
	import ProfileStackMenu, { type StackNotamRow } from './ProfileStackMenu.svelte';
	import PlotTitleLine from './PlotTitleLine.svelte';
	import CrossingsStrip from './CrossingsStrip.svelte';
	import { isEditableTarget } from '$lib/ui/focus';
	import { t } from '$lib/state/i18n.svelte';
	import { routeProfileModal, closeRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { profileLayers } from '$lib/state/profileLayers.svelte';
	import {
		activeRoute,
		routes,
		routeSettings,
		setWaypointAltitude,
		stepActiveRoute,
	} from '$lib/state/route.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import {
		effectiveClimbGradFtPerNM,
		effectiveCruiseSpeedKt,
		effectiveDescentGradFtPerNM,
	} from '$lib/state/aircraft.svelte';
	import { computeNavLog } from '$lib/route/navlog';
	import type { AirspaceCorridorBand } from '$lib/route/airspaces';
	import { applicabilityFloorFt, snapToLevel } from '$lib/route/cruisingLevels';
	import { cruisingRegime } from '$lib/state/cruisingRegime.svelte';
	import { legMagneticTrackDeg, decimalYearFromDate } from '$lib/route/magnetic';
	import { exactFt } from '$lib/vertical/limits';
	import { notamState } from '$lib/state/notam.svelte';
	import {
		ensureAirspaces,
		ensureObstacles,
		getAirspaces,
		airspaceByKey,
		obstacleById,
		dataState,
		airportByIdent,
	} from '$lib/state/data.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { navLiveFor } from '$lib/state/navLive.svelte';
	import { currentPose, nav, poseAltMslFt } from '$lib/state/navRecording.svelte';
	import { openNavProfile } from '$lib/state/navProfileModal.svelte';
	import Segmented from './Segmented.svelte';
	import { placementOf, surfaceKeepsMapVisible, workspace } from '$lib/state/workspace.svelte';
	import { focusNotam } from '$lib/map/notamLayer';
	import { computeMinAltitudes } from '$lib/route/minAltitude';
	import {
		ensureRouteTerrain,
		legMinGroundElevFt,
		routeTerrain,
		routeTerrainSamples,
	} from '$lib/state/routeTerrain.svelte';
	import {
		markDetailFromProfile,
		navigateToAirport,
		navigateToAirspace,
		navigateToNavaid,
		navigateToNotam,
		navigateToObstacle,
	} from '$lib/state/ui.svelte';
	import { flyToBoundsVisible, flyToVisible } from '$lib/map/focus';
	import type { TerrainSample } from '$lib/map/terrain';
	import { fmtAlt, fmtLevel, fmtNM, isFlightLevelAt } from '$lib/route/format';
	import {
		bandCrossings,
		buildRouteProfileDoc,
		computeCeilingFt,
		sampleAltitudePathAt,
		terrainFtAt,
		zoomWindow,
	} from '$lib/route/routeProfile';
	import { createProfileWindow } from './profileWindow.svelte';
	import { createProfileOverlays } from './profileOverlays.svelte';
	import {
		effectiveRouteWinds,
		routeCloudCover,
		routeFreezingLevelsFt,
		routeLegWindTips,
		routeWindEteMin,
	} from '$lib/state/routeWind.svelte';

	// Load airspaces when the modal opens so the bands work without a manual
	// fetch (mirrors NavLogModal).
	$effect(() => {
		if (routeProfileModal.open && !dataState.airspacesLoaded) {
			void ensureAirspaces().catch(() => {
				/* surfaced via dataState.airspacesError */
			});
		}
	});

	// Isolate the surface for printing: tag <html> so the print rules hide
	// the rest of the app. The landscape @page is NOT injected here: it is
	// the print job's, installed only while this surface is the one
	// printing (the pageCss prop below), because @page cannot be scoped and
	// an open surface would otherwise re-size every other surface's job.
	$effect(() => {
		if (!routeProfileModal.open) {
			return;
		}
		const el = document.documentElement;
		el.classList.add('route-profile-print');
		return () => el.classList.remove('route-profile-print');
	});

	/* The popovers sit above every surface (they must clear their own box,
	 * which is 1100 at full screen), so they cannot be left floating when the
	 * layout underneath them moves: close them when this surface changes
	 * placement, and when a modal surface takes the screen. They are also
	 * anchored to a button rect read once, so a stage resize would detach
	 * them from it. */
	$effect(() => {
		void placementOf('routeProfile');
		void workspace.overlay;
		layersOpen = false;
		closeCtxMenu();
	});

	// i18n-ignore: injected print CSS, not user-visible text
	const PAGE_CSS = '@media print { @page { size: A4 landscape; margin: 10mm; } }';

	/* Printing builds the chart at the PAGE, not at the dock it happens to be
	 * sitting in: the SVG places its band labels against the pixel size it is
	 * given, so a chart built small prints truncated ones however large the
	 * paper is (print.ts). The window (distance, altitude) is untouched, so
	 * the sheet still shows what the screen shows. The claim lands before
	 * printSurface's `await tick()`, so this re-render is in place for the
	 * print snapshot. */
	const printing = $derived(isPrintingSurface('routeProfile'));

	const enough = $derived(activeRoute().waypoints.length >= 2);

	// Overlay visibility comes from the persisted Layers popover state
	// (profileLayers, all default on). Wind barbs along the profile are the
	// per-leg effective winds; the freezing level is its own layer, no
	// longer riding the barbs toggle.
	const profileLegWinds = $derived(
		profileLayers.windBarbs
			? effectiveRouteWinds(activeRoute()).map((w) => (w ? { dirDeg: w.dirDeg, speedKt: w.speedKt } : null))
			: null,
	);
	const profileLegWindTips = $derived(profileLayers.windBarbs ? routeLegWindTips(activeRoute()) : null);
	const profileFreezingFt = $derived(profileLayers.freezing ? routeFreezingLevelsFt(activeRoute()) : null);

	// Cloud curtain along the profile. Resolution is pure math off the
	// already-fetched columns, so toggling never touches the network.
	const profileCloudCover = $derived(profileLayers.clouds ? routeCloudCover(activeRoute()) : null);

	// Corridor obstacles. The dataset lazy-loads when first needed (the
	// NotamDetail idiom); the width is the min-alt corridor, so the chart
	// shows the obstacles that drive the nav log's MSA column.
	// Layer/publisher toggles are display-only map state and deliberately
	// don't apply here.
	$effect(() => {
		if (routeProfileModal.open && profileLayers.obstacles && !dataState.obstaclesLoaded) {
			void ensureObstacles().catch(() => {
				/* surfaced via dataState.obstaclesError */
			});
		}
	});

	// Per-leg MSA for the step-line, the NavLogSheet recipe verbatim
	// (computeMinAltitudes over the same min-alt corridor and the same
	// flight-rules margin, so the line, the nav-log column and the obstacle
	// marks agree by construction). Keyed on the waypoints' COORDINATES +
	// the corridor half-width + the VFR/IFR flag (msaMarginForTerrainFt,
	// per-leg mountainous-aware) only, so altitude edits and window moves
	// never refetch terrain; abort on supersede; no spinner, the line pops
	// in like the lazily loaded obstacles.
	let profileMsa = $state<(number | null)[]>([]);
	// True once the MSA fetch has settled (or nothing is pending): the
	// view-restore effect defers its alt-window clamp on it, because
	// dataCeilingFt is missing the MSA contribution until then.
	let msaSettled = $state(true);
	$effect(() => {
		const halfWidthNM = routeSettings.minAltCorridorRadiusNM;
		const vfr = routeSettings.vfr;
		const pts = activeRoute().waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
		if (!routeProfileModal.open || !profileLayers.msa || pts.length < 2) {
			profileMsa = [];
			msaSettled = true;
			return;
		}
		msaSettled = false;
		const ctrl = new AbortController();
		void ensureObstacles()
			.then((obstacles) =>
				computeMinAltitudes(pts, obstacles, { signal: ctrl.signal, halfWidthNM, vfr }),
			)
			.then((mins) => {
				if (!ctrl.signal.aborted) {
					profileMsa = mins;
					msaSettled = true;
				}
			})
			.catch(() => {
				if (!ctrl.signal.aborted) {
					profileMsa = [];
					msaSettled = true;
				}
			});
		return () => ctrl.abort();
	});

	// The overlay deriveds (obstacle marks, NOTAM bands + activation hatch,
	// temporary NOTAM obstacles): the shared createProfileOverlays over this
	// modal's route axis (profileOverlays.svelte.ts; the trace modal passes
	// its trace adapter). Kept OUT of buildRouteProfileDoc on purpose:
	// visibleNotams() moves on every filter keystroke and the minute tick,
	// which must not re-run the heavy airspace walks (the tick-free doc
	// invariant). The crossings strip reads bandActivationsRaw UNGATED; the
	// chart hatch follows the NOTAMs toggle via bandActivations.
	const overlays = createProfileOverlays({
		enough: () => enough,
		pts: () => activeRoute().waypoints,
		cumNM: () => doc.wpPoints.map((w) => w.distNM),
		bandWaypoints: () => activeRoute().waypoints,
		terrain: () => terrain,
		corridorBands: () => corridorBands,
	});

	/* Following a link out of the chart into a detail panel. With the map
	 * beside it (a docked profile) both stay up, so nothing moves and no
	 * breadcrumb is needed: seeing the chart and the panel at once is the
	 * whole point of docking. A profile that covers the map still has to get
	 * out of the way, and the panel's "Back to ..." arrow returns from that. */
	function leaveForDetail(): void {
		if (surfaceKeepsMapVisible('routeProfile')) {
			return;
		}
		markDetailFromProfile('route');
		closeRouteProfile();
	}

	// NOTAM band / temporary-obstacle click: linked navigation to the NOTAM
	// panel, and the map centers on the geometry (the panel crosshair's own
	// focusNotam recipe). Centering is a PROFILE-origin behavior: list and
	// panel selections stay highlight-only, the app's convention.
	function onNotamClick(index: number): void {
		navigateToNotam(index);
		const n = notamState.notams[index];
		if (mapState.map && n) {
			focusNotam(mapState.map, n);
		}
		leaveForDetail();
	}

	// DB obstacle mark click: obstacle panel + map centered on it (the
	// selection highlight draws it enlarged even with the layer off).
	function onObstacleClick(id: string): void {
		navigateToObstacle(id);
		const o = obstacleById(id);
		if (o) {
			flyToVisible([o.lat, o.lon]);
		}
		leaveForDetail();
	}

	// Cursor readout (route mode): the planned level, ground elevation and
	// AGL clearance at the inspected distance, docked over the plot (the
	// trace profile's readout idiom). Values are locale-invariant tokens
	// (fmtNM / fmtLevel / fmtAlt + ICAO units); labels come from the
	// catalogs. Null while the pointer is off the plot or a leg is dragged
	// (the chart reports null then).
	let inspectNM = $state<number | null>(null);
	const readout = $derived.by(() => {
		if (inspectNM == null || !enough) {
			return null;
		}
		const plannedFt = sampleAltitudePathAt(doc.altitudePath.vertices, inspectNM);
		const ta = routeSettings.semicircular ? effectiveTransitionAltFt() : Infinity;
		const groundFt = terrain.length > 0 ? terrainFtAt(terrain, inspectNM) : null;
		// i18n-ignore-start: ICAO unit tokens (NM, ft) and the em-dash placeholder
		return {
			distText: `${fmtNM(inspectNM)} NM`,
			levelText: `${fmtLevel(plannedFt, ta)}${isFlightLevelAt(plannedFt, ta) ? '' : ' ft'}`,
			groundText: groundFt != null ? `${fmtAlt(groundFt)} ft` : '—',
			aglText: groundFt != null ? `${fmtAlt(plannedFt - groundFt)} ft` : '—',
		};
		// i18n-ignore-end
	});
	const airspaces = $derived(dataState.airspacesLoaded ? getAirspaces() : null);

	// --- terrain: via the shared per-route cache (state/routeTerrain), so this
	// chart, the nav-log schedule, the flight-dossier print and the map's route
	// filter all use the SAME samples and agree on AGL evaluation by
	// construction. Keyed on coords only, so an altitude edit updates the
	// route line without refetching the ground. ---
	$effect(() => {
		if (!routeProfileModal.open || !enough) {
			return;
		}
		const r = activeRoute();
		ensureRouteTerrain(r.id, r.waypoints);
	});
	const terrain = $derived.by<TerrainSample[]>(() => {
		const r = activeRoute();
		return routeTerrainSamples(r.id, r.waypoints) ?? [];
	});
	const terrainLoading = $derived(
		routeTerrain.byRoute[activeRoute().id]?.status === 'loading',
	);
	const terrainError = $derived(
		routeTerrain.byRoute[activeRoute().id]?.status === 'error',
	);

	// The one loading / degradation cap beside the title (PlotTitleLine).
	const titleCap = $derived(
		!dataState.airspacesLoaded
			? t.navlog.loadingAirspaces
			: terrainLoading
				? t.route.terrainLoading
				: terrainError
					? t.route.terrainUnavailable
					: profileLayers.obstacles && dataState.obstaclesLoading
						? t.layers.loadingObstacles
						: null,
	);

	// Everything the chart draws (waypoints, bands, altitude path, the default
	// fit ceiling), shared with the flight-dossier print doc so the printed
	// chart is this one.
	const doc = $derived(
		buildRouteProfileDoc({
			waypoints: activeRoute().waypoints,
			cruiseSpeedKt: effectiveCruiseSpeedKt(),
			airspaces,
			terrain,
			airportElevFt: (ident) => airportByIdent(ident)?.elevFt ?? null,
			typeLabels: t.data.airspaceTypes,
			climbGradFtPerNM: effectiveClimbGradFtPerNM(),
			descentGradFtPerNM: effectiveDescentGradFtPerNM(),
		}),
	);
	const totalNM = $derived(doc.totalNM);
	const corridorBands = $derived(doc.corridorBands);
	const fitCeilingFt = $derived(doc.fitCeilingFt);

	// The live along-route position (docs/nav-live-comparison.md item 8):
	// marker + flown dimming through the trace profile's playhead idiom.
	// planOnly suppresses the nearest-point projection of a route not being
	// flown; a non-null currentLegIdx implies airborne, not arrived, and a
	// resolved distNM. Display-only per fix: none of the heavy walks key on
	// the pose (the navLive contract), and this modal's doc / terrain / MSA
	// deriveds never read it.
	const live = $derived(enough ? navLiveFor(activeRoute().id) : null);
	const livePlayheadNM = $derived(
		live !== null && !live.planOnly && live.log.state.currentLegIdx !== null
			? live.log.state.distNM
			: null,
	);

	// Ownship: the pose's ACTUAL altitude through THE datum chokepoint
	// (poseAltMslFt, the strip's GPS ALT figure), so the chart shows the
	// vertical deviation from the planned line and not just the progress.
	// Same display-only contract as the marker above.
	const liveAltFt = $derived.by(() => {
		if (livePlayheadNM == null) {
			return null;
		}
		const pose = currentPose();
		return pose ? poseAltMslFt(pose) : null;
	});

	// The altitude slider's track top: the 3/4 fit, raised to clear any higher
	// airspace bands (and the MSA step-line, which can sit above the fit
	// window over high ground) so the user can zoom out to them. (Distance
	// track is [0, totalNM].)
	const dataCeilingFt = $derived(
		Math.max(
			fitCeilingFt,
			computeCeilingFt(
				[
					...doc.altitudePath.vertices.map((v) => v.altFt),
					...profileMsa.filter((v): v is number => v != null),
				],
				terrain.flatMap((t) => (t.elevFt == null ? [] : [t.elevFt])),
				[...doc.placedBands, ...(overlays.profileNotamBands ?? [])],
			),
		),
	);

	// The chart fills its container; two range sliders define the visible window
	// over each axis (zoom + pan, no scrollbars). Each window tracks the full
	// data range until the user drags its slider. The window state machine is
	// the shared createProfileWindow (profileWindow.svelte.ts); this modal's
	// persistence rule rides its hooks: every touch saves into the per-route
	// savedViews Map, and Fit forgets the entry.
	const win = createProfileWindow({
		totalNM: () => totalNM,
		dataCeilingFt: () => dataCeilingFt,
		fitCeilingFt: () => fitCeilingFt,
		enough: () => enough,
		fmtAltBubble,
		onTouched: saveView,
		onFitForget: () => savedViews.delete(routes.activeId),
	});

	// Reframe / restore: on open or on a route switch, restore that route's
	// saved window (re-clamped through zoomWindow's factor-1 path; dropped
	// when the route length moved > 0.5 NM or the route is gone); untouched
	// axes keep the auto fit and keep refitting live on route edits. All
	// writes are untracked; fitCeilingFt stays untracked on purpose (a live
	// leg drag must never rescale the view and pin the dragged leg at 3/4).
	// The alt-window restore waits for msaSettled: its clamp bound
	// dataCeilingFt lacks the async MSA contribution until then, and
	// clamping against the transient ceiling would shrink a saved high
	// window for good. The auto fit stands in meanwhile; a user touch of
	// the alt axis during the wait wins and drops the pending restore.
	let lastViewKey = '';
	let pendingAltView: { floorFt: number; ceilingFt: number } | null = null;
	$effect(() => {
		const open = routeProfileModal.open;
		const rid = routes.activeId;
		const tot = totalNM;
		const msaReady = msaSettled;
		if (!open) {
			lastViewKey = '';
			pendingAltView = null;
			return;
		}
		const restoring = lastViewKey !== rid;
		lastViewKey = rid;
		untrack(() => {
			if (restoring) {
				pendingAltView = null;
				let saved = savedViews.get(rid);
				if (saved && Math.abs(saved.totalNM - tot) > 0.5) {
					savedViews.delete(rid);
					saved = undefined;
				}
				for (const id of savedViews.keys()) {
					if (!routes.list.some((r) => r.id === id)) {
						savedViews.delete(id);
					}
				}
				win.distTouched = saved?.distTouched ?? false;
				win.altTouched = saved?.altTouched ?? false;
				if (saved?.distTouched) {
					[win.viewFromNM, win.viewToNM] = zoomWindow(
						saved.fromNM,
						saved.toNM,
						(saved.fromNM + saved.toNM) / 2,
						1,
						0,
						tot,
						win.distMinSpan,
					);
				}
				if (saved?.altTouched) {
					if (msaReady) {
						[win.viewFloorFt, win.viewCeilingFt] = zoomWindow(
							saved.floorFt,
							saved.ceilingFt,
							(saved.floorFt + saved.ceilingFt) / 2,
							1,
							0,
							dataCeilingFt,
							1000,
						);
					} else {
						win.altTouched = false;
						pendingAltView = { floorFt: saved.floorFt, ceilingFt: saved.ceilingFt };
					}
				}
			} else if (pendingAltView && msaReady) {
				const p = pendingAltView;
				pendingAltView = null;
				if (!win.altTouched) {
					win.altTouched = true;
					[win.viewFloorFt, win.viewCeilingFt] = zoomWindow(
						p.floorFt,
						p.ceilingFt,
						(p.floorFt + p.ceilingFt) / 2,
						1,
						0,
						dataCeilingFt,
						1000,
					);
					// Re-save: a dist-slider save during the wait stored the
					// interim altTouched=false, which would drop this window
					// on the next restore.
					saveView();
				}
			}
			if (!win.distTouched) {
				win.viewFromNM = 0;
				win.viewToNM = tot;
			}
			if (!win.altTouched) {
				win.viewFloorFt = 0;
				win.viewCeilingFt = fitCeilingFt;
			}
		});
	});

	function saveView(): void {
		savedViews.set(routes.activeId, {
			fromNM: win.viewFromNM,
			toNM: win.viewToNM,
			floorFt: win.viewFloorFt,
			ceilingFt: win.viewCeilingFt,
			distTouched: win.distTouched,
			altTouched: win.altTouched,
			totalNM,
		});
	}

	// Altitude bubbles read FL above the TA (the axis gate); the trace modal
	// passes its all-feet sibling instead.
	function fmtAltBubble(v: number): string {
		const ta = routeSettings.semicircular ? effectiveTransitionAltFt() : Infinity;
		// i18n-ignore: unit token
		return `${fmtLevel(v, ta)}${isFlightLevelAt(v, ta) ? '' : ' ft'}`;
	}

	// Click a waypoint: open its detail panel (airport / navaid) or centre the map
	// on a free coordinate, then hand over to leaveForDetail.
	function onWaypoint(i: number): void {
		const wp = activeRoute().waypoints[i];
		if (!wp) {
			return;
		}
		if (wp.kind === 'airport' && wp.refId) {
			navigateToAirport(wp.refId.toUpperCase());
			} else if (wp.kind === 'navaid' && wp.refId) {
			navigateToNavaid(wp.refId);
			}
		// Every branch centers: the waypoint sits AT the airport / navaid
		// position (anchored by ident), so no dataset lookup is needed.
		flyToVisible([wp.lat, wp.lon]);
		leaveForDetail();
	}

	// Set one leg's cruise altitude from a chart leg drag. Leg i flies at its
	// from-waypoint's alt (`activeRoute().waypoints[i].alt`), so this moves only that leg;
	// valid for every leg `0..n-2` (the destination, n-1, has no outbound leg).
	// With the semicircular option on, a drag above the leg's applicability
	// floor lands on the cruising levels of the table (below it, or when no
	// level fits, the plain 100 ft rounding stays). The drag is a manual edit
	// (no auto-target arg), exactly like typing a value.
	function onWaypointAlt(i: number, ft: number, exact = false): void {
		const r = activeRoute();
		const n = r.waypoints.length;
		const wp = r.waypoints[i];
		if (!wp || i < 0 || i > n - 2) {
			return;
		}
		// The committed value is contained in the visible altitude window
		// (grid-aligned bounds so a clamped value never rounds past the
		// edge), so a drag can never push the cruise line out of view; the
		// window top also rides the snap's capFt below, so the semicircular
		// snap lands on the highest compliant level under it. The window is
		// the only cap on purpose: the Class A cap stays a RouteTab badge
		// concern (manual legs are never rewritten). `exact` (the keyboard
		// nudge) keeps the window clamp but skips the snap: a +-100 ft step
		// through the snap would land back on the current level, and precise
		// entry stays raw behind the RouteTab non-compliant cue, like typing.
		const loFt = Math.max(0, Math.ceil(win.viewFloorFt / 100) * 100);
		const hiFt = Math.max(loFt, Math.floor(win.viewCeilingFt / 100) * 100);
		const rounded = Math.min(hiFt, Math.max(loFt, Math.round(ft / 100) * 100));
		let target = rounded;
		if (!exact && routeSettings.semicircular) {
			const leg = computeNavLog(r.waypoints, null).legs[i];
			const floorFt = applicabilityFloorFt(
				legMinGroundElevFt(r.id, r.waypoints)[i] ?? null,
				routeSettings.vfr,
			);
			if (leg && leg.legNM > 1e-6 && rounded > floorFt) {
				const track = legMagneticTrackDeg(
					leg.trackTrueDeg,
					r.waypoints[i],
					r.waypoints[i + 1],
					decimalYearFromDate(new Date()),
				);
				target =
					snapToLevel(rounded, track, routeSettings.vfr, { floorFt, capFt: hiFt }, cruisingRegime()) ??
					rounded;
			}
		}
		setWaypointAltitude(wp.id, target);
	}

	// Crossings strip rows: every volume (airspace band or NOTAM band) the
	// drawn planned line penetrates, ordered by first entry. NOTAM bands
	// flow through bandCrossings unchanged (PlacedNotamBand extends
	// PlacedBand); their click resolves back to the NOTAM by key.
	const crossings = $derived.by(() => {
		const path = doc.altitudePath.vertices;
		if (path.length < 2) {
			return [];
		}
		return bandCrossings([...doc.placedBands, ...(overlays.profileNotamBands ?? [])], path, {
			vfr: routeSettings.vfr,
			// The UNGATED activation map: a crossing's active / forbidden
			// verdict must not change when the NOTAM overlay is toggled off.
			activeKeys: new Set(overlays.bandActivationsRaw?.keys() ?? []),
		});
	});
	function onCrossingClick(key: string): void {
		const nb = (overlays.profileNotamBands ?? []).find((b) => b.key === key);
		if (nb) {
			onNotamClick(nb.notamIndex); // navigates, centers, then leaveForDetail
		} else {
			onBandClick(key);
		}
	}

	// Airspace band click opens its panel and centers the map on the zone
	// (the panel crosshair's own bbox recipe: zoom-to-fit, z12 cap).
	function onBandClick(key: string): void {
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

	// Right-click menu listing the airspaces AND NOTAM bands under the cursor
	// (spans covering the distance whose altitude band contains the cursor),
	// like the map's context menu. The rows are assembled here; ProfileStackMenu
	// (the extra snippet) renders them above the modal, a row click opens the
	// feature's panel and a row hover highlights that band in the chart.
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
		const groundFt = terrainFtAt(terrain, distNM);
		const bands = corridorBands
			.filter(
				(b) =>
					b.spans.some((s) => distNM >= s.enterNM - 1e-6 && distNM <= s.leaveNM + 1e-6) &&
					altFt >= (b.vLower ? (exactFt(b.vLower, groundFt) ?? b.vLower.ft) : Number.NEGATIVE_INFINITY) &&
					altFt <= (b.vUpper ? (exactFt(b.vUpper, groundFt) ?? b.vUpper.ft) : Number.POSITIVE_INFINITY),
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
							(b.vLower ? (exactFt(b.vLower, groundFt) ?? b.vLower.ft) : Number.NEGATIVE_INFINITY) &&
							altFt <=
								(b.vUpper ? (exactFt(b.vUpper, groundFt) ?? b.vUpper.ft) : Number.POSITIVE_INFINITY))),
			)
			.map((b) => ({ id: b.id, index: b.index, vLower: b.vLower, vUpper: b.vUpper, known: b.knownExtent }));
		// "Classe G" phrasing for an empty result: charted volumes exist at
		// this distance and the click sits below every one of their floors
		// (a null floor reads SFC, so such a band would have contained the
		// point). Airspace bands only: class is an airspace concept, and a
		// distance with nothing charted at all keeps the generic wording.
		const over = corridorBands.filter((b) =>
			b.spans.some((s) => distNM >= s.enterNM - 1e-6 && distNM <= s.leaveNM + 1e-6),
		);
		const belowCharted =
			bands.length === 0 &&
			over.length > 0 &&
			over.every((b) => b.vLower != null && altFt < (exactFt(b.vLower, groundFt) ?? b.vLower.ft));
		ctxMenu = { open: true, x: clientX, y: clientY, bands, notams, belowCharted };
	}
	function closeCtxMenu(): void {
		ctxMenu.open = false;
		ctxHoverKey = null;
	}
	function onCtxSelect(key: string): void {
		onBandClick(key); // navigates, centers, then leaveForDetail
	}

	// Layers popover: one header icon button; ProfileLayersPopover (the extra
	// snippet) renders the anchored panel + backdrop above the modal box.
	let layersOpen = $state(false);
	let layersBtn = $state<HTMLButtonElement>();

	// Closing the modal (any path) dismisses the menu and the popover.
	$effect(() => {
		if (!routeProfileModal.open) {
			ctxMenu.open = false;
			ctxHoverKey = null;
			layersOpen = false;
		}
	});

	// Switching routes (header arrows or keyboard) invalidates the menu, which is
	// anchored to a point on the previous route's profile. Track only
	// routes.activeId: the menu writes also READ the ctxMenu signal, so without
	// untrack this effect would subscribe to ctxMenu and re-run the instant
	// onProfileContextMenu reassigns it to open the menu, closing it on the spot.
	$effect(() => {
		void routes.activeId;
		untrack(() => {
			ctxMenu.open = false;
			ctxHoverKey = null;
		});
	});
</script>

<svelte:window
	onkeydown={(e: KeyboardEvent) => {
		if (
			routeProfileModal.open &&
			(e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
			!ctxMenu.open &&
			!isEditableTarget(e.target)
		) {
			stepActiveRoute(e.key === 'ArrowRight' ? 1 : -1);
		}
	}}
/>

<SurfaceShell
	id="routeProfile"
	onClose={closeRouteProfile}
	onEscape={() => {
		if (layersOpen) {
			layersOpen = false;
		} else if (ctxMenu.open) {
			closeCtxMenu();
		} else {
			closeRouteProfile();
		}
	}}
	label={t.route.routeProfileAria}
	boxClass="route-profile-box print-palette"
	pageCss={() => PAGE_CSS}
	printName={() => routePrintStem('profile', activeRoute())}
>
	{#snippet header()}
		<!-- The hop to the sibling profile: the workspace swaps them in place
		     (same dock slot), so the window reads as one surface with two
		     views. It LEADS the header, before the title, in BOTH profile
		     windows: the two titles differ in width, and a control that moves
		     under the pointer across the swap breaks the double-toggle (the
		     stable-rows rule). Absent while there is no trace to show, never
		     disabled; Segmented fires on the selected side too, hence the
		     guard. -->
		{#if nav.points.length >= 2}
			<div class="no-print">
				<Segmented
					options={[
						{ value: 'route', label: t.tabs.route },
						{ value: 'trace', label: t.navigation.trace },
					]}
					value="route"
					onSelect={(v) => {
						if (v === 'trace') {
							openNavProfile();
						}
					}}
					ariaLabel={t.navigation.profileSwitchAria}
				/>
			</div>
		{/if}
		<h2>{t.route.verticalProfile}</h2>
		<RouteSwitcher />
		{#if enough}
			<div class="controls no-print">
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
				<button class="modal-close" title={t.route.fitTip} aria-label={t.route.fitAria} onclick={win.fitReset}>
					<Icon name="maximize" />
				</button>
				<button class="modal-close" title={t.route.print} aria-label={t.route.print} onclick={() => void printSurface('routeProfile')}>
					<Icon name="printer" />
				</button>
			</div>
		{/if}
	{/snippet}

	<div class="body">
				{#if !enough}
					<p class="muted">{t.route.profileAddWaypoints}</p>
				{:else}
					<PlotTitleLine
						route={activeRoute()}
						{totalNM}
						eteMin={doc.totalEteMin !== null
							? (routeWindEteMin(activeRoute()) ?? doc.totalEteMin)
							: null}
						interactive
						cap={titleCap}
					/>

					<!-- Crossings strip: every volume the drawn line penetrates,
					 forbidden first (led by the folded NO-GO pill), then by
					 first entry. Hover highlights the band (modal stays);
					 click navigates like clicking the band itself. On phones
					 the strip is CrossingsStrip's own one-line summary + sheet.
					 On desktop it is the one part that grows without limit
					 (a wrapping row per dock width), so it is the part that
					 yields: it keeps its natural height while there is room
					 and scrolls once the chart is down to its floor, which is
					 what stops a bottom dock full of chips from leaving no
					 profile in the profile. -->
					<div class="cx-scroll">
						<CrossingsStrip
							{crossings}
							interactive
							surfaceId="routeProfile"
							onhover={(key: string | null) => (ctxHoverKey = key)}
							onselect={onCrossingClick}
						/>
					</div>

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
							<div class="plot-area print-plot-ink" bind:clientWidth={win.plotW} bind:clientHeight={win.plotH}>
								{#if win.ready}
									<RouteProfile
										bands={doc.placedBands}
										{terrain}
										waypoints={doc.wpPoints}
										altitudePath={doc.altitudePath}
										legAltsFt={doc.legAltsFt}
										fromNM={win.viewFromNM}
										toNM={win.viewToNM}
										floorFt={win.viewFloorFt}
										ceilingFt={win.viewCeilingFt}
										widthPx={printing ? PRINT_PLOT_W : win.plotW}
										heightPx={printing ? PRINT_ROUTE_PLOT_H : win.plotH}
										onWaypointClick={onWaypoint}
										{onBandClick}
										{onWaypointAlt}
										onContextMenu={onProfileContextMenu}
										highlightKey={ctxHoverKey}
										vfr={routeSettings.vfr}
										transitionAltFt={routeSettings.semicircular
											? effectiveTransitionAltFt()
											: null}
										legWinds={profileLegWinds}
										legWindTips={profileLegWindTips}
										freezingFt={profileFreezingFt}
									msaFt={profileMsa}
										cloudCover={profileCloudCover}
										obstacles={overlays.profileObstacles}
										notamBands={overlays.profileNotamBands}
										notamObstacles={overlays.profileNotamObstacles}
										terrainTint={profileLayers.terrainTint}
										bandActivations={overlays.bandActivations}
										playheadNM={livePlayheadNM}
										playheadAltFt={liveAltFt}
										dimFlown={livePlayheadNM != null}
										{onNotamClick}
									{onObstacleClick}
										onInspect={(nm: number | null) => {
											inspectNM = nm;
										}}
										onZoom={win.applyZoom}
										onPan={win.applyPan}
										onFit={win.fitReset}
									/>
									{#if readout}
										<ProfileReadout
											class="no-print"
											rows={[
												{ label: t.navigation.distance, value: readout.distText },
												{ label: t.route.readoutLevel, value: readout.levelText },
												{ label: t.route.readoutGround, value: readout.groundText },
												{ label: 'AGL', value: readout.aglText },
											]}
											hint={t.route.readoutHint}
										/>
									{/if}
									<span class="gesture-hint no-print" aria-hidden="true"
										>{t.route.profileGestureHint}</span
									>
								{:else}
									<p class="muted sizing">{t.route.sizing}</p>
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
				rows={['windBarbs', 'freezing', 'clouds', 'obstacles', 'msa', 'terrainTint', 'notams']}
				anchorEl={layersBtn}
				onClose={() => (layersOpen = false)}
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
	:global(.route-profile-box) {
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

	.controls {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.body {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
		padding: 12px 16px 16px;

		/* Nothing leaves the surface box. Measured on a phone before this
		   existed: a bottom dock's crossings strip painted 47px past the
		   box, under the tab bar. The print flow resets this to visible. */
		overflow: hidden;
	}

	/* The title line and the crossings strip live in PlotTitleLine /
	   CrossingsStrip (shared with the printed dossier's profile sheet). */

	/* Natural height while there is room, and never more than its share:
	   past that it scrolls, so the chart always keeps the majority of a
	   short surface. On a desktop dock the strip is a row or two and this
	   never binds. */
	.cx-scroll {
		flex: 0 1 auto;

		/* One row always visible: a strip squeezed to nothing is worse than
		   a short one, because a 0px scroller says there is nothing to see. */
		min-height: 44px;
		max-height: 40%;
		overflow-y: auto;
	}

	.plot-stack {
		display: flex;
		flex: 1;

		/* The chart's own floor, which is what makes the strip yield rather
		   than the profile: on a phone's 269px bottom dock, seven crossing
		   chips left the plot 32px tall, which is a colour bar, not a
		   profile. The floor is a share of the surface as well as a figure,
		   so a short dock splits the room instead of starving the strip to
		   an invisible 0px scroller; a pilot who wants both in full drags
		   the dock up or switches the surface to full. */
		min-height: 120px;
		flex-direction: column;
	}

	/* the vertical altitude slider is a direct flex child (30px) left of the plot */
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

	/* the horizontal distance slider, offset under the plot-area (past the 30px
	 * vertical slider) */
	.plot-hrow {
		padding-left: 30px;
	}

	/* The vertical slider widens to 44px under touch-ui (RangeSlider), so
	   the offset follows: at 30px the distance track sat 14px left of the
	   plot's x-axis origin on every coarse pointer (the mobile audit's
	   finding). */
	:global(:root.touch-ui) .plot-hrow {
		padding-left: 44px;
	}

	/* ---- phones: the chart owns the dock ---------------------------------
	   Keyed off :root.mobile-ui, never a media query (the ui.svelte.ts
	   doctrine). The sliders go: the chart's own gestures (pinch zoom,
	   pan, keyboard, Fit) are the windowing, the field's model (SkyDemon's
	   Virtual Radar, ForeFlight's Profile View). The crossings keep every
	   chip but on ONE scrollable row, and the title line yields except
	   while it carries the loading / degradation cap. Print counter-rules
	   below: mobile-ui stays stamped while printing FROM a phone, and this
	   surface prints itself. */
	:global(:root.mobile-ui) .plot-row :global(.rslider),
	:global(:root.mobile-ui) .plot-hrow {
		display: none;
	}

	/* The phone strip is CrossingsStrip's own one-line summary (the sheet
	   holds the rows), so the scroller needs no phone-specific overflow
	   rules any more; the print un-hide of the full row lives in the
	   component beside the rendition it counter-rules. */
	:global(:root.mobile-ui) .cx-scroll {
		min-height: 0;
	}

	:global(:root.mobile-ui) .body > :global(.title-line:not(.has-cap)) {
		display: none;
	}

	/* The one-time gesture note over the plot: the sliders were the visible
	   windowing affordance, so discoverability must not drop to zero. */
	.gesture-hint {
		position: absolute;
		right: 8px;

		/* Bottom corner: the top strip belongs to the waypoint labels and the
		   x-axis line sits below; this is the plot's emptiest region. */
		bottom: 24px;
		display: none;
		padding: 1px 6px;
		font-size: 9px;
		color: var(--text-muted);
		background: color-mix(in srgb, var(--surface) 80%, transparent);
		border-radius: 6px;
		pointer-events: none;
	}

	:global(:root.mobile-ui) .gesture-hint {
		display: block;
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

	/* ---- landscape print: only the chart, fit to the page ---- */
	@media print {
		/* Hide the app's mount point, not just .app inside it: #app keeps its
		   height:100dvh even with .app display:none, which prints as a blank
		   leading page before the (portaled) modal. */
		:global(html.route-profile-print #app) {
			display: none !important;
		}

		:global(html.route-profile-print .modal-backdrop) {
			display: none !important;
		}

		:global(html.route-profile-print .route-profile-box) {
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

			/* Inks ride the shared .print-palette class on this box
			   (app.css), so the strip and title print the pinned day inks
			   whatever the session theme; the chart keeps its own
			   .print-plot-ink override below. */
			background: var(--surface);
		}

		:global(html.route-profile-print) .body {
			overflow: visible;
		}

		.no-print {
			display: none !important;
		}

		/* the sliders are on-screen controls; drop them from the print */
		.plot-row :global(.rslider),
		.plot-hrow {
			display: none !important;
		}

		/* Phone counter-rules: mobile-ui stays stamped while printing from a
		   phone, and paper neither scrolls nor hides its title. */
		:global(:root.mobile-ui) .body > :global(.title-line:not(.has-cap)) {
			display: flex;
		}

		:global(:root.mobile-ui) .cx-scroll {
			overflow: visible;
			max-height: none;
		}

		/* One viewBox, the current view, and the chart is BUILT at the page
		   (PRINT_PLOT_W / PRINT_ROUTE_PLOT_H) rather than stretched from the
		   screen: scaling a screen-sized viewBox up kept its label-fitting,
		   so the printed bands lost their vertical-limit lines and had their
		   names truncated. Nothing here may re-size the SVG. */
		.plot-stack,
		.plot-row {
			display: block;
		}

		/* The SVG's ink palette rides the shared .print-plot-ink class on
		   this element (app.css). */
		.plot-area {
			overflow: visible !important;
			border: none !important;
		}

		.plot-area :global(svg.plot) {
			/* Centred on the sheet; the size is the SVG's own. */
			display: block;
			margin: 0 auto;
		}

		/* Hover is a screen affordance: a pointer parked on a band while
		   printing must not freeze the dim / highlight into the paper.
		   Restore every class-driven hover state to its base values (the
		   :hover rules don't print; only these class states persist). */
		.plot-area :global(.band.dimmed path),
		.plot-area :global(.band.highlight path) {
			fill-opacity: 0.1;
			stroke-opacity: 0.4;
			stroke-width: 0.75;
		}

		.plot-area :global(.band.dimmed path.pecked),
		.plot-area :global(.band.highlight path.pecked) {
			stroke-width: 2.5;
			stroke-opacity: 0.85;
		}

		.plot-area :global(.band.dimmed path.act-hatch),
		.plot-area :global(.band.highlight path.act-hatch) {
			fill-opacity: 1;
		}

		.plot-area :global(.nband.dimmed path),
		.plot-area :global(.nband.highlight path) {
			fill-opacity: 0.55;
			stroke-opacity: 1;
			stroke-width: 1;
		}

		.plot-area :global(.band-label.dimmed) {
			opacity: 1;
		}
	}
</style>
