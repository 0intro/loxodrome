<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { Airspace } from '$lib/data/airspaces';
	import { t } from '$lib/state/i18n.svelte';
	import {
		openAirspaceProfile,
		publishAirspaceProfile,
		releaseAirspaceProfile,
		type AirspaceProfileSubject,
	} from '$lib/state/airspaceProfileModal.svelte';
	import VerticalProfile from '$lib/components/VerticalProfile.svelte';
	import type { VerticalOverlay } from '$lib/components/verticalProfile';
	import AirspaceAboveLine from '$lib/components/AirspaceAboveLine.svelte';
	import { PAD_L, PAD_R, hiddenNoteText, windowColumns, windowNoteText } from '$lib/components/verticalProfile';
	import { useAirspaceHover } from '$lib/components/featureHover.svelte';
	import { altitudeProfileModel } from './altitudeProfileModel.svelte';

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

	/* What the surface plots when it is opened from here: this panel's own
	 * inputs, published as one fresh object whenever any of them moves. */
	const subject = $derived<AirspaceProfileSubject>({
		airspaces,
		heading,
		highlightKey,
		overlays,
		groundFt,
		lat,
		lon,
	});

	/* The inline chart and the surface derive from ONE model, so the
	 * thumbnail and the chart it opens cannot disagree. */
	const model = altitudeProfileModel(() => subject);
	const scope = $derived(model.scope);
	const shown = $derived(scope.shown);
	const hiddenNote = $derived(hiddenNoteText(scope, t.detail));
	const columns = $derived(model.columns);
	const win = $derived(model.win);
	const resolvedGroundFt = $derived(model.groundFt);
	const placed = $derived(windowColumns(columns, win, resolvedGroundFt));
	const windowNote = $derived(windowNoteText(win, placed, t.detail));

	// At more than this many airspaces the inline chart's column width
	// would shrink below ~6 px in the typical detail-panel width; show
	// a button that opens the modal instead.
	const INLINE_MAX = 30;

	// Measure the panel width so the inline SVG can be sized to fill it
	// exactly: columns scale to whatever (panel - padding) / N works out
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

	/* The surface lives outside this panel (PanelProfileModal, mounted once
	 * per app), and this instance is its owner token: it opens the chart over
	 * its own subject, keeps it current while it lives, and releases it when
	 * it goes (state/airspaceProfileModal.svelte.ts says what release means on
	 * a phone, where this panel going is what opening the chart does). */
	const token = {};

	function openModal(): void {
		openAirspaceProfile(token, subject);
	}

	$effect(() => {
		publishAirspaceProfile(token, subject);
	});

	onDestroy(() => releaseAirspaceProfile(token));

	/* Flash the hovered column's airspace on the map, then fall back to the
	 * panel's current airspace selection (or nothing). Mirrors the airspace
	 * list rows and the context menu, so a profile column is just another way
	 * to point at an airspace; useAirspaceHover holds the assert-and-restore
	 * effect (the chart can unmount under the pointer). */
	const hover = useAirspaceHover(() => shown);

	const countLabel = $derived(t.detail.airspaceCount(shown.length));
</script>

<!-- The section exists because the point HAS airspaces over it. What the
     chart then DRAWS is the pilot's own filters' business, and it says which
     one emptied it: gating on the drawn set instead took the heading, the
     chart and the controls off the panel together, leaving nothing to say a
     filter was in force (docs/map-profile.md). -->
{#if airspaces.length > 0}
	<section class="block" bind:this={panelEl}>
		<h3>{resolvedHeading}</h3>
		<AirspaceAboveLine above={model.above} groundFt={resolvedGroundFt} complete={model.aboveComplete} />
		{#if hiddenNote}
			<p class="win-note" title={t.detail.profileHiddenTip}>{hiddenNote}</p>
		{/if}
		{#if windowNote}
			<p class="win-note" title={t.detail.profileWindowTip}>{windowNote}</p>
		{/if}
		<!-- Gate on the set the chart actually draws, not the raw prop: the "only
		 on map" mode and the altitude window can both narrow a long list back
		 under the inline threshold. -->
		{#if placed.drawn.length <= INLINE_MAX}
			<!-- Inline chart. Click anywhere on it (including columns) to
			 open the modal. Per-column navigation is reserved for the
			 modal's wider, easier-to-aim chart. -->
			<button
				type="button"
				class="inline-trigger"
				onclick={openModal}
				title={t.detail.openAltitudeProfile}
			>
				<VerticalProfile
					columns={placed.drawn}
					overlays={model.overlays}
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
