<script lang="ts">
	import { onMount } from 'svelte';
	import L from 'leaflet';
	import 'leaflet/dist/leaflet.css';
	import { baseLayerDef } from '$lib/map/baseLayers';
	import { CHART_LAYERS, createChartLayer } from '$lib/map/chartOverlays';
	import { offlineCharts, packFile } from '$lib/state/offlineCharts.svelte';
	import {
		renderNotams,
		setQlineRadiusVisible,
		setPanelQRadiusIndex,
		setQlineRadiusSuppressed,
		clearNotamLayer,
	} from '$lib/map/notamLayer';
	import {
		showAirports,
		hideAirports,
		clearAirports,
		refreshAirportZoom,
		updateAirportPane,
		setAirportCues,
		setAirportPublisher,
		setAirportType,
		ensureAirportIndex,
	} from '$lib/map/airportLayer';
	import {
		buildObstacleLayer,
		setObstacleGroupVisible,
		setObstaclePublisher,
		updateObstaclePane,
		clearObstacles,
		setObstacleCues,
	} from '$lib/map/obstacleLayer';
	import { activeNotamsByObstacle } from '$lib/state/notamObstacleLinks.svelte';
	import {
		buildNavaidLayer,
		setNavaidGroupVisible,
		setNavaidPublisher,
		updateNavaidPane,
		clearNavaids,
		setNavaidCues,
		setUnserviceableNavaids,
	} from '$lib/map/navaidLayer';
	import {
		buildNatureLayer,
		setNatureVisible,
		updateNaturePane,
		clearNatures,
	} from '$lib/map/natureLayer';
	import {
		activeNotamsByNavaid,
		unserviceableNavaids,
	} from '$lib/state/notamNavaidLinks.svelte';
	import {
		buildAirspaceLayer,
		setAirspaceCategory,
		setAirspacePublisher,
		setAirspaceAltitudeFilter,
		setRouteAirspaceFilter,
		updateAirspaceViewport,
		setLinkedAirspaces,
		clearAirspaceLayer,
		CATEGORIES,
	} from '$lib/map/airspaceLayer';
	import { renderActivations, clearActivations } from '$lib/map/activationLayer';
	import { ACTIVATION_HATCH_FILL } from '$lib/map/palette';
	import {
		buildAirspaceDecoLayer,
		redrawAirspaceDeco,
		setAirspaceLabelsVisible,
	} from '$lib/map/airspaceDecoLayer';
	import { syncSupaipLayer, clearSupaipLayer } from '$lib/map/supaipLayer';
	import {
		renderSupActivations,
		clearSupActivations,
	} from '$lib/map/supaipActivationLayer';
	import { syncSelectionHighlight } from '$lib/map/selectionHighlight';
	import { visibleSupaipZones } from '$lib/state/supaip.svelte';
	import { supZoneActivations, supZoneKey } from '$lib/state/supaipLinks.svelte';
	import type { SupAipZone } from '$lib/data/supaip';
	import { featureAt, contextFeaturesAt } from '$lib/map/interactions';
	import {
		syncRoutes,
		clearRouteLayer,
		snapLatLng,
		isPostDragClick,
		legAt,
		highlightLeg,
	} from '$lib/map/routeLayer';
	import { legHover, hoverLeg, unhoverLeg } from '$lib/state/legHover.svelte';
	import { syncRouteProgress, clearRouteProgress } from '$lib/map/routeProgressLayer';
	import { splitRouteAtNM } from '$lib/nav/steering';
	import { syncCorridor, clearCorridorLayer } from '$lib/map/routeCorridorLayer';
	import { syncMinAltCorridor, clearMinAltCorridorLayer } from '$lib/map/minAltCorridorLayer';
	import { syncMinAltDanger, clearMinAltDangerLayer } from '$lib/map/minAltDangerLayer';
	import { clearRouteAnalysisPane } from '$lib/map/routeAnalysisPane';
	import { syncNavTrace, syncNavAircraft, syncNavVector, clearNavLayer } from '$lib/map/navLayer';
	import { buildPreviewLayer, clearPreviewLayer } from '$lib/map/previewLayer';
	import { syncNavContact, clearNavContact } from '$lib/map/navContactLayer';
	import { syncNavAlerts, clearNavAlerts, drawableAlerts } from '$lib/map/navAlertLayer';
	import { airspaceAlerts, alertPrefs, drainAlertFires } from '$lib/state/airspaceAlert.svelte';
	import { armAlertAudioOnGesture, playAlertFireList } from '$lib/nav/alertSounds';
	import { syncProfilePoint, clearProfilePoint } from '$lib/map/profilePointLayer';
	import { navLiveNow } from '$lib/state/navLive.svelte';
	import { followNavRoute, navRouteId, navSegments } from '$lib/state/navRoute.svelte';
	import { smoothedMotionAt } from '$lib/nav/trace';
	import { routeColor, routeColorMap } from '$lib/route/routeColors';
	import { routesAirspaceKeysAtAltitude } from '$lib/route/airspaces';
	import { computeMinAltDangerCells } from '$lib/route/minAltitude';
	import {
		activeRoute,
		routes,
		routeSettings,
		addWaypoint,
		addWaypointFromSnap,
		selectWaypoint,
		removeWaypoint,
		applyAutoAltitudes,
		undoRoute,
		redoRoute,
	} from '$lib/state/route.svelte';
	import {
		ensureRouteTerrain,
		legMinGroundElevFt,
		pruneRouteTerrain,
		routeTerrainSamples,
	} from '$lib/state/routeTerrain.svelte';
	import { ensureRouteWindFor, pruneRouteWind, routeWind } from '$lib/state/routeWind.svelte';
	import {
		effectiveWindModel,
		ensureModelRun,
		ensureWindGrid,
		windAloft,
		windGrid,
		windGridBarbs,
		windGridIsobars,
		windGridIsotherm,
		windIsothermLabel,
	} from '$lib/state/windAloft.svelte';
	import {
		buildWindLayer,
		clearWindLayer,
		setWindData,
		syncWindLayer,
		windBarbNear,
	} from '$lib/map/windLayer';
	import { barbTipLines, type BarbTipInfo } from '$lib/weather/windBarbs';
	import {
		buildMetarLayer,
		clearMetarLayer,
		setMetarData,
		stationNear,
		syncMetarLayer,
	} from '$lib/map/metarLayer';
	import {
		ensureMetarStations,
		metarStations,
		stationFeed,
		stationTipLines,
		type MapStation,
	} from '$lib/state/metarStations.svelte';
	import {
		activatedAirspaceLinks,
		airspaceIdIndex,
		airspacesReferencedByNotam,
		isActiveTrigger,
	} from '$lib/state/notamLinks.svelte';
	import {
		getAirspaces,
		airspaceByKey,
		ensureObstacles,
		ensureNavaids,
		ensureNature,
		ensureSupaip,
		selectedSupaip,
		getSupaips,
		getObstacles,
		getNavaids,
		getNature,
	} from '$lib/state/data.svelte';
	import { layers, airportsAnyVisible, type ChartLayerId, type ChartSource,} from '$lib/state/layers.svelte';
	import { display } from '$lib/state/display.svelte';
	import { panelNativeZoom, type VacPanel, type VacPanelKind } from '$lib/data/vacgeo';
	import {
		buildVacPanelLayer,
		clearVacPanels,
		setVacPanelData,
		syncVacPanelLayer,
		vacPanelAt,
	} from '$lib/map/vacPanelLayer';
	import { clearVacPin, leadingChart, pinVacChart, vacPin } from '$lib/state/vacPin.svelte';
	import { offlineDocs } from '$lib/state/offlineDocs.svelte';
	import { ensureVacGeo, vacGeoState, vacPanelsIn } from '$lib/state/vacGeo.svelte';
	import { PANEL_BITMAP_BUDGET } from '$lib/state/panelCache';
	import {
		beginPanelPass,
		panelBitmapBytes,
		panelScaleFor,
		renderedPanel,
		syncDocPacks,
		vacRenderState,
	} from '$lib/state/vacPanels.svelte';
	import { activeAltitudeBand } from '$lib/state/filter.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { mapProfileModal } from '$lib/state/mapProfileModal.svelte';
	import { buildViewHash, parseViewHash, writeViewHash } from '$lib/map/viewHash';
	import { nav, currentPose, positionQuality } from '$lib/state/navRecording.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		visibleNotams,
		notamState,
		parseInput,
		notamsByIdent,
		isAirportNotam,
		selectedNotam,
	} from '$lib/state/notam.svelte';
	import { ensureAirports, ensureAirspaces, dataState, extendCoverage } from '$lib/state/data.svelte';
	import {
		areaOfPoints,
		coverage,
		setCoverageArea,
		setForcedPublishers,
		unionArea,
		type CoverageArea,
	} from '$lib/state/coverage.svelte';
	import { firToPublisher } from '$lib/notam/airspaceIds';
	import { PUBLISHERS, type Publisher } from '$lib/state/layers.svelte';
	import {
		ui,
		selectAirport,
		selectAirspace,
		selectObstacle,
		selectNavaid,
		selectNature,
		selectSupaip,
		selectSigmet,
		selectStation,
		navigateToAirspace,
	} from '$lib/state/ui.svelte';
	import {
		ensureSigmets,
		selectedSigmet,
		sigmetRings,
		sigmets,
		visibleSigmets,
	} from '$lib/state/sigmets.svelte';
	import { syncSigmetLayer, clearSigmetLayer, type SigmetDrawItem } from '$lib/map/sigmetLayer';
	import {
		contextMenu,
		openContextMenu,
		closeContextMenu,
	} from '$lib/state/contextMenu.svelte';
	import CursorCoords from './CursorCoords.svelte';
	import {
		cancelCursorElevation,
		cursorElevation,
		probeCursorElevation,
	} from '$lib/state/cursorElevation.svelte';
	import NavStrip from './NavStrip.svelte';

	const DEFAULT_CENTER: L.LatLngTuple = [48.8566, 2.3522];
	const DEFAULT_ZOOM = 6;

	// Chart layers sit above the base map (z 200) but below the reference
	// overlays (airspaces z 350) so airspaces / airports / NOTAMs stay on
	// top. Each STACKED chart layer gets its own pane at zIndex
	// CHART_PANE_BASE + its position in layers.chartStack — the check order
	// is the draw order (top of the stack wins where charts overlap).
	const CHART_PANE_BASE = 250;

	let container: HTMLDivElement;
	let map: L.Map | undefined;
	let zoomCtl: L.Control.Zoom | undefined;
	let activeBase: L.TileLayer | undefined;
	let activeBaseId: string | undefined;
	// Non-reactive handles to the mounted chart layers, keyed by id, so the
	// stack sync can add / remove / restack each without touching the others.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- L.TileLayer handle cache, not reactive state
	const chartLayerHandles = new Map<
		ChartLayerId,
		{ layer: L.GridLayer; source: ChartSource; pack: File | null }
	>();
	let airportsReparsed = false;
	let airspacesBuilt = $state(false);
	// $state, not plain lets: the cue effects below guard on them BEFORE
	// calling their selector, so the flag has to be what re-runs the effect
	// once the layer is built. (airspacesBuilt above was already reactive.)
	let obstaclesBuilt = $state(false);
	let navaidsBuilt = $state(false);

	// Live coordinates under the mouse cursor. Populated by the existing
	// mousemove handler below and consumed by CursorCoords. Null when the
	// cursor is off the map (cleared in onMapMouseOut).
	let hoveredCoord = $state<{ lat: number; lng: number } | null>(null);

	// Wind-barb hover readout (direction, speed in kt and km/h, ISA), fed by
	// the same rAF-throttled mousemove; null when no barb sits under the
	// cursor. Positioned at the cursor's container point, pointer-inert;
	// flip is precomputed there (the template must not read `container`).
	// The hovered DATUM, not the rendered lines: the template builds the text,
	// so a locale switch mid-hover re-renders the badge (docs/i18n.md rule 3).
	let windTip = $state<{
		x: number;
		y: number;
		flip: boolean;
		station: MapStation | null;
		barb: BarbTipInfo | null;
	} | null>(null);

	/** Swap the base tile layer when the layers state changes. */
	function syncBaseLayer(): void {
		if (!map || activeBaseId === layers.baseLayer) {
			return;
		}
		const def = baseLayerDef(layers.baseLayer);
		const next = def.create();
		next.addTo(map);
		activeBase?.remove();
		activeBase = next;
		activeBaseId = def.id;
	}

	/**
	 * Sync the mounted chart layers to layers.chartStack + layers.chartSource.
	 * Each stacked id gets its own pane `chart-<id>` whose zIndex follows the
	 * id's position in the stack (CHART_PANE_BASE + index), so the CHECK
	 * ORDER is the draw order. A source switch (dev-only selector) recreates
	 * the mounted layers from the other URL template; a layer with no
	 * template for the active source is skipped (the LayersTab greys it out).
	 * A chart with a READY offline pack is built from the local archive
	 * instead of the network (createPackChartLayer; same pane, options and
	 * on-screen behaviour); the handle remembers WHICH File it was built
	 * from, so a finished download or a pack delete (offlineCharts.gen bump
	 * re-runs the effect below) swaps the live layer in place.
	 */
	// The offline pack reader, imported on first use. Memoised so a stack of
	// several packed charts resolves one module, not one per layer.
	let packChartLayerModule: Promise<typeof import('$lib/map/packChartLayer').createPackChartLayer> | null = null;
	function loadPackChartLayer(): Promise<typeof import('$lib/map/packChartLayer').createPackChartLayer> {
		packChartLayerModule ??= import('$lib/map/packChartLayer').then((m) => m.createPackChartLayer);
		return packChartLayerModule;
	}

	function syncChartStack(): void {
		if (!map) {
			return;
		}
		const source = import.meta.env.DEV ? layers.chartSource : 'public';
		for (const [id, h] of chartLayerHandles) {
			if (!layers.chartStack.includes(id) || h.source !== source || h.pack !== packFile(id)) {
				h.layer.remove();
				chartLayerHandles.delete(id);
			}
		}
		layers.chartStack.forEach((id, i) => {
			const def = CHART_LAYERS.find((d) => d.id === id);
			if (!def) {
				return;
			}
			const paneName = `chart-${id}`;
			const pane = map!.getPane(paneName) ?? map!.createPane(paneName);
			pane.style.zIndex = String(CHART_PANE_BASE + i);
			if (!chartLayerHandles.has(id)) {
				const pack = packFile(id);
				if (pack) {
					// The pack reader pulls in pmtiles (and fflate through it),
					// which nobody needs until a chart has actually been
					// downloaded, so it is fetched on first use rather than
					// riding the entry chunk. Async: re-check the handle when it
					// lands, since a stack change may have overtaken it.
					void loadPackChartLayer().then((create) => {
						if (!map || chartLayerHandles.has(id) || packFile(id) !== pack) {
							return;
						}
						const layer = create(def, paneName, pack);
						if (layer) {
							chartLayerHandles.set(id, { layer: layer.addTo(map), source, pack });
						}
					});
				} else {
					const layer = createChartLayer(def, source, paneName);
					if (layer) {
						chartLayerHandles.set(id, { layer: layer.addTo(map!), source, pack });
					}
				}
			}
		});
	}

	onMount(() => {
		// Restore a shared view from the URL hash
		// (#map=z/lat/lon[&layer=][&charts=]); fall back to the Paris default. The
		// base layer + OACI overlay are applied first so syncBaseLayer() below and
		// the base-layer / oaci effects pick them up.
		const restored = parseViewHash(location.hash);
		if (restored) {
			// A present #map= is the WHOLE view and wins over the stored seed
			// (layers.svelte.ts reads localStorage at module init): an absent
			// &layer= / &charts= encodes the OSM default / empty stack, so a
			// shared bare link shows what its sender saw, exactly like the
			// hashchange handler below. The settle effect then restamps and
			// persists that state (the accepted consequence).
			layers.baseLayer = restored.layer ?? 'osm';
			layers.chartStack = restored.charts;
		}
		// Reduced motion: Leaflet's zoom / fade animations are JS-driven, so the
		// app.css near-zero block cannot reach them; the options are read once at
		// creation, which is why this is a creation-time matchMedia probe rather
		// than a live listener.
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		map = L.map(container, {
			center: restored ? restored.center : DEFAULT_CENTER,
			zoom: restored ? restored.zoom : DEFAULT_ZOOM,
			// The zoom control is owned by a locale effect below: Leaflet bakes
			// its title strings at creation, so it is rebuilt per language.
			zoomControl: false,
			zoomAnimation: !reducedMotion,
			fadeAnimation: !reducedMotion,
		});
		mapState.map = map;
		syncBaseLayer();
		buildPreviewLayer(map);

		/* Publish the area the reference datasets must cover: the map
		   viewport unioned with every route's extent, so a plan crossing a
		   country loads it even while the map looks elsewhere. Called from
		   the move handler (and once at creation) so the gate has an area
		   before anything asks for data. */
		const publishCoverageArea = (m: L.Map): void => {
			const b = m.getBounds();
			let area: CoverageArea | null = {
				minLat: b.getSouth(),
				minLon: b.getWest(),
				maxLat: b.getNorth(),
				maxLon: b.getEast(),
			};
			for (const r of routes.list) {
				area = unionArea(area, areaOfPoints(r.waypoints));
			}
			setCoverageArea(area);
		};

		const onMove = (): void => {
			if (!map) {
				return;
			}
			const c = map.getCenter();
			mapState.zoom = map.getZoom();
			mapState.center = { lat: c.lat, lng: c.lng };
			publishCoverageArea(map);
			updateAirportPane(map);
			refreshAirportZoom(map);
			updateAirspaceViewport(map);
			updateObstaclePane(map);
			updateNavaidPane(map);
		};
		map.on('moveend zoomend', onMove); // i18n-ignore: Leaflet event names, not display text
		onMove();

		// Editing only the #hash in the URL bar (or following a #map= link) is a
		// soft navigation: the browser fires hashchange WITHOUT reloading, so the
		// onMount restore above never re-runs. Re-apply the view live here so the
		// address bar drives the map. Our own writeViewHash uses replaceState,
		// which fires no hashchange, so this can't loop back on itself.
		const onHashRestore = (): void => {
			const v = parseViewHash(location.hash);
			if (!v || !map) {
				return;
			}
			// An absent &layer= encodes the OSM default (viewHash.ts), so a
			// hand-edited bare #map= must restore it like the chart flags below;
			// keeping the current layer would make the settle effect re-stamp
			// the key the user just deleted.
			layers.baseLayer = v.layer ?? 'osm';
			layers.chartStack = v.charts;
			map.setView(v.center, v.zoom);
		};
		window.addEventListener('hashchange', onHashRestore);

		// Airports / obstacles / airspaces all need a manual click fallback
		// now that none of them bind per-feature click handlers to their
		// canvases: airportLayer and obstacleLayer paint single direct-draw
		// canvases (no L.circleMarker objects), and airspaces are
		// interactive: false on purpose so they can't shadow NOTAM clicks.
		// Order matters and matches the visual z-stack: airports (z 400)
		// > obstacles (z 380) > airspaces (z 350). NOTAM markers (z 600,
		// real L.Marker objects) handle their own clicks above this.
		const onMapClick = (e: L.LeafletMouseEvent): void => {
			if (!map) {
				return;
			}
			// A waypoint drag ends with a synthetic map click Leaflet fails to
			// suppress here (repainting the dropped pin defeats its guard); ignore
			// it so a drag never adds a waypoint or selects the feature under the drop.
			if (isPostDragClick()) {
				return;
			}
			// In route edit mode a left-click adds a waypoint (snapped to a nearby
			// waypoint, airport or navaid when one is in range) instead of selecting
			// a feature.
			if (routeSettings.editMode) {
				const snap = snapLatLng(e.latlng.lat, e.latlng.lng);
				const wp = snap
					? addWaypointFromSnap(snap)
					: addWaypoint(e.latlng.lat, e.latlng.lng);
				selectWaypoint(wp.id);
				return;
			}
			// station > airport > navaid > obstacle > airspace; a click selects
			// whatever is on top, FIR/UIR included (see featureAt).
			const hit = featureAt(map, e.latlng.lat, e.latlng.lng);
			if (!hit) {
				// Nothing above it was hit, so the click belongs to the
				// chart under the pointer if there is one. Last on purpose,
				// and it is the pane order rather than a preference: the
				// VAC panels are at z300, below every layer featureAt
				// probes. A chart is not a selection either, which is why
				// it is not a FeatureHit: it has no detail panel, only a
				// place in the stack.
				const chart = vacPanelAt(e.latlng.lat, e.latlng.lng);
				if (chart) {
					pinVacChart(chart.ident);
				}
				return;
			}
			if (hit?.kind === 'station') {
				selectStation(hit);
			} else if (hit?.kind === 'airport') {
				selectAirport(hit.id);
			} else if (hit?.kind === 'nature') {
				selectNature(hit.id);
			} else if (hit?.kind === 'navaid') {
				selectNavaid(hit.id);
			} else if (hit?.kind === 'obstacle') {
				selectObstacle(hit.id);
			} else if (hit?.kind === 'supaip') {
				selectSupaip(hit.id, hit.zone);
			} else if (hit?.kind === 'sigmet') {
				selectSigmet(hit.id);
			} else if (hit?.kind === 'airspace') {
				// Reached from the selected NOTAM (one of the airspaces it
				// references, the reason it stays clickable with its category
				// off): navigate with a back-link to that NOTAM. Any other
				// airspace click is a fresh selection.
				const key = hit.key;
				const notam = selectedNotam();
				const fromNotam =
					notam != null &&
					airspacesReferencedByNotam(notam).some((a) => a.key === key);
				if (fromNotam) {
					navigateToAirspace(key);
				} else {
					selectAirspace(key);
				}
			}
		};
		const onMapContextMenu = (e: L.LeafletMouseEvent): void => {
			if (!map) {
				return;
			}
			const features = contextFeaturesAt(map, e.latlng.lat, e.latlng.lng);
			// Always open (and suppress the browser's native menu): even over
			// empty map the menu offers "Copy coordinates" for the click point.
			L.DomEvent.preventDefault(e.originalEvent);
			openContextMenu(
				features,
				e.latlng.lat,
				e.latlng.lng,
				e.originalEvent.clientX,
				e.originalEvent.clientY,
			);
			// The menu's airspace / SUP AIP sections are dataset-backed
			// location queries, ungated by the layer toggles, so the datasets
			// load on first use (with every layer off nothing else loads
			// them). Backfill the still-open menu in place once they arrive.
			if (!dataState.airspacesLoaded || !dataState.supaipLoaded) {
				const { lat, lng } = e.latlng;
				const { clientX, clientY } = e.originalEvent;
				void Promise.allSettled([ensureAirspaces(), ensureSupaip()]).then(() => {
					if (!map || !contextMenu.open || contextMenu.lat !== lat || contextMenu.lng !== lng) {
						return;
					}
					openContextMenu(contextFeaturesAt(map, lat, lng), lat, lng, clientX, clientY);
				});
			}
		};
		map.on('click', onMapClick);
		map.on('contextmenu', onMapContextMenu);
		map.on('movestart zoomstart', closeContextMenu); // i18n-ignore: Leaflet event names, not display text

		// The leg of the active route under the pointer, or none: the Route tab
		// marks its row and this map draws the segment heavy (both off the one
		// legHover state). A clear only ever drops the MAP's own hover, never a
		// panel row's: the pointer leaves the map to reach the sidebar, so the
		// mouseout arrives with the row already pointing.
		const applyMapLegHover = (hit: { routeId: string; fromId: string } | null): void => {
			if (hit) {
				hoverLeg(hit.routeId, hit.fromId, 'map');
				return;
			}
			const cur = legHover.leg;
			if (cur?.source === 'map') {
				unhoverLeg(cur.fromId);
			}
		};

		// Pointer cursor when hovering a clickable airspace. We skip FIR/UIR -
		// those layers cover the whole region and would otherwise replace the
		// drag affordance everywhere; and bail out during a Leaflet drag so we
		// don't fight the .leaflet-dragging cursor. Throttled to one frame so
		// the hit-test never runs more than once per repaint.
		let cursorHovering = false;
		let cursorPending = 0;
		const onMapMouseMove = (e: L.LeafletMouseEvent): void => {
			if (!map || cursorPending) {
				return;
			}
			const { lat, lng } = e.latlng;
			// Cheap state write: piggy-back on the existing rAF throttle so
			// the cursor badge updates at most once per repaint. Done outside
			// the airspace hit-test so the badge stays fresh even while the
			// hit-test is suppressed during a drag.
			hoveredCoord = { lat, lng };
			// The ground under that same point, from the tiles already
			// decoded; a fetch only once the pointer comes to rest
			// (state/cursorElevation). Beside the coordinate write rather
			// than inside the frame below, so the two lines of the badge
			// always describe the same place.
			probeCursorElevation(lat, lng);
			const cursorPt = e.containerPoint;
			cursorPending = requestAnimationFrame(() => {
				cursorPending = 0;
				if (!map) {
					return;
				}
				const container = map.getContainer();
				if (container.classList.contains('leaflet-dragging')) {
					windTip = null;
					applyMapLegHover(null);
					return;
				}
				// Hover readout: METAR stations first (they draw above the aloft
				// barbs' pane order in reading priority; observed beats forecast
				// under the cursor), then the wind barbs.
				const station = stationNear(map, lat, lng);
				const barb = station ? null : windBarbNear(map, lat, lng);
				windTip =
					station || barb
						? {
								x: cursorPt.x,
								y: cursorPt.y,
								flip: cursorPt.x > map.getSize().x - 240,
								station,
								barb,
							}
						: null;
				// The route leg under the pointer (its own map-level test: the
				// coloured line is a 4 px stroke and its casing takes no events,
				// so a polyline mouseover would be a target nobody can hold).
				applyMapLegHover(legAt(lat, lng));
				// Airports, obstacles, and airspaces are all hit-tested
				// manually here for the same reason the click is (see
				// onMapClick): the canvases the airport / obstacle layers
				// draw to don't fire per-feature mouseover, so the cursor
				// never turns to pointer without this check. FIR/UIR are
				// excluded (they blanket the region); a click still selects
				// them, this only governs the hover cursor.
				const hit = featureAt(map, lat, lng);
				const should = hit != null && !(hit.kind === 'airspace' && hit.category === 'fir');
				if (should !== cursorHovering) {
					cursorHovering = should;
					container.style.cursor = should ? 'pointer' : '';
				}
			});
		};
		const onMapMouseOut = (): void => {
			if (cursorPending) {
				cancelAnimationFrame(cursorPending);
				cursorPending = 0;
			}
			// Intentionally leave hoveredCoord as-is so the bottom-left
			// CursorCoords badge stays visible with the last cursor
			// position when the user moves off the map; otherwise moving
			// toward the badge to click it would clear the badge before
			// the click lands (the badge is a sibling of the Leaflet
			// container, so entering it counts as leaving the map).
			if (cursorHovering && map) {
				cursorHovering = false;
				map.getContainer().style.cursor = '';
			}
			windTip = null;
			applyMapLegHover(null);
			// The elevation probe is deliberately NOT cancelled here, nor on
			// a view change below: hoveredCoord freezes at the same instant,
			// so a probe already armed is answering for the very point the
			// badge is still showing. Cancelling it stranded the line on its
			// placeholder for as long as the map kept moving, which under
			// follow mode is the whole flight (measured: seven seconds of
			// 1 Hz pans with the pointer at rest, and it never filled).
		};
		// The barb readout must not survive a view change (wheel zoom fires
		// no mousemove, so the tip would linger over the wrong spot).
		const onViewChangeStart = (): void => {
			windTip = null;
		};
		map.on('mousemove', onMapMouseMove);
		map.on('mouseout', onMapMouseOut);
		map.on('movestart zoomstart', onViewChangeStart); // i18n-ignore: Leaflet event names, not display text

		// Keep Leaflet's internal size in sync with the flex container: the
		// docks shrink it in flow, so this is also what makes a dock resize
		// reach the map. A zero box (the page placement hides the map row)
		// is skipped, since Leaflet cannot project against it and would only
		// have to be told again on the way back.
		const ro = new ResizeObserver(() => {
			if (container.clientWidth > 0 && container.clientHeight > 0) {
				map?.invalidateSize();
			}
		});
		ro.observe(container);

		return () => {
			ro.disconnect();
			if (cursorPending) {
				cancelAnimationFrame(cursorPending);
			}
			cancelCursorElevation();
			if (hashTimer != null) {
				clearTimeout(hashTimer);
				hashTimer = null;
			}
			window.removeEventListener('hashchange', onHashRestore);
			// i18n-ignore-start: Leaflet event names, not display text
			map?.off('moveend zoomend', onMove);
			map?.off('movestart zoomstart', onViewChangeStart);
			map?.off('click', onMapClick);
			map?.off('contextmenu', onMapContextMenu);
			map?.off('movestart zoomstart', closeContextMenu);
			map?.off('mousemove', onMapMouseMove);
			map?.off('mouseout', onMapMouseOut);
			// i18n-ignore-end
			// Drop the activation overlay state before the map goes;
			// map.remove() detaches the DOM but the module-level Maps in
			// activationLayer would otherwise retain references to the
			// dead map (HMR & test reloads notice).
			if (map) {
				clearActivations(map);
				clearSupActivations(map);
				clearAirports(map);
				clearObstacles(map);
				clearNavaids(map);
				clearNatures(map);
				clearRouteLayer(map);
				clearRouteProgress(map);
				clearCorridorLayer(map);
				clearMinAltCorridorLayer(map);
				clearMinAltDangerLayer(map);
				clearRouteAnalysisPane(map);
				clearWindLayer(map);
				clearMetarLayer(map);
				clearNavLayer(map);
				clearNavContact(map);
				clearNavAlerts(map);
				clearProfilePoint(map);
				clearVacPanels(map);
				// These take no map: they null their module-level
				// group / index handles, whose `if (!group)` build guards
				// would otherwise pin a remounted component to the dead map.
				clearNotamLayer();
				clearAirspaceLayer();
				clearSupaipLayer();
				clearSigmetLayer();
				clearPreviewLayer();
			}
			map?.remove();
			mapState.map = null;
			map = undefined;
		};
	});

	/* The publishers a loaded briefing points at, forced into the coverage
	   gate whatever the map is showing. "Linked lists always show"
	   (docs/notam-relationships.md): a NOTAM panel has to be able to list
	   its affected airspaces, and the highlight has to be able to draw
	   them, even when the map is somewhere else entirely. Read off the RAW
	   briefing, not filteredNotams(), so a data filter can never gate a
	   dataset out from under a panel. */
	$effect(() => {
		const wanted: Publisher[] = [];
		for (const n of notamState.notams) {
			const fir = n.qualifier?.fir;
			const p = fir ? firToPublisher(fir) : null;
			if (p) {
				wanted.push(p);
			}
		}
		setForcedPublishers(wanted);
	});

	/* Widen what is loaded when the area of interest grows. Reading both
	   coverage fields here is the subscription; extendCoverage itself only
	   touches datasets something has already asked for, so this never
	   starts a load on its own. */
	$effect(() => {
		void coverage.area;
		void coverage.forced;
		void extendCoverage();
	});

	$effect(() => {
		// Re-run whenever the selected base layer changes.
		void layers.baseLayer;
		syncBaseLayer();
	});

	// The hash restamp below is throttled (leading + trailing, one window):
	// follow-mode pans fire moveend per pose (1 Hz live, 10 Hz replay), and
	// Safari hard-fails history.replaceState past 100 calls per 30 s. Later
	// runs inside the window only refresh pendingHash, they never re-arm the
	// timer, so continuous motion still stamps once a window instead of
	// starving. The timer is cleared at unmount (the onMount teardown), never
	// in the effect itself, where cleanup would run before every re-run.
	const HASH_THROTTLE_MS = 1000;
	let hashTimer: ReturnType<typeof setTimeout> | null = null;
	let hashLastMs = 0;
	let pendingHash = '';

	function flushViewHash(): void {
		hashLastMs = Date.now();
		writeViewHash(pendingHash);
	}

	$effect(() => {
		// Keep the shareable URL hash (#map=z/lat/lon[&layer=][&charts=]) in
		// step with the settled view, the base layer and the chart overlays.
		// mapState.center/zoom are written by the moveend/zoomend handler, so this fires
		// on settle, not per frame; it writes to history (not tracked $state), so there
		// is no self-trigger loop. The hash is BUILT synchronously on every run:
		// buildViewHash reads each chart flag, which is what keeps the effect
		// tracking chartStack's in-place mutations.
		if (!mapState.map) {
			return;
		}
		const { lat, lng } = mapState.center;
		pendingHash = buildViewHash(mapState.zoom, lat, lng, layers.baseLayer, layers.chartStack);
		const since = Date.now() - hashLastMs;
		if (since >= HASH_THROTTLE_MS) {
			flushViewHash();
		} else if (hashTimer == null) {
			hashTimer = setTimeout(() => {
				hashTimer = null;
				flushViewHash();
			}, HASH_THROTTLE_MS - since);
		}
	});

	$effect(() => {
		// The zoom control carries the only user-visible Leaflet strings, and
		// Leaflet bakes control options at creation, so rebuild it whenever the
		// locale changes its titles. Reading mapState.map (reactive) covers the
		// first run racing onMount.
		const m = mapState.map;
		const zoomInTitle = t.map.zoomIn;
		const zoomOutTitle = t.map.zoomOut;
		if (!m) {
			return;
		}
		zoomCtl?.remove();
		zoomCtl = L.control.zoom({ zoomInTitle, zoomOutTitle });
		zoomCtl.addTo(m);
	});

	$effect(() => {
		// Mount / unmount / restack the chart layers when the stack or the
		// dev source selector changes. Reading length + every entry (and the
		// source) makes the effect track them.
		void layers.chartStack.length;
		for (const id of layers.chartStack) {
			void id;
		}
		void layers.chartSource;
		// A pack appearing or disappearing swaps that chart's live layer
		// between network and the local archive.
		void offlineCharts.gen;
		syncChartStack();
	});

	$effect(() => {
		// Re-draw NOTAM features whenever the parsed set or filter changes,
		// or when one of the display flags that participates in the render
		// (obstacle-type icons, Q-line marker visibility) flips.
		const all = visibleNotams();
		const typeIcons = display.typeIcons;
		const qlineMarkers = display.qlineMarkers;
		// When "Hide airport NOTAM markers" is on and airports are shown,
		// suppress the blue Q-line (fallback) marker of aerodrome NOTAMs; the
		// airport's cue ring + detail panel represent them instead. Red position
		// markers, radius circles, and area polygons are left untouched. Reading
		// dataState.airportsLoaded re-runs this once the (non-reactive) airport
		// index is populated, so the set fills in as soon as airports load.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const hideAirportQline = new Set<number>();
		if (
			airportsAnyVisible() &&
			display.hideAirportNotamMarkers &&
			dataState.airportsLoaded
		) {
			for (const { notam, index } of all) {
				if (isAirportNotam(notam)) {
					hideAirportQline.add(index);
				}
			}
		}
		if (map) {
			renderNotams(map, all, typeIcons, qlineMarkers, hideAirportQline);
		}
	});

	$effect(() => {
		// Toggle on-selection Q-line radius circles.
		setQlineRadiusVisible(display.qlineRadius);
	});

	$effect(() => {
		// Position/area NOTAMs draw their Q-line radius circle only when the
		// open detail panel has its "Show Q radius" toggle on for that NOTAM.
		const idx = ui.detail?.kind === 'notam' ? ui.detail.index : null;
		setPanelQRadiusIndex(idx !== null && idx === ui.qRadiusIndex ? idx : null);
	});

	$effect(() => {
		// When a NOTAM that references airspaces ("Affected airspaces": named
		// in its text or cited by designator) is selected and the option is on,
		// highlight all of them and suppress its auto Q-line radius circle. The
		// circle stays available via the detail-panel toggle (additive), so the
		// highlight is not gated on ui.qRadiusIndex.
		const notam = display.affectedAirspaces ? selectedNotam() : null;
		const affected = notam ? airspacesReferencedByNotam(notam) : [];
		setLinkedAirspaces(affected.length ? affected : null);
		setQlineRadiusSuppressed(affected.length > 0);
	});

	$effect(() => {
		// Lazy-load the airports overlay and sync per-group visibility. Mirrors
		// the airspace category effect: the layer stays on the map while any
		// airport group is enabled, and the draw loop hides the OurAirports
		// types whose group toggle is off. The grouped "Airports" checkbox
		// flips the three fixed-wing sizes together.
		// The spread reads every group flag unconditionally (the canonical
		// airportsAnyVisible() short-circuits, so it alone would under-track).
		const g = { ...layers.airportTypes };
		if (!map) {
			return;
		}
		if (!airportsAnyVisible()) {
			hideAirports();
			return;
		}
		void ensureAirports()
			.then((airports) => {
				if (!map || !airportsAnyVisible()) {
					return;
				}
				showAirports(map, airports);
				setAirportType('large_airport', g.airports);
				setAirportType('medium_airport', g.airports);
				setAirportType('small_airport', g.airports);
				setAirportType('heliport', g.heliports);
				setAirportType('seaplane_base', g.seaplane);
				setAirportType('balloonport', g.balloon);
				setAirportType('closed', g.closed);
				// Airport coords are now available; re-parse once so NOTAMs
				// anchored via "RDL …/… ARP <ICAO>" can resolve a position.
				// reparse: same text, same briefing, so a fetched result keeps
				// its viewport filter and its fetch provenance.
				if (!airportsReparsed && notamState.parsedAt > 0) {
					airportsReparsed = true;
					parseInput({ reparse: true });
				}
				// Sync NOTAM cue rings on the airports we just built.
				setAirportCues(new Set(notamsByIdent().keys()));
			})
			.catch(() => {
				/* error is surfaced via dataState.airportsError */
			});
	});

	$effect(() => {
		// Keep the airport cue rings in sync with the visible NOTAMs.
		setAirportCues(new Set(notamsByIdent().keys()));
	});

	$effect(() => {
		// Lazy-load and toggle the airspace category overlays. The revision
		// counter is read so a LATE country (coverage loads publishers by
		// area as the map moves) re-runs the build with the re-merged array,
		// which buildAirspaceLayer re-indexes under the live layer.
		void dataState.revision.airspaces;
		const vis = { ...layers.airspace };
		if (!map) {
			return;
		}
		const anyOn = CATEGORIES.some((c) => vis[c]);
		// Build the dataset + polygons when the user wants airspaces drawn, once
		// a briefing is loaded, OR once the dataset has been loaded by any other
		// path (a route's nav-log schedule, an airport / airspace panel). The
		// NOTAM "In airspaces" list and the selected-airspace highlight must work
		// even with every airspace layer off (the default) and with no briefing
		// at all (route planning), so they need the data loaded and the geometry
		// built (byKey, which highlightAirspace looks the selection up in)
		// regardless of category visibility; the category toggles below still
		// decide what is actually drawn on the map.
		const routeOnlyActive =
			routeSettings.airspacesOnRouteOnly && routes.list.some((r) => r.waypoints.length >= 2);
		const needed =
			anyOn ||
			routeOnlyActive ||
			notamState.notams.length > 0 ||
			dataState.airspacesLoaded;
		if (!needed) {
			if (airspacesBuilt) {
				for (const c of CATEGORIES) {
					setAirspaceCategory(map, c, false);
				}
			}
			return;
		}
		void ensureAirspaces()
			.then((airspaces) => {
				if (!map) {
					return;
				}
				buildAirspaceLayer(map, airspaces);
				buildAirspaceDecoLayer(map);
				airspacesBuilt = true;
				for (const c of CATEGORIES) {
					setAirspaceCategory(map, c, layers.airspace[c]);
				}
				updateAirspaceViewport(map);
				redrawAirspaceDeco(map);
			})
			.catch(() => {
				/* error is surfaced via dataState.airspacesError */
			});
	});

	// VFR Class A altitude rule. Recompute every auto leg's altitude when the
	// route geometry, the VFR flag or the default altitude changes, and once the
	// airspace dataset finishes loading (it is usually null when a route is first
	// drawn). Keyed on lat/lon only (a stringified signature), never on wp.alt:
	// this effect WRITES wp.alt on auto legs, so reading it would loop. Hosted
	// here because MapView is always mounted and already owns the airspace data.
	// Covers every route's geometry: applyAutoAltitudes re-levels all of them, so
	// adding or moving a waypoint on any route re-runs the rule.
	const routeCoordsKey = $derived(
		routes.list
			.map((r) => r.waypoints.map((w) => `${w.lat.toFixed(5)},${w.lon.toFixed(5)}`).join('|'))
			.join('||'),
	);
	$effect(() => {
		void routeCoordsKey;
		void routeSettings.vfr;
		void routeSettings.defaultAltitudeFt;
		void dataState.airspacesLoaded;
		// Semicircular cruising levels: the applicability floor follows the
		// per-leg minimum ground, so keep the shared terrain warm and read it
		// here (a tracked read: auto legs re-level when the samples land).
		let legMinElevByRoute: Record<string, readonly (number | null)[]> | undefined;
		if (routeSettings.semicircular) {
			legMinElevByRoute = {};
			for (const r of routes.list) {
				if (r.waypoints.length >= 2) {
					ensureRouteTerrain(r.id, r.waypoints);
					legMinElevByRoute[r.id] = legMinGroundElevFt(r.id, r.waypoints);
				}
			}
			pruneRouteTerrain(routes.list.map((r) => r.id));
		}
		applyAutoAltitudes(routeSettings.vfr, getAirspaces(), legMinElevByRoute);
	});

	// What the four map layers were last told, mirroring their own initial
	// state (every publisher visible), so the first run pushes exactly the
	// publishers stored as hidden.
	const pushedPublisher: Record<Publisher, boolean> = Object.fromEntries(
		PUBLISHERS.map((p) => [p, true]),
	) as Record<Publisher, boolean>;

	$effect(() => {
		// Per-publisher toggles. One effect fans the flag changes out to
		// every map layer that filters by publisher: airspaces, airports,
		// navaids and obstacles.
		//
		// It iterates PUBLISHERS rather than naming them, because a
		// hand-kept list here silently produced a dead checkbox for every
		// publisher added after the first eight: Switzerland's and the
		// United States' obstacles ignored their toggle, and so did the
		// airspaces of Georgia, the Netherlands, Italy and the whole eAIP
		// cohort.
		//
		// Only the publishers whose flag CHANGED are pushed. Re-pushing
		// them all was affordable at eight and is not at twenty-one:
		// setAirspacePublisher re-sorts and re-stacks every visible
		// polygon. A flag set before the airspace layer is built still
		// lands, since the setters record it and buildAirspaceLayer
		// reconciles every entry against it.
		const want = {} as Record<Publisher, boolean>;
		for (const p of PUBLISHERS) {
			want[p] = layers.publisher[p];
		}
		if (!map) {
			return;
		}
		let airspacesChanged = false;
		for (const p of PUBLISHERS) {
			if (pushedPublisher[p] === want[p]) {
				continue;
			}
			pushedPublisher[p] = want[p];
			setAirspacePublisher(map, p, want[p]);
			setAirportPublisher(p, want[p]);
			setNavaidPublisher(map, p, want[p]);
			setObstaclePublisher(map, p, want[p]);
			airspacesChanged = true;
		}
		if (airspacesChanged) {
			redrawAirspaceDeco(map);
		}
	});

	$effect(() => {
		// ONE selection-highlight fan for every feature kind (the "Selection
		// and hover always highlight" invariant): the switch lives in
		// map/selectionHighlight.ts, incl. the airspace double-call (outline
		// highlight + activation-hatch widening) and the SUP AIP hatch. Each
		// setter draws its feature even with the layer off and no-ops on an
		// unchanged value, so one effect over ui.detail replaces the per-kind
		// ones with identical behaviour.
		syncSelectionHighlight(ui.detail);
	});

	$effect(() => {
		// Lazy-load + toggle the two obstacle categories. A group flipping on
		// triggers the dataset load; the layer is also BUILT (but left detached)
		// as soon as the data is loaded by any path (e.g. a NOTAM panel's
		// "Affected obstacles" list), so selecting / hovering an obstacle row
		// highlights it on the map even with both groups off. syncLayer only
		// attaches the canvas when a group is on or a feature is highlighted.
		const vis = { ...layers.obstacles };
		const loaded = dataState.obstaclesLoaded;
		if (!map) {
			return;
		}
		const anyOn = vis.windturbines || vis.other;
		// Kick off the load when a group is switched on; the build happens on the
		// re-run once `loaded` flips.
		if (anyOn && !loaded) {
			void ensureObstacles().catch(() => {
				/* error is surfaced via dataState.obstaclesError */
			});
			return;
		}
		if (!loaded) {
			return;
		}
		const obstacles = getObstacles();
		if (!obstacles) {
			return;
		}
		buildObstacleLayer(map, obstacles);
		obstaclesBuilt = true;
		setObstacleGroupVisible(map, 'windturbines', vis.windturbines);
		setObstacleGroupVisible(map, 'other', vis.other);
		updateObstaclePane(map);
	});

	$effect(() => {
		// Keep the obstacle cue rings in sync with the active NOTAMs.
		// Reactive on visibleNotams + notamState.tick + obstaclesLoaded
		// via activeNotamsByObstacle(). The build flag is read FIRST and is
		// reactive, so an unbuilt layer costs nothing (the link scan walks
		// the whole briefing) and the effect still re-runs the moment the
		// layer appears.
		if (!map || !obstaclesBuilt) {
			return;
		}
		setObstacleCues(new Set(activeNotamsByObstacle().keys()));
	});

	$effect(() => {
		// Lazy-load + toggle the four navaid groups. A group flipping on triggers
		// the dataset load; the layer is also BUILT (but left detached) as soon as
		// the data is loaded by any path (e.g. a NOTAM panel's "Affected navaids"
		// list), so selecting / hovering a navaid row highlights it on the map
		// even with every group off. syncLayer only attaches the canvas when a
		// group is on or a feature is highlighted.
		const vis = { ...layers.navaids };
		const loaded = dataState.navaidsLoaded;
		if (!map) {
			return;
		}
		const anyOn = vis.navaids || vis.ils || vis.waypoints || vis.reporting;
		// Kick off the load when a group is switched on; the build happens on the
		// re-run once `loaded` flips.
		if (anyOn && !loaded) {
			void ensureNavaids().catch(() => {
				/* error is surfaced via dataState.navaidsError */
			});
			return;
		}
		if (!loaded) {
			return;
		}
		const navaids = getNavaids();
		if (!navaids) {
			return;
		}
		buildNavaidLayer(map, navaids);
		navaidsBuilt = true;
		setNavaidGroupVisible(map, 'navaids', vis.navaids);
		setNavaidGroupVisible(map, 'ils', vis.ils);
		setNavaidGroupVisible(map, 'waypoints', vis.waypoints);
		setNavaidGroupVisible(map, 'reporting', vis.reporting);
		updateNavaidPane(map);
	});

	$effect(() => {
		// Keep the navaid cue rings in sync with the active NOTAMs.
		// Reactive on visibleNotams + notamState.tick + navaidsLoaded via
		// activeNotamsByNavaid(). Build flag first, see the obstacle twin.
		if (!map || !navaidsBuilt) {
			return;
		}
		setNavaidCues(new Set(activeNotamsByNavaid().keys()));
	});

	$effect(() => {
		// Dim / grey the navaids an active NOTAM marks unserviceable.
		// Reactive on visibleNotams + notamState.tick + navaidsLoaded via
		// unserviceableNavaids(). Build flag first, see the obstacle twin.
		if (!map || !navaidsBuilt) {
			return;
		}
		setUnserviceableNavaids(unserviceableNavaids());
	});

	$effect(() => {
		// Lazy-load + toggle the three nature / sensitive-site / bird categories.
		// Built (detached) once loaded so a selection / hover highlights the
		// symbol even with every toggle off.
		const vis = { ...layers.nature };
		const loaded = dataState.natureLoaded;
		if (!map) {
			return;
		}
		const anyOn = vis.nature || vis.sensitive || vis.bird;
		if (anyOn && !loaded) {
			void ensureNature().catch(() => {
				/* error surfaced via dataState.natureError */
			});
			return;
		}
		if (!loaded) {
			return;
		}
		const natures = getNature();
		if (!natures) {
			return;
		}
		buildNatureLayer(map, natures);
		setNatureVisible(map, 'NATURE', vis.nature);
		setNatureVisible(map, 'SENSITIVE', vis.sensitive);
		setNatureVisible(map, 'BIRD', vis.bird);
		updateNaturePane(map);
	});

	$effect(() => {
		// Lazy-load the SUP AIP dataset when the overlay is switched on.
		if (layers.supaip && !dataState.supaipLoaded) {
			void ensureSupaip().catch(() => {
				/* error is surfaced via dataState.supaipError */
			});
		}
	});

	$effect(() => {
		// Also load the SUP AIP dataset when a pasted activation NOTAM references
		// a supplement, so its zones hatch even if the SUP layer was never toggled
		// on (mirrors the airspace overlay loading once a briefing exists).
		// isActiveTrigger is the same gate the NOTAM panel uses for its badge.
		const anyTrigger = visibleNotams().some((it) => isActiveTrigger(it.notam));
		if (anyTrigger && !dataState.supaipLoaded) {
			void ensureSupaip().catch(() => {
				/* error is surfaced via dataState.supaipError */
			});
		}
	});

	$effect(() => {
		// Render the SUP AIP overlay, one feature per named zone. With the
		// toggle on, draw the evaluation-window (per supplement, or per zone
		// where it has its own schedule) / altitude (per zone) filtered set;
		// always add the selected supplement's remaining zones so selecting one
		// from a NOTAM panel highlights it even with the toggle off. That top-up
		// is PER ZONE: the window filters zone by zone, so a supplement can have
		// one season drawn and the other filtered out, and the panel's zone rows
		// select the filtered-out one by index.
		// Reactive on supaipLoaded, the filters, the toggle, the selection.
		void dataState.supaipLoaded;
		if (!map) {
			return;
		}
		const sel = selectedSupaip();
		const selZone = ui.detail?.kind === 'supaip' ? ui.detail.zone : undefined;
		let items = layers.supaip ? visibleSupaipZones() : [];
		if (sel) {
			// Local, intentionally non-reactive index of the selection's drawn zones.
			const drawn = new Set(
				items.filter((it) => it.sup.id === sel.id).map((it) => it.zoneIndex),
			);
			const extra = sel.zones
				.map((zone, zoneIndex) => ({ sup: sel, zoneIndex, zone }))
				.filter((it) => it.zone.geometry !== null && !drawn.has(it.zoneIndex));
			if (extra.length > 0) {
				items = [...items, ...extra];
			}
		}
		syncSupaipLayer(map, items, sel ? { id: sel.id, zone: selZone } : null);
	});

	$effect(() => {
		// Lazy-load the VAC panel georeference when any of its toggles goes
		// on. 130 KB, France only, and useless until one does.
		if ((layers.vac.app || layers.vac.att || layers.vac.gmc) && !vacGeoState.loaded) {
			void ensureVacGeo().catch(() => {
				/* surfaced via vacGeoState.error */
			});
		}
	});

	let vacHeld: string[] = [];
	/** The panels the last selection chose, so a render that lands can be
	 *  painted without choosing again. Plain lets, not state: inputs to the
	 *  next run of these effects and never something to react to. */
	let vacWanted: VacPanel[] = [];
	let vacZoom = 0;
	/** CHOOSING what to draw, debounced like the METAR and wind fetches and
	 *  for the same reason: each panel not already drawn costs a ranged read
	 *  of a 195 MB pack and a pdf.js rasterization, and a pan across France
	 *  must not start one per frame.
	 *
	 *  It must NOT read vacRenderState.gen. Each landing picture bumps that,
	 *  which cleared the pending timer and started a new 400 ms one, so the
	 *  overlay repainted only once rasterising went quiet: over the Paris
	 *  basin, blank for a second and a half while twenty-one sheets redrew
	 *  two at a time. Painting what has landed is the effect below. */
	$effect(() => {
		const m = mapState.map;
		void mapState.zoom;
		void mapState.center;
		void layers.vac.app;
		void layers.vac.att;
		void layers.vac.gmc;
		void vacGeoState.loaded;
		// A pack landing, going or being promoted changes what a plate's
		// bytes are under a file name that did not move, so the documents
		// and the pictures drawn from them are dropped here rather than
		// merely re-read.
		syncDocPacks(offlineDocs.gen);
		if (!m) {
			return;
		}
		const kinds = vacKinds();
		const timer = setTimeout(() => drawVacPanels(kinds), 400);
		return () => clearTimeout(timer);
	});

	/** Choose and paint, at once. The debounced effect above calls it on a
	 *  move; pinning a chart calls it directly, because a gesture aimed at a
	 *  chart must answer now and not in four hundred milliseconds. */
	function drawVacPanels(kinds: VacPanelKind[]): void {
		{
			const mm = mapState.map;
			if (!mm) {
				return;
			}
			buildVacPanelLayer(mm);
			if (kinds.length === 0) {
				beginPanelPass();
				setVacPanelData([]);
				syncVacPanelLayer(mm, false);
				return;
			}
			const b = mm.getBounds();
			const zoom = mm.getZoom();
			const dpr = window.devicePixelRatio || 1;
			const wanted = vacPanelsIn(
				{
					south: b.getSouth(),
					west: b.getWest(),
					north: b.getNorth(),
					east: b.getEast(),
				},
				kinds,
				zoom,
				panelNativeZoom,
				vacHeld,
				{
					costOf: (p) => panelBitmapBytes(p, zoom, dpr),
					budget: PANEL_BITMAP_BUDGET,
					pinned: leadingChart(),
				},
			);
			// The pin lets go when the selection could not honour it, which
			// covers out of view and below the legibility floor in one
			// test, and keeps it from becoming a mode to be remembered and
			// undone. Notifying here re-runs the effect below once, which
			// settles at once since the pin is then null.
			//
			// Only while nothing is being previewed: a preview that cannot
			// be honoured says nothing about the pin underneath it, and
			// pointing at a row must not throw away what was pinned.
			if (
				vacPin.preview === null &&
				vacPin.ident !== null &&
				wanted[0]?.ident !== vacPin.ident
			) {
				clearVacPin();
			}
			// The aerodromes drawn, remembered for the next move so panning
			// across a chart cannot swap it for a neighbour's, nor drop one
			// at the far edge of the budget. A plain let, not state: it is
			// an input to the next run of this effect and never something
			// to react to.
			vacHeld = [...new Set(wanted.map((p) => p.ident))];
			vacWanted = wanted;
			vacZoom = zoom;
			beginPanelPass();
			setVacPanelData(
				wanted.map((panel) => ({
					panel,
					canvas: renderedPanel(panel, panelScaleFor(panel, zoom, dpr))?.canvas ?? null,
					pinned: panel.ident === leadingChart(),
				})),
			);
			syncVacPanelLayer(mm, true);
		}
	}

	/** The kinds the Layers tab has on, in the order the stack wants them. */
	function vacKinds(): VacPanelKind[] {
		const kinds: VacPanelKind[] = [];
		if (layers.vac.app) {
			kinds.push('APP');
		}
		if (layers.vac.att) {
			kinds.push('ATT');
		}
		if (layers.vac.gmc) {
			kinds.push('GMC');
		}
		return kinds;
	}

	/** A pin is direct manipulation, so it answers now rather than after the
	 *  four hundred milliseconds the move debounce is for. */
	$effect(() => {
		void vacPin.ident;
		void vacPin.preview;
		if (mapState.map) {
			drawVacPanels(vacKinds());
		}
	});

	/** PAINTING what has landed, undebounced: a picture arriving is not a
	 *  reason to choose again, only to draw. syncVacPanelLayer rather than
	 *  redrawVacPanels, since the layer is off the map while nothing it
	 *  holds has a bitmap. beginPanelPass is deliberately not called: this
	 *  is the same pass, and re-marking it would let eviction drop what is
	 *  on screen. */
	$effect(() => {
		void vacRenderState.gen;
		const mm = mapState.map;
		if (!mm || vacWanted.length === 0) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		setVacPanelData(
			vacWanted.map((panel) => ({
				panel,
				canvas: renderedPanel(panel, panelScaleFor(panel, vacZoom, dpr))?.canvas ?? null,
				pinned: panel.ident === leadingChart(),
			})),
		);
		syncVacPanelLayer(mm, true);
	});

	$effect(() => {
		// Fetch the worldwide SIGMET set while the layer is on, the Weather
		// tab lists it, or a sigmet panel is open; the minute tick is the
		// auto-refresh pulse and the ensure paces itself by its 5 min TTL
		// (failures stamped). seq re-runs us after a manual Refresh.
		void notamState.tick;
		void sigmets.showOnMap;
		void sigmets.tabOpen;
		void sigmets.seq;
		void display.liveWeather;
		void ui.detail;
		ensureSigmets();
	});

	$effect(() => {
		// Render the SIGMET overlay: the validity / altitude filtered set
		// with the toggle on; the selected advisory always draws so a panel
		// link shows its area with the layer off. Reactive on the fetch seq
		// (via visibleSigmets), the filters, the toggle, the selection and
		// the airspace dataset (FIR-wide fallbacks resolve through it).
		if (!map) {
			return;
		}
		const sel = selectedSigmet();
		const items: SigmetDrawItem[] = (
			sigmets.showOnMap && display.liveWeather ? visibleSigmets() : []
		).map((s) => ({ sigmet: s, rings: sigmetRings(s) }));
		if (sel && !items.some((it) => it.sigmet.id === sel.id)) {
			items.push({ sigmet: sel, rings: sigmetRings(sel) });
		}
		syncSigmetLayer(map, items, sel?.id ?? null);
	});

	$effect(() => {
		// Push the global altitude filter through to the airspace overlay.
		const band = activeAltitudeBand();
		if (map) {
			setAirspaceAltitudeFilter(map, band);
			redrawAirspaceDeco(map);
		}
	});

	$effect(() => {
		// Designator labels on airspaces (the Layers-tab toggle); the setter
		// repaints the decoration canvas itself.
		setAirspaceLabelsVisible(layers.airspaceLabels);
	});

	$effect(() => {
		// Optional "Show only route airspaces" map filter: when on, show only the
		// airspaces ANY route flies THROUGH at its planned per-leg altitude (all
		// categories, every route and not just the active one) and hide the rest;
		// when off, the Layers-tab category toggles govern. Tracks the toggle, every
		// route + its waypoint coords AND per-leg altitudes (read via
		// routesAirspaceKeysAtAltitude) plus the default altitude, so it updates live
		// on any route's edits; airspacesBuilt gates it until the layer exists.
		// Terrain per route (the shared routeTerrain cache) makes AGL/ASFC zones
		// test exactly; the filter is conservative until samples land, then
		// tightens (routeTerrainSamples is a tracked read).
		const on = routeSettings.airspacesOnRouteOnly;
		const routed = routes.list.filter((r) => r.waypoints.length >= 2);
		void dataState.airspacesLoaded;
		if (!map || !airspacesBuilt) {
			return;
		}
		const all = on && routed.length > 0 ? getAirspaces() : null;
		if (!all) {
			setRouteAirspaceFilter(map, null);
			redrawAirspaceDeco(map);
			return;
		}
		for (const r of routed) {
			ensureRouteTerrain(r.id, r.waypoints);
		}
		pruneRouteTerrain(routes.list.map((r) => r.id));
		setRouteAirspaceFilter(
			map,
			routesAirspaceKeysAtAltitude(
				routed.map((r) => r.waypoints),
				all,
				routeSettings.defaultAltitudeFt,
				routed.map((r) => routeTerrainSamples(r.id, r.waypoints)),
			),
		);
		redrawAirspaceDeco(map);
	});

	$effect(() => {
		// Hatch the airspaces currently activated by a loaded NOTAM. The
		// activatedAirspaceLinks() derivation reads notamState.notams,
		// .tick and the loaded airspaces, so this effect re-runs whenever
		// any of them changes (including the 60-second tick).
		const activated = activatedAirspaceLinks();
		// The shared by-id index (notamLinks builds it once per dataset
		// array): this effect re-runs on every minute tick in `now` mode,
		// and rebuilding a ten-thousand-row Map per tick was the very
		// pattern the memo pass removed from the activation extract.
		const byId = airspaceIdIndex();
		if (!map || !byId) {
			return;
		}
		renderActivations(map, activated, byId);
	});

	$effect(() => {
		// Hatch the SUP AIP zones currently activated by a loaded NOTAM. Like the
		// airspace activation overlay this never reads layers.supaip, so a zone
		// hatches even with the SUP layer off, only while its activating NOTAM is
		// active in the current eval window (supZoneActivations time-gates).
		const activated = supZoneActivations();
		const all = getSupaips();
		if (!map || !all) {
			return;
		}
		// Local supZoneKey -> zone index; the initializer form isn't flagged by
		// the prefer-svelte-reactivity rule (cf. the airspace byId above).
		const zonesByKey = new Map<string, SupAipZone>(
			all.flatMap((s) =>
				s.zones.map((zone, i) => [supZoneKey(s.id, i), zone] as [string, SupAipZone]),
			),
		);
		renderSupActivations(map, activated, zonesByKey);
	});

	$effect(() => {
		// Reverse-sync the route overlay (one coloured polyline per route, plus
		// the active route's draggable waypoint markers) whenever any route's
		// waypoints, selection, or the active route changes. Reading mapState.map
		// makes this re-run once the map is created; touching each waypoint's
		// lat/lon/kind makes a drag-commit or a re-anchor re-run it. syncRoutes is
		// a keyed diff and bails while a drag owns the DOM (see routeLayer).
		const m = mapState.map;
		void routes.activeId;
		for (const r of routes.list) {
			void r.id;
			void r.selectedWaypointId;
			void r.alternate;
			void r.waypoints.length;
			for (const w of r.waypoints) {
				void w.lat;
				void w.lon;
				void w.kind;
			}
		}
		if (m) {
			syncRoutes(m, routes.list, routes.activeId);
		}
	});

	$effect(() => {
		// Draw the leg being pointed at, from either surface (the Route tab's leg
		// row or this map's own hover). highlightLeg reads the active route, so
		// touching each waypoint's position here is what redraws the segment when
		// the geometry under a resting pointer moves (a pin dropped, a row
		// reordered); it validates the id itself and draws nothing for a leg the
		// route no longer has.
		void mapState.map;
		void routes.activeId;
		for (const w of activeRoute().waypoints) {
			void w.lat;
			void w.lon;
		}
		highlightLeg(legHover.leg?.fromId ?? null);
	});

	$effect(() => {
		// Preview the active route's NOTAM-fetch corridor while the corridor-width
		// field is focused. Reads the trigger + width (corridorPreview / radius),
		// mapState.zoom (the band weight is in pixels, so it recomputes on zoom), and
		// the active route's waypoints (so it tracks edits / re-anchors / activation).
		// The band is interactive:false and never blocks clicks (see routeCorridorLayer).
		const m = mapState.map;
		const show = routeSettings.corridorPreview;
		const radiusNM = routeSettings.corridorRadiusNM;
		void mapState.zoom;
		void routes.activeId;
		// Colour via the resolver so an active alternate gets its trip's hue;
		// reading each route's alternate flag here also re-runs this on a toggle.
		const colors = routeColorMap(routes.list);
		const wps = activeRoute().waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
		if (m) {
			syncCorridor(m, wps, radiusNM, colors.get(routes.activeId) ?? routeColor(0), show);
		}
	});

	$effect(() => {
		// Preview the active route's minimum-altitude (MSA) corridor while the MSA
		// corridor-width field is focused. Mirrors the NOTAM-corridor effect above:
		// reads the trigger + half-width, mapState.zoom (band weight is in pixels) and
		// the active route's waypoints, so it tracks edits / steps / zoom. The band is
		// a fixed amber and interactive:false (see minAltCorridorLayer).
		const m = mapState.map;
		const show = routeSettings.minAltCorridorPreview;
		const halfWidthNM = routeSettings.minAltCorridorRadiusNM;
		void mapState.zoom;
		void routes.activeId;
		const wps = activeRoute().waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
		if (m) {
			syncMinAltCorridor(m, wps, halfWidthNM, show);
		}
	});

	$effect(() => {
		// Highlight the active route's minimum-altitude corridor cells whose
		// terrain / obstacle MSA (+ the flight-rules margin, per leg via
		// msaMarginForTerrainFt: 2000 ft IFR over mountainous legs) tops
		// the planned leg altitude, i.e. exactly where flying the planned level
		// busts the clearance floor. Tracks the toggle, the corridor half-width,
		// the VFR/IFR flag (the margin), every waypoint's lat/lon AND alt (so
		// altitude edits recompute) and the obstacle-loaded flag, but NOT
		// mapState.zoom: the cells are geographic and the canvas layer re-projects
		// itself on pan / zoom.
		const m = mapState.map;
		const on = routeSettings.minAltDangerOn;
		const halfWidthNM = routeSettings.minAltCorridorRadiusNM;
		const vfr = routeSettings.vfr;
		void routes.activeId;
		// Obstacles refine the result but must NOT gate it: terrain alone drives
		// most cells, so draw with whatever is loaded now and recompute once the
		// dataset arrives (this flag re-runs the effect), rather than blocking the
		// whole overlay on the multi-MB obstacle load.
		void dataState.obstaclesLoaded;
		const wps = activeRoute().waypoints.map((w) => ({ lat: w.lat, lon: w.lon, alt: w.alt }));
		if (!m) {
			return;
		}
		if (!on || wps.length < 2) {
			syncMinAltDanger(m, []);
			return;
		}
		// Kick the lazy load; obstaclesLoaded re-runs us when ready.
		void ensureObstacles().catch(() => {
			/* error is surfaced via dataState.obstaclesError */
		});
		const obstacles = getObstacles() ?? [];
		// Abort a superseded run so a late terrain batch can't paint stale cells.
		const ctrl = new AbortController();
		void computeMinAltDangerCells(wps, obstacles, { halfWidthNM, vfr, signal: ctrl.signal })
			.then((cells) => {
				if (!ctrl.signal.aborted && mapState.map) {
					syncMinAltDanger(mapState.map, cells);
				}
			})
			.catch(() => {
				/* terrain fetch failed; leave the overlay as-is */
			});
		return () => ctrl.abort();
	});

	$effect(() => {
		// Winds-aloft lattice fetch: tracks the view (mapState.zoom / center;
		// live bounds are read in the callback) and the Weather panel's inputs,
		// debounced so a pan settles before one batched Open-Meteo request
		// fires. Reads inside the timeout are untracked by design, so the void
		// list here IS the dependency list. ensureWindGrid gates itself on
		// showOnMap + display.liveWeather (aborting and idling when hidden),
		// which keeps this effect unconditional. The minute tick is the
		// auto-refresh pulse: the ensure no-ops until its 15 min TTL (and
		// stands down while a rate-limit retry is pending).
		const m = mapState.map;
		void mapState.zoom;
		void mapState.center;
		void windAloft.model;
		void windAloft.levelFt;
		void windAloft.isotherm0;
		void windAloft.isobars;
		void windAloft.showOnMap;
		void windAloft.animating;
		void windAloft.validTimeMs;
		void windGrid.retrySeq;
		void display.liveWeather;
		void notamState.tick;
		if (!m) {
			return;
		}
		const t = setTimeout(() => {
			const mm = mapState.map;
			if (!mm) {
				return;
			}
			const b = mm.getBounds();
			ensureWindGrid({
				west: b.getWest(),
				south: b.getSouth(),
				east: b.getEast(),
				north: b.getNorth(),
				degPerPx: (b.getEast() - b.getWest()) / Math.max(1, mm.getSize().x),
				centerLat: mm.getCenter().lat,
				centerLon: mm.getCenter().lng,
			});
		}, 500);
		return () => clearTimeout(t);
	});

	$effect(() => {
		// Feed the wind canvas. windGridBarbs / windGridIsotherm are tracked
		// reads (they follow the lattice cache, the level and the valid time),
		// so animation frames repaint from the fetched columns with no network.
		const m = mapState.map;
		const on = windAloft.showOnMap && display.liveWeather;
		const barbs = on ? windGridBarbs() : [];
		const iso = on ? windGridIsotherm() : [];
		if (!m) {
			return;
		}
		buildWindLayer(m);
		setWindData({
			barbs,
			isoLines: iso,
			isoLabel: windIsothermLabel(),
			isobars: on ? windGridIsobars() : [],
		});
		syncWindLayer(m, on);
	});

	$effect(() => {
		// The recorded / imported navigation track polyline. Reads the array (so a
		// live recording extends it); the show-trace toggle gates it.
		const m = mapState.map;
		const pts = nav.points;
		const show = nav.showTrace;
		if (!m) {
			return;
		}
		syncNavTrace(m, pts, show);
	});

	$effect(() => {
		// The aircraft marker at the live tip (recording) or the replay playhead,
		// rotated to track and followed when asked. Must NOT read
		// mapState.center/zoom: the follow panTo fires moveend, which writes
		// them, so a read here would self-loop.
		const m = mapState.map;
		const pose = currentPose();
		const kind = nav.iconKind;
		const follow = nav.follow;
		const quality = positionQuality();
		// Read here so a locale switch re-stamps the recentre tooltip.
		const recenterLabel = t.navigation.recenter;
		if (!m) {
			return;
		}
		syncNavAircraft(m, pose, kind, follow, quality, recenterLabel);
	});

	$effect(() => {
		// Trajectory vector at the current point whenever the toggle is on and a
		// pose exists: the live tip while recording, else the replay / pinned
		// playhead. Motion is the time-weighted velocity at nav.playheadMs, which
		// ingestFix pins to the live tip and replay/scrub set directly, so one
		// causal call serves both. Same no-center/zoom-read rule as the aircraft
		// effect.
		// A dead-reckoned vector off a fix that has stopped arriving is the most
		// misleading thing that can be on the screen, so a lost position clears
		// it outright rather than projecting from where the aircraft last was.
		const m = mapState.map;
		const pose = currentPose();
		const on = nav.vector && pose != null && positionQuality() !== 'lost';
		const motion = on ? smoothedMotionAt(nav.points, nav.playheadMs) : null;
		if (!m) {
			return;
		}
		syncNavVector(m, pose, motion, on);
	});

	$effect(() => {
		// Live-navigation data: the airspaces and the route terrain the
		// schedule walk refines AGL limits with, ensured per route change,
		// never per pose (the heavy walk stays keyed on geometry). Gated on
		// the route alone, like the live layer itself: the tab readout and
		// the live schedule need the dataset whether or not the map clones
		// are on. The load error surfaces through dataState.airspacesError in
		// the Navigation tab, so a rejection here is deliberately swallowed.
		const r = routes.list.find((x) => x.id === navRouteId()) ?? activeRoute();
		if (r.waypoints.length < 2) {
			return;
		}
		void ensureAirspaces().catch(() => {});
		ensureRouteTerrain(r.id, r.waypoints);
	});

	$effect(() => {
		// The alert evaluator answers route or no route (docs/nav-alerts.md),
		// so its volume datasets load on the pose alone; the route-gated
		// ensure above covers only planned flights. Same swallowed-rejection
		// posture: the error surfaces through dataState in the tab.
		if (!alertPrefs.enabled || !currentPose()) {
			return;
		}
		void ensureAirspaces().catch(() => {});
		void ensureSupaip().catch(() => {});
	});

	$effect(() => {
		// The active route follows the leg being flown, until the user pages
		// elsewhere (docs/nav-live.md). It lives here because the module is
		// where every other navigation effect lives; the rule itself is in
		// state/navRoute.
		followNavRoute();
	});

	$effect(() => {
		// The current / next airspace-to-contact emphasis at the along-route
		// position (state/navLive resolves it; null clears both clones, so
		// turning either toggle off empties navContactKeys() too). Same
		// no-center/zoom-read rule as the aircraft effect.
		const m = mapState.map;
		const info = nav.contactMap ? navLiveNow() : null;
		// Only an airspace unit has a polygon to clone; the two aerodromes of
		// the contact chain carry a null key.
		const curKey = info?.contact?.current?.key ?? null;
		const nxtKey = info?.contact?.next?.key ?? null;
		const cur = curKey != null ? airspaceByKey(curKey) : null;
		const nxt = nxtKey != null ? airspaceByKey(nxtKey) : null;
		if (!m) {
			return;
		}
		syncNavContact(m, cur, nxt);
	});

	$effect(() => {
		// The live airspace-alert emphasis at the aircraft position
		// (state/airspaceAlert resolves it; null clears every clone). Same
		// no-center/zoom-read rule as the aircraft effect.
		const m = mapState.map;
		const info = airspaceAlerts();
		if (!m) {
			return;
		}
		syncNavAlerts(m, info ? drawableAlerts(info.alerts, info.dominant) : null);
	});

	$effect(() => {
		// The attention channel: sound edges drained from the state-owned
		// queue, live only (a replay debrief stays visual). The queue hands
		// each edge to exactly one drain however many surfaces read
		// airspaceAlerts(), and the drain runs armed or not so an audio-off
		// session cannot stockpile stale chimes. A persisted-on channel
		// re-arms on the first gesture after a reload.
		void airspaceAlerts();
		if (!nav.recording) {
			return;
		}
		const fires = drainAlertFires();
		if (!alertPrefs.audio) {
			return;
		}
		armAlertAudioOnGesture();
		playAlertFireList(fires, { caution: alertPrefs.audioCaution });
	});

	$effect(() => {
		// Progress over the WHOLE plan: every route already completed draws
		// wholly flown, and the one being flown is cut at the aircraft, its
		// remainder carrying the route's own colour drawn heavy (the ForeFlight
		// / SkyDemon convention). A plan of consecutive routes is one flight, so
		// it reads at a glance rather than one route at a time. Cleared whenever
		// there is no live position to cut at, so a plain planning session sees
		// the ordinary route line. Same no-center/zoom-read rule as the aircraft
		// effect.
		const m = mapState.map;
		const info = navLiveNow();
		const st = info?.log.state;
		const segs = navSegments();
		const flownId = navRouteId();
		const byId = new Map(routes.list.map((r) => [r.id, r]));
		const completed: [number, number][][] = [];
		for (const s of segs) {
			const r = s.toIdx != null && s.routeId !== flownId ? byId.get(s.routeId) : undefined;
			if (r) {
				completed.push(r.waypoints.map((w): [number, number] => [w.lat, w.lon]));
			}
		}
		const flying = byId.get(flownId);
		const split =
			st != null && flying != null && st.distNM != null && st.currentLegIdx != null && !st.arrived
				? splitRouteAtNM(flying.waypoints, st.distNM)
				: null;
		// An arrived route is complete like the ones behind it.
		if (!split && st?.arrived === true && flying) {
			completed.push(flying.waypoints.map((w): [number, number] => [w.lat, w.lon]));
		}
		const hue = routeColorMap(routes.list).get(flownId) ?? null;
		if (!m) {
			return;
		}
		syncRouteProgress(m, {
			completed,
			current: split && hue ? { split, color: hue } : null,
		});
	});

	$effect(() => {
		// The draggable point the map altitude profile is taken over. It is up
		// only while that surface is: the state's point getter is gated on
		// open-ness, so an eviction or a reflow close takes the marker with it.
		// The drag writes straight back to the surface's own state, and reading
		// the tooltip here re-stamps it on a locale switch (Leaflet bakes icon
		// options at creation). Must NOT read mapState.center/zoom: the marker's
		// autoPan fires moveend, which writes them, so a read would self-loop
		// (the aircraft effect's rule).
		const m = mapState.map;
		const point = mapProfileModal.point;
		const title = t.map.profilePoint;
		if (!m) {
			return;
		}
		syncProfilePoint(m, point, title);
	});

	$effect(() => {
		// METAR stations: debounced viewport ensure (the wind lattice's twin).
		// The minute tick re-arms the debounce once a minute on purpose: it is
		// the auto-refresh pulse, and the ensure refetches only tiles past
		// their 5 min TTL (failures are stamped into the cache at the same
		// cadence). Gates itself on showOnMap + display.liveWeather.
		const m = mapState.map;
		void mapState.zoom;
		void mapState.center;
		void metarStations.showOnMap;
		void metarStations.seq;
		void display.liveWeather;
		void notamState.tick;
		if (!m) {
			return;
		}
		const t = setTimeout(() => {
			const mm = mapState.map;
			if (!mm) {
				return;
			}
			const b = mm.getBounds();
			ensureMetarStations({
				west: b.getWest(),
				south: b.getSouth(),
				east: b.getEast(),
				north: b.getNorth(),
			});
		}, 500);
		return () => clearTimeout(t);
	});

	$effect(() => {
		// Feed the METAR canvas; the gated read keeps a hidden layer free
		// (stationFeed tracks tile arrivals and the minute tick for ages).
		const m = mapState.map;
		const on = metarStations.showOnMap && display.liveWeather;
		const stations = on ? stationFeed() : [];
		if (!m) {
			return;
		}
		buildMetarLayer(m);
		setMetarData(stations);
		syncMetarLayer(m, on);
	});

	$effect(() => {
		// Keep the model-run provenance fresh for the model in view / in use
		// (the Weather tab's status line and the nav-log tooltips read it).
		// Only once a wind feature is actually live: barbs on, or forecast
		// legs with a routed route; an idle load stays network-silent. The
		// minute tick re-checks the run every RUN_TTL; a detected new cycle
		// invalidates the lattice and the route winds (windAloft.svelte.ts).
		const wanted =
			windAloft.showOnMap ||
			(windAloft.useForecastForLegs && routes.list.some((r) => r.waypoints.length >= 2));
		if (!wanted) {
			return;
		}
		void display.liveWeather;
		void notamState.tick;
		ensureModelRun(effectiveWindModel(mapState.center.lat, mapState.center.lng));
	});

	$effect(() => {
		// Warm the per-route forecast winds for EVERY route (max 6): the
		// nav-log sheets self-ensure too, but the fuel plan and the dossier
		// need leg winds with no sheet rendered. ensureRouteWindFor tracks the
		// departure chain (dossier ETD, ground stops, the panel time) through
		// its own reads; each waypoint's coords are touched here so drags
		// re-run us. It gates itself off (and aborts) while live weather or
		// forecast legs are disabled. retrySeq re-runs us after a rate limit;
		// the minute tick is the auto-refresh pulse (TTL-paced inside the
		// ensure, which also subscribes us to new-run detection).
		void routeWind.retrySeq;
		void notamState.tick;
		for (const r of routes.list) {
			for (const w of r.waypoints) {
				void w.lat;
				void w.lon;
			}
			if (r.waypoints.length >= 2) {
				void ensureRouteWindFor(r);
			}
		}
		pruneRouteWind(routes.list.map((r) => r.id));
	});

	$effect(() => {
		// In edit mode, ensure the airport + navaid spatial indexes exist so
		// waypoint snapping works even when those layers are toggled off. Building
		// an index does not force its canvas visible (the layers stay detached
		// until a group is on or a feature is highlighted).
		if (!routeSettings.editMode) {
			return;
		}
		if (!mapState.map) {
			return;
		}
		void ensureAirports()
			.then((a) => {
				if (mapState.map) {
					ensureAirportIndex(mapState.map, a);
				}
			})
			.catch(() => {
				/* error surfaced via dataState.airportsError */
			});
		void ensureNavaids()
			.then((n) => {
				if (mapState.map) {
					buildNavaidLayer(mapState.map, n);
				}
			})
			.catch(() => {
				/* error surfaced via dataState.navaidsError */
			});
	});

	/** Route keyboard shortcuts, all skipped while the user is typing in a field so
	 *  the route-builder text inputs / nav-log notes keep their native edit + undo:
	 *  Ctrl/Cmd-Z undoes a route action, Ctrl/Cmd-Shift-Z (or Ctrl/Cmd-Y) redoes,
	 *  Delete / Backspace removes the selected waypoint. */
	function onKeydown(e: KeyboardEvent): void {
		const t = e.target as HTMLElement | null;
		const inField =
			!!t &&
			(t.tagName === 'INPUT' ||
				t.tagName === 'TEXTAREA' ||
				t.tagName === 'SELECT' ||
				t.isContentEditable);

		if ((e.ctrlKey || e.metaKey) && !e.altKey) {
			const k = e.key.toLowerCase();
			if (k === 'z' || k === 'y') {
				if (inField) {
					return; // let the field's native undo handle it
				}
				const did = k === 'y' || e.shiftKey ? redoRoute() : undoRoute();
				if (did) {
					e.preventDefault();
				}
				return;
			}
		}

		if (e.key !== 'Delete' && e.key !== 'Backspace') {
			return;
		}
		if (inField) {
			return;
		}
		const selectedId = activeRoute().selectedWaypointId;
		if (!selectedId) {
			return;
		}
		e.preventDefault();
		removeWaypoint(selectedId);
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svg class="hatch-defs" aria-hidden="true" focusable="false">
	<defs>
		<!-- Diagonal-hatch fills referenced by activationLayer.ts's
			 polygons via fill="url(#hatch-<category>)", generated from the
			 palette's ACTIVATION_HATCH_FILL so every category resolves to a
			 real pattern. Each category mirrors the underlying airspace
			 colour so the overlay reads as "this same airspace, activated"
			 rather than a foreign visual. Stripe width (3) and tile size
			 (8 with a 45° rotate) yield a clearly-spaced hatch that doesn't
			 moiré at typical zoom levels. -->
		{#each Object.entries(ACTIVATION_HATCH_FILL) as [cat, fill] (cat)}
			<pattern id="hatch-{cat}" patternUnits="userSpaceOnUse"
					 width="8" height="8" patternTransform="rotate(45)">
				<rect width="3" height="8" {fill} />
			</pattern>
		{/each}
		<!-- SUP AIP activated-zone hatch (supaipActivationLayer.ts). Magenta
			 to match the base SUP AIP overlay's #c2185b identity (app
			 identity, deliberately not a palette entry). -->
		<pattern id="hatch-supaip" patternUnits="userSpaceOnUse"
				 width="8" height="8" patternTransform="rotate(45)">
			<rect width="3" height="8" fill="#c2185b" />
		</pattern>
	</defs>
</svg>

<div class="map-wrap">
	<div class="map" bind:this={container}></div>
	{#if windTip}
		<div
			class="wind-tip"
			class:flip={windTip.flip}
			style:left={`${windTip.x}px`}
			style:top={`${windTip.y}px`}
		>
			{#each windTip.station ? stationTipLines(windTip.station) : windTip.barb ? barbTipLines(windTip.barb, t.weather.barb) : [] as line, i (i)}
				<div>{line}</div>
			{/each}
		</div>
	{/if}
	<CursorCoords coord={hoveredCoord} elevFt={cursorElevation.ft} />
	<!-- The in-flight strip rides over the map rather than beside it: no
	     layout change, so no Leaflet resize, and it survives every tab
	     selection and dock the workspace can put up (docs/nav-live.md). -->
	<NavStrip />
</div>

<style>
	/* A flex child of .stage-main, which is a row inside the stage column, so
	   the height comes from the stretch rather than a percentage: a bottom
	   dock has to be able to take part of it. */
	.map-wrap {
		position: relative;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	/* The strip publishes its own height here (NavStrip's resize observer), so
	   the Leaflet controls step clear of the band instead of sitting under it.
	   Absent, the fallback is zero and nothing moves. */
	:global(.map-wrap .leaflet-top) {
		padding-top: var(--nav-strip-h, 0);
	}

	.map {
		width: 100%;
		height: 100%;

		/* Long-press opens our context menu, not the browser text-selection
		   callout. Scoped to the map so copy affordances elsewhere (NavLog
		   cells, SUP AIP text) keep working. */
		-webkit-touch-callout: none;
		user-select: none;
	}

	/* Wind-barb hover readout: a pointer-inert badge riding the cursor
	   (offset clear of it; flipped left near the right edge). Sits above
	   the Leaflet panes but below the sidebar (z 500). */
	.wind-tip {
		position: absolute;
		z-index: 460;
		margin: 14px 0 0 14px;
		padding: 5px 8px;
		font-size: 12px;
		line-height: 1.35;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
		pointer-events: none;
		white-space: nowrap;
	}

	.wind-tip.flip {
		transform: translateX(calc(-100% - 28px));
	}

	/* Inline SVG that defines hatch <pattern>s for the activation overlay.
	   Kept at zero size + absolutely positioned so the page never paints it
	   directly, but the pattern ids are reachable by url(#hatch-…) fills
	   anywhere on the page (Leaflet's SVG polygons cross SVG element
	   boundaries when resolving fill URLs by id). */
	.hatch-defs {
		position: absolute;
		width: 0;
		height: 0;
		pointer-events: none;
	}

	:global(.leaflet-container) {
		background: var(--surface-2);
		font: inherit;
		overscroll-behavior: none;
	}

	/* On phones the on-map attribution overlaps the bottom sheet's tab bar;
	   hide it there. The credit is preserved in the About modal (Map data),
	   reachable via the toolbar's More menu. Desktop keeps the on-map credit.
	   (mobile-ui: App.svelte's root class, THE breakpoint definition.) */
	:global(:root.mobile-ui .leaflet-control-attribution) {
		display: none;
	}

	/* Route waypoint markers and the altitude profile's point: strip the default
	   divIcon box; show a grab cursor since they're draggable. */
	:global(.route-pin),
	:global(.profile-pin) {
		background: transparent;
		border: none;
		cursor: grab;
	}

	:global(.route-pin:active),
	:global(.profile-pin:active) {
		cursor: grabbing;
	}

	/* A waypoint list is pointing at this pin (highlightWaypoint, set from the
	   nav log's ident cells and the Route tab's rows): the pin lifts off the
	   chart, the .notam-pin--selected treatment in app.css. The transform
	   targets the inner SVG so Leaflet's translate-positioning on the container
	   survives, and scales about the middle because the disc's anchor is its
	   centre. The z-index bump beats an overlapping sibling inside the
	   route-markers pane, where an out-and-back route stacks two pins on one
	   point; !important because Leaflet writes a latitude-derived z-index
	   inline on every marker. No transition: setIcon rebuilds the inner <svg>
	   on every route sync, so a freshly inserted element cannot animate from a
	   previous value, and an instant pop is what a hover flash wants. */
	:global(.route-pin--hl) {
		z-index: 700 !important;
	}

	:global(.route-pin--hl > svg) {
		transform: scale(1.3);
		filter: drop-shadow(0 2px 4px rgb(0 0 0 / 45%));
	}

	/* Night dimming is a property of the NIGHT THEME itself, manual or
	   automatic alike (docs/nav-live.md "In-flight ergonomics"): the
	   RASTER tiles dim behind the Display-tab intensity. Three pane
	   families carry raster: the base tilePane, the chart-stack panes
	   (chart-<id>, class leaflet-chart-<id>-pane) and the VAC panels
	   drawn from the plates themselves; every other pane is vector or
	   canvas symbology and keeps full contrast, which is the point: the
	   white raster is what destroys night vision, and a VAC sheet is the
	   whitest thing the map can show. The filter
	   sits on the panes, never .leaflet-container (a filter makes it the
	   containing block). App.svelte publishes --night-dim. */
	:global([data-theme='night'] .leaflet-tile-pane),
	:global([data-theme='night'] .leaflet-vac-panels-pane),
	:global([data-theme='night'] [class*='leaflet-chart-']) {
		filter: brightness(var(--night-dim, 0.7));
	}

	/* Theme Leaflet's own controls for night mode. */
	:global([data-theme="night"] .leaflet-bar a) {
		background: var(--surface);
		color: var(--text);
		border-bottom-color: var(--border);
	}

	:global([data-theme="night"] .leaflet-bar a:hover) {
		background: var(--surface-3);
	}

	:global([data-theme="night"] .leaflet-control-attribution) {
		background: rgb(20 24 30 / 85%);
		color: var(--text-muted);
	}

	:global([data-theme="night"] .leaflet-control-attribution a) {
		color: var(--accent);
	}
</style>
