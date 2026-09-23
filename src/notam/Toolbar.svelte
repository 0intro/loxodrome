<script lang="ts">
	/* The app's one bar: what is being shown, and the two controls that change
	 * it.
	 *
	 * ViewConditions is Loxodrome's own, mounted whole. The period and the
	 * level band are TOOLBAR chrome in both apps rather than list filters,
	 * because they govern the map as much as the list, and they have to be
	 * reachable with no briefing loaded.
	 */
	import HeadOverlay from '$lib/components/HeadOverlay.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import LanguageToggle from '$lib/components/LanguageToggle.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import ViewConditions from '$lib/components/ViewConditions.svelte';
	import LayersPopover from './LayersPopover.svelte';
	import SettingsPopover from './SettingsPopover.svelte';
	import { LOXODROME_URL } from './loxodrome';
	import { fitToNotams } from '$lib/map/notamLayer';
	import { openAbout } from '$lib/state/aboutModal.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { mapState } from '$lib/state/map.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { notamState, visibleNotams } from '$lib/state/notam.svelte';

	/* The mark the browser tab shows, shown again in the bar: one file, so
	   the two cannot drift. BASE_URL is /notam/ here, which is also what
	   puts it inside the mask's prefix rule. */
	const markSrc = `${import.meta.env.BASE_URL}favicon.svg`;

	let layersOpen = $state(false);
	let settingsOpen = $state(false);
	let menuOpen = $state(false);
	/* One anchor per popover, not one shared: both hang off their OWN head
	   button, and a single slot would put whichever opened second under the
	   button the first one was read from. */
	let layersAnchor = $state({ x: 0, y: 0 });
	let settingsAnchor = $state({ x: 0, y: 0 });

	const hasBriefing = $derived(notamState.notams.length > 0);

	/** The house anchor: the head button's left edge, 4 px below it. */
	function under(e: MouseEvent): { x: number; y: number } {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		return { x: r.left, y: r.bottom + 4 };
	}

	function openLayers(e: MouseEvent): void {
		layersAnchor = under(e);
		layersOpen = true;
	}

	function openSettings(e: MouseEvent): void {
		settingsAnchor = under(e);
		settingsOpen = true;
	}
</script>

