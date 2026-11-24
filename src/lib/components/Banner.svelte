<script lang="ts">
	/* The accent strip above the toolbar, shared by the notices (the AIRAC
	 * switch and the data expiry, the new version, the data retry) and the
	 * file-open failure line: text, an optional action, and a dismiss cross.
	 * Both buttons are the shared controls (.btn, .icon-btn) in the strip's
	 * colours, so they take the press, the focus ring and the touch floor
	 * every button has. Labels come from the caller so the component stays
	 * catalog-free. */
	import Icon from './Icon.svelte';

	interface Props {
		text: string;
		/** Action button (e.g. Reload); omitted = dismiss-only banner. */
		actionLabel?: string | undefined;
		onAction?: (() => void) | undefined;
		/** The work the action started is running: the label reads its
		 *  running form, `busyLabel` ("Reloading…"), and a press is absorbed. */
		busy?: boolean | undefined;
		busyLabel?: string | undefined;
		dismissLabel: string;
		onDismiss: () => void;
	}

	let { text, actionLabel, onAction, busy = false, busyLabel, dismissLabel, onDismiss }: Props = $props();

	function act(): void {
		if (!busy) {
			onAction?.();
		}
	}
</script>

<aside class="banner" role="status">
	<span class="text">{text}</span>
	{#if actionLabel}
		<!-- Both labels share one cell, the idle one hidden while the work
		     runs, so the button keeps the longer one's width and a wrapped
		     strip keeps its height under the finger. aria-disabled rather
		     than disabled, which would drop the focus. -->
		<button type="button" class="btn action" aria-disabled={busy || undefined} onclick={act}>
			<span class="label" class:off={busy && !!busyLabel}>{actionLabel}</span>
			{#if busyLabel}
				<span class="label" class:off={!busy}>{busyLabel}</span>
			{/if}
		</button>
	{/if}
	<button type="button" class="icon-btn dismiss" aria-label={dismissLabel} onclick={onDismiss}>
		<Icon name="x" size={14} />
	</button>
</aside>

<style>
	/* The banners render ABOVE the toolbar (App.svelte), so on a notched
	   phone under viewport-fit=cover they own the top screen edge and have
	   to pay its inset themselves; the toolbar's own --sat rule sits below
	   them and cannot cover it. The sides take the larger of 12px and their
	   insets, the toolbar's idiom. */
	.banner {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: calc(6px + var(--sat)) max(12px, var(--sar)) 6px max(12px, var(--sal));
		background: var(--accent);
		color: var(--accent-text);
		font-size: 13px;
		box-shadow: var(--shadow-1);
	}

	.text {
		flex: 1;
	}

	/* Both buttons ring their focus in the strip's own ink: the shared
	   accent ring would vanish on the accent fill. */
	.action {
		display: inline-grid;
		padding: 3px 10px;
		font: inherit;
		color: var(--accent);
		background: var(--accent-text);
		border: none;
		border-radius: var(--radius-sm);
	}

	.action:hover {
		filter: brightness(0.95);
	}

	.action[aria-disabled='true'] {
		cursor: progress;
	}

	.label {
		grid-area: 1 / 1;
	}

	.off {
		visibility: hidden;
	}

	.dismiss {
		width: 24px;
		height: 24px;
		color: inherit;
		border-radius: var(--radius-sm);
		opacity: 0.8;
	}

	.dismiss:hover {
		background: rgb(255 255 255 / 15%);
		opacity: 1;
	}

	.action:focus-visible,
	.dismiss:focus-visible {
		outline-color: var(--accent-text);
	}
</style>
