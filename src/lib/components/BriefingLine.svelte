<script lang="ts">
	/* The NOTAM briefing's line: where it came from, and what it is short of
	 * for the planned flight (state/briefing.svelte.ts), worded once by
	 * ./briefingText.ts. The NOTAMs tab's head carries it in both views, the
	 * list and the fetch view, so an automatic fetch never hides it. It also
	 * says where the briefing leaves the period the map is read at. */
	import { autorouter } from '$lib/autorouter/state.svelte';
	import { formatZuluNear, formatZuluSpan } from '$lib/format/datetime';
	import { viewGaps } from '$lib/notam/briefingVerdict';
	import { sofia } from '$lib/sofia/state.svelte';
	import { briefingVerdictNow } from '$lib/state/briefing.svelte';
	import { retryDataNow } from '$lib/state/dataRetry.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { activeEvalWindow, notamState } from '$lib/state/notam.svelte';
	import { newListedCount } from '$lib/state/notamOrder.svelte';
	import { notamFetchBusy, notamSource } from '$lib/state/notamSource.svelte';
	import { runBriefing } from '$lib/state/briefingFetch';
	import { hasFlyableRoute } from '$lib/state/timeWindow.svelte';
	import { briefingLineReasons, briefingReasonText, briefingStamp, briefingSupaipList } from './briefingText';
	import Icon from './Icon.svelte';

	let {
		onShowFetch,
		inList = true,
	}: {
		/** Opens the fetch view, which names the routes a fetch lost and why. */
		onShowFetch?: (() => void) | undefined;
		/** Is the list up? The fetch view states a fetch's error under its own
		 *  button, so the line states it only over the list. */
		inList?: boolean;
	} = $props();


	const now = $derived.by(() => {
		void notamState.tick;
		return Date.now();
	});
	const verdict = $derived(briefingVerdictNow());
	const flyable = $derived(hasFlyableRoute());
	const short = $derived(verdict.plan && verdict.reasons.length > 0);
	const stamp = $derived(briefingStamp(verdict, notamState.lastFetch?.source ?? null, now));
	/* The SUP AIP list the zones and their activations come from. */
	const supList = $derived(briefingSupaipList());
	/* The reasons under the line (briefingLineReasons). */
	const reasons = $derived(
		briefingLineReasons(verdict).map((r) => ({ code: r.code, text: briefingReasonText(r, now, verdict.source) })),
	);
	/* The span the briefing covers, stated while the period the map is read
	 * at reaches outside it. */
	const briefed = $derived(notamState.lastFetch?.briefed ?? null);
	const gaps = $derived(briefed ? viewGaps(briefed, activeEvalWindow()) : { from: null, until: null });
	const busy = $derived(notamFetchBusy());
	const error = $derived(
		notamSource.source === 'sofia'
			? sofia.error
			: autorouter.lastKind === 'route'
				? autorouter.error
				: null,
	);
	const shown = $derived(verdict.plan || verdict.source !== 'none');
	/* What a refresh brought since the list last showed the briefing. */
	const fresh = $derived(newListedCount());

	/* The run the map notice's button starts, routes fetched: the picked
	 * source's route fetch for the planned flight, whatever period is
	 * typed, then the aerodromes the briefing owes by name. A gesture, so
	 * the datasets a briefing resolves against are asked again first. */
	function refresh(): void {
		if (busy) {
			return;
		}
		void retryDataNow();
		void runBriefing({ routes: true });
	}
</script>

{#if shown}
	<div class="briefing" class:short>
		<p class="b-line">
			<Icon name={short ? 'alert-triangle' : 'file-text'} size={13} />
			<span class="b-text">{stamp}</span>
			{#if flyable}
				<!-- Both labels share one cell, the idle one hidden while the
				     fetch runs, so the button keeps its width (Banner's form). -->
				<button class="btn b-act" aria-disabled={busy || undefined} onclick={refresh}>
					<span class="b-label" class:off={busy}>
						{verdict.source === 'none' ? t.briefing.fetch : t.briefing.refresh}
					</span>
					<span class="b-label" class:off={!busy}>{t.briefing.fetching}</span>
				</button>
			{/if}
		</p>
		{#if supList}
			<p class="b-sup">{supList}</p>
		{/if}
		{#if reasons.length > 0}
			<ul class="b-reasons">
				{#each reasons as r (r.code)}
					<li>
						{r.text}
						{#if r.code === 'failed' && onShowFetch && inList}
							<button class="b-link" onclick={onShowFetch}>{t.briefing.failedShow}</button>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		{#if fresh > 0 && notamState.seen}
			<p class="b-new">{t.briefing.newSince({ n: fresh, time: formatZuluNear(notamState.seen.at, now) })}</p>
		{/if}
		{#if inList && error}
			<p class="error" role="alert">{error()}</p>
		{/if}
	</div>
	{#if briefed && (gaps.from !== null || gaps.until !== null)}
		<p class="b-view" title={t.briefing.coversTip({ before: gaps.from !== null, after: gaps.until !== null })}>
			{t.briefing.covers(formatZuluSpan(briefed.from, briefed.to))}
		</p>
	{/if}
{/if}

<style>
	/* A notice, boxed by kind: plain while the briefing covers the flight,
	   the workbook amber, the app's text-weight caution, while it is short. */
	.briefing {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px 9px;
		font-size: 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
	}

	.briefing.short {
		color: var(--workbook-orange);
		background: color-mix(in srgb, var(--workbook-orange) 10%, transparent);
		border-color: color-mix(in srgb, var(--workbook-orange) 40%, transparent);
	}

	.b-line {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
		font-weight: 600;
	}

	.b-text {
		flex: 1 1 auto;
		min-width: 0;
	}

	.b-act {
		display: inline-grid;
		flex: 0 0 auto;
	}

	.b-label {
		grid-area: 1 / 1;
	}

	.b-label.off {
		visibility: hidden;
	}

	.b-reasons {
		margin: 0;
		padding: 0 0 0 19px;
		line-height: 1.45;
	}

	.b-link {
		padding: 0;
		font: inherit;
		color: inherit;
		text-decoration: underline;
		cursor: pointer;
		background: none;
		border: 0;
	}

	.b-new {
		margin: 0;
		color: var(--accent);
	}

	.b-sup {
		margin: 0;
		padding-left: 19px;
	}

	.b-view {
		margin: 4px 0 0;
		font-size: 12px;
		color: var(--text-muted);
	}

	.error {
		margin: 0;
	}
</style>
