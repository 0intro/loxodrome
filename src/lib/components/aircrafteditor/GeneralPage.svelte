<script lang="ts">
	/* Identity, cruise, climb / descent, fuel (grades, presets), notes and
	 * source. The
	 * registration (and, for a registration-less plane, the type) is the
	 * fleet key: locked for library planes, whose key must not change. */

	import Icon from '../Icon.svelte';
	import {
		blankCruiseDraft,
		blankFuelDraft,
		blankPresetDraft,
		blankVerticalSpeedDraft,
		decimalStep,
		type AircraftDraft,
	} from '$lib/aircraft/edit';
	import { FUEL_TYPES, FUEL_TYPE_INFO, type FuelType } from '$lib/aircraft/schema';
	import type { DesignatorType } from '$lib/data/designators';
	import {
		ensureFaaDesignators,
		isKnownDesignator,
		searchDesignators,
	} from '$lib/state/data.svelte';
	import { t } from '$lib/state/i18n.svelte';

	let { draft = $bindable(), keyLocked }: { draft: AircraftDraft; keyLocked: boolean } = $props();

	// Unique id prefix for the combobox ARIA wiring (aria-controls /
	// aria-activedescendant need document-unique option ids).
	const uid = $props.id();

	function v(e: Event): string {
		return (e.target as HTMLInputElement).value;
	}

	const derivedKey = $derived(draft.registration.trim() || draft.type.trim());

	// ICAO type designator suggestions (the FAA JO 7360.1 catalog, loaded
	// lazily when the page opens): a floating menu below the field while it
	// is focused, arrow keys + Enter pick, Escape closes the menu before it
	// can close the modal. The unknown-value warning is advisory: the FAA
	// list is a subset of Doc 8643, and Save is never blocked.
	void ensureFaaDesignators().catch(() => {});
	let icaoFocused = $state(false);
	let icaoActive = $state(-1);
	const icaoSuggestions = $derived(icaoFocused ? searchDesignators(draft.icaoType) : []);
	const icaoOpen = $derived(icaoSuggestions.length > 0);

	function pickIcaoType(s: DesignatorType): void {
		draft.icaoType = s.code;
		icaoFocused = false;
		icaoActive = -1;
	}

	function onIcaoKeydown(e: KeyboardEvent): void {
		if (!icaoOpen) {
			return;
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			icaoActive = (icaoActive + 1) % icaoSuggestions.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			icaoActive = icaoActive <= 0 ? icaoSuggestions.length - 1 : icaoActive - 1;
		} else if (e.key === 'Enter' && icaoActive >= 0 && icaoActive < icaoSuggestions.length) {
			e.preventDefault();
			pickIcaoType(icaoSuggestions[icaoActive]);
		} else if (e.key === 'Escape') {
			e.stopPropagation();
			icaoFocused = false;
			icaoActive = -1;
		}
	}

	function toggleGrade(ft: FuelType, on: boolean): void {
		const f = draft.fuel!;
		if (on) {
			// Re-insert in the canonical grade order.
			f.types = FUEL_TYPES.filter((x) => f.types.includes(x) || x === ft);
		} else {
			f.types = f.types.filter((x) => x !== ft);
		}
		if (!f.types.includes(f.type) && f.types.length > 0) {
			f.type = f.types[0];
		}
	}
</script>

