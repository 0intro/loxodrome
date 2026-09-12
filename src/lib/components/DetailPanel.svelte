<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/state/i18n.svelte';
	import Icon from './Icon.svelte';
	import NotamDetail from './detail/NotamDetail.svelte';
	import AirportDetail from './detail/AirportDetail.svelte';
	import AirspaceDetail from './detail/AirspaceDetail.svelte';
	import ObstacleDetail from './detail/ObstacleDetail.svelte';
	import NavaidDetail from './detail/NavaidDetail.svelte';
	import NatureDetail from './detail/NatureDetail.svelte';
	import SupAipDetail from './detail/SupAipDetail.svelte';
	import SigmetDetail from './detail/SigmetDetail.svelte';
	import MetarStationDetail from './detail/MetarStationDetail.svelte';
	import {
		ui,
		closeDetail,
		goBack,
		selectNotam,
		type DetailTarget,
	} from '$lib/state/ui.svelte';
	import { notamState, selectedNotam } from '$lib/state/notam.svelte';
	import { orderedVisibleNotams } from '$lib/state/notamOrder.svelte';
	import {
		selectedAirport,
		selectedAirspace,
		selectedObstacle,
		selectedNavaid,
		selectedNature,
		selectedSupaip,
		navaidById,
		natureById,
		supaipById,
	} from '$lib/state/data.svelte';
	import {
		startResize,
		nudgeResize,
		loadPanelWidth,
		savePanelWidth,
		type ResizeOptions,
	} from '$lib/ui/resize';
	import { registerBackClose } from '$lib/ui/backClose';
	import { openRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { openNavProfile } from '$lib/state/navProfileModal.svelte';
	import { setDockPx, workspace } from '$lib/state/workspace.svelte';
	import { startSheetDrag, MIN_OPEN_FRAC, FLICK } from '$lib/ui/sheet';
	import { mapState } from '$lib/state/map.svelte';
	import { flyToVisible, flyToBoundsVisible } from '$lib/map/focus';
	import { focusNotam } from '$lib/map/notamLayer';
	import { focusSupBbox } from '$lib/map/supaipLayer';
	import { focusSigmet } from '$lib/map/sigmetLayer';
	import { selectedSigmet, sigmetRings } from '$lib/state/sigmets.svelte';
	import { selectedStation } from '$lib/state/metarStations.svelte';
	import { sigmetLabel } from '$lib/weather/sigmet';

	const notam = $derived(selectedNotam());
	const airport = $derived(selectedAirport());
	const airspace = $derived(selectedAirspace());
	const obstacle = $derived(selectedObstacle());
	const navaid = $derived(selectedNavaid());
	const nature = $derived(selectedNature());
	const supaip = $derived(selectedSupaip());
	const supaipZone = $derived(
		ui.detail?.kind === 'supaip' ? ui.detail.zone : undefined,
	);
	const sigmet = $derived(selectedSigmet());
	const station = $derived(selectedStation());
	const open = $derived(
		notam !== null ||
			airport !== null ||
			airspace !== null ||
			obstacle !== null ||
			navaid !== null ||
			nature !== null ||
			supaip !== null ||
			sigmet !== null ||
			station !== null,
	);
	const title = $derived(
		notam?.id ??
			airport?.ident ??
			airspace?.id ??
			obstacle?.name ??
			navaid?.ident ??
			nature?.name ??
			supaip?.title ??
			station?.id ??
			(sigmet ? sigmetLabel(sigmet, t.weather.sigmet) : '') ??
			'',
	);
	const subtitle = $derived(
		notam
			? t.detail.notamSubtitle
			: airport
				? t.detail.airport
				: airspace
					? t.detail.airspace
					: obstacle
						? t.data.obstacleTypes[obstacle.type]
						: navaid
							? t.data.navaidTypes[navaid.type]
							: nature
								? (nature.type === 'SENSITIVE' ? t.detail.sensitiveSite : t.detail.natureReserve)
								: supaip
									? t.detail.supAip
									: sigmet
										? 'SIGMET'
										: station
											? t.detail.metarStation
											: '',
	);

	// The header crosshair centres the map on the selected item, reusing each
	// kind's existing focus helper. Everything with an extent (NOTAM,
	// airspace, SUP AIP, SIGMET) flies to its bbox by the same recipe, the
	// zoom cap differing only by how large that kind of feature typically
	// is; point features pan at the current zoom. No-op without a live map.
	function centerSelected(): void {
		const map = mapState.map;
		if (!map) {
			return;
		}
		// On phones, drop the sheet to half first so the flight is visible in
		// the map strip above it (a full-height sheet would hide the result).
		if (ui.isMobile && ui.detailHeight > 0.5) {
			ui.detailHeight = 0.5;
		}
		if (notam) {
			focusNotam(map, notam);
		} else if (airport) {
			flyToVisible({ lat: airport.lat, lng: airport.lon });
		} else if (airspace) {
			const b = airspace.bbox;
			flyToBoundsVisible(
				map,
				[
					[b.minLat, b.minLon],
					[b.maxLat, b.maxLon],
				],
				40,
				12,
			);
		} else if (obstacle) {
			flyToVisible({ lat: obstacle.lat, lng: obstacle.lon });
		} else if (navaid) {
			flyToVisible({ lat: navaid.lat, lng: navaid.lon });
		} else if (nature) {
			flyToVisible({ lat: nature.lat, lng: nature.lon });
		} else if (supaip) {
			const bbox =
				supaipZone != null
					? (supaip.zones[supaipZone]?.bbox ?? supaip.bbox)
					: supaip.bbox;
			focusSupBbox(map, bbox);
		} else if (sigmet) {
			focusSigmet(map, { sigmet, rings: sigmetRings(sigmet) });
		} else if (station) {
			flyToVisible({ lat: station.lat, lng: station.lon });
		}
	}

	// Greys out the crosshair when the selection has no usable geometry: a
	// text-only NOTAM, or a SUP AIP whose PDF yielded no coordinates.
	const canCenter = $derived(
		airport != null ||
			airspace != null ||
			navaid != null ||
			nature != null ||
			obstacle != null ||
			(notam != null && notam.coordinates.length > 0) ||
			(supaip != null &&
				(supaipZone != null
					? (supaip.zones[supaipZone]?.bbox ?? supaip.bbox) != null
					: supaip.bbox != null)) ||
			(sigmet != null && sigmetRings(sigmet).length > 0) ||
			station != null,
	);

	// Whole sentences per kind (t.detail.backTo*), so French prepositions
	// contract correctly ("Retour au NOTAM", "Retour à l'aérodrome").
	// A detail opened from a vertical-profile modal carries the one-shot
	// ui.detailFromProfile marker instead of a back target (the two are
	// mutually exclusive): its back arrow reopens that modal.
	const backLabel = $derived.by(() => {
		if (ui.detailFromProfile === 'route') {
			return t.detail.backToVerticalProfile;
		}
		if (ui.detailFromProfile === 'trace') {
			return t.detail.backToTraceProfile;
		}
		const b = ui.detailBack;
		if (!b) {
			return '';
		}
		if (b.kind === 'notam') {
			const n = notamState.notams[b.index];
			return n ? t.detail.backToNotam(n.id) : '';
		}
		if (b.kind === 'airport') {
			return t.detail.backToAirport(b.id);
		}
		if (b.kind === 'obstacle') {
			return t.detail.backToObstacle(b.id);
		}
		if (b.kind === 'navaid') {
			// Navaid ids ("DME:1527279") aren't user-facing; show the ident.
			return t.detail.backToNavaid(navaidById(b.id)?.ident ?? '').trimEnd();
		}
		if (b.kind === 'nature') {
			return t.detail.backToNature(natureById(b.id)?.name ?? '').trimEnd();
		}
		if (b.kind === 'supaip') {
			// SUP AIP ids ("metropole-2026-012") aren't user-facing; show title.
			return t.detail.backToSupaip(supaipById(b.id)?.title ?? '').trimEnd();
		}
		if (b.kind === 'sigmet') {
			return t.detail.backToSigmet;
		}
		if (b.kind === 'station') {
			return t.detail.backToStation(b.id);
		}
		// b.key is "id|name"; show the user-facing id, not the synthetic key.
		return t.detail.backToAirspace(b.key.split('|', 1)[0]);
	});

	// Back to a vertical profile reopens that modal over the panel (its saved
	// window restores the exact view left behind); the marker is consumed so
	// a later close falls back to normal behavior.
	function onBack(): void {
		const origin = ui.detailFromProfile;
		if (origin) {
			ui.detailFromProfile = null;
			if (origin === 'trace') {
				openNavProfile();
			} else {
				openRouteProfile();
			}
			return;
		}
		goBack();
	}

	// Prev/Next stepper, shown only for a NOTAM panel opened from the NOTAMs tab
	// (the selection carries `fromList`). It walks orderedVisibleNotams() (the
	// canonical SOFIA-Briefing PIB order), the SAME sequence the NOTAMs tab
	// renders, so the position and the steps match the list exactly and reading
	// it here tracks every filter; null (no stepper) for map / cross-link
	// selections, a single visible entry, or a current NOTAM the filters have
	// since removed from the list.
	const notamNav = $derived.by(() => {
		const d = ui.detail;
		if (d?.kind !== 'notam' || !d.fromList) {
			return null;
		}
		const list = orderedVisibleNotams();
		if (list.length <= 1) {
			return null;
		}
		const pos = list.findIndex((it) => it.index === d.index);
		if (pos === -1) {
			return null;
		}
		return {
			pos,
			total: list.length,
			prev: pos > 0 ? list[pos - 1].index : null,
			next: pos < list.length - 1 ? list[pos + 1].index : null,
		};
	});

	// Step to another list entry, mirroring NotamsTab.onSelect (select +
	// recentre the map). Keeps fromList=true so the stepper persists across steps.
	function stepTo(index: number): void {
		selectNotam(index, true);
		const n = notamState.notams[index];
		if (mapState.map && n) {
			focusNotam(mapState.map, n);
		}
	}

	// Left/Right arrow keys step the list while a list-opened NOTAM is shown.
	// Inert otherwise; skip when typing in a field, when the resize handle has
	// focus (it nudges width with arrows) or the map is focused (Leaflet pans
	// with arrows), and ignore modifier combos.
	function onKeydown(e: KeyboardEvent): void {
		if (!notamNav || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
			return;
		}
		const t = e.target;
		if (
			t instanceof HTMLElement &&
			(t.tagName === 'INPUT' ||
				t.tagName === 'TEXTAREA' ||
				t.tagName === 'SELECT' ||
				t.isContentEditable ||
				t.closest('.resize-handle') ||
				t.closest('.leaflet-container'))
		) {
			return;
		}
		if (e.key === 'ArrowLeft' && notamNav.prev !== null) {
			e.preventDefault();
			stepTo(notamNav.prev);
		} else if (e.key === 'ArrowRight' && notamNav.next !== null) {
			e.preventDefault();
			stepTo(notamNav.next);
		}
	}

	const WIDTH_KEY = 'loxodrome:detail-width';
	// The handle sits on the panel's left edge, so dragging right shrinks it.
	const RESIZE: ResizeOptions = { dir: -1, min: 320, max: 760 };

	let panelWidth = $state(loadPanelWidth(WIDTH_KEY, 480));

	function onResizeStart(e: PointerEvent): void {
		startResize(
			e,
			panelWidth,
			RESIZE,
			(w) => (panelWidth = w),
			(w) => savePanelWidth(WIDTH_KEY, w),
		);
	}

	function onResizeKey(e: KeyboardEvent): void {
		const w = nudgeResize(e, panelWidth, RESIZE);
		if (w !== null) {
			panelWidth = w;
			savePanelWidth(WIDTH_KEY, w);
		}
	}

	// Mobile: the detail is the second bottom sheet, with the SAME drag feel
	// as the sidebar sheet (Sidebar.svelte): the grip drags it to any height,
	// a release below MIN_OPEN_FRAC or a downward flick dismisses it, a tap
	// toggles the half / full presets. Live px height while dragging; at rest
	// the ui.detailHeight fraction owns it (remembered across opens).
	let dragHeight = $state<number | null>(null);

	/* The fraction is of the whole workspace, which is what the sheet is
	 * anchored to: it sits on the screen's bottom edge like the sidebar sheet
	 * and grows upward OVER the tab bar and any bottom dock, both of which
	 * are reserved space below it. (While the sheet cleared the dock instead,
	 * the fraction had to exclude it, or the sheet's top went negative and
	 * .workspace's `overflow: clip` cut the grip and the close button off.) */
	const sheetHeightStyle = $derived(
		!ui.isMobile
			? undefined
			: dragHeight !== null
				? `${dragHeight}px`
				: `calc((100% - var(--kb, 0px)) * ${ui.detailHeight})`,
	);

	// At (rested) full height, flatten the top corners so the sheet meets the
	// toolbar seamlessly (the Sidebar full-height rule).
	const atFull = $derived(
		ui.isMobile && open && dragHeight === null && ui.detailHeight >= 0.995,
	);

	/* At frac 1 the sheet is the whole workspace, so it covers the map
	   whatever the bar and the dock below it hold. `atFull` is the cosmetic
	   corner-flattening; this is the one the Leaflet-control rule needs. */
	const coversMap = $derived(ui.isMobile && open && ui.detailHeight >= 0.995);

	/** Height available to a bottom sheet: the workspace's padding box, which
	 *  is the 100% the fraction is of. The sheet may grow over the tab bar
	 *  and a bottom dock, so nothing is subtracted. */
	function availableSheetPx(sheet: HTMLElement): number {
		return Math.max(1, sheet.parentElement?.clientHeight ?? window.innerHeight);
	}

	function toggleSnap(): void {
		ui.detailHeight = ui.detailHeight < 0.9 ? 1 : 0.5;
	}

	function onGripDown(e: PointerEvent): void {
		const sheet = (e.currentTarget as HTMLElement).closest('.detail');
		if (!(sheet instanceof HTMLElement)) {
			return;
		}
		// The workspace is the sheet's containing block; its height is the 100%.
		const max = availableSheetPx(sheet);
		startSheetDrag(e, {
			startHeight: sheet.getBoundingClientRect().height,
			min: 80,
			max,
			onMove: (h) => (dragHeight = h),
			onRelease: (h, velocity) => {
				dragHeight = null;
				const frac = h / max;
				if (velocity < -FLICK || frac < MIN_OPEN_FRAC) {
					closeDetail();
				} else {
					ui.detailHeight = velocity > FLICK ? 1 : Math.min(1, frac);
				}
			},
			onTap: toggleSnap,
		});
	}

	function onGripKey(e: KeyboardEvent): void {
		if (e.key === 'ArrowUp') {
			e.preventDefault();
			ui.detailHeight = Math.min(1, ui.detailHeight + 0.1);
		} else if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (ui.detailHeight <= MIN_OPEN_FRAC) {
				closeDetail();
			} else {
				ui.detailHeight = Math.max(MIN_OPEN_FRAC, ui.detailHeight - 0.1);
			}
		} else if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggleSnap();
		}
	}

	// On phones the detail sheet replaces the sidebar sheet: opening it drops
	// the sidebar to its peek so the map (not the tab panel) shows above the
	// detail, and closing restores the sidebar as the user had it. The saved
	// collapse state is incidental, not a dependency, hence untrack.
	$effect(() => {
		if (!ui.isMobile || !open) {
			return;
		}
		const wasCollapsed = untrack(() => ui.sidebarCollapsed);
		ui.sidebarCollapsed = true;
		return () => {
			ui.sidebarCollapsed = wasCollapsed;
		};
	});

	// A bottom dock wants the same edge, and on a phone the three of them
	// leave the map a sliver. Same rule as the sidebar above: the dock drops
	// to its floor while the detail sheet is up, and comes back afterwards,
	// unless the user resized it meanwhile, which is a deliberate choice and
	// outranks what it was before.
	$effect(() => {
		if (!ui.isMobile || !open || workspace.dockBottom === null) {
			return;
		}
		const was = untrack(() => workspace.dockPx.bottom);
		setDockPx('bottom', 0);
		const floored = untrack(() => workspace.dockPx.bottom);
		return () => {
			if (workspace.dockPx.bottom === floored) {
				setDockPx('bottom', was);
			}
		};
	});

	// Per-target scroll memory; when navigating between linked panels
	// (e.g. airport → NOTAM → back), restore the previous panel's scroll
	// position rather than jumping to the top. Local non-reactive cache;
	// the map of remembered offsets is small (one entry per visited
	// target) and lives for the page lifetime.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const scrollPositions = new Map<string, number>();
	let scrollEl = $state<HTMLDivElement>();
	let prevDetail: DetailTarget | null = null;

	function scrollKey(t: DetailTarget): string {
		if (t.kind === 'notam') {
			return `notam:${t.index}`;
		}
		if (t.kind === 'airspace') {
			return `airspace:${t.key}`;
		}
		return `${t.kind}:${t.id}`;
	}

	function onDetailScroll(): void {
		// Save the current target's scroll position each time the user
		// scrolls; by the time `ui.detail` changes, scrollTop already
		// reflects the new panel, so we have to capture continuously.
		if (prevDetail && scrollEl) {
			scrollPositions.set(scrollKey(prevDetail), scrollEl.scrollTop);
		}
	}

	$effect(() => {
		const next = ui.detail;
		prevDetail = next;
		if (!next) {
			return;
		}
		const saved = scrollPositions.get(scrollKey(next)) ?? 0;
		// Defer until the new panel's content has rendered.
		requestAnimationFrame(() => {
			if (scrollEl) {
				scrollEl.scrollTop = saved;
			}
		});
	});

	// System/browser Back closes the open panel (the Android back gesture).
	// Keyed on `open` only: linked-panel navigation keeps it true, so one
	// history entry per panel session, and Back dismisses the whole panel.
	$effect(() => {
		if (!open) {
			return;
		}
		return registerBackClose(closeDetail);
	});
