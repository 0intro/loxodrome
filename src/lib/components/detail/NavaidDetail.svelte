<script lang="ts">
	import { type Navaid } from '$lib/data/navaids';
	import { formatFreqMHz } from '$lib/format/radio';
	import { formatAipRemark } from '$lib/format/remark';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { display } from '$lib/state/display.svelte';
	import { airportByIdent } from '$lib/state/data.svelte';
	import { navigateToAirport } from '$lib/state/ui.svelte';
	import { dedupeById } from '$lib/data/dedup';
	import { activeNotamsByNavaid, unserviceableNavaids } from '$lib/state/notamNavaidLinks.svelte';
	import CoordButton from './CoordButton.svelte';
	import DirectToButton from './DirectToButton.svelte';
	import { hitToAnchor } from '$lib/state/waypointSearch.svelte';
	import { currentPose } from '$lib/state/navRecording.svelte';
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

	// The strip stands only with a position, the one thing it holds needing
	// one; a boolean, so a fix does not touch the sheet.
	const hasPose = $derived(currentPose() !== null);

	// A French reporting point's aerodrome, as the AIP states it (never the
	// ident-suffix guess the search uses), and its remark: the landmark, at
	// times an operating note.
	const aerodrome = $derived(navaid.ad ? airportByIdent(navaid.ad) : null);
	const lang = $derived(resolveLangPref(display.aipRemarkLang, i18n.locale));

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

	{#if hasPose}
		<!-- Direct-To: a pilot told "direct to the VOR" or "report over the
		     point" finds it in the search and flies there from this sheet. -->
		<div class="actions">
			<DirectToButton
				target={hitToAnchor({ kind: 'navaid', navaid })}
				label={t.detail.directTo(navaid.ident)}
				tip={t.detail.directToPointTip}
			/>
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

		{#if navaid.ad}
			<dt>{t.detail.vrpAerodrome}</dt>
			<dd>
				{#if aerodrome}
					<button type="button" class="link" onclick={() => navigateToAirport(aerodrome.ident)}>
						<span class="mono">{aerodrome.ident}</span>
						{aerodrome.name}
					</button>
				{:else}
					<span class="mono">{navaid.ad}</span>
				{/if}
			</dd>
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

	{#if navaid.rmk}
		<section class="block">
			<h3>{t.detail.remarks}</h3>
			<p class="block-text" lang={lang}>{formatAipRemark(navaid.rmk, lang)}</p>
		</section>
	{/if}

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

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
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

	/* --surface, not the tags' white: the night --danger is a light red. */
	.tag--unserviceable {
		color: var(--surface);
		background: var(--danger);
	}

	abbr[title] {
		text-decoration: none;
		cursor: inherit;
	}

	/* The aerodrome a reporting point belongs to, a link in the value cell. */
	.link {
		padding: 0;
		font: inherit;
		color: var(--accent);
		text-align: left;
		background: none;
		border: 0;
		cursor: pointer;
	}

	.link:hover {
		text-decoration: underline;
	}

	.link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* Remark body: '#'-normalised newlines rendered via pre-line, as the
	 * obstacle and airspace sheets render theirs. */
	.block-text {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		white-space: pre-line;
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
