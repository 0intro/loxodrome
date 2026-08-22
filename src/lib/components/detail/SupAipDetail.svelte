<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { SupAip, SupAipActivation, SupAipZone } from '$lib/data/supaip';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { formatVLimit } from '$lib/vertical/limits';
	import type { Notam } from '$lib/notam/types';
	import { sortNotamsBySubject } from '$lib/notam/qcode';
	import { mapState } from '$lib/state/map.svelte';
	import { focusSupBbox, hoverSupaipZone } from '$lib/map/supaipLayer';
	import { selectSupaip } from '$lib/state/ui.svelte';
	import { display } from '$lib/state/display.svelte';
	import { formatFreqMHz } from '$lib/format/radio';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import {
		activatedNotamsForSup,
		notamsReferencingSup,
		supZoneActivations,
		parseSupZoneKey,
		activatedZoneIndices,
	} from '$lib/state/supaipLinks.svelte';
	import { formatActivationSpan } from '$lib/format/datetime';
	import Fields from './Fields.svelte';
	import NotamCardList from './NotamCardList.svelte';
	import SupLangLinks from '$lib/components/detail/SupLangLinks.svelte';

	// Drop any transient hover highlight if the panel closes mid-hover (the
	// row's mouseleave may not fire on unmount).
	onDestroy(() => hoverSupaipZone(null));

	interface Props {
		supaip: SupAip;
		zoneIndex?: number | undefined;
	}
	const { supaip, zoneIndex }: Props = $props();

	// English text exists only for supplements with an _en.pdf; otherwise the
	// toggle is hidden and the French subject is shown.
	const hasEn = $derived(!!supaip.descriptionEn);
	const lang = $derived(hasEn ? resolveLangPref(display.supaipLang, i18n.locale) : 'fr');
	const description = $derived(
		lang === 'en' ? supaip.descriptionEn : supaip.descriptionFr || supaip.descriptionEn,
	);
	// The catalog record carries literal keys; the dataset region is an open
	// string, so the lookup widens at the read site and falls back to the code.
	const regionLabel = $derived(
		(t.detail.supRegions as Record<string, string>)[supaip.region] ?? supaip.region,
	);
	const selected = $derived(
		zoneIndex != null && zoneIndex >= 0 && zoneIndex < supaip.zones.length
			? zoneIndex
			: -1,
	);

	// NOTAM activation links (mirrors AirspaceDetail). "Activated by" lists the
	// activation NOTAMs lighting up any zone in the active eval window;
	// "Referenced by" lists other NOTAMs citing this supplement that are not
	// those activations.
	const activatedBy = $derived(
		sortNotamsBySubject(activatedNotamsForSup(supaip), (it) => it.notam.qCode),
	);
	const referencedBy = $derived(
		sortNotamsBySubject(notamsReferencingSup(supaip.number, supaip.year), (it) => it.notam.qCode),
	);

	// Zone indices currently activated by a NOTAM, for the per-zone ACTIVE badge.
	const activeZoneIdx = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive state
		const set = new Set<number>();
		for (const key of supZoneActivations().keys()) {
			const p = parseSupZoneKey(key);
			if (p && p.supId === supaip.id) {
				set.add(p.zoneIndex);
			}
		}
		return set;
	});

	// The zones an activation NOTAM brings into force, for its card caption.
	function matchedZoneNames(n: Notam): string {
		return activatedZoneIndices(n, supaip)
			.map((i) => supaip.zones[i]?.name || t.detail.zoneN(i + 1))
			.join(', ');
	}

	function vertical(z: SupAipZone): string {
		if (!z.vLower && !z.vUpper) {
			return '';
		}
		return `${formatVLimit(z.vLower) || '–'} – ${formatVLimit(z.vUpper) || '–'}`;
	}

	// Prose date with the catalog's abbreviated month names (docs/i18n.md);
	// read at call time from the template, so it follows the locale.
	function fmtDate(d: string): string {
		const [y, m, day] = d.split('-').map(Number);
		return y && m && day ? `${day} ${t.common.months[m - 1]} ${y}` : d;
	}

	// "11 Jun 2026, 12:00 - 18:00" / "16 Feb - 31 Jul 2026, 09:00 - 16:00" /
	// "16 Apr 2026 - 12 Apr 2028" (all-day / H24 has no times).
	function fmtActivation(a: SupAipActivation): string {
		const date = a.dateTo ? `${fmtDate(a.date)} - ${fmtDate(a.dateTo)}` : fmtDate(a.date);
		return a.from && a.to ? `${date}, ${a.from} - ${a.to}` : date;
	}

	function openZone(i: number): void {
		selectSupaip(supaip.id, i);
		if (mapState.map) {
			focusSupBbox(mapState.map, supaip.zones[i].bbox ?? supaip.bbox);
		}
	}
