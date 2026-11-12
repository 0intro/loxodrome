<script lang="ts">
	/* The aircraft fleet manager: the committed library + user planes
	 * (shadowing by registration), selection of the active aircraft, the
	 * basics editable in place (copy-on-write into the user store), ONE link
	 * into the editor for the rest of the sheet (a generic sheet's shows it
	 * read-only), and per-plane YAML import / export. While the editor is up
	 * beside this tab, a plane picked in the list moves it there
	 * (pickAircraft). */

	import ConfirmDialog from '../ConfirmDialog.svelte';
	import {
		aircraftState,
		ensureAircraftLibrary,
		fleet,
		selectedAircraft,
		aircraftByKey,
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
		isMultiEngine,
		parseAircraftYaml,
		stringifyAircraftYaml,
		enduranceMin,
		FUEL_TYPE_INFO,
		GENERIC_KEY_PREFIX,
		type Aircraft,
		type FuelType,
	} from '$lib/aircraft/schema';
	import {
		closeAircraftEditor,
		editorShows,
		openAircraftCreate,
		openAircraftDuplicate,
		openAircraftEditor,
		pickAircraft,
	} from '$lib/state/aircraftEditor.svelte';
	import { groupFleet, type FleetGroup } from '$lib/aircraft/fleetSearch';
	import { downloadBlob } from '$lib/ui/dom';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { singleLine } from '$lib/ui/singleLine';
	import { isNativeApp } from '$lib/native/platform';
	import { importAircraftSheet, pickFileNatively } from '$lib/state/openFile.svelte';
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
	const groups = $derived(groupFleet(planes, fleetView.query, { genericLabel: t.aircraft.genericGroup }));
	const showHeaders = $derived(groups.some((g) => g.kind !== 'none'));

	/** A group's fold key: the operator's name, '' for the planes without
	 *  one, and for the generic sheets a key no operator name takes. */
	function groupKey(g: FleetGroup): string {
		return g.kind === 'generic' ? GENERIC_KEY_PREFIX : (g.operator ?? '');
	}
	const searching = $derived(fleetView.query.trim() !== '');

	let fileError = $state('');
	let fileInput: HTMLInputElement | undefined;

	function badge(a: Aircraft): string {
		if (a.identity.generic !== undefined) {
			return t.aircraft.badgeGeneric;
		}
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
			importAircraftSheet(parseAircraftYaml(await file.text()));
		} catch (err) {
			fileError = err instanceof Error ? err.message : String(err);
		}
	}

	function onExport(a: Aircraft): void {
		downloadBlob(stringifyAircraftYaml(a), aircraftFileName(aircraftKey(a)), 'text/yaml');
	}

	/* Delete asks first, through the app's ConfirmDialog, as every
	 * destructive action does: it drops the pilot's own sheet, on every synced
	 * device too. Answered, it also puts away an editor showing that plane,
	 * whose Save would otherwise bring the sheet straight back; its unsaved
	 * edits go with the plane. */
	let pendingDelete = $state<string | null>(null);

	function deletePlane(): void {
		const key = pendingDelete;
		pendingDelete = null;
		if (key === null) {
			return;
		}
		if (editorShows(key)) {
			closeAircraftEditor();
		}
		removeUserAircraft(key);
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
					onclick={() => pickAircraft(key)}
				>
					<span class="reg">{a.identity.registration ?? a.identity.type}</span>
					<!-- A generic sheet's key is its type: shown once. -->
					{#if a.identity.generic === undefined}
						<span class="actype">{a.identity.type}</span>
					{/if}
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
		{#each groups as g (groupKey(g))}
			{@const expanded = searching || !!fleetView.expanded[groupKey(g)]}
			{#if showHeaders}
				<button
					class="group-head"
					aria-expanded={expanded}
					title={g.kind === 'generic' ? t.aircraft.genericGroupTip : undefined}
					onclick={() => toggleFleetGroup(groupKey(g))}
				>
					<span class="chev" class:open={expanded} aria-hidden="true"></span>
					<span class="group-title" class:none={g.kind === 'none'}>
						{g.kind === 'generic' ? t.aircraft.genericGroup : (g.operator ?? t.aircraft.noOperator)}
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
			{@const generic = selected.identity.generic !== undefined}
			<!-- A generic sheet is read-only: Duplicate is the way to a pilot's
			     own plane, with its registration and weighing. The editor's one
			     door is the card's link below. -->
			<span class="sep">·</span>
			<button
				class="link-btn"
				onclick={() => openAircraftDuplicate(aircraftKey(selected))}
				title={generic ? t.aircraft.duplicateGenericTip : t.aircraft.duplicateTip}
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
			<button class="link-btn" onclick={() => (pendingDelete = aircraftState.selectedKey)}>
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
		<!-- A generic sheet reads as text: its fields are the manual's, and a
		     pilot's own figures go on a Duplicate. -->
		{@const ro = a.identity.generic !== undefined}
		<section class="card">
			<h3>
				{a.identity.registration ?? a.identity.type}
				{#if ro}
					<span class="badge">{t.aircraft.badgeGeneric}</span>
				{:else}
					<span class="type">{a.identity.type}</span>
				{/if}
			</h3>
			{#if ro}
				<p class="muted small">{t.aircraft.genericCardNote}</p>
			{/if}
			{#if isMultiEngine(a)}
				<p class="muted small">{t.aircraft.twinCardNote}</p>
			{/if}
			<label class="field" title={t.aircraft.icaoTypeTip}>
				<span>{t.aircraft.icaoType}</span>
				<input
					disabled={ro}
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
			<!-- A box that wraps: a generic sheet's name states its serial range,
			     and its read-only box cannot be scrolled. Enter commits. -->
			<label class="field top">
				<span>{t.aircraft.name}</span>
				<textarea
					class="one-line"
					rows="1"
					disabled={ro}
					autocapitalize="words"
					use:singleLine={{ commitOnEnter: true }}
					value={a.identity.name ?? ''}
					onchange={(e) => {
						const v = (e.target as HTMLTextAreaElement).value.trim();
						updateAircraft(aircraftKey(a), (x) => {
							x.identity.name = v || undefined;
						});
					}}
				></textarea>
			</label>
			<label class="field" title={t.aircraft.operatorTip}>
				<span>{t.aircraft.operator}</span>
				<input
					disabled={ro}
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
				<label class="field" title={t.aircraft.cruiseRouteTip}>
					<span>{t.aircraft.cruiseSpeed}</span>
					<input
						disabled={ro}
						class="num"
						type="number"
						lang="en"
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
					<span>{isMultiEngine(a) ? t.aircraft.consumptionBothEngines : t.aircraft.consumption}</span>
					<input
						disabled={ro}
						class="num"
						type="number"
						lang="en"
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
						disabled={ro}
						class="num"
						type="number"
						lang="en"
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
						disabled={ro}
						class="num"
						type="number"
						lang="en"
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
				<!-- The density reading follows the box, whole: beside it where the
				     row holds both, under it on the box column where it does not
				     (the default sidebar, its label column holding every label). -->
				<label class="field top" title={t.aircraft.gradeDensityTip}>
					<span>{t.aircraft.fuel}</span>
					<span class="grade">
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
					</span>
				</label>
			{/if}
			{#if enduranceMin(a) != null}
				<!-- A comma, not a middle dot: the app's prose takes sentences or
				     commas. -->
				<p class="derived">
					{t.aircraft.enduranceLine(fmtHHMM(enduranceMin(a)!))}{#if rangeNM != null}, {t.aircraft.rangeLine(Math.round(rangeNM))}{/if}
				</p>
			{/if}
			{#if a.notes}
				<p class="muted">{a.notes}</p>
			{/if}

			<!-- No stations / performance tables here (wide tables live in
			     surfaces): the editor's own pages hold them, behind ONE link
			     that opens it on the page last shown, a toggle like every
			     surface's own button. A generic sheet's shows it read-only. -->
			<p class="small">
				<button
					class="link-btn"
					class:on={editorShows(aircraftKey(a))}
					aria-pressed={editorShows(aircraftKey(a))}
					onclick={() => openAircraftEditor(aircraftKey(a))}
					title={ro ? t.aircraft.viewSheetTip : t.aircraft.editTip}
				>
					{ro ? t.aircraft.viewSheet : t.aircraft.editSheet}
				</button>
			</p>
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

{#if pendingDelete !== null}
	{@const doomed = aircraftByKey(pendingDelete)}
	<ConfirmDialog
		message={t.aircraft.confirmDelete(doomed?.identity.registration ?? doomed?.identity.type ?? pendingDelete)}
		confirmLabel={t.aircraft.delete}
		danger
		onConfirm={deletePlane}
		onCancel={() => (pendingDelete = null)}
	/>
{/if}

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
	 * the field's box (the label column + 8px gap). */
	.icao-unknown {
		margin: -4px 0 0 calc(var(--label-w) + 8px);
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

	/* The editor's link reads pressed while the editor is up on THIS plane:
	   it is a toggle, so the next press puts it away. */
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

	/* The labels' column holds the longest French label on one line (147 px,
	   "Capacité des réservoirs", where 110 px wrapped three labels at every
	   sidebar width) from the 400 px default sidebar up; a narrower card gives
	   it under half its width, a label then wrapping. */
	.card {
		--label-w: clamp(96px, 44%, 150px);

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
		flex: 0 0 var(--label-w);
		color: var(--text-muted);
	}

	/* A wrapping box's label sits on its first line. */
	.field.top {
		align-items: flex-start;
	}

	.field.top > span:first-child {
		padding-block-start: 3px;
	}

	.field input,
	.field textarea,
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

	/* A basis fitting the widest grade label ("UL Aéro Super+", 134px measured),
	   so the box and the kg/L reading beside it don't jump when a shorter grade is
	   selected: its width follows the row, never the option shown. It shrinks
	   where the row cannot hold it, which a narrow sidebar's French label made
	   happen (32 px past a 280 px panel); the label and the reading give too. */
	.field select.fuel-type {
		flex: 0 1 136px;
		min-width: 0;
	}

	.field .num {
		flex: 0 0 80px;
	}

	.grade {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		gap: 2px 8px;
		align-items: center;
		min-width: 0;
	}

	.grade .unit {
		white-space: nowrap;
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
