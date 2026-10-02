<script lang="ts">
	/* Print-only document: the visible NOTAMs as a SOFIA-Briefing-style bulletin,
	 * flowed two A5 columns per A4 landscape sheet. Rendered off-screen (parked,
	 * not display:none, so it never flashes while it settles) and revealed under
	 * html.notam-print by NotamPrintHost. Structure mirrors a real SOFIA route
	 * PIB: owner blocks (aerodrome IDENT NAME / FIR line), fine subject
	 * sub-headings, then each NOTAM as id / DU:-AU: validity / A) / spaced Q) /
	 * D) / E) / F) / G). Grouping + order come from the shared PIB sorter. */

	import { orderedNotamOwnerSections, type NotamOwnerSection } from '$lib/state/notamOrder.svelte';
	import { airportByIdent, firRowsForIdent } from '$lib/state/data.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { notamSections } from '$lib/notam';
	import {
		sofiaSubjectCategory,
		SOFIA_SUBJECT_ORDER,
		type SofiaScope,
		type SofiaSubjectKey,
	} from '$lib/notam/sofiaSubject';
	import { pibValidity, pibQLine, pibDateTime } from '$lib/notam/pib';
	import type { NotamOwner } from '$lib/notam/ownership';
	import { notamState, type IndexedNotam } from '$lib/state/notam.svelte';
	import { activeFilterChips, filter } from '$lib/state/filter.svelte';
	import { planScope } from '$lib/state/planScope.svelte';
	import { levelsLabel, levelsRestrict, periodLabel, periodRestricts } from './conditionsText';
	import { notamSourceName } from '$lib/format/aerodromeFetch';

	const generatedAt = pibDateTime(new Date());

	// A bulletin printed for the cockpit states its own coverage, and states
	// it in full: a briefing fetched route by route can land short of a
	// corridor, and on paper there is no screen to go back to for WHICH
	// corridor. The count alone told a pilot something was missing without
	// telling them what, which is the half of the sentence that matters at
	// the holding point.
	const gaps = $derived(notamState.gaps);

	// And what it was read at and filtered by, for the same reason: every
	// one of these persists across sessions (docs/preferences.md), the
	// toolbar's chips and the list's do not print, and a filter set last
	// week would otherwise shape today's bulletin unsaid. What restricts is
	// set in bold, the toolbar chips' own emphasis rule; the route corridor
	// counts where its clause is live (planScope's corridor, none in the
	// NOTAM Viewer).
	const corridorApplies = $derived(
		planScope.corridor?.(notamState.notams, notamState.parsedAt) != null,
	);
	// The aerodromes fetched from their panel, which the route corridor lets
	// through by decision: the paper names them beside the filter.
	const fetchedIdents = $derived(Object.keys(notamState.aerodromeFetches));
	const filterWords = $derived.by(() => {
		const words = activeFilterChips({ route: corridorApplies }).map((chip) => {
			switch (chip.id) {
				case 'rules':
					return `${t.filter.flightRulesLegend} ${filter.trafficMode === 'vfr' ? 'VFR' : 'IFR'}`;
				case 'route':
					return fetchedIdents.length > 0
						? `${t.filter.routeLegend} (${t.notam.pib.exceptFetched(fetchedIdents.join(', '))})`
						: t.filter.routeLegend;
				case 'kind':
					return `${t.filter.kindLegend} ${chip.on}/${chip.total}`;
			}
		});
		const q = filter.query.trim();
		if (q) {
			words.push(t.notam.pib.search(q));
		}
		return words;
	});

	const sections = $derived(orderedNotamOwnerSections());
	const rendered = $derived(sections.map((s) => ({ section: s, groups: subjectGroups(s) })));
	const count = $derived(
		rendered.reduce((n, r) => n + r.groups.reduce((m, g) => m + g.items.length, 0), 0),
	);

	interface SubjectGroup {
		key: SofiaSubjectKey;
		items: IndexedNotam[];
	}

	// Bucket a section's NOTAMs by the fine SOFIA subject (context = aerodrome vs
	// en-route), deduped by source id (a multi-area NOTAM is one PIB entry),
	// emitted in SOFIA's category order.
	function subjectGroups(section: NotamOwnerSection): SubjectGroup[] {
		const scope: SofiaScope = section.owner.kind === 'aerodrome' ? 'aerodrome' : 'enroute';
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, not reactive state
		const byKey = new Map<SofiaSubjectKey, IndexedNotam[]>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedup set, not reactive state
		const seen = new Set<string>();
		for (const item of section.items) {
			if (seen.has(item.notam.id)) {
				continue;
			}
			seen.add(item.notam.id);
			const key = sofiaSubjectCategory(item.notam.qCode, scope);
			const bucket = byKey.get(key);
			if (bucket) {
				bucket.push(item);
			} else {
				byKey.set(key, [item]);
			}
		}
		return SOFIA_SUBJECT_ORDER[scope]
			.filter((k) => byKey.has(k))
			.map((k) => ({ key: k, items: byKey.get(k) as IndexedNotam[] }));
	}

	// SOFIA renders "IDENT FIR NAME", multi-FIR joined by " - "; an aerodrome as
	// "IDENT NAME"; unknown owners fall back to the generic label.
	function ownerHeading(owner: NotamOwner): string {
		if (owner.kind === 'aerodrome') {
			const ident = owner.ident.toUpperCase();
			const name = airportByIdent(ident)?.name;
			const heading = name ? `${ident} ${name}` : ident;
			// Fetched from its panel since the briefing: younger than the rest
			// of the paper, which says so where the reader looks.
			const fetched = notamState.aerodromeFetches[ident];
			return fetched
				? `${heading} (${t.notam.pib.aerodromeFetched({
						source: notamSourceName(fetched.source),
						time: pibDateTime(new Date(fetched.at)),
					})})`
				: heading;
		}
		if (owner.kind === 'fir' || owner.kind === 'checklist') {
			return owner.firs.map(firHeading).join(' - ');
		}
		return t.notam.firGroups.other;
	}

	function firHeading(ident: string): string {
		const id = ident.toUpperCase();
		const name = firRowsForIdent(id)[0]?.name;
		return name ? `${id} FIR ${name}` : `${id} FIR`;
	}

	interface Line {
		text: string;
		pre?: boolean;
	}

	// The printed lines of one NOTAM, in SOFIA order (B)/C) become the DU:/AU:
	// line; no decoded prose, no NOTAMR marker, matching the reference PDF).
	function notamLines(item: IndexedNotam): { id: string; lines: Line[] } {
		const n = item.notam;
		const s = notamSections(n);
		const v = pibValidity(n.startDate, n.endDate, n.permanent, n.estimated);
		const lines: Line[] = [];
		let validity = `${t.notam.pib.from}: ${v.from} ${t.notam.pib.to}: ${v.to ?? 'PERM'}`;
		if (v.estimated) {
			validity += ' EST';
		}
		lines.push({ text: validity });
		lines.push({ text: `A)${s.A ?? n.icaoCodes.join(' ')}` });
		const q = pibQLine(s.Q);
		if (q) {
			lines.push({ text: `Q) ${q}` });
		}
		if (s.D) {
			lines.push({ text: `D) ${s.D}` });
		}
		if (s.E) {
			lines.push({ text: `E) ${s.E}`, pre: true });
		}
		if (s.F) {
			lines.push({ text: `F) ${s.F}` });
		}
		if (s.G) {
			lines.push({ text: `G) ${s.G}` });
		}
		return { id: n.id, lines };
	}
