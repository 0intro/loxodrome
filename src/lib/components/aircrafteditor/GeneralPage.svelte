<script lang="ts">
	/* Identity, cruise, climb / descent, fuel (grades, presets), notes and
	 * source. The
	 * registration (and, for a registration-less plane, the type) is the
	 * fleet key: locked for library planes, whose key must not change. */

	import Icon from '../Icon.svelte';
	import {
		blankCruiseDraft,
		blankCruiseSettingDraft,
		blankFuelDraft,
		blankPresetDraft,
		blankVerticalSpeedDraft,
		decimalStep,
		SOME_TEXT,
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
	import { gridPaste } from '$lib/ui/gridPaste';
	import { singleLine } from '$lib/ui/singleLine';
	import { askRemoval } from './removal';

	let {
		draft = $bindable(),
		keyLocked,
		fromGeneric = false,
	}: { draft: AircraftDraft; keyLocked: boolean; fromGeneric?: boolean } = $props();

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

	// A section holding figures asks before it goes (the editor's question).
	const askRemove = askRemoval();

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
				class="w-code"
				type="text"
				autocapitalize="characters"
				spellcheck="false"
				bind:value={draft.registration}
				required={fromGeneric}
				pattern={fromGeneric ? SOME_TEXT : undefined}
				disabled={keyLocked}
				title={keyLocked ? t.aircraft.keyLockedTip : t.aircraft.regTip}
			/>
		</label>
		{#if fromGeneric}
			<p class="under generic-hint">{t.aircraft.genericCopyHint}</p>
		{/if}
		<label class="field">
			<span>{t.aircraft.type}</span>
			<input
				class="w-type"
				type="text"
				autocapitalize="characters"
				spellcheck="false"
				bind:value={draft.type}
				required
				pattern={SOME_TEXT}
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
					class="w-icao"
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
			<p class="under icao-unknown">{t.aircraft.icaoTypeUnknown}</p>
		{/if}
		<!-- A twin states two: the Performance page then shows its
		     accelerate-stop and one engine inoperative cards. -->
		<label class="field" title={t.aircraft.enginesTip}>
			<span>{t.aircraft.engines}</span>
			<select
				value={draft.engines}
				onchange={(e) => (draft.engines = (e.target as HTMLSelectElement).value as '1' | '2')}
			>
				<option value="1">{t.aircraft.enginesOne}</option>
				<option value="2">{t.aircraft.enginesTwo}</option>
			</select>
		</label>
		<!-- A box that wraps (a generic sheet's name states its serial range),
		     holding one line of text. -->
		<label class="field top">
			<span>{t.aircraft.name}</span>
			<textarea class="w-long one-line" rows="1" autocapitalize="words" use:singleLine bind:value={draft.name}></textarea>
		</label>
		<label class="field">
			<span>{t.aircraft.operator}</span>
			<input class="w-name" type="text" autocapitalize="words" bind:value={draft.operator} title={t.aircraft.operatorTip} />
		</label>
		<p class="hint">
			{t.aircraft.fleetKeyLine(derivedKey === '' ? t.aircraft.fleetKeyUnset : derivedKey)}
		</p>
	</section>

	<section class="card">
		<div class="sect-head">
			<h4>{t.aircraft.cruise}</h4>
			{#if draft.cruise}
				<button class="link-btn" onclick={() => askRemove('section', () => t.aircraft.cruise, draft.cruise, blankCruiseDraft(), () => (draft.cruise = null))}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.cruise}
			{@const c = draft.cruise}
			<label class="field">
				<span>{t.aircraft.cruiseSpeed}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<label class="field">
				<span>{t.aircraft.cruiseDefaultName}</span>
				<input class="w-name" type="text" spellcheck="false" placeholder={t.aircraft.cruiseDefaultNamePlaceholder} value={c.name} oninput={(e) => (c.name = v(e))} />
			</label>
			<p class="hint">{t.aircraft.cruiseSharedSaveHint}</p>
			<!-- The manual's other power settings: a flight plan picks one in the
			     Route tab, so a different speed comes with its own fuel flow. -->
			<div class="presets">
				<h5>{t.aircraft.cruiseSettings}</h5>
				{#if c.settings.length > 0}
					<!-- A setting's name runs to 22 characters: the table is about a
					     phone's width and pans in its own scroller there. -->
					<div class="table-scroll">
					<table
						class="etable settings"
						use:gridPaste={{
							grow: (_grid: string, rows: number) => {
								while (c.settings.length < rows) {
									c.settings.push(blankCruiseSettingDraft());
								}
							},
						}}
					>
						<thead>
							<tr>
								<th>{t.aircraft.name}</th>
								<th>kt</th>
								<th>L/h</th>
								<th class="plain"></th>
							</tr>
						</thead>
						<tbody>
							{#each c.settings as s, i (i)}
								<tr>
									<td><input class="setting-cell" type="text" spellcheck="false" required pattern={SOME_TEXT} data-row={i} data-col="0" aria-label={t.aircraft.ariaCruiseSettingName(i + 1)} value={s.name} oninput={(e) => (c.settings[i].name = v(e))} /></td>
									<td><input class="cell" type="number" lang="en" min="1" required data-row={i} data-col="1" aria-label={t.aircraft.ariaCruiseSettingSpeed(i + 1)} step={decimalStep(s.speedKt)} value={s.speedKt} oninput={(e) => (c.settings[i].speedKt = v(e))} /></td>
									<td><input class="cell" type="number" lang="en" min="0" required data-row={i} data-col="2" aria-label={t.aircraft.ariaCruiseSettingLph(i + 1)} step={decimalStep(s.consumptionLph)} value={s.consumptionLph} oninput={(e) => (c.settings[i].consumptionLph = v(e))} /></td>
									<td class="plain">
										<button class="icon" title={t.aircraft.removeCruiseSettingTip} onclick={() => c.settings.splice(i, 1)}>
											<Icon name="x" size={13} />
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
					</div>
				{/if}
				<button class="add-btn" onclick={() => c.settings.push(blankCruiseSettingDraft())}>
					<Icon name="plus" size={12} />
					{t.aircraft.addCruiseSetting}
				</button>
				<p class="hint">{t.aircraft.cruiseSettingsHint}</p>
			</div>
		{:else}
			<p class="hint absent">{t.aircraft.notInSheet}</p>
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
				<button class="link-btn" onclick={() => askRemove('section', () => t.aircraft.climb, draft.climb, blankVerticalSpeedDraft(), () => (draft.climb = null))}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.climb}
			{@const c = draft.climb}
			<label class="field">
				<span>{t.aircraft.climbSpeed}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<label class="field">
				<span>{t.aircraft.climbRate}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(c.rateFtMin)} value={c.rateFtMin} oninput={(e) => (c.rateFtMin = v(e))} />
				<span class="unit">ft/min</span>
			</label>
			<p class="hint">{t.aircraft.climbHint}</p>
		{:else}
			<p class="hint absent">{t.aircraft.notInSheet}</p>
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
				<button class="link-btn" onclick={() => askRemove('section', () => t.aircraft.descent, draft.descent, blankVerticalSpeedDraft(), () => (draft.descent = null))}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.descent}
			{@const c = draft.descent}
			<label class="field">
				<span>{t.aircraft.descentSpeed}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(c.speedKt)} value={c.speedKt} oninput={(e) => (c.speedKt = v(e))} />
				<span class="unit">kt</span>
			</label>
			<label class="field">
				<span>{t.aircraft.descentRate}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(c.rateFtMin)} value={c.rateFtMin} oninput={(e) => (c.rateFtMin = v(e))} />
				<span class="unit">ft/min</span>
			</label>
			<p class="hint">{t.aircraft.descentHint}</p>
		{:else}
			<p class="hint absent">{t.aircraft.notInSheet}</p>
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
				<button class="link-btn" onclick={() => askRemove('section', () => t.aircraft.fuel, draft.fuel, blankFuelDraft(), () => (draft.fuel = null))}>{t.aircraft.removeSection}</button>
			{/if}
		</div>
		{#if draft.fuel}
			{@const f = draft.fuel}
			<label class="field">
				<span>{t.aircraft.tankCapacity}</span>
				<input class="num" type="number" lang="en" min="1" required step={decimalStep(f.capacityL)} value={f.capacityL} oninput={(e) => (f.capacityL = v(e))} />
				<span class="unit">L</span>
			</label>
			<label class="field">
				<span>{t.aircraft.usableFuel}</span>
				<!-- Empty is the whole capacity (the schema default): the box shows
				     that value in force, and steps from it. -->
				<input
					class="num"
					type="number"
					lang="en"
					min="1"
					step={decimalStep(f.usableL || f.capacityL)}
					value={f.usableL}
					placeholder={f.capacityL}
					oninput={(e) => (f.usableL = v(e))}
				/>
				<span class="unit">L</span>
			</label>
			<label class="field">
				<span>{draft.engines === '2' ? t.aircraft.consumptionBothEngines : t.aircraft.consumption}</span>
				<input
					class="num"
					type="number"
					lang="en"
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
					<table
						class="etable"
						use:gridPaste={{
							grow: (_grid: string, rows: number) => {
								while (f.presets.length < rows) {
									f.presets.push(blankPresetDraft());
								}
							},
						}}
					>
						<thead>
							<tr>
								<th>{t.aircraft.name}</th>
								<th>{t.aircraft.litres}</th>
								<th class="plain"></th>
							</tr>
						</thead>
						<tbody>
							{#each f.presets as p, i (i)}
								<tr>
									<!-- The name is a machine key ("tabs"), matched exactly: no
									     capitalisation, no spelling fixes. -->
									<td><input class="text-cell" type="text" autocapitalize="off" spellcheck="false" required pattern={SOME_TEXT} data-row={i} data-col="0" aria-label={t.aircraft.ariaPresetName(i + 1)} value={p.name} oninput={(e) => (f.presets[i].name = v(e))} /></td>
									<td><input class="cell" type="number" lang="en" min="1" required data-row={i} data-col="1" aria-label={t.aircraft.ariaPresetLitres(i + 1)} step={decimalStep(p.litres)} value={p.litres} oninput={(e) => (f.presets[i].litres = v(e))} /></td>
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
			<p class="hint absent">{t.aircraft.notInSheet}</p>
			<button class="add-btn" onclick={() => (draft.fuel = blankFuelDraft())}>
				<Icon name="plus" size={12} />
				{t.aircraft.addFuel}
			</button>
		{/if}
	</section>

	<!-- Prose, both: boxes that wrap, on the box column like every other. A
	     source cites a manual and a weighing report, 100 to 200 characters. -->
	<section class="card">
		<h4>{t.aircraft.notesAndSource}</h4>
		<label class="field top">
			<span>{t.aircraft.notes}</span>
			<textarea class="w-long" rows="3" autocapitalize="sentences" bind:value={draft.notes} placeholder={t.aircraft.notesPlaceholder}
			></textarea>
		</label>
		<label class="field top">
			<span>{t.aircraft.source}</span>
			<textarea class="w-long" rows="2" bind:value={draft.source} placeholder={t.aircraft.sourcePlaceholder}></textarea>
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

	/* The grades sit in a wrapping row, the label on their first line. */
	.grades {
		align-items: baseline;
	}

	.grade-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 16px;
	}

	/* ICAO type suggestions: a floating menu anchored under the input (the
	 * RouteTab hit-menu pattern), so opening it leaves the fields below in
	 * place. The box holds a designator, the menu a designator and a model
	 * name, so it is wider than its box, never past the body's edge.
	 * Distinct icao-* class names on purpose: bare state-word classes collide
	 * with app.css globals. */
	.icao-wrap {
		position: relative;
		display: flex;
		min-width: 0;
	}

	.icao-menu {
		position: absolute;
		top: calc(100% + 3px);
		left: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		gap: 2px;
		inline-size: 300px;
		max-inline-size: calc(100cqi - var(--label-w) - var(--field-gap));
		max-height: 260px;
		padding: 4px;
		margin: 0;
		overflow-y: auto;
		list-style: none;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		box-shadow: 0 6px 18px rgb(0 0 0 / 22%);
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

	/* Advisories set under their box (.under, the box column): the ICAO
	   designator the FAA list lacks, the registration a generic copy needs. */
	.icao-unknown,
	.generic-hint {
		color: var(--workbook-orange);
	}

	.presets {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* Screen only: paper never clips the table. */
	@media screen {
		.table-scroll {
			overflow-x: auto;
		}
	}

	/* A wrapping box's label sits on its first line. */
	.top {
		align-items: flex-start;
	}

	.top > span:first-child {
		padding-block-start: 3px;
	}

	/* The notes and the source grow by hand; the name grows with its text. */
	.top textarea:not(.one-line) {
		resize: vertical;
	}
</style>
