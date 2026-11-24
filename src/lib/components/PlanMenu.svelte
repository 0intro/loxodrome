<script lang="ts">
	/* The flight plan menu (state/planDocument.svelte.ts): the plan's name, where
	 * it stands, and the document's actions, in ONE HeadOverlay (an anchored
	 * popup on desktop, a bottom sheet on phones, one history entry either
	 * way). The toolbar's plan chip and the phone's plan line open it; it is
	 * mounted once, in PlanHost.
	 *
	 * The name box is the placeholder rule's (visual-language.md): empty over
	 * the route in grey, the name in force when none is typed. It commits on
	 * Enter, on Ctrl/Cmd+S (which then saves the plan under it), or on a blur
	 * that stays inside the menu (a row clicked after typing). Every way of
	 * dismissing the menu reverts it: Escape is taken at the window by the
	 * overlay before the box sees it, and Chromium blurs an input it removes. */
	import { untrack } from 'svelte';
	import HeadOverlay from './HeadOverlay.svelte';
	import Icon from './Icon.svelte';
	import { planStateText } from './planStateText';
	import {
		activePlan,
		canSavePlan,
		hasStorableWorkspace,
		planUnsaved,
	} from '$lib/state/activePlan.svelte';
	import { signedIn } from '$lib/state/account.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		closePlanMenu,
		downloadPlanFile,
		newPlan,
		openSavedPlan,
		pickPlanFile,
		planChain,
		planDocument,
		renameActivePlan,
		savePlan,
		savePlanAsNew,
	} from '$lib/state/planDocument.svelte';
	import { saveKey } from '$lib/state/planShortcut';
	import { routes } from '$lib/state/route.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { workspace } from '$lib/state/workspace.svelte';
	import { inputValue } from '$lib/ui/dom';

	let body = $state<HTMLDivElement>();
	let draft = $state('');

	// Each opening starts from the name in force; a draft never outlives its
	// menu.
	$effect(() => {
		if (planDocument.menuOpen) {
			draft = untrack(() => routes.planName ?? '');
		}
	});

	const saved = $derived(activePlan.source != null);
	const storable = $derived(hasStorableWorkspace());
	const canSave = $derived(canSavePlan());
	const stateText = $derived(planStateText());
	const errorText = $derived.by(() => {
		const e = planDocument.error;
		if (e == null) {
			return '';
		}
		switch (e.op) {
			case 'save':
				return t.plan.saveFailed(e.detail);
			case 'download':
				return t.plan.downloadFailed(e.detail);
			case 'open':
				return t.plan.openFailed(e.detail);
			default: {
				const never: never = e.op;
				return never;
			}
		}
	});

	function commitName(): void {
		const next = draft.trim();
		if (next === (routes.planName ?? '')) {
			return;
		}
		void renameActivePlan(next === '' ? null : next);
	}

	// The menu stays up while a save or the file's build runs, so the row
	// keeps saying it is busy; it closes once the work has landed, and stays
	// on its error line when it has not.
	async function onSave(asNew: boolean): Promise<void> {
		const out = await (asNew ? savePlanAsNew() : savePlan());
		if (out.kind === 'saved' || out.kind === 'unchanged') {
			closePlanMenu();
		}
	}

	async function onDownload(): Promise<void> {
		if (await downloadPlanFile()) {
			closePlanMenu();
		}
	}

	function onNew(): void {
		closePlanMenu();
		void newPlan();
	}
</script>

<!-- Raised over a full surface (a failed Ctrl+S under a maximised workbook),
     the overlay names it and lifts itself above it. -->
<HeadOverlay
	open={planDocument.menuOpen}
	x={planDocument.anchor.x}
	y={planDocument.anchor.y}
	title={t.plan.title}
	minWidthPx={260}
	surface={workspace.overlay ?? undefined}
	onClose={closePlanMenu}
