<script lang="ts">
	/* A small segmented control: a row of mutually exclusive buttons, one
	 * active. Locale-free by design, callers pass already-resolved labels
	 * (invariant tokens like VFR / IFR, or translated strings), so it never
	 * touches the i18n catalogs. Shared by the Route and Filter flight-rules
	 * pickers, the settings-panel language / datum pickers, the replay speed
	 * picker and the aircraft-symbol picker. */
	import Icon from './Icon.svelte';

	interface Option {
		value: string;
		/** Visible text; for an icon option, the accessible name instead. */
		label: string;
		title?: string;
		/** Icon-only option: the glyph replaces the visible label. */
		icon?: string;
		/** Offered but not choosable yet (the caller says why beside the
		 *  control; a browser suppresses a disabled button's own tooltip). */
		disabled?: boolean;
	}

	let {
		options,
		value,
		onSelect,
		ariaLabel,
		title,
	}: {
		options: Option[];
		value: string;
		onSelect: (v: string) => void;
		ariaLabel: string;
		title?: string | undefined;
	} = $props();
</script>

<div class="seg" role="group" aria-label={ariaLabel} {title}>
	{#each options as o (o.value)}
		<!-- aria-pressed carries the active state (visual-only before): a
		     group of toggle buttons, one pressed. -->
		<button
			type="button"
			disabled={o.disabled}
			class:active={o.value === value}
			aria-pressed={o.value === value}
			title={o.title}
			aria-label={o.icon ? o.label : undefined}
			onclick={() => onSelect(o.value)}
		>
			{#if o.icon}<Icon name={o.icon} size={16} />{:else}{o.label}{/if}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		overflow: hidden;
	}

	.seg button {
		display: inline-flex;
		align-items: center;
		padding: 2px 9px;
		font: inherit;
		font-size: 11px;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 0;
		cursor: pointer;
	}

	.seg button + button {
		border-left: 1px solid var(--border);
	}

	.seg button.active {
		color: var(--accent-text);
		background: var(--accent);
	}

	.seg button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	.seg button:disabled {
		cursor: default;
		opacity: 0.45;
	}

	/* The touch-ui class, not a media query: a segmented control appears on
	   the strip, in the replay transport and in the viewing conditions, all
	   of which are worked while recording on whatever pointer is attached. */
	:global(:root.touch-ui) .seg button {
		min-height: 44px;
		padding: 6px 14px;
	}
</style>
