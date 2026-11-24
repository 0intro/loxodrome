<script lang="ts">
	/* Inline per-leg wind override editor, opened from the W/V chip: direction
	 * (° true) / speed (kt). It fills the leg's tail exactly (the cue slots and
	 * the chip, laid out under it), so opening it never moves the altitude
	 * field. The boxes follow the placeholder rule: empty, they show the
	 * AUTOMATIC wind in grey (the forecast, else the global wind), and an
	 * override is what the pilot types, so opening and leaving changes
	 * nothing. Enter in the direction moves to the speed, Enter in the speed
	 * or leaving commits (route/legWind.ts windEditOutcome decides), Escape
	 * cancels, the x clears an override. String-typed while open (numeric
	 * inputs are value= + oninput, the editor convention); the WaypointRow
	 * {#if} mounts a fresh instance per open, which seeds the boxes. */
	import Icon from '../../Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { setWaypointWind, clearWaypointWind } from '$lib/state/route.svelte';
	import { windDirText, windEditOutcome, type WindVec } from '$lib/route/legWind';

	interface Props {
		/** The waypoint whose leg wind is being overridden. */
		wpId: string;
		/** The leg's override, seeding the boxes; null leaves them empty. */
		override: WindVec | null;
		/** The automatic wind, the boxes' grey value; null when none resolves. */
		auto: WindVec | null;
		/** Commit, cancel and clear all end here; the row flips its open flag
		 *  and, after a key or the x (never after a click elsewhere), gives the
		 *  focus back to the chip. */
		onClose: (refocus: boolean) => void;
	}
	const { wpId, override, auto, onClose }: Props = $props();

	// The boxes SEED from the override at open and then live their own life
	// (the user is typing); the {#if} remount is the refresh path.
	// svelte-ignore state_referenced_locally
	let dir = $state(override ? windDirText(override.dirDeg) : '');
	// svelte-ignore state_referenced_locally
	let spd = $state(override ? String(Math.round(override.speedKt)) : '');
	const dirPlaceholder = $derived(auto ? windDirText(auto.dirDeg) : '');
	const spdPlaceholder = $derived(auto ? String(Math.round(auto.speedKt)) : '');

	let dirEl = $state<HTMLInputElement | null>(null);
	let spdEl = $state<HTMLInputElement | null>(null);

	function autofocus(node: HTMLInputElement): void {
		node.focus();
		node.select();
	}

	// One-shot close latch: closing unmounts the focused input and Chrome then
	// fires a focusout on the removal, which must not commit again over an
	// Enter, an Escape or the x's clear.
	let closed = false;
	function close(refocus: boolean): void {
		closed = true;
		onClose(refocus);
	}

	/** Commit what the boxes say. `fromKey`: an Enter, which moves to an empty
	 *  box rather than discard a half-typed pair; leaving discards it. */
	function commit(fromKey: boolean): void {
		if (closed) {
			return;
		}
		const out = windEditOutcome(dir, spd, auto, override);
		if (out.kind === 'incomplete' && fromKey) {
			const empty = dir.trim() === '' ? dirEl : spdEl;
			empty?.focus();
			return;
		}
		if (out.kind === 'clear') {
			clearWaypointWind(wpId);
		} else if (out.kind === 'set') {
			setWaypointWind(wpId, out.dirDeg, out.speedKt);
		}
		close(fromKey);
	}

	function onDirKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			spdEl?.focus();
			spdEl?.select();
		} else if (e.key === 'Escape') {
			close(true);
		}
	}

	function onSpdKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			commit(true);
		} else if (e.key === 'Escape') {
			close(true);
		}
	}

	/** A box's text, unless it is a half-typed number (badInput reads as ''),
	 *  which waits for the next key rather than reading as an emptied box. */
	function boxText(e: Event, prev: string): string {
		const el = e.currentTarget as HTMLInputElement;
		return el.validity.badInput ? prev : el.value;
	}

	function onFocusOut(e: FocusEvent): void {
		const next = e.relatedTarget as Node | null;
		if (!next || !(e.currentTarget as HTMLElement).contains(next)) {
			commit(false);
		}
	}
</script>

<span class="leg-wind-edit" onfocusout={onFocusOut}>
	<input
		bind:this={dirEl}
		type="number"
		lang="en"
		inputmode="numeric"
		enterkeyhint="next"
		min="0"
		max="360"
		step="5"
		use:autofocus
		value={dir}
		placeholder={dirPlaceholder}
		oninput={(e) => (dir = boxText(e, dir))}
		onkeydown={onDirKey}
		aria-label={t.route.windDirAria}
	/>
	<span class="sep">/</span>
	<input
		bind:this={spdEl}
		type="number"
		lang="en"
		inputmode="numeric"
		enterkeyhint="done"
		min="0"
		step="5"
		value={spd}
		placeholder={spdPlaceholder}
		oninput={(e) => (spd = boxText(e, spd))}
		onkeydown={onSpdKey}
		aria-label={t.route.windSpeedAria}
	/>
	{#if override}
		<button
			class="clear"
			title={t.route.clearWindTip}
			aria-label={t.route.clearWindAria}
			onmousedown={(e) => e.preventDefault()}
			onclick={() => {
				clearWaypointWind(wpId);
				close(true);
			}}
		>
			<Icon name="x" size={12} />
		</button>
	{/if}
</span>

<style>
	/* Fills the leg's tail (position: relative there), so neither the editor,
	 * its x nor a font can move the altitude field or grow the row. */
	.leg-wind-edit {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		gap: 2px;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Two boxes sharing what the tail leaves them (about 41 px each at the
	 * default width, 32 px below 340 px of list), wide enough for "360" only
	 * without the spinner: the arrow keys still step, from the grey value. */
	.leg-wind-edit input {
		flex: 1 1 0;
		min-width: 0;
		padding: 3px 2px;
		font: inherit;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		text-align: center;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
		appearance: textfield;
	}

	.leg-wind-edit input::-webkit-inner-spin-button,
	.leg-wind-edit input::-webkit-outer-spin-button {
		margin: 0;
		appearance: none;
	}

	/* The automatic wind, the value in force: the workbook's muted ink. */
	.leg-wind-edit input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	.sep {
		flex: 0 0 auto;
	}

	.clear {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.clear:hover {
		color: var(--text);
		background: var(--surface-3);
	}
</style>
