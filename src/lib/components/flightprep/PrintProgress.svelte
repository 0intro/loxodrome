<script lang="ts">
	/* Progress overlay for the pack-print prefetches: a scrim + card over the
	 * host with a determinate bar, the step list (counters and the current
	 * chart token), the amber issue lines as they arrive, and Cancel. A run
	 * that ends with issues holds here before the print dialog: the card turns
	 * into its review, the issues with their wire lines as tooltips, and asks
	 * Cancel / Retry / Print anyway. Reads the shared printProgress tracker;
	 * each host mounts one instance and passes the modes it owns. Inside
	 * FlightPrepModal the scrim fills the position:fixed .modal-box; the
	 * standalone (portaled) variant used by WxPrintHost brings its own dialog
	 * role, focus trap, Escape and phone Back. `no-print` on the root keeps it
	 * off paper on the per-page print path; the pack paths hide the whole
	 * host. */

	import Icon from '../Icon.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { registerBackClose } from '$lib/ui/backClose';
	import { ui } from '$lib/state/ui.svelte';
	import {
		decidePrint,
		printIssueKey,
		printProgress,
		printProgressFraction,
		requestPrintCancel,
		type PrintIssue,
		type PrintProgressMode,
		type PrintStepKind,
	} from '$lib/state/printProgress.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { chartCatalogText, chartFailedText, chartNoteText, flightPastText } from './chartsText';
	import { frontIssueText } from './frontsText';

	interface Props {
		/** The run modes this host displays (each host shows only its own). */
		modes: PrintProgressMode[];
		/** Portaled outside any dialog: own role="dialog" + focus trap. */
		standalone?: boolean;
	}
	const { modes, standalone = false }: Props = $props();

	const shown = $derived(printProgress.active && modes.includes(printProgress.mode));
	const pct = $derived(Math.round(printProgressFraction() * 100));

	// Label maps are functions reading t at call time (docs/i18n.md rule 2).
	function title(mode: PrintProgressMode): string {
		switch (mode) {
			case 'prep':
				return t.flightprep.progressTitlePrep;
			case 'dossier':
				return t.flightprep.progressTitleDossier;
			case 'wx':
				return t.flightprep.progressTitleWx;
		}
	}

	function stepLabel(kind: PrintStepKind): string {
		switch (kind) {
			case 'datasets':
				return t.flightprep.progressDatasets;
			case 'msa':
				return t.flightprep.progressMsa;
			case 'wind':
				return t.flightprep.progressWind;
			case 'terrain':
				return t.flightprep.progressTerrain;
			case 'wx':
				return t.flightprep.progressWx;
			case 'fronts':
				return t.weather.fronts.progress;
			case 'charts':
				return t.flightprep.progressCharts;
			case 'pages':
				return t.flightprep.progressPages;
		}
	}

	function issueText(issue: PrintIssue): string {
		switch (issue.code) {
			case 'datasets':
				return t.flightprep.progressIssueDatasets;
			case 'msa':
				return t.flightprep.progressIssueMsa;
			case 'wind':
				return t.flightprep.progressIssueWind;
			case 'wind-blank':
				return t.flightprep.progressIssueWindBlank;
			case 'terrain':
				return t.flightprep.progressIssueTerrain;
			case 'wx-station':
				return t.flightprep.wxUnavailable(issue.param);
			case 'charts-catalog':
				return chartCatalogText(issue.product, issue.zone, issue.failure);
			case 'charts-failed':
				return chartFailedText(issue.chart, issue.validAtMs, Date.now());
			case 'charts-missing':
				return chartNoteText(issue, Date.now());
			case 'charts-undated':
				return chartNoteText({ ...issue, level: null, kind: 'undated', validAtMs: null, publishAtMs: null }, Date.now());
			case 'flight-past':
				return flightPastText(issue);
			case 'fronts-unavailable':
			case 'fronts-missing':
			case 'fronts-failed':
				return frontIssueText(issue, Date.now());
		}
	}

	/** The wire line behind an issue, shown as its tooltip (docs/i18n.md
	 *  rule 7: it stays English); undefined when the issue carries none. */
	function issueDetail(issue: PrintIssue): string | undefined {
		return 'failure' in issue ? issue.failure.detail : undefined;
	}

	const review = $derived(printProgress.phase === 'review');
	const cardTitle = $derived(review ? t.flightprep.progressReviewTitle : title(printProgress.mode));

	// The clicked pack button disables when the prep starts, dropping focus
	// to <body> (outside the trap); pull it onto the card's Cancel, then onto
	// Print anyway when the run holds for a decision.
	let cancelBtn = $state<HTMLButtonElement | null>(null);
	let printBtn = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		(review ? printBtn : cancelBtn)?.focus();
	});

	/* A press that lands within this of the review appearing was aimed at
	 * the Cancel that stood in Print anyway's place a moment before: refused,
	 * as ConfirmDialog refuses one (its SETTLE_MS, and why). The clock starts
	 * when the run starts holding. */
	const SETTLE_MS = 250;
	let reviewAt = 0;
	$effect.pre(() => {
		if (review) {
			reviewAt = Date.now();
		}
	});
	function settled(): boolean {
		return Date.now() - reviewAt >= SETTLE_MS;
	}

	// The standalone card (the Weather tab's briefing) answers Escape and the
	// phone's Back as Cancel; inside the flight preparation surface both close
	// the surface, whose own close cancels the run.
	$effect(() => {
		if (!shown || !standalone || !ui.isMobile) {
			return;
		}
		return registerBackClose(requestPrintCancel);
	});
	function onCardKey(e: KeyboardEvent): void {
		if (standalone && e.key === 'Escape') {
			e.stopPropagation();
			requestPrintCancel();
			return;
		}
		// A held Enter auto-repeats, and each repeat would activate the button
		// focused after the last one: never the review's Print anyway.
		if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
		}
	}
