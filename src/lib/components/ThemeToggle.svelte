<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import Icon from './Icon.svelte';
	import { theme, toggleTheme } from '$lib/state/theme.svelte';
</script>

<button
	class="icon-btn"
	onclick={toggleTheme}
	title={theme.value === 'night' ? t.common.themeToDay : t.common.themeToNight}
	aria-label={t.common.themeToggle}
>
	<Icon name={theme.value === 'night' ? 'sun' : 'moon'} />
</button>
