<script lang="ts">
	import type { Airspace } from '$lib/data/airspaces';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import {
		airspacesOver,
		compareAirspaceByBand,
		firIdent,
		isFirLike,
		raiRadioIndex,
	} from '$lib/data/airspaces';
	import { formatVLimit } from '$lib/vertical/limits';
	import { dedupeById } from '$lib/data/dedup';
	import {
		notamsForAirspace,
		geometricNotamsForAirspace,
		activatedAirspaceLinks,
		activatedAirspaceIds,
		notamNamesAirspace,
	} from '$lib/state/notamLinks.svelte';
	import { getAirspaces } from '$lib/state/data.svelte';
	import { display } from '$lib/state/display.svelte';
	import { rtbaZoneActivations } from '$lib/notam/rtba';
	import { groupNotamsBySubject, sortNotamsBySubject } from '$lib/notam/qcode';
	import { formatActivationWindow } from '$lib/format/datetime';
	import { formatAipRemark } from '$lib/format/remark';
	import { routeSettings } from '$lib/state/route.svelte';
	import type { EntryCondition } from '$lib/data/airspaceEntry';
	import { resolveLangPref } from '$lib/i18n/locale';
	import { resolveAirspaceRadios } from '$lib/state/freqOverride.svelte';
	import { firNotamIndex, type IndexedNotam } from '$lib/state/notam.svelte';
	import AltitudeProfile from './AltitudeProfile.svelte';
	import Fields from './Fields.svelte';
	import FrequencyList from './FrequencyList.svelte';
	import NotamCardList from './NotamCardList.svelte';
	import NotamGroup from './NotamGroup.svelte';

	interface Props {
		airspace: Airspace;
	}

	let { airspace }: Props = $props();

	// Language for the AIP free-text remarks (working hours + general): follows
	// the UI locale unless pinned in the Display tab. format/remark.ts splits
	// the SIA "French\\English" bilingual form and normalises '#' line breaks.
	const lang = $derived(resolveLangPref(display.aipRemarkLang, i18n.locale));

	// The entry condition the app APPLIED for this flight, above the published
	// text it came from: an alert is only as trustworthy as the clause behind
	// it, and AIP France states the conditions per traffic category, so the
	// panel shows the one for the route's flight rules (docs/nav-alerts.md).
	// Nothing shows when the parse fell back to reading the whole remark, so a
	// fallback never masquerades as a published clause.
	const entryCond = $derived(routeSettings.vfr ? airspace.entry.vfr : airspace.entry.ifr);
	const entryWord = $derived.by(() => {
		const words: Record<EntryCondition, string> = {
			forbidden: t.detail.entryForbidden,
			clearance: t.detail.entryClearance,
			radio: t.detail.entryRadio,
			'radio-ats': t.detail.entryRadioAts,
		};
		return entryCond ? words[entryCond] : null;
	});

	// Radio rows with any active frequency-change NOTAM (a by-name SIV change)
	// overlaid: the matched row carries the NOTAM'd value + provenance, anything
	// unmatched / ambiguous comes back as a flag.
	const resolvedRadio = $derived(resolveAirspaceRadios(airspace));
	const radio = $derived(resolvedRadio.radios);
	const freqFlags = $derived(resolvedRadio.flags);

	// The RAI (auto-info) frequency the VAC cites for a military / activable
	// airspace, flagged in the otherwise-full list. The nav-log and the
	// radio/airspace schedule show only this one; here every linked frequency
	// stays visible. null when the remark cites no RAI; the index is into the
	// full list and stays valid after a frequency-change override.
	const raiIdx = $derived(raiRadioIndex(airspace));

	// Vertical stack at the airspace's centre, so the profile shows it in
	// context of its neighbours with itself highlighted. Sampled from the
	// full dataset (reactive via getAirspaces) so toggled-off categories
	// don't blank it. The selected airspace is forced in even when the
	// bbox centre falls outside its ring (concave / ring-with-hole shapes).
	const stack = $derived.by(() => {
		const all = getAirspaces();
		if (!all) return [airspace];
		const b = airspace.bbox;
		const over = airspacesOver(
			all,
			(b.minLat + b.maxLat) / 2,
			(b.minLon + b.maxLon) / 2,
		);
		if (over.some((a) => a.key === airspace.key)) {
			return over;
		}
		return [airspace, ...over].sort(compareAirspaceByBand);
	});

	// The bbox centre, reused as the ground-elevation point for the profile.
	const centLat = $derived((airspace.bbox.minLat + airspace.bbox.maxLat) / 2);
	const centLon = $derived((airspace.bbox.minLon + airspace.bbox.maxLon) / 2);

	const upper = $derived(formatVLimit(airspace.vUpper));
	const lower = $derived(formatVLimit(airspace.vLower));
	// AIXM Max / Mnm auxiliary limits (fr activity zones: a winch site
	// publishes "1000 ft ASFC, max 3300 ft ASFC").
	const maxLimit = $derived(formatVLimit(airspace.vMax));
	const mnmLimit = $derived(formatVLimit(airspace.vMnm));
	// ES OTHER:* rows and blank FAA codes arrive with no datum; the bare
	// value is shown with a hint rather than a guessed reference.
	const datumUnknown = $derived(
		airspace.vLower?.ref === 'UNKNOWN' || airspace.vUpper?.ref === 'UNKNOWN',
	);
	// The catalog tables carry literal keys; the dataset fields are open
	// strings, so the lookups widen at the read site and fall back to the code.
	const typeLabel = $derived(
		(t.data.airspaceTypes as Record<string, string>)[airspace.type] ?? airspace.type,
	);
	const classDesc = $derived(
		(t.data.airspaceClasses as Record<string, string>)[airspace.airClass] ?? '',
	);

	// Show the AIXM txtLocalType only when it adds info beyond the
	// emitted type: e.g. a D-OTHER row whose emit type is "ACTIVITY"
	// but whose source txtLocalType is "TRVL" / "VOL" / "UAC" tells the
	// pilot what KIND of activity (friendly expansions in t.data). Hide
	// when the subtype is redundant (a RAS+TMZ row whose subtype string
	// is also "TMZ").
	const subtypeLabel = $derived.by(() => {
		const s = airspace.subtype?.trim();
		if (!s) return '';
		if (s.toUpperCase() === airspace.type.toUpperCase()) return '';
		return (t.data.airspaceSubtypes as Record<string, string>)[s.toUpperCase()] ?? s;
	});

	// FIR-like rows (FIR / UIR / OCA / ARTCC) list the NOTAMs filed under
	// their ICAO indicator in Item A): the FIR's own briefing, grouped by
	// Q-code subject family with the QKKKK checklists split out. Every other
	// airspace keeps the relationship-tier list below.
	const firLike = $derived(isFirLike(airspace));
	const briefIdent = $derived(firIdent(airspace));
	const firIndexed = $derived(firLike && briefIdent ? firNotamIndex() : null);
	const firBriefing = $derived(
		dedupeById(firIndexed?.briefing.get(briefIdent ?? '') ?? []),
	);
	const firChecklists = $derived(
		dedupeById(firIndexed?.checklists.get(briefIdent ?? '') ?? []),
	);
	const firGroups = $derived(groupNotamsBySubject(firBriefing, (it) => it.notam.qCode));

	const matched = $derived(firLike ? [] : notamsForAirspace(airspace.id));

	// A source NOTAM split into multiple area-entries appears more than once
	// in `matched`. Keep only one entry per id; NotamDetail already groups
	// all areas of the source NOTAM internally.
	const matchedUnique = $derived(dedupeById(matched));

	// Identity-based activation links (qCode + airspace-id text match,
	// filtered to NOTAMs whose validity window contains "now"). Shown above
	// the "Affecting NOTAMs" list; that list dedupes against this to avoid
	// showing the same NOTAM twice.
	const activatedBy = $derived(
		sortNotamsBySubject(
			dedupeById(activatedAirspaceLinks().get(airspace.id) ?? []),
			(it) => it.notam.qCode,
		),
	);
	const activatedIds = $derived.by(() => {
		const out: Record<string, true> = {};
		for (const it of activatedBy) {
			out[it.notam.id] = true;
		}
		return out;
	});
	const affectingOnly = $derived(
		matchedUnique.filter((it) => !activatedIds[it.notam.id]),
	);

	// The relationship that put a row in "Affecting NOTAMs": an activation
	// outside the current evaluation window (live ones sit in "Activated
	// by"), the by-name link, or the designator citation. Reads t at call
	// time (rendered from the template), so it follows the locale.
	function tierLabel(it: IndexedNotam): { label: string; title: string } {
		if (activatedAirspaceIds(it.notam).includes(airspace.id)) {
			return { label: t.detail.tierActivates, title: t.detail.tierActivatesTip };
		}
		if (notamNamesAirspace(it.notam, airspace)) {
			return { label: t.detail.tierNamed, title: t.detail.tierNamedTip };
		}
		return { label: t.detail.tierMentions, title: t.detail.tierMentionsTip };
	}

	// Opt-in geometric tier (Display preference): NOTAMs whose geometry
	// touches this airspace, minus the ones already listed above. Off the
	// FIR branch entirely; the briefing replaces location-based matching.
	const geometricExtra = $derived.by(() => {
		if (firLike || !display.showInAirspaces) {
			return [];
		}
		const listed: Record<string, true> = { ...activatedIds };
		for (const it of affectingOnly) {
			listed[it.notam.id] = true;
		}
		return sortNotamsBySubject(
			dedupeById(geometricNotamsForAirspace(airspace.id)).filter(
				(it) => !listed[it.notam.id],
			),
			(it) => it.notam.qCode,
		);
	});

	// The RTBA activation window for THIS airspace inside an activating NOTAM, or
	// null when the NOTAM isn't RTBA or doesn't list this zone; shown as a chip on
	// the "Activated by" / "Affecting NOTAMs" cards so the reverse link carries the
	// same per-zone time as the NOTAM's "Activates" list.
	function zoneWindow(item: IndexedNotam): string | null {
		// A zone can carry several windows in one NOTAM (a morning and an evening
		// slot); show them all, comma-joined, not just the first.
		const windows: string[] = [];
		for (const z of rtbaZoneActivations(item.notam)) {
			if (z.airspaceId === airspace.id) {
				windows.push(formatActivationWindow(z.start, z.end));
			}
		}
		return windows.length ? windows.join(', ') : null;
	}