>
	<div class="plan-menu" bind:this={body}>
		<div class="plan-head">
			<input
				class="plan-name"
				type="text"
				maxlength="80"
				value={draft}
				placeholder={planChain() || t.plan.title}
				aria-label={t.flights.planNameLabel}
				title={t.plan.nameTip}
				disabled={planDocument.saving}
				oninput={(e) => (draft = inputValue(e))}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commitName();
					} else if (saveKey(e, false) === 'save') {
						// PlanHost saves on this key once the box has heard it,
						// blurring the box first: a blur with no related target,
						// which reverts the draft.
						commitName();
					}
				}}
				onblur={(e) => {
					if (body?.contains(e.relatedTarget as Node | null)) {
						commitName();
					}
				}}
			/>
			<p class="state muted small">{stateText}</p>
			{#if planUnsaved() && signedIn()}
				<!-- Signed in, the stakes of an unsaved plan grow: the saved plans
				     are what follows the pilot to other devices
				     (docs/accounts-sync.md, the phase-1 hint). -->
				<p class="hint small">{t.plan.syncHint}</p>
			{/if}
			{#if errorText !== ''}
				<p class="error small" role="alert">{errorText}</p>
			{/if}
		</div>
		<button
			class="item group-top"
			onclick={() => void onSave(false)}
			disabled={!canSave || planDocument.saving}
			title={t.plan.saveTip}
		>
			<Icon name="save" size={14} />
			<span class="grow">{planDocument.saving ? t.plan.savingPlan : t.plan.save}</span>
			{#if !ui.isMobile}<kbd class="key">{t.plan.saveKey}</kbd>{/if}
		</button>
		<!-- A plan never saved has no entry to fork from: Save makes its first. -->
		{#if saved}
			<button
				class="item"
				onclick={() => void onSave(true)}
				disabled={!storable || planDocument.saving}
				title={t.plan.saveAsNewTip}
			>
				<Icon name="save" size={14} />
				{t.plan.saveAsNew}
			</button>
		{/if}
		<!-- A menu row OPENS, never toggles, straight onto the Plans view. -->
		<button class="item group-top" onclick={openSavedPlan}>
			<Icon name="logbook" size={14} />
			{t.plan.openSaved}
		</button>
		<!-- The picker opens inside this click: the web input needs the
		     click's own activation. -->
		<button class="item" onclick={pickPlanFile} title={t.plan.openFileTip}>
			<Icon name="file-text" size={14} />
			{t.plan.openFile}
		</button>
		<button class="item" onclick={onNew} title={t.plan.newPlanTip}>
			<Icon name="plus" size={14} />
			{t.plan.newPlan}
		</button>
		<button
			class="item group-top"
			onclick={() => void onDownload()}
			disabled={!storable || planDocument.downloading}
			title={t.plan.downloadTip}
		>
			<Icon name="download" size={14} />
			{planDocument.downloading ? t.plan.preparingFile : t.plan.download}
		</button>
	</div>
</HeadOverlay>

<style>
	.plan-head {
		display: grid;
		gap: 4px;
		padding: 2px 8px 6px;
	}

	.plan-name {
		width: 100%;
		min-width: 0;
		padding: 5px 8px;
		font: inherit;
		font-size: var(--fs-md);
		color: var(--text);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	:global(:root.touch-ui) .plan-name {
		min-height: 44px;
	}

	.state,
	.hint,
	.error {
		margin: 0;
	}

	.hint {
		color: var(--workbook-orange);
	}

	.error {
		color: var(--danger);
	}

	.grow {
		flex: 1;
	}

	.key {
		padding: 0 4px;
		font: inherit;
		font-size: var(--fs-2xs);
		color: var(--text-muted);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	/* The row that opens a group carries the rule, the route menu's idiom. */
	.item.group-top {
		margin-top: 4px;
		padding-top: 9px;
		border-top: 1px solid var(--border);
		border-radius: 0 0 5px 5px;
	}
</style>
