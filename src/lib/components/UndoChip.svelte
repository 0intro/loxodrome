<script lang="ts">
	/* The map's undo chip (state/undoChip.svelte.ts): after a route edit made
	 * on the map, a short line naming it and an Undo button, at the foot of
	 * the map, gone after a few seconds or at the next edit. The same place
	 * says, while a waypoint is armed for its one drag in flight
	 * (state/routeLock.svelte.ts, the menu's Move waypoint), what to do next,
	 * with a Cancel; the drop then raises the undo chip there. It stands at
	 * the top of the map's bottom-left column (MapView .corner-bl), above the
	 * terrain legend and the cursor badge, which it never covers. The live
	 * region is always in the DOM, so it exists before its text does and the
	 * line is announced. Only the chip takes the pointer: the column is
	 * pointer-inert, so a pan that starts beside it goes to the map. */
	import { t } from '$lib/state/i18n.svelte';
	import { activeRoute } from '$lib/state/route.svelte';
	import { endWaypointMove, routeLock } from '$lib/state/routeLock.svelte';
	import {
		holdUndoChip,
		takeUndo,
		undoChip,
		undoChipShown,
		type UndoChipKind,
	} from '$lib/state/undoChip.svelte';

	const shown = $derived(undoChipShown());
	/** The line for a waypoint armed for its one drag, else null. */
	const moving = $derived.by(() => {
		const id = routeLock.moveId;
		const wp = id === null ? undefined : activeRoute().waypoints.find((w) => w.id === id);
		if (!wp) {
			return null;
		}
		const name = wp.ident ?? wp.label;
		return name ? t.map.moveArmedNamed(name) : t.map.moveArmed;
	});
	const words: Record<UndoChipKind, string> = $derived({
		moved: t.map.undoMoved,
		added: t.map.undoAdded,
		inserted: t.map.undoInserted,
		removed: t.map.undoRemoved,
	});

	// The pointer and the focus each hold the countdown; plain flags, read
	// only by the handlers.
	let hovered = false;
	let focused = false;
	function hold(): void {
		holdUndoChip(hovered || focused);
	}
</script>

<div class="undo-slot no-print" role="status">
	{#if moving}
		<div class="undo-chip map-bar">
			<span class="undo-text">{moving}</span>
			<button type="button" class="text-btn undo-btn" onclick={endWaypointMove}>{t.common.cancel}</button>
		</div>
	{:else if shown && undoChip.kind}
		<div
			class="undo-chip map-bar"
			role="group"
			onmouseenter={() => {
				hovered = true;
				hold();
			}}
			onmouseleave={() => {
				hovered = false;
				hold();
			}}
			onfocusin={() => {
				focused = true;
				hold();
			}}
			onfocusout={() => {
				focused = false;
				hold();
			}}
		>
			<span class="undo-text">{words[undoChip.kind]}</span>
			<button type="button" class="text-btn undo-btn" onclick={takeUndo}>{t.route.undo}</button>
		</div>
	{/if}
</div>

<style>
	/* A flex item of the corner column, which places it; empty, it takes no
	   room the readouts below it would notice (the column grows upward). */
	.undo-slot {
		pointer-events: none;
	}

	/* The map's bar family (app.css .map-bar) with a worded action. The
	   whole chip takes the pointer, unlike a strip: a reader holding the
	   offer with the mouse over its sentence is what holds the countdown. */
	.undo-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		width: max-content;
		max-width: min(calc(100vw - 32px), 420px);
		padding: 2px 2px 2px 10px;
		font-size: var(--fs-md);
		pointer-events: auto;
	}

	.undo-text {
		white-space: nowrap;
	}
</style>
