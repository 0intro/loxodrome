<script lang="ts">
	/* One live-feed status line + Refresh button, shared by the Weather tab's
	 * METAR-stations, SIGMET and TEMSI/WINTEM sections. The caller owns the
	 * per-feed branching (off / zoom-in / loading / empty / count) and passes
	 * the resolved sentence; this component owns the presentation: the
	 * warning ink for errors, the ", refreshed X ago." join for count lines,
	 * and the button. */
	import { t } from '$lib/state/i18n.svelte';

	interface Props {
		/** The resolved status sentence for the normal path. */
		status: string;
		/** A count line's age, joined as ", {ageText}."; absent, status prints
		 *  verbatim with its own punctuation. */
		ageText?: string | null;
		/** Error text; when set it replaces the status line, in the warning ink. */
		error?: string | null;
		onRefresh: () => void;
		disabled?: boolean;
	}
	const { status, ageText = null, error = null, onRefresh, disabled = false }: Props = $props();
</script>

<p class="muted small status-line">
	{#if error}
		<span class="warn-inline" role="alert">{error}</span>
	{:else if ageText}
		{status}, {ageText}.
	{:else}
		{status}
	{/if}
	<button class="btn" onclick={onRefresh} {disabled}>{t.weather.refresh}</button>
</p>

<style>
	.small {
		font-size: 11px;
	}

	.status-line .btn {
		margin-left: 6px;
	}

	.warn-inline {
		color: var(--danger);
	}

</style>
