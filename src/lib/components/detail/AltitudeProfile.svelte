<script lang="ts">
	import { onDestroy } from 'svelte';
	import { groundBandAtPoint } from '$lib/vertical/limits';
	import type { Airspace } from '$lib/data/airspaces';
	import { compareAirspaceByBand } from '$lib/data/airspaces';
	import { t } from '$lib/state/i18n.svelte';
	import { activeAltitudeBand } from '$lib/state/filter.svelte';
	import { profileAirspaces } from '$lib/state/profile.svelte';
	import { closeSurface, openSurface } from '$lib/state/workspace.svelte';
	import { elevationFtAt } from '$lib/map/terrain';
	import VerticalProfile from '$lib/components/VerticalProfile.svelte';
	import VerticalProfileModal from '$lib/components/VerticalProfileModal.svelte';
	import type { VerticalOverlay } from '$lib/components/verticalProfile';
	import AirspaceAboveLine from '$lib/components/AirspaceAboveLine.svelte';
	import {
		PAD_L,
		PAD_R,
		airspaceAbove,
		airspaceColumns,
		profileWindow,
		windowColumns,
		windowNoteText,
	} from '$lib/components/verticalProfile';
	import { airspaceNavigator, useAirspaceHover } from '$lib/components/featureHover.svelte';

	interface Props {
		/** Airspaces to plot, highest-band first (see airspacesOver). */
		airspaces: Airspace[];
		/** Section heading + modal/button label base. */
		heading?: string;
		/** SVG aria-label / title; defaults to the heading. */
		description?: string;
		/** `key` of the airspace to draw as the focus column (others dim).
		 *  Null for the NOTAM / aerodrome profiles, which highlight nothing. */
		highlightKey?: string | null;
		/** Extra overlay bands beyond the active-altitude-filter outline the
		 *  panel always draws (e.g. a NOTAM Q-line band). The altitude window
		 *  keeps them wholly visible, floor included, so no separate ceiling
		 *  contribution is needed. */
		overlays?: VerticalOverlay[];
		/** Ground elevation (ft) of the profiled point, drawn as a terrain band.
		 *  Pass this for an airport (its field elevation); otherwise pass `lat`/`lon`
		 *  and the terrain at that point is fetched. */
		groundFt?: number | null;
		lat?: number;
		lon?: number;
	}
	const {
		airspaces,
		heading,
		description,
		highlightKey = null,
		overlays = [],
		groundFt = null,
		lat,
		lon,
	}: Props = $props();

	// No t.* in a $props() fallback (docs/i18n.md rule 4): resolve the default
	// heading in a $derived so it follows the locale.
	const resolvedHeading = $derived(heading ?? t.detail.altitudeProfile);

	// Terrain ground for the profile's point. An explicit groundFt (an airport's
	// field elevation) wins; otherwise fetch the terrain at lat/lon once.
	let fetchedGroundFt = $state<number | null>(null);
	$effect(() => {
		if (groundFt != null || lat == null || lon == null) {
			fetchedGroundFt = null;
			return;
		}
		let stale = false;
		void elevationFtAt(lat, lon)
			.then((ft) => {
				if (!stale) fetchedGroundFt = ft;
			})
			.catch(() => {
				if (!stale) fetchedGroundFt = null;
			});
		return () => {
			stale = true;
		};
	});
	const resolvedGroundFt = $derived(groundFt ?? fetchedGroundFt);

	// At more than this many airspaces the inline chart's column width
	// would shrink below ~6 px in the typical detail-panel width; show
	// a button that opens the modal instead.
	const INLINE_MAX = 30;

	// Apply the global "all airspaces vs only those on the map" setting. The
	// highlighted airspace (the airspace panel's own subject) is always kept,
	// even when the "only on map" mode would otherwise filter it out.
	const shown = $derived.by(() => {
		const list = profileAirspaces(airspaces);
		if (highlightKey == null || list.some((a) => a.key === highlightKey)) {
			return list;
		}
		const sel = airspaces.find((a) => a.key === highlightKey);
		return sel ? [sel, ...list].sort(compareAirspaceByBand) : list;
	});

	const filterBand = $derived(activeAltitudeBand());

	// One shared column build (components/verticalProfile.ts airspaceColumns);
	// the vocab is read here, inside the $derived, so tooltips follow the
	// locale, and highlightKey marks this panel's own subject column.
	const columns = $derived(
		airspaceColumns(
			shown,
			// A single probed point, so the band's two ends are one reading.
			groundBandAtPoint(resolvedGroundFt),
			{
				unknownLimit: t.detail.unknownLimit,
				airspaceTypes: t.data.airspaceTypes,
			},
			highlightKey,
		),
	);

	// The axis is the band being flown, not the tallest column: one shared rule
	// (components/verticalProfile.ts). The panel's own overlays are must-show
	// bands, since on the NOTAM panel that F)/G) band IS the subject and its
	// floor can be FL 095 (which is what the retired overlayCeilingFt prop tried
	// to do, floor included). The inline chart draws this fitted window; the
	// surface owns the live one it can be zoomed to.
	const win = $derived(
		profileWindow({
			columns,
			band: filterBand,
			mustShow: overlays,
			groundFt: resolvedGroundFt,
		}),
	);
	const placed = $derived(windowColumns(columns, win, resolvedGroundFt));
	const windowNote = $derived(windowNoteText(win, placed, t.detail));

	// The actionable number the chart implies, over the whole stack. Suppressed
	// without a ground (the NOTAM panel), where the reference would be sea level.
	const above = $derived(airspaceAbove(columns, resolvedGroundFt));

	// The caller's overlays plus the active altitude filter window, drawn as a
	// dashed outline so it stays legible over any fill overlay. The chart drops
	// it while the band spans its whole window, which it does whenever the axis
	// IS the band.
	const allOverlays = $derived.by<VerticalOverlay[]>(() => {
		const out: VerticalOverlay[] = [...overlays];
		if (filterBand) {
			out.push({
				kind: 'outline',
				floorFt: filterBand.floor,
				ceilingFt: filterBand.ceiling,
				color: 'var(--text-muted)',
				label: t.detail.activeAltitudeFilter,
			});
		}
		return out;
	});

	// Measure the panel width so the inline SVG can be sized to fill it
	// exactly -- columns scale to whatever (panel - padding) / N works out
	// to, capped to a sensible max so a single-airspace chart doesn't blow
	// up to a 280 px column. No CSS stretch => no text distortion.
	const PAD_X = PAD_L + PAD_R; // the width the chart's axis costs
	let panelEl: HTMLElement | undefined = $state();
	let panelWidth = $state(280);

	$effect(() => {
		if (!panelEl) {
			return;
		}
		const ro = new ResizeObserver((entries) => {
			for (const e of entries) {
				panelWidth = e.contentRect.width;
			}
		});
		ro.observe(panelEl);
		return () => ro.disconnect();
	});

	const inlineColW = $derived.by(() => {
		// The DRAWN count: the window drops what lies entirely outside it, and
		// that width belongs to the columns that stayed.
		const n = placed.drawn.length;
		if (n === 0) return 6;
		const avail = Math.max(60, panelWidth - PAD_X);
		const ideal = Math.floor(avail / n);
		// Floor at 6 px (still legible as a thin dot column), cap at
		// 48 px so a single column doesn't span the whole panel.
		return Math.max(6, Math.min(48, ideal));
	});

	function openModal(): void {
		openSurface('airspaceProfile');
	}

	function closeModal(): void {
		closeSurface('airspaceProfile');
	}

	const navigateToColumn = airspaceNavigator('airspaceProfile', closeModal);

	/* The surface plots THIS panel's airspaces, so it goes when the panel
	 * does: a docked chart outlives its own close button otherwise. */
	onDestroy(closeModal);

	/* Flash the hovered column's airspace on the map, then fall back to the
	 * panel's current airspace selection (or nothing). Mirrors the airspace
	 * list rows and the context menu, so a profile column is just another way
	 * to point at an airspace; useAirspaceHover holds the assert-and-restore
	 * effect (the chart can unmount under the pointer). */
	const hover = useAirspaceHover(() => shown);

	const countLabel = $derived(t.detail.airspaceCount(shown.length));
