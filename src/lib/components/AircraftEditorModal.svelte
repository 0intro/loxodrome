<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	/* The aircraft editor modal: every data-sheet field editable over four
	 * pages (General, Mass & balance, Performance, YAML). Edits live in a
	 * string-typed draft (src/lib/aircraft/edit.ts) validated live by the
	 * schema parser; Save commits only a schema-valid Aircraft through
	 * saveEditedAircraft, so localStorage can never receive a sheet that
	 * would fail to parse next session. Create mode covers both a blank
	 * sheet and a duplicate (registration cleared). Follows the
	 * FlightPrepModal skeleton: portal + focus trap, Escape to close,
	 * backdrop dismiss, page tabs; plus a footer with the first validation
	 * error (mapped to its page) and Cancel / Save. */

	import { untrack } from 'svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import PageTabs from './PageTabs.svelte';
	import SurfaceShell from './SurfaceShell.svelte';
	import GeneralPage from './aircrafteditor/GeneralPage.svelte';
	import MassBalanceEditPage from './aircrafteditor/MassBalanceEditPage.svelte';
	import PerformanceEditPage from './aircrafteditor/PerformanceEditPage.svelte';
	import YamlPage from './aircrafteditor/YamlPage.svelte';
	import {
		aircraftEditor,
		closeAircraftEditor,
		degradeToCreate,
	} from '$lib/state/aircraftEditor.svelte';
	import {
		aircraftByKey,
		ensureAircraftLibrary,
		isLibraryKey,
		saveEditedAircraft,
	} from '$lib/state/aircraft.svelte';
	import {
		aircraftToDraft,
		duplicateDraft,
		draftToAircraft,
		errorPage,
		type AircraftDraft,
		type AircraftEditorPage,
	} from '$lib/aircraft/edit';
	import { aircraftKey, parseAircraftYaml, stringifyAircraftYaml } from '$lib/aircraft/schema';
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

	// Rebuild the draft once per open REQUEST, not per placement: docking or
	// maximising the editor must not clobber in-progress edits, and asking
	// for another plane while it is already up must reseed even though
	// nothing about the slot changed. The fleet lookup stays untracked so the
	// async library load (or a shadow pruning) cannot re-run this either.
	$effect(() => {
		void aircraftEditor.requestSeq;
		if (!aircraftEditor.open) {
			return;
		}
		void ensureAircraftLibrary();
		untrack(() => {
			const src = aircraftEditor.key ? aircraftByKey(aircraftEditor.key) : null;
			const snap = src ? $state.snapshot(src) : null;
			if (aircraftEditor.mode === 'edit' && !snap) {
				// The plane vanished (deleted elsewhere): degrade to a blank create.
				degradeToCreate();
			}
			draft = aircraftEditor.mode === 'edit' ? aircraftToDraft(snap) : snap ? duplicateDraft(snap) : aircraftToDraft(null);
			initialDraftJson = JSON.stringify($state.snapshot(draft));
			saveError = null;
			yamlText = '';
			yamlError = '';
			yamlDirty = false;
		});
	});

	const result = $derived(draftToAircraft($state.snapshot(draft)));
	const errPage = $derived(result.ok ? null : errorPage(result.errors[0]));
	const validKey = $derived(result.ok ? aircraftKey(result.aircraft) : null);
	const keyLocked = $derived(
		aircraftEditor.mode === 'edit' && aircraftEditor.key !== null && isLibraryKey(aircraftEditor.key),
	);
	const title = $derived(
		aircraftEditor.mode === 'edit'
			? t.aircraft.editTitle(aircraftEditor.key ?? '')
			: aircraftEditor.key
				? t.aircraft.newCopyTitle(aircraftEditor.key)
				: t.aircraft.newAircraft,
	);
	const dirty = $derived(JSON.stringify($state.snapshot(draft)) !== initialDraftJson || yamlDirty);

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
			draft = aircraftToDraft(parseAircraftYaml(yamlText));
			yamlError = '';
			yamlDirty = false;
		} catch (e) {
			yamlError = e instanceof Error ? e.message : String(e);
		}
	}

	/* Both destructive guards go through the app's own ConfirmDialog, which
	 * is themed, sized to the app's touch floor and puts initial focus on
	 * Cancel; what it guards here is an afternoon of data-sheet edits, so a
	 * stray Enter must not be what discards them. The pending action is held
	 * until the question is answered. */
	let pendingConfirm = $state<(() => void) | null>(null);

	function onSave(): void {
		if (!result.ok) {
			return;
		}
		// Unapplied YAML edits are not in the draft: saving would silently
		// discard them, so confirm like the dirty close does (Apply on the
		// YAML page folds them in and clears the flag).
		if (yamlDirty) {
			pendingConfirm = commitSave;
			return;
		}
		commitSave();
	}

	function commitSave(): void {
		if (!result.ok) {
			return;
		}
		const err = saveEditedAircraft(
			aircraftEditor.mode === 'edit' ? aircraftEditor.key : null,
			result.aircraft,
		);
		if (err) {
			saveError = err;
		} else {
			closeAircraftEditor();
		}
	}

	function requestClose(): void {
		if (dirty) {
			pendingConfirm = closeAircraftEditor;
			return;
		}
		closeAircraftEditor();
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
			{#if errPage === id && aircraftEditor.page !== id}
				<span class="dot" title={t.aircraft.errorDotTip}></span>
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

	<div class="body">
				{#if aircraftEditor.page === 'general'}
					<GeneralPage bind:draft {keyLocked} />
				{:else if aircraftEditor.page === 'mb'}
					<MassBalanceEditPage bind:draft />
				{:else if aircraftEditor.page === 'perf'}
					<PerformanceEditPage bind:draft validPerformance={result.ok ? (result.aircraft.performance ?? null) : null} />
				{:else}
					<YamlPage
						bind:text={yamlText}
						error={yamlError}
						stale={!result.ok && !yamlDirty}
						onapply={applyYaml}
						ontyped={() => {
							yamlDirty = true;
							yamlError = '';
						}}
					/>
				{/if}
			</div>

			<footer class="foot">
				{#if saveError}
					<span class="msg save-error" role="alert">{saveError()}</span>
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
				{:else}
					<span class="msg ok">{t.aircraft.validSheet(validKey ?? '')}</span>
				{/if}
				<button class="btn" onclick={requestClose}>{t.aircraft.cancel}</button>
				<button class="btn primary" disabled={!result.ok} onclick={onSave}>{t.aircraft.save}</button>
			</footer>
</SurfaceShell>

{#if pendingConfirm}
	<ConfirmDialog
		message={t.common.discardChanges}
		confirmLabel={t.common.discardChangesAction}
		danger
		onConfirm={() => {
			const run = pendingConfirm;
			pendingConfirm = null;
			run?.();
		}}
		onCancel={() => (pendingConfirm = null)}
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
	   to below their floor. */
	@media screen {
		.body {
			container-type: inline-size;
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
</style>
