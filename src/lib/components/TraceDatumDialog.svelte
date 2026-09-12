<script lang="ts">
	/* "What are this file's altitudes measured from?", asked when an IGC
	 * file does not say (docs/trace-files.md). On ConfirmDialog's chrome
	 * (which cites ResetDialog's), deliberately NOT that component: a
	 * confirm is one safe action and one destructive one, with the focus on
	 * Cancel so a stray Enter destroys nothing, while this is two PEER
	 * readings of the same file. Nothing here is destructive, so the
	 * recommended reading holds the initial focus instead.
	 *
	 * The question exists because the two readings differ by about 45 m over
	 * France, which is enough to move a recorded track across an airspace
	 * floor; the specification says ellipsoid and common soft loggers write
	 * mean sea level, and the file usually states neither. */
	import { t } from '$lib/state/i18n.svelte';
	import type { AltDatum } from '$lib/nav/altitudeDatum';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';

	interface Props {
		/** Extra sentence when the answer covers a whole batch. */
		note?: string | undefined;
		onChoose: (datum: AltDatum) => void;
		onCancel: () => void;
	}
	let { note, onChoose, onCancel }: Props = $props();

	const uid = $props.id();
	let firstBtn = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		firstBtn?.focus();
	});
</script>

<div use:portal>
	<button
		class="modal-backdrop"
		aria-label={t.common.dismiss}
		onpointerdown={onCancel}
		oncontextmenu={(e) => e.preventDefault()}
	></button>
	<div
		class="modal-box at-dialog datum-box"
		role="dialog"
		aria-modal="true"
		aria-labelledby="{uid}-title"
		tabindex="-1"
		use:focusTrap
		onkeydown={(e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				onCancel();
			}
		}}
	>
		<h2 id="{uid}-title">{t.navigation.igcDatumTitle}</h2>
		<p class="msg">{t.navigation.igcDatumQuestion}</p>
		{#if note}
			<p class="msg note">{note}</p>
		{/if}
		<div class="choices">
			<button type="button" class="btn wide" bind:this={firstBtn} onclick={() => onChoose('ellipsoid')}>
				<span class="pick">{t.navigation.igcDatumEllipsoid}</span>
				<span class="hint">{t.navigation.igcDatumEllipsoidHint}</span>
			</button>
			<button type="button" class="btn wide" onclick={() => onChoose('msl')}>
				<span class="pick">{t.navigation.igcDatumMsl}</span>
				<span class="hint">{t.navigation.igcDatumMslHint}</span>
			</button>
		</div>
		<div class="actions">
			<button type="button" class="btn" onclick={onCancel}>{t.common.cancel}</button>
		</div>
	</div>
</div>

<style>
	.datum-box {
		--modal-width: min(420px, 92vw);

		gap: 10px;
		padding: 16px;
	}

	h2 {
		margin: 0;
		font-size: var(--fs-md);
	}

	.msg {
		margin: 0;
		font-size: var(--fs-sm);
		line-height: 1.45;
		color: var(--text-muted);
	}

	.note {
		font-style: italic;
	}

	/* Stacked full-width choices, not a segmented pill: each carries a line
	   of its own, and the 44px in-flight target applies to every .btn. */
	.choices {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.choices .btn {
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		height: auto;
		padding: 8px 10px;
		text-align: left;
	}

	.pick {
		font-weight: 600;
	}

	.hint {
		font-size: var(--fs-2xs);
		color: var(--text-muted);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