<header class="viewer-bar">
	{#if ui.isMobile}
		<!-- The phone's app menu, on Loxodrome's own chrome: the brand, with a
		     caret, opens the app-level rows. Measured at 392 px the five icon
		     buttons left the viewing conditions 22 px wide and at 360 px two,
		     which is the bar's primary chrome crushed by its secondary one. -->
		<button
			class="logo-btn"
			onclick={() => (menuOpen = !menuOpen)}
			aria-expanded={menuOpen}
			aria-label={t.common.appMenu}
			title={t.common.appMenu}
		>
			<!-- i18n-ignore: the product name, identical in both catalogs -->
			<img class="brand-mark" src={markSrc} alt="NOTAM Viewer" width="20" height="20" />
			<Icon name="chevron-down" size={12} />
		</button>
	{:else}
		<!-- The brand lockup. The second line is the one piece of chrome that
		     outlives a loaded briefing, the loader's card being hidden once the
		     list replaces it; on a phone it moves into the menu's About, which
		     is where the relationship is explained anyway. -->
		<span class="brand">
			<!-- i18n-ignore: the product name, identical in both catalogs -->
			<span class="brand-name">NOTAM Viewer</span>
			<a
				class="brand-sibling"
				href={LOXODROME_URL}
				target="_blank"
				rel="noopener"
				title={t.viewer.siblingBadgeTip}>{t.viewer.siblingBadge}</a
			>
		</span>
	{/if}

	<ViewConditions />

	<div class="bar-actions">
		<button
			class="icon-btn"
			aria-label={t.common.fitMap}
			title={t.common.fitMap}
			disabled={!hasBriefing}
			onclick={() => {
				if (mapState.map) {
					fitToNotams(mapState.map, visibleNotams());
				}
			}}
		>
			<Icon name="crosshair" />
		</button>
		<button
			class="icon-btn"
			aria-label={t.layers.title}
			title={t.layers.title}
			aria-expanded={layersOpen}
			onclick={openLayers}
		>
			<Icon name="layers" />
		</button>
		<!-- Loxodrome's own two, mounted whole rather than copied. The language
		     button shows the locale IN FORCE, not the one a tap would switch
		     to, and carries the screen-reader announcement that goes with it;
		     a second spelling of either is how the two bars would come to
		     disagree about what the letters mean. -->
		{#if !ui.isMobile}
			<LanguageToggle />
			<ThemeToggle />
			<!-- The preferences this app exercises. Loxodrome puts Settings
			     above About in its own app menu; the desktop bar has no menu,
			     so the pair sit in that order as buttons. -->
			<button
				class="icon-btn"
				aria-label={t.display.title}
				title={t.display.title}
				aria-expanded={settingsOpen}
				onclick={openSettings}
			>
				<Icon name="sliders" />
			</button>
			<button
				class="icon-btn"
				aria-label={t.common.aboutApp}
				title={t.common.aboutApp}
				onclick={openAbout}
			>
				<Icon name="info" />
			</button>
		{/if}
	</div>
</header>

{#if ui.isMobile}
	<!-- The phone's own BOTTOM SHEET, the shared HeadOverlay chrome, so it has
	     the same presentation, Escape, system Back and swipe-down close as
	     every other sheet in both apps. The two toggles ride a strip at the
	     foot rather than becoming rows, which is what Loxodrome does with the
	     same components. -->
	<HeadOverlay
		open={menuOpen}
		x={0}
		y={0}
		title={t.common.appMenu}
		minWidthPx={220}
		onClose={() => (menuOpen = false)}
	>
		<!-- Above About, the order Loxodrome's own app menu uses. The sheet
		     has to go first: the popover anchors off the row, and the two
		     would otherwise be up at once. -->
		<button
			class="item more-item"
			onclick={(e) => {
				menuOpen = false;
				openSettings(e);
			}}
		>
			<Icon name="sliders" size={16} />
			<span>{t.display.title}</span>
		</button>
		<button
			class="item more-item"
			onclick={() => {
				menuOpen = false;
				openAbout();
			}}
		>
			<Icon name="info" size={16} />
			<span>{t.common.aboutApp}</span>
		</button>
		<a
			class="item more-item"
			href={LOXODROME_URL}
			target="_blank"
			rel="noopener"
			onclick={() => (menuOpen = false)}
		>
			<Icon name="map" size={16} />
			<span>{t.viewer.siblingBadge}</span>
		</a>
		<div class="more-toggles">
			<LanguageToggle />
			<ThemeToggle />
		</div>
	</HeadOverlay>
{/if}

<LayersPopover
	open={layersOpen}
	x={layersAnchor.x}
	y={layersAnchor.y}
	onClose={() => (layersOpen = false)}
/>

<SettingsPopover
	open={settingsOpen}
	x={settingsAnchor.x}
	y={settingsAnchor.y}
	onClose={() => (settingsOpen = false)}
/>

<style>
	.viewer-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 12px;
		border-block-end: 1px solid var(--border);
		background: var(--surface);
	}

	.brand {
		display: flex;
		flex-direction: column;
		line-height: 1.15;
		white-space: nowrap;
	}

	.brand-name {
		font-weight: 600;
	}

	/* The mark in the bar, the flight app's own idiom and only on the phone,
	   where the logo IS the menu's door. It is this app's own mark rather
	   than the site's (src/notam/public/favicon.svg, which says why), so the
	   two apps read apart at a glance in a tab strip and on a home screen.

	   It stands ALONE there, as Loxodrome's does, and the bar is the reason:
	   the name costs about 100 px of a 392 px row, and this bar's primary
	   chrome is the viewing conditions beside it. Carrying both crushed the
	   conditions to 30 px at 320 px wide, which is the crowding the menu was
	   built to end. The name is still on the tab, the About page and the
	   phone's own task switcher. */
	.brand-mark {
		flex: none;
		align-self: center;
		border-radius: 3px;
	}

	/* The menu's door on a phone, Loxodrome's own shape. 44 px because it is
	   the bar's one touch target there besides the two map buttons. */
	.logo-btn {
		display: inline-flex;
		flex: none;
		gap: 2px;
		align-items: center;
		block-size: 44px;
		padding: 0 6px 0 4px;
		border: 0;
		border-radius: var(--radius-sm);
		background: none;
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}

	/* The sheet's rows and the toggle strip at its foot, matching the flight
	   app's app menu: those styles are scoped to its own Toolbar, so the
	   shape is shared and the rule is not. */
	.more-item {
		display: flex;
		gap: 10px;
		align-items: center;
		inline-size: 100%;
		min-block-size: 44px;
		padding: 8px 10px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: start;
		text-decoration: none;
		cursor: pointer;
	}

	.more-item:hover,
	.more-item:focus-visible {
		background: var(--bg);
	}

	.more-toggles {
		display: flex;
		gap: 4px;
		margin-block-start: 2px;
		padding-block-start: 4px;
		border-block-start: 1px solid var(--border);
	}

	.brand-sibling {
		color: var(--muted);
		font-size: var(--fs-2xs);
		text-decoration: none;
	}

	.brand-sibling:hover,
	.brand-sibling:focus-visible {
		color: var(--accent);
		text-decoration: underline;
	}

	.bar-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-inline-start: auto;
	}
</style>
