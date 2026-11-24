<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		activationTimes,
		excludedDesignator,
		supaipPublisherOf,
		supaipSubject,
		supaipSubjectLang,
		supZoneSun,
		zoneSchedule,
		type SupAip,
		type SupAipContact,
		type SupAipExcluded,
		type SupAipExclusion,
		type SupAipZone,
	} from '$lib/data/supaip';
	import { airspacesByIds } from '$lib/state/data.svelte';
	import { useAirspaceHover } from '$lib/components/featureHover.svelte';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import { formatVLimit, type VLimit } from '$lib/vertical/limits';
	import type { Notam } from '$lib/notam/types';
	import { sortNotamsBySubject } from '$lib/notam/qcode';
	import { mapState } from '$lib/state/map.svelte';
	import { focusSupBbox, hoverSupaipZone } from '$lib/map/supaipLayer';
	import { navigateToAirspace, selectSupaip } from '$lib/state/ui.svelte';
	import { display } from '$lib/state/display.svelte';
	import { formatFreqMHz } from '$lib/format/radio';
	import type { IndexedNotam } from '$lib/state/notam.svelte';
	import type { SupAipPhoneRole } from '$lib/data/supaip';
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
	import ZoneStatus from './ZoneStatus.svelte';
	import ContactTable, { type ContactRow } from './ContactTable.svelte';
	import { supZone } from '$lib/state/activity.svelte';
	import { rulePeriods, type ActivityRule } from '$lib/data/activity';
	import { zoneStanding } from '$lib/nav/alertVolumes';
	import { drawnStateAt } from '$lib/state/notam.svelte';
	import { activationText, standingText } from '$lib/components/supScheduleText';
	import SupLangLinks from '$lib/components/detail/SupLangLinks.svelte';

	// The penetration rule arrives one STATEMENT per line, and cmd/supaip opens
	// each exception it spares on the supplement's own bullet (reflowRule); such
	// a line hangs its wraps under its text rather than under the marker. The
	// class mirrors cmd/supaip's ruleBullets, the symbol-font bullets it maps
	// (puaGlyphs) included. A blank line separates two sections, or two zones'
	// paragraphs, and is drawn as a gap.
	const RULE_ITEM = /^[-\u2013\u2014\u2022\u25c6\u2666\u2212\u2713\u27a2\u25a1*]\s/;

	// Drop any transient hover highlight if the panel closes mid-hover (the
	// row's mouseleave may not fire on unmount).
	onDestroy(() => hoverSupaipZone(null));

	interface Props {
		supaip: SupAip;
		zoneIndex?: number | undefined;
	}
	const { supaip, zoneIndex }: Props = $props();

	// A supplement is published in its own State's language, so the
	// "local" pole of the language preference is French in France and
	// Spanish in Spain; the lang attribute has to say which, or a
	// screen reader reads Spanish with French phonemes.
	const localLang = $derived(supaip.region === 'es' ? 'es' : 'fr');
	const pref = $derived(supaipSubjectLang(supaip, display.supaipLang, i18n.locale));
	const lang = $derived(pref === 'en' ? 'en' : localLang);
	const description = $derived(supaipSubject(supaip, display.supaipLang, i18n.locale));
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
	// The state the head says: the selected zone's, else the first's, named
	// where the supplement holds several.
	const statusIdx = $derived(selected >= 0 ? selected : 0);
	const statusZone = $derived(supZone(supaip, statusIdx));
	// The units a real-activity table names, and those the users' information
	// section lists bare, each under the supplement's own heading for it.
	const knownContacts = $derived(supaip.contacts.filter((c) => !c.users));
	const userContacts = $derived(supaip.contacts.filter((c) => c.users));
	// Its telephone numbers by whom they reach, in the order a flight needs
	// them: who knows the activity, before it, during it, the manager, the
	// other contacts.
	const phoneGroups = $derived.by(() => {
		const heads: Record<SupAipPhoneRole, string> = {
			known: t.detail.realActivityKnownTo,
			before: t.detail.phonesBefore,
			during: t.detail.phonesDuring,
			manager: t.detail.manager,
			contact: t.detail.phonesContact,
		};
		const order: SupAipPhoneRole[] = ['known', 'before', 'during', 'manager', 'contact'];
		return order.flatMap((role) => {
			const rows: ContactRow[] = supaip.phones
				.filter((p) => p.role === role)
				.map((p) => ({ label: p.label, freq: '', phones: p.numbers, note: '' }));
			return rows.length > 0 ? [{ role, head: heads[role], rows }] : [];
		});
	});
	const contactRows = (list: SupAipContact[]): ContactRow[] =>
		list.map((c) => ({ label: c.unit, freq: c.freqs.map(formatFreqMHz).join(' / '), phones: [], note: c.note ?? '' }));

	// NOTAM activation links (mirrors AirspaceDetail). "Activated by" lists the
	// activation NOTAMs lighting up any zone in the active eval window;
	// "Referenced by" lists other NOTAMs citing this supplement that are not
	// those activations.
	const activatedBy = $derived(
		sortNotamsBySubject(activatedNotamsForSup(supaip), (it) => it.notam.qCode),
	);
	// A supplement of a publisher whose NOTAMs cite no supplement series
	// this app reads (Belgium's, the overseas SIA regions') is referenced
	// by nothing: falling back to the French namespace would list French
	// NOTAMs citing the same number, another publisher's supplement.
	const referencedBy = $derived.by(() => {
		const pub = supaipPublisherOf(supaip);
		if (pub === null) {
			return [];
		}
		return sortNotamsBySubject(
			notamsReferencingSup(supaip.number, supaip.year, pub),
			(it) => it.notam.qCode,
		);
	});

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

	function band(lower: VLimit | null, upper: VLimit | null): string {
		if (!lower && !upper) {
			return '';
		}
		return `${formatVLimit(lower) || '–'} – ${formatVLimit(upper) || '–'}`;
	}

	function vertical(z: SupAipZone): string {
		return band(z.vLower, z.vUpper);
	}

	// "Except CONDOM Valence sur Baïse: SFC – 1500 ft ASFC", the sector's
	// hours after its band ("Except Séderon: SFC – 1500 ft ASFC, SR - SS").
	function exclusionText(e: SupAipExclusion): string {
		const words = { earliest: t.detail.supTimeEarliest, latest: t.detail.supTimeLatest };
		const hours = e.hours.map((h) => activationTimes({ date: '', ...h }, words));
		return t.detail.zoneExcept(e.name, [band(e.vLower, e.vUpper), ...hours].filter(Boolean).join(', '));
	}

	// The airspaces the zones' lateral limits take out of them, by
	// condition: "Except LF-P 77", "Except LF-R 15 A, LF-R 15 B while
	// active", each a link to its airspace or zone.
	const excludedRows = $derived(
		airspacesByIds(supaip.zones.flatMap((z) => z.excluded.flatMap((e) => (e.id ? [e.id] : [])))),
	);
	const excludedHover = useAirspaceHover(() => excludedRows);

	interface ExcludedItem {
		text: string;
		key?: string | undefined;
		zone?: number | undefined;
	}

	function excludedItem(e: SupAipExcluded): ExcludedItem {
		if (e.zone) {
			const i = supaip.zones.findIndex((z) => z.name === e.zone);
			return { text: e.zone, zone: i >= 0 ? i : undefined };
		}
		const id = e.id ?? '';
		const row = excludedRows.find((a) => a.id === id) ?? null;
		return { text: excludedDesignator(id, row), key: row?.key };
	}

	function excludedGroups(z: SupAipZone): { whileActive: boolean; items: ExcludedItem[] }[] {
		return [false, true]
			.map((whileActive) => ({
				whileActive,
				items: z.excluded.filter((e) => e.whenActive === whileActive).map(excludedItem),
			}))
			.filter((g) => g.items.length > 0);
	}

	// Prose date with the catalog's abbreviated month names (docs/i18n.md);
	// read at call time from the template, so it follows the locale.
	// Does a line's period reach the time the map shows?
	const viewed = $derived(drawnStateAt());
	function inForce(r: ActivityRule, z: SupAipZone): boolean {
		return rulePeriods(r, viewed.fromMs, viewed.toMs, supZoneSun(supaip, z), 1).length > 0;
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

	{#if statusZone}
		<div class="status">
			{#if supaip.zones.length > 1}
				<span class="status-zone">{supaip.zones[statusIdx].name || t.detail.zoneN(statusIdx + 1)}</span>
			{/if}
			<ZoneStatus volume={statusZone} />
		</div>
	{/if}

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
			<SupLangLinks
				fr={supaip.urlPdf || null}
				en={supaip.urlPdfEn || null}
				localLabel={localLang.toUpperCase()}
			/>
		</div>
	{/if}

	{#if supaip.contacts.length > 0 || supaip.penetration || supaip.manager || supaip.phones.length > 0}
		<section class="block">
			<h3>{t.detail.coordination}</h3>
			{#if supaip.penetration}
				<p class="pen">
					<span class="pen-tag pen--{supaip.penetration.kind}">
						{t.detail.supPenetration[supaip.penetration.kind]}
					</span>
				</p>
				{#if supaip.penetration.refused}
					<p class="pen-refused">{t.detail.supPenetrationRefused}</p>
				{:else if supaip.penetration.text}
					<div class="pen-rule" lang={localLang}>
						{#each supaip.penetration.text.split('\n') as line, i (i)}
							<p class:item={RULE_ITEM.test(line)} class:gap={line === ''}>{line}</p>
						{/each}
					</div>
				{/if}
			{/if}
			{#if supaip.manager}
				<Fields>
					<dt>{t.detail.manager}</dt>
					<dd>{supaip.manager}</dd>
				</Fields>
			{/if}
			{#if knownContacts.length > 0}
				<p class="coord-sub" title={t.detail.realActivityTip}>{t.detail.realActivityKnownTo}</p>
				<ContactTable rows={contactRows(knownContacts)} />
			{/if}
			{#if userContacts.length > 0}
				<p class="coord-sub" title={t.detail.userInformationTip}>{t.detail.userInformation}</p>
				<ContactTable rows={contactRows(userContacts)} />
			{/if}
			{#each phoneGroups as g (g.role)}
				<p class="coord-sub" title={t.detail.phonesTip}>{g.head}</p>
				<ContactTable rows={g.rows} />
			{/each}
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
				activeTip={t.detail.activatesSupInPeriodTip}
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
					{@const schedule = zoneSchedule(supaip, z)}
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
								<span class="zone-active-tag" title={t.detail.zoneActiveInPeriodTip}>ACTIVE</span>
							{/if}
						</div>
						<div class="zone-meta">
							{#if vertical(z)}<span>{vertical(z)}</span>{/if}
							{#if z.sameAs}
								<span class="muted">{t.detail.zoneSameAs(z.sameAs)}</span>
							{:else if z.geometry === null}
								<span class="muted">{t.detail.noArea}</span>
							{/if}
							{#each z.exclusions as e, ei (ei)}
								<span>{exclusionText(e)}</span>
							{/each}
							{#each excludedGroups(z) as g (g.whileActive)}
								<span>
									{t.detail.zoneExceptLead}
									{#each g.items as it, ii (ii)}
										{#if it.key}
											{@const key = it.key}
											<button
												class="zone-link"
												onclick={() => navigateToAirspace(key)}
												onmouseenter={() => excludedHover.set(key)}
												onmouseleave={() => excludedHover.set(null)}>{it.text}</button
											>{:else if it.zone !== undefined}
											{@const zi = it.zone}
											<button
												class="zone-link"
												onclick={() => openZone(zi)}
												onmouseenter={() => hoverSupaipZone(supaip.zones[zi].geometry)}
												onmouseleave={() => hoverSupaipZone(null)}>{it.text}</button
											>{:else}{it.text}{/if}{ii < g.items.length - 1 ? ', ' : ''}
									{/each}
									{g.whileActive ? t.detail.zoneExceptWhileActive(g.items.length) : ''}
								</span>
							{/each}
						</div>
						{#if (schedule && schedule.length > 0) || z.standing.length > 0}
							{@const standing = zoneStanding(supaip, z)}
							<ul class="zone-acts">
								{#each schedule ?? [] as a, ai (ai)}
									{@const now = inForce({ ...a, mode: a.mode ?? 'firm' }, z)}
									<li class:now title={now ? t.detail.supLineInForceTip : t.detail.timesUtcTip}>{activationText(a)}</li>
								{/each}
								{#each z.standing as s, si (si)}
									{@const now = standing[si] ? inForce(standing[si], z) : false}
									<li class:now title={now ? t.detail.supLineInForceTip : t.detail.timesUtcTip}>{standingText(s)}</li>
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

	.status-zone {
		font-size: var(--fs-xs);
		font-weight: 600;
		color: var(--text-muted);
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

	.zone-link {
		padding: 0;
		font: inherit;
		color: var(--accent);
		background: transparent;
		border: none;
		cursor: pointer;
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

	.zone-acts li.now {
		font-weight: 600;
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

	/* The rule as the supplement prints it: the head, then one line per
	   exception. */
	.pen-rule {
		margin: 0 0 8px;
	}

	.pen-rule p {
		margin: 0 0 2px;
		font-size: 12px;
	}

	.pen-rule p.item {
		padding-left: 1em;
		text-indent: -1em;
	}

	.pen-rule p.gap {
		height: 0.5em;
	}

	.pen-refused {
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--text-muted);
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

	/* circumvent / forbidden mean "stay out"; conditional / other keep neutral.
	   Labelled with --surface, not the tags' white: the night --danger is a
	   light red. */
	.pen--circumvent,
	.pen--forbidden {
		color: var(--surface);
		background: var(--danger, #c0392b);
	}

	.coord-sub {
		margin: 8px 0 4px;
		font-size: 11px;
		color: var(--text-muted);
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
