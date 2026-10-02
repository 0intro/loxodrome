<script lang="ts">
	/* The aircraft fleet manager: the committed library + user planes
	 * (shadowing by registration), selection of the active aircraft, the
	 * basics editable in place (copy-on-write into the user store), links
	 * into the editor's stations / envelope / performance pages, and
	 * per-plane YAML import / export. The flight-preparation modal opens
	 * from here too. */

	import {
		aircraftState,
		ensureAircraftLibrary,
		fleet,
		selectedAircraft,
		selectAircraft,
		importUserAircraft,
		updateAircraft,
		revertToLibrary,
		removeUserAircraft,
		isShadowed,
		isUserOnly,
		tankedFuelType,
		tankedFuelDensityKgPerL,
		setTankedFuel,
	} from '$lib/state/aircraft.svelte';
	import {
		aircraftFileName,
		aircraftKey,
		parseAircraftYaml,
		stringifyAircraftYaml,
		enduranceMin,
		FUEL_TYPE_INFO,
		type Aircraft,
		type FuelType,
	} from '$lib/aircraft/schema';
	import {
		editorShows,
		openAircraftCreate,
		openAircraftDuplicate,
		openAircraftEditor,
	} from '$lib/state/aircraftEditor.svelte';
	import { groupFleet } from '$lib/aircraft/fleetSearch';
	import { downloadBlob } from '$lib/ui/dom';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { isNativeApp } from '$lib/native/platform';
	import { pickFileNatively } from '$lib/state/openFile.svelte';
	import { fleetView, toggleFleetGroup } from '$lib/state/fleetView.svelte';
	import { ensureFaaDesignators, isKnownDesignator } from '$lib/state/data.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { fmtHHMM } from '../flightprep/shared';

	// The unknown-designator check on the ICAO type field (advisory: the
	// FAA JO 7360.1 list is a subset of Doc 8643).
	void ensureFaaDesignators().catch(() => {});

	$effect(() => {
		void ensureAircraftLibrary();
	});

	const planes = $derived(fleet());
	const selected = $derived(selectedAircraft());
	const unknownKey = $derived(aircraftState.selectedKey !== null && selected === null);

	// The fleet grouped by operator and narrowed by the search query. Headers
	// appear once any plane names an operator; while searching, matches always
	// show (the stored fold state is ignored, not mutated).
	const groups = $derived(groupFleet(planes, fleetView.query));
	const showHeaders = $derived(groups.some((g) => g.operator !== null));
	const searching = $derived(fleetView.query.trim() !== '');

	let fileError = $state('');
	let fileInput: HTMLInputElement | undefined;

	function badge(a: Aircraft): string {
		const key = aircraftKey(a);
		if (isUserOnly(key)) {
			return t.aircraft.badgeCustom;
		}
		if (isShadowed(key)) {
			return t.aircraft.badgeEdited;
		}
		return '';
	}

	/* Natively the Android picker, not the WebView's own chooser, which hands
	 * the page a file it cannot always read back; the file then opens as
	 * whatever kind it holds (docs/android.md). */
	function openPicker(): void {
		if (isNativeApp()) {
			void pickFileNatively();
			return;
		}
		fileInput?.click();
	}

	async function onImportFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) {
			return;
		}
		fileError = '';
		try {
			importUserAircraft(parseAircraftYaml(await file.text()));
		} catch (err) {
			fileError = err instanceof Error ? err.message : String(err);
		}
	}

	function onExport(a: Aircraft): void {
		downloadBlob(stringifyAircraftYaml(a), aircraftFileName(aircraftKey(a)), 'text/yaml');
	}

	function numEdit(e: Event, apply: (a: Aircraft, v: number) => void): void {
		const v = Number.parseFloat((e.target as HTMLInputElement).value);
		if (Number.isFinite(v) && v > 0 && aircraftState.selectedKey) {
			updateAircraft(aircraftState.selectedKey, (a) => apply(a, v));
		}
	}

	const rangeNM = $derived.by(() => {
		if (!selected?.cruise) {
			return null;
		}
		const e = enduranceMin(selected);
		return e == null ? null : (e / 60) * selected.cruise.speedKt;
	});
