<script lang="ts">
	/* The NOTAM Viewer's map.
	 *
	 * A second composition over the SAME layer modules the flight app uses, not
	 * a second set of layers: map/notamLayer.ts, map/airspaceLayer.ts and the
	 * rest are shared whole, and so is the hit-test RULE (map/areaRank.ts). What
	 * differs is what is on the map, which is the app.
	 *
	 * Why a second component rather than a shared core: MapView.svelte's own
	 * onMount owns every pane and every teardown, and a parent / child split
	 * would reorder its effects in the flight app's most load-bearing file.
	 * The layer APIs are typed exports, so the drift duplication risks is
	 * compiler-caught; the drift a split risks is not. What this view owes the
	 * airspace layers is small and order-free: build the airspace layer and
	 * the painting that draws it, take both down, and leave the painting's
	 * repaints to the airspace layer (map/airspaceLayer.ts, airspacesToPaint
	 * and setAirspaceRepaintListener).
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
	import { armKeyPan } from '$lib/map/keyPan';
	import { padSvgRenderers } from '$lib/map/svgPadding';
	import { retitleZoom } from '$lib/map/zoomControl';
	import HatchDefs from '$lib/components/HatchDefs.svelte';
	import {
		buildAirspaceLayer,
		clearAirspaceLayer,
		setAirspaceAltitudeFilter,
		setAirspaceCategory,
		setFaintAirspaces,
		setShownAirspaces,
		setLinkedAirspaces,
		updateAirspaceViewport,
		CATEGORIES,
	} from '$lib/map/airspaceLayer';
	import {
		buildAirspaceDecoLayer,
		clearAirspaceDecoLayer,
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
	import {
		clearNotamLayer,
		fitToNotams,
		renderNotams,
		setPanelQRadiusIndex,
		setQlineRadiusSuppressed,
		setQlineRadiusVisible,
		updateNotamPinsViewport,
	} from '$lib/map/notamLayer';
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
	import { t } from '$lib/state/i18n.svelte';
	import { layers, airportsAnyVisible } from '$lib/state/layers.svelte';
	import {
		airportByIdent,
		dataState,
		ensureAirports,
		ensureAirspaces,
		ensureSupaip,
		getSupaips,
		selectedSupaip,
		watchCoverage,
	} from '$lib/state/data.svelte';
	import {
		aerodromeClosedByNotam,
		aerodromeNotamIdents,
	} from '$lib/state/aerodromeState.svelte';
	import { closedAirspaceLinks } from '$lib/state/freqOverride.svelte';
	import { setCoverageViewport, setForcedPublishers } from '$lib/state/coverage.svelte';
	import { notamPublisher } from '$lib/notam/airspaceIds';
	import {
		pinHeldByAirport,
		drawnStateAt,
		notamState,
		notamsByIdent,
		selectedNotam,
		visibleNotams,
		drawnNotams,
	} from '$lib/state/notam.svelte';
	import { AIRPORT_KINDS, airportZoomFloor } from '$lib/map/airportVisibility';
	import { airspaceIdIndex, airspacesReferencedByNotam, isActiveTrigger } from '$lib/state/notamLinks.svelte';
	import { supZoneKey } from '$lib/state/supaipLinks.svelte';
	import { airspaceActivations, airspaceFaint, airspaceMay, notamStates } from '$lib/state/zoneStates.svelte';
	import { supHatchZones, supLayerZones, supNotamZones, supSelectionZones, type DrawnSupZone, type VisibleZone } from '$lib/state/supaip.svelte';
	import type { SupAipZone } from '$lib/data/supaip';
	import {
		navigateToAirspace,
		selectAirport,
		selectAirspace,
		selectNotam,
		selectSupaip,
		ui,
	} from '$lib/state/ui.svelte';

	/** Paris, the home State's centre of gravity, as in the flight app. */
	const DEFAULT_CENTER: L.LatLngTuple = [48.8566, 2.3522];
	const DEFAULT_ZOOM = 6;

	let container: HTMLDivElement;
	let map: L.Map | undefined;
	let baseLayer: L.TileLayer | null = null;
	let zoomCtl: L.Control.Zoom | undefined;
	let zoomCtlMap: L.Map | undefined;
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
		// The vector overlays draw half a screen beyond each side (svgPadding.ts).
		padSvgRenderers();
		map = L.map(container, {
			center: restored ? restored.center : DEFAULT_CENTER,
			zoom: restored ? restored.zoom : DEFAULT_ZOOM,
			// The zoom control is the locale effect's, below: Leaflet bakes its
			// English titles into the control it builds here.
			zoomControl: false,
			zoomAnimation: !reducedMotion,
			fadeAnimation: !reducedMotion,
		});
		mapState.map = map;
		syncBaseLayer();
		// Read once, then folded away (map/attributionCredit.ts): this app's
		// About page credits the base map the same way Loxodrome's does.
		const disarmCredit = armAttributionCredit(map);
		const disarmKeyPan = armKeyPan(map);

		/* The area the reference datasets must cover. No plan term: there is
		   no plan here (planScope.extent is null), so it is the viewport and
		   the selection alone. */
		const publishCoverageArea = (m: L.Map): void => {
			const b = m.getBounds();
			setCoverageViewport({
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
			updateNotamPinsViewport(map);
			updateAirportPane(map);
		};
		// moveend alone: a zoom fires zoomend and then moveend from the same
		// Map._moveEnd call, so binding both settled twice per zoom step.
		map.on('moveend', onSettled);
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
				// Reached from the selected NOTAM (one of the airspaces it
				// references, the reason it stays clickable with its category
				// off): navigate with a back-link to that NOTAM, as MapView
				// does. Any other airspace click is a fresh selection.
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
			disarmKeyPan();
			window.removeEventListener('hashchange', onHash);
			if (hashTimer != null) {
				clearTimeout(hashTimer);
				hashTimer = null;
			}
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
			clearAirspaceDecoLayer();
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

	watchCoverage();

	$effect(() => {
		void layers.baseLayer;
		syncBaseLayer();
	});

	$effect(() => {
		// The zoom control carries the only user-visible Leaflet strings,
		// baked at creation: built once per map, and on a locale change its
		// two titles are rewritten in place (map/zoomControl.ts), as in
		// MapView. Reading mapState.map (reactive) covers the first run
		// racing onMount.
		const m = mapState.map;
		const titles = { zoomInTitle: t.map.zoomIn, zoomOutTitle: t.map.zoomOut };
		if (!m) {
			return;
		}
		if (zoomCtl && zoomCtlMap === m) {
			retitleZoom(zoomCtl, titles);
			return;
		}
		zoomCtl?.remove();
		zoomCtl = L.control.zoom(titles);
		zoomCtl.addTo(m);
		zoomCtlMap = m;
	});

	// The hash restamp below is throttled (leading + trailing, one window),
	// as the flight app's is: a window edge dragged or a run of wheel zooms
	// settles the view once a frame, and Safari hard-fails
	// history.replaceState past 100 calls per 30 s. Later runs inside the
	// window only refresh pendingHash, they never re-arm the timer. The timer
	// is cleared at unmount (the onMount teardown), never in the effect
	// itself, where cleanup would run before every re-run.
	const HASH_THROTTLE_MS = 1000;
	let hashTimer: ReturnType<typeof setTimeout> | null = null;
	let hashLastMs = 0;
	let pendingHash = '';

	function flushViewHash(): void {
		hashLastMs = Date.now();
		writeViewHash(pendingHash);
	}

	$effect(() => {
		// The shareable address (#map=z/lat/lon[&layer=]) follows the settled
		// view and the base layer, the viewer's only memory of either:
		// mapState.center and zoom are written on settle, so this runs per
		// settled view, not per frame.
		if (!mapState.map) {
			return;
		}
		const { lat, lng } = mapState.center;
		pendingHash = buildViewHash(mapState.zoom, lat, lng, layers.baseLayer, []);
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
					setAirspaceCategory(c, false);
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
					setAirspaceCategory(c, layers.airspace[c]);
				}
				updateAirspaceViewport(map);
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
		pushChangedPublishers(pushedPublisher, want, [
			(p, on) => setAirspacePublisher(p, on),
			(p, on) => setAirportPublisher(p, on),
		]);
	});

	$effect(() => {
		const band = activeAltitudeBand();
		if (map) {
			setAirspaceAltitudeFilter(band);
		}
	});

	$effect(() => {
		// The setter repaints the decoration canvas itself.
		setAirspaceLabelsVisible(layers.airspaceLabels);
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
		// The toggle's window- and altitude-filtered zones (with it off, those
		// a NOTAM of the period activates later), and what the selection
		// names topped up PER ZONE in its state, as in MapView
		// (supSelectionZones): the zone a click or a panel row selects, else
		// every zone of a supplement selected whole.
		void dataState.supaipLoaded;
		if (!map) {
			return;
		}
		const sel = selectedSupaip();
		const selZone = ui.detail?.kind === 'supaip' ? ui.detail.zone : undefined;
		let items: (VisibleZone | DrawnSupZone)[] = layers.supaip ? supLayerZones() : supNotamZones();
		if (sel) {
			const extra = supSelectionZones(sel, selZone, items);
			if (extra.length > 0) {
				items = [...items, ...extra];
			}
		}
		syncSupaipLayer(map, items, sel ? { id: sel.id, zone: selZone } : null);
	});

	/* The airport floors the zoom has passed, the one thing the hide rule
	   below reads about the zoom. */
	const airportZoom = $derived(airportZoomFloor(mapState.zoom));

	/* The NOTAM overlay itself. */
	$effect(() => {
		const all = drawnNotams();
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
			renderNotams(map, all, typeIcons, qlineMarkers, hideAirportQline, notamStates());
		}
	});

	$effect(() => {
		setQlineRadiusVisible(display.qlineRadius);
	});

	$effect(() => {
		// The detail panel's "Show Q radius" for the NOTAM it shows.
		const idx = ui.detail?.kind === 'notam' ? ui.detail.index : null;
		setPanelQRadiusIndex(idx !== null && idx === ui.qRadiusIndex ? idx : null);
	});

	$effect(() => {
		// The selected NOTAM's affected airspaces (named in its text or cited
		// by designator), drawn instead of its auto Q-line radius circle while
		// the Layers option is on. The panel's own Q radius toggle still
		// draws the circle, so the highlight does not read ui.qRadiusIndex.
		const notam = display.affectedAirspaces ? selectedNotam() : null;
		const affected = notam ? airspacesReferencedByNotam(notam) : [];
		setLinkedAirspaces(affected.length ? affected : null);
		setQlineRadiusSuppressed(affected.length > 0);
	});

	/* The activation hatches, airspace and SUP AIP. Neither reads its layer
	   toggle: a zone hatches while it is active over the viewed time, and
	   an activation later in the period draws its dashed outline, which is
	   the whole point of drawing them (state/zoneStates.svelte.ts). */
	$effect(() => {
		const acts = airspaceActivations();
		const byId = airspaceIdIndex();
		if (!map || !byId) {
			return;
		}
		renderActivations(map, acts.active, acts.later, byId);
	});

	$effect(() => {
		// The zones inactive over the viewed time draw faint, and those that
		// may be active a NOTAM of the period activates later draw whatever
		// their toggle (the flight app's effect, MapView).
		setFaintAirspaces(airspaceFaint());
		setShownAirspaces(airspaceMay());
	});

	$effect(() => {
		const active = supHatchZones();
		const all = getSupaips();
		if (!map || !all) {
			return;
		}
		const zonesByKey = new Map<string, SupAipZone>(
			all.flatMap((s) =>
				s.zones.map((zone, i) => [supZoneKey(s.id, i), zone] as [string, SupAipZone]),
			),
		);
		renderSupActivations(map, active, zonesByKey);
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
