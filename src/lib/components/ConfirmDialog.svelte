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
	 * On a phone the hardware Back key cancels it through that stack (the
	 * HeadOverlay idiom): with nothing registered, Back minimised the app
	 * right after the Fly tap that raised the radar caution.
	 *
	 * Escape and the backdrop cancel, and focus lands on Cancel so a stray
	 * Enter never destroys anything.
	 *
	 * The acknowledge mode is the same chrome for a CAUTION: one button,
	 * since nothing changes whichever way a caution is answered and a
	 * "Cancel" beside "Understood" has no referent; that one button takes
	 * the initial focus (there is no safe alternative to protect), and
	 * Escape and the backdrop still dismiss through onCancel, which the
	 * caller reads as "not acknowledged, ask again next time". */
	import { t } from '$lib/state/i18n.svelte';
	import { ui } from '$lib/state/ui.svelte';
	import { registerBackClose } from '$lib/ui/backClose';
	import { focusTrap } from '$lib/ui/focusTrap';
	import { portal } from '$lib/ui/portal';

	interface Props {
		/** The question, as a sentence. */
		message: string;
		/** The destructive action's own verb; defaults to a plain OK. */
		confirmLabel?: string;
		/** Style the confirm as destructive (filled danger). */
		danger?: boolean;
		/** 'confirm' (default): a two-outcome question, Cancel focused first.
		 *  'acknowledge': a caution with the one button, focused. */
		mode?: 'confirm' | 'acknowledge';
		onConfirm: () => void;
		onCancel: () => void;
	}
	let { message, confirmLabel, danger = false, mode = 'confirm', onConfirm, onCancel }: Props = $props();

	const uid = $props.id();
	let cancelBtn = $state<HTMLButtonElement | null>(null);
	let confirmBtn = $state<HTMLButtonElement | null>(null);

	/* A tap that lands within this of the dialog appearing was aimed at
	 * whatever was there before, and is refused.
	 *
	 * The keyboard half of this hazard is already guarded below (a held Enter
	 * auto-repeating onto the dialog that replaced the one it just answered).
	 * The TOUCH half is the same hazard on the surface these confirms are
	 * actually used on: one handler can destroy a confirm and mount another in
	 * its place inside a frame (the Fly confirm answering into the radar
	 * caution), and the caution's single button sits at the same end of the
	 * row as the OK that was just pressed. A double-tap would then acknowledge,
	 * unread and for good, a caution that is only ever shown once per device.
	 * A quarter of a second is far longer than a double-tap's gap and far
	 * shorter than reading a sentence.
	 *
	 * The clock starts at the QUESTION, not at the mount. A caller that
	 * answers one question with another inside the same handler keeps this
	 * instance and swaps its message: the Toolbar's replace confirm resolves
	 * straight into the once-only location consent on a first native start,
	 * one `{:else if}` branch for both. Keyed on the mount, that consent would
	 * take the second tap of a double-tap aimed at the replace OK, which sits
	 * in the same place. */
	const SETTLE_MS = 250;
	let shownAt = Date.now();
	$effect.pre(() => {
		void message;
		shownAt = Date.now();
	});
	/** Has this question been on screen long enough for a press to mean it? */
	function settled(): boolean {
		return Date.now() - shownAt >= SETTLE_MS;
	}

	// focusTrap lands on the first focusable, which would be the confirm;
	// the safe control must hold the initial focus instead. A caution has
	// no safe control, so its one button takes it. Per QUESTION, like the
	// settle clock: the answer just given left focus on the OK, which is not
	// where a new question may start.
	$effect(() => {
		void message;
		(mode === 'acknowledge' ? confirmBtn : cancelBtn)?.focus();
	});

	// The phone's Back key is Cancel (a dismissal, never the destructive
	// action); the desktop keeps no history entry, as the header says.
	$effect(() => {
		if (!ui.isMobile) {
			return;
		}
		return registerBackClose(onCancel);
	});
</script>

<div use:portal>
	<button
		class="modal-backdrop"
		aria-label={t.common.dismiss}
		onclick={onCancel}
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
				return;
			}
			// A held Enter auto-repeats, and each repeat activates the focused
			// button again: the OK that started a recording would go on to
			// acknowledge the radar caution mounted in its place, unread and
			// for good. A repeat never reaches a button; the press does.
			if (e.repeat && (e.key === 'Enter' || e.key === ' ')) {
				e.preventDefault();
			}
		}}
	>
		<p class="msg" id="{uid}-msg">{message}</p>
		<div class="actions">
			{#if mode === 'confirm'}
				<button type="button" class="btn" bind:this={cancelBtn} onclick={onCancel}>
					{t.common.cancel}
				</button>
			{/if}
			<button
				type="button"
				class="btn"
				class:danger
				bind:this={confirmBtn}
				onclick={() => {
					if (settled()) {
						onConfirm();
					}
				}}
			>
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
