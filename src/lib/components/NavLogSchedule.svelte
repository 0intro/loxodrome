<script lang="ts">
	import type { RouteAirspaceEvent } from '$lib/route/airspaces';
	import type { NavLiveSchedule } from '$lib/nav/navlogLive';
	import { cachedAirspaceSchedule } from '$lib/state/navlogSchedule';
	import { t } from '$lib/state/i18n.svelte';
	import { routeSettings, type Route } from '$lib/state/route.svelte';
	import { effectiveCruiseSpeedKt } from '$lib/state/aircraft.svelte';
	import { getAirspaces, dataState } from '$lib/state/data.svelte';
	import { airspaceScheduleBadge, type AirspaceScheduleBadge, type VLimit } from '$lib/data/airspaces';
	import { formatVLimit } from '$lib/vertical/limits';
	import { ensureRouteTerrain, routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
	import { routeLegGroundSpeeds } from '$lib/state/routeWind.svelte';
	import { legCumulativeMinutes, timeAtNM } from '$lib/route/legWind';
	import { computeNavLog } from '$lib/route/navlog';
	import { fmtNM, fmtEte, fmtClockUtc, fmtDurationMin } from '$lib/route/format';
	import { radioSummary } from '$lib/format/radio';
	import { resolveScheduleRadios } from '$lib/state/freqOverride.svelte';
	import { useAirspaceHover } from './featureHover.svelte';

	interface Props {
		/** The route whose crossed airspaces / SIV this schedule lists. */
		route: Route;
		/** Section heading; the kneeboard print passes the route's dep -> dest. */
		heading?: string;
		/** Click a row to navigate to the airspace. Its presence is also what
		 *  makes the rows flash their airspace on the map when pointed at, so
		 *  the print and measuring mounts (which pass none) stay inert. */
		onAirspace?: (key: string) => void;
		/** Continuation-card slice (kneeboard prints): render only the events
		 *  [from, to) (ABSOLUTE schedule indices, end-exclusive). Every row is
		 *  self-contained (Cum / ETE are absolute per event), so a slice needs
		 *  no boundary repetition; absent = the whole schedule. */
		rowRange?: { from: number; to: number } | undefined;
		/** 1-based continuation-card position; count > 1 appends "(i/n)" to
		 *  the heading, which repeats on every part (as does the thead). */
		part?: { index: number; count: number } | undefined;
		/** A5 kneeboard-card compaction, scoped by prop (the print card mounts
		 *  in NavLogModal / PrintDoc and navlogMeasure's print-prep measuring
		 *  mount set it) and media-INDEPENDENT, so the measuring mount renders
		 *  the exact card geometry on screen and the measured row heights are
		 *  the printed ones. */
		kneeboard?: boolean;
		/** Live overlay (navigation mode; state/navLive.svelte.ts): dims passed
		 *  rows, highlights the current / next contact rows, stamps the actual
		 *  crossing times and pins the next-change countdown chip. Only the
		 *  interactive modal mount passes it; the print / measuring mounts must
		 *  never (the measured card packing depends on row heights). */
		live?: NavLiveSchedule | null;
	}
	let { route, heading, onAirspace, rowRange, part, kneeboard = false, live = null }: Props = $props();
	// Belt-and-braces against a live prop reaching a print mount: the overlay
	// renders only off-kneeboard.
	const liveOn = $derived(live != null && !kneeboard);
	// The rows answer for a route the aircraft is not on: still worth showing
	// (it is the plan being rejoined) but not as a contact in force.
	const planOnly = $derived(liveOn && live?.planOnly === true);
	// Continuation-card marker appended to the heading: bare numerals,
	// locale-invariant, present only when the schedule is actually split.
	const partSuffix = $derived(part && part.count > 1 ? ` (${part.index}/${part.count})` : '');
	// Translated default resolved in a $derived, never a $props() fallback
	// (docs/i18n.md rule 4), so a locale switch re-renders the heading.
	const headingText = $derived((heading ?? t.navlog.scheduleHeading) + partSuffix);

	const airspaces = $derived(dataState.airspacesLoaded ? getAirspaces() : null);

	// Terrain along the route (shared per-route cache): AGL/ASFC limits then
	// evaluate exactly, so the schedule agrees with the route profile. The
	// schedule renders conservatively first and refines when samples land.
	$effect(() => {
		ensureRouteTerrain(route.id, route.waypoints);
	});
	const terrain = $derived(routeTerrainSamples(route.id, route.waypoints));

	const schedule = $derived(
		airspaces
			? cachedAirspaceSchedule(
					route.waypoints,
					airspaces,
					effectiveCruiseSpeedKt(),
					routeSettings.defaultAltitudeFt,
					terrain,
				)
			: [],
	);

	// The schedule with frequency-change NOTAMs applied to the crossed airspaces'
	// radio, so the radio column reports the current value (a SIV frequency NOTAM
	// moves SEINE 4/5 here too). Untouched when the briefing has no such NOTAM.
	const scheduleResolved = $derived(airspaces ? resolveScheduleRadios(schedule, airspaces) : schedule);

	// Wind-corrected ETEs as a cheap second stage: the walk above stays free
	// of wind dependencies (the Weather animation ticks validTimeMs, which
	// must not re-run a 1000-sample walk per frame), and only this remap
	// re-times the events through the per-leg ground speeds. With no wind on
	// any leg the events pass through untouched (bit-identical still air).
	const scheduleTimed = $derived.by<RouteAirspaceEvent[]>(() => {
		const gs = routeLegGroundSpeeds(route);
		if (gs.every((g) => g == null)) {
			return scheduleResolved;
		}
		const bounds = legCumulativeMinutes(
			computeNavLog(route.waypoints, effectiveCruiseSpeedKt()).legs,
			effectiveCruiseSpeedKt(),
			gs,
		);
		if (!bounds) {
			return scheduleResolved;
		}
		return scheduleResolved.map((ev) => ({ ...ev, eteMin: timeAtNM(ev.atNM, bounds) }));
	});

	// Continuation-card slice: the events THIS card renders. Bounds clamp to
	// the live schedule, and the LAST part always runs to the end: the split
	// was measured moments before printing, but a terrain refinement landing
	// in between can shift the event list, and a clamped tail must widen
	// rather than drop rows off the paper.
	const evFrom = $derived(
		rowRange ? Math.min(Math.max(0, rowRange.from), scheduleTimed.length) : 0,
	);
	const evTo = $derived(
		!rowRange || (part && part.index === part.count)
			? scheduleTimed.length
			: Math.min(scheduleTimed.length, rowRange.to),
	);
	const cardEvents = $derived(scheduleTimed.slice(evFrom, evTo));

	function band(lower: VLimit | null, upper: VLimit | null): string {
		const lo = formatVLimit(lower);
		const hi = formatVLimit(upper);
		if (!lo && !hi) {
			return '';
		}
		return `${lo || '?'} – ${hi || '?'}`;
	}

	/* The frequency column, split on the service-closure bit: the working
	 * rows read as today, a withdrawn one is appended struck with the NOTAM
	 * named on the tooltip (same row height: inline text only). */
	function openRadioText(ev: RouteAirspaceEvent): string {
		return radioSummary(ev.radio.filter((r) => !r.closed), (r) => r.call || r.unit);
	}

	function closedRadioText(ev: RouteAirspaceEvent): string {
		return radioSummary(ev.radio.filter((r) => r.closed), (r) => r.call || r.unit);
	}

	function closedRadioTip(ev: RouteAirspaceEvent): string {
		const id = ev.radio
			.map(
				(r) =>
					(r as { closedBy?: { source?: { notam?: { id?: string } } } }).closedBy?.source
						?.notam?.id,
			)
			.find((v) => v != null);
		return t.navlog.freqClosedTip(id ?? '');
	}

	// One chip per row (the vertical profile's badge model): class chips keep
	// the accent look (the base .chip rule), the rest colour by category ink;
	// SIV / activity chips (text '') render as the empty filled square.
	function chipClass(chip: AirspaceScheduleBadge): string {
		let cls = 'chip';
		if (chip.category !== 'controlled') {
			cls += ` chip--${chip.category}`;
		}
		if (chip.text === '') {
			cls += ' chip--sq';
		}
		return cls;
	}

	function onAirspaceKey(e: KeyboardEvent, key: string): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onAirspace?.(key);
		}
	}

	/* Pointing at a row flashes its airspace on the map, the rule the airspace
	   lists, the context menu and the profile columns already follow; focus
	   counts as pointing, since the row is a keyboard button. The set is the
	   rows actually drawn, so a route edit that stops crossing a zone drops the
	   highlight. The print and measuring mounts pass no onAirspace, so they
	   never call set and the effect stays inert. */
	const hover = useAirspaceHover(() => cardEvents);
