<!-- Shared "FR · EN" affordance for a SUP AIP: links that open the supplement
     in each language. Used identically by the NOTAM AipSupChips and the
     SupAipDetail panel so the language links stay homogeneous. A language is
     shown only when its URL exists (English is metropole-only in France);
     with neither, a muted "(no link)" hint stands in.

     The first link is the supplement's OWN language, which is the
     publishing State's: FR in France, ES in Spain. The label is a bare
     language code, locale-invariant like the rest of the ICAO
     vocabulary, so it takes no catalog entry. Offline packs exist for
     the French supplements only, so the stored-copy marker follows the
     same flag rather than the URL. -->
<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { docLinkClick, storedDoc } from '$lib/state/aipDocOpen';
	import { offlineDocs } from '$lib/state/offlineDocs.svelte';

	interface Props {
		fr: string | null;
		en: string | null;
		/** Language code for the local-language link (default 'FR'). */
		localLabel?: string;
	}
	let { fr, en, localLabel = 'FR' }: Props = $props();

	// Only the French supplements ship as offline document packs.
	const packed = $derived(localLabel === 'FR');

	// The pack stores a supplement under its PDF's own file name, which is
	// how cmd/aipdocs names it too. Reading offlineDocs.gen is what makes the
	// marker appear the moment a download lands.
	const nameOf = (url: string | null): string | null => url?.split('/').pop() || null;
	const frStored = $derived(
		packed && (offlineDocs.gen, storedDoc(nameOf(fr), true, 'fr')) !== null,
	);
	const enStored = $derived(
		packed && (offlineDocs.gen, storedDoc(nameOf(en), true, 'en')) !== null,
	);
</script>

{#if fr || en}
	<span class="sup-langs">
		{#if fr}
			<a
				class="ext"
				class:stored={frStored}
				href={fr}
				target="_blank"
				rel="noopener noreferrer"
				title={frStored ? t.detail.docOffline : t.detail.supPdfLocalTip}
				onclick={(e) => docLinkClick(e, fr, packed ? nameOf(fr) : null, true, 'fr')}
			>{localLabel}</a>
		{/if}
		{#if fr && en}<span class="sup-sep">·</span>{/if}
		{#if en}
			<a
				class="ext"
				class:stored={enStored}
				href={en}
				target="_blank"
				rel="noopener noreferrer"
				title={enStored ? t.detail.docOffline : t.detail.supPdfEnTip}
				onclick={(e) => docLinkClick(e, en, nameOf(en), true, 'en')}
			>EN</a>
		{/if}
	</span>
{:else}
	<span class="sup-nolink" title={t.detail.noLinkTip}>{t.detail.noLink}</span>
{/if}

<style>
	.sup-langs {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
	}

	.sup-sep {
		color: var(--text-muted);
	}

	.sup-nolink {
		color: var(--text-muted);
		font-size: 11px;
	}

	/* External-link colour (mirrors AirportDetail.svelte::.ext). */
	.ext {
		color: var(--accent);
		text-decoration: none;
	}

	.ext:hover {
		text-decoration: underline;
	}

	/* A stored copy: the same link, marked so the pilot knows it will open
	   with no network. A dot rather than a word, the affordance being two
	   letters wide. */
	.stored::after {
		content: '';
		display: inline-block;
		width: 4px;
		height: 4px;
		margin-left: 3px;
		vertical-align: super;
		border-radius: 50%;
		background: var(--accent);
	}

	.ext:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
