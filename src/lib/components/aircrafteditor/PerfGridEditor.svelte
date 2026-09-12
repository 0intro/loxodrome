<script lang="ts">
	/* One POH distance grid: columns are ISA offsets, one row group per
	 * altitude with a max-mass and a min-mass sub-row, each cell holding the
	 * ground roll and the distance over 15 m. Add/remove keeps the cells
	 * matrix rectangular, so grid completeness stays structural; the schema
	 * still validates every number on save. */

	import Icon from '../Icon.svelte';
	import { blankPerfCell, decimalStep, type PerfGridDraft } from '$lib/aircraft/edit';
	import { t } from '$lib/state/i18n.svelte';

	let { grid = $bindable(), title }: { grid: PerfGridDraft; title: string } = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	function addAltitude(): void {
		grid.altitudesFt.push('');
		grid.cells.push(grid.isaOffsetsC.map(() => blankPerfCell()));
	}

	function removeAltitude(ai: number): void {
		grid.altitudesFt.splice(ai, 1);
		grid.cells.splice(ai, 1);
	}

	function addOffset(): void {
		grid.isaOffsetsC.push('');
		for (const row of grid.cells) {
			row.push(blankPerfCell());
		}
	}

	function removeOffset(ii: number): void {
		grid.isaOffsetsC.splice(ii, 1);
		for (const row of grid.cells) {
			row.splice(ii, 1);
		}
	}
</script>

<div class="grid-editor">
	<h5>{title}</h5>
	<table class="etable" aria-label={title}>
		<thead>
			<tr>
				<th rowspan="2">{t.aircraft.altitudeFt}</th>
				<th rowspan="2">{t.aircraft.massRow}</th>
				{#each grid.isaOffsetsC as isa, ii (ii)}
					<th colspan="2" class="isa-head">
						<span class="isa-lbl">ISA</span>
						<input
							class="axis"
							type="number"
							step={decimalStep(isa)}
							value={isa}
							aria-label={t.aircraft.ariaIsaAxis(ii + 1)}
							title={t.aircraft.isaOffsetTip}
							oninput={(e) => (grid.isaOffsetsC[ii] = v(e))}
						/>
						<button
							class="icon"
							title={t.aircraft.removeIsaColTip}
							disabled={grid.isaOffsetsC.length <= 2}
							onclick={() => removeOffset(ii)}
						>
							<Icon name="x" size={12} />
						</button>
					</th>
				{/each}
				<th rowspan="2" class="plain">
					<button class="icon" title={t.aircraft.addIsaColTip} onclick={addOffset}>
						<Icon name="plus" size={14} />
					</button>
				</th>
			</tr>
			<tr>
				{#each grid.isaOffsetsC as _isa, ii (ii)}
					<th>{t.aircraft.rollM}</th>
					<th>{t.aircraft.d15M}</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each grid.altitudesFt as alt, ai (ai)}
				<tr>
					<td rowspan="2" class="alt-cell">
						<input
							class="axis"
							type="number"
							step={decimalStep(alt)}
							value={alt}
							aria-label={t.aircraft.ariaAltitudeAxis(ai + 1)}
							oninput={(e) => (grid.altitudesFt[ai] = v(e))}
						/>
						<button
							class="icon"
							title={t.aircraft.removeAltitudeTip}
							disabled={grid.altitudesFt.length <= 2}
							onclick={() => removeAltitude(ai)}
						>
							<Icon name="x" size={12} />
						</button>
					</td>
					<td class="mass">{t.aircraft.massLimitMax}</td>
					{#each grid.isaOffsetsC as _isa3, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								min="0"
								aria-label={t.aircraft.ariaPerfCell({
									alt,
									isa: grid.isaOffsetsC[ii],
									mass: t.aircraft.massLimitMax,
									what: t.aircraft.rollM,
								})}
								step={decimalStep(grid.cells[ai][ii].massMaxRoll)}
								value={grid.cells[ai][ii].massMaxRoll}
								oninput={(e) => (grid.cells[ai][ii].massMaxRoll = v(e))}
							/>
						</td>
						<td>
							<input
								class="cell"
								type="number"
								min="0"
								aria-label={t.aircraft.ariaPerfCell({
									alt,
									isa: grid.isaOffsetsC[ii],
									mass: t.aircraft.massLimitMax,
									what: t.aircraft.d15M,
								})}
								step={decimalStep(grid.cells[ai][ii].massMaxD15)}
								value={grid.cells[ai][ii].massMaxD15}
								oninput={(e) => (grid.cells[ai][ii].massMaxD15 = v(e))}
							/>
						</td>
					{/each}
					<td rowspan="2" class="plain"></td>
				</tr>
				<tr>
					<td class="mass">{t.aircraft.massLimitMin}</td>
					{#each grid.isaOffsetsC as _isa4, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								min="0"
								aria-label={t.aircraft.ariaPerfCell({
									alt,
									isa: grid.isaOffsetsC[ii],
									mass: t.aircraft.massLimitMin,
									what: t.aircraft.rollM,
								})}
								step={decimalStep(grid.cells[ai][ii].massMinRoll)}
								value={grid.cells[ai][ii].massMinRoll}
								oninput={(e) => (grid.cells[ai][ii].massMinRoll = v(e))}
							/>
						</td>
						<td>
							<input
								class="cell"
								type="number"
								min="0"
								aria-label={t.aircraft.ariaPerfCell({
									alt,
									isa: grid.isaOffsetsC[ii],
									mass: t.aircraft.massLimitMin,
									what: t.aircraft.d15M,
								})}
								step={decimalStep(grid.cells[ai][ii].massMinD15)}
								value={grid.cells[ai][ii].massMinD15}
								oninput={(e) => (grid.cells[ai][ii].massMinD15 = v(e))}
							/>
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
	<button class="add-btn" onclick={addAltitude}>
		<Icon name="plus" size={12} />
		{t.aircraft.addAltitude}
	</button>
</div>

<style>
	.grid-editor {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	.isa-head {
		white-space: nowrap;
	}

	.isa-lbl {
		color: var(--text-muted);
		font-weight: 600;
		font-size: 11.5px;
	}

	.alt-cell {
		white-space: nowrap;
		vertical-align: middle;
	}

	.mass {
		color: var(--text-muted);
		font-weight: 600;
		text-align: left;
	}
</style>
