<script lang="ts">
	import { routes, activeRoute, stepActiveRoute } from '$lib/state/route.svelte';
	import { routeColor, routeColorMap } from '$lib/route/routeColors';
	import { routeEndpointLabel } from '$lib/route/routeLabel';
	import { t } from '$lib/state/i18n.svelte';
	import Icon from './Icon.svelte';

	const idx = $derived(routes.list.findIndex((r) => r.id === routes.activeId));
	// Dot colour by the shared resolver (an alternate shares its trip's hue).
	const hues = $derived(routeColorMap(routes.list));
</script>

{#if routes.list.length > 1}
	<div class="route-switcher" role="group" aria-label={t.route.switchRoute}>
		<button
			class="rs-arrow"
			aria-label={t.route.prevRoute}
			title={t.route.prevRoute}
			disabled={idx <= 0}
			onclick={() => stepActiveRoute(-1)}
		>
			<Icon name="chevron-left" size={16} />
		</button>
		<span class="rs-label" style:--route-hue={hues.get(routes.activeId) ?? routeColor(idx)}>
			<span class="rs-dot"></span>
			<span class="rs-text">{routeEndpointLabel(activeRoute(), t.route.newRoute)}</span>
		</span>
		<button
			class="rs-arrow"
			aria-label={t.route.nextRoute}
			title={t.route.nextRoute}
			disabled={idx >= routes.list.length - 1}
			onclick={() => stepActiveRoute(1)}
		>
			<Icon name="chevron-right" size={16} />
		</button>
	</div>
{/if}

<style>
	.route-switcher {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.rs-arrow {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		padding: 0;
		border: none;
		border-radius: 6px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	/* Paging routes is a one-hand gesture in flight, so the 28px box carries
	   the touch floor as slop instead of growing the surface header. */
	:global(:root.touch-ui) .rs-arrow {
		position: relative;
	}

	:global(:root.touch-ui) .rs-arrow::after {
		position: absolute;
		inset: -8px;
		content: '';
	}

	.rs-arrow:hover:not(:disabled) {
		background: var(--surface-3);
		color: var(--text);
	}

	.rs-arrow:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.rs-arrow:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.rs-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 200px;
	}

	.rs-dot {
		flex: none;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--route-hue);
	}

	.rs-text {
		overflow: hidden;
		font-size: 13px;
		font-weight: 600;
		color: var(--text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media print {
		.route-switcher {
			display: none;
		}
	}
</style>
