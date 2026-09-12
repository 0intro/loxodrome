<script lang="ts">
	import { i18n, setLocale, t } from '$lib/state/i18n.svelte';
</script>

<button
	class="icon-btn lang-btn"
	onclick={() => setLocale(i18n.locale === 'en' ? 'fr' : 'en')}
	title={t.common.langSwitch}
	aria-label={t.common.langSwitch}
>
	{i18n.locale === 'fr' ? 'FR' : 'EN'}
</button>
<!-- Announces the switch to screen readers in the new language: visually
     hidden, role=status fires on text change without moving focus. -->
<span class="sr-only" role="status">{t.common.langStatus}</span>

<style>
	.lang-btn {
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.04em;
	}
</style>
