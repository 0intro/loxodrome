<script lang="ts">
	/* The automatic NOTAM briefing's host (flight app only, mounted once by
	 * App.svelte beside PersistHost). It keeps what the decision and the
	 * notice read of the page (briefingWatch: online, visible, the plan
	 * restored and since when it holds) and the pilot's last press, and one
	 * effect runs the clock (state/briefingClock.svelte.ts), which starts the
	 * run when it is due. A second effect asks for the SUP AIP list the
	 * verdict reads the briefing's trigger NOTAMs against, and a third sets
	 * the Android reminder at the RTBA release
	 * (state/briefingReminder.svelte.ts), whose permission is read at the
	 * start and each time the app comes back. */
	import { onMount } from 'svelte';
	import { isNativeApp } from '$lib/native/platform';
	import { briefingWatch, ensureSupaipForTriggers } from '$lib/state/briefing.svelte';
	import { createBriefingClock } from '$lib/state/briefingClock.svelte';
	import { readReminderPermission, syncBriefingReminder } from '$lib/state/briefingReminder.svelte';
	import { whenRoutesRestored } from '$lib/state/routePersist';

	const clock = createBriefingClock();

	onMount(() => {
		briefingWatch.online = navigator.onLine;
		briefingWatch.visible = document.visibilityState === 'visible';
		void whenRoutesRestored().then(() => {
			briefingWatch.restored = true;
		});
		const onLine = (): void => {
			briefingWatch.online = navigator.onLine;
		};
		const onVisibility = (): void => {
			briefingWatch.visible = document.visibilityState === 'visible';
			if (briefingWatch.visible && isNativeApp()) {
				void readReminderPermission();
			}
		};
		// Android's permission question leaves the page visible: its answer
		// comes back with the window's focus.
		const onFocus = (): void => {
			void readReminderPermission();
		};
		if (isNativeApp()) {
			void readReminderPermission();
			addEventListener('focus', onFocus);
		}
		const onActive = (): void => {
			clock.pressed();
		};
		addEventListener('online', onLine);
		addEventListener('offline', onLine);
		document.addEventListener('visibilitychange', onVisibility);
		document.addEventListener('pointerdown', onActive, { capture: true, passive: true });
		document.addEventListener('keydown', onActive, { capture: true, passive: true });
		return () => {
			removeEventListener('focus', onFocus);
			removeEventListener('online', onLine);
			removeEventListener('offline', onLine);
			document.removeEventListener('visibilitychange', onVisibility);
			document.removeEventListener('pointerdown', onActive, { capture: true });
			document.removeEventListener('keydown', onActive, { capture: true });
			clock.stop();
		};
	});

	$effect(() => clock.tick());

	$effect(ensureSupaipForTriggers);

	$effect(() => syncBriefingReminder());
</script>
