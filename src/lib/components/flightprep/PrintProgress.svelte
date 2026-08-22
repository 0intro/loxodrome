<script lang="ts">
	/* Progress overlay for the pack-print prefetches: a scrim + card over the
	 * host with a determinate bar, the step list (counters and the current
	 * chart token), the amber non-blocking issue lines, and Cancel / Close.
	 * Reads the shared printProgress tracker; each host mounts one instance
	 * and passes the modes it owns. Inside FlightPrepModal the scrim fills
	 * the position:fixed .modal-box and the box's focus trap covers the
	 * buttons; the standalone (portaled) variant used by WxPrintHost brings
	 * its own dialog role + focus trap. `no-print` on the root keeps it off
	 * paper on the per-page print path; the pack paths hide the whole host. */

	import Icon from '../Icon.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import {
		closePrintProgress,
		printProgress,
		printProgressFraction,
		requestPrintCancel,
		type PrintIssue,
		type PrintProgressMode,
		type PrintStepKind,
	} from '$lib/state/printProgress.svelte';
	import { t } from '$lib/state/i18n.svelte';

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
			case 'terrain':
				return t.flightprep.progressIssueTerrain;
			case 'wx-station':
				return t.flightprep.wxUnavailable(issue.param);
			case 'charts-failed':
				return t.flightprep.chartsFailed(issue.n);
			case 'charts-catalog':
				return t.flightprep.chartsUnavailable;
		}
	}

	function issueKey(issue: PrintIssue): string {
		return issue.code + ('param' in issue ? `|${issue.param}` : '');
	}

	const cardTitle = $derived(
		printProgress.summary ? t.flightprep.progressPrintedIssues : title(printProgress.mode),
	);

	// The clicked pack button disables when the prep starts, dropping focus
	// to <body> (outside the trap); pull it onto the card's action button,
	// and again when Cancel swaps to the summary's Close.
	let actionBtn = $state<HTMLButtonElement | null>(null);
	$effect(() => {
		actionBtn?.focus();
	});
</script>

{#snippet card()}
	<h3 class="pp-title">{cardTitle}</h3>
	{#if !printProgress.summary}
		<div
			class="pp-bar"
			role="progressbar"
			aria-label={t.flightprep.progressAria}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={pct}
		>
			<div class="pp-fill" style:width="{pct}%"></div>
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
			{#if !printProgress.summary}
				<p class="pp-note">{t.flightprep.progressIssuesNote}</p>
			{/if}
			<ul>
				{#each printProgress.issues as issue (issueKey(issue))}
					<li>{issueText(issue)}</li>
				{/each}
			</ul>
		</div>
	{/if}
	<div class="pp-actions">
		{#if printProgress.summary}
			<button class="pp-btn" bind:this={actionBtn} onclick={closePrintProgress}>
				{t.common.close}
			</button>
		{:else}
			<button class="pp-btn" bind:this={actionBtn} onclick={requestPrintCancel}>
				{t.common.cancel}
			</button>
		{/if}
	</div>
{/snippet}

{#if shown}
	<div class="pp-scrim no-print">
		{#if standalone}
			<div class="pp-card" role="dialog" aria-modal="true" aria-label={cardTitle} use:focusTrap>
				{@render card()}
			</div>
		{:else}
			<div class="pp-card">
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

	.pp-bar {
		height: 6px;
		background: var(--surface-3);
		border-radius: 999px;
		overflow: hidden;
	}

	.pp-fill {
		height: 100%;
		background: var(--accent);
		border-radius: inherit;
		transition: width 0.25s ease;
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
		justify-content: flex-end;
	}

	.pp-btn {
		font: inherit;
		font-size: 12.5px;
		padding: 5px 14px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface-2);
		color: var(--text);
		cursor: pointer;
	}

	.pp-btn:hover {
		background: var(--surface-3);
	}
</style>
