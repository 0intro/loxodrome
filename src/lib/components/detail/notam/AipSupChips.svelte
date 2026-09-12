<script lang="ts">
	import type { Notam } from '$lib/notam/types';
	import { t } from '$lib/state/i18n.svelte';
	import {
		extractAipSupsFor,
		siaSupUrl,
		notamSupPublisher,
	} from '$lib/notam/aipSup';
	import { ensureSupaip, supaipByRef } from '$lib/state/data.svelte';
	import { navigateToSupaip } from '$lib/state/ui.svelte';
	import { focusSupBbox } from '$lib/map/supaipLayer';
	import { mapState } from '$lib/state/map.svelte';
	import SupLangLinks from '$lib/components/detail/SupLangLinks.svelte';
	import type { SupAip } from '$lib/data/supaip';

	interface Props {
		notam: Notam;
	}
	let { notam }: Props = $props();

	// Deduped chip list of every distinct AIP SUP referenced anywhere in the
	// NOTAM (not just E). Each chip pairs the id with FR + EN sublinks;
	// IFR-series chips render with a muted "(no link)" hint since the URL
	// convention isn't confirmed.
	// The publisher decides both the citation grammar (Spain cites bare,
	// "SUP 149/26") and which numbering namespace the lookup resolves in.
	const publisher = $derived(notamSupPublisher(notam));

	const supRefs = $derived.by(() => {
		if (!publisher) return [];
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const seen = new Set<string>();
		const out: {
			display: string;
			number: number;
			year: number;
			hrefFr: string | null;
			hrefEn: string | null;
			series: 'A' | 'IFR';
		}[] = [];
		for (const r of extractAipSupsFor(notam.fullContent, publisher)) {
			// One chip per SUPPLEMENT, however it is spelled: "AIP SUP 149/26"
			// and the bare "SUP 149/26" are the same reference.
			const key = `${r.series}:${r.number}/${r.year}`;
			if (seen.has(key)) continue;
			seen.add(key);
			// The SIA's file names are derivable, so an unmatched French
			// reference can still link. ENAIRE's are not (the AIRAC infix
			// and the inconsistent zero-padding are per file), so a
			// Spanish reference links only what the dataset carries.
			const guessable = publisher === 'fr';
			out.push({
				display: r.display,
				number: r.number,
				year: r.year,
				hrefFr: guessable ? siaSupUrl(r, 'fr') : null,
				hrefEn: guessable ? siaSupUrl(r, 'en') : null,
				series: r.series,
			});
		}
		return out;
	});

	// Load the SUP AIP dataset on demand so referenced supplements can be
	// enriched (title, validity, area) and opened on the map.
	$effect(() => {
		if (supRefs.length > 0) {
			void ensureSupaip().catch(() => {
				/* error surfaced via dataState.supaipError */
			});
		}
	});

	// Join each reference to the dataset (re-derives once it loads). PDF links
	// prefer the dataset's verified URLs (EN present only when an _en.pdf
	// exists); the guessed siaSupUrl pattern is the fallback for unmatched refs.
	const chips = $derived(
		supRefs.map((r) => {
			const sup =
				r.series === 'A' && publisher
					? supaipByRef(r.number, r.year, publisher)
					: null;
			return {
				...r,
				sup,
				pdfFr: sup?.urlPdf || r.hrefFr,
				pdfEn: sup ? sup.urlPdfEn || null : r.hrefEn,
			};
		}),
	);

	// The label on the local-language link: a supplement is published in
	// its State's own language, so the pair reads FR / EN in France and
	// ES / EN in Spain.
	const defaultLocalLabel = $derived(publisher === 'es' ? 'ES' : 'FR');

	function supLocalLabel(sup: SupAip): string {
		return sup.region === 'es' ? 'ES' : 'FR';
	}

	function openSup(sup: SupAip): void {
		navigateToSupaip(sup.id);
		if (mapState.map) {
			focusSupBbox(mapState.map, sup.bbox);
		}
	}
</script>

{#if chips.length > 0}
	<section class="block">
		<h3>{t.notam.referencedSups} ({chips.length})</h3>
		<ul class="sup-list">
			{#each chips as r (r.display)}
				<li class="sup-chip">
					<div class="sup-head">
						{#if r.sup}
							<button
								class="sup-id sup-id-btn"
								onclick={() => r.sup && openSup(r.sup)}
								title={t.notam.showSupAreaTip}
							>{r.display}</button>
						{:else}
							<span class="sup-id">{r.display}</span>
						{/if}
						<SupLangLinks
							fr={r.pdfFr}
							en={r.pdfEn}
							localLabel={r.sup ? supLocalLabel(r.sup) : defaultLocalLabel}
						/>
					</div>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.sup-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sup-chip {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px 6px;
		font-size: 12px;
	}

	.sup-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}

	.sup-id {
		flex: 0 0 auto;
		font-family: ui-monospace, monospace;
		font-weight: 700;
	}

	.sup-id-btn {
		padding: 0;
		font-family: ui-monospace, monospace;
		font-weight: 700;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
	}

	.sup-id-btn:hover {
		text-decoration: underline;
	}

	.sup-id-btn:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

</style>
