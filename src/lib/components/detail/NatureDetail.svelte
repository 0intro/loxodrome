<script lang="ts">
	import { type Nature, natureMinAltLabel } from '$lib/data/nature';
	import { t } from '$lib/state/i18n.svelte';
	import CoordButton from './CoordButton.svelte';
	import Fields from './Fields.svelte';

	interface Props {
		nature: Nature;
	}
	const { nature }: Props = $props();
</script>

<div class="nature">
	<Fields>
		<dt>{t.detail.type}</dt>
		<dd>{t.data.natureTypes[nature.type]}</dd>

		<dt>{t.detail.name}</dt>
		<dd>{nature.name}</dd>

		<dt>{t.detail.minOverflight}</dt>
		<dd class="mono">{natureMinAltLabel(nature)}</dd>

		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={nature.lat} lon={nature.lon} />
		</dd>
	</Fields>

	<p class="note">{t.detail.natureNote}</p>
</div>

<style>
	.nature {
		display: flex;
		flex-direction: column;
		gap: 12px;
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
