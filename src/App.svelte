<script lang="ts">
	import { onMount } from 'svelte';
	import Toolbar from '$lib/components/Toolbar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import MapView from '$lib/components/MapView.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import NotamMenu from '$lib/components/NotamMenu.svelte';
	import AboutModal from '$lib/components/AboutModal.svelte';
	import MapProfileModal from '$lib/components/MapProfileModal.svelte';
	import NavLogModal from '$lib/components/NavLogModal.svelte';
	import RouteProfileModal from '$lib/components/RouteProfileModal.svelte';
	import NavProfileModal from '$lib/components/NavProfileModal.svelte';
	import FlightPrepModal from '$lib/components/FlightPrepModal.svelte';
	import FlightsModal from '$lib/components/FlightsModal.svelte';
	import AircraftEditorModal from '$lib/components/AircraftEditorModal.svelte';
	import WxPrintHost from '$lib/components/WxPrintHost.svelte';
	import NotamPrintHost from '$lib/components/NotamPrintHost.svelte';
	import PersistHost from '$lib/components/PersistHost.svelte';
	import FileOpenHost from '$lib/components/FileOpenHost.svelte';
	import SearchPalette from '$lib/components/SearchPalette.svelte';
	import ShortcutsOverlay from '$lib/components/ShortcutsOverlay.svelte';
	import AiracBanner from '$lib/components/AiracBanner.svelte';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import { ui, MOBILE_UI_MEDIA } from './lib/state/ui.svelte';
	import { notamState } from './lib/state/notam.svelte';
	import { openIncomingBytes } from '$lib/state/openFile.svelte';
	import { resumeRoutesRestore } from '$lib/state/routePersist';
	import { currentPose, nav } from './lib/state/navRecording.svelte';
	import { applyAutoNight, nightDim } from './lib/state/nightDim.svelte';
	import { reconcileAutoStop } from './lib/state/autoStop.svelte';
	import {
		frontmostSurface,
		placementOf,
		reflowSurfaces,
		setStageSize,
		workspace,
	} from './lib/state/workspace.svelte';
	import { listenForUserPrint, setFrontmostSurface } from './lib/ui/surfacePrint.svelte';
	import { applyStageVars, observeBox } from './lib/ui/stageRect';
	import { watchSafeArea } from './lib/ui/safeArea';
	import { ensureOfflineCharts } from '$lib/state/offlineCharts.svelte';
	import { ensureOfflineDocs, heldCycles } from '$lib/state/offlineDocs.svelte';
	import { purgeDocCache } from '$lib/state/aipDocOpen';

	let stageEl: HTMLDivElement | undefined = $state();
	/** Bumped by the stage resize observer; the geometry effect reads it so a
	 *  measurement change re-publishes even though the box it reads is not
	 *  itself reactive. */
	let boxTick = $state(0);

	const dockB = $derived(workspace.dockPx.bottom);
	const dockR = $derived(workspace.dockPx.right);
	/** The page placement hands the whole stage to one surface, so the map
	 *  gives up its box entirely rather than rendering tiles behind it. */
	const mapHidden = $derived(
		workspace.overlay !== null && placementOf(workspace.overlay) === 'page',
	);

	onMount(() => {
		const mq = window.matchMedia(MOBILE_UI_MEDIA);
		const sync = (): void => {
			const entering = mq.matches && !ui.isMobile;
			const flipped = mq.matches !== ui.isMobile;
			ui.isMobile = mq.matches;
			// The CSS carrier of the same decision (style rules key off
			// :root.mobile-ui); everything mobile renders post-mount, so no
			// pre-mount stamp is needed.
			document.documentElement.classList.toggle('mobile-ui', mq.matches);
			if (entering) {
				// Open map-first on phones: drop the sheet to its peek.
				// (Rotating portrait <-> landscape stays mobile, so the sheet
				// state survives rotation.)
				ui.sidebarCollapsed = true;
			}
			if (flipped) {
				// A phone has one dock and no page; re-resolve every open
				// surface for the layout we just moved to.
				reflowSurfaces();
			}
		};
		sync();
		mq.addEventListener('change', sync);
		return () => mq.removeEventListener('change', sync);
	});

	/* The touch-ui root class: 44 px targets when the pointer is coarse OR
	 * a recording is running, which is this app's definition of being in
	 * flight (gloves and turbulence make any pointer coarse). The
	 * ui.svelte.ts doctrine: the criterion lives here once, CSS keys only
	 * off the class. */
	$effect(() => {
		const recording = nav.recording;
		const mq = window.matchMedia('(pointer: coarse)');
		const stamp = (): void => {
			document.documentElement.classList.toggle('touch-ui', recording || mq.matches);
		};
		stamp();
		mq.addEventListener('change', stamp);
		return () => mq.removeEventListener('change', stamp);
	});

	/* The automatic night trigger: reconcile per minute tick at the pose,
	 * WHILE RECORDING only (a desk replay never switches your theme). It
	 * only sets / restores the THEME; the dimming itself is the night
	 * theme's own CSS, identical to a manual toggle (docs/nav-live.md
	 * "In-flight ergonomics"). */
	$effect(() => {
		void notamState.tick;
		const pose = nav.recording ? currentPose() : null;
		applyAutoNight(pose?.lat ?? null, pose?.lon ?? null, Date.now());
	});

	/* The automatic stop after landing: reconcile on the recorder's own 1 Hz
	 * clock and per fix, WHILE RECORDING only (nav.nowMs ticks only while the
	 * watch is up, so the effect is inert otherwise). Firing goes through the
	 * ordinary stopRecording(), and the effect above then restores the theme
	 * (docs/nav-live.md "In-flight ergonomics"). */
	$effect(() => {
		reconcileAutoStop();
	});

	/* The night theme's raster brightness, published as a custom property
	 * so the Display-tab slider takes effect live. */
	$effect(() => {
		document.documentElement.style.setProperty('--night-dim', String(nightDim.pct / 100));
	});

	/* Measure the stage: everything that can move it (the sidebar width, a
	 * banner appearing, the window) changes its size too, so one observer
	 * covers them all. */
	$effect(() => {
		if (!stageEl) {
			return;
		}
		return observeBox(stageEl, () => {
			boxTick += 1;
		});
	});

	$effect(() => {
		// Tracked: the measurement tick and both dock sizes.
		void boxTick;
		if (!stageEl) {
			return;
		}
		const rect = stageEl.getBoundingClientRect();
		applyStageVars({
			left: rect.left,
			top: rect.top,
			width: rect.width,
			height: rect.height,
			dockB,
			dockR,
		});
		setStageSize(rect.width, rect.height);
	});

	// Track the on-screen keyboard: expose its height as --kb so the mobile
	// bottom sheet (bottom: var(--kb)) rides above it. Browsers that honour
	// interactive-widget=resizes-content already shrink the layout viewport,
	// so --kb stays ~0 there; this covers the rest.
	onMount(() => {
		const vv = window.visualViewport;
		if (!vv) {
			return;
		}
		const onViewport = (): void => {
			const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
			document.documentElement.style.setProperty('--kb', `${kb}px`);
		};
		onViewport();
		vv.addEventListener('resize', onViewport);
		vv.addEventListener('scroll', onViewport);
		return () => {
			vv.removeEventListener('resize', onViewport);
			vv.removeEventListener('scroll', onViewport);
		};
	});

	// The bottom safe-area inset the sheets pad by, kept only while it
	// measures real: a browser can report the navigation bar's height for a
	// bar that is not under the page at all (ui/safeArea.ts).
	onMount(() => watchSafeArea());

	// Offline chart packs: reconcile from OPFS once per boot so a downloaded
	// chart serves locally from first paint (the gen bump re-runs MapView's
	// chart-stack effect when this settles; docs/offline-maps.md).
	onMount(() => {
		void ensureOfflineCharts();
		// The AIP document packs, same reconcile. It also promotes a held
		// pre-release pack whose AIRAC cycle has arrived, so the panels stop
		// offering last cycle's plates the first time the app opens on or
		// after the effective date; the extracted-PDF cache then drops the
		// cycles no longer held.
		void ensureOfflineDocs().then(() => purgeDocCache(heldCycles()));
	});

	/* A user-initiated print (Ctrl+P, the browser menu) claims no job, so
	 * without this every open surface would flow onto the paper one after
	 * another. Claim the frontmost one instead. */
	onMount(() => {
		setFrontmostSurface(frontmostSurface);
		return listenForUserPrint();
	});

	onMount(() => {
		void loadInitial();
	});

	/**
	 * On startup, open the file named by a `?file=` URL parameter. It carries a
	 * NOTAM briefing by default and by history, which is what the fallback
	 * keeps saying when the content is inconclusive; anything the sniffer does
	 * recognise (a saved route workspace, an aircraft data sheet, a trace in
	 * any of its formats) opens as itself, through the same dispatcher the Android intents use.
	 * Otherwise the input stays blank; the user pastes / uploads / fetches when
	 * they're ready.
	 */
	async function loadInitial(): Promise<void> {
		// The null test mirrors routePersist's `has('file')` deferral guard
		// EXACTLY: a bare `?file` / empty `?file=` defers the restore too, so
		// bailing on falsiness here would leave it deferred for ever and the
		// stored plan stranded under an armed writer.
		const fileParam = new URLSearchParams(location.search).get('file');
		if (fileParam === null) {
			return;
		}
		try {
			if (fileParam !== '') {
				const res = await fetch(fileParam);
				if (res.ok) {
					// Bytes, so a KMZ (a ZIP container) survives the trip: the
					// dispatcher unwraps it and sniffs the text inside.
					const bytes = new Uint8Array(await res.arrayBuffer());
					await openIncomingBytes(fileParam, bytes, { fallback: 'notams' });
				}
			}
		} catch {
			/* network error; leave the input empty */
		} finally {
			// The route restore DEFERS on a ?file= boot rather than skipping
			// for the session: this file is most often a NOTAM briefing, which
			// says nothing about the flight plan, and the plan should come back
			// as usual. On every exit, including a failed fetch, hand the
			// restore its turn. A route file will have replaced the workspace
			// by now, and the restore's own "the user has their own workspace"
			// exit then holds the stored plan for the rescue.
			await resumeRoutesRestore();
		}
	}
