<script lang="ts">
	/* The NOTAM Viewer's shell.
	 *
	 * One job: a briefing on a chart. The panel holds the loader and the list
	 * (NotamsTab, reused whole), the stage holds the map, and the detail panel
	 * overlays the stage exactly as it does in the flight app.
	 *
	 * What is NOT here is the point of the app: no route workspace, no nav
	 * recording, no weather SURFACES, no aircraft, no accounts, no offline
	 * packs. The airport panel's own METAR / TAF card comes over with the
	 * shared panel and is credited as such; what is absent is the Weather tab,
	 * the overlays and the winds (src/notam/datasets.ts). The
	 * shared components those would have reached are answered by
	 * state/planScope.svelte.ts, which this app never registers, so they get
	 * the null answers that module documents.
	 */
	import { onMount, tick, untrack } from 'svelte';
	import DetailPanel from '$lib/components/DetailPanel.svelte';
	import DetailSurface from '$lib/components/DetailSurface.svelte';
	import PanelProfileModal from '$lib/components/PanelProfileModal.svelte';
	import NotamPrintHost from '$lib/components/NotamPrintHost.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import NotamMapView from '$lib/components/NotamMapView.svelte';
	import AboutSurface from './AboutSurface.svelte';
	import BriefingLoader from './BriefingLoader.svelte';
	import Toolbar from './Toolbar.svelte';
	import NotamsTab from '$lib/components/tabs/NotamsTab.svelte';
	import { MOBILE_UI_MEDIA, PHONE_LANDSCAPE_MEDIA, ui } from '$lib/state/ui.svelte';
	import {
		closeSurface,
		isOpen,
		openSurface,
		setStageSize,
		workspace,
	} from '$lib/state/workspace.svelte';
	import { applyStageVars, observeBox } from '$lib/ui/stageRect';
	import { watchSafeArea } from '$lib/ui/safeArea';
	import { applyLayout } from './layout';
	import { t } from '$lib/state/i18n.svelte';
	import { fitToNotams } from '$lib/map/notamLayer';
	import { mapState } from '$lib/state/map.svelte';
	import { notamState, visibleNotams } from '$lib/state/notam.svelte';
	import { nightDim } from '$lib/state/nightDim.svelte';

	/* On a phone the briefing is a PAGE over the map rather than a column
	 * beside it: there is no width to split at 392 px. It opens itself when
	 * there is nothing to show, because an empty map with a hidden paste box
	 * is not an empty state, it is a dead end. */
	let briefingPage = $state(false);
	/* Bound to NotamsTab, because the phone bar carries Load as a destination
	 * of its own and the bar and the tab's head button must be two views of one
	 * state. The reason it is a destination: a reader who came to this app for
	 * a paste box, pasted, and was handed to the map has no obvious way back to
	 * the box. The head's 44 px download icon is a door, but not one they find. */
	let loaderOpen = $state(false);
	const hasBriefing = $derived(notamState.notams.length > 0);
	/* With nothing loaded the tab shows the loader whatever this says, so the
	 * bar must mark Load as current or it would point at a page nobody is on. */
	const loaderShowing = $derived(briefingPage && (loaderOpen || !hasBriefing));
	$effect(() => {
		if (ui.isMobile && !hasBriefing) {
			briefingPage = true;
		}
	});
	/* The other half of what "Display on map" promises: frame what was just
	 * loaded, rather than leaving the reader wherever the map happened to be.
	 * fitToNotams frames the MARKERS, not the radii, which is what makes this
	 * worth doing at all: padded by radius the box came out at the same
	 * 18.1 x 23.4 degrees for three different routes, because two 460 NM navaid
	 * outages reach into every French briefing (map/notamLayer.ts).
	 *
	 * Two frames, not one tick: on a phone, hiding the briefing page changes the
	 * Leaflet container's size and it is MapView's ResizeObserver that tells
	 * Leaflet so. Fitting before that lands would frame the old box. */
	async function fitLoaded(): Promise<void> {
		await tick();
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		if (mapState.map) {
			fitToNotams(mapState.map, visibleNotams());
		}
	}

	/* Opening a NOTAM from the page hands the phone back to the map, where
	 * the detail pane can sit under it. */
	$effect(() => {
		if (ui.isMobile && ui.detail !== null) {
			untrack(() => (briefingPage = false));
		}
	});


	// The layout carriers, lifted from src/App.svelte: ui.isMobile is what the
	// shared surfaces branch on, and :root.mobile-ui / .touch-ui are what the
	// CSS branches on. One definition of "this is a phone", in JS and in CSS.
	// A flip or a turn also re-places the open surfaces (./layout.ts): the
	// detail pane changes edge with the orientation.
	onMount(() => {
		const phone = window.matchMedia(MOBILE_UI_MEDIA);
		const landscape = window.matchMedia(PHONE_LANDSCAPE_MEDIA);
		const apply = (): void => {
			const sideways = phone.matches && landscape.matches;
			// The classes first: the stage lays out on the read below.
			document.documentElement.classList.toggle('mobile-ui', phone.matches);
			document.documentElement.classList.toggle('mobile-landscape', sideways);
			applyLayout(phone.matches, landscape.matches, () => stage.getBoundingClientRect());
		};
		apply();
		phone.addEventListener('change', apply);
		landscape.addEventListener('change', apply);
		return () => {
			phone.removeEventListener('change', apply);
			landscape.removeEventListener('change', apply);
		};
	});

	/* The phone's detail lives in the pane: the `detail` workspace surface is
	 * up exactly while ui.detail names something on the phone layout
	 * (docs/workspace-surfaces.md "Phones"). One bridge, so the select* /
	 * navigateTo* entry points stay layout-blind. NAMED, not resolved: half
	 * the kinds load their dataset on demand, and gating on the resolved
	 * question would refuse to open for those seconds. The closes are
	 * untracked writes: this effect reads open-ness to decide and must not
	 * re-run for its own write. */
	$effect(() => {
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

	// The stage geometry the docked surfaces resolve against, published as CSS
	// custom properties on <html> from one observer (ui/stageRect.ts).
	/* The stage geometry the docked detail pane resolves against, published as
	 * CSS custom properties on <html> from one observer (ui/stageRect.ts).
	 * The bottom dock's height rides along, because the pane is reserved in
	 * FLOW by the spacer inside the stage and that is what shrinks the Leaflet
	 * container. */
	/* The bottom inset is checked rather than trusted (ui/safeArea.ts): a
	 * browser can report the system navigation bar's whole height for a page it
	 * lays ABOVE the bar, and `.phone-bar` pads by `--sab`, so without this the
	 * destinations grow a band of their own grey that nothing draws in. The
	 * flight app installs it from its own App; this shell is separate and had
	 * simply never been wired to it, which made the two apps answer the same
	 * browser differently. Latent on the measured device (Chrome reports 0 px
	 * there, buttons and gestures alike), real wherever one reports an inset it
	 * keeps the page clear of.
	 */
	onMount(() => watchSafeArea());

	/* The night theme's raster brightness. `--night-dim` is read by app.css,
	   which both apps share, and PUBLISHED by the app shell, which they do
	   not: this one never published it, so its map dimmed at the CSS
	   fallback and a value set on the shared origin next door did nothing
	   here. The flight app's own line (src/App.svelte). */
	$effect(() => {
		document.documentElement.style.setProperty('--night-dim', String(nightDim.pct / 100));
	});

	let stage: HTMLDivElement;
	const dockB = $derived(workspace.dockPx.bottom);
	// The right dock too: a phone held sideways docks the detail pane on the
	// right, and a desktop can dock the panel chart there. Published as 0 and
	// reserved nowhere, every such surface was 0 px wide, the detail opened
	// on a tap invisible and its close with it.
	const dockR = $derived(workspace.dockPx.right);
	onMount(() => {
		const measure = (): void => {
			const r = stage.getBoundingClientRect();
			applyStageVars({
				left: r.left,
				top: r.top,
				width: r.width,
				height: r.height,
				dockB: workspace.dockPx.bottom,
				dockR: workspace.dockPx.right,
			});
			setStageSize(r.width, r.height);
		};
		measure();
		return observeBox(stage, measure);
	});
	$effect(() => {
		// Re-publish when the pane resizes, which the box observer cannot see:
		// the spacer changes the stage's CHILDREN, not the stage.
		void dockB;
		void dockR;
		if (stage) {
			const r = stage.getBoundingClientRect();
			applyStageVars({
				left: r.left,
				top: r.top,
				width: r.width,
				height: r.height,
				dockB,
				dockR,
			});
		}
	});

	// A coarse pointer is the app's one definition of being touched, and every
	// 44px control keys off it through :root.touch-ui (app.css).
	onMount(() => {
		const coarse = window.matchMedia('(pointer: coarse)');
		const apply = (): void => {
			document.documentElement.classList.toggle('touch-ui', coarse.matches);
		};
		apply();
		coarse.addEventListener('change', apply);
		return () => coarse.removeEventListener('change', apply);
	});
</script>

<div class="viewer">
	<Toolbar />
	<div class="viewer-body">
		<div class="viewer-panel" class:page={ui.isMobile} class:hidden={ui.isMobile && !briefingPage}>
			<!-- Measured, not guessed: the world corpus shows 9 148 rows in the
			     default period, 79 363 DOM nodes and a 4.5 s task to build them.
			     400 is about what a reader scrolls before searching instead, and
			     the rest is one click away. -->
			<div class="viewer-panel-body">
				<NotamsTab maxRows={400} bind:showLoader={loaderOpen}>
					{#snippet loader({ onLoaded, onGaps }: { onLoaded: () => void; onGaps: () => void })}
						<BriefingLoader
							onLoaded={() => {
								onLoaded();
								// The buttons say "Fetch briefing" and "Display on
								// map", and on a phone the briefing is a PAGE over
								// the map, so a load that succeeded has to hand the
								// screen back or the map it drew on is the one
								// thing the reader cannot see. Only on a CLEAN
								// load: BriefingLoader routes a briefing short of a
								// corridor to onGaps instead, and that amber chip
								// is on this page.
								if (ui.isMobile) {
									briefingPage = false;
								}
								void fitLoaded();
							}}
							{onGaps}
						/>
					{/snippet}
				</NotamsTab>
			</div>
		</div>
		<div class="viewer-stage" bind:this={stage}>
			<div class="viewer-stage-main">
				<NotamMapView />
				{#if dockR > 0}
					<div class="dock-space" style:inline-size="{dockR}px"></div>
				{/if}
			</div>
			<div class="dock-space" style:block-size="{dockB}px"></div>
		</div>
	</div>

	{#if ui.isMobile}
		<!-- Three destinations: where the briefing is drawn, where it is listed,
		     and where one is loaded. The third is not a duplicate of the tab
		     head's own button but the only LABELLED way back to the paste box,
		     which is what this app is for. Map stays first: it is where a load
		     hands you. -->
		<nav class="phone-bar" aria-label={t.tabs.notams}>
			<button
				class="phone-dest"
				aria-current={!briefingPage}
				onclick={() => (briefingPage = false)}
			>
				<Icon name="map" />
				<span>{t.tabs.map}</span>
			</button>
			<button
				class="phone-dest"
				aria-current={briefingPage && !loaderShowing}
				onclick={() => {
					briefingPage = true;
					loaderOpen = false;
				}}
			>
				<Icon name="file-text" />
				<span>{t.tabs.notams}</span>
			</button>
			<button
				class="phone-dest"
				aria-current={loaderShowing}
				onclick={() => {
					briefingPage = true;
					loaderOpen = true;
				}}
			>
				<Icon name="download" />
				<span>{t.viewer.barLoad}</span>
			</button>
		</nav>
	{/if}

	<AboutSurface />
	<DetailPanel />
	<DetailSurface />
	<!-- The detail panels' own altitude profile, mounted beside them rather
	     than inside: on a phone the detail is a pane surface, and a chart
	     mounted in it went with the panel it evicted
	     (state/airspaceProfileModal.svelte.ts). -->
	<PanelProfileModal />
	<!-- The NOTAMs tab's Print button is SHARED, so mounting its host is
	     what makes that button do anything: requestNotamPrint only bumps a
	     counter, and with nobody listening the control was live, labelled
	     and inert here (measured: window.print called zero times). Printing
	     a briefing is squarely this app's business, so the host comes over
	     rather than the button going away. -->
	<NotamPrintHost />
</div>
