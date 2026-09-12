<script lang="ts">
	import { type Obstacle } from '$lib/data/obstacles';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { dedupeById } from '$lib/data/dedup';
	import { activeNotamsByObstacle } from '$lib/state/notamObstacleLinks.svelte';
	import { formatAipRemark } from '$lib/format/remark';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { display } from '$lib/state/display.svelte';
	import CoordButton from './CoordButton.svelte';
	import Fields from './Fields.svelte';
	import NotamCardList from './NotamCardList.svelte';

	interface Props {
		obstacle: Obstacle;
	}
	const { obstacle }: Props = $props();

	const typeLabel = $derived(t.data.obstacleTypes[obstacle.type]);

	// AIP remark language: follows the UI locale unless pinned in the Display
	// tab. format/remark.ts splits the SIA "French\\English" bilingual form.
	const lang = $derived(resolveLangPref(display.aipRemarkLang, i18n.locale));

	// Cmd/uk and cmd/es namespace ids as `uk:<uuid>` / `es:<uuid>`.
	// Cmd/fr emits a bare SIA mid (numeric), so absence of a colon
	// prefix is the FR signal. Anything with an unknown prefix is
	// flagged empty so the badge stays off. The publisher codes (FR /
	// UK / ES) are invariant; the tooltips come from t.detail.sourceTips.
	const sourceCode = $derived.by(() => {
		const i = obstacle.id.indexOf(':');
		if (i <= 0) {
			return 'fr';
		}
		const code = obstacle.id.slice(0, i).toLowerCase();
		return code === 'uk' || code === 'es' || code === 'be' || code === 'de' || code === 'at' ? code : '';
	});

	const matched = $derived(
		activeNotamsByObstacle().get(obstacle.id) ?? [],
	);

	// A source NOTAM split into multiple area-entries (multi-coord NOTAMs)
	// appears more than once in `matched`. Dedup by id so the panel shows
	// each source NOTAM once, like AirportDetail does.
	const matchedNotams = $derived(dedupeById(matched));
</script>

<div class="obstacle">
	{#if sourceCode}
		<div class="tags">
			<span
				class="tag tag--source"
				title={(t.detail.sourceTips as Record<string, string>)[sourceCode]}
			>{sourceCode.toUpperCase()}</span>
		</div>
	{/if}

	<Fields>
		<dt>{t.detail.type}</dt>
		<dd>{typeLabel}</dd>

		<dt>{t.detail.name}</dt>
		<dd>{obstacle.name || '–'}</dd>

		<dt>{t.detail.position}</dt>
		<dd>
			<CoordButton lat={obstacle.lat} lon={obstacle.lon} />
		</dd>

		{#if obstacle.elev != null}
			<dt>{t.detail.elevation}</dt>
			<dd>
				{obstacle.elev.toLocaleString('en-US')} ft
				<abbr title={t.detail.amslTip}>AMSL</abbr>
				({Math.round(obstacle.elev * 0.3048)} m)
			</dd>
		{/if}

		{#if obstacle.hgt != null}
			<dt>{t.detail.height}</dt>
			<dd>
				{obstacle.hgt.toLocaleString('en-US')} ft
				<abbr title={t.detail.aglTip}>AGL</abbr>
				({Math.round(obstacle.hgt * 0.3048)} m)
			</dd>
		{/if}

		<dt>{t.detail.lighting}</dt>
		<dd>{obstacle.lit ? t.detail.lit : t.detail.unlit}</dd>

		{#if obstacle.group}
			<dt>{t.detail.group}</dt>
			<dd class="muted">{t.detail.groupNote}</dd>
		{/if}
	</Fields>

	{#if obstacle.rmk}
		<section class="block">
			<h3>{t.detail.remarks}</h3>
			<p class="block-text" lang={lang}>{formatAipRemark(obstacle.rmk, lang)}</p>
		</section>
	{/if}

	{#if matchedNotams.length > 0}
		<section class="block">
			<h3>{t.detail.affectingNotamsObstacle} ({matchedNotams.length})</h3>
			<NotamCardList items={matchedNotams} grouped />
		</section>
	{/if}
</div>

<style>
	.obstacle {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.muted {
		color: var(--text-muted);
		font-size: 11px;
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

	/* Source chip: neutral grey for all publishers so the badge marks
	 * provenance without playing flag colours. */
	.tag--source {
		background: #5a6275;
	}

	/* AMSL / AGL: title attribute still produces a tooltip on hover,
	 * but no visual cue (no dotted underline, no help cursor). Firefox
	 * applies a dotted underline by default; reset it explicitly. */
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

	/* Remark body: '#'-normalised newlines rendered via pre-line, same as
	 * AirspaceDetail's remark block. */
	.block-text {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		white-space: pre-line;
	}
</style>
