<script lang="ts">
	/* The sync engine's mount-once host (the PersistHost idiom): the
	 * triggers need rune tracking inside a component effect and the state
	 * modules stay effect-free, so this mount is the engine's one
	 * lifecycle. Renders nothing.
	 *
	 * The single-slot setOutingSettledHook is flightLibrary's and sync
	 * NEVER touches it: the $effect below sees the archived row land in
	 * flightLibrary.rows, and the engine's own !nav.recording gate is what
	 * holds the just-flown trace's blobs until the archive settle. */

	import { onMount } from 'svelte';
	import { account, signedIn } from '$lib/state/account.svelte';
	import { aircraftState } from '$lib/state/aircraft.svelte';
	import { flightLibrary } from '$lib/state/flightLibrary.svelte';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import { planCatalog } from '$lib/state/planCatalog.svelte';
	import { whenRoutesRestored } from '$lib/state/routePersist';
	import { checkSharedExpiry, syncNow } from '$lib/state/sync.svelte';

	onMount(() => {
		// The first pass sequences BEHIND the workspace restore, so the
		// rescue deposit is in the catalog before adoption enumerates it.
		void whenRoutesRestored().then(async () => {
			await checkSharedExpiry();
			await syncNow();
		});
		const onVisible = () => {
			if (document.visibilityState === 'visible') {
				void checkSharedExpiry().then(() => syncNow());
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		// Best-effort flush (inside fetch-keepalive's small budget; the
		// next trigger catches whatever a closing page cut off).
		const onPageHide = () => {
			void syncNow();
		};
		window.addEventListener('pagehide', onPageHide);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('pagehide', onPageHide);
		};
	});

	// The debounced mutation trigger: rune reads over the synced stores
	// (the persist-writer idiom), DEEP enough that an in-place edit fires
	// too: a remark or stamp edit replaces a row at an unchanged count, a
	// plane edit swaps one value under an unchanged key set (copy-on-
	// write), and length-only reads would sleep through all of them.
	let debounce: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (!signedIn()) {
			return;
		}
		void account.email;
		for (const r of flightLibrary.rows) {
			void r.savedAtMs;
			void r.remarks;
			void r.aircraftKey;
			void r.declared;
		}
		for (const r of planCatalog.rows) {
			void r.savedAtMs;
		}
		for (const key of Object.keys(aircraftState.user)) {
			void aircraftState.user[key];
		}
		for (const key of Object.keys(aircraftState.tankedFuel)) {
			void aircraftState.tankedFuel[key];
		}
		void flightPrep.dossier.pilot.name;
		void flightPrep.dossier.pilot.sepValidUntil;
		void flightPrep.dossier.pilot.medicalValidUntil;
		if (debounce !== null) {
			clearTimeout(debounce);
		}
		debounce = setTimeout(() => {
			debounce = null;
			void syncNow();
		}, 3000);
	});
</script>
