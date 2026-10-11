<script lang="ts">
	/* One POH distance grid: columns are temperatures, ISA offsets or outside
	 * air temperatures as the manual prints them, one row group per altitude
	 * with a max-mass and a min-mass sub-row, each cell holding the ground
	 * roll and the distance over 15 m. Add/remove keeps the cells matrix
	 * rectangular, so grid completeness stays structural; the schema still
	 * validates every number on save. Switching the axis keeps the numbers:
	 * it changes what they mean. */

	import Icon from '../Icon.svelte';
	import { blankPerfCell, decimalStep, type PerfGridDraft } from '$lib/aircraft/edit';
	import type { TemperatureAxis } from '$lib/aircraft/schema';
	import { t } from '$lib/state/i18n.svelte';
	import { gridPaste } from '$lib/ui/gridPaste';
	import { askRemoval } from './removal';

	let {
		grid = $bindable(),
		title,
		hint,
	}: {
		grid: PerfGridDraft;
		title: string;
		/** A line under the grid (the page's first says a block pastes). */
		hint?: string | undefined;
	} = $props();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	function addAltitude(): void {
		grid.altitudesFt.push('');
		grid.cells.push(grid.temperaturesC.map(() => blankPerfCell()));
	}

	// A row or a column holding figures asks before it goes (the editor's
	// question); one freshly added goes at once.
	const askRemove = askRemoval();

	function removeAltitude(ai: number): void {
		const alt = grid.altitudesFt[ai];
		askRemove(
			'altitude',
			() => `${alt.trim() === '' ? '?' : alt} ft`,
			{ alt, cells: grid.cells[ai] },
			{ alt: '', cells: grid.temperaturesC.map(() => blankPerfCell()) },
			() => {
				grid.altitudesFt.splice(ai, 1);
				grid.cells.splice(ai, 1);
			},
		);
	}

	function addColumn(): void {
		grid.temperaturesC.push('');
		for (const row of grid.cells) {
			row.push(blankPerfCell());
		}
	}

	function removeColumn(ii: number): void {
		const temp = grid.temperaturesC[ii];
		askRemove(
			'column',
			() => (oat ? `${temp.trim() === '' ? '?' : temp} °C` : `ISA ${temp.trim() === '' ? '?' : temp}`),
			{ temp, cells: grid.cells.map((row) => row[ii]) },
			{ temp: '', cells: grid.cells.map(() => blankPerfCell()) },
			() => {
				grid.temperaturesC.splice(ii, 1);
				for (const row of grid.cells) {
					row.splice(ii, 1);
				}
			},
		);
	}

	const oat = $derived(grid.axis === 'oat');

	/* A pasted block's room (ui/gridPaste). The cells sit as the manual
	 * prints them: two rows an altitude (max then min mass), two columns a
	 * temperature (roll then 15 m); each axis is a grid of its own, the
	 * temperatures a row, the altitudes a column. */
	function grow(name: string, rows: number, cols: number): void {
		const altitudes = name === 'temps' ? 0 : name === 'alts' ? rows : Math.ceil(rows / 2);
		const columns = name === 'alts' ? 0 : name === 'temps' ? cols : Math.ceil(cols / 2);
		while (grid.altitudesFt.length < altitudes) {
			addAltitude();
		}
		while (grid.temperaturesC.length < columns) {
			addColumn();
		}
	}

	function cellLabel(alt: string, temp: string, mass: string, what: string): string {
		return oat
			? t.aircraft.ariaPerfCellOat({ alt, temp, mass, what })
			: t.aircraft.ariaPerfCell({ alt, isa: temp, mass, what });
	}
</script>

<div class="grid-editor">
	<h5>{title}</h5>
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
	<!-- The grid is wider than a phone (every temperature a pair of cells):
	     it pans in its own scroller, never the whole editor. It stays dense
	     on a touch screen too (poh), like the flight preparation's POH
	     tables. -->
	<div class="grid-scroll">
	<table class="etable poh" aria-label={title} use:gridPaste={{ grow }}>
		<thead>
			<tr>
				<th rowspan="2">{t.aircraft.altitudeFt}</th>
				<th rowspan="2">{t.aircraft.massRow}</th>
				{#each grid.temperaturesC as temp, ii (ii)}
					<th colspan="2" class="isa-head">
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
				<th rowspan="2" class="plain">
					<button class="icon" title={oat ? t.aircraft.addOatColTip : t.aircraft.addIsaColTip} onclick={addColumn}>
						<Icon name="plus" size={14} />
					</button>
				</th>
			</tr>
			<tr>
				{#each grid.temperaturesC as _temp, ii (ii)}
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
					{#each grid.temperaturesC as _temp3, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min="0"
								required
								data-row={ai * 2}
								data-col={ii * 2}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMax, t.aircraft.rollM)}
								step={decimalStep(grid.cells[ai][ii].massMaxRoll)}
								value={grid.cells[ai][ii].massMaxRoll}
								oninput={(e) => (grid.cells[ai][ii].massMaxRoll = v(e))}
							/>
						</td>
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min="0"
								required
								data-row={ai * 2}
								data-col={ii * 2 + 1}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMax, t.aircraft.d15M)}
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
					{#each grid.temperaturesC as _temp4, ii (ii)}
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min="0"
								required
								data-row={ai * 2 + 1}
								data-col={ii * 2}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMin, t.aircraft.rollM)}
								step={decimalStep(grid.cells[ai][ii].massMinRoll)}
								value={grid.cells[ai][ii].massMinRoll}
								oninput={(e) => (grid.cells[ai][ii].massMinRoll = v(e))}
							/>
						</td>
						<td>
							<input
								class="cell"
								type="number"
								lang="en"
								min="0"
								required
								data-row={ai * 2 + 1}
								data-col={ii * 2 + 1}
								aria-label={cellLabel(alt, grid.temperaturesC[ii], t.aircraft.massLimitMin, t.aircraft.d15M)}
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

	/* Screen only: a plain Ctrl+P prints the frontmost surface, and paper
	   must never clip the grid. */
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
