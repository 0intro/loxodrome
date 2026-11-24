<script lang="ts">
	import { feetOf, seasonEnd, zsmActiveIn, type Zsm } from '$lib/data/zsm';
	import { groupThousands } from '$lib/format/datetime';
	import { t } from '$lib/state/i18n.svelte';
	import { drawnStateAt } from '$lib/state/notam.svelte';
	import { zsmState } from '$lib/state/zsm.svelte';
	import Fields from './Fields.svelte';

	interface Props {
		zone: Zsm;
	}
	const { zone }: Props = $props();

	const STAC_URL = 'https://www.stac.aviation-civile.gouv.fr/fr/zsm';

	const active = $derived.by(() => {
		const { fromMs, toMs } = drawnStateAt();
		return zsmActiveIn(zone, fromMs, toMs);
	});
	const until = $derived(seasonEnd(zone.species, zone.modified));
	const overfly = $derived(t.detail.zsmOverflyValue(groupThousands(feetOf(zone.overflyM)), groupThousands(zone.overflyM)));
	const edition = $derived(zsmState.meta?.edition ?? zone.modified);
</script>

<div class="zsm">
	<p class="state" class:active>
		{#if active}
			{until ? t.detail.zsmActiveUntil(zone.modified, until) : t.detail.zsmActiveSince(zone.modified)}
		{:else}
			{t.detail.zsmInactive}
		{/if}
	</p>

	<Fields>
		<dt>{t.detail.zsmSpecies}</dt>
		<dd>{zone.species}</dd>

		<dt>{t.detail.zsmOverfly}</dt>
		<dd class="mono">{overfly}</dd>

		<dt>{t.detail.zsmTop}</dt>
		<dd class="mono">{t.detail.zsmTopValue(groupThousands(zone.topM))}</dd>

		<dt>{t.detail.zsmSource}</dt>
		<dd><a href={STAC_URL} target="_blank" rel="noopener noreferrer">{t.detail.zsmEdition(edition)}</a></dd>
	</Fields>

	<p class="note">{t.detail.zsmRecommendation}</p>
</div>

<style>
	.zsm {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.state {
		margin: 0;
		font-weight: 600;
	}

	.state.active {
		color: var(--danger);
	}

	.mono {
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
	}

	.note {
		margin: 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
