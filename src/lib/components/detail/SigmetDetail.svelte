<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { HAZARD_STYLES, fmtSigmetLevels, type Sigmet } from '$lib/weather/sigmet';
	import { formatActivationSpan } from '$lib/format/datetime';
	import { notamState } from '$lib/state/notam.svelte';

	interface Props {
		sigmet: Sigmet;
	}
	const { sigmet }: Props = $props();

	const style = $derived(HAZARD_STYLES[sigmet.hazard]);
	const validity = $derived(
		formatActivationSpan(new Date(sigmet.validFromMs), new Date(sigmet.validToMs)),
	);
	// Live state code, re-evaluated on the shared minute tick; the template
	// translates it so a locale switch re-renders the word.
	const state = $derived.by(() => {
		void notamState.tick;
		const now = Date.now();
		if (now < sigmet.validFromMs) {
			return 'upcoming';
		}
		return now <= sigmet.validToMs ? 'active' : 'expired';
	});
	const levels = $derived(fmtSigmetLevels(sigmet, t.weather.sigmet));
	// A stationary advisory (STNR / 0 kt) shows no movement line.
	const movement = $derived(
		sigmet.dirDeg != null && sigmet.spdKt != null && sigmet.spdKt > 0
			? t.detail.movingLine({
					dir: String(Math.round(sigmet.dirDeg)).padStart(3, '0'),
					kt: Math.round(sigmet.spdKt),
				})
			: null,
	);
</script>

<div class="sigmet">
	<div class="hazard-row">
		<span class="hazard-chip" style:background={style.color}>
			{sigmet.qualifier ? `${sigmet.qualifier} ` : ''}{sigmet.hazardRaw}
		</span>
		<span class="state" class:active={state === 'active'}>
			{state === 'active'
				? t.detail.sigmetActiveNow
				: state === 'upcoming'
					? t.detail.sigmetUpcoming
					: t.detail.sigmetExpired}
		</span>
	</div>

	<dl class="fields">
		<dt>{t.detail.hazard}</dt>
		<dd>{t.weather.hazards[sigmet.hazard]}{sigmet.qualifier ? `, ${sigmet.qualifier}` : ''}</dd>

		{#if sigmet.fir}
			<dt>FIR</dt>
			<dd>{sigmet.firName ?? sigmet.fir}</dd>
		{/if}

		<dt>{t.detail.valid}</dt>
		<dd class="mono">{validity}</dd>

		{#if levels}
			<dt>{t.detail.levels}</dt>
			<dd class="mono">{levels}</dd>
		{/if}

		{#if movement}
			<dt>{t.detail.moving}</dt>
			<dd class="mono">{movement}</dd>
		{/if}
	</dl>

	{#if sigmet.raw}
		<div class="raw-block">
			<div class="raw-label">{t.detail.rawBulletin}</div>
			<pre class="raw" lang="en">{sigmet.raw}</pre>
		</div>
	{/if}

	{#if !sigmet.ring}
		<p class="note">
			{t.detail.sigmetNoBoundary}
		</p>
	{/if}

	<p class="note">
		{t.detail.sigmetAttribution}
	</p>
</div>

<style>
	.sigmet {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.hazard-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.hazard-chip {
		padding: 2px 8px;
		font-size: 12px;
		font-weight: 700;
		letter-spacing: 0.03em;
		color: #fff;
		border-radius: 4px;
	}

	.state {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.state.active {
		color: var(--danger, #c0392b);
		font-weight: 600;
	}

	.fields {
		display: grid;
		grid-template-columns: max-content 1fr;
		column-gap: 12px;
		row-gap: 6px;
		margin: 0;
		font-size: 13px;
	}

	.fields dt {
		color: var(--text-muted);
		font-weight: 500;
	}

	.fields dd {
		margin: 0;
	}

	.mono {
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
	}

	.raw-block {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.raw-label {
		font-size: 11px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.raw {
		margin: 0;
		padding: 8px 10px;
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
		font-size: 12px;
		line-height: 1.45;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		background: var(--surface-2, rgb(0 0 0 / 4%));
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.note {
		margin: 0;
		font-size: 11px;
		line-height: 1.4;
		color: var(--text-muted);
	}
</style>
