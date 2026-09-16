<script lang="ts">
	/* The data sheet as raw YAML: seeded from the form draft (the modal owns
	 * the text, since pages unmount on tab switch), editable or pasteable,
	 * applied back into the forms through the real parser so the error
	 * messages match the import path's. */

	import { t } from '$lib/state/i18n.svelte';

	let {
		text = $bindable(),
		error,
		stale,
		onapply,
		ontyped,
	}: {
		text: string;
		error: string;
		/** The form draft does not validate, so the text shows the last applied state. */
		stale: boolean;
		onapply: () => void;
		ontyped: () => void;
	} = $props();
</script>

<div class="page">
	<p class="hint">{t.aircraft.yamlIntro}</p>
	{#if stale}
		<p class="hint">{t.aircraft.yamlStale}</p>
	{/if}
	<textarea bind:value={text} oninput={ontyped} spellcheck="false" aria-label={t.aircraft.yamlAria}
	></textarea>
	{#if error}
		<!-- Schema validation errors stay English by recorded decision. -->
		<p class="err" role="alert" lang="en">{error}</p>
	{/if}
	<div>
		<button class="btn" onclick={onapply}>{t.aircraft.applyToForms}</button>
	</div>
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 8px;
		height: 100%;
	}

	textarea {
		flex: 1;
		min-height: 320px;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 12px;
		line-height: 1.45;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 8px 10px;
		resize: none;
		white-space: pre;
	}
</style>
