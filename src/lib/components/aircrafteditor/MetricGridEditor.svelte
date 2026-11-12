<script lang="ts" generics="T extends MetricTableDraft">
	/* One one-figure grid of a twin (the accelerate-stop distance, the one
	 * engine inoperative climb): its own two masses, then the POH grid's
	 * shape, columns the temperatures (ISA offsets or outside air
	 * temperatures as the manual prints them), one row group per altitude
	 * with a max-mass and a min-mass sub-row, ONE figure a cell. The sibling
	 * of PerfGridEditor, whose rules it keeps: add and remove keep the cells
	 * rectangular, a pasted block reaches the cells, switching the axis keeps
	 * the numbers. A climb may be zero or below, so its cells take no `min`. */

	import Icon from '../Icon.svelte';
	import { blankMetricCell, decimalStep, type MetricTableDraft } from '$lib/aircraft/edit';
	import type { TemperatureAxis } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';
	import { gridPaste } from '$lib/ui/gridPaste';
	import { askRemoval } from './removal';

	let {
		grid = $bindable(),
		title,
		what,
		negative = false,
		hint,
	}: {
		/** The table's draft (an accelerate-stop one carries its wind too). */
		grid: T;
		title: string;
		/** What a cell holds, for its accessible name ("accelerate-stop"). */
		what: string;
		/** A climb: its figures may be zero or below. */
		negative?: boolean;
		hint?: string | undefined;
	} = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	function addAltitude(): void {
		grid.altitudesFt.push('');
		grid.cells.push(grid.temperaturesC.map(() => blankMetricCell()));
	}

	// A row or a column holding figures asks before it goes; one freshly
	// added goes at once.
	const askRemove = askRemoval();

	function removeAltitude(ai: number): void {
		const alt = grid.altitudesFt[ai];
		askRemove(
			'altitude',
			() => `${alt.trim() === '' ? '?' : alt} ft`,
			{ alt, cells: grid.cells[ai] },
			{ alt: '', cells: grid.temperaturesC.map(() => blankMetricCell()) },
			() => {
				grid.altitudesFt.splice(ai, 1);
				grid.cells.splice(ai, 1);
			},
		);
	}

	function addColumn(): void {
		grid.temperaturesC.push('');
		for (const row of grid.cells) {
			row.push(blankMetricCell());
		}
	}

	function removeColumn(ii: number): void {
		const temp = grid.temperaturesC[ii];
		askRemove(
			'column',
			() => (oat ? `${temp.trim() === '' ? '?' : temp} °C` : `ISA ${temp.trim() === '' ? '?' : temp}`),
			{ temp, cells: grid.cells.map((row) => row[ii]) },
			{ temp: '', cells: grid.cells.map(() => blankMetricCell()) },
			() => {
				grid.temperaturesC.splice(ii, 1);
				for (const row of grid.cells) {
					row.splice(ii, 1);
				}
			},
		);
	}

	const oat = $derived(grid.axis === 'oat');

	/* A pasted block's room (ui/gridPaste): two rows an altitude (max then
	 * min mass), one column a temperature; each axis a grid of its own. */
	function grow(name: string, rows: number, cols: number): void {
		const altitudes = name === 'temps' ? 0 : name === 'alts' ? rows : Math.ceil(rows / 2);
		const columns = name === 'alts' ? 0 : cols;
		while (grid.altitudesFt.length < altitudes) {
			addAltitude();
		}
		while (grid.temperaturesC.length < columns) {
			addColumn();
		}
	}

	function cellLabel(alt: string, temp: string, mass: string): string {
		return oat
			? t.aircraft.ariaPerfCellOat({ alt, temp, mass, what })
			: t.aircraft.ariaPerfCell({ alt, isa: temp, mass, what });
	}
</script>