</script>

<svelte:window onkeydown={onKeydown} />

<aside
	class="detail"
	class:open
	class:mobile={ui.isMobile}
	class:full={atFull}
	class:covers-map={coversMap}
	class:dragging={dragHeight !== null}
	style:width={ui.isMobile ? undefined : `${panelWidth}px`}
	style:height={sheetHeightStyle}
	aria-hidden={!open}
>
	{#if open}
		{#if ui.isMobile}
			<button
				class="detail-grip"
				aria-label={t.common.resizeDetail}
				onpointerdown={onGripDown}
				onkeydown={onGripKey}
			>
				<span class="grip-bar"></span>
			</button>
		{/if}
		{#if !ui.isMobile}
			<button
				class="resize-handle"
				aria-label={t.common.resizeDetail}
				onpointerdown={onResizeStart}
				onkeydown={onResizeKey}
			></button>
		{/if}
		<header class="detail-head">
			{#if backLabel}
				<button class="back-btn" onclick={onBack}>
					<Icon name="chevron-left" size={14} />
					<span>{backLabel}</span>
				</button>
			{/if}
			{#if notamNav}
				<nav class="notam-nav" aria-label={t.common.stepThroughList}>
					<button
						class="step-btn"
						disabled={notamNav.prev === null}
						onclick={() => notamNav.prev !== null && stepTo(notamNav.prev)}
						aria-label={t.common.prevNotam}
					>
						<Icon name="chevron-left" size={14} />
						<span>{t.common.prev}</span>
					</button>
					<span class="step-pos">{notamNav.pos + 1} / {notamNav.total}</span>
					<button
						class="step-btn"
						disabled={notamNav.next === null}
						onclick={() => notamNav.next !== null && stepTo(notamNav.next)}
						aria-label={t.common.nextNotam}
					>
						<span>{t.common.next}</span>
						<Icon name="chevron-right" size={14} />
					</button>
				</nav>
			{/if}
			<div class="detail-headline">
				<div class="detail-heading">
					<div class="detail-id">{title}</div>
					<div class="detail-sub">{subtitle}</div>
				</div>
				<div class="detail-actions">
					<button
						class="icon-btn"
						onclick={centerSelected}
						disabled={!canCenter}
						aria-label={t.common.centerMapAria}
						title={t.common.centerMap}
					>
						<Icon name="crosshair" />
					</button>
					<button
						class="icon-btn"
						onclick={closeDetail}
						aria-label={t.common.closeDetail}
					>
						<Icon name="x" />
					</button>
				</div>
			</div>
		</header>
		<div
			class="detail-scroll"
			bind:this={scrollEl}
			onscroll={onDetailScroll}
		>
			{#if notam}
				<NotamDetail {notam} />
			{:else if airport}
				<AirportDetail {airport} />
			{:else if airspace}
				<AirspaceDetail {airspace} />
			{:else if obstacle}
				<ObstacleDetail {obstacle} />
			{:else if navaid}
				<NavaidDetail {navaid} />
			{:else if nature}
				<NatureDetail {nature} />
			{:else if supaip}
				<SupAipDetail {supaip} zoneIndex={supaipZone} />
			{:else if sigmet}
				<SigmetDetail {sigmet} />
			{:else if station}
				<MetarStationDetail {station} />
			{/if}
		</div>
	{/if}
</aside>

<style>
	/* The panel is an overlay: it covers part of the map, and map/focus.ts
	   shifts the centre by its width so a selection still lands where the
	   user can see it. The docks are not overlays, they hold reserved space,
	   so the panel keeps clear of both (each var is 0 when its slot is
	   empty): above the bottom dock, left of the side dock. */
	.detail {
		position: absolute;
		top: 0;
		right: var(--dock-r, 0);
		bottom: var(--dock-b, 0);
		display: flex;
		flex-direction: column;

		/* 100% is the workspace, which includes the sidebar: with a wide side
		   dock the panel could otherwise start left of the stage and paint over
		   the sidebar (520 > 500). Hold it to the stage instead. */
		max-width: calc(100vw - var(--stage-l, 0px) - var(--dock-r, 0px));
		background: var(--surface);
		border-left: 1px solid var(--border);
		box-shadow: var(--shadow-2);

		/* Parked off-screen while closed. The 105% is of the panel's OWN width,
		   which only clears the workspace when its `right` inset is 0: with a
		   side dock the panel is inset by --dock-r, so the park fell short by
		   exactly that and left an empty white panel sitting over the dock
		   (invisible until the z-index above put it there). Clear the inset
		   too. */
		transform: translateX(calc(105% + var(--dock-r, 0px)));
		transition: transform 0.18s ease;

		/* Above a paged surface (1090), below the modal backdrop (1099): a
		   page takes the map's own box, and the panel has always overlaid the
		   map. Under it, clicking a list row opened the panel invisibly
		   behind the workbook and it stayed Tab-reachable while hidden. */
		z-index: 1092;
	}

	.detail.open {
		transform: translateX(0);
	}

	/* Mobile: the detail is a bottom sheet mirroring the sidebar sheet
	   (Sidebar.svelte .sidebar.mobile): bottom-anchored above the on-screen
	   keyboard, rounded top, grip-dragged height (inline style; the fraction
	   at rest), slide-in/out via translateY. */
	.detail.mobile {
		top: auto;
		bottom: var(--kb, 0);
		width: 100%;
		overflow: hidden;
		border-left: none;
		border-top: 1px solid var(--border);
		border-radius: 12px 12px 0 0;

		/* Safe area: the sheet owns the bottom screen edge, so it pads by the
		   share of the bottom inset nothing below it covers (0 off-device). */
		padding-bottom: var(--sheet-sab);

		/* Same as the desktop park: the bottom inset (the keyboard, all this
		   sheet is anchored above) has to be cleared on top of its own
		   height. */
		transform: translateY(calc(105% + var(--kb, 0px)));
		transition: transform 0.18s ease, height 0.22s ease, border-radius 0.15s ease;
	}

	.detail.mobile.open {
		transform: translateY(0);
	}

	.detail.mobile.dragging {
		transition: none;
	}

	/* Full height: flatten the top so the sheet meets the toolbar seamlessly
	   (the rounded corners would otherwise reveal a sliver of map). */
	.detail.mobile.full {
		border-top: none;
		border-radius: 0;
	}

	.detail-grip {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		height: 22px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: grab;
		touch-action: none;
	}

	.grip-bar {
		width: 36px;
		height: 4px;
		border-radius: 2px;
		background: var(--border-strong);
	}

	.resize-handle {
		position: absolute;
		top: 0;
		left: -3px;
		bottom: 0;
		width: 7px;
		padding: 0;
		border: none;
		background: transparent;
		cursor: col-resize;
		touch-action: none;
		z-index: 2;
	}

	.resize-handle:hover,
	.resize-handle:focus-visible {
		background: var(--accent);
		outline: none;
	}

	.detail-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--border);
	}

	.detail-headline {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	/* Keep the crosshair + close buttons clustered at the right edge;
	 * without the wrapper the headline's space-between would strand the
	 * crosshair in the middle of the header. */
	.detail-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.back-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		align-self: flex-start;
		padding: 2px 4px;
		margin-left: -4px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.back-btn:hover {
		color: var(--accent);
	}

	.back-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.notam-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.step-btn {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		padding: 2px 7px;
		font: inherit;
		font-size: 12px;
		color: var(--text-muted);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	.step-btn:hover:not(:disabled) {
		color: var(--accent);
		border-color: var(--accent);
	}

	.step-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}

	.step-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.step-pos {
		font-size: 11px;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.detail-id {
		font-size: 16px;
		font-weight: 700;
	}

	.detail-sub {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.detail-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 14px;
		overscroll-behavior: none;
	}

	/* Touch targets (the app.css .icon-btn pattern): grow the grip toward a
	   44px hit area with a taller button + invisible slop (downward-biased:
	   the sheet's overflow:hidden clips above the top edge), and bring the
	   stepper / back link to 44px effective via padding + slop. */
	@media (pointer: coarse) {
		.detail-grip {
			position: relative;
			height: 30px;
		}

		.detail-grip::after {
			content: '';
			position: absolute;
			inset: -7px 0;
		}

		.step-btn,
		.back-btn {
			position: relative;
			min-height: 36px;
		}

		.step-btn {
			padding: 6px 14px;
		}

		.back-btn {
			padding: 6px 8px;
		}

		.step-btn::after,
		.back-btn::after {
			content: '';
			position: absolute;
			inset: -4px 0;
		}
	}
</style>