</script>

<div class="app">
	<AiracBanner />
	<UpdateBanner />
	<!-- Mounted here rather than beside the other hosts: its failure banner
	     belongs to the top strip, and its confirm is portaled anyway. -->
	<FileOpenHost />
	<Toolbar />
	<div class="workspace">
		<Sidebar />
		<!-- The stage: the space between the side panels that a docked or
		     paged surface may take. Its spacers are empty; the surfaces
		     themselves paint over them from the body portal. -->
		<div class="stage" bind:this={stageEl}>
			<div class="stage-main">
				<!-- Only the map gives up its box to a page, never the dock
				     spacer beside it: a paged surface fills the map area, and
				     a docked one keeps the strip it reserved. -->
				<div class="map-slot" class:hidden={mapHidden}>
					<MapView />
				</div>
				{#if dockR > 0}
					<div class="dock-space" style:width="{dockR}px"></div>
				{/if}
			</div>
			{#if dockB > 0}
				<div class="dock-space" style:height="{dockB}px"></div>
			{/if}
		</div>
		<DetailPanel />
	</div>
	<ContextMenu />
	<NotamMenu />
	<AboutModal />
	<MapProfileModal />
	<NavLogModal />
	<RouteProfileModal />
	<NavProfileModal />
	<FlightPrepModal />
	<FlightsModal />
	<AircraftEditorModal />
	<WxPrintHost />
	<NotamPrintHost />
	<PersistHost />
	<SearchPalette />
	<ShortcutsOverlay />
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	.workspace {
		position: relative;
		display: flex;
		flex: 1;
		min-height: 0;

		/* Contain the off-screen parked panels (the closed DetailPanel sits at
		   translateX(105%)); clip (not hidden) so they add no scroll range that
		   a focus/scrollIntoView could drag the whole page into. */
		overflow: clip;
	}

	/* On a phone the sidebar sheet at rest IS the bottom bar, so the workspace
	   reserves its height and the stage ends above it. That is what puts a
	   bottom dock BETWEEN the map and the bar: the dock is reserved space
	   inside the stage, never an overlay, so the bar it would otherwise sit
	   on top of has to be reserved too. The sheets stay absolutely positioned
	   against the padding box, so they still reach the screen's bottom edge
	   and still grow up over the dock. --sheet-peek is measured and published
	   by Sidebar.svelte. */
	:global(:root.mobile-ui) .workspace {
		padding-bottom: var(--sheet-peek, 0);
	}

	/* The bottom dock spans the stage width, so the right dock sits above it:
	   a column of [map row][bottom spacer], the map row itself a row of
	   [map][right spacer]. */
	.stage {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
	}

	.stage-main {
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.map-slot {
		display: flex;
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	.map-slot.hidden {
		display: none;
	}

	/* Empty on purpose: it only reserves the box the portaled surface paints
	   over, and it is what actually shrinks the Leaflet container. */
	.dock-space {
		flex: 0 0 auto;
	}

	/* The Leaflet attribution sits in the map's bottom-right corner at
	   Leaflet's control z-index (1000), above the detail panel (520), so it
	   would otherwise show on top of the panel that covers that corner. The
	   map and the panel are both descendants of .workspace, so hide the
	   attribution while the panel is open (covers both desktop and the
	   full-width mobile panel; it reappears when the panel closes). */
	:global(.workspace:has(.detail.open) .leaflet-control-attribution) {
		display: none;
	}

	/* On mobile, a sheet tall enough to cover the map would let the Leaflet
	   controls (zoom + attribution) poke through on top of it. `.full` used to
	   be the proxy for that, but it means "the whole workspace", and a bottom
	   dock makes a sheet cover the map well before then, so the sheets carry
	   .covers-map instead. A shorter sheet keeps the controls: the map strip
	   above it stays a working map. Desktop keeps just the attribution rule. */
	:global(.workspace:has(.sidebar.mobile.covers-map, .detail.mobile.covers-map) .leaflet-control) {
		display: none;
	}
</style>
