<script lang="ts">
	import type { Notam, NotamSections } from '$lib/notam/types';
	import { t } from '$lib/state/i18n.svelte';
	import { extractAipSups, siaSupUrl, isFrenchNotam } from '$lib/notam/aipSup';

	interface Props {
		notam: Notam;
		sections: NotamSections;
	}
	let { notam, sections }: Props = $props();

	// AIP SUP references inside the E-section body, tokenised so the matching
	// substrings become clickable inline links. EN URL by default; the chip
	// list below (AipSupChips) offers FR/EN per reference. Skipped entirely
	// for non-French NOTAMs (the SIA URL only resolves for SIA-published SUPs).
	const eTokens = $derived.by(() => {
		const text = sections.E ?? '';
		if (!text || !isFrenchNotam(notam)) return [{ text }];
		const refs = extractAipSups(text);
		const out: { text: string; href?: string }[] = [];
		let cursor = 0;
		for (const r of refs) {
			const href = siaSupUrl(r, 'en');
			if (!href) continue; // IFR series stays as inline text.
			if (r.start > cursor) out.push({ text: text.slice(cursor, r.start) });
			out.push({ text: r.raw, href });
			cursor = r.end;
		}
		if (cursor < text.length) out.push({ text: text.slice(cursor) });
		return out;
	});
</script>

{#if sections.D}
	<section class="block">
		<h3>{t.notam.schedule}</h3>
		<!-- Raw NOTAM D) item: English/bilingual source data (docs/i18n.md rule 11). -->
		<p class="block-text" lang="en">{sections.D}</p>
	</section>
{/if}

{#if sections.E}
	<section class="block">
		<h3>{t.notam.description}</h3>
		<!-- Raw NOTAM E) body: English/bilingual source data (docs/i18n.md rule 11). -->
		<p class="block-text" lang="en">{#each eTokens as tok, i (i)}{#if tok.href}<a
					class="sup-link"
					href={tok.href}
					target="_blank"
					rel="noopener noreferrer"
					title={t.notam.supLinkTip}
				>{tok.text}</a>{:else}{tok.text}{/if}{/each}</p>
	</section>
{/if}

{#if sections.F || sections.G}
	<section class="block">
		<h3>{t.notam.verticalLimits}</h3>
		<p class="block-text" lang="en">{sections.F ?? '–'} – {sections.G ?? '–'}</p>
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

	.block-text {
		margin: 0;
		white-space: pre-wrap;
		line-height: 1.5;
	}

	/* Inline AIP SUP link inside the E-section text. Inherits the surrounding
	   font and wrapping; only colour + underline-on-hover distinguish it. */
	.sup-link {
		color: var(--accent);
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
	}

	.sup-link:hover {
		text-decoration-style: solid;
	}

	.sup-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
