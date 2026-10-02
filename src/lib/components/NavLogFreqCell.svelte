<script lang="ts">
	/* The nav-log banner's manual-frequencies editor (NavLogSheet mounts it
	 * on the interactive path only, so the print and measuring mounts stay
	 * clear of it): a textarea over the frequency lines plus the
	 * back-to-auto reset button. Leaving the editor commits the draft,
	 * Escape cancels. The sheet owns which waypoint is being edited and the
	 * route-state writes; this cell only edits text and reports the
	 * outcome. */

	import Icon from './Icon.svelte';
	import { inputValue } from '$lib/ui/dom';
	import { t } from '$lib/state/i18n.svelte';

	interface Props {
		/** The draft's seed: the waypoint's manual text, else the automatic
		 *  lines shown when the editor opened (the sheet freezes both the
		 *  seed and the back-to-auto equality target at open). */
		initial: string;
		/** Focus left the editor: commit the draft (blank text or the
		 *  automatic lines hand the cell back to auto, the sheet's rule). */
		onCommit: (text: string) => void;
		/** Escape: drop the draft. */
		onCancel: () => void;
		/** The reset button: hand the cell back to the automatic list. */
		onReset: () => void;
	}
	let { initial, onCommit, onCancel, onReset }: Props = $props();

	// The prop seeds the initial draft only; keystrokes own it after, and
	// closing unmounts the cell, so a reopen reseeds.
	// svelte-ignore state_referenced_locally
	let text = $state(initial);

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			// Cancel the edit only: without stopPropagation SurfaceShell's
			// window-level Escape would close the whole nav-log modal.
			e.stopPropagation();
			onCancel();
		}
	}

	function onFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget as Node | null;
		if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
			onCommit(text);
		}
	}

	// Focus the just-mounted editor; blur-commit never fires on an unfocused
	// textarea. A local action, not the autofocus attribute (a11y lint).
	function autofocus(node: HTMLTextAreaElement): void {
		node.focus();
	}
</script>

<span class="freqs-edit" onfocusout={onFocusOut}>
	<textarea
		class="freqs-input"
		autocapitalize="characters"
		spellcheck="false"
		aria-label={t.navlog.freqTextAria}
		value={text}
		use:autofocus
		oninput={(e) => (text = inputValue(e))}
		onkeydown={onKeyDown}
	></textarea>
	<button
		class="freq-reset"
		title={t.navlog.freqResetTip}
		aria-label={t.navlog.freqResetAria}
		onmousedown={(e) => e.preventDefault()}
		onclick={onReset}
	>
		<Icon name="rotate-ccw" size={11} />
	</button>
</span>

<style>
	/* The editor replacing the frequency lines: a textarea filling the rest of
	   the banner (scrolling internally past ~5 lines) plus the reset button.
	   The bottom margin keeps the field (and its focus outline) clear of the
	   waypoint-seam ink painted over the banner's bottom edge. */
	.freqs-edit {
		display: flex;
		flex: 1;
		gap: 2px;
		min-height: 0;
		margin-bottom: 4px;
	}

	.freqs-input {
		flex: 1;
		min-width: 0;
		min-height: 0;
		padding: 2px 4px;
		font: inherit;
		font-size: 10px;
		font-weight: 400;
		line-height: 1.3;
		color: var(--text);
		text-align: left;
		background: transparent;
		border: 1px solid var(--border-strong);
		border-radius: 2px;
		resize: none;
	}

	.freqs-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.freq-reset {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		align-self: flex-start;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-muted);
		cursor: pointer;
		background: none;
		border: none;
	}

	.freq-reset:hover {
		color: var(--text);
	}
</style>
