<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import Banner from './Banner.svelte';
</script>

{#if dataState.airacSwitchPending}
	<Banner
		text={t.common.airacSwitch}
		actionLabel={t.common.reload}
		onAction={() => location.reload()}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (dataState.airacSwitchPending = false)}
	/>
{/if}