</script>

{#snippet card()}
	<h3 class="pp-title">{cardTitle}</h3>
	{#if !review}
		<div
			class="progress"
			role="progressbar"
			aria-label={t.flightprep.progressAria}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={pct}
		>
			<div class="progress-fill" style:width="{pct}%"></div>
		</div>
		<ul class="pp-steps" aria-live="polite">
			{#each printProgress.steps as s (s.kind)}
				<!-- Status classes are pp- prefixed: app.css has a global .error
				     (the inline error banner) that would restyle a bare span. -->
				<li class="pp-step" class:pp-pending={s.status === 'pending'}>
					<span class="pp-glyph pp-{s.status}">
						{#if s.status === 'done'}
							<Icon name="check" size={12} />
						{:else if s.status === 'error'}
							<Icon name="alert-triangle" size={12} />
						{/if}
					</span>
					<span class="pp-label">{stepLabel(s.kind)}</span>
					{#if s.param}
						<span class="pp-param">{s.param}</span>
					{/if}
					{#if s.total > 0}
						<span class="pp-count">{s.done + s.failed}/{s.total}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
	{#if printProgress.issues.length > 0}
		<div class="pp-issues">
			<ul>
				{#each printProgress.issues as issue (printIssueKey(issue))}
					<li title={issueDetail(issue)}>{issueText(issue)}</li>
				{/each}
			</ul>
			{#if review}
				<p class="pp-note">{t.flightprep.progressReviewNote}</p>
			{/if}
		</div>
	{/if}
	<div class="pp-actions">
		<button type="button" class="btn" bind:this={cancelBtn} onclick={requestPrintCancel}>
			{t.common.cancel}
		</button>
		{#if review}
			<button
				type="button"
				class="btn"
				onclick={() => {
					if (settled()) {
						decidePrint('retry');
					}
				}}
			>
				{t.flightprep.progressRetry}
			</button>
			<button
				type="button"
				class="btn primary"
				bind:this={printBtn}
				onclick={() => {
					if (settled()) {
						decidePrint('print');
					}
				}}
			>
				{t.flightprep.progressPrintAnyway}
			</button>
		{/if}
	</div>
{/snippet}

{#if shown}
	<div class="pp-scrim no-print">
		{#if standalone}
			<div
				class="pp-card"
				role="dialog"
				aria-modal="true"
				aria-label={cardTitle}
				tabindex="-1"
				use:focusTrap
				onkeydown={onCardKey}
			>
				{@render card()}
			</div>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="pp-card" role="group" aria-label={cardTitle} onkeydown={onCardKey}>
				{@render card()}
			</div>
		{/if}
	</div>
{/if}

<style>
	.pp-scrim {
		position: absolute;
		inset: 0;
		z-index: 10;
		display: grid;
		place-items: center;
		padding: 20px;
		background: rgb(0 0 0 / 35%);
		border-radius: var(--radius);
	}

	.pp-card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: min(420px, 100%);
		padding: 14px 16px;
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		box-shadow: var(--shadow-2);
	}

	.pp-title {
		margin: 0;
		font-size: 13.5px;
		font-weight: 600;
		color: var(--text);
	}



	.pp-steps {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.pp-step {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12.5px;
		color: var(--text);
	}

	.pp-step.pp-pending {
		color: var(--text-muted);
	}

	.pp-glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 14px;
		height: 14px;
		flex: none;
	}

	.pp-glyph.pp-pending::before {
		content: '';
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--border-strong);
	}

	.pp-glyph.pp-running::before {
		content: '';
		width: 9px;
		height: 9px;
		border: 2px solid var(--border-strong);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: pp-spin 0.8s linear infinite;
	}

	.pp-glyph.pp-done {
		color: var(--status-active);
	}

	.pp-glyph.pp-error {
		color: var(--no-live-data);
	}

	@keyframes pp-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.pp-label {
		flex: none;
	}

	.pp-param {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: right;
		font-size: 11.5px;
		color: var(--text-muted);
	}

	.pp-count {
		flex: none;
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.pp-issues {
		font-size: 12px;
		color: var(--no-live-data);
	}

	.pp-note {
		margin: 0;
	}

	.pp-issues ul {
		margin: 4px 0 0;
		padding-left: 16px;
	}

	.pp-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
