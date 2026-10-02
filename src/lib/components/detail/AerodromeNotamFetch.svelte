<script lang="ts">
	/* The airport panel's own NOTAM fetch: the NOTAMs FILED UNDER this
	 * aerodrome (Item A), asked of the source the SOFIA / autorouter picker
	 * names and put into the loaded briefing in place of what the answer
	 * speaks for (state/aerodromeNotams.ts, notam/splice.ts).
	 *
	 * Renders two siblings into the panel's NOTAM head row: the button, then
	 * the status on a line of its own. The status also carries what the
	 * panel used to get wrong: with no briefing loaded, or none holding
	 * anything under this ident, "no NOTAMs" was an all-clear the app cannot
	 * give; and NOTAMs the briefing holds but the panel does not show (a
	 * filter, the region the briefing was fetched for) are counted, not
	 * silently missing. */
	import { notamSourceName } from '$lib/format/aerodromeFetch';
	import { formatZuluNear, formatZuluSpan } from '$lib/format/datetime';
	import { aerodromeRefresh } from '$lib/state/aerodromeRefresh.svelte';
	import {
		aerodromeFetchable,
		refreshAerodromeNotams,
		stopAerodromeRefresh,
	} from '$lib/state/aerodromeNotams';
	import { retryDataNow } from '$lib/state/dataRetry.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { briefingLoaded, filedUnderCounts, notamState } from '$lib/state/notam.svelte';
	import { notamFetchBusy, notamSource } from '$lib/state/notamSource.svelte';

	interface Props {
		ident: string;
		/** The NOTAMs filed under the ident the panel lists, after the filters. */
		shown: number;
	}

	let { ident, shown }: Props = $props();

	const id = $derived(ident.trim().toUpperCase());
	const fetchable = $derived(aerodromeFetchable(id));
	const record = $derived(notamState.aerodromeFetches[id] ?? null);
	const running = $derived(aerodromeRefresh.fetching === id);
	// Another fetch, from this panel's sibling or from a NOTAMs tab button.
	const elsewhere = $derived(notamFetchBusy() && !running);
	const counts = $derived(filedUnderCounts(id));
	const hidden = $derived(Math.max(0, counts.held - counts.outOfScope - shown));
	const loaded = $derived(briefingLoaded());
	const error = $derived(aerodromeRefresh.errorIdent === id ? aerodromeRefresh.error : null);
	const errorDetail = $derived(
		aerodromeRefresh.errorIdent === id ? aerodromeRefresh.errorDetail : null,
	);
	const sourceName = $derived(notamSourceName(notamSource.source));
	// The minute tick keeps "15:10Z" honest across midnight, when today's
	// time turns into another day's and is written in full.
	const nowMs = $derived.by(() => {
		void notamState.tick;
		return Date.now();
	});

	function onClick(): void {
		if (running) {
			stopAerodromeRefresh();
			return;
		}
		// A gesture: a dataset read waiting for its retry is asked now, and
		// the fetch's own ensures join it.
		void retryDataNow();
		void refreshAerodromeNotams(id);
	}
</script>

{#if fetchable}
	<button
		type="button"
		class="btn fetch"
		disabled={elsewhere}
		title={running
			? t.detail.adNotamsStopTip
			: elsewhere
				? t.detail.adNotamsBusyTip
				: t.detail.adNotamsTip({ ident: id, source: sourceName })}
		onclick={onClick}
	>
		{running
			? t.route.stopFetch
			: record || counts.held > 0
				? t.detail.adNotamsRefresh
				: t.detail.adNotamsGet}
	</button>
{/if}
<div class="fetch-status" aria-live="polite">
	{#if error}
		<p class="fail" role="alert" title={errorDetail ?? undefined}>
			{error()}
			{t.detail.adNotamsUnchanged}
		</p>
	{/if}
	{#if running}
		<p>{t.detail.adNotamsFetching({ ident: id, source: sourceName })}</p>
	{:else if record}
		<p>
			{t.detail.adNotamsFetched({
				n: record.count,
				ident: id,
				source: notamSourceName(record.source),
				time: formatZuluNear(record.at, nowMs),
			})}
		</p>
		<p>{t.detail.adNotamsCovering(formatZuluSpan(record.briefed.from, record.briefed.to))}</p>
		{#if record.withdrawn.length > 0}
			<p title={t.detail.adNotamsWithdrawnTip(record.withdrawn.join(', '))}>
				{t.detail.adNotamsWithdrawn(record.withdrawn.length)}
			</p>
		{/if}
		{#if record.unconfirmed.length > 0}
			<p class="caution" title={t.detail.adNotamsUnconfirmedTip(record.unconfirmed.join(', '))}>
				{t.detail.adNotamsUnconfirmed({
					n: record.unconfirmed.length,
					source: notamSourceName(record.source),
				})}
			</p>
		{/if}
		{#if record.kept.length > 0}
			<p title={t.detail.adNotamsKeptTip(record.kept.join(', '))}>
				{t.detail.adNotamsKept(record.kept.length)}
			</p>
		{/if}
	{:else if !loaded}
		<p>{t.detail.noBriefingLoaded}</p>
	{:else if counts.held === 0}
		<p>{t.detail.noneFiledUnder(id)}</p>
	{/if}
	{#if hidden > 0}
		<p>{t.filter.hiddenByFilters(hidden)}</p>
	{/if}
	{#if counts.outOfScope > 0}
		<p>{t.filter.outsideFetch(counts.outOfScope)}</p>
	{/if}
</div>

<style>
	/* In the panel's head row, beside the section title; the touch-ui floor
	   (app.css) still lifts it to 44 px where a finger needs it. */
	.fetch {
		flex: none;
		padding: 1px 10px;
		font-size: var(--fs-sm);
	}

	/* The status takes a line of its own under the head. Empty, it is a
	   zero-height line that still announces what lands in it. */
	.fetch-status {
		flex: 1 0 100%;
	}

	.fetch-status p {
		margin: 3px 0 0;
		font-size: var(--fs-xs);
		line-height: 1.4;
		color: var(--text-muted);
	}

	.fetch-status .fail {
		color: var(--danger);
	}

	.fetch-status .caution {
		color: var(--workbook-orange);
	}
</style>