</script>

<div class="tab-panel">
	<h2>{t.aircraft.fleet}</h2>
	{#if aircraftState.libraryError}
		<p class="muted build-error" role="alert">
			{t.aircraft.libraryErrorLead} <span lang="en">{aircraftState.libraryError}</span>
		</p>
	{/if}
	<input
		type="search"
		class="search"
		autocapitalize="none"
		autocomplete="off"
		spellcheck="false"
		enterkeyhint="search"
		placeholder={t.aircraft.searchPlaceholder}
		aria-label={t.aircraft.searchAria}
		bind:value={fleetView.query}
	/>
	<div class="fleet">
		{#snippet planeRow(a: Aircraft)}
			{@const key = aircraftKey(a)}
			<li>
				<button
					class="plane"
					class:selected={key === aircraftState.selectedKey}
					onclick={() => selectAircraft(key)}
				>
					<span class="reg">{a.identity.registration ?? a.identity.type}</span>
					<span class="actype">{a.identity.type}</span>
					{#if a.identity.icaoType}
						<span class="icaotype">{a.identity.icaoType}</span>
					{/if}
					<span class="name">{a.identity.name ?? ''}</span>
					{#if badge(a)}
						<span class="badge">{badge(a)}</span>
					{/if}
				</button>
			</li>
		{/snippet}
		{#each groups as g (g.operator ?? '')}
			{@const expanded = searching || !!fleetView.expanded[g.operator ?? '']}
			{#if showHeaders}
				<button
					class="group-head"
					aria-expanded={expanded}
					onclick={() => toggleFleetGroup(g.operator ?? '')}
				>
					<span class="chev" class:open={expanded} aria-hidden="true"></span>
					<span class="group-title" class:none={g.operator === null}>
						{g.operator ?? t.aircraft.noOperator}
					</span>
					{#if !expanded && g.planes.some((p) => aircraftKey(p) === aircraftState.selectedKey)}
						<span class="sel-dot" title={t.aircraft.containsSelectedTip}></span>
					{/if}
					<span class="count">{g.planes.length}</span>
				</button>
			{/if}
			{#if expanded}
				<ul class="fleet-list">
					{#each g.planes as a (aircraftKey(a))}
						{@render planeRow(a)}
					{/each}
				</ul>
			{/if}
		{/each}
		{#if searching && groups.length === 0}
			<p class="muted">{t.aircraft.noMatch(fleetView.query.trim())}</p>
		{/if}
		{#if unknownKey}
			<ul class="fleet-list">
				<li>
					<div class="plane unknown selected">
						<span class="reg">{aircraftState.selectedKey}</span>
						<span class="name">{t.aircraft.unknownAircraft}</span>
					</div>
				</li>
			</ul>
		{/if}
	</div>

	<div class="file-actions">
		<button class="link-btn" onclick={() => openAircraftCreate()} title={t.aircraft.newAircraftTip}>
			{t.aircraft.newAircraft}
		</button>
		<span class="sep">·</span>
		<button class="link-btn" onclick={openPicker} title={t.aircraft.importTip}>
			{t.aircraft.importAircraft}
		</button>
		{#if selected}
			<span class="sep">·</span>
			<button
				class="link-btn"
				class:on={editorShows(aircraftKey(selected))}
				aria-pressed={editorShows(aircraftKey(selected))}
				onclick={() => openAircraftEditor(aircraftKey(selected))}
				title={t.aircraft.editTip}
			>
				{t.aircraft.edit}
			</button>
			<span class="sep">·</span>
			<button
				class="link-btn"
				onclick={() => openAircraftDuplicate(aircraftKey(selected))}
				title={t.aircraft.duplicateTip}
			>
				{t.aircraft.duplicate}
			</button>
			<span class="sep">·</span>
			<button class="link-btn" onclick={() => onExport(selected)} title={t.aircraft.exportTip}>
				{t.aircraft.exportPlane(selected.identity.registration ?? selected.identity.type)}
			</button>
		{/if}
		{#if aircraftState.selectedKey && isShadowed(aircraftState.selectedKey)}
			<span class="sep">·</span>
			<button
				class="link-btn"
				onclick={() => revertToLibrary(aircraftState.selectedKey!)}
				title={t.aircraft.revertTip}
			>
				{t.aircraft.revert}
			</button>
		{/if}
		{#if aircraftState.selectedKey && isUserOnly(aircraftState.selectedKey)}
			<span class="sep">·</span>
			<button class="link-btn" onclick={() => removeUserAircraft(aircraftState.selectedKey!)}>
				{t.aircraft.delete}
			</button>
		{/if}
		<input
			bind:this={fileInput}
			class="file-input"
			type="file"
			accept={pickerAccept('.yaml,.yml,text/yaml')}
			aria-hidden="true"
			tabindex="-1"
			onchange={onImportFile}
		/>
	</div>
	{#if fileError}
		<!-- Schema validation errors stay English by recorded decision. -->
		<p class="muted build-error" role="alert" lang="en">{fileError}</p>
	{/if}

	{#if selected}
		{@const a = selected}
		<section class="card">
			<h3>
				{a.identity.registration ?? a.identity.type}
				<span class="type">{a.identity.type}</span>
			</h3>
			<label class="field" title={t.aircraft.icaoTypeTip}>
				<span>{t.aircraft.icaoType}</span>
				<input
					type="text"
					autocapitalize="characters"
					spellcheck="false"
					value={a.identity.icaoType ?? ''}
					onchange={(e) => {
						const v = (e.target as HTMLInputElement).value.trim();
						updateAircraft(aircraftKey(a), (x) => {
							x.identity.icaoType = v || undefined;
						});
					}}
				/>
			</label>
			{#if a.identity.icaoType && isKnownDesignator(a.identity.icaoType) === false}
				<p class="icao-unknown">{t.aircraft.icaoTypeUnknown}</p>
			{/if}
			<label class="field">
				<span>{t.aircraft.name}</span>
				<input
					type="text"
					autocapitalize="words"
					value={a.identity.name ?? ''}
					onchange={(e) => {
						const v = (e.target as HTMLInputElement).value.trim();
						updateAircraft(aircraftKey(a), (x) => {
							x.identity.name = v || undefined;
						});
					}}
				/>
			</label>
			<label class="field" title={t.aircraft.operatorTip}>
				<span>{t.aircraft.operator}</span>
				<input
					type="text"
					autocapitalize="words"
					value={a.identity.operator ?? ''}
					onchange={(e) => {
						const v = (e.target as HTMLInputElement).value.trim();
						updateAircraft(aircraftKey(a), (x) => {
							x.identity.operator = v || undefined;
						});
					}}
				/>
			</label>
			{#if a.cruise}
				<label class="field" title={t.aircraft.cruiseSharedTip}>
					<span>{t.aircraft.cruiseSpeed}</span>
					<input
						class="num"
						type="number"
						min="1"
						step="1"
						value={a.cruise.speedKt}
						onchange={(e) => numEdit(e, (x, v) => (x.cruise!.speedKt = v))}
					/>
					<span class="unit">kt</span>
				</label>
			{/if}
			{#if a.fuel}
				<label class="field">
					<span>{t.aircraft.consumption}</span>
					<input
						class="num"
						type="number"
						min="1"
						step="0.5"
						value={a.fuel.consumptionLph ?? ''}
						onchange={(e) => numEdit(e, (x, v) => (x.fuel!.consumptionLph = v))}
					/>
					<span class="unit">L/h</span>
				</label>
				<label class="field">
					<span>{t.aircraft.tankCapacity}</span>
					<input
						class="num"
						type="number"
						min="1"
						step="1"
						value={a.fuel.capacityL}
						onchange={(e) =>
							numEdit(e, (x, v) => {
								x.fuel!.capacityL = v;
								if (x.fuel!.usableL > v) {
									x.fuel!.usableL = v;
								}
							})}
					/>
					<span class="unit">L</span>
				</label>
				<label class="field">
					<span>{t.aircraft.usableFuel}</span>
					<input
						class="num"
						type="number"
						min="1"
						step="1"
						value={a.fuel.usableL}
						onchange={(e) => numEdit(e, (x, v) => (x.fuel!.usableL = Math.min(v, x.fuel!.capacityL)))}
					/>
					<span class="unit">L</span>
				</label>
				<!-- The grade tanked, not a data-sheet edit: an operational pick among
				     the sheet's grades (setTankedFuel), so it never marks the plane
				     edited; the sheet's own grade is the editor's business. -->
				<label class="field" title={t.aircraft.gradeDensityTip}>
					<span>{t.aircraft.fuel}</span>
					<select
						class="fuel-type"
						value={tankedFuelType(aircraftKey(a), a.fuel)}
						onchange={(e) => {
							setTankedFuel(aircraftKey(a), (e.target as HTMLSelectElement).value as FuelType);
						}}
					>
						{#each a.fuel.types as ft (ft)}
							<option value={ft}>{FUEL_TYPE_INFO[ft].label}</option>
						{/each}
					</select>
					<!-- i18n-ignore: kg/L is an invariant unit token -->
					<span class="unit">{tankedFuelDensityKgPerL(aircraftKey(a), a.fuel)} kg/L</span>
				</label>
			{/if}
			{#if enduranceMin(a) != null}
				<p class="derived">
					{t.aircraft.enduranceLine(fmtHHMM(enduranceMin(a)!))}
					{#if rangeNM != null}
						· {t.aircraft.rangeLine(Math.round(rangeNM))}
					{/if}
				</p>
			{/if}
			{#if a.notes}
				<p class="muted">{a.notes}</p>
			{/if}

			<!-- No stations / performance tables here (wide tables live in
			     surfaces): the editor's own pages hold them, one link away. -->
			{#if a.massBalance}
				<p class="small">
					<button
						class="link-btn"
						class:on={editorShows(aircraftKey(a), 'mb')}
						aria-pressed={editorShows(aircraftKey(a), 'mb')}
						onclick={() => openAircraftEditor(aircraftKey(a), 'mb')}
					>
						{t.aircraft.editStationsEnvelope}
					</button>
				</p>
			{/if}

			{#if a.performance}
				<p class="small">
					<button
						class="link-btn"
						class:on={editorShows(aircraftKey(a), 'perf')}
						aria-pressed={editorShows(aircraftKey(a), 'perf')}
						onclick={() => openAircraftEditor(aircraftKey(a), 'perf')}
					>
						{t.aircraft.editPerfData}
					</button>
				</p>
			{/if}
			{#if a.source}
				<p class="muted small">{t.aircraft.sourceLine(a.source)}</p>
			{/if}
		</section>
	{:else}
		<p class="muted">
			{t.aircraft.selectPrompt}
			{#if !aircraftState.libraryLoaded}{t.aircraft.libraryLoading}{/if}
		</p>
	{/if}
	<!-- No flight-preparation launcher here: the toolbar is its one home
	     (the cluster / the Flight disclosure / the phone More menu). -->
</div>

<style>
	.tab-panel {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.muted {
		font-size: 12.5px;
		color: var(--text-muted);
	}

	.small {
		font-size: 12px;
	}

	.build-error {
		color: var(--danger);
	}

	.fleet {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.fleet-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* Operator group header: chevron + name + count pill (the NotamGroup
	 * pattern); shown only once at least one plane names an operator. */
	.group-head {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		margin-top: 4px;
		padding: 3px 2px;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		text-align: left;
		color: var(--text);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.group-head:first-child {
		margin-top: 0;
	}

	.chev {
		flex: 0 0 auto;
		width: 0;
		height: 0;
		border-top: 4px solid transparent;
		border-bottom: 4px solid transparent;
		border-left: 5px solid var(--text-muted);
		transition: transform 0.12s ease;
	}

	.chev.open {
		transform: rotate(90deg);
	}

	.group-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.group-title.none {
		font-style: italic;
		font-weight: 500;
		color: var(--text-muted);
	}

	/* Marks a folded group holding the selected aircraft, so the selection
	 * never silently disappears. */
	.sel-dot {
		flex: 0 0 auto;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
	}

	.count {
		flex: 0 0 auto;
		margin-left: auto;
		padding: 0 6px;
		font-size: 11px;
		font-weight: 700;
		color: var(--text-muted);
		background: var(--surface-2);
		border-radius: 999px;
	}

	/* Picking the aircraft is the tab's whole purpose, so the rows carry the
	   touch floor: measured 29px (fleet row) and 20px (operator header) on a
	   phone, both under it. These rows are free to grow, unlike the dense
	   planning tables. */
	:global(:root.touch-ui) .plane,
	:global(:root.touch-ui) .group-head {
		min-height: 44px;
	}

	.plane {
		display: flex;
		align-items: baseline;
		gap: 8px;
		width: 100%;
		text-align: left;
		font: inherit;
		font-size: 13px;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}

	.plane:hover {
		background: var(--surface-2);
	}

	.plane.selected {
		border-color: var(--accent);
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.plane.unknown {
		cursor: default;
		border-color: var(--danger);
	}

	.reg {
		min-width: 64px;
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', consolas, monospace;
		font-size: 12.5px;
		font-weight: 700;
	}

	.actype {
		flex: 0 0 auto;
		font-size: 12px;
	}

	.icaotype {
		flex: 0 0 auto;
		font-family: ui-monospace, 'SF Mono', 'Cascadia Code', consolas, monospace;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Advisory only (the FAA list is a subset of Doc 8643); aligned under
	 * the field's input (110px label + 8px gap). */
	.icao-unknown {
		margin: -4px 0 0 118px;
		font-size: 12px;
		color: var(--workbook-orange);
	}

	.name {
		flex: 1;
		color: var(--text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.badge {
		font-size: 10.5px;
		font-weight: 600;
		text-transform: uppercase;
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--surface-3);
		color: var(--text-muted);
	}

	.file-actions {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		flex-wrap: wrap;
	}

	.link-btn {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--accent);
		cursor: pointer;
	}

	/* An entry point whose editor is up on THIS plane and page reads as
	   pressed: it is a toggle, so the next press puts it away. */
	.link-btn.on {
		font-weight: 600;
		text-decoration: underline;
	}

	.link-btn:hover {
		text-decoration: underline;
	}

	.sep {
		color: var(--text-muted);
	}

	.file-input {
		display: none;
	}

	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.card h3 {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.type {
		font-weight: 400;
		font-size: 12px;
		color: var(--text-muted);
	}

	.field {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
	}

	.field > span:first-child {
		width: 110px;
		color: var(--text-muted);
	}

	.field input,
	.field select {
		font: inherit;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 6px;
		flex: 1;
		min-width: 0;
	}

	.field select {
		flex: 0 1 auto;
	}

	/* Fixed width fitting the widest grade label ("UL Aéro Super+", 134px measured),
	   so the box and the kg/L reading beside it don't jump when a shorter grade is
	   selected. */
	.field select.fuel-type {
		flex: 0 0 136px;
	}

	.field .num {
		flex: 0 0 80px;
	}

	.unit {
		color: var(--text-muted);
		font-size: 12px;
	}

	.derived {
		margin: 0;
		font-size: 12.5px;
		font-weight: 600;
	}

</style>
