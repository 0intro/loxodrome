<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { pwa, applyUpdate, dismissUpdate } from '$lib/state/pwa.svelte';
	import Banner from './Banner.svelte';
</script>

{#if pwa.needRefresh}
	<Banner
		text={t.common.updateReady}
		actionLabel={t.common.reload}
		onAction={applyUpdate}
		dismissLabel={t.common.dismiss}
		onDismiss={dismissUpdate}
	/>
{/if}
