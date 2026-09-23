<script lang="ts">
	/* The NOTAM Viewer's map.
	 *
	 * A second composition over the SAME layer modules the flight app uses, not
	 * a second set of layers: map/notamLayer.ts, map/airspaceLayer.ts and the
	 * rest are shared whole, and so is the hit-test RULE (map/areaRank.ts). What
	 * differs is what is on the map, which is the app.
	 *
	 * Why a second component rather than a shared core: MapView.svelte's own
	 * onMount owns every pane and every teardown, and map/airspaceLayer.ts:617
	 * documents a lockstep between the boundary layer and its decoration that
	 * holds "by construction, since buildAirspaceLayer registers its viewport
	 * handler before MapView builds the decoration layer" - i.e. by declaration
	 * order inside ONE component. Splitting that into a parent and a child
	 * reorders the effects and invalidates the one subsystem with a written
	 * lockstep rule, in the flight app's most load-bearing file.
	 *
	 * One deliberate divergence from MapView, and it is the reason this app can
	 * take a world briefing: the publishers forced into the coverage gate follow
	 * the SELECTION, not the whole briefing. See the effect below.
	 */
	import { onMount } from 'svelte';
	import L from 'leaflet';
	import 'leaflet/dist/leaflet.css';
	import { baseLayerDef } from '$lib/map/baseLayers';
	import { armAttributionCredit } from '$lib/map/attributionCredit';
	import HatchDefs from '$lib/components/HatchDefs.svelte';
	import {
		buildAirspaceLayer,
		clearAirspaceLayer,
		setAirspaceAltitudeFilter,
		setAirspaceCategory,
		updateAirspaceViewport,
		CATEGORIES,
	} from '$lib/map/airspaceLayer';
	import {
		buildAirspaceDecoLayer,
		redrawAirspaceDeco,
		setAirspaceLabelsVisible,
	} from '$lib/map/airspaceDecoLayer';
	import {
		clearAirports,
		hideAirports,
		setAirportCues,
		setAirportClosedByNotam,
		setAirportType,
		showAirports,
		updateAirportPane,
	} from '$lib/map/airportLayer';
	import { clearNotamLayer, fitToNotams, renderNotams, setQlineRadiusVisible } from '$lib/map/notamLayer';
	import { clearActivations, renderActivations } from '$lib/map/activationLayer';
	import {
		syncAirspaceClosures,
		clearAirspaceClosures,
	} from '$lib/map/airspaceClosureLayer';
	import { clearSupaipLayer, syncSupaipLayer } from '$lib/map/supaipLayer';
	import { clearSupActivations, renderSupActivations } from '$lib/map/supaipActivationLayer';
	import { syncSelectionHighlight } from '$lib/map/selectionHighlight';
	import { notamContextFeaturesAt, notamFeatureAt } from '$lib/map/notamInteractions';
	import {
		noPublishersPushed,
		pushChangedPublishers,
		wantedPublishers,
	} from '$lib/map/publisherFanout';
	import { buildViewHash, parseViewHash, writeViewHash } from '$lib/map/viewHash';
	import { activeAltitudeBand } from '$lib/state/filter.svelte';
	import { setAirportPublisher } from '$lib/map/airportLayer';
	import { setAirspacePublisher } from '$lib/map/airspaceLayer';
	import { mapState } from '$lib/state/map.svelte';
	import { display } from '$lib/state/display.svelte';
	import { layers, airportsAnyVisible } from '$lib/state/layers.svelte';
	import {
		airportByIdent,
		dataState,
		ensureAirports,
		ensureAirspaces,
		ensureSupaip,
		extendCoverage,
		getSupaips,
	} from '$lib/state/data.svelte';
	import {
		aerodromeClosedByNotam,
		aerodromeNotamIdents,
	} from '$lib/state/aerodromeState.svelte';
	import { closedAirspaceLinks } from '$lib/state/freqOverride.svelte';
	import { coverage, setCoverageArea, setForcedPublishers } from '$lib/state/coverage.svelte';
	import { notamPublisher } from '$lib/notam/airspaceIds';
	import {
		pinHeldByAirport,
		drawnStateAt,
		notamState,
		notamsByIdent,
		visibleNotams,
	} from '$lib/state/notam.svelte';
	import { AIRPORT_KINDS, airportZoomFloor } from '$lib/map/airportVisibility';
	import {
		activatedAirspaceLinks,
		airspaceIdIndex,
		isActiveTrigger,
	} from '$lib/state/notamLinks.svelte';
	import { supZoneActivations, supZoneKey } from '$lib/state/supaipLinks.svelte';
	import { visibleSupaipZones } from '$lib/state/supaip.svelte';
	import type { SupAipZone } from '$lib/data/supaip';
	import { selectAirport, selectAirspace, selectNotam, selectSupaip, ui } from '$lib/state/ui.svelte';

	/** Paris, the home State's centre of gravity, as in the flight app. */
	const DEFAULT_CENTER: L.LatLngTuple = [48.8566, 2.3522];
	const DEFAULT_ZOOM = 6;

	let container: HTMLDivElement;
	let map: L.Map | undefined;
	let baseLayer: L.TileLayer | null = null;
	let airspacesBuilt = false;
	const pushedPublisher = noPublishersPushed();

	function syncBaseLayer(): void {
		if (!map) {
			return;
		}
		const def = baseLayerDef(layers.baseLayer);
		if (baseLayer) {
			map.removeLayer(baseLayer);
		}
		baseLayer = def.create();
		baseLayer.addTo(map);
	}

	onMount(() => {
		// A present #map= is the WHOLE view and wins over the stored seed, the
		// same rule the flight app applies: an absent &layer= encodes the OSM
		// default, so a shared bare link shows what its sender saw.
		const restored = parseViewHash(location.hash);
		if (restored) {
			layers.baseLayer = restored.layer ?? 'osm';
		}
		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		map = L.map(container, {
			center: restored ? restored.center : DEFAULT_CENTER,
			zoom: restored ? restored.zoom : DEFAULT_ZOOM,
			zoomControl: true,
			zoomAnimation: !reducedMotion,
			fadeAnimation: !reducedMotion,
		});
		mapState.map = map;
		syncBaseLayer();
		// Read once, then folded away (map/attributionCredit.ts): this app's
		// About page credits the base map the same way Loxodrome's does.
		const disarmCredit = armAttributionCredit(map);

		/* The area the reference datasets must cover. No route term: there are
		   no routes here, so it is the viewport and the selection alone. */
		const publishCoverageArea = (m: L.Map): void => {
			const b = m.getBounds();
			setCoverageArea({
				minLat: b.getSouth(),
				minLon: b.getWest(),
				maxLat: b.getNorth(),
				maxLon: b.getEast(),
			});
		};

		const onSettled = (): void => {
			if (!map) {
				return;
			}
			const c = map.getCenter();
			mapState.zoom = map.getZoom();
			mapState.center = { lat: c.lat, lng: c.lng };
			publishCoverageArea(map);
			updateAirspaceViewport(map);
			redrawAirspaceDeco(map);
			updateAirportPane(map);
			writeViewHash(buildViewHash(map.getZoom(), c.lat, c.lng, layers.baseLayer, []));
		};
		map.on('moveend', onSettled);
		map.on('zoomend', onSettled);
		// Once now, as the flight app does: L.map() fired its own moveend while
		// it was being built, before any handler was listening, so until the
		// first pan the rest of the app held the default zoom. The on-field pin
		// rule reads it, and a viewer restored at #map=5 or 4 and handed a
		// briefing with no fit (a file, a briefing short of its corridor) hid
		// pins beside aerodrome symbols the layer does not draw there.
		onSettled();

		map.on('click', (e: L.LeafletMouseEvent) => {
			if (!map) {
				return;
			}
			const hit = notamFeatureAt(map, e.latlng.lat, e.latlng.lng);
			if (!hit) {
				return;
			}
			if (hit.kind === 'airport') {
				selectAirport(hit.id);
			} else if (hit.kind === 'notam') {
				selectNotam(hit.index);
			} else if (hit.kind === 'supaip') {
				selectSupaip(hit.id, hit.zone);
			} else {
				selectAirspace(hit.key);
			}
		});

		// The pointer says what is clickable, which is the only thing that can:
		// every path here is interactive:false, so the browser's own cursor
		// rules never fire (docs/map-hit-testing.md).
		map.on('mousemove', (e: L.LeafletMouseEvent) => {
			if (!map) {
				return;
			}
			const hit = notamFeatureAt(map, e.latlng.lat, e.latlng.lng);
			container.style.cursor = hit ? 'pointer' : '';
		});

		const ro = new ResizeObserver(() => map?.invalidateSize());
		ro.observe(container);

		const onHash = (): void => {
			const v = parseViewHash(location.hash);
			if (v && map) {
				layers.baseLayer = v.layer ?? 'osm';
				map.setView(v.center, v.zoom);
			}
		};
		window.addEventListener('hashchange', onHash);

		return () => {
			ro.disconnect();
			disarmCredit();
			window.removeEventListener('hashchange', onHash);
			if (map) {
				clearAirports(map);
				clearActivations(map);
				clearAirspaceClosures(map);
				clearSupActivations(map);
			}
			// These take no map: they null their module-level group handles,
			// whose build guards would otherwise pin a remount to the dead map.
			clearNotamLayer();
			clearAirspaceLayer();
			clearSupaipLayer();
			map?.remove();
			mapState.map = null;
			map = undefined;
		};
	});

	/* THE divergence from MapView, and the reason a world briefing is loadable
	   here. The flight app forces the publisher of EVERY loaded NOTAM's FIR into
	   the coverage gate, which is right for a briefing that covers a route: a
	   panel must be able to list its affected airspaces wherever the map is.
	   This app's briefings are routinely a whole continent or the whole world -
	   the predecessor's own test corpus is a 33 077-entry world dump - and
	   notamPublisher has a twelve-value co-domain, so the same rule would pull
	   every dataset the site ships on a paste.

	   A panel exists only for a SELECTED NOTAM, so the selection is what forces.
	   ui.detailBack rides along, or the back arrow would return to a panel whose
	   lists had emptied. Everything else on screen is covered by the viewport
	   term, which is what "wherever the map is" already means here. */
	$effect(() => {
		const wanted: ReturnType<typeof notamPublisher>[] = [];
		for (const d of [ui.detail, ui.detailBack]) {
			if (d?.kind !== 'notam') {
				continue;
			}
			const n = notamState.notams[d.index];
			const p = n?.qualifier?.fir ? notamPublisher(n.qualifier.fir, n.icaoCodes) : null;
			if (p) {
				wanted.push(p);
			}
		}
		setForcedPublishers(wanted.filter((p) => p !== null));
	});

	$effect(() => {
		void coverage.area;
		void coverage.forced;
		void extendCoverage();
	});

	$effect(() => {
		void layers.baseLayer;
		syncBaseLayer();
	});

	/* Airports: lazy-load and per-group visibility. The spread reads every
	   group flag unconditionally, since airportsAnyVisible() short-circuits;
	   the revision re-runs it when a country loading late re-merges the
	   dataset, so the layer indexes the merge every lookup answers from. */
	$effect(() => {
		const g = { ...layers.airportTypes };
		void dataState.revision.airports;
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
				for (const [type, kind] of Object.entries(AIRPORT_KINDS)) {
					setAirportType(type, g[kind.group]);
				}
				setAirportCues(new Set(notamsByIdent().keys()));
			})
			.catch(() => {
				/* surfaced via dataState.airportsError */
			});
	});

	$effect(() => {
		if (map && dataState.airportsLoaded) {
			setAirportCues(new Set(notamsByIdent().keys()));
		}
	});

	/* Airspaces: the same gate as the flight app's, minus the route term. The
	   dataset is built once a briefing exists OR anything else has loaded it,
	   because "linked lists always show": a NOTAM panel lists its affected
	   airspaces with every category off, which is the default. */
	$effect(() => {
		void dataState.revision.airspaces;
		const vis = { ...layers.airspace };
		if (!map) {
			return;
		}
		const anyOn = CATEGORIES.some((c) => vis[c]);
		const needed = anyOn || notamState.notams.length > 0 || dataState.airspacesLoaded;
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
				/* surfaced via dataState.airspacesError */
			});
	});

	$effect(() => {
		const want = wantedPublishers();
		if (!map) {
			return;
		}
		const m = map;
		const moved = pushChangedPublishers(pushedPublisher, want, [
			(p, on) => setAirspacePublisher(m, p, on),
			(p, on) => setAirportPublisher(p, on),
		]);
		if (moved) {
			redrawAirspaceDeco(m);
		}
	});

	$effect(() => {
		const band = activeAltitudeBand();
		if (map) {
			setAirspaceAltitudeFilter(map, band);
		}
	});

	$effect(() => {
		setAirspaceLabelsVisible(layers.airspaceLabels);
		if (map) {
			redrawAirspaceDeco(map);
		}
	});

	/* SUP AIP: loaded when its own toggle goes on, and rendered with the
	   selected supplement's remaining zones topped up so selecting one from a
	   NOTAM panel shows it even with the layer off. */
	$effect(() => {
		if (layers.supaip && !dataState.supaipLoaded) {
			void ensureSupaip().catch(() => {
				/* surfaced via dataState.supaipError */
			});
		}
	});

	/* And loaded when a LOADED NOTAM activates a supplement, whatever the
	   toggle says. The hatch effect below deliberately ignores the toggle,
	   because a zone a briefing activates is the thing this app exists to
	   draw; without this it was ignoring the toggle while being starved by
	   it, since the only loader was the one above and the toggle is off by
	   default. The effect simply returned at `!all` and nothing ever hatched:
	   R2736/26 activating 'ZRT DRONE COUBERT' of AIP SUP 191/25 linked
	   correctly in the panel and drew nothing on the map. Loxodrome's MapView
	   has carried this since the feature shipped; the duplicate never got it
	   (isActiveTrigger is the same gate the NOTAM panel uses for its badge). */
	$effect(() => {
		const anyTrigger = visibleNotams().some((it) => isActiveTrigger(it.notam));
		if (anyTrigger && !dataState.supaipLoaded) {
			void ensureSupaip().catch(() => {
				/* surfaced via dataState.supaipError */
			});
		}
	});

	$effect(() => {
		const items = layers.supaip ? visibleSupaipZones() : [];
		if (!map) {
			return;
		}
		const selId = ui.detail?.kind === 'supaip' ? ui.detail.id : null;
		const selZone = ui.detail?.kind === 'supaip' ? ui.detail.zone : undefined;
		syncSupaipLayer(map, items, selId ? { id: selId, zone: selZone } : null);
	});

	/* The airport floors the zoom has passed, the one thing the hide rule
	   below reads about the zoom. */
	const airportZoom = $derived(airportZoomFloor(mapState.zoom));

	/* The NOTAM overlay itself. */
	$effect(() => {
		const all = visibleNotams();
		const typeIcons = display.typeIcons;
		const qlineMarkers = display.qlineMarkers;
		// Only the pins that sit ON their field are suppressed, and only while
		// the field's symbol is drawn: the symbol and its cue ring stand there
		// already. One the NOTAM puts elsewhere, or beside a symbol not drawn
		// at this zoom or under these toggles, is the only thing saying where
		// (pinHeldByAirport).
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const hideAirportQline = new Set<number>();
		if (display.hideAirportNotamMarkers && dataState.airportsLoaded) {
			const zoom = airportZoom;
			for (const { notam, index } of all) {
				if (pinHeldByAirport(notam, zoom)) {
					hideAirportQline.add(index);
				}
			}
		}
		if (map) {
			renderNotams(map, all, typeIcons, qlineMarkers, hideAirportQline);
		}
	});

	$effect(() => {
		setQlineRadiusVisible(display.qlineRadius);
	});

	/* The activation hatches, airspace and SUP AIP. Neither reads its layer
	   toggle: a zone hatches while a loaded NOTAM activates it, which is the
	   whole point of drawing it. */
	$effect(() => {
		const activated = activatedAirspaceLinks();
		const byId = airspaceIdIndex();
		if (!map || !byId) {
			return;
		}
		renderActivations(map, activated, byId);
	});

	$effect(() => {
		const activated = supZoneActivations();
		const all = getSupaips();
		if (!map || !all) {
			return;
		}
		const zonesByKey = new Map<string, SupAipZone>(
			all.flatMap((s) =>
				s.zones.map((zone, i) => [supZoneKey(s.id, i), zone] as [string, SupAipZone]),
			),
		);
		renderSupActivations(map, activated, zonesByKey);
	});

	$effect(() => {
		// Draw the FIS sectors whose radio a NOTAM has withdrawn. Like the
		// activation hatch this reads no layer toggle: the FIS categories are
		// off by default, and a sector nobody answers on is exactly what the
		// map should say without being asked. closedAirspaceLinks() resolves
		// through the same ladder the airspace panel prints, one reading of the
		// NOTAM rather than two, and at the same range, drawnStateAt(): the
		// instant the map shows, which is the panel's default too.
		const closed = closedAirspaceLinks();
		if (!map) {
			return;
		}
		// SIV only. Type FIC draws NOTHING by chart convention: its limits ride
		// the FIR boundaries and the 500k prints the APP sectors' limits alone
		// (map/airspaceSymbology.ts, the SIA chart convention every type is
		// drawn to), so dashing a closed PARIS
		// Information would paint a line across the whole region that the
		// chart never prints and the pilot cannot turn off. The sector still
		// says so in its own panel and in the contact ladder.
		syncAirspaceClosures(
			map,
			[...closed.values()]
				.map((c) => c.airspace)
				.filter((a) => a.type !== 'FIC'),
		);
	});

	$effect(() => {
		// Strike the aerodromes a NOTAM currently shuts. Judged at
		// drawnStateAt(), never the briefing horizon: most of these closures
		// are nightly or exercise slots, and "shut at some point before the
		// horizon" would mark a field all day for a 21:00 works closure.
		// aerodromeNotamIdents() is the cheap gate; only those fields resolve.
		const idents = aerodromeNotamIdents();
		const at = drawnStateAt();
		// The revision, not just the loaded flag: a coverage extension merges a
		// new country's aerodromes into an already-loaded index, and until it
		// lands airportByIdent answers null for every field in it. Reading the
		// flag alone left a field shut abroad unmarked until something else
		// happened to invalidate this effect.
		void dataState.revision.airports;
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const shut = new Set<string>();
		if (dataState.airportsLoaded) {
			for (const ident of idents) {
				const ap = airportByIdent(ident);
				if (ap && aerodromeClosedByNotam(ap, at)) {
					shut.add(ident.toUpperCase());
				}
			}
		}
		setAirportClosedByNotam(shut);
	});

	/* ONE selection-highlight fan for every feature kind, the shared switch. */
	$effect(() => {
		syncSelectionHighlight(ui.detail);
	});

	/** Fit the map to the briefing. The toolbar's fit, and the one the loader
	 *  calls once a briefing lands. */
	export function fit(): void {
		if (map) {
			fitToNotams(map, visibleNotams());
		}
	}

	/** What is stacked under a point, for a "what is here?" menu. */
	export function featuresAt(lat: number, lon: number): ReturnType<typeof notamContextFeaturesAt> | null {
		return map ? notamContextFeaturesAt(map, lat, lon) : null;
	}
</script>

<HatchDefs />

<div class="notam-map" bind:this={container}></div>

<style>
	/* A flex child, not an absolute fill: the space a docked surface takes is
	 * reserved BESIDE this (a right dock) or BELOW it (a bottom one) by an
	 * empty spacer, which is what shrinks the Leaflet container and so
	 * reaches its ResizeObserver. An absolute fill would sit under the pane
	 * instead. */
	.notam-map {
		flex: 1;
		min-inline-size: 0;
		min-block-size: 0;
	}
</style>
