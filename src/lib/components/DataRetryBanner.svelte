<script lang="ts">
	/* The data retry notice (docs/data-retry.md): what aeronautical data did
	   not load and is being read again, from the moment a first retry comes
	   due without landing it, so a blip the first retry closes never shows.
	   A country missing from a dataset is otherwise invisible (the map simply
	   has nothing there), and an empty alert band over it reads as clear.
	   Retry now asks every pending read at once; the dismissal holds until
	   something new fails. Mounted by both apps above their toolbars. */
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { bannerEntries, dismissDataRetry, retryDataNow } from '$lib/state/dataRetry.svelte';
	import { describeMissing } from '$lib/format/dataRetry';
	import Banner from './Banner.svelte';

	const text = $derived.by(() => {
		const entries = bannerEntries();
		if (!entries) {
			return null;
		}
		// A chart index that is no publisher (a held State's, Denmark's) by
		// its region in the reading language, as the About dialog names it.
		const regions = new Intl.DisplayNames([i18n.locale], { type: 'region', fallback: 'none' });
		return describeMissing(entries, {
			sentence: t.common.dataRetry,
			groups: t.common.dataRetryGroups,
			publishers: t.layers.publisherNames,
			regionName: (code) => (/^[a-z]{2}$/.test(code) ? regions.of(code.toUpperCase()) : undefined),
		});
	});
</script>

{#if text}
	<Banner
		{text}
		actionLabel={t.common.retryNow}
		onAction={() => void retryDataNow()}
		dismissLabel={t.common.dismiss}
		onDismiss={dismissDataRetry}
	/>
{/if}
