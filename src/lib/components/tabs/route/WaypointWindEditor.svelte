<script lang="ts">
	/* Inline per-leg wind override editor replacing the W/V chip: direction
	 * (° true) / speed (kt). Enter or leaving commits (both emptied = clear),
	 * Escape cancels, the x clears the override. String-typed while open
	 * (numeric inputs are value= + oninput, the editor convention); the
	 * WaypointRow {#if} mounts a fresh instance per open, which is what seeds
	 * the fields from the leg's effective wind. */
	import Icon from '../../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { setWaypointWind, clearWaypointWind } from '$lib/state/route.svelte';
	import type { EffectiveLegWind } from '$lib/route/legWind';

	interface Props {
		/** The waypoint whose leg wind is being overridden. */
		wpId: string;
		/** The leg's effective wind, seeding the fields. */
		wind: EffectiveLegWind | null;
		/** Commit, cancel and clear all end here; the row flips its open flag. */
		onClose: () => void;
	}
	const { wpId, wind, onClose }: Props = $props();

	// The fields SEED from the effective wind at open and then live their own
	// life (the user is typing); the {#if} remount is the refresh path.
	// svelte-ignore state_referenced_locally
	let dir = $state(String(Math.round(wind?.dirDeg ?? 0)));
	// svelte-ignore state_referenced_locally
	let spd = $state(String(Math.round(wind?.speedKt ?? 0)));

	function autofocus(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	// One-shot close latch (the retired shared-state editor's null guard):
	// closing unmounts the focused input and Chrome then fires a focusout on
	// the removal, which must not commit again over an Enter, an Escape or
	// the x's clear.
	let closed = false;
	function close(): void {
		closed = true;
		onClose();
	}

	function commit(): void {
		if (closed) {
			return;
		}
		// A type=number input reports '' for emptied or invalid content, and
		// Number('') is 0: an emptied editor means "no override", so a blank
		// commit clears it (like the x button), never a spurious 0/0 override.
		// parseFloat('') is NaN, so a half-blank / unparsable pair cancels,
		// mirroring the global-wind handlers' blank-means-null rule.
		const dirText = dir.trim();
		const spdText = spd.trim();
		if (dirText === '' && spdText === '') {
			clearWaypointWind(wpId);
		} else {
			const d = parseFloat(dirText);
			const s = parseFloat(spdText);
			if (Number.isFinite(d) && Number.isFinite(s) && s >= 0) {
				setWaypointWind(wpId, ((Math.round(d) % 360) + 360) % 360, Math.round(s));
			}
		}
		close();
	}

	function onKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			commit();
		} else if (e.key === 'Escape') {
			close();
		}
	}

	function onFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget as Node | null;
		if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
			commit();
		}
	}
</script>

<span class="leg-wind-edit" onfocusout={onFocusOut}>
	<input
		type="number"
		min="0"
		max="360"
		step="5"
		use:autofocus
		value={dir}
		oninput={(e) => (dir = e.currentTarget.value)}
		onkeydown={onKey}
		aria-label={t.route.windDirAria}
	/>
	<span>/</span>
	<input
		type="number"
		min="0"
		step="5"
		value={spd}
		oninput={(e) => (spd = e.currentTarget.value)}
		onkeydown={onKey}
		aria-label={t.route.windSpeedAria}
	/>
	<button
		class="icon"
		title={t.route.clearWindTip}
		aria-label={t.route.clearWindAria}
		onmousedown={(e) => e.preventDefault()}
		onclick={() => {
			clearWaypointWind(wpId);
			close();
		}}
	>
		<Icon name="x" size={12} />
	</button>
</span>

<style>
	.leg-wind-edit {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 2px;
		font-size: 11px;
		color: var(--text-muted);
	}

	.leg-wind-edit input {
		width: 46px;
		padding: 3px 5px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.icon {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.icon:hover {
		color: var(--text);
		background: var(--surface-3);
	}
</style>
