<script lang="ts">
	/* The phone's pages: the full-screen host for everything that is not
	 * read against the map (docs/workspace-surfaces.md "Phones"). One fixed
	 * container over the stage, the bar visible under it, a slim head (Back,
	 * the title, the page's Segmented sections) and a scrolling body that
	 * REUSES the desktop tab components. Not a workspace surface: a surface
	 * page evicts the docks, and a phone page must leave the pane where it
	 * is, to come back on Back.
	 *
	 * A page returns in the state it was left (EASA AMC1 SPA.EFB.100(b)(2)):
	 * the section is remembered in ui.pageSection, the tabs' own state lives
	 * in their modules, and the scroll position is remembered per page and
	 * section here, which also ends the old sheet's scroll leak between tabs
	 * (one panel body, one scrollTop for eight tabs). */
	import Icon from '../Icon.svelte';
	import Segmented from '../Segmented.svelte';
	import NotamsTab from '../tabs/NotamsTab.svelte';
	import AirportsTab from '../tabs/AirportsTab.svelte';
	import LayersTab from '../tabs/LayersTab.svelte';
	import SettingsTab from '../tabs/SettingsTab.svelte';
	import RouteTab from '../tabs/RouteTab.svelte';
	import AircraftTab from '../tabs/AircraftTab.svelte';
	import NavigationTab from '../tabs/NavigationTab.svelte';
	import WeatherTab from '../tabs/WeatherTab.svelte';
	import NearestAerodromes from './NearestAerodromes.svelte';
	import SupAipList from './SupAipList.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { routeDrivesTrafficMode } from '$lib/state/route.svelte';
	import NotamLoader from '$lib/components/NotamLoader.svelte';
	import { closePage, ui } from '$lib/state/ui.svelte';
	import { PAGE_SECTIONS, pageSection } from '$lib/state/phoneNav.svelte';
	import { registerBackClose } from '$lib/ui/backClose';
	import { openNavLog } from '$lib/state/navLogModal.svelte';
	import { openRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { toggleFlightPrep, type FlightPrepPage } from '$lib/state/flightPrepModal.svelte';

	const page = $derived(ui.page);
	const sections = $derived(page ? PAGE_SECTIONS[page] : []);
	const section = $derived(page ? pageSection(page) : null);
	const title = $derived(page ? t.tabs[page] : '');

	/* Two Plan sections are launchers: the log and the profile are read
	 *  against the map, so they open in the pane and the page steps aside
	 *  (the mock's decision: "opens beside the map and returns to it"). */
	function pick(id: string): void {
		if (!page) {
			return;
		}
		if (page === 'plan' && id === 'log') {
			closePage();
			openNavLog();
			return;
		}
		if (page === 'plan' && id === 'profile') {
			closePage();
			openRouteProfile();
			return;
		}
		ui.pageSection[page] = id;
	}

	const PREP_PAGES: { id: FlightPrepPage; label: () => string }[] = [
		{ id: 'dossier', label: () => t.flightprep.pageOverview },
		{ id: 'fuel', label: () => t.flightprep.pageFuel },
		{ id: 'mb', label: () => t.flightprep.pageMb },
		{ id: 'perf', label: () => t.flightprep.pagePerf },
	];

	/* One history entry per page SESSION: none per section, and none per
	 * page switch either. The effect reads a single boolean, never the page
	 * itself (the SurfaceShell doctrine): registerBackClose's release is an
	 * async history.back(), so re-registering on a switch pushes the new
	 * entry before the old back() lands and the position drifts down one
	 * entry each time, until a later release steps off the app's own
	 * entries and the page navigates away (measured: the Plan page's Log
	 * launcher left the app after three page switches). */
	const pageUp = $derived(page !== null);
	$effect(() => {
		if (!pageUp) {
			return;
		}
		return registerBackClose(closePage);
	});

	// Scroll memory per page and section, restored once the body has
	// rendered (the DetailPanel idiom).
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
	const scrollPositions = new Map<string, number>();
	let bodyEl = $state<HTMLDivElement>();
	let prevKey: string | null = null;

	function remember(): void {
		if (prevKey && bodyEl) {
			scrollPositions.set(prevKey, bodyEl.scrollTop);
		}
	}

	$effect(() => {
		const key = page ? `${page}:${section ?? ''}` : null;
		prevKey = key;
		if (!key) {
			return;
		}
		const saved = scrollPositions.get(key) ?? 0;
		// Next frame, once the body has rendered its content and has a
		// scroll range; cancelled on teardown so a page left inside that
		// frame does not have the outgoing page's offset written into it.
		const frame = requestAnimationFrame(() => {
			if (bodyEl) {
				bodyEl.scrollTop = saved;
			}
		});
		return () => cancelAnimationFrame(frame);
	});
</script>

{#if page}
	<section class="phone-page no-print" aria-label={title}>
		<header class="page-head">
			<button type="button" class="icon-btn" onclick={closePage} aria-label={t.common.back} title={t.common.back}>
				<Icon name="chevron-left" />
			</button>
			<!-- The sections take the head's one row, so the title yields to
			     them: the bar under the page already names the destination
			     (its label is the current one), and five Plan sections plus a
			     title do not fit a 392 px screen. Kept for the document
			     outline and for assistive tech, which is what reads it. -->
			<h1 class={sections.length > 1 ? 'sr-only' : undefined}>{title}</h1>
			{#if sections.length > 1}
				<div class="page-seg">
					<Segmented
						options={sections.map((s) => ({ value: s.id, label: t.tabs[s.key] }))}
						value={section ?? ''}
						onSelect={pick}
						ariaLabel={title}
					/>
				</div>
			{/if}
		</header>
		<div class="page-body" bind:this={bodyEl} onscroll={remember}>
			{#if page === 'airports'}
				{#if section === 'nearest'}
					<NearestAerodromes />
				{:else}
					<AirportsTab />
				{/if}
			{:else if page === 'brief'}
				{#if section === 'weather'}
					<WeatherTab />
				{:else if section === 'supaip'}
					<SupAipList />
				{:else}
					<NotamsTab rulesFromRoute={routeDrivesTrafficMode()}>
						{#snippet loader({ onLoaded, onGaps }: { onLoaded: () => void; onGaps: () => void })}
							<NotamLoader {onLoaded} {onGaps} />
						{/snippet}
					</NotamsTab>
				{/if}
			{:else if page === 'plan'}
				{#if section === 'aircraft'}
					<AircraftTab />
				{:else if section === 'prep'}
					<div class="tab-panel">
						<fieldset class="group">
							<legend>{t.route.flightPreparation}</legend>
							{#each PREP_PAGES as p (p.id)}
								<button type="button" class="prep-row" onclick={() => toggleFlightPrep(p.id)}>
									<span>{p.label()}</span>
									<Icon name="chevron-right" size={16} />
								</button>
							{/each}
						</fieldset>
					</div>
				{:else}
					<RouteTab />
				{/if}
			{:else if page === 'flight'}
				<NavigationTab section={section === 'alerts' ? 'alerts' : section === 'replay' ? 'replay' : 'flight'} />
			{:else if page === 'layers'}
				<LayersTab />
			{:else if page === 'settings'}
				<SettingsTab />
			{/if}
		</div>
	</section>
{/if}

<style>
	/* Over the stage and the pane (1090), under the popup band (1095), so
	   a sheet raised from a page still clears it; ends above the bar. */
	.phone-page {
		position: fixed;
		top: 0;
		right: 0;
		bottom: calc(var(--nav-h) + var(--sab));
		left: 0;
		z-index: 1093;
		display: flex;
		flex-direction: column;
		background: var(--surface);
	}

	/* Landscape: beside the rail, down to the bottom inset. */
	:global(:root.mobile-landscape) .phone-page {
		bottom: var(--sab);
		left: calc(var(--phone-rail-w) + var(--sal));
	}

	/* The head is the toolbar's twin: the same height and the same air above
	   and below its controls, because the two strips sit one under the other
	   as the pilot moves between the map and a page, and a control that
	   changes size across that move reads as a different control. --toolbar-h
	   less the 44 px touch target leaves HALF of it above and half below. */
	.page-head {
		display: flex;
		flex: 0 0 auto;
		gap: 8px;
		align-items: center;
		height: calc(var(--toolbar-h) + var(--sat));
		padding: var(--sat) max(6px, var(--sar)) 0 max(4px, var(--sal));
		border-bottom: 1px solid var(--border);
	}

	.page-head h1 {
		flex: 1 1 auto;
		margin: 0;
		font-size: 16px;
		font-weight: 700;
	}

	/* One row, always: the five Plan sections fit beside Back at this
	   padding on a 392 px screen, and the scroller is the fallback for a
	   narrower phone or a longer translation rather than the resting
	   state. Exactly 44 px tall, the toolbar icon's own height, borders
	   included; the touch floor that sizes a Segmented elsewhere would
	   make it 46 and leave the head two pixels taller than the toolbar. */
	.page-seg {
		display: flex;
		flex: 1 1 auto;
		justify-content: flex-end;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.page-seg::-webkit-scrollbar {
		display: none;
	}

	.page-seg :global(.seg) {
		height: 44px;
		flex: 0 0 auto;
	}

	/* ONE rule for the head's segments, and it must win: the Segmented's own
	   touch-ui floor (44px + the control's borders) carries the same
	   specificity, so two rules here left the winner to bundle order, which
	   is how the head came out 46px tall against the toolbar's 44. */
	.page-seg :global(.seg button) {
		min-height: 0;
		height: 100%;
		padding: 0 10px;
		font-size: 12px;
	}

	.page-body {
		flex: 1;
		min-height: 0;
		padding: 12px 12px calc(12px + var(--sheet-sab, 0px));
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.prep-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: 44px;
		padding: 6px 4px;
		font: inherit;
		color: var(--text);
		text-align: left;
		background: none;
		border: 0;
		border-bottom: 1px solid var(--border);
		cursor: pointer;
	}
</style>
