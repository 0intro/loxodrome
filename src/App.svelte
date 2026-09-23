<script lang="ts">
	import { untrack } from 'svelte';
	import { onMount } from 'svelte';
	import Toolbar from '$lib/components/Toolbar.svelte';
	import LazySurface from '$lib/components/LazySurface.svelte';
	import { offlineModal } from '$lib/state/offlineModal.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import PhoneNavBar from '$lib/components/phone/PhoneNavBar.svelte';
	import PhonePages from '$lib/components/phone/PhonePages.svelte';
	import MapView from '$lib/components/MapView.svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import ContextMenu from '$lib/components/ContextMenu.svelte';
	import NotamMenu from '$lib/components/NotamMenu.svelte';
	import WxPrintHost from '$lib/components/WxPrintHost.svelte';
	import NotamPrintHost from '$lib/components/NotamPrintHost.svelte';
	import PersistHost from '$lib/components/PersistHost.svelte';
	import SyncHost from '$lib/components/SyncHost.svelte';
	import FileOpenHost from '$lib/components/FileOpenHost.svelte';
	import SearchPalette from '$lib/components/SearchPalette.svelte';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import { closeLogin, loginModal, openLogin } from '$lib/state/loginModal.svelte';
	import {
		accountModal,
		openAccountAfterLogin,
		openAccountModal,
	} from '$lib/state/accountModal.svelte';
	import { signedIn } from '$lib/state/account.svelte';
	import ShortcutsOverlay from '$lib/components/ShortcutsOverlay.svelte';
	import AiracBanner from '$lib/components/AiracBanner.svelte';
	import UpdateBanner from '$lib/components/UpdateBanner.svelte';
	import { ui, closeDetail, MOBILE_UI_MEDIA, PHONE_LANDSCAPE_MEDIA } from './lib/state/ui.svelte';
	// The lazily-mounted surfaces' own open flags (their state modules are
	// tiny and already in the boot graph; only the components are deferred).
	import { aboutModal } from '$lib/state/aboutModal.svelte';
	import { mapProfileModal } from '$lib/state/mapProfileModal.svelte';
	import { airspaceProfileModal } from '$lib/state/airspaceProfileModal.svelte';
	import { navLogModal } from '$lib/state/navLogModal.svelte';
	import { routeProfileModal } from '$lib/state/routeProfileModal.svelte';
	import { navProfileModal } from '$lib/state/navProfileModal.svelte';
	import { flightPrepModal } from '$lib/state/flightPrepModal.svelte';
	import { flightsModal } from '$lib/state/flightsModal.svelte';
	import { aircraftEditor } from '$lib/state/aircraftEditor.svelte';
	import { notamState } from './lib/state/notam.svelte';
	import { openFile, openIncomingBytes } from '$lib/state/openFile.svelte';
	import { resumeRoutesRestore } from '$lib/state/routePersist';
	import { currentPose, nav } from './lib/state/navRecording.svelte';
	import { applyAutoNight, nightDim } from './lib/state/nightDim.svelte';
	import { reconcileAutoStop } from './lib/state/autoStop.svelte';
	import {
		closeSurface,
		frontmostSurface,
		isOpen,
		openSurface,
		placementOf,
		reflowSurfaces,
		setPaneCapHook,
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
		const lq = window.matchMedia(PHONE_LANDSCAPE_MEDIA);
		const sync = (): void => {
			const flipped = mq.matches !== ui.isMobile;
			// A phone held sideways (docs/workspace-surfaces.md "Phones"): the
			// bar becomes a left rail and the pane a right dock. Read beside
			// the mobile flag so one pass sees both flips.
			const landscape = mq.matches && lq.matches;
			const turned = landscape !== ui.isLandscapePhone;
			ui.isMobile = mq.matches;
			ui.isLandscapePhone = landscape;
			// The CSS carriers of the same decisions (style rules key off
			// :root.mobile-ui / .mobile-landscape); everything mobile renders
			// post-mount, so no pre-mount stamp is needed.
			document.documentElement.classList.toggle('mobile-ui', mq.matches);
			document.documentElement.classList.toggle('mobile-landscape', landscape);
			if (flipped) {
				// Open map-first on phones: no page up. (Rotating portrait <->
				// landscape stays mobile, so the page survives rotation.) And
				// LEAVING the phone layout must clear it too: the bar and the
				// pages unmount with `ui.isMobile`, but a page left standing
				// keeps the workspace and the toolbar inert, which on a
				// desktop is the whole application dead with nothing on
				// screen to explain it (a window dragged past the breakpoint,
				// the device toolbar toggled, Android split screen).
				ui.page = null;
			}
			if (flipped || turned) {
				// A phone has one dock and no page, and its edge follows the
				// orientation; re-resolve every open surface for the layout we
				// just moved to. Never interactive (a rotation must not
				// prompt), the reflow's own rule. The stage already has its
				// new size (the class flip above lays out on this read) but
				// the observer publishing it runs a frame later: push it now,
				// so the reflow seeds the new edge's detent from the live
				// geometry and not the old orientation's (0.45 of a landscape
				// height clamps to the pane's floor, measured).
				if (stageEl) {
					const r = stageEl.getBoundingClientRect();
					setStageSize(r.width, r.height);
				}
				reflowSurfaces();
			}
		};
		sync();
		mq.addEventListener('change', sync);
		lq.addEventListener('change', sync);
		return () => {
			mq.removeEventListener('change', sync);
			lq.removeEventListener('change', sync);
		};
	});

	/* The touch-ui root class: 44 px targets when the pointer is coarse OR
	 * a recording is running, which is this app's definition of being in
	 * flight (gloves and turbulence make any pointer coarse). The
	 * ui.svelte.ts doctrine: the criterion lives here once, CSS keys only
	 * off the class. Beside it, in-flight: the recording alone, the 64 px
	 * floor the phone's bar and band grow to while it runs (the
	 * touch-in-turbulence studies' 15 mm; docs/mobile-ui-review.md). */
	$effect(() => {
		const recording = nav.recording;
		const mq = window.matchMedia('(pointer: coarse)');
		const stamp = (): void => {
			document.documentElement.classList.toggle('touch-ui', recording || mq.matches);
			document.documentElement.classList.toggle('in-flight', recording);
		};
		stamp();
		mq.addEventListener('change', stamp);
		return () => mq.removeEventListener('change', stamp);
	});

	/* The phone's detail lives in the pane: the `detail` workspace surface
	 * is up exactly while ui.detail names something on the phone layout
	 * (docs/workspace-surfaces.md "Phones"). One bridge, here, so the
	 * select* / navigateTo* entry points stay layout-blind. The closes are
	 * untracked writes: this effect reads open-ness to decide, and must not
	 * re-run for its own write. */
	$effect(() => {
		/* NAMED, not resolved. The desktop panel gates on the resolved
		 * question, and copying that here was wrong: half the kinds load
		 * their dataset on demand (a navaid waypoint tapped in the nav log
		 * asks for the set and fills in when it lands, which is the panel's
		 * own documented behaviour), so the pane would refuse to open for
		 * those seconds, or close and reopen under one. The stale-target
		 * case it was meant to catch is already handled where it happens:
		 * a re-parse and a clear both null ui.detail themselves. */
		const target = ui.detail;
		const mobile = ui.isMobile;
		const up = isOpen('detail');
		if (!mobile || target === null) {
			if (up) {
				untrack(() => closeSurface('detail'));
			}
			return;
		}
		if (!up) {
			untrack(() => openSurface('detail'));
		}
	});

	/* The pane's cap: half at most while a recording runs, so a chart or a
	 * log never takes the whole map from a pilot in flight. Registered as a
	 * hook (the workspace never reads navRecording); read reactively by the
	 * placement writes that consult it. */
	onMount(() => setPaneCapHook(() => nav.recording));

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
		const params = new URLSearchParams(location.search);
		// The public account route (docs/accounts-sync.md; the web deletion
		// path Play's data-safety form declares): ?account= lands on the
		// Settings tab, whose Account group is the first thing on it.
		if (params.has('account')) {
			// Signed in: straight to the management surface. Signed out: the
			// login dialog, armed to open the surface on success, so the
			// deletion controls are one flow away from the declared URL.
			if (signedIn()) {
				openAccountModal();
			} else {
				openAccountAfterLogin();
				openLogin();
			}
		}
		// The null test mirrors routePersist's `has('file')` deferral guard
		// EXACTLY: a bare `?file` / empty `?file=` defers the restore too, so
		// bailing on falsiness here would leave it deferred for ever and the
		// stored plan stranded under an armed writer.
		const fileParam = params.get('file');
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
				} else {
					// SAY so. A boot that cannot read the file it was handed
					// used to come up as a bare map, which reads as the app
					// ignoring the intent rather than failing on it.
					openFile.failure = { name: fileParam, reason: 'failed', detail: `HTTP ${res.status}` };
				}
			}
		} catch (err) {
			openFile.failure = {
				name: fileParam,
				reason: 'failed',
				detail: err instanceof Error ? err.message : '',
			};
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
	<!-- A phone PAGE is opaque and covers the toolbar, the map and the pane,
	     but it is not a modal with a backdrop, so without this everything it
	     hides stays in the tab order and in a screen reader's swipe order:
	     the Fly button, the map's controls and the band's cells are all
	     reachable, and firable, while invisible. -->
	<div class="workspace" inert={ui.page !== null || undefined}>
		{#if !ui.isMobile}
			<Sidebar />
		{/if}
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
	{#if ui.isMobile}
		<PhoneNavBar />
		<PhonePages />
	{/if}
	<ContextMenu />
	<NotamMenu />
	<!-- Mounted on first open and kept for the session (LazySurface): every
	     one of these gates its own DOM through SurfaceShell, so mounting them
	     eagerly bought nothing but their code in the entry chunk. -->
	<LazySurface id="about" open={aboutModal.open} load={() => import('$lib/components/AboutModal.svelte')} />
	<!-- onFail: the detail is the one surface with a second source of truth
	     (ui.detail, which the bridge above re-asserts), so a chunk that will
	     not load has to release the SELECTION too or the two would trade the
	     slot back and forth. -->
	<LazySurface
		id="detail"
		open={isOpen('detail')}
		load={() => import('$lib/components/DetailSurface.svelte')}
		onFail={closeDetail}
	/>
	<LazySurface
		id="account"
		open={accountModal.open}
		load={() => import('$lib/components/AccountModal.svelte')}
	/>
	<LazySurface id="mapProfile" open={mapProfileModal.open} load={() => import('$lib/components/MapProfileModal.svelte')} />
	<!-- A detail panel's own chart. Mounted HERE, not in the panel: on a phone
	     the panel is the pane's occupant and opening the chart evicts it, so a
	     chart mounted inside it went the moment it opened
	     (state/airspaceProfileModal.svelte.ts). -->
	<LazySurface
		id="airspaceProfile"
		open={airspaceProfileModal.open}
		load={() => import('$lib/components/PanelProfileModal.svelte')}
	/>
	<LazySurface id="navlog" open={navLogModal.open} load={() => import('$lib/components/NavLogModal.svelte')} />
	<LazySurface id="routeProfile" open={routeProfileModal.open} load={() => import('$lib/components/RouteProfileModal.svelte')} />
	<LazySurface id="navProfile" open={navProfileModal.open} load={() => import('$lib/components/NavProfileModal.svelte')} />
	<LazySurface id="flightPrep" open={flightPrepModal.open} load={() => import('$lib/components/FlightPrepModal.svelte')} />
	<LazySurface id="flights" open={flightsModal.open} load={() => import('$lib/components/FlightsModal.svelte')} />
	<LazySurface
		id="offline"
		open={offlineModal.open}
		load={() => import('$lib/components/OfflineModal.svelte')}
	/>
	<LazySurface id="aircraftEditor" open={aircraftEditor.open} load={() => import('$lib/components/AircraftEditorModal.svelte')} />
	<WxPrintHost />
	<NotamPrintHost />
	<PersistHost />
	<SyncHost />
	<SearchPalette />
	{#if loginModal.open}
		<LoginModal onClose={closeLogin} />
	{/if}
	<ShortcutsOverlay />
</div>

<style>
	.app {
		display: flex;
		flex-direction: column;
		height: 100dvh;
		overflow: hidden;
	}

	/* Landscape phone: the bar is a fixed left rail (PhoneNavBar.svelte), so
	   the column starts after it and pads the bottom inset itself, which the
	   rail no longer covers. */
	:global(:root.mobile-landscape) .app {
		padding-bottom: var(--sab);
		padding-left: calc(var(--phone-rail-w) + var(--sal));
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

</style>