</script>

<div class="content">
	<span class="badge badge--{airspace.category}">
		{typeLabel}
	</span>

	<div class="name">{airspace.name}</div>

	<Fields>
		{#if subtypeLabel}
			<dt>{t.detail.localType}</dt>
			<dd>{subtypeLabel}</dd>
		{/if}
		{#if airspace.airClass}
			<dt>{t.detail.class}</dt>
			<dd>
				<span class="cls">{airspace.airClass}</span>
				{#if classDesc}
					<div class="cls-desc">{classDesc}</div>
				{/if}
			</dd>
		{/if}
		{#if upper || lower}
			<dt>{t.detail.limits}</dt>
			<dd title={datumUnknown ? t.detail.datumUnknownTip : undefined}>
				{lower || '?'} – {upper || '?'}
				{#if mnmLimit || maxLimit}
					<div class="aux-limits">
						{#if mnmLimit}{t.detail.limitMnm} {mnmLimit}{/if}{#if mnmLimit && maxLimit},
						{/if}{#if maxLimit}{t.detail.limitMax} {maxLimit}{/if}
					</div>
				{/if}
			</dd>
		{/if}
		{#if airspace.workHr}
			<dt>{t.detail.hours}</dt>
			<dd>{airspace.workHr}</dd>
		{/if}
	</Fields>

	<AltitudeProfile airspaces={stack} highlightKey={airspace.key} lat={centLat} lon={centLon} />

	{#if airspace.rmkWorkHr}
		<section class="block">
			<h3>{t.detail.workingHours}</h3>
			<p class="block-text" lang={lang}>{formatAipRemark(airspace.rmkWorkHr, lang)}</p>
		</section>
	{/if}

	{#if radio.length > 0 || freqFlags.length > 0}
		<section class="block">
			<h3>{t.detail.radio}</h3>
			<FrequencyList layout="list" radios={radio} flags={freqFlags} raiIndex={raiIdx} />
		</section>
	{/if}

	{#if entryWord}
		<section class="block">
			<h3 title={t.detail.entryConditionsTip}>
				<!-- i18n-ignore: ICAO Doc 8400 abbreviation, locale-invariant -->
				{t.detail.entryConditions(routeSettings.vfr ? 'VFR' : 'IFR')}
			</h3>
			<p class="block-text">{entryWord}</p>
		</section>
	{/if}

	{#if airspace.rmk}
		<section class="block">
			<h3>{t.detail.remarks}</h3>
			<p class="block-text" lang={lang}>{formatAipRemark(airspace.rmk, lang)}</p>
		</section>
	{/if}

	{#if firLike}
		<section class="block">
			<h3>{t.detail.firBriefing} ({firBriefing.length})</h3>
			{#if firBriefing.length === 0 && firChecklists.length === 0}
				<p class="empty">{t.detail.noFirNotams}</p>
			{:else}
				<div class="groups">
					{#each firGroups as g (g.group.key)}
						<NotamGroup title={t.notam.firGroups[g.group.key]} items={g.items} />
					{/each}
					<NotamGroup title={t.detail.checklists} items={firChecklists} />
				</div>
			{/if}
		</section>
	{:else}
		{#snippet activatedExtra(item: IndexedNotam)}
			{@const win = zoneWindow(item)}
			{#if win}<span class="zone-window" title={t.detail.activationWindowZoneTip}>{win}</span>{/if}
		{/snippet}

		{#snippet affectingExtra(item: IndexedNotam)}
			{@const tier = tierLabel(item)}
			{@const win = zoneWindow(item)}
			<span class="tier" title={tier.title}>{tier.label}</span>
			{#if win}<span class="zone-window" title={t.detail.activationWindowZoneTip}>{win}</span>{/if}
		{/snippet}

		{#if activatedBy.length > 0}
			<section class="block">
				<h3>{t.detail.activatedBy} ({activatedBy.length})</h3>
				<NotamCardList
					items={activatedBy}
					active
					activeTip={t.detail.activatesAirspaceNowTip}
					activeAccent="var(--airspace-restricted)"
					headExtra={activatedExtra}
				/>
			</section>
		{/if}

		<section class="block">
			<h3>{t.detail.affectingNotamsAirspace} ({affectingOnly.length})</h3>
			{#if affectingOnly.length === 0}
				<p class="empty">{t.detail.noNotamsAirspace}</p>
			{:else}
				<NotamCardList items={affectingOnly} grouped headExtra={affectingExtra} />
			{/if}
		</section>

		{#if geometricExtra.length > 0}
			<section class="block">
				<NotamGroup title={t.detail.inThisAirspace} items={geometricExtra} />
			</section>
		{/if}
	{/if}
</div>

<style>
	.content {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.badge {
		align-self: flex-start;
		padding: 3px 9px;
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #fff;
		border-radius: 999px;
	}

	.badge--controlled {
		background: var(--airspace-controlled);
	}

	.badge--restricted {
		background: var(--airspace-restricted);
	}

	.badge--transit {
		background: var(--airspace-transit);
	}

	.badge--siv {
		background: var(--airspace-siv);
	}

	.badge--fir {
		background: var(--airspace-fir);
	}

	.name {
		font-size: 15px;
		font-weight: 600;
	}

	.cls {
		padding: 1px 6px;
		font-weight: 700;
		background: var(--accent);
		color: var(--accent-text);
		border-radius: 3px;
	}

	.aux-limits,
	.cls-desc {
		margin-top: 3px;
		font-size: 12px;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.block h3 {
		margin: 0 0 4px;
		font-size: 12px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}

	.block-text {
		margin: 0;
		white-space: pre-line;
		line-height: 1.5;
	}

	.zone-window {
		font-family: ui-monospace, monospace;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
	}

	/* The relationship chip on an "Affecting NOTAMs" card: ACTIVATES (an
	 * activation outside the evaluation window), NAMED, or MENTIONS. */
	.tier {
		padding: 1px 6px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.groups {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.empty {
		margin: 0;
		font-size: 12px;
		color: var(--text-muted);
	}
</style>
