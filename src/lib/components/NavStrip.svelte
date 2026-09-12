<script lang="ts">
	/* The in-flight strip: the live figures, over the map, whatever else is on
	 * screen.
	 *
	 * Until this existed every live number lived in the Navigation tab, and the
	 * sidebar unmounts a tab as soon as another is selected, so opening Layers
	 * or Weather destroyed the whole readout; on a phone the sheet covers the
	 * map, making map and instruments mutually exclusive. The band floats over
	 * the map instead (a child of .map-wrap, the CursorCoords precedent), so it
	 * changes no layout and costs the Leaflet container no resize.
	 *
	 * It is deliberately NOT a workspace surface: the registry has three slots
	 * and opening a surface evicts the slot's incumbent, so a strip in one
	 * would fight the nav log and the profiles it exists to sit beside
	 * (src/lib/surfaces.ts).
	 *
	 * Reading order is in-flight priority, which is not the planner's: any
	 * warning, then who to talk to and on what, then where the aircraft is
	 * going and how far off course it is, then the raw instruments. The
	 * frequency is the largest thing on the band because reading it at arm's
	 * length in turbulence is the task this surface exists for. */
	import AlertPanel from './AlertPanel.svelte';
	import Icon from './Icon.svelte';
	import InstrumentTiles from './InstrumentTiles.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { copyText } from '$lib/ui/clipboard';
	import { contactLines, type ContactLine } from '$lib/format/radio';
	import { fmtClockUtc, fmtDurationMin, fmtDurationMs, fmtNM, fmtTrack } from '$lib/route/format';
	import { OFF_ROUTE_NM } from '$lib/nav/navlogLive';
	import { handoverDue } from '$lib/nav/contactChain';
	import { traceEndMs } from '$lib/nav/trace';
	import { alertAnnounce, alertLine, openAlertPanel } from './alertText';
	import { decimalYearFromDate, magneticFromTrue } from '$lib/route/magnetic';
	import { steerDeg } from '$lib/nav/steering';
	import { altCorrectionFt } from '$lib/nav/altitudeDatum';
	import {
		nav,
		currentPose,
		poseAltMslFt,
		positionQuality,
		traceAltDatum,
	} from '$lib/state/navRecording.svelte';
	import { acknowledgeAlert, alertSurfaceNow } from '$lib/state/airspaceAlert.svelte';
	import { autoStop, keepRecording } from '$lib/state/autoStop.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { navLiveNow, type NavContactUnit } from '$lib/state/navLive.svelte';
	import { overflownAirport } from '$lib/state/navOverflight.svelte';
	import { navRouteId } from '$lib/state/navRoute.svelte';
	import { navStrip, setStripHidden, toggleStripCollapsed } from '$lib/state/navStrip.svelte';
	import { navLogModal, toggleNavLog } from '$lib/state/navLogModal.svelte';
	import { routes } from '$lib/state/route.svelte';
	import { selectAirport, ui } from '$lib/state/ui.svelte';
	import { routeEndpointLabel } from '$lib/route/routeLabel';

	const pose = $derived(currentPose());
	const quality = $derived(positionQuality());
	const info = $derived(navLiveNow());
	const stale = $derived(quality !== 'good');

	/** Which route of a chained plan the band is answering for. Named only
	 *  when there is more than one, since a single route needs no saying, and
	 *  it leads the band because it qualifies everything after it. */
	const flownLabel = $derived.by(() => {
		const flyable = routes.list.filter((r) => r.waypoints.length >= 2);
		if (flyable.length < 2) {
			return null;
		}
		const flown = flyable.find((r) => r.id === navRouteId());
		return flown ? routeEndpointLabel(flown, t.route.newRoute) : null;
	});

	/** The strip has a JOB: a live recording, a running or scrubbed replay
	 *  (the playhead strictly before the trace end is a debrief in
	 *  progress), or a flyable route (planning wants the contact, waypoint
	 *  and ETA cells). Outside those the bar is flight furniture with no
	 *  flight, the SkyDemon planning/flying split: it stands down to the
	 *  restore handle, and the session-only idleOpen peek brings the
	 *  frozen readout back for a look. */
	const stripPosture = $derived.by(() => {
		if (nav.recording || nav.playing) {
			return true;
		}
		const end = traceEndMs(nav.points);
		if (end != null && nav.playheadMs < end) {
			return true;
		}
		return routes.list.some((r) => r.waypoints.length >= 2);
	});

	/** Up while there is a position to report AND a reason to report it. */
	const shown = $derived(
		!navStrip.hidden && (pose != null || nav.recording) && (stripPosture || navStrip.idleOpen),
	);

	/** The X: dismissing a peek is not a standing preference, so it only
	 *  clears the peek; in a working posture it persists as today. */
	function hideStrip(): void {
		navStrip.idleOpen = false;
		if (stripPosture) {
			setStripHidden(true);
		}
	}

	/** The handle: one tap always shows the strip, whatever kept it down. */
	function restoreStrip(): void {
		if (navStrip.hidden) {
			setStripHidden(false);
		}
		navStrip.idleOpen = true;
	}

	// ---- the airspace-alert surface (docs/nav-alerts.md) ----
	// The annunciator / record / status split: ONE banner row carries the
	// dominant unacknowledged alert (the SkyDemon warning grammar: the body
	// opens the details, the cross acknowledges), the chip carries the
	// channel's state while anything alerts and opens the panel, and the
	// panel lists everything else. nav/alertSurface.ts decides what shows.
	const model = $derived(alertSurfaceNow());

	/** The alert panel, anchored at the chip (the FiltersPopover idiom). */
	let panelOpen = $state(false);
	let panelPos = $state({ x: 0, y: 0 });
	let chipEl = $state<HTMLElement | null>(null);

	function openPanel(): void {
		const r = chipEl?.getBoundingClientRect();
		if (r) {
			panelPos = { x: r.left, y: r.bottom + 4 };
		}
		panelOpen = true;
	}

	/** The chip's accessible name: the channel state with the counts,
	 *  number-last so neither language needs agreement. */
	function chipLabel(): string {
		const n = t.navigation;
		const c = model.chip;
		if (!c) {
			return n.alertsSection;
		}
		if (c.kind === 'alerts') {
			const base = n.alertChipActive(String(model.badge.unacked));
			return model.badge.acked > 0
				? `${base}, ${n.alertChipAcked(String(model.badge.acked))}`
				: base;
		}
		if (c.kind === 'acked') {
			return n.alertChipAllAcked;
		}
		return model.suspended === 'noFix' ? n.alertSuspendedNoFix : n.alertChipSuspended;
	}

	/** A safety banner must not be hidden by a comfort preference: an
	 *  unacknowledged warning renders the banner alone even while the strip
	 *  itself is dismissed, and so does the suspension line while a
	 *  recording runs (the channel's failure is itself safety information).
	 *  Planned advisories and cautions respect the dismissal. */
	const bare = $derived(
		!shown && ((pose != null && model.bannerEscapes) || model.suspended != null),
	);

	/** The auto-stop countdown (state/autoStop.svelte). It renders even on a
	 *  hidden or collapsed strip: the recording is about to end itself and
	 *  release the screen, which is worth a line wherever the band is. */
	const stopPending = $derived(autoStop.pending);
	const stopRemainMs = $derived(stopPending ? Math.max(0, stopPending.stopAtMs - nav.nowMs) : 0);

	// Magnetic, like the nav log's MC / MH columns: GNSS reports track in true,
	// and a true track shown beside a magnetic bearing is a trap in the cockpit.
	const trackMagDeg = $derived.by(() => {
		if (!pose || pose.trackDeg == null) {
			return null;
		}
		return magneticFromTrue(
			pose.trackDeg,
			pose.lat,
			pose.lon,
			decimalYearFromDate(new Date(nav.playheadMs)),
		);
	});

	const altMslFt = $derived(pose ? poseAltMslFt(pose) : null);
	const altTip = $derived.by(() => {
		const datum = traceAltDatum();
		const source = t.navigation.altDatumSource[datum];
		if (datum === 'msl' || !pose) {
			return t.navigation.altitudeTip(source, t.navigation.altDatumCorrection.none);
		}
		const sep = Math.round(altCorrectionFt(pose.lat, pose.lon, datum));
		return t.navigation.altitudeTip(source, t.navigation.altDatumCorrection.applied(String(sep)));
	});

	const st = $derived(info?.log.state ?? null);
	const contact = $derived(info?.contact ?? null);
	/** The turn onto the bearing, which the band showed only as its two
	 *  operands, in cells that are not adjacent: the pilot did the subtraction.
	 *  Both angles magnetic (see trackMagDeg above), so the difference is
	 *  meaningful without a datum note. */
	const steerText = $derived.by(() => {
		const brg = info?.log.bearingMagDeg ?? null;
		if (brg == null || trackMagDeg == null) {
			return null;
		}
		const deg = Math.round(steerDeg(brg, trackMagDeg));
		if (deg === 0) {
			return t.navigation.steerNone;
		}
		const abs = String(Math.abs(deg));
		return deg < 0 ? t.navigation.steerLeft(abs) : t.navigation.steerRight(abs);
	});
	// The overflown aerodrome: the band's one position-resolved cell, up with
	// or without a route (state/navOverflight).
	const over = $derived(overflownAirport());
	// Everything route-referenced is answering for a route the aircraft is not
	// on. It stays on the band (it is still the plan, and the plan is what the
	// pilot is rejoining), but muted and captioned rather than confident.
	const planOnly = $derived(info?.planOnly === true);
	const arrived = $derived(st?.arrived ?? false);
	const nextEtoMs = $derived(
		st && st.currentLegIdx != null ? (st.wpts[st.currentLegIdx + 1]?.etoMs ?? null) : null,
	);
	/** The destination ETA: the estimate chain's LAST entry, the nav-log
	 *  modal's bottom row (recalage-corrected at the live GS). The vendors'
	 *  bars all carry it as a first-class field beside the next-waypoint
	 *  figures; here it rides the flown-route cell of a multi-route plan
	 *  and its own cell otherwise. */
	const destEtoMs = $derived(
		st && st.wpts.length > 0 ? (st.wpts[st.wpts.length - 1].etoMs ?? null) : null,
	);
	/** One clock per meaning on a phone line: while the destination ETA is
	 *  displayed, the next-waypoint trail keeps dist and ETE and drops its
	 *  ETO (the SkyDemon Next/Dest split); desktop has room for both. */
	const showNextEto = $derived(
		nextEtoMs != null && (!ui.isMobile || destEtoMs == null),
	);
	/** How the flight is running against its own plan, in WORDS rather than a
	 *  signed number: an arbitrary sign convention has to be taught, and the
	 *  tooltip that would teach it is exactly what a mounted touch device does
	 *  not show. Rides the destination ETA, the figure it qualifies. Under
	 *  half a minute reads as on plan rather than as nothing, the XTK cell's
	 *  "on course" rule: silence would be indistinguishable from unknown.
	 *
	 *  Desktop band only. Measured on a 392 px phone, the words push line A
	 *  36 px past its width and the ETA cell clips mid-word; the phone band is
	 *  two designed lines that FIT, so a figure that does not fit yields to
	 *  the one it qualifies, exactly as the next-waypoint ETO yields to the
	 *  destination ETA there. */
	const planText = $derived.by(() => {
		const d = st?.planDeltaMin ?? null;
		if (d == null) {
			return null;
		}
		const min = Math.round(Math.abs(d));
		if (min === 0) {
			return t.navigation.planOnTime;
		}
		return d > 0 ? t.navigation.planLate(String(min)) : t.navigation.planEarly(String(min));
	});

	/** The next contact's lead figure, shared by the desktop cell and the
	 *  phone's transient line so the two can never word it differently. */
	const nextTrail = $derived(
		contact?.toBoundaryNM != null
			? `${fmtNM(contact.toBoundaryNM)} NM${contact.eteMin != null ? ` · ${fmtDurationMin(contact.eteMin)}` : ''}`
			: '',
	);

	/** The phone band has no room for a permanent next-contact cell (line A
	 *  budgets three cells across 390 px), so it raises one only inside the
	 *  handover window, where the call has to be made. Desktop carries the
	 *  cell throughout and needs no window. */
	const nextDue = $derived(
		ui.isMobile &&
			contact?.next != null &&
			handoverDue(contact.toBoundaryNM, contact.eteMin),
	);

	/** Whether line A (the who-to-talk-to line) has anything to say. The
	 *  collapse keeps line A and folds the instruments; with line A EMPTY
	 *  that folded to a bar of nothing, so the instruments ignore the
	 *  collapse when this is false, and the collapse control hides (it
	 *  would change nothing). */
	const lineAContent = $derived(
		flownLabel != null ||
			contact?.current != null ||
			over != null ||
			(nav.recording && !nav.lastFix) ||
			(info != null && (arrived || info.log.nextIdent != null)) ||
			(flownLabel == null && destEtoMs != null && !arrived),
	);

	/** Whether the collapse control would change anything: without that it
	 *  is dead weight (a no-route phone strip once toggled between "tiles"
	 *  and an almost-empty bar). A collapsed strip stays eligible so a
	 *  persisted-collapsed strip can always expand back. On the phone the
	 *  collapse hides line B (the compact instruments), which exists with a
	 *  pose; on desktop it hides the guarded cell set. */
	const collapsible = $derived(
		lineAContent &&
			(ui.isMobile
				? pose != null
				: contact?.next != null || over != null || pose != null || (nav.recording && !nav.lastFix)),
	);


	/** The unit's voice services, the one to CALL first (format/radio).
	 *
	 *  The band shows ONE channel per line. A unit published on several
	 *  ("118.200 / 120.700") is more than twice as wide as one, and it is the
	 *  only thing that made the frequency's width unbounded; the others ride
	 *  the tooltip and the revealed row. You tune one channel anyway. */
	function lines(u: NavContactUnit): ContactLine[] {
		return contactLines(u.radio, u.kind);
	}

	/** The aerodrome whose full frequency list is unfolded, by ident. Keyed by
	 *  ident rather than held as a boolean so a handover closes it on its own:
	 *  the row renders only while that field is still one of the two contacts
	 *  or the field being overflown, and a field the flight has left cannot
	 *  leave its list on the band. */
	let revealed = $state<string | null>(null);
	/** The unfolded field and its lines, or null. Collapsing the strip closes
	 *  it too: the point of collapsing is to see less. `chain` says the unit is
	 *  one of the route-referenced contacts, the ones the plan-only muting
	 *  qualifies; the overflown field is the position itself. */
	const revealedUnit = $derived.by(() => {
		if (revealed == null || navStrip.collapsed) {
			return null;
		}
		const chain = [contact?.current, contact?.next].find((c) => c?.ident === revealed);
		const u = chain ?? (over?.unit.ident === revealed ? over.unit : undefined);
		return u ? { unit: u, lines: lines(u), chain: chain != null } : null;
	});

	/** Escape folds the revealed frequency rows away (the alert panel owns
	 *  its own Escape through HeadOverlay). Bound only while open, so the
	 *  strip adds no window listener to the common case. */
	$effect(() => {
		if (revealed == null) {
			return;
		}
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				revealed = null;
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	let copied = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	async function copyFreq(freq: string): Promise<void> {
		if (!(await copyText(freq))) {
			return;
		}
		copied = freq;
		if (copyTimer != null) {
			clearTimeout(copyTimer);
		}
		copyTimer = setTimeout(() => (copied = null), 1500);
	}

	// The band's own height, published so the Leaflet controls can step clear
	// of it rather than sitting under it.
	let el = $state<HTMLElement | null>(null);
	$effect(() => {
		const node = el;
		if (!node) {
			return;
		}
		const publish = (): void => {
			node.parentElement?.style.setProperty('--nav-strip-h', `${node.offsetHeight}px`);
		};
		publish();
		const ro = new ResizeObserver(publish);
		ro.observe(node);
		return () => {
			node.parentElement?.style.removeProperty('--nav-strip-h');
			ro.disconnect();
		};
	});
</script>

<!-- Only ever rendered for a unit that exists: a labelled dash on the band is
     one more thing to read past on a surface whose whole point is that there
     is nothing to read past. The plan-only muting spares the 'over' cell: the
     overflown field is resolved from the position itself, exactly what the
     muting says the chain's answers are not. -->
{#snippet unitCell(unit: NavContactUnit, kind: 'current' | 'next' | 'over', trailing: string)}
	{@const all = lines(unit)}
	{@const p = all[0]}
	{@const revealable = unit.kind === 'aerodrome' && unit.ident != null && all.length > 1}
	<div
		class="cell contact"
		class:next={kind === 'next'}
		class:over={kind === 'over'}
		class:plan-only={planOnly && kind !== 'over'}
	>
		<!-- On a phone `next` only ever renders on the transient handover line,
		     where the full label costs the width the lead figure needs. -->
		<span class="k"
			>{kind === 'current'
				? t.navigation.contactCurrent
				: kind === 'next'
					? ui.isMobile
						? t.navigation.contactNextShort
						: t.navigation.contactNext
					: t.navigation.contactOverflight}</span
		>
		<!-- The chevron sits INSIDE the label's reserved width, so an aerodrome
		     taking the contact from an airspace does not move the cell: the label
		     ellipsises one character earlier instead. -->
		{#if revealable}
			<button
				type="button"
				class="unit unit-btn"
				title={unit.label}
				aria-expanded={revealed === unit.ident}
				aria-label={revealed === unit.ident ? t.navigation.freqHide : t.navigation.freqShow}
				onclick={() => (revealed = revealed === unit.ident ? null : unit.ident)}
			>
				<span class="unit-name">{unit.label}</span>
				<Icon name={revealed === unit.ident ? 'chevron-up' : 'chevron-down'} size={11} />
			</button>
		{:else}
			<span class="unit" title={unit.label}>{unit.label}</span>
		{/if}
		{#if p}
			<span class="freq-row">
				<button
					type="button"
					class="freq"
					class:copied={copied === p.freq}
					title={p.all === p.freq
						? t.navigation.copyFreq(p.label)
						: `${t.navigation.copyFreq(p.label)} · ${p.all}`}
					aria-label={t.navigation.copyFreq(p.label)}
					onclick={() => void copyFreq(p.freq)}>{p.freq}</button
				>
				<!-- This unit answers where a NOTAM-closed sector would have: the
				     marker says WHY the frequency is not the published sector's
				     own, and its tooltip names the sector and the NOTAM. Same
				     chan-flag dress as the unfold rows' stale-list marker. -->
				{#if unit.closedBy}
					<span
						class="chan-flag"
						title={t.navigation.contactClosedBy({
							unit: unit.closedBy.closedLabel,
							id: unit.closedBy.notamId,
						})}
					>
						<Icon name="alert-triangle" size={11} />
					</span>
				{/if}
			</span>
		{/if}
		{#if trailing}<span
				class="trail"
				class:boundary={kind === 'next'}
				class:dist={kind === 'over'}>{trailing}</span
			>{/if}
	</div>
{/snippet}

{#snippet flownCell()}
	{#if flownLabel}
		<div class="cell" class:plan-only={planOnly} title={t.navigation.flownRouteTip}>
			<span class="k">{t.navigation.flownRoute}</span>
			<span class="unit">{flownLabel}</span>
			{#if planOnly}
				<span class="trail plan-note" title={t.navigation.planOnlyTip(String(OFF_ROUTE_NM))}
					>{t.navigation.planOnly}</span
				>
			{/if}
			{#if destEtoMs != null && !arrived}
				<!-- i18n-ignore: ETA is an ICAO Doc 8400 abbreviation, locale-invariant like the tile keys; the title spells it out -->
				<span class="trail" title={t.navigation.navlogEta}>ETA {fmtClockUtc(destEtoMs)}Z</span>
			{/if}
			{#if planText && !ui.isMobile}
				<span class="trail plan" title={t.navigation.planDeltaTip}>{planText}</span>
			{/if}
		</div>
	{:else if planOnly}
		<div class="cell" title={t.navigation.planOnlyTip(String(OFF_ROUTE_NM))}>
			<span class="k">{t.navigation.xtk}</span>
			<span class="unit plan-note">{t.navigation.planOnly}</span>
		</div>
	{/if}
{/snippet}

{#snippet waypointCell()}
	{#if info && !arrived && info.log.nextIdent}
		<div class="cell">
			<span class="k">{t.navigation.navlogNext}</span>
			<span class="unit">{info.log.nextIdent}</span>
			{#if info.log.pinnedLegIdx != null}
				<!-- The log is reading a segment the pilot set, not one it worked
				     out: a correction is a state, so it shows while it stands.
				     Appearing and disappearing reflows the band, which is the
				     event it is. -->
				<span class="trail plan-note" title={t.navigation.flownLegTip}
					>{t.navigation.legByHand}</span
				>
			{/if}
			<span class="trail leg"
				>{info.log.nextDistNM != null ? `${fmtNM(info.log.nextDistNM)}${ui.isMobile ? '' : ' NM'}` : ''}{info.log
					.nextEteMin != null
					? ` · ${fmtDurationMin(info.log.nextEteMin)}`
					: ''}{showNextEto && nextEtoMs != null ? ` · ${fmtClockUtc(nextEtoMs)}Z` : ''}</span
			>
		</div>
	{:else if arrived}
		<div class="cell">
			<span class="k">{t.navigation.navlogEta}</span>
			<span class="unit">{t.navigation.navlogArrived}</span>
		</div>
	{/if}
{/snippet}

{#snippet etaCell()}
	<!-- The single-route home of the destination ETA (a multi-route plan
	     carries it on the flown-route cell instead). The label is the bare
	     Doc 8400 abbreviation; the tooltip says destination. -->
	{#if flownLabel == null && destEtoMs != null && !arrived}
		<div class="cell eta" class:plan-only={planOnly} title={t.navigation.navlogEta}>
			<!-- i18n-ignore: ETA is an ICAO Doc 8400 abbreviation, locale-invariant like the tile keys; the title spells it out -->
			<span class="k">ETA</span>
			<span class="unit">{fmtClockUtc(destEtoMs)}Z</span>
			{#if planText && !ui.isMobile}
				<span class="trail plan" title={t.navigation.planDeltaTip}>{planText}</span>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet steerPair()}
	{#if steerText}
		<span class="pair" title={t.navigation.steerTip}>
			<span class="k">{t.navigation.steer}</span>
			<span class="num steer-val">{steerText}</span>
		</span>
	{/if}
{/snippet}

{#snippet xtkPair()}
	{#if info}
		<span class="pair" title={t.navigation.xtkTip}>
			<!-- i18n-ignore: XTK is an ICAO Doc 8400 abbreviation; the title spells it out -->
			<span class="k">XTK</span>
			<span class="num xtk" class:off-route={info.log.offRoute}
				>{info.log.xtkSide === 0 || (info.log.xtkNM ?? 0) < 0.1
					? t.navigation.onCourse
					: `${fmtNM(info.log.xtkNM ?? 0)} NM ${info.log.xtkSide > 0 ? t.navigation.xtkRight : t.navigation.xtkLeft}`}</span
			>
		</span>
	{/if}
{/snippet}

{#if shown || bare || stopPending}
	<aside
		class="nav-strip no-print"
		class:collapsed={navStrip.collapsed}
		bind:this={el}
		aria-label={t.navigation.stripLabel}
	>
		<!-- The alert before everything: the review's in-flight reading order
		     starts at "any warning". ONE banner row carries the dominant
		     unacknowledged alert (the SkyDemon warning grammar: the body
		     opens the volume's detail panel, the cross acknowledges,
		     escalation past the acknowledged severity re-alerts); the chip
		     leads the row, states the channel's state, and
		     opens the alert panel where everything else lists. All
		     acknowledged collapses the row to the lone muted chip; a
		     suspended evaluation states itself instead of leaving a blank
		     (docs/nav-alerts.md "Presentation"). -->
		{#snippet chipBtn()}
			{#if model.chip}
				{@const c = model.chip}
				<button
					type="button"
					bind:this={chipEl}
					class="alert-chip"
					class:ink-danger={c.ink === 'danger'}
					class:ink-caution={c.ink === 'caution'}
					class:ink-muted={c.ink === 'muted'}
					class:solid={c.solid}
					aria-expanded={panelOpen}
					aria-label={chipLabel()}
					title={t.navigation.alertPanelOpenTip}
					onclick={openPanel}
				>
					{#if c.kind === 'alerts'}
						<Icon name="alert-triangle" size={11} /><span class="n">{model.badge.unacked}</span>
					{:else if c.kind === 'acked'}
						<Icon name="check" size={11} /><span class="n">{model.badge.acked}</span>
					{:else}
						<Icon name="alert-triangle" size={11} />
					{/if}
				</button>
			{/if}
		{/snippet}
		{#if model.suspended != null || model.banner}
			<!-- The announcement is its own element: the banner's text carries a
			     distance and a countdown that change on every fix, and an
			     assertive region announcing those interrupts continuously. This
			     one says the same thing without the numbers, so it speaks when
			     the alert appears, escalates, or the evaluation suspends. -->
			<p class="sr-only" aria-live="assertive">
				{model.suspended != null
					? model.suspended === 'lost'
						? t.navigation.alertSuspendedLost
						: t.navigation.alertSuspendedNoFix
					: model.banner
						? alertAnnounce(model.banner)
						: ''}
			</p>
		{/if}
		{#if model.suspended != null}
			<!-- lost wears danger (a live position stopped); noFix wears the
			     calm acquiring dress (a recording waiting for its first fix
			     is normal start-up, not a failure). -->
			<div
				class="alert alert-banner"
				class:lost={model.suspended === 'lost'}
				class:acquiring={model.suspended === 'noFix'}
				role="status"
				title={model.suspended === 'lost'
					? t.navigation.alertSuspendedLostTip
					: t.navigation.alertSuspendedNoFixTip}
			>
				{@render chipBtn()}
				<span class="alert-text"
					>{model.suspended === 'lost'
						? t.navigation.alertSuspendedLost
						: t.navigation.alertSuspendedNoFix}</span
				>
			</div>
		{:else if model.banner}
			{@const b = model.banner}
			<div
				class="alert alert-banner"
				class:avoid={b.action === 'avoid' && !b.planned}
				class:caution={b.action === 'caution'}
				class:inside={b.severity === 'inside' && !b.planned}
				class:planned={b.planned}
			>
				{@render chipBtn()}
				<button
					type="button"
					class="alert-open"
					title={t.navigation.alertOpenTip}
					onclick={() => model.banner && openAlertPanel(model.banner)}>{alertLine(b)}</button
				>
				<button
					type="button"
					class="alert-ack"
					title={t.navigation.alertAckTip}
					aria-label={t.navigation.alertAckLabel}
					onclick={() => model.banner && acknowledgeAlert(model.banner.key)}
				>
					<Icon name="x" size={13} />
				</button>
			</div>
		{/if}

		<!-- The recording is about to end itself: a countdown, not an alarm
		     (the landing is the normal end of a flight), so it reads in the
		     alert family's stepped-back form under the safety banner above.
		     A timer role rather than a live region: a region would announce
		     every second of the tick. The button answers for THIS landing;
		     the next one arms the countdown again (docs/nav-live.md). -->
		{#if stopPending}
			<div class="alert stop-soon" role="timer" aria-label={t.navigation.autoStopLabel}>
				<Icon name="stop" size={13} />
				<span class="stop-count">{t.navigation.autoStopCountdown(fmtDurationMs(stopRemainMs))}</span>
				<button type="button" class="stop-keep" title={t.navigation.autoStopKeepTip} onclick={keepRecording}
					>{t.navigation.autoStopKeep}</button
				>
			</div>
		{/if}

		{#if shown}
		<!-- The caveat before the figures it qualifies: a frozen fix renders
		     exactly like a fresh one, so it cannot be a footnote. The
		     suspension line above already states a lost position, so this
		     only ever adds the degraded form beside it. -->
		{#if stale && model.suspended == null}
			<p
				class="alert"
				class:lost={quality === 'lost'}
				role="status"
				title={quality === 'lost' ? t.navigation.gpsLostTip : t.navigation.gpsDegradedTip}
			>
				<Icon name="alert-triangle" size={13} />
				{quality === 'lost' ? t.navigation.gpsLost : t.navigation.gpsDegraded}
			</p>
		{/if}

		<!-- The rare-critical evaluator gap keeps its inline line: with no
		     airspace dataset there is NO evaluation at all, which even a
		     NOTAM-volume banner above must not obscure. It wears danger
		     only once the fetch has SETTLED failed; the routine boot load
		     (a few seconds on a phone) shows the calm acquiring form, so
		     every start does not open on a red flash. The chronic briefing
		     caveat moved behind the chip (the alert panel and the
		     Navigation tab state it): it only downgrades the
		     NOTAM-activated zones to a caution, which the banner shows. -->
		{#if model.regions.includes('gapLine')}
			{#if dataState.airspacesError != null}
				<p class="alert lost" role="status" title={t.navigation.alertNoAirspacesTip}>
					<Icon name="alert-triangle" size={13} />
					{t.navigation.alertNoAirspaces}
				</p>
			{:else}
				<p class="alert acquiring" role="status" title={t.navigation.alertAirspacesLoadingTip}>
					<Icon name="alert-triangle" size={13} />
					{t.navigation.alertAirspacesLoading}
				</p>
			{/if}
		{/if}

		<div class="row">
			{#if ui.isMobile}
				<!-- Phone: two designed lines that always FIT. The free scroller
				     clipped whatever fell past the edge, and the priority order
				     put the instruments there ("TRK 31" read for 313 deg is a
				     misreading hazard). Line A keeps who to talk to (the route
				     contact, else the overflown field, else the fix wait) and
				     where the aircraft is going; line B is the compact
				     instrument line the collapse control folds. The BEARING
				     stays off the phone (the steer pair on line B is the number
				     it was being read for); the next contact rides its own
				     transient line below, since neither the Navigation tab nor
				     the alert lane carries it. Residual overflow snaps between
				     cells, never mid-value. -->
				<div class="band band-lines">
					{#if lineAContent}
					<div class="line">
						{@render flownCell()}
						{#if contact?.current}
							{@render unitCell(contact.current, 'current', '')}
						{:else if over}
							{@render unitCell(over.unit, 'over', `${fmtNM(over.distNM)} NM`)}
						{:else if nav.recording && !nav.lastFix}
							<div class="cell"><span class="waiting">{t.navigation.waitingFix}</span></div>
						{/if}
						{@render waypointCell()}
					{@render etaCell()}
					</div>
					{/if}
					<!-- The handover window's own line. A unit is contacted BEFORE
					     its airspace is entered, and line A has no room for a
					     permanent fourth cell, so the next contact is raised for
					     the HANDOVER_LEAD_MIN minutes in which the call is
					     actually made and drops away once it is. It is the one
					     element allowed past the two-designed-lines rule, and it
					     earns it the way the doctrine already allows: a field
					     appearing or disappearing reflows the band, which is a
					     real event and worth seeing. Here the event is the
					     handover itself, once per boundary rather than per fix.
					     Deliberately OUTSIDE the collapse: collapsing folds the
					     instruments, and a pilot who wants less on the band has
					     not asked to be told less about the radio. -->
					{#if nextDue && contact?.next}
						<div class="line line-next">
							{@render unitCell(contact.next, 'next', nextTrail)}
						</div>
					{/if}
					{#if pose && (!navStrip.collapsed || !lineAContent)}
						<div class="line line-b">
							<InstrumentTiles
								compact
								speedKt={pose.speedKt}
								{trackMagDeg}
								{altMslFt}
								{altTip}
								{stale}
							/>
							{#if info && !arrived && st?.currentLegIdx != null && steerText}
								<!-- One steering figure on a phone, not two: measured, the
								     pair plus the cross-track runs line B 48 px past its
								     width, and the band's rule is two lines that FIT. The
								     turn is the one that is acted on and the one the map
								     under the band cannot show (an offset from the drawn
								     line is exactly what a map DOES show), and past
								     OFF_ROUTE_NM the flown cell still says "plan, not
								     position". Without a track to subtract there is no
								     turn, and the cross-track has the slot. -->
								{@render steerPair()}
							{:else if info && !arrived && info.log.xtkNM != null}
								{@render xtkPair()}
							{/if}
						</div>
					{/if}
				</div>
			{:else}
				<div class="band">
					{@render flownCell()}
					{#if contact?.current}
						{@render unitCell(contact.current, 'current', '')}
					{/if}
					{#if contact?.next && !navStrip.collapsed}
						{@render unitCell(contact.next, 'next', nextTrail)}
					{/if}
					<!-- The field being overflown, from the position alone. Distance
					     only, no ETE: the aircraft is passing the field, not flying
					     to it. -->
					{#if over && !navStrip.collapsed}
						{@render unitCell(over.unit, 'over', `${fmtNM(over.distNM)} NM`)}
					{/if}

					{@render waypointCell()}
					{@render etaCell()}

					{#if !navStrip.collapsed || !lineAContent}
						{#if info && !arrived && st?.currentLegIdx != null && (info.log.bearingMagDeg != null || info.log.xtkNM != null)}
							<div class="cell steer">
								{#if info.log.bearingMagDeg != null}
									<span class="pair" title={t.navigation.bearingTip}>
										<!-- i18n-ignore: BRG is an ICAO Doc 8400 abbreviation, locale-invariant like the tile keys; the title spells it out -->
										<span class="k">BRG</span>
										<span class="num">{fmtTrack(info.log.bearingMagDeg)}</span>
									</span>
								{/if}
								<!-- Between the bearing and the cross-track, because it is
								     what the two of them were being read FOR. -->
								{@render steerPair()}
								{#if info.log.xtkNM != null}
									{@render xtkPair()}
								{/if}
							</div>
						{/if}

						<div class="cell tiles">
							{#if nav.recording && !nav.lastFix}
								<span class="waiting">{t.navigation.waitingFix}</span>
							{:else if pose}
								<InstrumentTiles
									speedKt={pose.speedKt}
									{trackMagDeg}
									{altMslFt}
									{altTip}
									{stale}
								/>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<div class="actions">
				<!-- The all-acknowledged residual: the chip keeps the put-away
				     alerts findable, counted and re-alertable WITHOUT a row of
				     its own (a dedicated row read as a big empty banner holding
				     one pill). It returns to the banner's left edge the moment
				     anything fires or escalates; the banner and suspension rows
				     render it there themselves. -->
				{#if model.chip && !model.banner && model.suspended == null}
					{@render chipBtn()}
				{/if}
				<!-- The live log, one tap from the band it summarises (the
				     SkyDemon instruments-to-plog gesture). Gated on the live
				     selector, so a routeless recording never offers an empty
				     log; replay qualifies like the rest of the band. -->
				{#if info}
					<button
						type="button"
						class="log-btn"
						title={t.route.navigationLog}
						aria-label={t.route.navigationLog}
						aria-pressed={navLogModal.open}
						onclick={toggleNavLog}
					>
						<Icon name="navlog" size={14} />
					</button>
				{/if}
				<!-- Only while collapsing would change something: a control that
				     does nothing is dead weight on a small screen (a no-route
				     strip once toggled between "tiles" and an almost-empty
				     bar). Collapsed stays eligible so a persisted-collapsed
				     strip can always expand back. -->
				{#if collapsible || (lineAContent && navStrip.collapsed)}
					<button
						type="button"
						title={navStrip.collapsed ? t.navigation.stripExpand : t.navigation.stripCollapse}
						aria-label={navStrip.collapsed ? t.navigation.stripExpand : t.navigation.stripCollapse}
						aria-expanded={!navStrip.collapsed}
						onclick={toggleStripCollapsed}
					>
						<Icon name={navStrip.collapsed ? 'chevron-down' : 'chevron-up'} size={14} />
					</button>
				{/if}
				<button
					type="button"
					title={t.navigation.stripHide}
					aria-label={t.navigation.stripHide}
					onclick={hideStrip}
				>
					<Icon name="x" size={14} />
				</button>
			</div>
		</div>

		<!-- Every frequency at the field, unfolded on request. It rides under the
		     whole row rather than inside the cell, so the band's reserved widths
		     are untouched and this costs nothing until it is asked for. -->
		{#if revealedUnit}
			{@const u = revealedUnit.unit}
			<div
				class="freqs"
				class:plan-only={planOnly && revealedUnit.chain}
				aria-label={t.navigation.freqAll(u.label)}
			>
				{#each revealedUnit.lines as l (l.label + '|' + l.all)}
					<button
						type="button"
						class="chan"
						class:copied={copied === l.freq}
						title={l.all === l.freq
							? t.navigation.copyFreq(l.label)
							: `${t.navigation.copyFreq(l.label)} · ${l.all}`}
						aria-label={t.navigation.copyFreq(l.label)}
						onclick={() => void copyFreq(l.freq)}
					>
						<span class="chan-k">{l.label}</span>
						{l.freq}
						{#if l.was}<s title={t.navigation.freqWas(l.was)}>{l.was}</s>{/if}
					</button>
				{/each}
				{#if u.freqFlagged}
					<span class="chan-flag" title={t.navigation.freqFlagged}>
						<Icon name="alert-triangle" size={11} />
					</span>
				{/if}
				{#if u.ident}
					{@const ident = u.ident}
					<button
						type="button"
						class="chan chan-link"
						title={t.detail.openAirportTip}
						onclick={() => selectAirport(ident)}>{t.detail.viewAerodrome(ident)}</button
					>
				{/if}
			</div>
		{/if}
		{/if}
	</aside>
	<!-- Inside the strip's own {#if}: dismissing or losing the strip
	     unmounts the panel with it, so it cannot float anchorless. The
	     component portals itself (HeadOverlay), so it adds nothing to the
	     strip's measured height. -->
	<AlertPanel
		open={panelOpen}
		x={panelPos.x}
		y={panelPos.y}
		{model}
		onClose={() => (panelOpen = false)}
	/>
{:else if pose != null || nav.recording}
	<!-- The restore handle: the strip's X undone where the strip lives
	     (the Garmin split-screen arrow / sheet-grip idiom; the Navigation
	     tab keeps the desk path). Being the else of the main block, it
	     yields automatically to whatever escapes the dismissal: the bare
	     banner, the suspension line, the auto-stop countdown. -->
	<button
		type="button"
		class="strip-restore no-print"
		title={t.navigation.stripShow}
		aria-label={t.navigation.stripShow}
		onclick={restoreStrip}
	>
		<Icon name="chevron-down" size={14} />
	</button>
{/if}

<style>
	/* Over the map, not beside it: the band must cost the Leaflet container no
	   resize, and the map under it stays a working map. Below the sidebar
	   (z 500) and the detail panel, above the Leaflet panes and the cursor
	   badge (450). */
	.nav-strip {
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		z-index: 470;

		/* Safe areas: on a phone the map (and so this strip) spans the whole
		   screen width, so a landscape notch eats the strip's ends; the 6px
		   holds wherever the inset is smaller (0 off-device). */
		padding: 5px max(6px, var(--sar)) 5px max(6px, var(--sal));
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border-bottom: 1px solid var(--border);
		box-shadow: var(--shadow-1);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	/* The dismissed strip's restore handle, at the strip's own home so the
	   hide and the undo share a place. Slim grip, bottom-rounded like the
	   sheet's, with the tap zone extended past the visual by the ::after
	   outset (44 px reachable without the bulk). */
	.strip-restore {
		position: absolute;
		top: 0;
		left: 50%;
		z-index: 470;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 64px;
		height: 20px;
		padding: 0;
		color: var(--text-muted);
		cursor: pointer;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border: 1px solid var(--border);
		border-top: none;
		border-radius: 0 0 10px 10px;
		box-shadow: var(--shadow-1);
		transform: translateX(-50%);
	}

	.strip-restore::after {
		position: absolute;
		inset: -8px -12px -16px;
		content: '';
	}

	.strip-restore:hover {
		color: var(--text);
		background: var(--surface-2);
	}

	.band {
		display: flex;
		flex: 1;
		flex-wrap: wrap;
		align-items: center;
		min-width: 0;
		gap: 5px 10px;
	}

	/* On a phone the band is TWO designed lines that fit, not a scroller: a
	   free scroller clipped whatever fell past the edge, and the priority
	   order put the instruments there, a misreading hazard. Line A holds
	   the contact (or its fallbacks) and the active waypoint; line B the
	   compact instrument strip the collapse control folds. Residual
	   overflow (a landscape notch, a long callsign) still scrolls, but
	   snaps between cells so a cut can never land mid-value. */
	.band-lines {
		flex-flow: column nowrap;
		gap: 4px;
		align-items: stretch;
	}

	.band-lines .line {
		display: flex;
		gap: 5px 10px;
		align-items: center;
		min-width: 0;
		overflow-x: auto;
		scrollbar-width: none;
		scroll-snap-type: x proximity;
	}

	.band-lines .cell {
		flex: 0 0 auto;
		scroll-snap-align: start;
	}

	.band-lines .line-b {
		gap: 8px;
	}

	/* The handover line is the ONE cell on the band laid out as a ROW rather
	   than a label-over-value stack: stacked it costs four text rows (~60 px)
	   of map, which is a lot of chart to spend on an element that is only ever
	   up for a few minutes. Baseline-aligned so the frequency still reads as
	   the value and the label as its caption.

	   It keeps the 14ch unit reservation of the other phone cells even though
	   the line is full width: the anti-jitter doctrine is about the value not
	   moving under the eye, and a handover is exactly when the callsign
	   changes length. */
	.band-lines .line-next .cell {
		flex-flow: row wrap;
		gap: 2px 6px;
		align-items: baseline;
	}

	/* It WRAPS rather than scrolls, alone among the lines. Everywhere else a
	   cut falls on a cell boundary and the value beyond is still reachable by
	   dragging; here the thing past the edge is the lead figure, the whole
	   reason the line was raised, and a pilot does not scroll a band to find
	   out when to call. Measured at 392 px: the English line fits on one row,
	   the French ("Suivante" against "Next") takes the second rather than
	   hiding the countdown. */
	.band-lines .line-next {
		overflow-x: visible;
	}

	/* Nothing follows the lead figure on its own line, so the desktop's 17ch
	   reservation buys nothing here: it would only hold empty space open. The
	   anti-jitter doctrine guards a value against its NEIGHBOURS moving, and
	   this one has none to its right; it also counts monotonically DOWN, so it
	   shrinks leftward into free space rather than shoving anything. */
	.band-lines .line-next .trail.boundary {
		min-width: 0;
	}

	/* Beside two full-width lines the side-by-side buttons reserved ~90 px
	   for the whole band height; stacked, they cost one 44 px column and
	   the lines get the width back. Phone only (mobile-ui ⇔ ui.isMobile,
	   the doctrine), where the band-lines layout renders. */
	:global(:root.mobile-ui) .actions {
		flex-direction: column;
		gap: 0;
	}

	.cell {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		min-width: 0;
	}

	/* The tiles size to their own figures rather than absorbing the band: a
	   three-digit speed does not need a quarter of the screen, and the space
	   left over is what keeps the frequency the thing the eye lands on. */
	.cell.tiles {
		flex: 0 1 auto;
		justify-content: stretch;
	}

	.k {
		font-size: 10px;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	/* Every live figure below holds ONE width whatever it reads. The band is a
	   wrapping flex row whose height pads the Leaflet controls, so a field that
	   grows by a character on each fix shuffles its neighbours, can push a
	   field onto a second row, and jumps the zoom control with it. Digits are
	   tabular, so one ch is one digit and the reservations are read straight
	   off the formatters' longest output (route/format.ts). A field appearing
	   or disappearing still reflows the band, which is a real event and worth
	   seeing. */

	/* A FIXED width, not a cap: the label is what sized the contact cells, and
	   a callsign is anything from "CTR MELUN" to "LFPL LOGNES EMERAINVILLE", so
	   every handover shoved the whole band sideways. Enough for a typical
	   callsign; a long aerodrome name ellipsises, keeping the ident and enough
	   of the name to know it, with the whole of it on the tooltip. */
	.unit {
		overflow: hidden;
		width: 18ch;
		font-size: 12px;
		font-weight: 600;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The ETA cell's value is already constant-width (fmtClockUtc): the
	   18ch callsign reservation would waste half the cell on a phone line
	   that has to fit three cells. */
	.cell.eta .unit {
		width: auto;
	}

	/* The phone lines budget three cells across 390 px: the 18ch callsign
	   reservation is the desktop's; 14ch stays FIXED (the anti-jitter
	   doctrine) while longer names ellipsise a little earlier, the whole
	   name on the tooltip as everywhere. */
	.band-lines .unit {
		width: 14ch;
	}

	/* The frequency is the reason the band exists: the largest thing on it, and
	   a tap target that copies rather than a label to transcribe by hand. The
	   published channel is always three decimals (formatFreqMHz), so seven
	   digits reserve it exactly; a unit on several frequencies is wider and
	   expands the cell, which only ever happens at a handover. */
	.freq {
		padding: 0;
		min-width: 7ch;
		font: inherit;
		font-size: 21px;
		line-height: 1.05;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		background: none;
		border: 0;
		cursor: pointer;
		text-align: left;
	}

	/* The frequency plus its optional closure marker as ONE flex child, so
	   the column layout (and the transient line's baseline row) treats them
	   as the frequency did alone. */
	.freq-row {
		display: flex;
		gap: 5px;
		align-items: center;
		min-width: 0;
	}

	.freq:hover {
		color: var(--accent);
	}

	.freq.copied {
		color: var(--accent);
	}

	/* The unit still to be called, and the field merely overflown, read one
	   step back from the one in force. */
	.contact.next .freq,
	.contact.over .freq {
		font-size: 15px;
		color: var(--text-muted);
	}

	.trail {
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
	}

	/* "99.9 NM · 2 h 05 min", the longest fmtNM + fmtDurationMin pair, measured
	   rather than counted: the spaces and the separator are well under a ch, so
	   a reservation by character count would be half a field too wide, and the
	   width the band cannot afford is the one that pushes it onto a second row. */
	.trail.boundary {
		min-width: 17ch;
	}

	/* The same, plus " · 09:22Z" (fmtClockUtc). */
	.trail.leg {
		min-width: 24ch;
	}

	/* The phone trail holds dist and ETE only (the ETO clock yields to the
	   destination ETA, one clock per meaning), so the desktop's three-part
	   reservation would hold 70 px of nothing. */
	.band-lines .trail.leg {
		min-width: 14ch;
	}

	/* "4.9 NM": fmtNM under the 5 NM radius is one width by construction. */
	.trail.dist {
		min-width: 6ch;
	}

	/* The plan delta's longest form across BOTH catalogs (a ch is the font's
	   own digit advance, not a word count): "120 min de retard". A figure that
	   changes by a minute must not shuffle the band. */
	.trail.plan {
		min-width: 17ch;
	}

	.steer {
		flex-direction: row;
		align-items: center;
		gap: 10px;
	}

	.pair {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.num {
		font-size: 15px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	/* The cross-track swaps a distance for a phrase ("123 NM R" against
	   "on course", "dans l'axe"), so it reserves the longer of the two in
	   either language, AND in the heavier weight: past OFF_ROUTE_NM the value
	   goes semibold, worth about a character on its own.
	   The reservation is in em, NOT ch, and that is the whole point here: a ch
	   is the advance of "0" in the element's OWN font, so a weight that changes
	   changes the reservation with it, and the box grew by exactly the amount
	   the bold text needed. An em follows the font SIZE alone, which does not
	   move. The bearing beside it needs no reservation at all: fmtTrack pads it
	   to three digits. */
	.num.xtk {
		display: inline-block;
		min-width: 6.5em;
	}

	/* "G 180°", the longest form: three digits, the degree sign and a side
	   letter. In em for the same reason as the cross-track beside it, though
	   nothing here changes weight; the field must not breathe as the turn
	   closes from two digits to one. */
	.num.steer-val {
		display: inline-block;
		min-width: 3.6em;
	}

	/* Past OFF_ROUTE_NM the plan is answering about a route that is not being
	   flown, so the number carries the alert ink itself. */
	.num.off-route {
		font-weight: 600;
		color: var(--nav-orange);
	}

	/* Answering for a route the aircraft is not on. The figures stay (the plan
	   is what is being rejoined) but stop reading as observed fact: a unit
	   resolved from a route being flown 8 NM away is a suggestion, not a
	   handover. The note carries the same alert ink as the off-route number. */
	.cell.plan-only .unit,
	.cell.plan-only .freq,
	.cell.plan-only .trail,
	.freqs.plan-only .chan {
		opacity: 0.55;
	}

	/* The disclosure carries the same reserved width as the plain label, the
	   chevron taking its space from inside rather than beside: an aerodrome
	   taking the contact from an airspace must not shift the band, which is
	   the whole point of the reservation. */
	.unit-btn {
		display: flex;
		align-items: center;
		gap: 3px;
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}

	.unit-btn:hover {
		color: var(--accent);
	}

	.unit-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Every frequency at the field, under the whole row. Only ever on screen
	   because the pilot asked for it, so it may take a line; on a phone it
	   scrolls with the band rather than wrapping, the same rule. */
	.freqs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 6px;
		margin-top: 4px;
		padding-top: 4px;
		border-top: 1px solid var(--border);
	}

	:global(:root.mobile-ui) .freqs {
		flex-wrap: nowrap;
		overflow-x: auto;
		scrollbar-width: none;
	}

	.chan {
		display: flex;
		flex: 0 0 auto;
		align-items: baseline;
		gap: 4px;
		padding: 2px 6px;
		border: 1px solid var(--border);
		border-radius: 999px;
		background: none;
		color: var(--text);
		font: inherit;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: pointer;
	}

	.chan:hover,
	.chan.copied {
		border-color: var(--accent);
		color: var(--accent);
	}

	.chan-k {
		color: var(--text-muted);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
	}

	.chan s {
		color: var(--text-muted);
		font-size: 10px;
	}

	.chan-link {
		border-style: dashed;
		color: var(--accent);
	}

	/* A change the resolver could not tie to any published service: the list
	   beside it may be stale in a way it cannot show, and the aerodrome panel
	   is where the reason is. */
	.chan-flag {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		color: var(--nav-orange);
	}

	.plan-note {
		color: var(--nav-orange);
		font-weight: 600;
		white-space: nowrap;
	}

	.waiting {
		font-size: 11px;
		color: var(--text-muted);
	}

	.alert {
		--alert-ink: var(--nav-orange);

		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 0 5px;
		padding: 3px 7px;
		font-size: 12px;
		font-weight: 600;
		color: var(--alert-ink);
		background: color-mix(in srgb, var(--alert-ink) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--alert-ink) 40%, transparent);
		border-radius: var(--radius);
	}

	.alert.lost {
		--alert-ink: var(--danger);
	}

	/* The airspace-alert banner (the SkyDemon warning form): the body opens
	   the volume's detail panel, the cross acknowledges, and the chip at
	   the row head opens the alert panel, where the rest of the queue
	   lists (AlertPanel.svelte carries the row form of this grammar). The
	   forbidden tier carries the danger ink like a lost position; the
	   clearance / equipment tiers keep the family's alert orange; a
	   caution reads one step calmer in the workbook amber; a planned
	   advisory steps back rather than shouts, the plan-only idiom.
	   Severity has ONE visual threshold, present tense: ahead of the
	   boundary an alert wears its ink as a tint, inside the volume it goes
	   solid in the same ink (the certified escalation logic, CS 25.1322:
	   time-criticality separates a caution from a warning). Planned keeps
	   its stepped-back form even inside; an acknowledged alert leaves the
	   banner for the panel, so the row has no acked form. */
	.alert.avoid {
		--alert-ink: var(--danger);
	}

	.alert.caution {
		--alert-ink: var(--workbook-orange);
	}

	/* The solid state's text is --surface, not --bg: it is the one colour
	   that clears AA on all three tier inks in BOTH themes (day 5.53 danger
	   / 4.91 caution / 5.50 alert; night 6.16 / 9.66 / 7.32), where --bg
	   left the caution tier at 4.30 in daylight. */
	.alert.inside {
		color: var(--surface);
		background: var(--alert-ink);
		border-color: var(--alert-ink);
	}

	.alert.planned {
		border-style: dashed;
		opacity: 0.85;
	}

	/* The suspension line's body (no button: the state is the message). */
	.alert-text {
		flex: 1;
		min-width: 0;
	}

	/* The channel chip: the alert surface's supervised-state anchor. Count
	   in the dominant ink, muted check when everything is acknowledged,
	   danger when evaluation is suspended; absent when nothing alerts, so
	   the strip rests clean. Always the way into the alert panel.
	   Leftmost in the row on purpose: the desktop detail panel (z 1092)
	   covers the strip's right end. */
	.alert-chip {
		--chip-ink: var(--nav-orange);

		display: inline-flex;
		flex: 0 0 auto;
		gap: 3px;
		align-items: center;
		justify-content: center;
		min-width: 26px;
		height: 20px;
		padding: 0 6px;
		font: inherit;
		font-size: 11px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		color: var(--chip-ink);
		cursor: pointer;
		background: color-mix(in srgb, var(--chip-ink) 10%, var(--surface));
		border: 1px solid color-mix(in srgb, var(--chip-ink) 45%, transparent);
		border-radius: 999px;
	}

	.alert-chip:hover {
		background: color-mix(in srgb, var(--chip-ink) 20%, var(--surface));
	}

	.alert-chip.ink-danger {
		--chip-ink: var(--danger);
	}

	.alert-chip.ink-caution {
		--chip-ink: var(--workbook-orange);
	}

	.alert-chip.ink-muted {
		--chip-ink: var(--text-muted);
	}

	.alert-chip.solid {
		color: var(--surface);
		background: var(--chip-ink);
	}

	/* On the solid (inside) banner the row background IS the ink: the chip
	   inverts to an outline in the page surface so it stays legible. */
	.alert.inside .alert-chip {
		color: var(--surface);
		background: transparent;
		border-color: color-mix(in srgb, var(--surface) 70%, transparent);
	}


	/* The auto-stop countdown: the family's stepped-back dashed form (a
	   normal automatic action, not a hazard), the time in tabular figures
	   so the per-second tick moves nothing around it. */
	.alert.stop-soon {
		border-style: dashed;
	}

	/* The acquiring form, same stepped-back dress: a transient-normal
	   state (the boot dataset load, a recording waiting for its first
	   fix) must not open every session on a red flash. Danger is for
	   what SETTLED wrong: a failed load, a position that was live and
	   got lost. */
	.alert.acquiring {
		border-style: dashed;
	}

	.stop-count {
		flex: 1;
		min-width: 0;
		font-variant-numeric: tabular-nums;
	}

	.stop-keep {
		flex: 0 0 auto;
		padding: 0 8px;
		font: inherit;
		font-size: 11px;
		font-weight: 600;
		color: inherit;
		background: none;
		border: 1px solid currentcolor;
		border-radius: 999px;
		cursor: pointer;
	}

	.stop-keep:hover {
		background: color-mix(in srgb, currentcolor 12%, transparent);
	}

	.alert-open {
		flex: 1;
		min-width: 0;
		padding: 0;
		font: inherit;
		font-size: 12px;
		font-weight: 600;
		color: inherit;
		text-align: left;
		background: none;
		border: 0;
		cursor: pointer;
	}

	.alert-open:hover {
		text-decoration: underline;
	}

	.alert-ack {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		padding: 0;
		color: inherit;
		background: none;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
	}

	.alert-ack:hover {
		background: color-mix(in srgb, currentcolor 12%, transparent);
	}

	.actions {
		display: flex;
		flex: 0 0 auto;
		gap: 2px;
		align-items: center;
	}

	.actions button:not(.alert-chip) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		color: var(--text-muted);
		background: none;
		border: 0;
		border-radius: 4px;
		cursor: pointer;
	}

	.actions button:not(.alert-chip):hover {
		color: var(--text);
		background: var(--surface-2);
	}

	/* The log launcher reads as pressed while its surface is open, the
	   .btn.on convention (aria-pressed rides beside it). */
	.actions .log-btn[aria-pressed='true'] {
		color: var(--accent);
	}

	/* Keyed off the touch-ui root class (coarse pointer OR a running
	   recording; App.svelte stamps it, the mobile-ui doctrine): in flight
	   this is read and tapped with gloves on, in turbulence, whatever the
	   pointer. */
	:global(:root.touch-ui) .actions button:not(.alert-chip) {
		width: 44px;
		height: 44px;
	}

	/* On phones the stacked column beside the band was defining the bar's
	   height: three 44 px buttons made an empty-ish strip 143 px tall.
	   Display controls keep the 44 px REACH through the ::after outset
	   while the visual shrinks (the restore handle's device); the alert
	   chip follows suit. */
	:global(:root.mobile-ui) .actions button:not(.alert-chip) {
		position: relative;
		width: 32px;
		height: 32px;
	}

	:global(:root.mobile-ui) .actions button:not(.alert-chip)::after {
		position: absolute;
		inset: -6px;
		content: '';
	}

	:global(:root.mobile-ui) .actions .alert-chip {
		position: relative;
		min-width: 36px;
		min-height: 28px;
	}

	:global(:root.mobile-ui) .actions .alert-chip::after {
		position: absolute;
		inset: -8px -4px;
		content: '';
	}

	:global(:root.touch-ui) .freq {
		min-height: 44px;
		font-size: 24px;
	}

	/* The revealed row is transient and deliberate, so it can afford the
	   target the resting band cannot. */
	:global(:root.touch-ui) .chan {
		min-height: 44px;
	}

	:global(:root.touch-ui) .alert-open {
		min-height: 44px;
	}

	:global(:root.touch-ui) .alert-ack,
	:global(:root.touch-ui) .alert-chip {
		min-width: 44px;
		min-height: 44px;
	}

	:global(:root.touch-ui) .stop-keep {
		min-height: 44px;
	}
</style>
