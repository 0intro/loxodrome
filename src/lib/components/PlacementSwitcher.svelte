<script lang="ts">
	/* The icon group in a surface header that moves it between placements.
	 * Offers only the placements the registry allows for that surface, and
	 * only the ones that make sense at the current viewport (a phone has no
	 * side dock and no page), so a surface with one option shows nothing. */
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { type Placement, type SurfaceId, mobilePlacement, surfaceDef } from '$lib/surfaces';
	import { placementOf, setPlacement } from '$lib/state/workspace.svelte';
	import { ui } from '$lib/state/ui.svelte';

	interface Props {
		id: SurfaceId;
	}
	const { id }: Props = $props();

	const ICONS: Record<Placement, string> = {
		'dock-bottom': 'panel-bottom',
		'dock-right': 'panel-right',
		page: 'panel-page',
		full: 'maximize',
		dialog: 'panel-page',
	};

	const current = $derived(placementOf(id));

	/* On a phone several desktop placements collapse onto the same rendering,
	 * so offer each distinct result once, keyed by what it collapses to.
	 *
	 * The placement actually showing is always offered, even when the phone
	 * collapse would have dropped it: a surface must never be somewhere its
	 * own switcher cannot show, which is how one used to end up stranded with
	 * no control to move it back. */
	const options = $derived.by(() => {
		const allowed = surfaceDef(id).placements;
		const current = placementOf(id);
		if (!ui.isMobile) {
			return [...allowed];
		}
		const seen: Placement[] = [];
		if (current !== null) {
			seen.push(current);
		}
		for (const p of allowed) {
			const rendered = mobilePlacement(p);
			if (allowed.includes(rendered) && !seen.includes(rendered)) {
				seen.push(rendered);
			}
		}
		return seen;
	});

	function labelFor(p: Placement): string {
		switch (p) {
			case 'dock-bottom':
				return t.common.dockBottom;
			case 'dock-right':
				return t.common.dockRight;
			case 'page':
				return t.common.pagePlacement;
			default:
				return t.common.fullScreen;
		}
	}
</script>

{#if options.length > 1}
	<div class="placement no-print" role="group" aria-label={t.common.placement}>
		{#each options as option (option)}
			<button
				type="button"
				class="modal-close"
				class:on={current === option}
				aria-pressed={current === option}
				title={labelFor(option)}
				aria-label={labelFor(option)}
				onclick={() => setPlacement(id, option)}
			>
				<Icon name={ICONS[option]} size={16} />
			</button>
		{/each}
	</div>
{/if}

<style>
	.placement {
		display: flex;
		flex: 0 0 auto;
		gap: 2px;
		align-items: center;
	}

	/* The pressed placement reads as the current one, not as a hover. */
	.placement button.on {
		background: var(--surface-3);
		color: var(--text);
	}
</style>
