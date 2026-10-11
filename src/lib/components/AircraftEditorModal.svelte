<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* The aircraft editor: every data-sheet field over four pages (General,
	 * Mass & balance, Performance, YAML). Edits live in a string-typed draft
	 * (src/lib/aircraft/edit.ts) validated live by the schema parser; Save
	 * commits only a schema-valid Aircraft through saveEditedAircraft, so
	 * localStorage can never receive a sheet that would fail to parse next
	 * session, and the editor stays on the saved plane. Create mode covers
	 * both a blank sheet and a duplicate (registration cleared); view mode
	 * shows a generic library sheet read-only, with Duplicate in place of
	 * Save. The editor follows the plane picked in the Aircraft tab
	 * (state/aircraftEditor.svelte.ts), every change of subject asking first
	 * through this modal's leave guard when the draft holds unsaved edits. */

	import { tick, untrack } from 'svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PageTabs from './PageTabs.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import GeneralPage from './aircrafteditor/GeneralPage.svelte';
	import MassBalanceEditPage from './aircrafteditor/MassBalanceEditPage.svelte';
	import PerformanceEditPage from './aircrafteditor/PerformanceEditPage.svelte';
	import YamlPage from './aircrafteditor/YamlPage.svelte';
	import { provideRemoval, untouched, type RemovedPart } from './aircrafteditor/removal';
	import {
		aircraftEditor,
		closeAircraftEditor,
		degradeToCreate,
		editorSaved,
		openAircraftDuplicate,
		registerEditorLeaveGuard,
	} from '$lib/state/aircraftEditor.svelte';
	import {
		aircraftByKey,
		aircraftState,
		ensureAircraftLibrary,
		isLibraryKey,
		saveEditedAircraft,
	} from '$lib/state/aircraft.svelte';
	import { remapStationLoads } from '$lib/state/flightPrep.svelte';
	import { stationKeyRemap } from '$lib/aircraft/massBalance';
	import { plausibilityPage, plausibilityWarnings } from '$lib/aircraft/plausibility';
	import {
		aircraftToDraft,
		duplicateDraft,
		draftGaps,
		draftToAircraft,
		errorPage,
		rebaseDraft,
		type AircraftDraft,
		type AircraftEditorPage,
	} from '$lib/aircraft/edit';
	import { storageSealed } from '$lib/state/persist';
	import {
		aircraftKey,
		GENERIC_KEY_PREFIX,
		parseAircraftYaml,
		stringifyAircraftYaml,
	} from '$lib/aircraft/schema';
	import type { ErrorText } from '$lib/i18n/errorText';

	// Key-only page registry; labels resolve through t at render so a locale
	// switch re-labels the tabs (docs/i18n.md rule 2).
	const PAGES: { id: AircraftEditorPage; icon: string }[] = [
		{ id: 'general', icon: 'plane' },
		{ id: 'mb', icon: 'scale' },
		{ id: 'perf', icon: 'gauge' },
		{ id: 'yaml', icon: 'file-text' },
	];

	let draft = $state<AircraftDraft>(aircraftToDraft(null));
	let initialDraftJson = $state('');
	// The fleet-save error is a deferred thunk (docs/i18n.md rule 7): calling
	// it in the template reads t, so it re-renders on a locale switch.
	let saveError = $state<ErrorText | null>(null);
	let yamlText = $state('');
	let yamlError = $state('');
	let yamlDirty = $state(false);
	// A copy of a generic sheet is one aircraft: it needs its registration
	// and its own weighing (duplicateDraft blanks the manual's sample).
	let fromGeneric = $state(false);
	// The key a save just stored the sheet under, said in the footer while
	// the draft stays as saved; a new subject forgets it.
	let savedKey = $state<string | null>(null);
	// A part changed both here and elsewhere since the draft's base, the
	// pilot's own kept (rebaseDraft): said in the footer while it stands.
	let overridden = $state(false);

	// Rebuild the draft once per change of subject, not per placement: docking
	// or maximising the editor must not clobber in-progress edits, and asking
	// for another plane while it is already up must reseed even though
	// nothing about the slot changed. The fleet lookup stays untracked so the
	// async library load (or a shadow pruning) cannot re-run this either.
	$effect(() => {
		void aircraftEditor.requestSeq;
		if (!aircraftEditor.open) {
			return;
		}
		untrack(() => {
			void ensureAircraftLibrary();
			const src = aircraftEditor.key ? aircraftByKey(aircraftEditor.key) : null;
			const snap = src ? $state.snapshot(src) : null;
			if (aircraftEditor.mode !== 'create' && !snap) {
				// The plane vanished (deleted elsewhere): degrade to a blank create.
				degradeToCreate();
			}
			draft = aircraftEditor.mode !== 'create' ? aircraftToDraft(snap) : snap ? duplicateDraft(snap) : aircraftToDraft(null);
			fromGeneric = aircraftEditor.mode === 'create' && snap?.identity.generic !== undefined;
			initialDraftJson = JSON.stringify($state.snapshot(draft));
			saveError = null;
			savedKey = null;
			overridden = false;
			yamlText = '';
			yamlError = '';
			yamlDirty = false;
		});
	});

	const readOnly = $derived(aircraftEditor.mode === 'view');
	const result = $derived(draftToAircraft($state.snapshot(draft), { requireRegistration: fromGeneric }));
	const errPage = $derived(result.ok ? null : errorPage(result.errors[0]));
	// Every box the sheet still needs, at once (edit.ts draftGaps), where the
	// schema stops at its first: the footer counts them, a dot marks each
	// page holding one, and each box marks itself (its `required`).
	const gaps = $derived(readOnly ? [] : draftGaps($state.snapshot(draft), { requireRegistration: fromGeneric }));
	/** Does a page hold something to fill in or correct? Its gaps, else the
	 *  schema's first error once every box is filled. */
	function needsWork(id: AircraftEditorPage): boolean {
		return gaps.length > 0 ? gaps.some((g) => g.page === id) : errPage === id;
	}

	/* A number box holding text it cannot read ("1 050", "1050-") hands the
	 * draft an empty string, which an optional box takes for "not stated":
	 * the box showed red (the browser's own badInput) while the footer read
	 * the sheet as valid, and Save dropped what had been typed. Such boxes
	 * count with the gaps and hold Save back. A required one is a gap
	 * already (its draft holds ''), so only the optional ones add. Only the
	 * page shown has boxes; another page's are drawn afresh from the draft. */
	let unreadable = $state(0);

	function countUnreadable(): void {
		let n = 0;
		for (const box of bodyEl?.querySelectorAll<HTMLInputElement>('input[type="number"]') ?? []) {
			if (box.validity.badInput && !box.required) {
				n++;
			}
		}
		unreadable = n;
	}

	// A new page or a new subject draws its boxes afresh.
	$effect(() => {
		void aircraftEditor.page;
		void aircraftEditor.requestSeq;
		void tick().then(countUnreadable);
	});
	const toFix = $derived(gaps.length + unreadable);
	// The figures to check (aircraft/plausibility.ts), on a sheet that
	// validates: an aid to transcription, so a read-only view, where nothing
	// is typed, lists none.
	const warnings = $derived(result.ok && !readOnly ? plausibilityWarnings(result.aircraft) : []);
	const mbWarnings = $derived(warnings.filter((w) => plausibilityPage(w) === 'mb'));
	const perfWarnings = $derived(warnings.filter((w) => plausibilityPage(w) === 'perf'));
	/** The page holding the first figures to check, for the footer's link. */
	const warnPage = $derived(warnings.length > 0 ? plausibilityPage(warnings[0]) : null);
	const validKey = $derived(result.ok ? aircraftKey(result.aircraft) : null);
	const keyLocked = $derived(
		aircraftEditor.mode === 'edit' && aircraftEditor.key !== null && isLibraryKey(aircraftEditor.key),
	);

	/** What the pilot calls a plane: its registration, else its type, never a
	 *  generic sheet's `generic:` key (the tab's own label). */
	function nameOf(key: string): string {
		const a = aircraftByKey(key);
		if (a) {
			return a.identity.registration ?? a.identity.type;
		}
		return key.startsWith(GENERIC_KEY_PREFIX) ? key.slice(GENERIC_KEY_PREFIX.length) : key;
	}

	const title = $derived.by(() => {
		const key = aircraftEditor.key;
		if (key === null) {
			return t.aircraft.newAircraft;
		}
		switch (aircraftEditor.mode) {
			case 'edit':
				return t.aircraft.editTitle(nameOf(key));
			case 'view':
				return t.aircraft.viewTitle(nameOf(key));
			case 'create':
				return t.aircraft.newCopyTitle(nameOf(key));
		}
	});
	const dirty = $derived(JSON.stringify($state.snapshot(draft)) !== initialDraftJson || yamlDirty);

	/* The sheet open here can change elsewhere while the editor stays up beside
	 * the Aircraft tab: the card's inline basics, a revert, an import, a sync.
	 * The draft then takes every change the pilot has not made otherwise here
	 * (rebaseDraft, against the base it was seeded from), and that sheet
	 * becomes its new base, so a Save never writes stale figures over the
	 * change, and an untouched draft simply shows it. The editor's own seed and
	 * save land on the base already, so they read as no change. */
	const stored = $derived(
		aircraftEditor.open && aircraftEditor.mode !== 'create' && aircraftEditor.key !== null
			? aircraftByKey(aircraftEditor.key)
			: null,
	);
	$effect(() => {
		if (stored === null) {
			return;
		}
		const next = aircraftToDraft($state.snapshot(stored));
		const nextJson = JSON.stringify(next);
		untrack(() => {
			if (nextJson === initialDraftJson) {
				return;
			}
			const merged = rebaseDraft($state.snapshot(draft), JSON.parse(initialDraftJson) as AircraftDraft, next);
			draft = merged.draft;
			initialDraftJson = nextJson;
			if (merged.conflict) {
				overridden = true;
			}
		});
	});

	// Any draft change invalidates the last save attempt's error.
	$effect(() => {
		void result;
		saveError = null;
	});

	// Entering the YAML page (re)seeds the text from the current draft,
	// unless the user has typed there; an invalid draft keeps the last text.
	$effect(() => {
		if (!aircraftEditor.open || aircraftEditor.page !== 'yaml' || yamlDirty) {
			return;
		}
		if (result.ok) {
			yamlText = stringifyAircraftYaml(result.aircraft);
		}
	});

	function applyYaml(): void {
		try {
			// A pasted generic sheet becomes the pilot's plane, as a Duplicate
			// does: kept, the flag would key the save as the library sheet.
			draft = { ...aircraftToDraft(parseAircraftYaml(yamlText)), generic: '' };
			yamlError = '';
			yamlDirty = false;
		} catch (e) {
			yamlError = e instanceof Error ? e.message : String(e);
		}
	}

	/* Every destructive question goes through the app's own ConfirmDialog,
	 * which is themed, sized to the app's touch floor and puts initial focus on
	 * Cancel; what it guards here is an afternoon of data-sheet edits, so a
	 * stray Enter must not be what discards them. The pending action is held
	 * until the question is answered: a discard (a close, a change of subject,
	 * a save leaving YAML unapplied) or the removal of a section or a
	 * configuration that holds figures. One question at a time: a request
	 * arriving while one is up is dropped, never replacing it. */
	type Question =
		| { kind: 'discard'; run: () => void }
		| { kind: 'remove'; part: RemovedPart; name: () => string; run: () => void };
	let question = $state<Question | null>(null);

	/** The question a removal asks, worded by what it removes. */
	function removalQuestion(part: RemovedPart, name: string): string {
		switch (part) {
			case 'section':
				return t.aircraft.confirmRemoveSection(name);
			case 'config':
				return t.aircraft.confirmRemoveConfig(name);
			case 'altitude':
				return t.aircraft.confirmRemoveAltitude(name);
			case 'column':
				return t.aircraft.confirmRemoveColumn(name);
			case 'model':
				return t.aircraft.confirmSwitchModel(name);
		}
	}

	function ask(q: Question): void {
		if (question === null) {
			question = q;
		}
	}

	/** The leave guard: a close or a change of subject runs at once, or waits
	 *  behind the discard confirm while the open draft holds unsaved edits. */
	function leave(proceed: () => void): void {
		if (question !== null) {
			return;
		}
		if (aircraftEditor.open && dirty) {
			question = { kind: 'discard', run: proceed };
		} else {
			proceed();
		}
	}

	// For the component's whole life; the body reads nothing reactive, so it
	// runs once, and the teardown unregisters this guard only.
	$effect(() => registerEditorLeaveGuard(leave));

	// The pages' "Remove section" and "Remove config": a part nobody filled in
	// goes at once, one holding figures asks first.
	provideRemoval((part, name, current, blank, remove) => {
		if (untouched(current, blank)) {
			remove();
		} else {
			ask({ kind: 'remove', part, name, run: remove });
		}
	});

	// A reload or a closed tab would drop unsaved edits without a word: the
	// browser's own leave question stands in front of them, armed only while
	// there are some (an Android WebView ignores it, as every app's).
	$effect(() => {
		if (!aircraftEditor.open || !dirty) {
			return;
		}
		// Not on the app's own way out (Reset, a sign-out's wipe, a shared
		// session's end), which seals storage first: nothing could be saved
		// then, and a Stay would keep wiped data on screen.
		const hold = (e: BeforeUnloadEvent): void => {
			if (!storageSealed()) {
				e.preventDefault();
			}
		};
		window.addEventListener('beforeunload', hold);
		return () => window.removeEventListener('beforeunload', hold);
	});

	let closeButton = $state<HTMLButtonElement>();
	let bodyEl = $state<HTMLElement>();

	function onSave(): void {
		if (!result.ok || unreadable > 0) {
			return;
		}
		// Unapplied YAML edits are not in the draft: saving would silently
		// discard them, so confirm like the dirty close does (Apply on the
		// YAML page folds them in and clears the flag).
		if (yamlDirty) {
			ask({ kind: 'discard', run: commitSave });
			return;
		}
		commitSave();
	}

	function commitSave(): void {
		if (!result.ok) {
			return;
		}
		const saved = result.aircraft;
		const originalKey = aircraftEditor.mode === 'edit' ? aircraftEditor.key : null;
		// The stations as stored until now: flight preparation keys the loads
		// typed for them by their labels.
		const was = originalKey !== null ? aircraftByKey(originalKey)?.massBalance : undefined;
		const before = was ? $state.snapshot(was) : null;
		const err = saveEditedAircraft(originalKey, saved);
		if (err) {
			saveError = err;
			return;
		}
		const key = aircraftKey(saved);
		// A station renamed, or one taken out, on the plane flight preparation
		// flies: the loads typed for its stations follow them (a re-key moved
		// the selection along already).
		if (before && saved.massBalance && aircraftState.selectedKey === key) {
			const remap = stationKeyRemap(before, saved.massBalance);
			if (remap !== null) {
				remapStationLoads(remap);
			}
		}
		// The editor stays on the plane it saved, under the key it was saved
		// as, its draft reseeded from the fleet: the figures as stored, and the
		// baseline the next edit is measured against.
		const stored = aircraftByKey(key);
		editorSaved(key);
		draft = aircraftToDraft(stored ? $state.snapshot(stored) : saved);
		initialDraftJson = JSON.stringify($state.snapshot(draft));
		fromGeneric = false;
		yamlText = '';
		yamlError = '';
		yamlDirty = false;
		savedKey = key;
		overridden = false;
		// Save, just pressed, turns disabled (nothing is left to save), and a
		// disabled button drops the focus to the page: Close takes it.
		void tick().then(() => closeButton?.focus());
	}

	function requestClose(): void {
		leave(closeAircraftEditor);
	}

	/** To the first box still needed: on this page, else on the first page
	 *  holding one, which opens first. */
	function showFirstGap(): void {
		if (unreadable === 0 && gaps.length > 0 && !gaps.some((g) => g.page === aircraftEditor.page)) {
			aircraftEditor.page = gaps[0].page;
		}
		void tick().then(() =>
			bodyEl?.querySelector<HTMLElement>('input:invalid, textarea:invalid')?.focus(),
		);
	}

	/** A generic sheet's way to the pilot's own plane: its copy, with the
	 *  registration and the weighing to fill in. */
	function duplicateShown(): void {
		if (aircraftEditor.key !== null) {
			openAircraftDuplicate(aircraftEditor.key);
			// The footer's Duplicate goes with the view it belonged to: the
			// copy's first need, its registration, takes the focus.
			void tick().then(() => bodyEl?.querySelector<HTMLElement>('input.w-code')?.focus());
		}
	}

	function pageLabel(id: AircraftEditorPage): string {
		switch (id) {
			case 'general':
				return t.aircraft.pageGeneral;
			case 'mb':
				return t.aircraft.pageMb;
			case 'perf':
				return t.aircraft.pagePerf;
			case 'yaml':
				return t.aircraft.pageYaml;
		}
	}
