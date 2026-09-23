<script lang="ts">
	/* The desktop sidebar: the tab rail and its panel beside the map. On a
	 * phone App.svelte mounts the bar and the pages instead
	 * (components/phone/, docs/workspace-surfaces.md "Phones"); the bottom
	 * sheet this component used to be there is gone with the 2026-09
	 * redesign. */
	import { t } from '$lib/state/i18n.svelte';
	import { routeDrivesTrafficMode } from '$lib/state/route.svelte';
	import NotamLoader from '$lib/components/NotamLoader.svelte';
	import Icon from './Icon.svelte';
	import NotamsTab from './tabs/NotamsTab.svelte';
	import AirportsTab from './tabs/AirportsTab.svelte';
	import LayersTab from './tabs/LayersTab.svelte';
	import SettingsTab from './tabs/SettingsTab.svelte';
	import RouteTab from './tabs/RouteTab.svelte';
	import AircraftTab from './tabs/AircraftTab.svelte';
	import NavigationTab from './tabs/NavigationTab.svelte';
	import WeatherTab from './tabs/WeatherTab.svelte';
	import { ui, selectTab, type SidebarTab } from '$lib/state/ui.svelte';
	import {
		startResize,
		nudgeResize,
		loadPanelWidth,
		savePanelWidth,
		type ResizeOptions,
	} from '$lib/ui/resize';

	// Labels resolve through t.tabs at render (never captured here: the
	// sidebar lives for the whole session, docs/i18n.md rule 2).
	// `sep` marks the entry OPENING a new rail group: 'group' is a gap
	// (briefing | planning | in-flight), 'settings' the stronger hairline
	// before the two settings tabs.
	type TabLabelKey = keyof typeof t.tabs;
	const TABS: { id: SidebarTab; labelKey: TabLabelKey; icon: string; sep?: 'group' | 'settings' }[] = [
		{ id: 'notams', labelKey: 'notams', icon: 'file-text' },
		{ id: 'airports', labelKey: 'airports', icon: 'aerodrome' },
		{ id: 'route', labelKey: 'route', icon: 'route', sep: 'group' },
		{ id: 'aircraft', labelKey: 'aircraft', icon: 'plane' },
		{ id: 'weather', labelKey: 'weather', icon: 'wind' },
		{ id: 'navigation', labelKey: 'navigation', icon: 'navigation', sep: 'group' },
		{ id: 'layers', labelKey: 'layers', icon: 'layers', sep: 'settings' },
		{ id: 'settings', labelKey: 'settings', icon: 'sliders' },
	];

	const WIDTH_KEY = 'loxodrome:sidebar-width';
	const RESIZE: ResizeOptions = { dir: 1, min: 280, max: 640 };

	let panelWidth = $state(loadPanelWidth(WIDTH_KEY, 400));

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
</script>

<aside class="sidebar" class:collapsed={ui.sidebarCollapsed}>
	<nav class="rail" aria-label={t.common.sidebarTabs}>
		{#each TABS as tab (tab.id)}
			<button
				class="rail-btn"
				class:group-start={tab.sep === 'group'}
				class:settings-start={tab.sep === 'settings'}
				class:active={ui.activeTab === tab.id && !ui.sidebarCollapsed}
				aria-current={ui.activeTab === tab.id && !ui.sidebarCollapsed ? 'true' : undefined}
				onclick={() => selectTab(tab.id)}
				title={t.tabs[tab.labelKey]}
				aria-label={t.tabs[tab.labelKey]}
			>
				<Icon name={tab.icon} />
				<span class="rail-label">{t.tabs[tab.labelKey]}</span>
			</button>
		{/each}
	</nav>

	{#if !ui.sidebarCollapsed}
		<div class="panel" style:width={`${panelWidth}px`}>
			<div class="panel-body">
				{#if ui.activeTab === 'notams'}
					<NotamsTab rulesFromRoute={routeDrivesTrafficMode()}>
						{#snippet loader({ onLoaded, onGaps }: { onLoaded: () => void; onGaps: () => void })}
							<NotamLoader {onLoaded} {onGaps} />
						{/snippet}
					</NotamsTab>
				{:else if ui.activeTab === 'airports'}
					<AirportsTab />
				{:else if ui.activeTab === 'route'}
					<RouteTab />
				{:else if ui.activeTab === 'aircraft'}
					<AircraftTab />
				{:else if ui.activeTab === 'weather'}
					<WeatherTab />
				{:else if ui.activeTab === 'navigation'}
					<NavigationTab />
				{:else if ui.activeTab === 'layers'}
					<LayersTab />
				{:else if ui.activeTab === 'settings'}
					<SettingsTab />
				{/if}
			</div>
			<button
				class="resize-handle"
				aria-label={t.common.resizeSidebar}
				onpointerdown={onResizeStart}
				onkeydown={onResizeKey}
			></button>
		</div>
	{/if}
</aside>

<style>
	.sidebar {
		display: flex;
		flex: 0 0 auto;
		background: var(--surface);
		z-index: 500;
	}

	.rail {
		display: flex;
		flex-direction: column;
		flex: 0 0 var(--rail-w);
		gap: 2px;
		padding: 6px 0;
		background: var(--surface-2);
		border-right: 1px solid var(--border);
	}

	.rail-btn {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
		padding: 8px 2px;
		border: none;
		border-left: 2px solid transparent;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.rail-btn:hover {
		color: var(--text);
		background: var(--surface-3);
	}

	.rail-btn.active {
		color: var(--accent);
		background: var(--surface);
		border-left-color: var(--accent);
	}

	/* Rail groups: a gap opens each group, and the settings pair sits behind
	   a hairline rule. Drawn as a ::before in the widened margin (never a
	   border on the button: border-left is the active accent). */
	.rail-btn.group-start {
		margin-top: 10px;
	}

	.rail-btn.settings-start {
		position: relative;
		margin-top: 16px;
	}

	.rail-btn.settings-start::before {
		content: '';
		position: absolute;
		top: -9px;
		right: 6px;
		left: 6px;
		border-top: 1px solid var(--border);
	}

	.rail-label {
		font-size: 10px;
		letter-spacing: 0.01em;
	}

	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		border-right: 1px solid var(--border);
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		padding: 14px;
		overflow-y: auto;
	}

	.resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
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

	/* A tablet's coarse pointer keeps the rail at the touch floor. */
	@media (pointer: coarse) {
		.rail-btn {
			min-height: 44px;
			justify-content: center;
		}
	}
</style>
