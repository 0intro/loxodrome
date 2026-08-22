<script lang="ts">
	/* The COM-frequency block shared by the airport and airspace panels:
	 * the rows in the panel's own layout (the airport service table, the
	 * airspace frequency-first list), each NOTAM-overridden row carrying
	 * the struck prior value + source-NOTAM link, and the non-applied
	 * changes as a flags list linking their NOTAM. The RAI badge is
	 * airspace-only (docs/siv-frequencies.md), carried by raiIndex. */
	import { t } from '$lib/state/i18n.svelte';
	import { formatFreqMHz } from '$lib/format/radio';
	import {
		flagText,
		freqFlagKey,
		type EffectiveAirportRadio,
		type EffectiveAirspaceRadio,
		type FreqChangeFlag,
		type RadioOverride,
	} from '$lib/state/freqOverride.svelte';
	import NotamIdButton from './NotamIdButton.svelte';

	interface Props {
		/** 'table' = the airport service columns; 'list' = the airspace stack. */
		layout: 'table' | 'list';
		radios: EffectiveAirportRadio[] | EffectiveAirspaceRadio[];
		flags: FreqChangeFlag[];
		/** Index of the airspace's RAI (auto-info) row; list layout only. */
		raiIndex?: number | null;
	}
	let { layout, radios, flags, raiIndex = null }: Props = $props();

	/** The airspace-side closure provenance, when the resolver stamped one
	 *  (airport rows never carry it). */
	function closedOf(
		r: EffectiveAirportRadio | EffectiveAirspaceRadio,
	): EffectiveAirspaceRadio['closedBy'] | null {
		return 'closedBy' in r && r.closedBy != null ? r.closedBy : null;
	}

	/** The designated substitutes as one printable run: "PARIS INFO 125.700 ·
	 *  PARIS CTL 128.275". Provenance text only; the working substitute is
	 *  whatever published row the resolution falls back to. */
	function substitutesText(c: NonNullable<EffectiveAirspaceRadio['closedBy']>): string {
		return c.substitutes.map((s) => `${s.label} ${formatFreqMHz(s.freq)}`).join(' · ');
	}
</script>

{#snippet closedNote(c: NonNullable<EffectiveAirspaceRadio['closedBy']>)}
	<span class="ovr-note">
		<NotamIdButton item={c.source} title={t.detail.freqClosedByTip} />
		{#if c.substitutes.length > 0}
			{t.detail.freqClosedContact(substitutesText(c))}
		{/if}
	</span>
{/snippet}

{#snippet ovrNote(o: RadioOverride)}
	<span class="ovr-note">
		<s>{o.was}</s>
		<NotamIdButton item={o.source} title={t.detail.freqChangedByTip} />
	</span>
{/snippet}

{#if radios.length > 0}
	{#if layout === 'table'}
		<table class="freqs">
			<tbody>
				{#each radios as r, i (r.unit + '|' + r.freq + '|' + i)}
					<tr class:overridden={!!r.override}>
						<td class="svc">{r.unit}</td>
						<td class="call">{r.call}</td>
						<td class="freq">
							{formatFreqMHz(r.freq)}
							{#if r.override}{@render ovrNote(r.override)}{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<ul class="radio">
			{#each radios as r, i (i)}
				<li
					class:overridden={!!r.override}
					class:closed-row={closedOf(r) != null}
					class:rai={i === raiIndex}
				>
					<span class="freq">{formatFreqMHz(r.freq)}</span>
					<span class="rl">
						<span class="rl-top">
							<span>{r.call || r.unit}</span>
							{#if i === raiIndex}
								<span class="rai-badge" title={t.detail.raiTip}>RAI</span>
							{/if}
						</span>
						{#if r.override}{@render ovrNote(r.override)}{/if}
						{#if closedOf(r)}{@render closedNote(closedOf(r)!)}{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
{/if}
{#if flags.length > 0}
	<p class="freq-flags-label">{t.detail.freqFlagsHeading}</p>
	<ul class="freq-flags">
		{#each flags as f (freqFlagKey(f))}
			<li>
				<NotamIdButton item={f.source} />
				<span class="flag-text">{flagText(f.info)}</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	/* Airport table: service label, call sign (muted, takes the slack),
	 * 3-decimal frequency right-aligned. */
	.freqs {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.freqs td {
		padding: 3px 4px;
		border-bottom: 1px solid var(--border);
	}

	.freqs .svc {
		font-weight: 600;
		white-space: nowrap;
	}

	.freqs .call {
		width: 100%;
		color: var(--text-muted);
	}

	.freqs .freq {
		text-align: right;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* A NOTAM-overridden row: the new frequency stands out, the prior value
	 * is struck through, and the source NOTAM is one click away. */
	.freqs tr.overridden .freq {
		font-weight: 700;
	}

	/* Airspace list: frequency first, the call sign / unit stacked beside. */
	.radio {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.radio li {
		display: flex;
		gap: 8px;
		padding: 2px 0;
	}

	.radio .freq {
		flex: 0 0 64px;
		font-family: ui-monospace, monospace;
		font-weight: 600;
	}

	.radio li.overridden .freq {
		font-weight: 700;
	}

	.rl {
		display: flex;
		flex-direction: column;
	}

	.rl-top {
		display: flex;
		gap: 6px;
		align-items: baseline;
	}

	/* The RAI (auto-info) frequency the chart cites: the one a pilot tunes
	 * for this airspace's activation status, and the only one the nav-log
	 * uses. */
	.rai-badge {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		padding: 0 5px;
		border-radius: var(--radius);
		background: var(--accent);
		color: var(--accent-text);
		white-space: nowrap;
	}

	/* A frequency a service-closure NOTAM withdrew: the published value stays
	   readable (the panel prints the record) but struck and muted, its note
	   naming the NOTAM and the designated substitutes. */
	.radio li.closed-row .freq {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.ovr-note {
		font-size: 11px;
		color: var(--text-muted);
	}

	.ovr-note s {
		margin-right: 4px;
	}

	.freqs .ovr-note {
		display: block;
		margin-top: 1px;
		font-weight: 400;
	}

	/* Detected frequency changes that aren't tied to a listed service row. */
	.freq-flags-label {
		margin: 8px 0 2px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.freq-flags {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 12px;
	}

	.freq-flags li {
		display: flex;
		gap: 6px;
		align-items: baseline;
	}

	.freq-flags .flag-text {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
</style>
