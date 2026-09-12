<script lang="ts">
	/* The app's confirm, on ResetDialog's chrome: a small centred dialog over
	 * the shared .modal-backdrop / .modal-box (app.css), deliberately NOT a
	 * workspace surface, since a one-question confirm needs no registry
	 * entry, placement or history entry.
	 *
	 * It exists because the destructive confirms used window.confirm, and in
	 * a standalone PWA that is a system alert: it ignores the night theme
	 * (a white flash at night, which is when the recording confirms fire),
	 * its buttons are OS-sized rather than the app's 44px in-flight target,
	 * its button order is platform-defined so the safe action cannot be put
	 * under the thumb, and it blocks the main thread while a GPS watch is
	 * running. ui/backClose.ts already recorded it as an interaction hazard.
	 *
	 * Escape and the backdrop cancel, and focus lands on Cancel so a stray
	 * Enter never destroys anything. */
	import { t } from '$lib/state/i18n.svelte';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';

	interface Props {
		/** The question, as a sentence. */
		message: string;
		/** The destructive action's own verb; defaults to a plain OK. */
		confirmLabel?: string;
		/** Style the confirm as destructive (filled danger). */
		danger?: boolean;
		onConfirm: () => void;
		onCancel: () => void;
	}
	let { message, confirmLabel, danger = false, onConfirm, onCancel }: Props = $props();

	const uid = $props.id();
	let cancelBtn = $state<HTMLButtonElement | null>(null);

	// focusTrap lands on the first focusable, which would be the confirm;
	// the safe control must hold the initial focus instead.
	$effect(() => {
		cancelBtn?.focus();
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
		class="modal-box at-dialog confirm-box"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="{uid}-msg"
		tabindex="-1"
		use:focusTrap
		onkeydown={(e: KeyboardEvent) => {
			// Focus is trapped inside, so Escape always lands here; stopping it
			// keeps the key from any surface's window-level handler beneath.
			if (e.key === 'Escape') {
				e.stopPropagation();
				onCancel();
			}
		}}
	>
		<p class="msg" id="{uid}-msg">{message}</p>
		<div class="actions">
			<button type="button" class="btn" bind:this={cancelBtn} onclick={onCancel}>
				{t.common.cancel}
			</button>
			<button type="button" class="btn" class:danger onclick={onConfirm}>
				{confirmLabel ?? t.common.ok}
			</button>
		</div>
	</div>
</div>

<style>
	.confirm-box {
		--modal-width: min(380px, 92vw);

		gap: 10px;
		padding: 16px;
	}

	.msg {
		margin: 0;
		font-size: var(--fs-md);
		line-height: 1.45;
	}

	.actions {
		display: flex;
		gap: 8px;
		justify-content: flex-end;
		margin-top: 2px;
	}
</style>
