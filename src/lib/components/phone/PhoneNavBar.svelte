<script lang="ts">
	/* The phone's bottom navigation bar: five labeled destinations, fixed,
	 * never scrolling (docs/workspace-surfaces.md "Phones"; FAA AC 20-175:
	 * the menu in one place, the current location stated). Map is home;
	 * the other four open a page over the stage. 56 px, 64 px while a
	 * recording runs (the in-flight root class), plus the bottom inset. */
	import Icon from '../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { closePage, openPage, type PhonePage, ui } from '$lib/state/ui.svelte';
	import { clearFullSurface, goHome } from '$lib/state/phoneNav.svelte';

	type Dest = { id: PhonePage | 'map'; icon: string; key: 'map' | 'airports' | 'brief' | 'plan' | 'flight' };
	const DESTS: Dest[] = [
		{ id: 'map', icon: 'map', key: 'map' },
		{ id: 'airports', icon: 'aerodrome', key: 'airports' },
		{ id: 'brief', icon: 'file-text', key: 'brief' },
		{ id: 'plan', icon: 'route', key: 'plan' },
		{ id: 'flight', icon: 'navigation', key: 'flight' },
	];

	/** The page up, or the map. The layers and settings pages belong to no
	 *  destination, so none reads as current while they are up. */
	const active = $derived(ui.page ?? 'map');

	function go(id: PhonePage | 'map'): void {
		if (!clearFullSurface()) {
			return;
		}
		if (id === 'map') {
			goHome();
			return;
		}
		if (ui.page === id) {
			closePage();
			return;
		}
		openPage(id);
	}
</script>

<nav class="phone-bar" aria-label={t.common.navBar}>
	{#each DESTS as d (d.id)}
		<button
			type="button"
			class:active={active === d.id}
			aria-current={active === d.id ? 'page' : undefined}
			onclick={() => go(d.id)}
		>
			<Icon name={d.icon} size={22} />
			<span>{t.tabs[d.key]}</span>
		</button>
	{/each}
</nav>

<style>
	/* In flow at the bottom of the app column, so the workspace above it
	   (and with it the stage, the map and the pane) ends where it starts;
	   it owns the screen's bottom edge and pads by the inset. */
	.phone-bar {
		display: flex;
		flex: 0 0 auto;
		height: calc(var(--nav-h) + var(--sab));
		padding: 0 var(--sar) var(--sab) var(--sal);
		background: var(--surface);
		border-top: 1px solid var(--border);
		z-index: 600;
	}

	/* Landscape: a fixed rail down the left edge, the five destinations in
	   a column (icon over label), the toolbar and the map beside it
	   (App.svelte pads the column by --phone-rail-w). */
	:global(:root.mobile-landscape) .phone-bar {
		position: fixed;
		top: 0;
		bottom: 0;
		left: 0;
		flex-direction: column;
		width: calc(var(--phone-rail-w) + var(--sal));
		height: auto;
		padding: var(--sat) 0 var(--sab) var(--sal);
		border-top: 0;
		border-right: 1px solid var(--border);
	}

	button {
		display: flex;
		flex: 1 1 0;
		flex-direction: column;
		gap: 2px;
		align-items: center;
		justify-content: center;
		min-width: 0;
		padding: 0;
		font: inherit;
		font-size: 10px;
		line-height: 1;
		color: var(--text-muted);
		background: none;
		border: 0;
	}

	button.active {
		color: var(--accent);
	}

	button span {
		overflow: hidden;
		max-width: 100%;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
</style>