</script>

<div class="supaip">
	<div class="tags">
		<span class="tag tag--region">{regionLabel}</span>
		{#if supaip.airac}
			<span class="tag tag--airac" title={t.detail.airacSupTip}>AIRAC</span>
		{/if}
		{#if supaip.ifr}<span class="tag">IFR</span>{/if}
		{#if supaip.vfr}<span class="tag">VFR</span>{/if}
	</div>

	{#if description}
		<p class="desc" lang={lang}>{description}</p>
	{/if}

	<Fields>
		{#if supaip.validFrom || supaip.validTo}
			<dt>{t.detail.valid}</dt>
			<dd>{supaip.validFrom ?? '…'} → {supaip.validTo ?? '…'}</dd>
		{/if}
		{#if supaip.fir.length > 0}
			<dt>FIR</dt>
			<dd class="mono">{supaip.fir.join(', ')}</dd>
		{/if}
		{#if supaip.adhp.length > 0}
			<dt>{t.detail.aerodromes}</dt>
			<dd class="mono">{supaip.adhp.join(', ')}</dd>
		{/if}
	</Fields>

	{#if supaip.urlPdf || supaip.urlPdfEn}
		<div class="pdf-row">
			<span class="pdf-label">{t.detail.document}</span>
			<SupLangLinks fr={supaip.urlPdf || null} en={supaip.urlPdfEn || null} />
		</div>
	{/if}

	{#if supaip.contacts.length > 0 || supaip.penetration || supaip.manager}
		<section class="block">
			<h3>{t.detail.coordination}</h3>
			{#if supaip.penetration}
				<p class="pen">
					<span class="pen-tag pen--{supaip.penetration.kind}">
						{t.detail.supPenetration[supaip.penetration.kind]}
					</span>
					{#if supaip.penetration.text}<span>{supaip.penetration.text}</span>{/if}
				</p>
			{/if}
			{#if supaip.manager}
				<Fields>
					<dt>{t.detail.manager}</dt>
					<dd>{supaip.manager}</dd>
				</Fields>
			{/if}
			{#if supaip.contacts.length > 0}
				<p class="coord-sub" title={t.detail.realActivityTip}>
					{t.detail.realActivityKnownTo}
				</p>
				<table class="freqs">
					<tbody>
						{#each supaip.contacts as c, i (c.unit + '|' + i)}
							<tr>
								<td class="svc">{c.unit}</td>
								<td class="freq">
									{#if c.freqs.length > 0}
										{c.freqs.map(formatFreqMHz).join(' / ')}
									{:else if c.note}
										<span class="muted">{c.note}</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{/if}

	{#snippet activatedWindow(item: IndexedNotam)}
		<span class="notam-window" title={t.detail.activationWindowTip}>
			{formatActivationSpan(item.notam.startDate, item.notam.endDate)}
		</span>
	{/snippet}

	{#snippet activatedZones(item: IndexedNotam)}
		{@const zones = matchedZoneNames(item.notam)}
		{#if zones}<div class="notam-zones">{t.detail.zonesLine(zones)}</div>{/if}
	{/snippet}

	{#if activatedBy.length > 0}
		<section class="block">
			<h3>{t.detail.activatedBy} ({activatedBy.length})</h3>
			<NotamCardList
				items={activatedBy}
				active
				activeTip={t.detail.activatesSupNowTip}
				activeAccent="var(--supaip)"
				headExtra={activatedWindow}
				caption={activatedZones}
			/>
		</section>
	{/if}

	{#if referencedBy.length > 0}
		<section class="block">
			<h3>{t.detail.referencedBy} ({referencedBy.length})</h3>
			<NotamCardList items={referencedBy} />
		</section>
	{/if}

	{#if supaip.zones.length > 0}
		<section class="block">
			<h3>{t.detail.zones} ({supaip.zones.length})</h3>
			<ul class="zone-list">
				{#each supaip.zones as z, i (i)}
					<li class="zone" class:selected={i === selected}>
						<div class="zone-head">
							<button
								class="zone-name"
								onclick={() => openZone(i)}
								onmouseenter={() => hoverSupaipZone(z.geometry)}
								onmouseleave={() => hoverSupaipZone(null)}
							>
								{z.name || t.detail.zoneN(i + 1)}
							</button>
							{#if activeZoneIdx.has(i)}
								<span class="zone-active-tag" title={t.detail.zoneActiveNowTip}>ACTIVE</span>
							{/if}
						</div>
						<div class="zone-meta">
							{#if vertical(z)}<span>{vertical(z)}</span>{/if}
							{#if z.sameAs}
								<span class="muted">{t.detail.zoneSameAs(z.sameAs)}</span>
							{:else if z.geometry === null}
								<span class="muted">{t.detail.noArea}</span>
							{/if}
						</div>
						{#if z.activations.length > 0}
							<ul class="zone-acts">
								{#each z.activations as a, ai (ai)}
									<li title={t.detail.timesUtcTip}>{fmtActivation(a)}</li>
								{/each}
							</ul>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<p class="muted">{t.detail.noSupGeometry}</p>
	{/if}

	{#if supaip.warnings.length > 0}
		<p class="muted">{t.detail.parseNotes(supaip.warnings.join(', '))}</p>
	{/if}
</div>

<style>
	.supaip {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.desc {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
	}

	.mono {
		font-family: ui-monospace, "SF Mono", "Cascadia Code", consolas, monospace;
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
		background: #5a6275;
		border-radius: 999px;
	}

	.tag--region {
		background: var(--supaip);
	}

	.tag--airac {
		background: #7a0042;
	}

	.block h3 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.zone-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.zone {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface-2);
	}

	.zone.selected {
		border-color: var(--accent);
	}

	.zone-name {
		align-self: flex-start;
		padding: 0;
		font: inherit;
		font-weight: 600;
		text-align: left;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;

		/* Override the button default so the zone name can be selected/copied;
		 * a click still opens the zone, a drag selects the text. */
		user-select: text;
	}

	.zone-name:hover {
		text-decoration: underline;
	}

	.zone-name:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.zone-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.zone-acts {
		margin: 4px 0 0;
		padding: 0 0 0 14px;
		list-style: disc;
		font-size: 12px;
		color: var(--text);
	}

	.zone-acts li {
		font-variant-numeric: tabular-nums;
	}

	.pdf-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		font-size: 13px;
	}

	.pdf-label {
		color: var(--text-muted);
	}

	.pen {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		margin: 0 0 6px;
		font-size: 12px;
	}

	.pen-tag {
		padding: 2px 7px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		white-space: nowrap;
		color: #fff;
		background: #5a6275;
		border-radius: 999px;
	}

	/* circumvent / forbidden mean "stay out"; conditional / other keep neutral. */
	.pen--circumvent,
	.pen--forbidden {
		background: var(--danger, #c0392b);
	}

	.coord-sub {
		margin: 8px 0 4px;
		font-size: 11px;
		color: var(--text-muted);
	}

	.freqs {
		width: 100%;
		font-size: 12px;
		border-collapse: collapse;
	}

	.freqs td {
		padding: 3px 4px;
		vertical-align: top;
		border-bottom: 1px solid var(--border);
	}

	.freqs .svc {
		font-weight: 600;
		white-space: nowrap;
	}

	.freqs .freq {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.zone-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.zone-active-tag {
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: #fff;
		background: var(--supaip);
		border-radius: 999px;
	}

	.notam-window {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.notam-zones {
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
