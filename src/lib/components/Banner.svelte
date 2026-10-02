<script lang="ts">
	/* The accent notification strip shared by the reload-style banners
	 * (AIRAC switch, PWA update, offline-ready): text, an optional action
	 * button, and a dismiss cross. Labels come from the caller so the
	 * component stays catalog-free. */
	import Icon from './Icon.svelte';

	interface Props {
		text: string;
		/** Action button (e.g. Reload); omitted = dismiss-only banner. */
		actionLabel?: string;
		onAction?: () => void;
		dismissLabel: string;
		onDismiss: () => void;
	}

	let { text, actionLabel, onAction, dismissLabel, onDismiss }: Props = $props();
</script>

<aside class="banner" role="status">
	<span class="text">{text}</span>
	{#if actionLabel}
		<button type="button" class="action" onclick={onAction}>{actionLabel}</button>
	{/if}
	<button type="button" class="dismiss" aria-label={dismissLabel} onclick={onDismiss}>
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

	.action {
		padding: 3px 10px;
		font: inherit;
		color: var(--accent);
		background: var(--accent-text);
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.action:hover {
		filter: brightness(0.95);
	}

	.dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		background: transparent;
		color: inherit;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		opacity: 0.8;
	}

	.dismiss:hover {
		background: rgb(255 255 255 / 15%);
		opacity: 1;
	}

	@media (pointer: coarse) {
		.dismiss {
			width: 44px;
			height: 44px;
		}
	}
</style>
