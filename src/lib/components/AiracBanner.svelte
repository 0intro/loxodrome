<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { isNativeApp } from '$lib/native/platform';
	import { reloadApp } from '$lib/state/pwa.svelte';
	import Banner from './Banner.svelte';

	/* The expiry banner (src/lib/data/airacValidity.ts): the datasets this
	   build shipped are a whole AIRAC cycle behind. The site redeploys with
	   every data refresh, so a reload is the web's update, once the new
	   version's waiting worker is let in (reloadApp: the expiry date is baked
	   into the bundle, so a reload under the old worker brought back the old
	   bundle and the same banner); the Android app carries its data inside the
	   APK and only a new release replaces it, which the store listing offers.
	   Dismissing lasts this session only: the data stays expired, and a pilot
	   opening the app tomorrow is told again. */
	const STORE_URL = 'https://play.google.com/store/apps/details?id=fr.loxodrome.app';
	const native = isNativeApp();
	const expiredOn = (__DATA_VALID_UNTIL__ ?? '').slice(0, 10);
	let expiryDismissed = $state(false);
	/* The switch banner's dismissal is the banner's own state, like the
	   expiry's. It used to clear dataState.airacSwitchPending, which is the
	   heartbeat's OUTPUT: the next minute tick computed it again and the
	   banner came back within a minute of being dismissed. Once pending the
	   flag stays pending for the session (a loaded slot only goes stale), so
	   dismissing for the session hides exactly what was dismissed. */
	let switchDismissed = $state(false);

	function update(): void {
		if (native) {
			window.open(STORE_URL, '_blank', 'noopener,noreferrer');
		} else {
			reloadApp();
		}
	}
</script>

{#if dataState.airacSwitchPending && !switchDismissed}
	<Banner
		text={t.common.airacSwitch}
		actionLabel={t.common.reload}
		onAction={reloadApp}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (switchDismissed = true)}
	/>
{/if}
{#if dataState.dataExpired && !expiryDismissed}
	<Banner
		text={t.common.dataExpired({ date: expiredOn })}
		actionLabel={native ? t.common.updateApp : t.common.reload}
		onAction={update}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (expiryDismissed = true)}
	/>
{/if}