<div class="page">
	<section class="card">
		<h4>{t.aircraft.identity}</h4>
		<label class="field">
			<span>{t.aircraft.registration}</span>
			<input
				type="text"
				autocapitalize="characters"
				spellcheck="false"
				bind:value={draft.registration}
				disabled={keyLocked}
				title={keyLocked ? t.aircraft.keyLockedTip : t.aircraft.regTip}
			/>
		</label>
		<label class="field">
			<span>{t.aircraft.type}</span>
			<input
				type="text"
				autocapitalize="characters"
				spellcheck="false"
				bind:value={draft.type}
				disabled={keyLocked && draft.registration.trim() === ''}
				title={keyLocked && draft.registration.trim() === ''
					? t.aircraft.typeLockedTip
					: t.aircraft.typeTip}
			/>
		</label>
		<label class="field">
			<span>{t.aircraft.icaoType}</span>
			<span class="icao-wrap">
				<input
					type="text"
					autocapitalize="characters"
					spellcheck="false"
					autocomplete="off"
					role="combobox"
					aria-autocomplete="list"
					aria-expanded={icaoOpen}
					aria-controls={icaoOpen ? `${uid}-icao-listbox` : undefined}
					aria-activedescendant={icaoOpen && icaoActive >= 0
						? `${uid}-icao-opt-${icaoActive}`
						: undefined}
					bind:value={draft.icaoType}
					title={t.aircraft.icaoTypeTip}
					onfocus={() => {
						icaoFocused = true;
						icaoActive = -1;
					}}
					onblur={() => (icaoFocused = false)}
					oninput={() => {
						icaoFocused = true;
						icaoActive = -1;
					}}
					onkeydown={onIcaoKeydown}
				/>
				{#if icaoOpen}
					<!-- mousedown is prevented on the whole menu (not just the
					     rows) so grabbing its scrollbar cannot blur the input
					     and close it; focus stays on the combobox input
					     (aria-activedescendant carries the active option). -->
					<ul
						class="icao-menu"
						id="{uid}-icao-listbox"
						role="listbox"
						tabindex="-1"
						onmousedown={(e) => e.preventDefault()}
					>
						{#each icaoSuggestions as s, i (s.code + '|' + s.manufacturer + '|' + s.model)}
							<li role="presentation">
								<button
									class="icao-row"
									class:icao-active={i === icaoActive}
									id="{uid}-icao-opt-{i}"
									role="option"
									aria-selected={i === icaoActive}
									tabindex="-1"
									onclick={() => pickIcaoType(s)}
								>
									<span class="icao-code">{s.code}</span>
									<span class="icao-desc">{s.manufacturer} {s.model}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</span>
		</label>
		{#if draft.icaoType.trim() !== '' && isKnownDesignator(draft.icaoType) === false}
			<p class="icao-unknown">{t.aircraft.icaoTypeUnknown}</p>
		{/if}
		<label class="field">
			<span>{t.aircraft.name}</span>
			<input type="text" autocapitalize="words" bind:value={draft.name} />
		</label>
		<label class="field">
			<span>{t.aircraft.operator}</span>
			<input type="text" autocapitalize="words" bind:value={draft.operator} title={t.aircraft.operatorTip} />
		</label>
		<p class="hint">
			{t.aircraft.fleetKeyLine(derivedKey === '' ? t.aircraft.fleetKeyUnset : derivedKey)}
		</p>
	</section>

	<section class="card">
		<div class="sect-head">
			<h4>{t.aircraft.cruise}</h4>
			{#if draft.cruise}
				<button class="link-btn" onclick={() => (draft.cruise = null)}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.cruise}
			{@const c = draft.cruise}
			<label class="field">
				<span>{t.aircraft.cruiseSpeed}</span>
				<input class="num" type="number" min="1" step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<p class="hint">{t.aircraft.cruiseSharedSaveHint}</p>
		{:else}
			<button class="add-btn" onclick={() => (draft.cruise = blankCruiseDraft())}>
				<Icon name="plus" size={12} />
				{t.aircraft.addCruise}
			</button>
		{/if}
	</section>

	<section class="card">
		<div class="sect-head">
			<h4>{t.aircraft.climb}</h4>
			{#if draft.climb}
				<button class="link-btn" onclick={() => (draft.climb = null)}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.climb}
			{@const c = draft.climb}
			<label class="field">
				<span>{t.aircraft.climbSpeed}</span>
				<input class="num" type="number" min="1" step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<label class="field">
				<span>{t.aircraft.climbRate}</span>
				<input class="num" type="number" min="1" step={decimalStep(c.rateFtMin)} value={c.rateFtMin} oninput={(e) => (c.rateFtMin = v(e))} />
				<span class="unit">ft/min</span>
			</label>
			<p class="hint">{t.aircraft.climbHint}</p>
		{:else}
			<button class="add-btn" onclick={() => (draft.climb = blankVerticalSpeedDraft())}>
				<Icon name="plus" size={12} />
				{t.aircraft.addClimb}
			</button>
		{/if}
	</section>

	<section class="card">
		<div class="sect-head">
			<h4>{t.aircraft.descent}</h4>
			{#if draft.descent}
				<button class="link-btn" onclick={() => (draft.descent = null)}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.descent}
			{@const c = draft.descent}
			<label class="field">
				<span>{t.aircraft.descentSpeed}</span>
				<input class="num" type="number" min="1" step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<label class="field">
				<span>{t.aircraft.descentRate}</span>
				<input class="num" type="number" min="1" step={decimalStep(c.rateFtMin)} value={c.rateFtMin} oninput={(e) => (c.rateFtMin = v(e))} />
				<span class="unit">ft/min</span>
			</label>
			<p class="hint">{t.aircraft.descentHint}</p>
		{:else}
			<button class="add-btn" onclick={() => (draft.descent = blankVerticalSpeedDraft())}>
				<Icon name="plus" size={12} />
				{t.aircraft.addDescent}
			</button>
		{/if}
	</section>

	<section class="card">
		<div class="sect-head">
			<h4>{t.aircraft.fuel}</h4>
			{#if draft.fuel}
				<button class="link-btn" onclick={() => (draft.fuel = null)}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.fuel}
			{@const f = draft.fuel}
			<label class="field">
				<span>{t.aircraft.tankCapacity}</span>
				<input class="num" type="number" min="1" step={decimalStep(f.capacityL)} value={f.capacityL} oninput={(e) => (f.capacityL = v(e))} />
				<span class="unit">L</span>
			</label>
			<label class="field">
				<span>{t.aircraft.usableFuel}</span>
				<input
					class="num"
					type="number"
					min="1"
					step={decimalStep(f.usableL)}
					value={f.usableL}
					placeholder={t.aircraft.usableFallback}
					oninput={(e) => (f.usableL = v(e))}
				/>
				<span class="unit">L</span>
			</label>
			<label class="field">
				<span>{t.aircraft.consumption}</span>
				<input
					class="num"
					type="number"
					min="1"
					step={decimalStep(f.consumptionLph)}
					value={f.consumptionLph}
					oninput={(e) => (f.consumptionLph = v(e))}
				/>
				<span class="unit">L/h</span>
			</label>
			<div class="field grades">
				<span>{t.aircraft.grades}</span>
				<div class="grade-list">
					{#each FUEL_TYPES as ft (ft)}
						<label class="check">
							<input
								type="checkbox"
								checked={f.types.includes(ft)}
								disabled={f.types.includes(ft) && f.types.length === 1}
								onchange={(e) => toggleGrade(ft, (e.target as HTMLInputElement).checked)}
							/>
							{FUEL_TYPE_INFO[ft].label}
						</label>
					{/each}
				</div>
			</div>
			<!-- The sheet's default grade; the grade actually tanked is the
			     Aircraft tab's per-plane pick, outside the data sheet. -->
			<label class="field" title={t.aircraft.gradeDensityTip}>
				<span>{t.aircraft.defaultGrade}</span>
				<select value={f.type} onchange={(e) => (f.type = (e.target as HTMLSelectElement).value as FuelType)}>
					{#each f.types as ft (ft)}
						<option value={ft}>{FUEL_TYPE_INFO[ft].label}</option>
					{/each}
				</select>
				<!-- i18n-ignore: kg/L is an invariant unit token -->
				<span class="unit">{FUEL_TYPE_INFO[f.type].densityKgPerL} kg/L</span>
			</label>
			<div class="presets">
				<h5>{t.aircraft.presets}</h5>
				{#if f.presets.length > 0}
					<table class="etable">
						<thead>
							<tr>
								<th>{t.aircraft.name}</th>
								<th>{t.aircraft.presetLabel}</th>
								<th>{t.aircraft.litres}</th>
								<th class="plain"></th>
							</tr>
						</thead>
						<tbody>
							{#each f.presets as p, i (i)}
								<tr>
									<td><input class="text-cell" type="text" autocapitalize="sentences" aria-label={t.aircraft.ariaPresetName(i + 1)} value={p.name} oninput={(e) => (f.presets[i].name = v(e))} /></td>
									<td><input class="text-cell" type="text" autocapitalize="characters" spellcheck="false" aria-label={t.aircraft.ariaPresetLabel(i + 1)} value={p.label} oninput={(e) => (f.presets[i].label = v(e))} /></td>
									<td><input class="cell" type="number" min="1" aria-label={t.aircraft.ariaPresetLitres(i + 1)} step={decimalStep(p.litres)} value={p.litres} oninput={(e) => (f.presets[i].litres = v(e))} /></td>
									<td class="plain">
										<button class="icon" title={t.aircraft.removePresetTip} onclick={() => f.presets.splice(i, 1)}>
											<Icon name="x" size={13} />
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				{/if}
				<button class="add-btn" onclick={() => f.presets.push(blankPresetDraft())}>
					<Icon name="plus" size={12} />
					{t.aircraft.addPreset}
				</button>
				<p class="hint">{t.aircraft.tabsPresetHint}</p>
			</div>
		{:else}
			<button class="add-btn" onclick={() => (draft.fuel = blankFuelDraft())}>
				<Icon name="plus" size={12} />
				{t.aircraft.addFuel}
			</button>
		{/if}
	</section>

	<section class="card">
		<h4>{t.aircraft.notes}</h4>
		<textarea class="notes" rows="3" autocapitalize="sentences" bind:value={draft.notes} placeholder={t.aircraft.notesPlaceholder}
		></textarea>
		<label class="field">
			<span>{t.aircraft.source}</span>
			<input type="text" bind:value={draft.source} placeholder={t.aircraft.sourcePlaceholder} />
		</label>
	</section>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	h4 {
		margin: 0;
		font-size: 13px;
	}

	h5 {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

	.grades {
		align-items: flex-start;
	}

	/* ICAO type suggestions: a floating menu anchored to the input (the
	 * RouteTab hit-menu pattern), so opening it leaves the fields below in
	 * place. Distinct icao-* class names on purpose: bare state-word
	 * classes collide with app.css globals. */
	.icao-wrap {
		position: relative;
		display: flex;
		flex: 1;
		min-width: 0;
	}

	.icao-menu {
		position: absolute;
		top: calc(100% + 3px);
		right: 0;
		left: 0;
		z-index: 30;
		padding: 4px;
		margin: 0;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 6px 18px rgb(0 0 0 / 22%);
		max-height: 260px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.icao-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		padding: 5px 8px;
		font: inherit;
		font-size: 12.5px;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.icao-row:hover,
	.icao-row.icao-active {
		background: var(--surface-2);
		border-color: var(--border);
	}

	.icao-code {
		flex: 0 0 auto;
		min-width: 42px;
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', consolas, monospace;
		font-weight: 600;
	}

	.icao-desc {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		font-size: 12px;
		color: var(--text-muted);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.icao-unknown {
		margin: -2px 0 0 138px;
		font-size: 12px;
		color: var(--workbook-orange);
	}

	.grade-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.presets {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.notes {
		font: inherit;
		font-size: 12.5px;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 4px 6px;
		resize: vertical;
	}
</style>
