<script lang="ts">
	/* The in-flight band: the live figures, over the map, whatever else is on
	 * screen (docs/nav-live.md "The in-flight strip").
	 *
	 * Until this existed every live number lived in the Navigation tab, and the
	 * sidebar unmounts a tab as soon as another is selected, so opening Layers
	 * or Weather destroyed the whole readout; on a phone the sheet covered the
	 * map, making map and instruments mutually exclusive. The band floats over
	 * the map instead (a child of .map-wrap, the CursorCoords precedent), so it
	 * changes no layout and costs the Leaflet container no resize.
	 *
	 * It is deliberately NOT a workspace surface: the registry has three slots
	 * and opening a surface evicts the slot's incumbent, so a strip in one
	 * would fight the nav log and the profiles it exists to sit beside
	 * (src/lib/surfaces.ts).
	 *
	 * TWO ROWS, on every layout, and never a third: the contact row (who to
	 * talk to, on what, and where the aircraft is going) and the instrument
	 * row (five fixed cells). What does not fit a row is reached by a TAP on
	 * its cell, which cycles a short ring of readings about the same subject
	 * (nav/bandCells.ts): the frequency cell turns to the next contact and the
	 * overflown field, the target cell to the destination, MH to the planned
	 * DTK, TRK to the bearing and the cross-track, GPS ALT to the height above
	 * ground and the leg's MSA, the ETA to the ETE. The label always names the
	 * reading, an alternate takes a distinct ink, and a cell returns to its
	 * primary by itself when its subject changes (a handover, a passage). The
	 * frequency is the largest thing on the band because reading it at arm's
	 * length in turbulence is the task this surface exists for; the heading
	 * to steer is the accent figure because it is the one that is acted on.
	 *
	 * The alert stack (the banner, the suspension line, the auto-stop
	 * countdown, the quality and dataset notes) FLOATS under the band rather
	 * than sitting in its flow: the band's height never moves with an alert,
	 * so the zoom control stops jumping and the map keeps its rows. */
	import AlertPanel from './AlertPanel.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { copyText } from '$lib/ui/clipboard';
	import { longPress } from '$lib/ui/longPress';
	import { contactLines, type ContactLine } from '$lib/format/radio';
	import { fmtClockUtc, fmtDurationMin, fmtDurationMs, fmtEte, fmtNM, fmtTrack } from '$lib/route/format';
	import { computeNavLog, waypointLabel } from '$lib/route/navlog';
	import { OFF_ROUTE_NM } from '$lib/nav/navlogLive';
	import { handoverDue } from '$lib/nav/contactChain';
	import { traceEndMs } from '$lib/nav/trace';
	import { alertAnnounce, alertLine, alertOpens, openAlertPanel } from './alertText';
	import { alertInk, alertPlanned, alertSolid } from '$lib/nav/alertSurface';
	import { decimalYearFromDate, magneticFromTrue } from '$lib/route/magnetic';
	import { legTasKt } from '$lib/route/legWind';
	import { altCorrectionFt } from '$lib/nav/altitudeDatum';
	import {
		RING_ENTRIES,
		advanceRing,
		aglFt,
		dtkMagDeg,
		liveHeadingMagDeg,
		planDeltaSuffix,
		resolveRingPos,
		ringHasAlternate,
		xtkCompact,
		type RingId,
		type RingPos,
	} from '$lib/nav/bandCells';
	import {
		nav,
		currentPose,
		poseAltMslFt,
		positionQuality,
		traceAltDatum,
	} from '$lib/state/navRecording.svelte';
	import { acknowledgeSurfaceAlert, alertSurfaceNow } from '$lib/state/alertStack';
	import { autoStop, keepRecording } from '$lib/state/autoStop.svelte';
	import { dataState } from '$lib/state/data.svelte';
	import { navLiveNow, type NavContactUnit } from '$lib/state/navLive.svelte';
	import { overflownAirport } from '$lib/state/navOverflight.svelte';
	import { navRouteId } from '$lib/state/navRoute.svelte';
	import { navStrip, setStripHidden, toggleStripCollapsed } from '$lib/state/navStrip.svelte';
	import { navLogModal, toggleNavLog } from '$lib/state/navLogModal.svelte';
	import { routeProfileModal, toggleRouteProfile } from '$lib/state/routeProfileModal.svelte';
	import { routeSettings, routes } from '$lib/state/route.svelte';
	import { effectiveRouteWinds } from '$lib/state/routeWind.svelte';
	import { windAloft } from '$lib/state/windAloft.svelte';
	import { effectiveCruiseSpeedKt } from '$lib/state/aircraft.svelte';
	import { ensurePoseGround, poseGroundFt } from '$lib/state/poseGround.svelte';
	import { ensureRouteMsa, routeMsaLegs } from '$lib/state/routeMsa.svelte';
	import { openPage, selectAirport, ui } from '$lib/state/ui.svelte';
	import { display } from '$lib/state/display.svelte';
	import { startFlight } from '$lib/state/flightAction.svelte';

	const pose = $derived(currentPose());
	const quality = $derived(positionQuality());
	const info = $derived(navLiveNow());
	const stale = $derived(quality !== 'good');

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

	// ---- the alert surface (docs/nav-alerts.md) ----
	// The annunciator / record / status split: ONE banner row carries the
	// dominant unacknowledged alert (the SkyDemon warning grammar: the body
	// opens the details, the cross acknowledges), the chip carries the
	// channel's state while anything alerts and opens the panel, and the
	// panel lists everything else. nav/alertSurface.ts decides what shows,
	// over both subjects: the volumes and the ground ahead
	// (docs/terrain-awareness.md).
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

	// ---- the figures ----

	/** Declination at the pose, at the display instant (a replay reads the
	 *  variation the flight had). */
	const year = $derived(decimalYearFromDate(new Date(nav.playheadMs)));

	// Magnetic, like the nav log's MC / MH columns: GNSS reports track in true,
	// and a true track shown beside a magnetic heading is a trap in the cockpit.
	const trackMagDeg = $derived.by(() => {
		if (!pose || pose.trackDeg == null) {
			return null;
		}
		return magneticFromTrue(pose.trackDeg, pose.lat, pose.lon, year);
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
	// The overflown aerodrome: the band's one position-resolved reading, up
	// with or without a route (state/navOverflight).
	const over = $derived(overflownAirport());
	// Everything route-referenced is answering for a route the aircraft is not
	// on. It stays on the band (it is still the plan, and the plan is what the
	// pilot is rejoining), but muted and captioned rather than confident.
	const planOnly = $derived(info?.planOnly === true);
	const arrived = $derived(st?.arrived ?? false);

	/** The destination ETA: the estimate chain's LAST entry, the nav-log
	 *  modal's bottom row (recalage-corrected at the live GS). */
	const destEtoMs = $derived(
		st && st.wpts.length > 0 ? (st.wpts[st.wpts.length - 1].etoMs ?? null) : null,
	);
	/** Minutes to the destination from the display instant, the same instant
	 *  the live log projected the pose at (navLive's tMs). */
	const eteDestMin = $derived(
		destEtoMs != null ? Math.max(0, (destEtoMs - nav.playheadMs) / 60000) : null,
	);

	/** The route the band answers for: the flown one of a chained plan. */
	const route = $derived.by(() => {
		const r = routes.list.find((x) => x.id === navRouteId());
		return r && r.waypoints.length >= 2 ? r : null;
	});
	const legIdx = $derived(st?.currentLegIdx ?? null);
	const legFrom = $derived(route && legIdx != null ? (route.waypoints[legIdx] ?? null) : null);
	const legTo = $derived(route && legIdx != null ? (route.waypoints[legIdx + 1] ?? null) : null);
	const destWp = $derived(route ? route.waypoints[route.waypoints.length - 1] : null);
	const destIdent = $derived(destWp ? waypointLabel(destWp) : '');

	/** The heading to steer (nav/bandCells liveHeadingMagDeg): the bearing
	 *  from the pose to the active waypoint corrected by the leg's effective
	 *  wind at the planned TAS, the nav log's own inputs (routeWind's
	 *  precedence, legTasKt's temperature rule), the variation at the pose.
	 *  Without a wind or a TAS it is the bare bearing and says so. */
	const legWind = $derived(route && legIdx != null ? (effectiveRouteWinds(route)[legIdx] ?? null) : null);
	const tasKt = $derived.by(() => {
		const cruise = effectiveCruiseSpeedKt();
		if (cruise == null || !legFrom) {
			return null;
		}
		return legTasKt(cruise, legWind?.forecast?.tempC ?? null, legFrom.alt, windAloft.tempTas);
	});
	const heading = $derived(
		pose && legTo && !arrived
			? liveHeadingMagDeg({
					pose,
					target: legTo,
					wind: legWind ? { dirDeg: legWind.dirDeg, speedKt: legWind.speedKt } : null,
					tasKt,
					timeYears: year,
				})
			: null,
	);
	/** The leg geometry the nav log prints (its DTK is the sheet's MC). */
	const navlog = $derived(route ? computeNavLog(route.waypoints, effectiveCruiseSpeedKt()) : null);
	const dtk = $derived.by(() => {
		const leg = navlog && legIdx != null ? (navlog.legs[legIdx] ?? null) : null;
		if (!leg || !legFrom || !legTo || arrived) {
			return null;
		}
		return dtkMagDeg(leg.trackTrueDeg, legFrom, legTo, year);
	});
	const totalNM = $derived(
		navlog && navlog.legs.length > 0 ? navlog.legs[navlog.legs.length - 1].cumNM : null,
	);
	const destRemainNM = $derived(
		totalNM != null && st?.distNM != null ? Math.max(0, totalNM - st.distNM) : null,
	);

	/* The height above ground and the leg's MSA read the two shared memos
	 * (state/poseGround, state/routeMsa), so the band, the alert engine and
	 * the nav-log sheet never disagree. Kept fresh while the band is up. */
	$effect(() => {
		if (shown && pose) {
			ensurePoseGround(pose.lat, pose.lon);
		}
	});
	const msaOpts = $derived({
		halfWidthNM: routeSettings.minAltCorridorRadiusNM,
		vfr: routeSettings.vfr,
	});
	$effect(() => {
		if (shown && route) {
			ensureRouteMsa(route.id, route.waypoints, msaOpts);
		}
	});
	const groundFt = $derived(pose ? poseGroundFt(pose.lat, pose.lon) : null);
	const agl = $derived(aglFt(altMslFt, groundFt));
	const msaLegFt = $derived.by(() => {
		if (!route || legIdx == null) {
			return null;
		}
		return routeMsaLegs(route.id, route.waypoints, msaOpts)?.[legIdx] ?? null;
	});

	/** The next contact's lead figure, worded once for the cell and the
	 *  frequency ring so the two can never differ. */
	const nextTrail = $derived(
		contact?.toBoundaryNM != null
			? `${fmtNM(contact.toBoundaryNM)} NM${contact.eteMin != null ? ` · ${fmtDurationMin(contact.eteMin)}` : ''}`
			: '',
	);

	/** The handover window: a unit is contacted BEFORE its airspace is
	 *  entered (SERA.6001 / 6005), so inside `handoverDue` the next unit and
	 *  its frequency REPLACE the target cell, on both layouts, and the
	 *  target ring is inert until the crossing. Zero pixels: the cell holds
	 *  one width whatever it shows. */
	const handover = $derived(
		contact?.next != null && handoverDue(contact.toBoundaryNM, contact.eteMin),
	);

	// ---- the rings (nav/bandCells.ts) ----
	// A tap's memory per cell: the position and the subject it was chosen
	// for. The resolve rule below falls back to the primary the moment the
	// subject changes, so nothing here has to watch for the event.
	let rings = $state<Record<RingId, RingPos | null>>({
		freq: null,
		next: null,
		mh: null,
		trk: null,
		alt: null,
		eta: null,
	});
	const legKey = $derived(`${route?.id ?? ''}|${legIdx ?? ''}`);
	const ringKeys = $derived<Record<RingId, string>>({
		freq: `${contact?.current?.label ?? ''}|${contact?.next?.label ?? ''}|${over?.unit.label ?? ''}`,
		next: legKey,
		mh: legKey,
		trk: legKey,
		alt: 'alt',
		eta: `${route?.id ?? ''}|${arrived}`,
	});
	const ringAvail = $derived<Record<RingId, boolean[]>>({
		// The next unit leaves the ring while the handover shows it in the
		// target cell: one reading, one place.
		freq: [contact?.current != null, contact?.next != null && !handover, over != null],
		next: [
			info?.log.nextIdent != null && !arrived,
			destWp != null && destEtoMs != null && !arrived,
		],
		mh: [heading != null, dtk != null],
		trk: [
			trackMagDeg != null,
			info?.log.bearingMagDeg != null && !arrived,
			// The cross-track needs a LEG to be across: the projection
			// clamps its lateral distance to the first checkpoint before
			// there is one, while navLive leaves the side at 0 for want of
			// a leg to take it from, and the pair reads "0", on course, to
			// an aircraft twenty miles off the plan. Blank or honest.
			info?.log.xtkNM != null && !arrived && st?.currentLegIdx != null,
		],
		alt: [altMslFt != null, agl != null, msaLegFt != null],
		eta: [destEtoMs != null && !arrived, eteDestMin != null && !arrived],
	});

	/** Entries that APPLY to the cell's subject even while their own reading
	 *  has lapsed. Only the altitude ring has any: AGL waits on a terrain
	 *  sample that answers within 2 NM of where it was taken, and the leg MSA
	 *  is null for the whole of a recompute, while the aircraft is just as
	 *  much above the ground and on the leg through both. Every other ring's
	 *  entries are there or not for the whole of a subject. */
	const ringApplies: Partial<Record<RingId, boolean[]>> = $derived({
		alt: [altMslFt != null, altMslFt != null, route != null && legIdx != null],
	});

	function ringPos(ring: RingId): number {
		return resolveRingPos(
			ring,
			rings[ring],
			ringKeys[ring],
			ringAvail[ring],
			ringApplies[ring] ?? ringAvail[ring],
		);
	}
	function ringAlt(ring: RingId): boolean {
		return ringHasAlternate(ring, ringPos(ring), ringAvail[ring]);
	}
	function tapRing(ring: RingId): void {
		if (ring === 'next' && handover) {
			return;
		}
		rings[ring] = { pos: advanceRing(ring, ringPos(ring), ringAvail[ring]), key: ringKeys[ring] };
	}

	const freqEntry = $derived(RING_ENTRIES.freq[ringPos('freq')]);
	const nextEntry = $derived(RING_ENTRIES.next[ringPos('next')]);
	const mhEntry = $derived(RING_ENTRIES.mh[ringPos('mh')]);
	const trkEntry = $derived(RING_ENTRIES.trk[ringPos('trk')]);
	const altEntry = $derived(RING_ENTRIES.alt[ringPos('alt')]);
	const etaEntry = $derived(RING_ENTRIES.eta[ringPos('eta')]);

	/** The unit's voice services, the one to CALL first (format/radio). The
	 *  band shows ONE channel; the others ride the unfolded row. */
	function lines(u: NavContactUnit): ContactLine[] {
		return contactLines(u.radio, u.kind);
	}

	/** What the contact cell shows: the reading its ring is on, with the
	 *  fallbacks the band always had (no route contact: the overflown field,
	 *  then the fix wait). */
	const freqCell = $derived.by(
		(): { unit: NavContactUnit; kind: 'current' | 'next' | 'over'; label: string; trail: string } | null => {
			const n = t.navigation;
			if (freqEntry === 'next' && contact?.next) {
				return {
					unit: contact.next,
					kind: 'next',
					label: `${n.contactNextShort} · ${contact.next.label}`,
					trail: nextTrail ? n.contactIn(nextTrail) : '',
				};
			}
			if (freqEntry === 'over' && over) {
				return {
					unit: over.unit,
					kind: 'over',
					label: `${n.contactOverShort} · ${over.unit.label}`,
					trail: `${fmtNM(over.distNM)} NM`,
				};
			}
			if (contact?.current) {
				return { unit: contact.current, kind: 'current', label: contact.current.label, trail: '' };
			}
			return null;
		},
	);

	/** The trailing cell of the contact row: the handover while it is due,
	 *  else the target ring (next waypoint / destination), else the arrival. */
	const targetCell = $derived.by(
		(): { kind: 'handover' | 'wpt' | 'dest' | 'arrived'; k: string; v: string; fig: string; byHand: boolean } | null => {
			const n = t.navigation;
			if (handover && contact?.next) {
				return {
					kind: 'handover',
					k: `${n.contactNextShort} · ${contact.next.label}`,
					v: lines(contact.next)[0]?.freq ?? '',
					fig: nextTrail ? n.contactIn(nextTrail) : '',
					byHand: false,
				};
			}
			if (arrived) {
				return { kind: 'arrived', k: n.navlogEta, v: n.navlogArrived, fig: '', byHand: false };
			}
			if (nextEntry === 'dest' && destWp && destEtoMs != null) {
				const parts: string[] = [];
				if (destRemainNM != null) {
					parts.push(`${fmtNM(destRemainNM)} NM`);
				}
				if (eteDestMin != null) {
					parts.push(fmtDurationMin(eteDestMin));
				}
				// i18n-ignore: ETA is an ICAO Doc 8400 abbreviation, locale-invariant like the cell labels; the cell's title spells it out
				parts.push(`ETA ${fmtClockUtc(destEtoMs)}Z`);
				return { kind: 'dest', k: n.destination, v: destIdent, fig: parts.join(' · '), byHand: false };
			}
			if (info?.log.nextIdent) {
				const parts: string[] = [];
				if (info.log.nextDistNM != null) {
					parts.push(`${fmtNM(info.log.nextDistNM)} NM`);
				}
				if (info.log.nextEteMin != null) {
					parts.push(fmtDurationMin(info.log.nextEteMin));
				}
				return {
					kind: 'wpt',
					k: n.navlogNext,
					v: info.log.nextIdent,
					fig: parts.join(' · '),
					byHand: info.log.pinnedLegIdx != null,
				};
			}
			return null;
		},
	);

	/** The plan delta beside the ETA clock ("+3": three minutes behind the
	 *  plan; navlogLive's planDeltaMin) and its worded form for the
	 *  accessible name and the tooltip, the language that needs no
	 *  convention taught. */
	const planSuffix = $derived(planDeltaSuffix(st?.planDeltaMin ?? null));
	const planWords = $derived.by(() => {
		const d = st?.planDeltaMin ?? null;
		if (d == null) {
			return '';
		}
		const min = Math.round(Math.abs(d));
		if (min === 0) {
			return t.navigation.planOnTime;
		}
		return d > 0 ? t.navigation.planLate(String(min)) : t.navigation.planEarly(String(min));
	});

	/** The phone's toolbar folded away in flight (Settings > Interface):
	 *  Stop and Layers ride the contact row instead, since the bar's one
	 *  mode control must stay one tap away (a template condition, never an
	 *  effect on nav.recording). The map's own layers pair, when chosen,
	 *  already carries Layers. */
	const folded = $derived(ui.isMobile && nav.recording && display.toolbarInFlight === 'folded');

	/** Whether the collapse control would change anything: it folds the
	 *  instrument row, which exists with a pose. A collapsed strip stays
	 *  eligible so a persisted-collapsed strip can always expand back. */
	const collapsible = $derived(pose != null);

	/** The aerodrome or unit whose full frequency list is unfolded, by its
	 *  ident (an aerodrome) or label (an airspace). Keyed rather than held as
	 *  a boolean so a handover closes it on its own: the row renders only
	 *  while that unit is still one of the contacts or the field being
	 *  overflown. Opened by a LONG PRESS on the contact cell, whose tap now
	 *  cycles the ring. */
	let revealed = $state<string | null>(null);
	function unitKey(u: NavContactUnit): string {
		return u.ident ?? u.label;
	}
	const revealedUnit = $derived.by(() => {
		if (revealed == null || navStrip.collapsed) {
			return null;
		}
		const chain = [contact?.current, contact?.next].find((c) => c && unitKey(c) === revealed);
		const u = chain ?? (over && unitKey(over.unit) === revealed ? over.unit : undefined);
		return u ? { unit: u, lines: lines(u), chain: chain != null } : null;
	});

	function revealFreqCell(): void {
		const u = freqCell?.unit;
		if (u) {
			revealed = revealed === unitKey(u) ? null : unitKey(u);
		}
	}

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

	// A frequency copied in the last second and a half leaves a timer behind
	// when the strip goes (a stop, a rotation): the one timer in the band
	// without a teardown.
	$effect(() => () => {
		if (copyTimer != null) {
			clearTimeout(copyTimer);
			copyTimer = null;
		}
	});

	// The band's own height, published so the Leaflet controls can step clear
	// of it rather than sitting under it. The floating alert stack is NOT
	// part of it, by design: an alert must not move the map's controls.
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

	// ---- the instrument cells' readings ----
	const mhCell = $derived.by(() => {
		const n = t.navigation;
		if (mhEntry === 'dtk' && dtk != null) {
			// i18n-ignore: DTK is the Garmin / Doc 8400 desired-track abbreviation, locale-invariant like MH; the title spells it out
			return { k: 'DTK', v: fmtTrack(dtk), tip: n.dtkTip, aria: `${n.dtkTip} ${fmtTrack(dtk)}` };
		}
		if (heading) {
			const k = heading.kind === 'mh' ? 'MH' : 'BRG';
			const tip = heading.kind === 'mh' ? n.headingTip : n.bearingTip;
			return { k, v: fmtTrack(heading.deg), tip, aria: `${tip} ${fmtTrack(heading.deg)}` };
		}
		// i18n-ignore: MH is an ICAO Doc 8400 abbreviation, locale-invariant like the nav log's column; the title spells it out
		return { k: 'MH', v: '—', tip: n.headingTip, aria: n.headingTip };
	});
	const trkCell = $derived.by(() => {
		const n = t.navigation;
		if (trkEntry === 'brg' && info?.log.bearingMagDeg != null) {
			const v = fmtTrack(info.log.bearingMagDeg);
			// i18n-ignore: BRG / XTK / TRK are ICAO Doc 8400 abbreviations, locale-invariant like the tile keys; the titles spell them out
			return { k: 'BRG', v, u: '', tip: n.bearingTip, aria: `${n.bearing} ${v}`, off: false };
		}
		if (trkEntry === 'xtk' && info?.log.xtkNM != null) {
			const v = xtkCompact(info.log.xtkNM, info.log.xtkSide, { left: n.xtkLeft, right: n.xtkRight });
			const words = v === '0' ? n.onCourse : `${v} NM`;
			return { k: 'XTK', v, u: v === '0' ? '' : 'NM', tip: n.xtkTip, aria: `${n.xtk} ${words}`, off: info.log.offRoute };
		}
		const v = trackMagDeg != null ? fmtTrack(trackMagDeg) : '—';
		return { k: 'TRK', v, u: '', tip: n.trackTip, aria: `${n.track} ${v}`, off: false };
	});
	const altCell = $derived.by(() => {
		const n = t.navigation;
		if (altEntry === 'agl') {
			// The CAPTION is the pilot's own choice and outlives a gap in the
			// reading: the sample that answers it lapses between terrain
			// tiles, and swapping the subject there would put a figure
			// thousands of feet different under a cell that looks the same.
			// Blank the number instead, the empty-cell placeholder.
			const v = agl != null ? String(agl) : '—';
			// i18n-ignore: AGL / MSA / GPS ALT are ICAO Doc 8400 abbreviations, locale-invariant like the tile keys; the titles spell them out
			return { k: 'AGL', v, tip: n.aglTip, aria: `${n.aglTip} ${v} ft`, msa: false };
		}
		if (altEntry === 'msa') {
			const v = msaLegFt != null ? String(Math.round(msaLegFt)) : '—';
			return { k: 'MSA', v, tip: n.msaLegTip, aria: `${n.msaLegTip} ${v} ft`, msa: true };
		}
		const v = altMslFt != null ? String(Math.round(altMslFt)) : '—';
		return { k: 'GPS ALT', v, tip: altTip, aria: `${n.altitude} ${v} ft`, msa: false };
	});
	const etaCell = $derived.by(() => {
		const n = t.navigation;
		if (etaEntry === 'ete' && eteDestMin != null) {
			const v = fmtEte(eteDestMin);
			// i18n-ignore: ETE / ETA are ICAO Doc 8400 abbreviations, locale-invariant like the tile keys; the titles spell them out
			return { k: `ETE ${destIdent}`, v, u: '', tip: n.navlogEteTip, aria: `${n.navlogEteTip} ${v}` };
		}
		if (destEtoMs != null && !arrived) {
			// The clock is UTC (Doc 8400); the Z rides where a fifth of the
			// band's width has room for it, which a phone's has not.
			const v = ui.isMobile ? fmtClockUtc(destEtoMs) : `${fmtClockUtc(destEtoMs)}Z`;
			const tip = planWords ? `${n.navlogEta}, ${planWords}` : n.navlogEta;
			return { k: `ETA ${destIdent}`, v, u: planSuffix, tip: `${tip}. ${n.planDeltaTip}`, aria: `${n.navlogEta} ${v}${planWords ? `, ${planWords}` : ''}` };
		}
		return { k: 'ETA', v: '—', u: '', tip: n.navlogEta, aria: n.navlogEta };
	});
	const gsText = $derived(pose?.speedKt != null ? String(Math.round(pose.speedKt)) : '—');
</script>

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

<!-- One instrument cell: a label over a value, the label always naming the
     reading. Each names itself for assistive technology as well as for the
     eye: the abbreviation is what a pilot reads, the title spells it out and
     the aria-label carries the words where a title never appears. The row is
     aria-live="off": an instrument that announced itself once a second would
     talk over the alert banner. -->
{#snippet instCell(ring: RingId | 'gs', k: string, v: string, u: string, tip: string, aria: string, extra: string)}
	{@const alt = ring !== 'gs' && ringPos(ring) !== 0}
	{@const cue = ring !== 'gs' && ringAlt(ring)}
	<button
		type="button"
		class="cell inst {ring} {extra}"
		class:alt-reading={alt}
		class:ringed={cue}
		title={cue ? `${tip} ${t.navigation.ringNext}.` : tip}
		aria-label={aria}
		onclick={() => {
			if (ring !== 'gs') {
				tapRing(ring);
			}
		}}
	>
		<span class="k"><span class="kt">{k}</span>{#if cue}<Icon name="chevron-down" size={9} />{/if}</span>
		<span class="v">{v}{#if u}<span class="u">{u}</span>{/if}</span>
	</button>
{/snippet}

{#if shown}
	<aside
		class="nav-strip no-print"
		class:collapsed={navStrip.collapsed}
		bind:this={el}
		aria-label={t.navigation.stripLabel}
	>
		<div class="contact-row">
			<!-- The contact cell: the largest figure on the band. Its tap
			     cycles current / next / overflown; a long press unfolds every
			     frequency at the unit (the row under the band). -->
			{#if freqCell}
				{@const p = lines(freqCell.unit)[0]}
				{@const cue = ringAlt('freq')}
				<button
					type="button"
					class="cell contact"
					class:next={freqCell.kind === 'next'}
					class:over={freqCell.kind === 'over'}
					class:alt-reading={freqCell.kind !== 'current'}
					class:ringed={cue}
					class:plan-only={planOnly && freqCell.kind !== 'over'}
					title={p
						? `${freqCell.unit.label} ${p.all}. ${t.navigation.freqMore}${cue ? ` ${t.navigation.ringNext}.` : ''}`
						: freqCell.unit.label}
					aria-label={`${freqCell.label} ${p?.freq ?? ''}`}
					onclick={() => tapRing('freq')}
					use:longPress={revealFreqCell}
				>
					<span class="k unit" title={freqCell.unit.label}
						><span class="kt">{freqCell.label}</span>{#if cue}<Icon name="chevron-down" size={9} />{/if}</span
					>
					<span class="freq-row">
						<span class="freq" class:copied={p != null && copied === p.freq}>{p?.freq ?? '—'}</span>
						<!-- This unit answers where a NOTAM-closed sector would have: the
						     marker says WHY the frequency is not the published sector's own. -->
						{#if freqCell.unit.closedBy}
							<span
								class="chan-flag"
								title={t.navigation.contactClosedBy({
									unit: freqCell.unit.closedBy.closedLabel,
									id: freqCell.unit.closedBy.notamId,
								})}
							>
								<Icon name="alert-triangle" size={11} />
							</span>
						{/if}
					</span>
					<!-- The lead line is ALWAYS there (empty for the unit in force), so
					     a reading with a lead figure costs the band no height. -->
					<span class="lead"
						>{#if planOnly && freqCell.kind !== 'over'}<span
								class="plan-note"
								title={t.navigation.planOnlyTip(String(OFF_ROUTE_NM))}>{t.navigation.planOnlyShort}</span
							>{:else}{freqCell.trail}{/if}</span
					>
				</button>
			{:else if nav.recording && !nav.lastFix}
				<div class="cell contact"><span class="waiting">{t.navigation.waitingFix}</span></div>
			{/if}

			<!-- The target cell: the next waypoint, the destination on a tap,
			     the next unit and its frequency while the handover is due. -->
			{#if targetCell}
				{@const cue = targetCell.kind !== 'handover' && targetCell.kind !== 'arrived' && ringAlt('next')}
				<button
					type="button"
					class="cell next"
					class:handover={targetCell.kind === 'handover'}
					class:alt-reading={targetCell.kind === 'dest'}
					class:ringed={cue}
					class:plan-only={planOnly}
					title={targetCell.kind === 'handover'
						? t.navigation.contactHandoverTip
						: `${targetCell.k}${cue ? `. ${t.navigation.ringNext}.` : ''}`}
					aria-label={`${targetCell.k} ${targetCell.v} ${targetCell.fig}`}
					onclick={() => tapRing('next')}
				>
					<span class="k"><span class="kt">{targetCell.k}</span>{#if cue}<Icon name="chevron-down" size={9} />{/if}</span>
					<span class="v">{targetCell.v}</span>
					<span class="fig"
						>{#if targetCell.byHand}<span class="plan-note" title={t.navigation.flownLegTip}
								>{t.navigation.legByHand}</span
							> {/if}{#if planOnly && (!freqCell || freqCell.kind === 'over')}<!-- The caption normally rides the
							contact cell's lead line, but not when that cell has none (no
							contact in force) or is exempt from the muting itself (the
							OVERFLOWN field, which IS the position): the muting alone
							would be left to say these figures are the plan. --><span
								class="plan-note"
								title={t.navigation.planOnlyTip(String(OFF_ROUTE_NM))}>{t.navigation.planOnlyShort}</span
							> {/if}{targetCell.fig}</span
					>
				</button>
			{/if}

			<div class="actions">
				{#if folded}
					<button
						type="button"
						class="stop-btn"
						title={t.navigation.stopFlight}
						aria-label={t.navigation.stopFlight}
						onclick={startFlight}
					>
						<Icon name="stop" size={16} />
					</button>
					{#if display.layersControl !== 'map'}
						<button
							type="button"
							title={t.tabs.layers}
							aria-label={t.tabs.layers}
							onclick={() => openPage('layers')}
						>
							<Icon name="layers" size={16} />
						</button>
					{/if}
				{/if}
				<!-- The all-acknowledged residual: the chip keeps the put-away
				     alerts findable, counted and re-alertable WITHOUT a row of
				     its own. It returns to the banner's left edge the moment
				     anything fires or escalates. -->
				{#if model.chip && !model.banner && model.suspended == null}
					{@render chipBtn()}
				{/if}
				<!-- The live log and the vertical profile, one tap from the band
				     that summarises them (the SkyDemon instruments-to-plog
				     gesture). Gated on the live selector, so a routeless
				     recording never offers an empty log. -->
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
					<button
						type="button"
						class="log-btn"
						title={t.route.verticalProfile}
						aria-label={t.route.verticalProfile}
						aria-pressed={routeProfileModal.open}
						onclick={toggleRouteProfile}
					>
						<Icon name="profile" size={14} />
					</button>
				{/if}
				{#if collapsible || navStrip.collapsed}
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

		<!-- The instrument row: five fixed cells, label over value. Collapsing
		     the strip folds this row alone; the radio row stays. -->
		{#if pose && !navStrip.collapsed}
			<div class="inst-row" class:stale aria-live="off">
				{@render instCell('mh', mhCell.k, mhCell.v, '', mhCell.tip, mhCell.aria, '')}
				{@render instCell('trk', trkCell.k, trkCell.v, trkCell.u, trkCell.tip, trkCell.aria, trkCell.off ? 'off-route' : '')}
				<!-- i18n-ignore: GS is an ICAO Doc 8400 abbreviation, locale-invariant like the nav log's columns; the title spells it out -->
				{@render instCell('gs', 'GS', gsText, 'kt', t.navigation.groundSpeed, `${t.navigation.groundSpeed} ${gsText} kt`, '')}
				{@render instCell('alt', altCell.k, altCell.v, 'ft', altCell.tip, altCell.aria, altCell.msa ? 'msa' : '')}
				{@render instCell('eta', etaCell.k, etaCell.v, etaCell.u, etaCell.tip, etaCell.aria, '')}
			</div>
		{/if}

		<!-- Every frequency at the unit, unfolded on request. It rides under the
		     whole band rather than inside the cell, so the band's reserved widths
		     are untouched and this costs nothing until it is asked for. -->
		{#if revealedUnit}
			{@const u = revealedUnit.unit}
			<div
				class="freqs"
				role="group"
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
				<button
					type="button"
					class="chan chan-close"
					title={t.navigation.freqHide}
					aria-label={t.navigation.freqHide}
					onclick={() => (revealed = null)}
				>
					<Icon name="x" size={12} />
				</button>
			</div>
		{/if}
	</aside>
{:else if (pose != null || nav.recording) && !bare && !stopPending}
	<!-- The restore handle: the strip's X undone where the strip lives
	     (the Garmin split-screen arrow / sheet-grip idiom; the Navigation
	     tab keeps the desk path). It yields to whatever escapes the
	     dismissal: the bare banner, the suspension line, the countdown. -->
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

{#if shown || bare || stopPending}
	<!-- The alert stack floats under the band (or alone, when the band is
	     dismissed and a warning escapes it): the banner before everything,
	     the review's in-flight reading order starting at "any warning".
	     ONE banner row carries the dominant unacknowledged alert (the
	     SkyDemon warning grammar: body opens the detail panel, cross
	     acknowledges, the chip opens the panel with the ranked rest); a
	     suspended evaluation states itself instead of leaving a blank
	     (docs/nav-alerts.md "Presentation"). -->
	<div class="alert-stack no-print">
		{#if model.suspended != null || model.banner}
			<!-- The announcement is its own element: the banner's text carries a
			     distance and a countdown that change on every fix, and an
			     assertive region announcing those interrupts continuously. This
			     one says the same thing without the numbers. -->
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
			{@const ink = alertInk(b)}
			<div
				class="alert alert-banner"
				class:ink-danger={ink === 'danger'}
				class:ink-caution={ink === 'caution'}
				class:solid={alertSolid(b)}
				class:planned={alertPlanned(b)}
			>
				{@render chipBtn()}
				{#if alertOpens(b)}
					<button
						type="button"
						class="alert-open"
						title={t.navigation.alertOpenTip}
						onclick={() => model.banner && openAlertPanel(model.banner)}>{alertLine(b)}</button
					>
				{:else}
					<span class="alert-open">{alertLine(b)}</span>
				{/if}
				<button
					type="button"
					class="alert-ack"
					title={t.navigation.alertAckTip}
					aria-label={t.navigation.alertAckLabel}
					onclick={() => model.banner && acknowledgeSurfaceAlert(model.banner)}
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
			     shows the calm acquiring form. -->
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
		{/if}
	</div>
	<!-- Inside the block: dismissing or losing the strip unmounts the panel
	     with it, so it cannot float anchorless. The component portals itself
	     (HeadOverlay), so it adds nothing to the strip's measured height. -->
	<AlertPanel
		open={panelOpen}
		x={panelPos.x}
		y={panelPos.y}
		{model}
		onClose={() => (panelOpen = false)}
	/>
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
		display: flex;
		flex-direction: column;
		gap: 3px;

		/* Safe areas: on a phone the map (and so this strip) spans the whole
		   screen width, so a landscape notch eats the strip's ends; the 6px
		   holds wherever the inset is smaller (0 off-device). */
		padding: 4px max(6px, var(--sar)) 4px max(6px, var(--sal));
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		border-bottom: 1px solid var(--border);
		box-shadow: var(--shadow-1);
		user-select: none;
		-webkit-touch-callout: none;
	}

	/* The alert stack, floating under the band: absolute, so it is outside
	   the band's measured height and the map's controls never move for an
	   alert. Phone: the full width less a margin; desktop: right-anchored and
	   capped, clear of the zoom and recentre controls at the top left.
	   Pointer events pass through the stack's own empty space to the map. */
	.alert-stack {
		position: absolute;
		top: calc(var(--nav-strip-h, 0px) + 6px);
		right: 8px;
		left: 8px;
		z-index: 471;
		display: flex;
		flex-direction: column;
		gap: 4px;
		pointer-events: none;
	}

	.alert-stack > * {
		pointer-events: auto;
	}

	:global(:root:not(.mobile-ui)) .alert-stack {
		left: auto;
		width: min(60%, 640px);
	}

	/* On a phone the zoom control sits at the map's top left, under the
	   band; the stack starts right of it so a banner never covers it. */
	:global(:root.mobile-ui) .alert-stack {
		left: 62px;
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

	/* ---- the two rows ---- */

	.contact-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		min-height: 46px;
	}

	.inst-row {
		display: flex;
		align-items: stretch;
		min-width: 0;
		min-height: 40px;
		padding-top: 3px;
		border-top: 1px solid var(--border);
	}

	/* A cell is a button when it rings and plain furniture otherwise; both
	   carry the same box so a reading never moves for being tappable. */
	.cell {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 1px;
		min-width: 0;
		padding: 0;
		font: inherit;
		color: inherit;
		text-align: left;
		background: none;
		border: 0;
		border-radius: 6px;
	}

	.cell.ringed {
		cursor: pointer;
	}

	.cell.ringed:active {
		background: var(--surface-3);
	}

	.k {
		display: inline-flex;
		gap: 2px;
		align-items: center;
		font-size: 10px;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	/* ---- the contact cell ---- */

	/* A FIXED width, not a cap: a callsign is anything from "CTR MELUN" to
	   "LFPL LOGNES EMERAINVILLE", so every handover shoved the band sideways
	   until the cell held one width. Enough for a typical callsign; a long
	   aerodrome name ellipsises, the whole of it on the tooltip. The label
	   line IS the unit name here (the frequency below it is the value), so
	   it keeps the text's case and weight rather than the caption dress. */
	.cell.contact {
		flex: 0 0 auto;
		gap: 0;
		width: 18ch;
		min-width: 18ch;
		max-width: 18ch;
		overflow: hidden;
	}

	/* The label's text ellipsises inside the cell's fixed width; the caret
	   cue beside it keeps its own room. */
	.kt {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The lead figure under the frequency ("in 8.6 NM · 6 min" for the next
	   contact, the distance for the overflown field), a line reserved even
	   while empty so a tap never moves the band. */
	.lead {
		height: 12px;
		font-size: 11px;
		line-height: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cell.contact .k.unit {
		display: flex;
		height: 14px;
		overflow: hidden;
		font-size: 12px;
		font-weight: 600;
		line-height: 14px;
		color: var(--text);
		text-transform: none;
		letter-spacing: 0;
	}

	.cell.contact .k.unit :global(svg) {
		vertical-align: -1px;
	}

	/* The frequency is the reason the band exists: the largest thing on it.
	   The published channel is always three decimals (formatFreqMHz), so
	   seven digits reserve it exactly. */
	.freq-row {
		display: flex;
		gap: 6px;
		align-items: baseline;
		min-width: 0;
	}

	.freq {
		min-width: 7ch;
		font-size: 21px;
		line-height: 1;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	.freq.copied {
		color: var(--accent);
	}

	/* An alternate reading of the ring (the next contact, the overflown
	   field) wears the live-navigation ink, the cue that this is not the
	   unit in force. */
	.cell.contact.alt-reading .k.unit,
	.cell.contact.alt-reading .freq,
	.cell.contact.alt-reading .lead {
		color: var(--nav-orange);
	}

	/* ---- the target cell ---- */

	.cell.next {
		flex: 1 1 0;
		min-width: 80px;
		overflow: hidden;
	}

	/* Three lines of fixed height, so the handover's larger frequency and
	   the waypoint's name cost the same rows: the handover is zero pixels. */
	.cell.next .k {
		height: 12px;
		line-height: 12px;
	}

	.cell.next .v {
		height: 20px;
		overflow: hidden;
		font-size: 14px;
		font-weight: 600;
		line-height: 20px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* "99.9 NM · 2 h 05 min", the longest fmtNM + fmtDurationMin pair,
	   measured rather than counted: a reservation by character count would
	   be half a field too wide, and a value that changes by a minute must not
	   shuffle the band. */
	.cell.next .fig {
		height: 14px;
		min-width: 17ch;
		overflow: hidden;
		font-size: 12px;
		line-height: 14px;
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	/* The destination reading takes the accent, the ring's cue. */
	.cell.next.alt-reading .k,
	.cell.next.alt-reading .v,
	.cell.next.alt-reading .fig {
		color: var(--accent);
	}

	/* The handover: the next unit and its frequency in the target cell's
	   box, the live-navigation ink, the frequency at the contact cell's
	   size since it is the thing to set. */
	.cell.next.handover .k,
	.cell.next.handover .v,
	.cell.next.handover .fig {
		color: var(--nav-orange);
	}

	.cell.next.handover .v {
		font-size: 18px;
		font-variant-numeric: tabular-nums;
	}

	.cell.next.handover .fig {
		font-weight: 600;
	}

	/* ---- the instrument cells ---- */

	.cell.inst {
		flex: 0 0 auto;
		align-items: center;
		min-width: 88px;
		padding: 0 6px;
		text-align: center;
		border-left: 1px solid var(--border);
		border-radius: 0;
	}

	.cell.inst:first-child {
		border-left: 0;
	}

	.cell.inst .k {
		font-size: 9px;
		letter-spacing: 0.03em;
	}

	/* Every figure holds ONE width whatever it reads: the angles through
	   fmtTrack (three digits and the sign), the rest by tabular digits. */
	.cell.inst .v {
		font-size: 19px;
		font-weight: 600;
		line-height: 1.15;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.cell.inst .u {
		margin-left: 2px;
		font-size: 11px;
		font-weight: 400;
		color: var(--text-muted);
	}

	/* The heading to steer is the figure that is acted on: the accent, a
	   size up. */
	.cell.inst.mh .v {
		font-size: 21px;
		color: var(--accent);
	}

	/* An alternate reading steps back to the muted ink; the leg's MSA wears
	   the nav log's own MSA red, since a figure below it is what the sheet
	   tints in that ink. */
	.cell.inst.alt-reading .k,
	.cell.inst.alt-reading .v {
		color: var(--text-muted);
	}

	.cell.inst.alt-reading.msa .k,
	.cell.inst.alt-reading.msa .v {
		color: var(--danger);
	}

	/* The plan-delta suffix beside the ETA clock: the live-navigation ink,
	   semibold, so "+3" reads as a qualifier and not as part of the time. */
	.cell.inst.eta .u {
		font-weight: 600;
		color: var(--nav-orange);
	}

	/* Past OFF_ROUTE_NM the cross-track carries the alert ink itself. */
	.cell.inst.off-route .v {
		color: var(--nav-orange);
	}

	/* Frozen at the last fix: still the last known values, no longer current. */
	.inst-row.stale .v {
		opacity: 0.55;
	}

	/* Answering for a route the aircraft is not on. The figures stay (the plan
	   is what is being rejoined) but stop reading as observed fact. */
	.cell.plan-only .k,
	.cell.plan-only .v,
	.cell.plan-only .fig,
	.cell.plan-only .freq,
	.freqs.plan-only .chan {
		opacity: 0.55;
	}

	.cell.plan-only .plan-note {
		opacity: 1;
	}

	.plan-note {
		font-weight: 600;
		color: var(--nav-orange);
		white-space: nowrap;
	}

	.waiting {
		font-size: 11px;
		color: var(--text-muted);
	}

	/* ---- the unfolded frequencies ---- */

	/* Every frequency at the unit, under the whole band. Only ever on screen
	   because the pilot asked for it, so it may take a line; on a phone it
	   scrolls with the band rather than wrapping. */
	.freqs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 6px;
		align-items: center;
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
		gap: 4px;
		align-items: baseline;
		padding: 2px 6px;
		font: inherit;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		color: var(--text);
		white-space: nowrap;
		cursor: pointer;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
	}

	.chan:hover,
	.chan.copied {
		color: var(--accent);
		border-color: var(--accent);
	}

	.chan-k {
		font-size: 10px;
		font-weight: 600;
		color: var(--text-muted);
		letter-spacing: 0.04em;
	}

	.chan s {
		font-size: 10px;
		color: var(--text-muted);
	}

	.chan-link {
		color: var(--accent);
		border-style: dashed;
	}

	.chan-close {
		align-items: center;
		color: var(--text-muted);
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

	/* ---- the alert family ---- */

	.alert {
		--alert-ink: var(--nav-orange);

		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0;
		padding: 3px 7px;
		font-size: 12px;
		font-weight: 600;
		color: var(--alert-ink);
		background: color-mix(in srgb, var(--alert-ink) 12%, var(--surface));
		border: 1px solid color-mix(in srgb, var(--alert-ink) 40%, transparent);
		border-radius: var(--radius);
		box-shadow: var(--shadow-1);
	}

	.alert.lost {
		--alert-ink: var(--danger);
	}

	/* The alert banner (the SkyDemon warning form): the body opens the
	   volume's (or the obstacle's) detail panel, the cross acknowledges, and
	   the chip at the row head opens the alert panel, where the rest of the
	   queue lists. The forbidden tier and a terrain warning carry the danger
	   ink like a lost position; the clearance / equipment tiers keep the
	   family's alert orange; a caution, the terrain's included, reads one
	   step calmer in the workbook amber; a planned advisory steps back
	   rather than shouts. Severity has ONE visual threshold, present tense:
	   ahead of the boundary an alert wears its ink as a tint, inside the
	   volume it goes solid in the same ink, and so does a terrain warning
	   (CS 25.1322: time-criticality separates a caution from a warning).
	   nav/alertSurface.ts decides the ink and the form for both subjects. */
	.alert.ink-danger {
		--alert-ink: var(--danger);
	}

	.alert.ink-caution {
		--alert-ink: var(--workbook-orange);
	}

	/* The solid state's text is --surface, not --bg: the one colour that
	   clears AA on all three tier inks in BOTH themes. */
	.alert.solid {
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
	   the strip rests clean. Always the way into the alert panel. */
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

	/* On the solid banner the row background IS the ink: the chip inverts to
	   an outline in the page surface so it stays legible. */
	.alert.solid .alert-chip {
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
	   state must not open every session on a red flash. Danger is for
	   what SETTLED wrong. */
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
		cursor: pointer;
		background: none;
		border: 1px solid currentcolor;
		border-radius: 999px;
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
		cursor: pointer;
		background: none;
		border: 0;
	}

	.alert-open:hover {
		text-decoration: underline;
	}

	/* The ground ahead has no detail panel: its body is text, not a door,
	   centred like the button it stands in for when the row grows to the
	   touch floor. */
	span.alert-open {
		display: flex;
		align-items: center;
		cursor: default;
	}

	span.alert-open:hover {
		text-decoration: none;
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
		cursor: pointer;
		background: none;
		border: 0;
		border-radius: 4px;
	}

	.alert-ack:hover {
		background: color-mix(in srgb, currentcolor 12%, transparent);
	}

	/* ---- the actions ---- */

	.actions {
		display: flex;
		flex: 0 0 auto;
		gap: 2px;
		align-items: center;
		margin-left: auto;
	}

	.actions button:not(.alert-chip) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		padding: 0;
		color: var(--text-muted);
		cursor: pointer;
		background: none;
		border: 0;
		border-radius: 4px;
	}

	.actions button:not(.alert-chip):hover {
		color: var(--text);
		background: var(--surface-2);
	}

	/* A launcher reads as pressed while its surface is open, the .btn.on
	   convention (aria-pressed rides beside it). */
	.actions .log-btn[aria-pressed='true'] {
		color: var(--accent);
	}

	/* The folded toolbar's Stop, on the band: the danger fill, the one
	   filled control on the band, labelled in --surface (the .btn.danger
	   rationale). */
	.actions button.stop-btn,
	:global(:root.mobile-ui) .actions button.stop-btn {
		color: var(--surface);
		background: var(--danger);
		border-radius: 8px;
	}

	.actions button.stop-btn:hover {
		color: var(--surface);
		background: var(--danger);
	}

	/* ---- phones (mobile-ui ⇔ ui.isMobile, the doctrine) ---- */

	/* The contact row budgets the contact cell, the target cell and four
	   28 px actions across 392 px; the instrument row's five cells share the
	   width equally. */
	:global(:root.mobile-ui) .contact-row {
		gap: 6px;
	}

	:global(:root.mobile-ui) .cell.contact {
		width: 128px;
		min-width: 128px;
		max-width: 128px;
	}

	:global(:root.mobile-ui) .lead {
		height: 11px;
		font-size: 10px;
		line-height: 11px;
	}

	:global(:root.mobile-ui) .cell.contact .k.unit {
		height: 13px;
		font-size: 11px;
		line-height: 13px;
	}

	:global(:root.mobile-ui) .freq {
		font-size: 24px;
	}

	:global(:root.mobile-ui) .cell.next .fig {
		min-width: 0;
		font-size: 11px;
	}

	:global(:root.mobile-ui) .cell.inst {
		flex: 1 1 0;
		min-width: 0;
		padding: 0 2px;
	}

	:global(:root.mobile-ui) .cell.inst .v {
		font-size: 18px;
	}

	:global(:root.mobile-ui) .cell.inst.mh .v {
		font-size: 20px;
	}

	/* Display controls keep a 44 px REACH through the ::after outset while
	   the visual shrinks (the restore handle's device); the alert chip
	   follows suit. */
	:global(:root.mobile-ui) .actions button:not(.alert-chip) {
		position: relative;
		width: 28px;
		height: 28px;
	}

	:global(:root.mobile-ui) .actions button:not(.alert-chip)::after {
		position: absolute;
		inset: -8px -4px;
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

	/* ---- in flight (touch-ui: a coarse pointer OR a running recording) ---- */

	:global(:root.touch-ui) .freq {
		font-size: 26px;
	}

	:global(:root.touch-ui) .cell.inst .v {
		font-size: 21px;
	}

	:global(:root.touch-ui) .cell.inst.mh .v {
		font-size: 23px;
	}

	:global(:root.touch-ui) .cell.next.handover .v {
		font-size: 19px;
	}

	:global(:root.touch-ui) .actions button:not(.alert-chip) {
		width: 44px;
		height: 44px;
	}

	:global(:root.touch-ui.mobile-ui) .actions button:not(.alert-chip) {
		width: 30px;
		height: 30px;
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

	/* The 64 px floor while a recording runs (the in-flight class App stamps
	   beside touch-ui): the ringed cells and the actions reach it through the
	   contact row's height and the outset. */
	:global(:root.in-flight) .contact-row {
		min-height: 52px;
	}

	:global(:root.in-flight) .inst-row {
		min-height: 44px;
	}
</style>
