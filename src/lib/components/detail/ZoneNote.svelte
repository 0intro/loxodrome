<script lang="ts">
	/* The pilot's note of what a unit said of a zone, under the zone's state
	   on its panel (detail/ZoneStatus.svelte): while the zone may be active,
	   the state the unit gives, until when and from whom; once noted, the
	   note and its Clear. The note is the flight app's
	   (planScope.zoneNotes, state/zoneNotes.svelte.ts), kept for the flight,
	   and settles the zone wherever it may be active. The until box's grey
	   placeholder is the time in force: the end of the period the zone may
	   be active in, the planned flight's end at the latest, a day ahead at
	   most. The unit box's is the first unit the zone names. */
	import TimeField from '$lib/components/TimeField.svelte';
	import { noteLine, type ZoneState } from '$lib/components/zoneStateText';
	import { nextClockMs } from '$lib/format/datetime';
	import type { AlertVolume } from '$lib/nav/alertVolumes';
	import { fmtClockUtc } from '$lib/route/format';
	import { t } from '$lib/state/i18n.svelte';
	import { planScope, type ZoneNotesScope } from '$lib/state/planScope.svelte';

	interface Props {
		volume: AlertVolume;
		zone: ZoneState;
		notes: ZoneNotesScope;
	}

	let { volume, zone, notes }: Props = $props();

	const MINUTE_MS = 60_000;
	/** The farthest a default end reaches: the box holds a clock time, read
	 *  as its next occurrence (format/datetime.ts nextClockMs). */
	const HORIZON_MS = 86_400_000;

	let untilTyped = $state('');
	let unitTyped = $state('');

	const defaultUnit = $derived(volume.knownFrom.find((k) => k.unit !== '')?.unit ?? '');
	const defaultUntilMs = $derived.by(() => {
		const now = Date.now();
		const ends = [zone.answer.period?.endMs, planScope.flight?.window()?.to].filter(
			(x): x is number => x !== undefined && Number.isFinite(x) && x > now,
		);
		if (ends.length === 0) {
			return null;
		}
		const end = Math.floor(Math.min(...ends) / MINUTE_MS) * MINUTE_MS;
		return end > now && end - now <= HORIZON_MS ? end : null;
	});
	const timed = $derived(untilTyped !== '' || defaultUntilMs !== null);

	function take(state: 'active' | 'inactive'): void {
		const now = Date.now();
		const until = untilTyped !== '' ? nextClockMs(untilTyped, now) : defaultUntilMs;
		if (until === null) {
			return;
		}
		notes.set(volume.id, {
			state,
			notedAtMs: now,
			untilMs: until,
			unit: unitTyped.trim() || defaultUnit,
			name: volume.name,
		});
	}
</script>

{#if zone.note}
	{#if zone.answer.reason !== 'noted'}
		<p class="line">{noteLine(zone.note)}</p>
	{/if}
	<button class="btn clear" onclick={() => notes.clear(volume.id)}>{t.zones.noteClear}</button>
{:else if zone.answer.state === 'activable'}
	<div class="zone-note">
		<p class="line">{t.zones.noteHead}</p>
		<div class="fields">
			<label>
				<span>{t.zones.noteUntil}</span>
				<TimeField
					value={untilTyped}
					oncommit={(v: string) => (untilTyped = v)}
					allowEmpty
					placeholder={defaultUntilMs !== null ? fmtClockUtc(defaultUntilMs) : undefined}
					ariaLabel={t.zones.noteUntilAria}
				/>
			</label>
			<label>
				<span>{t.zones.noteUnit}</span>
				<input
					class="unit"
					type="text"
					autocomplete="off"
					bind:value={unitTyped}
					placeholder={defaultUnit}
					aria-label={t.zones.noteUnitAria}
				/>
			</label>
		</div>
		<div class="acts">
			<button class="btn" disabled={!timed} title={t.zones.noteInactiveTip} onclick={() => take('inactive')}
				>{t.zones.noteInactive}</button
			>
			<button class="btn" disabled={!timed} title={t.zones.noteActiveTip} onclick={() => take('active')}
				>{t.zones.noteActive}</button
			>
		</div>
	</div>
{/if}

<style>
	.zone-note {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 6px;
	}

	.line {
		margin: 0;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 12px;
		align-items: center;
	}

	.fields label {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		font-size: var(--fs-xs);
		color: var(--text-muted);
	}

	.unit {
		width: 12em;
		min-width: 0;
		padding: 5px 7px;
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.acts {
		display: flex;
		gap: 6px;
	}

	.clear {
		align-self: flex-start;
		margin-top: 6px;
	}
</style>