</script>

<div class="npd-print">
	<div class="npd-head">
		<div class="npd-title">{t.notam.pib.title}</div>
		<div class="npd-sub">
			{t.notam.pib.generated(generatedAt)} · {t.notam.pib.count(count)}
			{#if notamState.lastFetch}
				· {t.notam.pib.fetchedFrom({
					source: notamSourceName(notamState.lastFetch.source),
					time: pibDateTime(new Date(notamState.lastFetch.at)),
				})}
			{/if}
			{#if gaps}
				· <span class="npd-gap"
						>{t.notam.routesNotCovered({
							missing: gaps.routes.length,
							total: gaps.total,
							list: true,
						})}
						{gaps.routes.map((g) => `${g.label} (${t.errors.sofiaCause[g.cause]})`).join(' · ')}</span
					>
			{/if}
		</div>
		<div class="npd-sub">
			<!-- As APPLIED (./conditionsText.ts): a Flight period with no
			     window, a custom range not set or a band typed upside down cut
			     the paper at Now and at every level, and it says so. -->
			<span class:npd-cut={periodRestricts({ applied: true })}
				>{t.notam.pib.period(periodLabel({ applied: true }))}</span
			>
			{#if levelsRestrict({ applied: true })}
				<span class="npd-cut">{t.notam.pib.levels(levelsLabel({ applied: true }))}</span>
			{:else}
				<span>{t.notam.pib.allLevels}</span>
			{/if}
			{#if filterWords.length > 0}
				<span class="npd-cut">{t.notam.pib.filters(filterWords.join(', '))}</span>
			{/if}
		</div>
	</div>

	<div class="npd-doc">
		{#each rendered as { section, groups } (section.key)}
			<div class="npd-owner">{ownerHeading(section.owner)}</div>
			{#each groups as group (group.key)}
				<div class="npd-subject">{t.notam.sofiaGroups[group.key]}</div>
				{#each group.items as item (item.notam.id)}
					{@const nl = notamLines(item)}
					<div class="npd-notam">
						<div class="npd-id">{nl.id}</div>
						{#each nl.lines as line, i (i)}
							<div class="npd-line" class:pre={line.pre}>{line.text}</div>
						{/each}
					</div>
				{/each}
			{/each}
		{/each}
	</div>
</div>

<style>
	/* On screen: rendered but parked off-viewport (not display:none) so the
	 * print snapshot captures it without a visible flash while it settles. */
	.npd-print {
		position: fixed;
		top: 0;
		left: 0;
		width: 1100px;
		transform: translateX(-200vw);
		pointer-events: none;
		font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
		color: #000;
	}

	@media print {
		:global(html.notam-print) .npd-print {
			position: static;
			width: auto;
			transform: none;
			pointer-events: auto;
			background: #fff;
			color: #000;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
			font-size: 8.2pt;
			line-height: 1.24;
		}

		/* Two A5 columns per A4 landscape sheet; column-fill: auto fills one
		 * column fully before the next and paginates across sheets. The 8mm
		 * @page margin (NotamPrintHost) plus this 16mm gap yield two A5 halves
		 * with uniform 8mm margins on a guillotine cut. The title sits ABOVE the
		 * multicolumn block (not column-span: all, which Gecko mishandles in
		 * paged multicol), so it is full width on the first sheet. */
		.npd-doc {
			column-count: 2;
			column-gap: 16mm;
			column-fill: auto;
		}

		.npd-head {
			margin: 0 0 4mm;
			padding-bottom: 1.5mm;
			border-bottom: 0.4pt solid #000;
		}

		.npd-title {
			font-size: 13pt;
			font-weight: 700;
		}

		.npd-sub {
			font-size: 8pt;
			color: #333;
		}

		/* Bold black on paper, where a tint would print as grey: what the
		   bulletin leaves out has to read at a glance in the cockpit, the
		   routes it does not cover and the conditions that cut it down. */
		.npd-gap,
		.npd-cut {
			font-weight: 700;
			color: #000;
		}

		/* Aerodrome / FIR owner heading. */
		.npd-owner {
			margin: 3mm 0 1mm;
			font-size: 10.5pt;
			font-weight: 700;
			break-after: avoid;
		}

		/* Fine SOFIA subject sub-heading. */
		.npd-subject {
			margin: 1.8mm 0 0.6mm;
			font-size: 8.2pt;
			font-weight: 700;
			break-after: avoid;
		}

		/* One NOTAM; never split across a column or page. */
		.npd-notam {
			margin: 0 0 2mm;
			break-inside: avoid;
		}

		.npd-id {
			font-weight: 700;
		}

		.npd-line {
			padding-left: 4mm;
			text-indent: -4mm;
		}

		.npd-line.pre {
			white-space: pre-wrap;
		}
	}
</style>
