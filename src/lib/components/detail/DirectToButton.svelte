<script lang="ts">
	/* Direct-To from a detail sheet (route/directTo.ts): an alternate route
	 * from the present position to the sheet's subject, appended to the plan
	 * and pinned as the route flown; the plan itself is untouched. Shown only
	 * with a position (a flight, or a replay), and disabled once the plan
	 * holds its MAX_ROUTES. One definition for every sheet that offers it
	 * (docs/nav-live.md "Direct-To"). */
	import Icon from '../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { currentPose } from '$lib/state/navRecording.svelte';
	import { MAX_ROUTES, canAddRoute, directTo, type WaypointSnap } from '$lib/state/route.svelte';
	import { navRouteId, setNavRoutePin } from '$lib/state/navRoute.svelte';

	interface Props {
		/** Where the direct-to leads. */
		target: WaypointSnap;
		/** The button's words ("Direct to LFOX"). */
		label: string;
		/** Its title while the plan has room. */
		tip: string;
	}
	const { target, label, tip }: Props = $props();

	const pose = $derived(currentPose());

	function onDirectTo(): void {
		const here = pose;
		if (!here) {
			return;
		}
		const r = directTo(target, here, navRouteId());
		if (r) {
			setNavRoutePin(r.id);
		}
	}
</script>

{#if pose}
	<button
		type="button"
		class="act act-direct"
		disabled={!canAddRoute()}
		onclick={onDirectTo}
		title={canAddRoute() ? tip : t.detail.directToFull(MAX_ROUTES)}
	>
		<Icon name="navigation" size={14} />
		<span>{label}</span>
	</button>
{/if}

<style>
	/* The sheets' action pill, in the accent for the one action a pilot
	   opens a sheet in flight for. */
	.act {
		display: inline-flex;
		gap: 5px;
		align-items: center;
		padding: 3px 9px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: var(--accent);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
		cursor: pointer;
	}

	.act:hover {
		border-color: var(--accent);
	}

	.act:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.act:disabled {
		opacity: 0.45;
		cursor: default;
	}
</style>
