<script lang="ts">
	import { type Navaid } from '$lib/data/navaids';
	import { formatFreqMHz } from '$lib/format/radio';
	import { t } from '$lib/state/i18n.svelte';
	import { dedupeById } from '$lib/data/dedup';
	import { activeNotamsByNavaid, unserviceableNavaids } from '$lib/state/notamNavaidLinks.svelte';
	import CoordButton from './CoordButton.svelte';
	import Fields from './Fields.svelte';
	import NotamCardList from './NotamCardList.svelte';

	interface Props {
		navaid: Navaid;
	}
	const { navaid }: Props = $props();

	const typeLabel = $derived(t.data.navaidTypes[navaid.type] ?? navaid.type);

	// The publisher codes (FR / UK / ES) are invariant; the tooltips come
	// from t.detail.sourceTips.
	const sourceCode = $derived(
		navaid.source === 'fr' || navaid.source === 'uk' || navaid.source === 'es' || navaid.source === 'be' || navaid.source === 'de' || navaid.source === 'at'
			? navaid.source
			: '',
	);

	// True when an active NOTAM currently marks this navaid unserviceable.
	const unserviceable = $derived(unserviceableNavaids().has(navaid.id));

	// NDB carries a low/medium frequency in kHz; the VOR / ILS family carries
	// a VHF/UHF frequency in MHz, printed through the app's one frequency
	// formatter. TACAN / DME carry only a channel, shown in its own row below.
	const freqDisplay = $derived(
		navaid.freq
			? navaid.type === 'NDB'
				? `${navaid.freq} kHz`
				: `${formatFreqMHz(navaid.freq)} MHz`
			: '',
	);

	const matched = $derived(activeNotamsByNavaid().get(navaid.id) ?? []);
	// A source NOTAM split into multiple area-entries appears more than once
	// in `matched`. Dedup by id so the panel shows each source NOTAM once.
	const matchedNotams = $derived(dedupeById(matched));
</script>

<div class="navaid">
	{#if sourceCode || unserviceable}
		<div class="tags">
			{#if sourceCode}
				<span
					class="tag tag--source"
					title={t.detail.sourceTips[sourceCode]}
				>{sourceCode.toUpperCase()}</span>
			{/if}
			{#if unserviceable}
				<span
					class="tag tag--unserviceable"
					title={t.detail.unserviceableTip}
				>{t.detail.unserviceableTag}</span>
			{/if}
		</div>
	{/if}

	<Fields>
		<dt>{t.detail.type}</dt>
		<dd>{typeLabel}</dd>

		<dt>{t.detail.ident}</dt>
		<dd class="mono">{navaid.ident || '–'}</dd>

		{#if navaid.name}
			<dt>{t.detail.name}</dt>
			<dd>{navaid.name}</dd>
		{/if}

		{#if freqDisplay}
			<dt>{t.detail.frequency}</dt>
			<dd class="mono">{freqDisplay}</dd>
		{/if}

		{#if navaid.channel}
			<dt>{t.detail.channel}</dt>
			<dd class="mono">{navaid.channel}</dd>
		{/if}

		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={navaid.lat} lon={navaid.lon} />
		</dd>

		{#if navaid.elev != null}
			<dt>{t.detail.elevation}</dt>
			<dd>
				{navaid.elev.toLocaleString('en-US')} ft
				<abbr title={t.detail.amslTip}>AMSL</abbr>
				({Math.round(navaid.elev * 0.3048)} m)
			</dd>
		{/if}
	</Fields>

	{#if matchedNotams.length > 0}
		<section class="block">
			<h3>{t.detail.affectingNotamsNavaid} ({matchedNotams.length})</h3>
			<NotamCardList items={matchedNotams} grouped />
		</section>
	{/if}
</div>

<style>
	.navaid {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.mono {
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.tag {
		padding: 2px 7px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: #fff;
		border-radius: 999px;
	}

	.tag--source {
		background: #5a6275;
	}

	.tag--unserviceable {
		background: var(--danger);
	}

	abbr[title] {
		text-decoration: none;
		cursor: inherit;
	}

	.block h3 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}
</style>
