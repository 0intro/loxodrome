<script lang="ts">
	import type { Airspace } from '$lib/data/airspaces';
	import { t } from '$lib/state/i18n.svelte';
	import { navigateToAirspace } from '$lib/state/ui.svelte';
	import { clearHover, hoverFeature } from '$lib/map/selectionHighlight';

	interface Props {
		title: string;
		airspaces: Airspace[];
		/** Render the airspace id alongside the type label. Activates needs it
		 *  (callers usually want the LF-R-NNNN); the in-airspaces variant
		 *  drops it to declutter. */
		showId?: boolean;
		/** Optional per-airspace activation window text (RTBA per-zone times),
		 *  keyed by airspace id, shown as a trailing monospace chip. */
		windows?: Record<string, string>;
	}
	let { title, airspaces, showId = false, windows }: Props = $props();

	// The catalog table carries literal keys; the dataset type is an open
	// string, so the lookup widens at the read site and falls back to the code.
	function typeLabel(type: string): string {
		return (t.data.airspaceTypes as Record<string, string>)[type] ?? type;
	}
</script>

{#if airspaces.length > 0}
	<section class="block">
		<h3>{title} ({airspaces.length})</h3>
		<ul class="airspace-links">
			{#each airspaces as a, i (i)}
				<li>
					<button
						class="airspace-link"
						onclick={() => navigateToAirspace(a.key)}
						onmouseenter={() => hoverFeature('airspace', a.key)}
						onmouseleave={clearHover}
						title={typeLabel(a.type)}
					>
						<span class="swatch swatch--{a.category}"></span>
						{#if showId}
							<span class="airspace-id">{a.id}</span>
						{/if}
						<span class="airspace-type">{a.type}</span>
						{#if a.airClass}
							<span class="airspace-class">{a.airClass}</span>
						{/if}
						<span class="airspace-name">{a.name}</span>
						{#if windows?.[a.id]}
							<span class="airspace-window">{windows[a.id]}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.airspace-links {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.airspace-link {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 4px 6px;
		font: inherit;
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: 4px;
		cursor: pointer;
		color: var(--text);
	}

	.airspace-link:hover {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.airspace-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.swatch {
		flex: 0 0 auto;
		width: 10px;
		height: 10px;
		border-radius: 2px;
	}

	.swatch--controlled {
		background: var(--airspace-controlled);
	}

	.swatch--restricted {
		background: var(--airspace-restricted);
	}

	.swatch--transit {
		background: var(--airspace-transit);
	}

	.swatch--siv {
		background: var(--airspace-siv);
	}

	.swatch--fir {
		background: var(--airspace-fir);
	}

	.airspace-id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 12px;
		font-weight: 700;
	}

	.airspace-type {
		font-size: 12px;
		font-weight: 600;
	}

	.airspace-class {
		flex: 0 0 auto;
		min-width: 16px;
		padding: 1px 4px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		background: var(--accent);
		color: var(--accent-text);
		border-radius: 3px;
	}

	.airspace-name {
		flex: 1;
		overflow: hidden;
		font-size: 12px;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.airspace-window {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}
</style>