</script>

<SurfaceShell
	id="aircraftEditor"
	onClose={requestClose}
	label={t.aircraft.editorAria}
	boxClass="aircraft-editor-box"
>
	{#snippet header()}
		<h2>{title}</h2>
		{#snippet errorDot(id: AircraftEditorPage)}
			{#if needsWork(id) && aircraftEditor.page !== id}
				<span class="dot" title={t.aircraft.errorDotTip}></span>
			{:else if aircraftEditor.page !== id && ((id === 'mb' && mbWarnings.length > 0) || (id === 'perf' && perfWarnings.length > 0))}
				<span class="dot warn" title={t.aircraft.warnDotTip}></span>
			{/if}
		{/snippet}
		<PageTabs
			pages={PAGES}
			current={aircraftEditor.page}
			onSelect={(id: AircraftEditorPage) => (aircraftEditor.page = id)}
			ariaLabel={t.aircraft.pagesAria}
			labelFor={pageLabel}
			badge={errorDot}
		/>
	{/snippet}

	<div class="body" class:read-only={readOnly} bind:this={bodyEl} oninput={countUnreadable}>
		{#if aircraftEditor.page === 'yaml'}
			<YamlPage
				bind:text={yamlText}
				error={yamlError}
				stale={!result.ok && !yamlDirty}
				readonly={readOnly}
				onapply={applyYaml}
				ontyped={() => {
					yamlDirty = true;
					yamlError = '';
				}}
			/>
		{:else}
			<!-- The form pages' one wrapper: a generic sheet's view disables it,
			     which locks every control on the page at once. -->
			<fieldset class="sheet" disabled={readOnly}>
				{#if aircraftEditor.page === 'general'}
					<GeneralPage bind:draft {keyLocked} {fromGeneric} />
				{:else if aircraftEditor.page === 'mb'}
					<MassBalanceEditPage bind:draft {fromGeneric} warnings={mbWarnings} />
				{:else}
					<PerformanceEditPage
						bind:draft
						validPerformance={result.ok ? (result.aircraft.performance ?? null) : null}
						validOei={result.ok ? (result.aircraft.oneEngineInoperative ?? null) : null}
						warnings={perfWarnings}
					/>
				{/if}
			</fieldset>
		{/if}
	</div>

	<footer class="foot">
		{#if readOnly}
			<span class="msg">{t.aircraft.readOnlyNote}</span>
			<button class="btn" onclick={requestClose}>{t.common.close}</button>
			<button class="btn primary" onclick={duplicateShown}>{t.aircraft.duplicate}</button>
		{:else}
			{#if saveError}
				<span class="msg save-error" role="alert">{saveError()}</span>
			{:else if toFix > 0}
				<span class="msg">
					{t.aircraft.boxesToFill(toFix)}
					<button class="link-btn" onclick={showFirstGap}>
						{unreadable > 0 || gaps.some((g) => g.page === aircraftEditor.page)
							? t.aircraft.showFirstGap
							: t.aircraft.openPage(pageLabel(gaps[0].page))}
					</button>
				</span>
			{:else if !result.ok}
				<span class="msg">
					<!-- Schema validation errors stay English by recorded decision. -->
					<span lang="en">{result.errors[0]}</span>
					{#if errPage && errPage !== aircraftEditor.page}
						<button class="link-btn" onclick={() => (aircraftEditor.page = errPage)}>
							{t.aircraft.openPage(pageLabel(errPage))}
						</button>
					{/if}
				</span>
			{:else if savedKey !== null && !dirty}
				<span class="msg ok">{t.aircraft.savedSheet(savedKey)}</span>
			{:else if overridden && dirty}
				<span class="msg">{t.aircraft.changedElsewhere}</span>
			{:else}
				<span class="msg ok">
					{t.aircraft.validSheet(validKey ?? '')}
					{#if warnPage !== null}
						<!-- The figures to check stand on their page: the count says
						     there are some, and opens it from another. -->
						{#if warnPage !== aircraftEditor.page}
							<button class="link-btn warn" onclick={() => (aircraftEditor.page = warnPage)}>
								{t.aircraft.figuresToCheck(warnings.length)}
							</button>
						{:else}
							<span class="warn">{t.aircraft.figuresToCheck(warnings.length)}</span>
						{/if}
					{/if}
				</span>
			{/if}
			<!-- A save, said to a screen reader too: the line above is no live
			     region, its validation messages changing on every keystroke. -->
			<span class="sr-only" role="status">{savedKey !== null && !dirty ? t.aircraft.savedSheet(savedKey) : ''}</span>
			<!-- Nothing unsaved, the left button only closes; with changes it
			     cancels them, behind the discard confirm. -->
			<button class="btn" bind:this={closeButton} onclick={requestClose}>{dirty ? t.aircraft.cancel : t.common.close}</button>
			<!-- A new sheet's save is what adds the plane to the fleet. -->
			<button
				class="btn primary"
				disabled={!result.ok || unreadable > 0 || (!dirty && aircraftEditor.mode !== 'create')}
				onclick={onSave}
			>
				{aircraftEditor.mode === 'create' ? t.aircraft.addToFleet : t.aircraft.save}
			</button>
		{/if}
	</footer>
</SurfaceShell>

{#if question}
	{@const q = question}
	<ConfirmDialog
		message={q.kind === 'discard' ? t.common.discardChanges : removalQuestion(q.part, q.name())}
		confirmLabel={q.kind === 'discard'
			? t.common.discardChangesAction
			: q.part === 'model'
				? t.aircraft.switchModelAction
				: t.aircraft.remove}
		danger
		onConfirm={() => {
			// Taken before the question is cleared: `q` derives from it, and
			// reads null once it is.
			const run = q.run;
			question = null;
			run();
		}}
		onCancel={() => (question = null)}
	/>
{/if}

<style>
	:global(.aircraft-editor-box) {
		--modal-width: min(1080px, 96vw);

		/* A constant size across the four pages (the body scrolls). */
		height: min(840px, 86vh);
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
		white-space: nowrap;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--danger);
	}

	/* Figures to check: the workbook's orange, as on their page. */
	.dot.warn {
		background: var(--workbook-orange);
	}

	/* Same as flight preparation: the POH grids have a hard width of their own
	   (56px cells) and the CG envelope column a 320px floor, so below the
	   surface's declared minimum the body scrolls rather than crushing them. */
	.body {
		flex: 1;
		padding: 16px;
		overflow: auto;
	}

	.body > :global(*) {
		min-width: var(--surface-min-w, 0);
	}

	/* The form pages' wrapper (the YAML page's root is its sibling) only
	   exists to be disabled for a generic sheet: no frame, no padding, no
	   margin of its own. Its floor is the rule above. */
	.sheet {
		margin: 0;
		padding: 0;
		border: 0;
	}

	/* At `full` the box IS the screen, so the floor has nowhere to scroll to
	   except sideways and the pilot pans a workbook instead of a table.
	   Measured on this phone: 199px of pan, which is exactly the 560px floor
	   against a 358px content box, not any element's own width. The floor
	   still holds wherever there is room. */
	:global(.modal-box.at-full) .body > :global(*) {
		min-width: min(var(--surface-min-w, 0), 100%);
	}

	/* The pages reflow against the BOX, never the window, the flight-prep
	   idiom: screen only, so no containment reaches a print flow. Until now
	   the editor had no container at all, so its pages had nothing to answer
	   to below their floor. `--flat-bleed` states the padding above, which the
	   pages' flat cards bleed back over (styles/workbook.css,
	   docs/workspace-surfaces.md "A section is flat"). */
	@media screen {
		.body {
			--flat-bleed: 16px;

			container-type: inline-size;
		}
	}

	/* On a phone the window IS the screen, which is margin enough: 8 px of
	   air rather than 16, which the pages' flat sections bleed back over
	   (styles/workbook.css, `--flat-bleed`; docs/workspace-surfaces.md
	   "Phones"). Screen only. */
	@media screen {
		:global(:root.mobile-ui) .body {
			--flat-bleed: 8px;

			padding: 8px;
		}
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-top: 1px solid var(--border);
	}

	.msg {
		flex: 1;
		font-size: 12.5px;
		color: var(--text-muted);
		min-width: 0;
	}

	.msg.save-error {
		color: var(--danger);
	}

	.msg.ok {
		color: var(--text-muted);
	}

	/* The shared editor page vocabulary (.card / .field / .num / .etable
	   and friends) lives in styles/workbook.css, scoped to this box. */

	.foot .link-btn {
		background: none;
		border: none;
		padding: 0;
		font: inherit;
		font-size: 12.5px;
		color: var(--accent);
		cursor: pointer;
	}

	.foot .link-btn:hover {
		text-decoration: underline;
	}

	/* The count of figures to check, link or not: the orange they stand in on
	   their page. */
	.foot .warn,
	.foot .link-btn.warn {
		margin-inline-start: 6px;
		color: var(--workbook-orange);
	}
</style>
