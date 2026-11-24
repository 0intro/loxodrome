<script lang="ts">
	/* The data retry notice (docs/data-retry.md): what aeronautical data did
	   not load and is being read again, from the moment a first retry comes
	   due without landing it, so a blip the first retry closes never shows.
	   A country missing from a dataset is otherwise invisible (the map simply
	   has nothing there), and an empty alert band over it reads as clear.
	   Retry now asks every pending read at once and answers in the sentence:
	   "Retrying…" while the reads the banner names run, then what is still
	   missing, with the failure those reads share, or that it all loaded,
	   which holds LOADED_MS before the banner goes. The dismissal holds until
	   something new fails. Mounted by both apps above their toolbars. */
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { bannerEntries, dataRetry, dismissDataRetry, retryAnnounced } from '$lib/state/dataRetry.svelte';
	import { describeMissing, failureText, sharedFailure } from '$lib/format/dataRetry';
	import Banner from './Banner.svelte';

	/** How long "The missing data loaded." holds after a Retry now that
	 *  landed everything the banner named. */
	const LOADED_MS = 3_000;

	let asking = $state(false);
	/** The last Retry now that left something missing: the reads it asked
	 *  about, and whether the browser said it was offline when it ended
	 *  (navigator.onLine, which nothing reactive carries). */
	let asked = $state<{ keys: readonly string[]; offline: boolean } | null>(null);
	let loaded = $state(false);
	let loadedTimer: ReturnType<typeof setTimeout> | undefined;

	/** The pending reads the banner names. */
	const named = $derived(dataRetry.pending.filter((p) => p.announced && !p.quiet));
	/** The sentence answers the last press while the banner names only reads
	 *  it asked about: one failing since is news, told the usual way. */
	const still = $derived(asked !== null && named.length > 0 && named.every((p) => asked?.keys.includes(p.key)));

	const text = $derived.by(() => {
		if (loaded) {
			return t.common.dataRetryLoaded;
		}
		const entries = bannerEntries();
		if (!entries) {
			return null;
		}
		// A chart index that is no publisher (a held State's, Denmark's) by
		// its region in the reading language, as the About dialog names it.
		const regions = new Intl.DisplayNames([i18n.locale], { type: 'region', fallback: 'none' });
		const words = {
			sentence: still ? t.common.dataRetryStill : t.common.dataRetry,
			groups: t.common.dataRetryGroups,
			publishers: t.layers.publisherNames,
			regionName: (code: string) => (/^[a-z]{2}$/.test(code) ? regions.of(code.toUpperCase()) : undefined),
		};
		const failure = still && asked ? sharedFailure(named, asked.offline) : null;
		return describeMissing(entries, words, failure ? failureText(failure, t.common.dataRetryFailures) : undefined);
	});

	async function retry(): Promise<void> {
		if (asking) {
			return;
		}
		const keys = named.map((p) => p.key);
		asking = true;
		try {
			await retryAnnounced();
		} finally {
			asking = false;
		}
		if (bannerEntries()) {
			asked = { keys, offline: typeof navigator !== 'undefined' && navigator.onLine === false };
			return;
		}
		asked = null;
		loaded = true;
		clearTimeout(loadedTimer);
		loadedTimer = setTimeout(() => (loaded = false), LOADED_MS);
	}

	$effect(() => () => clearTimeout(loadedTimer));
</script>

{#if text}
	<Banner
		{text}
		actionLabel={loaded ? undefined : t.common.retryNow}
		busyLabel={t.common.retrying}
		busy={asking}
		onAction={() => void retry()}
		dismissLabel={t.common.dismiss}
		onDismiss={loaded ? () => (loaded = false) : dismissDataRetry}
	/>
{/if}