</script>

{#if shown.length > 0}
	<section class="block" bind:this={panelEl}>
		<h3>{resolvedHeading}</h3>
		<AirspaceAboveLine {above} groundFt={resolvedGroundFt} />
		{#if windowNote}
			<p class="win-note" title={t.detail.profileWindowTip}>{windowNote}</p>
		{/if}
		<!-- Gate on the set the chart actually draws, not the raw prop: the "only
		 on map" mode and the altitude window can both narrow a long list back
		 under the inline threshold. -->
		{#if placed.drawn.length <= INLINE_MAX}
			<!-- Inline chart. Click anywhere on it (including columns) to
			 open the modal -- per-column navigation is reserved for the
			 modal's wider, easier-to-aim chart. -->
			<button
				type="button"
				class="inline-trigger"
				onclick={openModal}
				title={t.detail.openAltitudeProfile}
			>
				<VerticalProfile
					columns={placed.drawn}
					overlays={allOverlays}
					floorFt={win.floorFt}
					ceilingFt={win.ceilingFt}
					groundFt={resolvedGroundFt}
					title={description ?? resolvedHeading}
					minColumnPx={inlineColW}
					maxColumnPx={inlineColW}
					onColumnHover={hover.set}
				/>
			</button>
		{:else}
			<button
				type="button"
				class="profile-btn"
				onclick={openModal}
			>
				{t.detail.viewAltitudeProfile} ({countLabel})
			</button>
		{/if}
	</section>

	<!-- The mapProfile header rule (docs/map-profile.md): the title is the
	     altitude-profile literal, and the panel's own heading (what the chart
	     is over) is the subtitle line; a panel that named none adds nothing. -->
	<VerticalProfileModal
		id="airspaceProfile"
		title={t.detail.altitudeProfile}
		subtitle={heading}
		{columns}
		overlays={allOverlays}
		fitFloorFt={win.floorFt}
		fitCeilingFt={win.ceilingFt}
		groundFt={resolvedGroundFt}
		onColumnClick={navigateToColumn}
		onColumnHover={hover.set}
		onClose={closeModal}
	/>
{/if}

<style>
	.block {
		display: block;
		width: 100%;
	}

	/* What the altitude window crops, stated where the chart is. The tip carries
	   how to reach the rest. */
	.win-note {
		margin: 0 0 4px;
		font-size: 11px;
		color: var(--text-muted);
		cursor: help;
	}

	/* Same uppercased-muted section header style as AirspaceList,
	 * Coordinates, etc., so the inline chart slots into the detail
	 * panel's existing rhythm. */
	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.inline-trigger {
		display: block;
		width: 100%;
		margin-bottom: 6px;
		padding: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		text-align: left;
	}

	.inline-trigger:hover {
		filter: brightness(1.05);
	}

	.inline-trigger:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.profile-btn {
		display: block;
		width: 100%;
		padding: 8px 10px;
		margin-bottom: 6px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		text-align: center;
		color: var(--accent);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
		cursor: pointer;
	}

	.profile-btn:hover {
		background: var(--surface-3);
	}

	.profile-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