<div class="grid-editor">
	<h5>{title}</h5>
	<label class="field">
		<span>{t.aircraft.maxMass}</span>
		<input class="num" type="number" lang="en" min="1" required step={decimalStep(grid.massMaxKg)} value={grid.massMaxKg} oninput={(e) => (grid.massMaxKg = v(e))} />
		<span class="unit">kg</span>
	</label>
	<label class="field">
		<span>{t.aircraft.minMass}</span>
		<input class="num" type="number" lang="en" min="1" required step={decimalStep(grid.massMinKg)} value={grid.massMinKg} oninput={(e) => (grid.massMinKg = v(e))} />
		<span class="unit">kg</span>
	</label>
	<label class="field" title={t.aircraft.tempColumnsTip}>
		<span>{t.aircraft.tempColumns}</span>
		<select
			value={grid.axis}
			onchange={(e) => (grid.axis = (e.target as HTMLSelectElement).value as TemperatureAxis)}
		>
			<option value="isa-offset">{t.aircraft.tempAxisIsa}</option>
			<option value="oat">{t.aircraft.tempAxisOat}</option>
		</select>
	</label>
	<!-- Wider than a phone: it pans in its own scroller, never the whole
	     editor, and stays dense on a touch screen (poh). -->
	<div class="grid-scroll">
	<table class="etable poh" aria-label={title} use:gridPaste={{ grow }}>
		<thead>
			<tr>
				<th>{t.aircraft.altitudeFt}</th>
				<th>{t.aircraft.massRow}</th>
				{#each grid.temperaturesC as temp, ii (ii)}
					<th class="isa-head">
						<span class="isa-lbl">{oat ? 'OAT' : 'ISA'}</span>
						<input
							class="axis"
							type="number"
							lang="en"
							required
							data-grid="temps"
							data-row="0"
							data-col={ii}
							step={decimalStep(temp)}
							value={temp}
							aria-label={oat ? t.aircraft.ariaOatAxis(ii + 1) : t.aircraft.ariaIsaAxis(ii + 1)}
							title={oat ? t.aircraft.oatTip : t.aircraft.isaOffsetTip}
							oninput={(e) => (grid.temperaturesC[ii] = v(e))}
						/>
						<button
							class="icon"
							title={oat ? t.aircraft.removeOatColTip : t.aircraft.removeIsaColTip}
							disabled={grid.temperaturesC.length <= 2}
							onclick={() => removeColumn(ii)}
						>
							<Icon name="x" size={12} />
						</button>
					</th>
				{/each}
				<th class="plain">
					<button class="icon" title={oat ? t.aircraft.addOatColTip : t.aircraft.addIsaColTip} onclick={addColumn}>
						<Icon name="plus" size={14} />
					</button>
				</th>
			</tr>
		</thead>
		<tbody>
			{#each grid.altitudesFt as alt, ai (ai)}
				<tr>
					<td rowspan="2" class="alt-cell">
						<input
							class="axis"
							type="number"
							lang="en"
							required
							data-grid="alts"
							data-row={ai}
							data-col="0"
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
					{#each grid.temperaturesC as _temp, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min={negative ? undefined : '0'}
								required
								data-row={ai * 2}
								data-col={ii}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMax)}
								step={decimalStep(grid.cells[ai][ii].massMax)}
								value={grid.cells[ai][ii].massMax}
								oninput={(e) => (grid.cells[ai][ii].massMax = v(e))}
							/>
						</td>
					{/each}
					<td rowspan="2" class="plain"></td>
				</tr>
				<tr>
					<td class="mass">{t.aircraft.massLimitMin}</td>
					{#each grid.temperaturesC as _temp2, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min={negative ? undefined : '0'}
								required
								data-row={ai * 2 + 1}
								data-col={ii}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMin)}
								step={decimalStep(grid.cells[ai][ii].massMin)}
								value={grid.cells[ai][ii].massMin}
								oninput={(e) => (grid.cells[ai][ii].massMin = v(e))}
							/>
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
	</div>
	<button class="add-btn" onclick={addAltitude}>
		<Icon name="plus" size={12} />
		{t.aircraft.addAltitude}
	</button>
	{#if hint}
		<p class="hint">{hint}</p>
	{/if}
</div>

<style>
	.grid-editor {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* Screen only: paper must never clip the grid. */
	@media screen {
		.grid-scroll {
			overflow-x: auto;
		}
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
