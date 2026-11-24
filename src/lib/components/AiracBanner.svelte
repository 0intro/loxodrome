<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { isNativeApp } from '$lib/native/platform';
	import { pwa, reloadApp, type ReloadOutcome } from '$lib/state/pwa.svelte';
	import Banner from './Banner.svelte';

	/* The expiry banner (src/lib/data/airacValidity.ts): the datasets this
	   build shipped are a whole AIRAC cycle behind. The site redeploys with
	   every data refresh, so the web's Update asks the site for its newest
	   version and reloads onto it (reloadApp: the expiry date is baked into
	   the bundle, so a reload onto the bundle the page runs brings back the
	   same banner), and says so when the site has none newer yet or cannot
	   be asked. The Android app carries its data inside the APK and only a
	   new release replaces it, which the store listing offers. Dismissing
	   lasts this session only: the data stays expired, and a pilot opening
	   the app tomorrow is told again. */
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
	/* What the web's Update last came to, the page still here. A version
	   found waiting since makes 'current' stale, and the new-version banner
	   then says what there is. */
	let updated = $state<ReloadOutcome>(null);
	const expiryText = $derived.by(() => {
		const text = t.common.dataExpired({ date: expiredOn });
		if (updated === 'current' && !pwa.needRefresh) {
			return `${text} ${t.common.updateCurrent}`;
		}
		if (updated === 'unreachable') {
			return `${text} ${t.common.updateUnreachable}`;
		}
		return text;
	});

	async function update(): Promise<void> {
		if (native) {
			window.open(STORE_URL, '_blank', 'noopener,noreferrer');
			return;
		}
		updated = null;
		updated = await reloadApp({ check: true });
	}
</script>

{#if dataState.airacSwitchPending && !switchDismissed}
	<Banner
		text={t.common.airacSwitch}
		actionLabel={t.common.reload}
		busyLabel={t.common.reloading}
		busy={pwa.busy}
		onAction={() => void reloadApp()}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (switchDismissed = true)}
	/>
{/if}
{#if dataState.dataExpired && !expiryDismissed}
	<Banner
		text={expiryText}
		actionLabel={t.common.updateApp}
		busyLabel={t.common.updating}
		busy={pwa.busy}
		onAction={() => void update()}
		dismissLabel={t.common.dismiss}
		onDismiss={() => (expiryDismissed = true)}
	/>
{/if}