</script>

<section class="sched" class:kneeboard>
	<h3>{headingText}</h3>
	{#if !dataState.airspacesLoaded}
		<!-- A failed fetch clears the loading flag but never sets loaded, so a
		     bare "Loading" would show forever; the error flag tells them apart. -->
		<p class="muted">
			{dataState.airspacesError != null ? t.navlog.airspacesUnavailable : t.navlog.loadingAirspaces}
		</p>
	{:else if scheduleTimed.length === 0}
		<p class="muted">{t.navlog.noAirspaceCrossed}</p>
	{:else}
		<div class="scroll">
			<table class="nav">
				<thead>
					<tr>
						<!-- i18n-ignore: Cum is the compact cumulative-distance header, invariant like the Doc 8400 abbreviations; the tooltip spells it out -->
						<th class="num" title={t.navlog.cumTip}>Cum</th>
						<th class="num" title={t.navlog.scheduleEteTip}>ETE</th>
						<th></th>
						<th>{t.navlog.airspace}</th>
						<th>{t.navlog.frequency}</th>
					</tr>
				</thead>
				<tbody>
					{#snippet cells(ev: RouteAirspaceEvent, abs: number)}
						{@const chip = airspaceScheduleBadge(ev)}
						{@const typeTitle = (t.data.airspaceTypes as Record<string, string>)[ev.type] ?? ev.type}
						{@const lrow = liveOn ? (live?.rows[abs] ?? null) : null}
						<td class="num">{fmtNM(ev.atNM)}</td>
						<td class="num">
							<span class="ete-plan">{fmtEte(ev.eteMin)}</span>
							{#if lrow?.atoMs != null}
								<span class="ato" title={t.navlog.atoTip}>{fmtClockUtc(lrow.atoMs)}</span>
							{/if}
						</td>
						<td>
							<span class="badge {ev.kind}">{ev.kind === 'enter' ? t.navlog.enter : t.navlog.leave}</span>
						</td>
						<td>
							<!-- One chip per row (the profile's badge model); the type text is
							     skipped when the chip already carries it (R / D / P, MOA, TMZ,
							     ...), so a row reads "R 212", not "R R 212". -->
							{#if chip}<span class={chipClass(chip)} title={chip.text === ev.type ? typeTitle : undefined}
								>{chip.text}</span
							>{/if}{#if !chip || chip.text !== ev.type}<span class="as-type" title={typeTitle}>{ev.type}</span
							>{/if} {ev.name}
							{#if band(ev.vLower, ev.vUpper)}
								<span class="as-band">{band(ev.vLower, ev.vUpper)}</span>
							{/if}
							{#if liveOn && live?.chip != null && abs === live.chip.rowIdx}
								<span class="live-chip" title={t.navigation.contactBoundary}
									>{fmtNM(live.chip.toNM)} NM{live.chip.eteMin != null
										? ` · ${fmtDurationMin(live.chip.eteMin)}`
										: ''}</span
								>
							{/if}
						</td>
						<td
							>{openRadioText(ev) ||
								(closedRadioText(ev) ? '' : '–')}{#if closedRadioText(ev)}
								<s class="freq-closed" title={closedRadioTip(ev)}>{closedRadioText(ev)}</s
								>{/if}</td
						>
					{/snippet}
					{#each cardEvents as ev, i (ev.kind + '|' + ev.key + '|' + i)}
						{@const abs = evFrom + i}
						{#if onAirspace}
							<!-- The row stays a ROW: role="button" over a <tr> orphans its
							     cells (a cell needs a row parent) and flattens the whole
							     line into one button label, so the schedule could not be
							     read with a screen reader's table keys. It keeps its tab
							     stop and its Enter handler, which is what makes it
							     reachable, and the cells keep saying what they hold. -->
							<tr
								class="ev clickable"
								class:plan-only={planOnly}
								class:passed={liveOn && (live?.rows[abs]?.passed ?? false)}
								class:current={liveOn && abs === live?.currentRowIdx}
								class:next={liveOn && abs === live?.nextRowIdx}
								aria-current={liveOn && abs === live?.currentRowIdx ? 'step' : undefined}
								tabindex="0"
								onclick={() => onAirspace(ev.key)}
								onkeydown={(e) => onAirspaceKey(e, ev.key)}
								onmouseenter={() => hover.set(ev.key)}
								onmouseleave={() => hover.set(null)}
								onfocus={() => hover.set(ev.key)}
								onblur={() => hover.set(null)}
							>
								{@render cells(ev, abs)}
							</tr>
						{:else}
							<tr
								class="ev"
								class:plan-only={planOnly}
								class:passed={liveOn && (live?.rows[abs]?.passed ?? false)}
								class:current={liveOn && abs === live?.currentRowIdx}
								class:next={liveOn && abs === live?.nextRowIdx}>{@render cells(ev, abs)}</tr
							>
						{/if}
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	.scroll {
		overflow-x: auto;
	}

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	/* ---- radio & airspace schedule table ----
	   --nav-live is the nav-mode identity orange (map/navLayer TRACE_COLOR
	   family; an app-identity colour, deliberately not in palette.ts), the
	   live overlay's ink. */
	.sched {
		--nav-live: var(--nav-orange);

		margin-top: 18px;
	}

	.sched h3 {
		margin: 0 0 8px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	table.nav {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}

	.nav th {
		padding: 6px 8px;
		text-align: left;
		font-weight: 600;
		white-space: nowrap;
		color: var(--text-muted);
		border-bottom: 1px solid var(--border);
	}

	.nav th.num {
		text-align: right;
	}

	/* Long airspace names / frequency lists wrap instead of running past the
	   panel edge or the paper edge (truncation is unrecoverable on the
	   kneeboard); numeric cells stay one-line (see .ev td.num). */
	.ev td {
		padding: 6px 8px;
		white-space: normal;
		border-bottom: 1px solid var(--border);
	}

	.ev td.num {
		text-align: right;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	/* Interactive mount only: the kneeboard / measuring cards render the same
	   rows with no onAirspace and must not promise a click. Neither property
	   participates in layout, so the measured card row heights are unchanged.
	   Focus tints like hover because it highlights the airspace the same way. */
	tr.ev.clickable {
		cursor: pointer;
	}

	tr.ev.clickable:hover,
	tr.ev.clickable:focus-visible {
		background: var(--surface-3);
	}

	.badge {
		display: inline-block;
		padding: 1px 7px;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
	}

	.badge.enter {
		color: var(--status-active);
		background: rgb(31 143 77 / 15%);
	}

	.badge.leave {
		color: var(--status-warn);
		background: rgb(198 40 40 / 12%);
	}

	.as-type {
		margin-right: 5px;
		font-weight: 600;
		color: var(--text-muted);
	}

	.as-band {
		margin-left: 6px;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* The row's single airspace chip (the vertical profile's badge model).
	   Line-height sized (13px, inside the row's line box on screen and on
	   the kneeboard) so the swatch -> chip swap stays row-height-neutral
	   for the measured card packing. The base rule is the class chip (and
	   the rare classless controlled row): accent, like the profile's. */
	.chip {
		display: inline-block;
		min-width: 15px;
		height: 13px;
		margin-right: 5px;
		padding: 0 4px;
		font-size: 10px;
		font-weight: 700;
		line-height: 13px;
		text-align: center;
		vertical-align: middle;
		background: var(--accent);
		color: var(--accent-text);
		border-radius: 3px;
	}

	.chip--restricted {
		background: var(--airspace-restricted);
	}

	.chip--transit {
		background: var(--airspace-transit);
	}

	.chip--trafficmgmt {
		background: var(--airspace-trafficmgmt);
	}

	/* SIV / activity: the empty filled square (the chart's SIV mark), the
	   chip box squared. */
	.chip--siv {
		background: var(--airspace-siv);
	}

	.chip--activity {
		background: var(--airspace-activity);
	}

	.chip--sq {
		width: 13px;
		min-width: 0;
		padding: 0;
	}

	/* ---- live overlay (the interactive modal mount only; liveOn gates on
	   !kneeboard, so the measured card packing never sees these) ----
	   Passed rows dim except the stamped actual (the record); the current
	   contact row tints with a left edge bar, the next one lighter; the
	   chip counts down to the next contact change. */
	tr.ev.passed td:not(:nth-child(2)) {
		opacity: 0.55;
	}

	tr.ev.passed td:nth-child(2) .ete-plan {
		opacity: 0.55;
	}

	.ato {
		display: block;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	tr.ev.current td {
		background: color-mix(in srgb, var(--nav-live) 10%, transparent);
	}

	tr.ev.current td:first-child {
		box-shadow: inset 3px 0 0 var(--nav-live);
	}

	tr.ev.next td {
		background: color-mix(in srgb, var(--nav-live) 5%, transparent);
	}

	/* Answering for a route the aircraft is not on: the sequence is still the
	   plan, so it is shown, but the current / next tints stop claiming a
	   contact is in force. The countdown chip goes with them. */
	tr.ev.plan-only.current td,
	tr.ev.plan-only.next td {
		background: none;
	}

	tr.ev.plan-only.current td:first-child {
		box-shadow: inset 3px 0 0 color-mix(in srgb, var(--nav-live) 35%, transparent);
	}

	tr.ev.plan-only .live-chip {
		opacity: 0.55;
	}

	/* A frequency a service-closure NOTAM withdrew: the published record
	   stays on the row, struck and muted; the tooltip names the NOTAM. */
	.freq-closed {
		color: var(--text-muted);
	}

	/* A contact in force reads as active, never as a dimmed past row: its ENTER
	   row lies behind the aircraft by construction (you entered the airspace to
	   be inside it), so the tint would otherwise land at 55%. */
	tr.ev.passed.current td,
	tr.ev.passed.next td,
	tr.ev.passed.current td:nth-child(2) .ete-plan,
	tr.ev.passed.next td:nth-child(2) .ete-plan {
		opacity: 1;
	}

	.live-chip {
		display: inline-block;
		margin-left: 6px;
		padding: 0 6px;
		font-size: 10px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		color: var(--nav-live);
		border: 1px solid var(--nav-live);
		border-radius: 999px;
	}

	/* ---- kneeboard compaction (one A5 card) ----
	   The schedule fills an A5 card; tighten. Scoped by the kneeboard PROP
	   (the root section's class), not html.navlog-kneeboard, and OUTSIDE
	   @media print: media-independent, so navlogMeasure's print-prep
	   measuring mount renders the exact card geometry on screen and the
	   measured row heights are the printed ones. The prop only ever comes
	   true for the print card mounts (NavLogModal kneeboard, PrintDoc
	   dossier; hidden or parked off-viewport on screen) and that host. */
	.sched.kneeboard {
		margin-top: 0;
	}

	.kneeboard .scroll {
		overflow: visible;
	}

	/* Slice-INVARIANT columns: auto table layout re-derives column widths
	   from each part's own rows, so a continuation card's Airspace column
	   could narrow (a long frequency in that slice) and wrap names onto
	   extra lines the full-table measuring mount never saw, overflowing
	   the packed card (measured with the printToPDF harness). Fixed layout
	   pins the numeric / badge columns and splits the rest identically on
	   every part AND in the measuring host, so measured row heights are
	   the printed ones (the nav-log grid's fixed tracks, table-flavoured). */
	.kneeboard table.nav {
		font-size: 9px;
		table-layout: fixed;
	}

	.kneeboard .nav th.num {
		width: 36px;
	}

	/* The enter / leave badge column. */
	.kneeboard .nav th:nth-child(3) {
		width: 42px;
	}

	/* The frequency column; the Airspace column takes the remainder. */
	.kneeboard .nav th:nth-child(5) {
		width: 31%;
	}

	.kneeboard .nav th,
	.kneeboard .ev td {
		padding: 3px 5px;
	}

	/* Fixed layout cannot widen a column for an overlong token: break it
	   instead of letting it overflow the cell. */
	.kneeboard .ev td {
		overflow-wrap: break-word;
	}

	@media print {
		/* Portrait single-route print: start the schedule on its own page. The
		   kneeboard lays it out two-up on its own sheet instead (see NavLogModal). */
		:global(html.navlog-print:not(.navlog-kneeboard)) .sched {
			break-before: page;
		}

		/* Keep each event row whole across a page break: the measured card
		   split makes every part fit its sheet, so this only tidies the rare
		   post-measure growth (the sheet's row-level break-inside posture). */
		tr.ev {
			break-inside: avoid;
		}
	}
</style>
