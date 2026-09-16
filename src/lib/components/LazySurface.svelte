<script lang="ts">
	/* Mount a workspace surface the first time it is opened, and keep it.
	 *
	 * App.svelte used to mount all ten of them unconditionally: SurfaceShell
	 * gates the DOM, not the code, so the flight-prep workbook, the aircraft
	 * editor, the flights library, About, the three profile / nav-log surfaces
	 * and the print document all ran their module graphs on every boot, in the
	 * entry chunk, for a pilot who never opened one.
	 *
	 * MOUNT AND KEEP, not mount and unmount: several surfaces do real work on
	 * the way out. FlightPrepModal cancels a running print job when it closes,
	 * RouteProfileModal drops its MSA state, and every surface's back-entry and
	 * print-claim registrations release through their own effect teardowns.
	 * Unmounting on close would change all of that. Keeping it means everything
	 * after the first open behaves exactly as before, and only the download,
	 * parse and first execution move to the moment the pilot asks. */

	import type { Component } from 'svelte';
	import type { SurfaceId } from '$lib/surfaces';
	import { closeSurface } from '$lib/state/workspace.svelte';

	interface Props {
		/** The surface's registry id: what a failed load releases. */
		id: SurfaceId;
		/** The surface's own open flag. */
		open: boolean;
		/** The dynamic import of its module. */
		load: () => Promise<{ default: Component }>;
	}

	let { id, open, load }: Props = $props();

	let Surface = $state<Component | null>(null);
	// Plain let: the guard must not make this effect re-run on its own write.
	let requested = false;

	$effect(() => {
		if (!open || requested) {
			return;
		}
		requested = true;
		// A failed chunk fetch (offline before the precache filled, a deploy
		// that rotated the hashes under a browser the service worker does not
		// yet control) must RELEASE the surface: openSurface has already
		// claimed its slot, reserved a dock strip or hidden the map for a
		// page, and every close control (the shell, Escape, the backdrop)
		// lives in the chunk that did not arrive. Closing hands the stage
		// back; the launcher stays, and the next open retries the load.
		void load()
			.then((m) => {
				Surface = m.default;
			})
			.catch((err: unknown) => {
				requested = false;
				closeSurface(id);
				console.error('surface chunk failed to load', id, err);
			});
	});
</script>

{#if Surface}
	<Surface />
{/if}
