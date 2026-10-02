<script lang="ts">
	import { printValue } from '$lib/ui/printValue';
	import { normalizeClock24 } from '$lib/format/datetime';

	/* A compact 24-hour HH:MM time field (UTC / Zulu). Every time in the app is
	 * 24h with no AM/PM, so this replaces the native time picker, which renders
	 * 12h AM/PM in some browser locales: too wide for the panel, and error-prone
	 * for a Zulu field. Controlled: the value comes in as `value`, a committed
	 * change reports the canonical 'HH:MM' via oncommit. Lenient entry (1830 /
	 * 6:00 / 18) is normalised on commit; unparseable input is rejected back to
	 * the last good value. printValue mirrors the value so the field prints in
	 * Gecko (the property-vs-attribute clone gap; inert on screen). */

	interface Props {
		/** The current 'HH:MM' value (empty string when unset). */
		value: string;
		/** Called with the canonical 'HH:MM' on a valid change, or '' when the
		 *  field is cleared and allowEmpty is set. */
		oncommit: (value: string) => void;
		/** Treat an empty field as a valid (cleared) value rather than rejecting. */
		allowEmpty?: boolean;
		disabled?: boolean;
		ariaLabel?: string;
	}
	const { value, oncommit, allowEmpty = false, disabled = false, ariaLabel }: Props = $props();

	function commit(e: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
		const raw = e.currentTarget.value.trim();
		if (allowEmpty && raw === '') {
			e.currentTarget.value = '';
			oncommit('');
			return;
		}
		const norm = normalizeClock24(raw);
		if (norm) {
			e.currentTarget.value = norm;
			oncommit(norm);
		} else {
			// Reject: restore the last good value.
			e.currentTarget.value = value;
		}
	}
</script>

<input
	class="time-field"
	type="text"
	inputmode="numeric"
	autocomplete="off"
	maxlength="5"
	{value}
	{disabled}
	aria-label={ariaLabel}
	use:printValue={value}
	onchange={commit}
/>

<style>
	.time-field {
		width: 4.75em;
		min-width: 0;
		max-width: 100%;
		padding: 5px 7px;
		font: inherit;
		text-align: center;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.time-field:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
