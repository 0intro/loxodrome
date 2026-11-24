<script lang="ts">
	import type { RouteAirspaceEvent } from '$lib/route/airspaces';
	import type { NavLiveSchedule } from '$lib/nav/navlogLive';
	import { cachedAirspaceSchedule } from '$lib/state/navlogSchedule';
	import { t } from '$lib/state/i18n.svelte';
	import { routeSettings, type Route } from '$lib/state/route.svelte';
	import { effectiveCruiseSpeedKt } from '$lib/state/aircraft.svelte';
	import { getAirspaces, getSupaips, dataState } from '$lib/state/data.svelte';
	import { airspaceScheduleBadge, type AirspaceScheduleBadge, type VLimit } from '$lib/data/airspaces';
	import { formatVLimit } from '$lib/vertical/limits';
	import { ensureRouteTerrain, routeTerrainSamples } from '$lib/state/routeTerrain.svelte';
	import { routeLegGroundSpeeds } from '$lib/state/routeWind.svelte';
	import { legCumulativeMinutes, timeAtNM } from '$lib/route/legWind';
	import { computeNavLog } from '$lib/route/navlog';
	import { fmtNM, fmtEte, fmtClockUtc, fmtDurationMin } from '$lib/route/format';
	import { airspaceRadioLabel, radioSummary, zoneLabel } from '$lib/format/radio';
	import { resolveScheduleRadios } from '$lib/state/scheduleRadios.svelte';
	import { useAirspaceHover } from './featureHover.svelte';
	import Icon from './Icon.svelte';
	import { askUnitText } from '$lib/data/knownFrom';
	import { notamVolumes, supaipVolumes, zsmVolumes, type AlertVolume } from '$lib/nav/alertVolumes';
	import { temporaryZoneSchedule, type ScheduleZone } from '$lib/route/airspaces';
	import { bandKnownFrom, bandStates, crossingClock, crossingRanges } from '$lib/state/activity.svelte';
	import { briefingActivityUnknown } from '$lib/state/briefing.svelte';
	import { activeEvalWindow, rawNotamsDuring } from '$lib/state/notam.svelte';
	import { activationRepresented } from '$lib/state/routeCrossings.svelte';
	import { planScope } from '$lib/state/planScope.svelte';
	import { routeEndpointsLabel } from '$lib/state/routeNotamFetch';
	import { validityOverlaps } from '$lib/state/supaip.svelte';
	import { zsmActiveZones } from '$lib/state/zsm.svelte';
	import { isZsmBandKey } from '$lib/route/zsmProfile';
	import { activeWord } from './profileBand';
	import { pastFlightNow } from './flightprep/chartsPrefetch';
	import { mergeScheduleRows } from './scheduleRows';
	import { cautionWord, notedWord } from './zoneStateText';

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
		/** A4-portrait page rendition (the nav log's full-page paper), the
		 *  kneeboard's slice-invariant table at the page's
		 *  scale: the page mounts and navlogMeasure's measuring mount set it,
		 *  so a continuation part lays its columns out exactly as the full
		 *  table the parts were measured on. */
		portrait?: boolean;
		/** Live overlay (navigation mode; state/navLive.svelte.ts): dims passed
		 *  rows, highlights the current / next contact rows, stamps the actual
		 *  crossing times and pins the next-change countdown chip. The
		 *  interactive mount passes it, and so do the A4 page mounts and their
		 *  measuring mount (that print is the screen's own record, measured
		 *  with the overlay it carries); the kneeboard / dossier mounts and
		 *  their measuring mount never (the gate below nulls it besides). */
		live?: NavLiveSchedule | null;
		/** Phone rendition, beside the sheet's compact grid: the table runs
		 *  to both edges of the pane (its cells inset their own text) and
		 *  only the text outside it, the heading and the notes, keeps an
		 *  inset. The interactive mount alone passes it; the gate below keeps
		 *  every print and measuring mount out whatever they pass, and the
		 *  rules are screen-only besides. */
		compact?: boolean;
		/** Desktop rendition, beside the sheet's flat one: the modal body
		 *  gives up its padding, so the heading, the notes and the table's
		 *  outer cells take a 12 px inset of their own. Gated like `compact`,
		 *  screen only. */
		flat?: boolean;
	}
	let {
		route,
		heading,
		onAirspace,
		rowRange,
		part,
		kneeboard = false,
		portrait = false,
		live = null,
		compact = false,
		flat = false,
	}: Props = $props();
	// Belt-and-braces against a live prop reaching a print mount: the overlay
	// renders only off-kneeboard.
	const liveOn = $derived(live != null && !kneeboard);
	// Structural like the sheet's own gate: no paper rendition is ever compact.
	const compactMode = $derived(compact && !kneeboard && !portrait);
	const flatMode = $derived(flat && !kneeboard && !portrait && !compactMode);
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

	// How the zone rows are judged, the dossier's rule (PrintDoc): over the
	// verdict window with the briefing's answer for the route, each crossing
	// at its planned time, or for a flight already flown over its dated
	// span, read as briefed. Every mount reads it alike, so the measured
	// rows are the printed ones.
	const past = $derived(pastFlightNow() !== null);
	const verdict = $derived(
		(past ? planScope.flight?.window() : planScope.flight?.briefingWindow()) ?? activeEvalWindow(),
	);

	// The temporary zones in force over it, walked as the airspaces are
	// (route/airspaces.ts temporaryZoneSchedule): the supplements' zones, the
	// restricted areas NOTAMs create, an activation NOTAM of a loaded zone
	// left to that zone's row, the profile's rule, and the raptor zones, each
	// named bare beside its ZSM chip.
	function zoneOf(key: string, v: AlertVolume): ScheduleZone {
		return { key, name: v.name, rings: v.rings, circles: v.circles, bbox: v.bbox, vLower: v.vLower, vUpper: v.vUpper };
	}
	const zones = $derived.by<ScheduleZone[]>(() => {
		void dataState.supaipLoaded;
		const sups = (getSupaips() ?? []).filter((s) => validityOverlaps(s, verdict.from, verdict.to));
		const notams = rawNotamsDuring(verdict)
			.map((i) => i.notam)
			.filter((n) => !activationRepresented(n));
		const zsm = zsmActiveZones(verdict.from, verdict.to);
		return [
			...supaipVolumes(sups).map((v) => zoneOf(`sup:${v.key}`, v)),
			...notamVolumes(notams)
				.filter((v) => v.qSubject.startsWith('R'))
				.map((v) => zoneOf(`notam:${v.key}`, v)),
			...zsmVolumes(zsm).map((v, i) => ({ ...zoneOf(v.key, v), name: zsm[i].name })),
		];
	});
	const zoneEvents = $derived(
		zones.length > 0
			? temporaryZoneSchedule(route.waypoints, zones, effectiveCruiseSpeedKt(), routeSettings.defaultAltitudeFt, terrain)
			: [],
	);

	// Wind-corrected ETEs as a cheap second stage: the walks above stay free
	// of wind dependencies (the Weather animation ticks its own instant, which
	// must not re-run a 1000-sample walk per frame), and only this remap
	// re-times the events through the per-leg ground speeds. With no wind on
	// any leg the events pass through untouched (bit-identical still air).
	const legBounds = $derived.by(() => {
		const gs = routeLegGroundSpeeds(route);
		if (gs.every((g) => g == null)) {
			return null;
		}
		return legCumulativeMinutes(
			computeNavLog(route.waypoints, effectiveCruiseSpeedKt()).legs,
			effectiveCruiseSpeedKt(),
			gs,
		);
	});
	function timed(events: RouteAirspaceEvent[]): RouteAirspaceEvent[] {
		const bounds = legBounds;
		return bounds ? events.map((ev) => ({ ...ev, eteMin: timeAtNM(ev.atNM, bounds) })) : events;
	}
	const scheduleTimed = $derived(timed(scheduleResolved));

	// The rows in route order, each schedule event keeping its index in the
	// schedule the live overlay reads (`raw`), a temporary zone's none.
	const rows = $derived(mergeScheduleRows(scheduleTimed, timed(zoneEvents)));

	// Each zone's state at its crossing, read as the profile's strip reads
	// it (state/activity.svelte.ts bandStates): its enter row wears ACTIVE or
	// the caution word, and a zone active or that may be active naming no
	// radio, a temporary zone always, gives its Frequency cell the unit that
	// knows its activity.
	const zoneStates = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's local tally
		const spans = new Map<string, { enterNM: number; leaveNM: number }[]>();
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a derived's local tally
		const open = new Map<string, number>();
		for (const { ev } of rows) {
			const from = open.get(ev.key);
			if (ev.kind === 'enter') {
				open.set(ev.key, ev.atNM);
			} else if (from !== undefined) {
				spans.set(ev.key, [...(spans.get(ev.key) ?? []), { enterNM: from, leaveNM: ev.atNM }]);
				open.delete(ev.key);
			}
		}
		const endNM = rows.length > 0 ? rows[rows.length - 1].ev.atNM : 0;
		for (const [key, from] of open) {
			spans.set(key, [...(spans.get(key) ?? []), { enterNM: from, leaveNM: Math.max(from, endNM) }]);
		}
		const bands = [...spans].map(([key, s]) => ({ key, spans: s }));
		const clock = past ? null : crossingClock(route);
		return bandStates(
			bands,
			{ fromMs: verdict.from, toMs: verdict.to },
			past ? null : briefingActivityUnknown(routeEndpointsLabel(route)),
			clock ? crossingRanges(bands, clock) : null,
		);
	});

	/** The word a zone's enter row wears, null for one in force at all
	 *  times or inactive at its crossing. A zone the pilot's note settles
	 *  says so after its state. */
	function zoneWord(ev: RouteAirspaceEvent): { text: string; caution: boolean } | null {
		const a = ev.kind === 'enter' ? zoneStates.get(ev.key) : undefined;
		if (a?.reason === 'noted' && a.period) {
			const noted = notedWord(a.period);
			return { text: a.state === 'active' ? `${t.route.activeWord} ${noted}` : noted, caution: false };
		}
		if (a?.state === 'active' && a.reason !== 'permanent') {
			return activeWord(ev.key);
		}
		return a?.state === 'activable' ? { text: cautionWord(a.reason), caution: true } : null;
	}

	/** The unit that knows a zone's activity, for a Frequency cell its own
	 *  radio leaves empty (data/knownFrom.ts askUnitText). */
	function knownUnit(ev: RouteAirspaceEvent): string | null {
		return askUnitText(bandKnownFrom(ev.key));
	}

	// Continuation-card slice: the events THIS card renders. Bounds clamp to
	// the live schedule, and the LAST part always runs to the end: the split
	// was measured moments before printing, but a terrain refinement landing
	// in between can shift the event list, and a clamped tail must widen
	// rather than drop rows off the paper.
	const evFrom = $derived(rowRange ? Math.min(Math.max(0, rowRange.from), rows.length) : 0);
	const evTo = $derived(
		!rowRange || (part && part.index === part.count) ? rows.length : Math.min(rows.length, rowRange.to),
	);
	const cardRows = $derived(rows.slice(evFrom, evTo));

	/** Whether the live overlay has the row passed: a schedule row's own
	 *  answer, a temporary zone's that of the first schedule row at or past
	 *  its distance. */
	function rowPassed(row: { ev: RouteAirspaceEvent; raw: number | null }): boolean {
		if (!liveOn || !live) {
			return false;
		}
		if (row.raw !== null) {
			return live.rows[row.raw]?.passed ?? false;
		}
		return rows.some((r) => r.raw !== null && r.ev.atNM >= row.ev.atNM && (live.rows[r.raw]?.passed ?? false));
	}

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
	 * named on the tooltip (same row height: inline text only). A channel
	 * naming no station is listed under the zone, as every surface lists it
	 * (airspaceRadioLabel). */
	function openRadioText(ev: RouteAirspaceEvent): string {
		const zone = zoneLabel(ev.type, ev.name);
		return radioSummary(ev.radio.filter((r) => !r.closed), (r) => airspaceRadioLabel(r, zone));
	}

	function closedRadioText(ev: RouteAirspaceEvent): string {
		const zone = zoneLabel(ev.type, ev.name);
		return radioSummary(ev.radio.filter((r) => r.closed), (r) => airspaceRadioLabel(r, zone));
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
	const hover = useAirspaceHover(() => cardRows.map((r) => r.ev));
</script>

<section class="sched" class:kneeboard class:portrait class:compact={compactMode} class:flat={flatMode}>
	<h3>{headingText}</h3>
	{#if !dataState.airspacesLoaded}
		<!-- A failed fetch clears the loading flag but never sets loaded, so a
		     bare "Loading" would show forever; the error flag tells them apart. -->
		<p class="muted">
			{dataState.airspacesError != null ? t.navlog.airspacesUnavailable : t.navlog.loadingAirspaces}
		</p>
	{:else if rows.length === 0}
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
					{#snippet cells(ev: RouteAirspaceEvent, raw: number | null)}
						{@const chip = airspaceScheduleBadge(ev)}
						{@const typeTitle = (t.data.airspaceTypes as Record<string, string>)[ev.type] ?? ev.type}
						{@const lrow = liveOn && raw !== null ? (live?.rows[raw] ?? null) : null}
						{@const word = zoneWord(ev)}
						{@const known = word && !ev.radio.length ? knownUnit(ev) : null}
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
							     ...), so a row reads "R 212", not "R R 212". A temporary zone
							     wears its source, its name carrying its kind ("ZRT 'BLOIS'"). -->
							<!-- i18n-ignore-start: SUP and NOTAM are ICAO abbreviations, ZSM the AIP's, locale-invariant -->
							{#if ev.key.startsWith('sup:')}<span class="chip chip--supaip">SUP</span
								>{:else if isZsmBandKey(ev.key)}<span class="chip chip--zsm">ZSM</span
								>{:else if ev.key.startsWith('notam:')}<span class="chip chip--notam">NOTAM</span
								>{:else}{#if chip}<span class={chipClass(chip)} title={chip.text === ev.type ? typeTitle : undefined}
									>{chip.text}</span
								>{/if}{#if !chip || chip.text !== ev.type}<span class="as-type" title={typeTitle}>{ev.type}</span
								>{/if}{/if} {ev.name}
							<!-- i18n-ignore-end -->
							{#if band(ev.vLower, ev.vUpper)}
								<span class="as-band">{band(ev.vLower, ev.vUpper)}</span>
							{/if}
							{#if word}
								<span class={['zone-word', word.caution && 'caution']}>{word.text}</span>
							{/if}
							{#if liveOn && raw !== null && live?.chip != null && raw === live.chip.rowIdx}
								<span class="live-chip" title={t.navigation.contactBoundary}
									>{fmtNM(live.chip.toNM)} NM{live.chip.eteMin != null
										? ` · ${fmtDurationMin(live.chip.eteMin)}`
										: ''}</span
								>
							{/if}
						</td>
						<td
							>{#if known}<span class="known" title={t.zones.knownOn(known)}>{known}</span
								>{:else}{openRadioText(ev) || (closedRadioText(ev) ? '' : '–')}{/if}{#if closedRadioText(ev)}
								<s class="freq-closed" title={closedRadioTip(ev)}>{closedRadioText(ev)}</s
								>{/if}{#if ev.freqFlaggedBy?.length}<span
									class="freq-flag"
									title={t.navlog.freqFlaggedTip(ev.freqFlaggedBy.join(', '))}
									><Icon name="alert-triangle" size={9} /></span
								>{/if}</td
						>
					{/snippet}
					{#each cardRows as row, i (row.ev.kind + '|' + row.ev.key + '|' + i)}
						{@const ev = row.ev}
						{@const raw = row.raw}
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
								class:passed={rowPassed(row)}
								class:current={liveOn && raw !== null && raw === live?.currentRowIdx}
								class:next={liveOn && raw !== null && raw === live?.nextRowIdx}
								aria-current={liveOn && raw !== null && raw === live?.currentRowIdx ? 'step' : undefined}
								tabindex="0"
								onclick={() => onAirspace(ev.key)}
								onkeydown={(e) => onAirspaceKey(e, ev.key)}
								onmouseenter={() => hover.set(ev.key)}
								onmouseleave={() => hover.set(null)}
								onfocus={() => hover.set(ev.key)}
								onblur={() => hover.set(null)}
							>
								{@render cells(ev, raw)}
							</tr>
						{:else}
							<tr
								class="ev"
								class:plan-only={planOnly}
								class:passed={rowPassed(row)}
								class:current={liveOn && raw !== null && raw === live?.currentRowIdx}
								class:next={liveOn && raw !== null && raw === live?.nextRowIdx}>{@render cells(ev, raw)}</tr
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

	/* Each ink on a 10% tint of itself, held to AA in both themes and on
	   paper, where the print palette's --danger is #d40000 (4.62:1 here,
	   4.42:1 on the alert banner's 12%; tests/contrast.spec.ts). The fixed
	   tints these replace measured 4.23:1 by day and 3.52:1 at night for the
	   green, and 2.52:1 at night for the red, a fill ink never meant as text. */
	.badge.enter {
		color: var(--status-active);
		background: color-mix(in srgb, var(--status-active) 10%, transparent);
	}

	.badge.leave {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
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

	/* A zone's state at its crossing, the profile strip's words: ACTIVE in
	   the row's ink, a crossing to confirm in the caution ink. */
	.zone-word {
		margin-left: 6px;
		font-size: 10px;
		font-weight: 700;
	}

	.zone-word.caution {
		font-weight: 600;
		color: var(--workbook-orange);
	}

	/* The unit that knows a zone's activity, in a Frequency cell the zone's
	   own radio leaves empty: a unit to ask, set apart from a channel to set. */
	.known {
		font-style: italic;
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

	/* A category chip labels with the ink theme.css pairs with its fill: the
	   accent text measured 3.10:1 on the day transit orange, on screen and on
	   paper. */
	.chip--restricted {
		color: var(--on-airspace-restricted);
		background: var(--airspace-restricted);
	}

	.chip--transit {
		color: var(--on-airspace-transit);
		background: var(--airspace-transit);
	}

	.chip--trafficmgmt {
		color: var(--on-airspace-trafficmgmt);
		background: var(--airspace-trafficmgmt);
	}

	/* SIV / activity: the empty filled square (the chart's SIV mark), the
	   chip box squared. */
	.chip--siv {
		color: var(--on-airspace-siv);
		background: var(--airspace-siv);
	}

	.chip--activity {
		color: var(--on-airspace-activity);
		background: var(--airspace-activity);
	}

	/* A temporary zone's source: the supplement's magenta, the NOTAM orange,
	   each fixed across themes under white figures. */
	.chip--supaip {
		color: #fff;
		background: var(--supaip);
	}

	.chip--notam {
		color: #fff;
		background: var(--notam-cue);
	}

	.chip--zsm {
		color: #fff;
		background: var(--zsm);
	}

	.chip--sq {
		width: 13px;
		min-width: 0;
		padding: 0;
	}

	/* ---- live overlay (the interactive mount and the A4 page mounts,
	   whose measuring mount carries the same overlay; liveOn gates on
	   !kneeboard, so the measured CARD packing never sees these) ----
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

	/* A change the resolver could not place on the sector's rows: the nav
	   log's sign, in the advisory ink, sized to the cell's text so the row
	   keeps its height. The tooltip names the NOTAMs. */
	.freq-flag {
		margin-left: 3px;
		color: var(--workbook-orange);
	}

	.freq-flag :global(svg) {
		width: 1em;
		height: 1em;
		vertical-align: -0.15em;
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

	/* ---- phone rendition (the `compact` prop) ----
	   The modal body gives up its padding on a phone, so the table runs to
	   both edges of the pane, its first and last cells insetting their own
	   text; the heading and the one-line notes are bare text and keep that
	   inset themselves. Screen only, like the sheet's compact block, so no
	   print can ever take it. */
	@media screen {
		.sched.compact h3,
		.sched.compact > .muted {
			padding-inline: 8px;
		}
	}

	/* The desktop's flat log (the sheet's `flat` block): the modal body gives
	   up its padding, so the heading, the notes and the table's outer cells
	   take a 12 px inset of their own. Screen only. */
	@media screen {
		.sched.flat h3,
		.sched.flat > .muted {
			padding-inline: 12px;
		}

		.sched.flat .nav :is(th, td):first-child {
			padding-left: 12px;
		}

		.sched.flat .nav :is(th, td):last-child {
			padding-right: 12px;
		}
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

	/* The row's words at the card's 9px, like the name beside them: the
	   enter / leave badge, the band and the zone's word. */
	.kneeboard .badge,
	.kneeboard .as-band,
	.kneeboard .zone-word {
		font-size: 9px;
	}

	.kneeboard .badge {
		padding: 1px 5px;
	}

	/* The enter / leave badge column holds the widest badge inside the
	   cell's padding: "Entrée", 43.5px in Bitstream Vera Sans Bold
	   (fontconfig's system-ui on Fedora). Narrower, the badge runs under
	   the airspace's chip in the next cell. */
	.kneeboard .nav th:nth-child(3) {
		width: 54px;
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

	/* ---- A4 page rendition (the `portrait` prop) ----
	   The same slice-invariance at page scale, for the same reason: the
	   A4 document's parts were measured on the FULL table, and an auto
	   layout re-deriving each part's column widths from its own rows
	   would wrap names the measure never saw and spill the part past its
	   sheet. Media-independent like the kneeboard block, so the measuring
	   mount lays out on screen what the page prints
	   (tests/navlogPaper.spec.ts pins the mounts carry it). */
	.portrait .scroll {
		overflow: visible;
	}

	.portrait table.nav {
		table-layout: fixed;
	}

	.portrait .nav th.num {
		width: 52px;
	}

	.portrait .nav th:nth-child(3) {
		width: 60px;
	}

	.portrait .nav th:nth-child(5) {
		width: 31%;
	}

	.portrait .ev td {
		overflow-wrap: break-word;
	}

	@media print {
		/* Portrait single-route print, UNPREPARED (the browser's own print
		   over the open surface): start the schedule on its own page. The
		   two prepared
		   documents place it themselves - the A4 one gives each measured part
		   its own page, the kneeboard lays parts out two-up on their own sheet
		   (see NavLogModal) - and a forced break inside a box that already
		   opens a page is how a blank sheet gets printed. */
		:global(html.navlog-print:not(.navlog-kneeboard, .navlog-paged)) .sched {
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
