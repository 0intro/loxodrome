<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { pwa, reloadApp } from '$lib/state/pwa.svelte';
	import Banner from './Banner.svelte';

	/* The dismissal is the banner's own state, like AiracBanner's:
	   pwa.needRefresh only says a version waits, and the expiry banner's
	   Reload lets it in whether or not this one was dismissed. */
	let dismissed = $state(false);
</script>

{#if pwa.needRefresh && !dismissed}
	<Banner
		text={t.common.updateReady}
		actionLabel={t.common.reload}
		busyLabel={t.common.reloading}
		busy={pwa.busy}
		onAction={() => void reloadApp()}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (dismissed = true)}
	/>
{/if}
