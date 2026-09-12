<script lang="ts">
	/* One headwind-factor anchor list ([knots, factor] rows). The first
	 * anchor is pinned to (0, 1), satisfying the schema's [0, 1] rule
	 * structurally; the rest must be ascending in knots (schema-checked). */

	import Icon from '../Icon.svelte';
	import { decimalStep, type WindAnchorDraft } from '$lib/aircraft/edit';
	import { t } from '$lib/state/i18n.svelte';

	let { anchors = $bindable(), title }: { anchors: WindAnchorDraft[]; title: string } = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}
</script>

<div class="anchors">
	<h5>{title}</h5>
	<table class="etable" aria-label={title}>
		<thead>
			<tr><th>{t.aircraft.headwindKt}</th><th>{t.aircraft.factor}</th><th class="plain"></th></tr>
		</thead>
		<tbody>
			{#each anchors as a, i (i)}
				<tr>
					<td>
						<input
							class="cell"
							type="number"
							aria-label={t.aircraft.ariaWindAnchorKt(i + 1)}
							step={decimalStep(a.kt)}
							value={a.kt}
							disabled={i === 0}
							oninput={(e) => (anchors[i].kt = v(e))}
						/>
					</td>
					<td>
						<input
							class="cell"
							type="number"
							aria-label={t.aircraft.ariaWindAnchorFactor(i + 1)}
							step={decimalStep(a.factor)}
							value={a.factor}
							disabled={i === 0}
							oninput={(e) => (anchors[i].factor = v(e))}
						/>
					</td>
					<td class="plain">
						{#if i > 0}
							<button class="icon" title={t.aircraft.removeAnchorTip} onclick={() => anchors.splice(i, 1)}>
								<Icon name="x" size={13} />
							</button>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
	<button class="add-btn" onclick={() => anchors.push({ kt: '', factor: '' })}>
		<Icon name="plus" size={12} />
		{t.aircraft.addAnchor}
	</button>
</div>

<style>
	.anchors {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}
</style>
