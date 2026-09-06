<script lang="ts">
	/* The persistence writer host (simplicity review Decision 3): one
	 * component mounted once from App (the WxPrintHost idiom) whose effects
	 * mirror the Layers choices and the route workspace to localStorage.
	 * The state modules stay effect-free (a module-level $effect needs a
	 * root); this mount is the writers' one lifecycle. Renders nothing. */

	import { onMount, untrack } from 'svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { nav } from '$lib/state/navRecording.svelte';
	import { persistAltitudeBand } from '$lib/state/filter.svelte';
	import { persistLayers } from '$lib/state/layers.svelte';
	import {
		armRoutesPersist,
		flushRoutesPersist,
		persistRoutesSoon,
		restoreRoutes,
		retryRestoreRoutes,
		routesRestorePending,
	} from '$lib/state/routePersist';

	/* Layers: discrete toggles, written synchronously on every change (the
	 * reads inside persistLayers are this effect's tracking). MapView's
	 * onMount hash seed mutates the same fields, so a #map= boot settles
	 * with the URL-derived state persisted (the documented consequence). */
	$effect(() => {
		persistLayers();
	});

	/* The level band, the one viewing condition that persists: it carries no
	   date, so restoring it cannot hide something in force. The period
	   deliberately does not, and every session opens on Now. */
	$effect(() => {
		persistAltitudeBand();
	});

	/* Routes: the writer arms only after the async restore settles, on
	 * EVERY exit path, skips included; an unarmed effect would mirror the
	 * pristine boot workspace over the stored one before the restore
	 * lands. Arming seeds the change signature, so arming itself never
	 * writes: a skipped restore (?file= boot, offline abort) leaves
	 * storage intact until the user actually edits. */
	let routesArmed = $state(false);
	onMount(() => {
		void restoreRoutes().finally(() => {
			armRoutesPersist();
			routesArmed = true;
		});
		// The debounce loses up to a second on tab close; pagehide flushes it.
		window.addEventListener('pagehide', flushRoutesPersist);
		return () => window.removeEventListener('pagehide', flushRoutesPersist);
	});
	$effect(() => {
		if (!routesArmed) {
			return;
		}
		persistRoutesSoon();
	});

	/* A restore that could not apply the stored workspace HOLDS it instead of
	 * walking away (routePersist), and this is what calls back when the data
	 * arrives: the two load flags flip only on a success, and the revision
	 * counter bumps again for each country the coverage gate lets in later,
	 * which is what can turn a LOSSY restore into a complete one. The map's
	 * own layers keep retrying the fetches on their cadence, so this rides an
	 * existing signal rather than polling.
	 *
	 * The call is untracked, and deliberately: retryRestoreRoutes is async,
	 * so its body runs synchronously into the restore, which READS the
	 * workspace yaml and WRITES routeSettings.vfr inside it. Tracked, that
	 * write invalidates this very effect, which re-runs while the first
	 * attempt is still awaiting its datasets and starts a second concurrent
	 * restore: two loadRoutes, two undo steps. The reads above are this
	 * effect's whole dependency set, and retryRestoreRoutes carries its own
	 * re-entrancy guard behind that.
	 *
	 * Never while recording: a late restore would swap the route under a
	 * pilot in flight, taking the nav log, the progress fold and the alert
	 * grading with it. The hold simply stands until the flight is over. */
	$effect(() => {
		const ready = dataState.airportsLoaded && dataState.navaidsLoaded;
		void dataState.revision.navaids;
		void dataState.revision.airports;
		if (!ready || !routesArmed || nav.recording || !routesRestorePending()) {
			return;
		}
		untrack(() => {
			void retryRestoreRoutes();
		});
	});
</script>
