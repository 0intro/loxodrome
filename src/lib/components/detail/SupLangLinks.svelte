<!-- Shared "FR · EN" affordance for a SUP AIP: links that open the supplement
     PDF in each language. Used identically by the NOTAM AipSupChips and the
     SupAipDetail panel so the language links stay homogeneous. A language is
     shown only when its URL exists (English is metropole-only); with neither,
     a muted "(no link)" hint stands in. -->
<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import { docLinkClick, storedDoc } from '$lib/state/aipDocOpen';
	import { offlineDocs } from '$lib/state/offlineDocs.svelte';

	interface Props {
		fr: string | null;
		en: string | null;
	}
	let { fr, en }: Props = $props();

	// The pack stores a supplement under its PDF's own file name, which is
	// how cmd/aipdocs names it too. Reading offlineDocs.gen is what makes the
	// marker appear the moment a download lands.
	const nameOf = (url: string | null): string | null => url?.split('/').pop() || null;
	const frStored = $derived(
		(offlineDocs.gen, storedDoc(nameOf(fr), true, 'fr')) !== null,
	);
	const enStored = $derived(
		(offlineDocs.gen, storedDoc(nameOf(en), true, 'en')) !== null,
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
				title={frStored ? t.detail.docOffline : t.detail.supPdfFrTip}
				onclick={(e) => docLinkClick(e, fr, nameOf(fr), true, 'fr')}
			>FR</a>
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
