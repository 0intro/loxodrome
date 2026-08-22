<script lang="ts">
	import Icon from './Icon.svelte';
	import NavLogFreqCell from './NavLogFreqCell.svelte';
	import { useEnrouteFreqHover, useNavaidHover, useWaypointHover } from './featureHover.svelte';
	import { inputValue } from '$lib/ui/dom';
	import { INTL_TAG } from '$lib/i18n/intl';
	import { i18n, t } from '$lib/state/i18n.svelte';
	import {
		routeSettings,
		setWaypointNotes,
		setWaypointFreqs,
		clearWaypointFreqs,
		type Route,
		type Waypoint,
	} from '$lib/state/route.svelte';
	import { effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { effectiveCruiseSpeedKt } from '$lib/state/aircraft.svelte';
	import {
		ensureRouteTerrain,
		legMinGroundElevFt,
		routeTerrainSamples,
	} from '$lib/state/routeTerrain.svelte';
	import {
		effectiveRouteWinds,
		ensureRouteWindFor,
		routeLegWindTips,
		routeWindSummary,
		routeWindWarning,
	} from '$lib/state/routeWind.svelte';
	import { legTasKt } from '$lib/route/legWind';
	import { windAloft } from '$lib/state/windAloft.svelte';
	import { computeNavLog, waypointLabel } from '$lib/route/navlog';
	import type { NavlogLiveDisplay } from '$lib/nav/navlogLive';
	import { applicabilityFloorFt, violatesSemicircular } from '$lib/route/cruisingLevels';
	import { cruisingRegime } from '$lib/state/cruisingRegime.svelte';
	import {
		classAFloorAt,
		classACeilingLabel,
		enrouteFreqsByLeg,
	} from '$lib/route/airspaces';
	import { cachedAirspaceSchedule } from '$lib/state/navlogSchedule';
	import { computeMinAltitudes } from '$lib/route/minAltitude';
	import {
		fmtTrack,
		fmtNM,
		fmtEte,
		fmtAlt,
		fmtLevel,
		vertArrow,
		freqSeedText,
		freqDisplayLines,
	} from '$lib/route/format';
	import { legMagneticTrackDeg, decimalYearFromDate, magneticModelExpired } from '$lib/route/magnetic';
	import { windTriangle } from '$lib/route/wind';
	import { ON_FIELD_VOR_RADIUS_NM, isVor, nearestVor, waypointRadialEntries, type RadialEntry } from '$lib/route/radial';
	import {
		getAirspaces,
		getAirports,
		getNavaids,
		navaidById,
		ensureObstacles,
		dataState,
	} from '$lib/state/data.svelte';
	import { contactRadios } from '$lib/data/airports';
	import type { VerticalLimit } from '$lib/data/airspaces';
	import { coalesceRadioLines } from '$lib/format/radio';
	import {
		resolveAirportRadios,
		resolveScheduleRadios,
		freqChangeIdents,
	} from '$lib/state/freqOverride.svelte';

	interface Props {
		/** The route this sheet renders (one nav log). */
		route: Route;
		/** Editable notes + clickable idents (the modal); static otherwise (print). */
		interactive?: boolean;
		/** Per-leg minimum safe altitude, precomputed by the caller (print, where
		 *  every route's MSA is fetched up front). Omitted in the interactive modal,
		 *  where the sheet fetches its own, async, keyed on the route geometry. */
		legMinFt?: (number | null)[];
		/** Click a waypoint ident (interactive only): centre the map / open detail. */
		onIdent?: (wp: Waypoint) => void;
		/** Pad the printed grid to at least this many waypoint rows with blank lines,
		 *  so a short route still prints a full, fill-in-able form. 0 = no padding. */
		minWaypoints?: number;
		/** Continuation-card slice (kneeboard prints): render only the legs
		 *  [from, to) (ABSOLUTE leg indices, end-exclusive) plus their bounding
		 *  waypoints. Cumulative columns (Rem, the totals) keep the full route's
		 *  values; absent = the whole route, zero behavior change. */
		legRange?: { from: number; to: number } | undefined;
		/** 1-based continuation-card position; count > 1 appends "(i/n)" to the
		 *  route title, and only the last part carries the totals band and the
		 *  minWaypoints blank-row padding. */
		part?: { index: number; count: number } | undefined;
		/** A5 kneeboard-card compaction, scoped by prop (the print card mounts
		 *  in NavLogModal / PrintDoc and navlogMeasure's print-prep measuring
		 *  mount set it) and media-INDEPENDENT, so the measuring mount renders
		 *  the exact card geometry on screen and the measured row heights are
		 *  the printed ones. */
		kneeboard?: boolean;
		/** Live plog overlay (navigation mode; state/navLive.svelte.ts):
		 *  fills the ETO / ATO slots, dims passed rows, highlights the current
		 *  leg and its target waypoint. The print mounts never pass it, and a
		 *  kneeboard mount nulls it besides (the gate below), so paper output
		 *  is unchanged. */
		live?: NavlogLiveDisplay | null;
		/** Phone rendition, the COMPACT GRID: the same 8-column chevron sheet
		 *  at phone-tuned tracks and fonts (the kneeboard pattern, a scoped
		 *  CSS block with zero markup change), its visible pane pinned to end
		 *  on the Waypoint column's right border so only Notes pans. A PROP,
		 *  never a width query: navlogMeasure mounts this sheet off-viewport
		 *  ON SCREEN to pack the printed kneeboard, so a width- or
		 *  media-driven switch would silently repack every card; the class
		 *  gate below (interactive && !kneeboard) is what keeps that mount
		 *  untouched whatever it passes. */
		compact?: boolean;
	}
	let {
		route,
		interactive = false,
		legMinFt,
		onIdent,
		minWaypoints = 0,
		legRange,
		part,
		kneeboard = false,
		live: liveProp = null,
		compact = false,
	}: Props = $props();

	// Belt-and-braces against a live prop reaching a print or measuring
	// mount (NavLogSchedule's liveOn rule): the overlay renders only
	// off-kneeboard, which makes the byte-identical-paper contract of
	// docs/nav-live.md structural rather than a caller convention.
	const live = $derived(kneeboard ? null : liveProp);
	/* Structural, like the live gate above: the print and measuring mounts
	 * are neither interactive nor compact-capable, so neither paper nor the
	 * measuring mount can ever acquire the class (the compact CSS block's
	 * @media screen wrap alone would not protect the measurer, which lays
	 * its host out on screen). */
	const compactMode = $derived(interactive && !kneeboard && compact);

	const navlog = $derived(computeNavLog(route.waypoints, effectiveCruiseSpeedKt()));

	// Per-leg minimum safe altitude. Use the caller's precomputed values when
	// supplied (print); otherwise fetch here, async. The effect reads only the
	// waypoints' COORDINATES (plus the corridor half-width, which sizes the
	// terrain + obstacle swath, and the flight rules, which set the margin:
	// msaMarginForTerrainFt, 500 ft VFR / 1000 ft IFR, 2000 ft IFR over a
	// mountainous leg by the corridor ground stats), so editing leg altitudes
	// doesn't refetch terrain but a VFR/IFR flip recomputes. Null per leg
	// while loading.
	let localMinFt = $state<(number | null)[]>([]);
	let minLoading = $state(false);
	const minFt = $derived(legMinFt ?? localMinFt);
	$effect(() => {
		const halfWidthNM = routeSettings.minAltCorridorRadiusNM;
		const vfr = routeSettings.vfr;
		const pts = route.waypoints.map((w) => ({ lat: w.lat, lon: w.lon }));
		if (legMinFt !== undefined || pts.length < 2) {
			// Caller supplies MSAs (print), or no leg to measure yet.
			localMinFt = [];
			minLoading = false;
			return;
		}
		const ctrl = new AbortController();
		minLoading = true;
		void ensureObstacles()
			.then((obstacles) =>
				computeMinAltitudes(pts, obstacles, { signal: ctrl.signal, halfWidthNM, vfr }),
			)
			.then((mins) => {
				if (!ctrl.signal.aborted) {
					localMinFt = mins;
					minLoading = false;
				}
			})
			.catch(() => {
				if (!ctrl.signal.aborted) {
					localMinFt = [];
					minLoading = false;
				}
			});
		return () => ctrl.abort();
	});

	// Declination changes negligibly over a session; evaluate once.
	const year = decimalYearFromDate(new Date());
	// Generated-date stamp in the UI locale; $derived (not a const) so a
	// locale switch re-renders it instead of freezing the init language.
	const genDate = $derived(
		new Intl.DateTimeFormat(INTL_TAG[i18n.locale], {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
		}).format(new Date()),
	);

	// Per-leg minimum ground elevation for the semicircular badge's
	// applicability floor (shared route-terrain cache; all-null until the
	// samples land, the conservative side).
	const legMinElev = $derived(
		routeSettings.semicircular ? legMinGroundElevFt(route.id, route.waypoints) : [],
	);

	// One leg's row values, named after the columns they fill (Alt / MSA,
	// MC / MH, Dist / Rem, ETE / ETE-W).
	interface LegView {
		arrow: string;
		altFt: number;
		msaFt: number | null;
		belowMsa: boolean;
		levelWarn: boolean;
		mcDeg: number;
		mhDeg: number | null;
		distNM: number;
		remNM: number;
		eteMin: number | null;
		eteWMin: number | null;
		/** Wind provenance hover for the MH and ETE/W cells (screen-only). */
		windTip: string | null;
	}

	// WMM2025 validity advisory, appended to the MH cell's provenance tip
	// (the MH is the one column the declination steers). One boolean; the
	// wall clock can't cross 2030.0 mid-session in any way worth tracking.
	const wmmExpired = magneticModelExpired(new Date());
	// Body defers the t read, so the advisory follows a locale switch.
	const mhTip = (lv: LegView | null): string | undefined => {
		const lines: string[] = [];
		if (lv?.windTip != null) {
			lines.push(lv.windTip);
		}
		if (wmmExpired && lv?.mhDeg != null) {
			lines.push(t.navlog.wmmExpiredTip);
		}
		return lines.length > 0 ? lines.join('\n') : undefined;
	};

	// Effective per-leg winds (override, forecast, global fallback) + their
	// provenance tips and the print-visible header summary, all from the one
	// shared resolver so the sheet, the Route tab and the exports agree.
	const legWinds = $derived(effectiveRouteWinds(route));
	const legTips = $derived(routeLegWindTips(route));
	const windSummary = $derived(routeWindSummary(route));
	const windWarning = $derived(routeWindWarning(route));

	const legs = $derived<LegView[]>(
		navlog.legs.map((leg, k) => {
			// Wind triangle (effective per-leg wind vs true track) -> magnetic
			// heading + ground speed. Null unless a cruise speed (TAS) and a wind
			// resolve; the TAS is temperature-corrected per leg when the option is
			// on and the forecast carries a temperature.
			const tas0 = effectiveCruiseSpeedKt();
			const ew = legWinds[k] ?? null;
			const from = route.waypoints[leg.index - 1];
			const to = route.waypoints[leg.index];
			const tas =
				tas0 != null && tas0 > 0
					? legTasKt(tas0, ew?.forecast?.tempC ?? null, from.alt, windAloft.tempTas)
					: null;
			const wind = tas != null && ew ? windTriangle(leg.trackTrueDeg, tas, ew.dirDeg, ew.speedKt) : null;
			// Per-leg altitude: this leg flies at its from-waypoint's alt; the arrow
			// shows the change from the previous leg (a climb out of the departure
			// for the first leg, where there is no previous leg).
			const prevLegAlt = route.waypoints[leg.index - 2]?.alt;
			const msaFt = minFt[k] ?? null;
			const mcDeg = legMagneticTrackDeg(leg.trackTrueDeg, from, to, year);
			return {
				arrow: vertArrow(prevLegAlt ?? 0, from.alt),
				altFt: from.alt,
				msaFt,
				// Flag a leg planned below its minimum safe altitude.
				belowMsa: msaFt != null && from.alt < msaFt,
				// Flag a level off the semicircular table (the RouteTab badge's
				// predicate, on the same unrounded magnetic track).
				levelWarn:
					routeSettings.semicircular &&
					leg.legNM > 1e-6 &&
					violatesSemicircular(
						from.alt,
						mcDeg,
						routeSettings.vfr,
						applicabilityFloorFt(legMinElev[k] ?? null, routeSettings.vfr),
						cruisingRegime(),
					),
				mcDeg,
				// Magnetic heading: the wind-corrected true heading run through the
				// same variation.
				mhDeg: wind
					? legMagneticTrackDeg(leg.trackTrueDeg + wind.wcaDeg, from, to, year)
					: null,
				distNM: leg.legNM,
				// Distance remaining to the destination, from this leg's start.
				remNM: navlog.totalNM - (leg.cumNM - leg.legNM),
				eteMin: leg.eteMin,
				eteWMin: wind ? (leg.legNM / wind.gsKt) * 60 : null,
				windTip: legTips[k] ?? null,
			};
		}),
	);

	// Wind-corrected total trip time: the sum of the per-leg ETE/W, or null when
	// the wind is unset or any leg is unflyable into it (so it stays blank).
	const totalEteWMin = $derived(
		legs.length > 0 && legs.every((l) => l.eteWMin != null)
			? legs.reduce((s, l) => s + (l.eteWMin ?? 0), 0)
			: null,
	);

	// Continuation-card slice: the legs / waypoints THIS card renders. The
	// LegView list above stays full-route, so every per-leg lookup (minFt,
	// legWinds, legMinElev, enrouteByLeg) keeps its absolute index and the
	// cumulative columns (Rem, the totals) keep their absolute values; only
	// the render slice narrows. The bounding waypoint at sliceTo repeats as
	// the next card's first row, so each card is a self-contained sub-log.
	const sliceFrom = $derived(legRange ? Math.max(0, legRange.from) : 0);
	const sliceTo = $derived(legRange ? Math.min(legs.length, legRange.to) : legs.length);
	const cardLegs = $derived(legRange ? legs.slice(sliceFrom, sliceTo) : legs);
	const cardWps = $derived(
		legRange ? route.waypoints.slice(sliceFrom, sliceTo + 1) : route.waypoints,
	);
	// The totals band and the blank-row padding belong to the LAST card only
	// (or the whole log when unsplit).
	const lastPart = $derived(!part || part.index === part.count);
	// Continuation-card marker appended to the route title: bare numerals,
	// locale-invariant, present only when the log is actually split.
	const partSuffix = $derived(part && part.count > 1 ? ` (${part.index}/${part.count})` : '');

	// Pad the printed grid to a minimum number of waypoint rows so a short route
	// still prints a full, fill-in-able form: blank legs + waypoints render after
	// the real ones, up to minWaypoints.
	// Pad only UNSPLIT cards: the blank filler rows make a short route's
	// lone card read as a full form, but a continuation part of a long
	// route must stay as small as its slice (padding the last part was
	// measured to push its totals onto a spill page).
	const padCount = $derived(Math.max(0, minWaypoints - cardWps.length));
	const totalLegs = $derived(cardLegs.length + padCount);
	const totalWps = $derived(cardWps.length + padCount);
	// Grid row of the totals band, under the last (real or blank) leg.
	const totalsRow = $derived(3 + 2 * totalLegs);

	const depLabel = $derived(route.waypoints.length ? waypointLabel(route.waypoints[0]) : '');
	const destLabel = $derived(route.waypoints.length ? waypointLabel(route.waypoints.at(-1)!) : '');

	const airspaces = $derived(dataState.airspacesLoaded ? getAirspaces() : null);

	// Upper Class A floor (the VFR ceiling) over each waypoint, VFR only. Drives the
	// red "Classe A NNNN" banner on the first line of the notes cell.
	const classACeilByWp = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on change
		const m = new Map<string, VerticalLimit>();
		if (!routeSettings.vfr || !airspaces) {
			return m;
		}
		for (const w of route.waypoints) {
			const floor = classAFloorAt(w.lat, w.lon, airspaces);
			if (floor) {
				m.set(w.id, floor);
			}
		}
		return m;
	});

	// Terrain via the shared per-route cache: exact AGL/ASFC evaluation,
	// agreeing with NavLogSchedule and the route profile by construction.
	$effect(() => {
		ensureRouteTerrain(route.id, route.waypoints);
	});

	// Forecast winds via the shared per-route cache (the terrain idiom): the
	// kneeboard prints render several sheets, so each self-ensures its winds.
	$effect(() => {
		void ensureRouteWindFor(route);
	});
	const terrain = $derived(routeTerrainSamples(route.id, route.waypoints));

	// The same walk NavLogSchedule (mounted beside this sheet) runs for its
	// table, deduped through its keyed memo; only the cheap radio-override
	// resolution stays per-instance (it tracks the freq-override state).
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
	const scheduleResolved = $derived(airspaces ? resolveScheduleRadios(schedule, airspaces) : schedule);

	// Per-leg enroute contact frequencies, listed under each from-waypoint when the
	// setting is on: the override-resolved schedule grouped by leg (Class A / E count
	// only under IFR). Empty when the toggle is off, so the cell shows airport radios
	// alone. Indexed by from-waypoint; the last waypoint has no outbound leg.
	const enrouteByLeg = $derived(
		routeSettings.enrouteFreqsInNavlog && airspaces
			? enrouteFreqsByLeg(
					scheduleResolved,
					navlog.legs.map((l) => l.cumNM),
					!routeSettings.vfr,
				)
			: [],
	);

	// VOR-family navaids, the candidates for the on-field airport radial.
	const vorCandidates = $derived(
		dataState.navaidsLoaded ? (getNavaids() ?? []).filter((n) => isVor(n.type)) : [],
	);

	// Per-waypoint VOR radial entries, a fixed banner atop the notes cell that
	// describes the leg LEAVING the waypoint: a QDR when the waypoint is (or is on
	// field of) a VOR, and a QDM for the next waypoint's VOR. A navaid waypoint uses
	// its own VOR; an airport a VOR on field (ON_FIELD_VOR_RADIUS_NM).
	const radialByWp = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on change
		const m = new Map<string, RadialEntry[]>();
		if (!dataState.navaidsLoaded || !routeSettings.vorRadialsInNavlog) {
			return m;
		}
		const wps = route.waypoints;
		const vorOf = wps.map((wp) => {
			if (wp.kind === 'navaid' && wp.refId) {
				const n = navaidById(wp.refId);
				return n && isVor(n.type) ? n : null;
			}
			if (wp.kind === 'airport') {
				return nearestVor(wp.lat, wp.lon, vorCandidates, ON_FIELD_VOR_RADIUS_NM);
			}
			return null;
		});
		for (let i = 0; i + 1 < wps.length; i++) {
			const entries = waypointRadialEntries(wps[i], vorOf[i], wps[i + 1], vorOf[i + 1], year);
			if (entries.length > 0) {
				m.set(wps[i].id, entries);
			}
		}
		return m;
	});

	// Coalesced airport frequencies keyed by ICAO, shown under each airport
	// waypoint's report banner, with any active frequency-change NOTAM applied so
	// the log reports the current value.
	const airportRadioByIdent = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index, rebuilt on change
		const m = new Map<string, { label: string; freq: string }[]>();
		if (!dataState.airportsLoaded || !routeSettings.airportFreqsInNavlog) {
			return m;
		}
		const ids = freqChangeIdents();
		for (const a of getAirports() ?? []) {
			// contactRadios is the gate: a closed field's published channels are
			// not a frequency to set, so the column stays empty under it (the
			// waypoint keeps its row; only the radio goes).
			if (contactRadios(a).length === 0) {
				continue;
			}
			const ident = a.ident.toUpperCase();
			const radios = ids.has(ident) ? resolveAirportRadios(a).radios : a.radios;
			m.set(ident, coalesceRadioLines(radios));
		}
		return m;
	});

	function onIdentKey(e: KeyboardEvent, wp: Waypoint): void {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onIdent?.(wp);
		}
	}

	/* Pointing at a row flashes what it names on the map, the rule the airport
	   list, the context menu and the schedule rows already follow. Three
	   targets: the ident cell and the aerodrome's own frequency lines mean this
	   WAYPOINT (its pin, since the aerodrome symbol sits under it); an enroute
	   frequency line means every airspace it merges; a VOR radial means its
	   station, which hoverFeature's pin rule turns back into a pin when the
	   station is the waypoint itself. Each list is empty on the print and
	   measuring mounts, which render the same lines: gating the LIST keeps the
	   effect inert there without a per-span ternary. */
	const hover = useWaypointHover(() => (interactive ? cardWps : []));
	const enrouteHover = useEnrouteFreqHover(() => (interactive ? enrouteByLeg.flat() : []));
	const radialHover = useNavaidHover(() =>
		interactive ? [...radialByWp.values()].flat().map((e) => e.navaidId) : [],
	);

	// Which waypoint's manual frequencies are being edited (interactive only;
	// this instance renders the active route, so the activeRoute()-based
	// setters apply to it, the notes-textarea precedent). The RouteTab
	// windEdit pattern: leaving the editor commits, Escape cancels, the reset
	// button hands the cell back to automatic. The seed and `autoText` (the
	// back-to-auto equality target) are frozen at open so both are the lines
	// the user saw; the live draft belongs to NavLogFreqCell.
	let freqEdit = $state<{ id: string; seed: string; autoText: string } | null>(null);

	function openFreqEdit(wp: Waypoint, autoText: string): void {
		freqEdit = { id: wp.id, seed: wp.freqsManual ?? autoText, autoText };
	}

	function commitFreqEdit(text: string): void {
		if (!freqEdit) {
			return;
		}
		setWaypointFreqs(freqEdit.id, text, freqEdit.autoText);
		freqEdit = null;
	}

	function cancelFreqEdit(): void {
		freqEdit = null;
	}

	function resetFreqEdit(): void {
		if (!freqEdit) {
			return;
		}
		clearWaypointFreqs(freqEdit.id);
		freqEdit = null;
	}

	// The leg-data columns' two-line header labels (columns 1-4, in order):
	// invariant ICAO Doc 8400 abbreviations plus the t.navlog KEY of the
	// tooltip spelling each out, resolved in the template so a locale switch
	// re-renders (docs/i18n.md rule 2: no t.* in a module-scope const).
	const SPLIT_HEADERS = [
		{ top: 'Alt', topTip: 'hdrAltTip', bot: 'MSA', botTip: 'hdrMsaTip' },
		{ top: 'MC', topTip: 'hdrMcTip', bot: 'MH', botTip: 'hdrMhTip' },
		{ top: 'Dist', topTip: 'hdrDistTip', bot: 'Rem', botTip: 'hdrRemTip' },
		{ top: 'ETE', topTip: 'hdrEteTip', bot: 'ETE/W', botTip: 'hdrEteWTip' },
	] as const;

	/** Leg-band shading (legs alternate .alt), for the chevron notch gradient;
	 *  the live current leg's halves carry the same tint as its
	 *  .lcell.current cells, so the tint runs into the chevron notch. */
	function shade(alt: boolean, current = false): string {
		const base = alt ? 'var(--surface-2)' : 'var(--surface)';
		// i18n-ignore: a CSS colour expression, not user-visible text
		return current ? `color-mix(in srgb, var(--nav-live) 10%, ${base})` : base;
	}
</script>

<!-- Root wrapper carrying the kneeboard compaction scope; display: contents,
     so it generates no box and the sheet's layout (modal body, print cards,
     fragmentation) is byte-identical to the unwrapped markup. -->
<div class="sheet" class:kneeboard class:compact={compactMode}>

<div class="title-line">
	<strong>{depLabel} → {destLabel}{partSuffix}</strong>
	<span>{fmtNM(navlog.totalNM)} NM</span>
	{#if navlog.totalEteMin !== null}
		<span title={t.navlog.totalEteTip}>ETE {fmtEte(navlog.totalEteMin)}</span>
	{/if}
	{#if windSummary}
		<span class="windline" title={t.navlog.windSummaryTip}>{windSummary}</span>
	{/if}
	{#if windWarning}
		<span class="windwarn" title={t.navlog.windSummaryTip}>{windWarning}</span>
	{/if}
	<span class="gen">{genDate}</span>
</div>

<div class="scroll">
	<div class="navlog">
		<!-- header (full band); the leg-data columns carry split two-line labels.
		     Unlike the leg / totals cells in column 4, the ETE header keeps its
		     right border: no chevron bevel runs beside row 1, so the ETO header
		     is a plain adjacent cell wanting the standard divider. -->
		{#each SPLIT_HEADERS as h, i (h.top)}
			<div class="hcell split" style:grid-column={i + 1} style:grid-row="1">
				<span class="htop" title={t.navlog[h.topTip]}>{h.top}</span>
				<span class="hbot" title={t.navlog[h.botTip]}>{h.bot}</span>
			</div>
		{/each}
		<div class="hcell" style:grid-column="5" style:grid-row="1" title={t.navlog.etoTip}>ETO</div>
		<div class="hcell" style:grid-column="6" style:grid-row="1" title={t.navlog.atoTip}>ATO</div>
		<div class="hcell" style:grid-column="7" style:grid-row="1">{t.navlog.waypoint}</div>
		<!-- col 8 is the grid's right edge; `edge` closes the header band at
		     the same weight as the .wcell frame below it. -->
		<div class="hcell edge" style:grid-column="8" style:grid-row="1">{t.navlog.notes}</div>

		<!-- close the empty leg-data cells under the header (the first
		     waypoint pentagon is offset up half a band) -->
		<div class="lcell headclose" style:grid-column="1" style:grid-row="2"></div>
		<div class="lcell headclose" style:grid-column="2" style:grid-row="2"></div>
		<div class="lcell headclose" style:grid-column="3" style:grid-row="2"></div>
		<div class="lcell headclose noedge" style:grid-column="4" style:grid-row="2"></div>

		<!-- leg bands (continuous; waypoint pentagons offset half a band);
		     lv = null renders a blank padding band (see minWaypoints) -->
		{#snippet legRow(lv: LegView | null, k: number)}
			{@const band = `${3 + 2 * k} / span 2`}
			{@const liveCur = live != null && sliceFrom + k === live.currentLegIdx}
			{@const livePassed = live?.wpts[sliceFrom + k + 1]?.passed ?? false}
			<div
				class="lcell"
				class:alt={k % 2 === 0}
				class:below={lv?.belowMsa}
				class:levelwarn={lv?.levelWarn && !lv?.belowMsa}
				class:passed={livePassed}
				class:current={liveCur}
				class:curbar={liveCur}
				style:grid-column="1"
				style:grid-row={band}
				title={lv?.levelWarn ? t.navlog.levelWarnTip : undefined}
			>
				<div class="ctop">
					{#if lv}<span class="arrow">{lv.arrow}</span><span
						>{fmtLevel(
							lv.altFt,
							routeSettings.semicircular ? effectiveTransitionAltFt() : Infinity,
						)}</span
					>{/if}
				</div>
				<div class="cbot msa">
					{#if lv}{lv.msaFt != null ? fmtAlt(lv.msaFt) : minLoading ? '…' : ''}{/if}
				</div>
			</div>
			<div
				class="lcell"
				class:alt={k % 2 === 0}
				class:passed={livePassed}
				class:current={liveCur}
				style:grid-column="2"
				style:grid-row={band}
			>
				<div class="ctop">{lv ? fmtTrack(lv.mcDeg) : ''}</div>
				<!-- Wind provenance hover on the wind-corrected value only (the MC above
				     it is windless), so the tip explains the number it belongs to; the
				     WMM validity advisory joins it once the model is expired. -->
				<div class="cbot val" title={mhTip(lv)}>
					{lv?.mhDeg != null ? fmtTrack(lv.mhDeg) : ''}
				</div>
			</div>
			<div
				class="lcell"
				class:alt={k % 2 === 0}
				class:passed={livePassed}
				class:current={liveCur}
				style:grid-column="3"
				style:grid-row={band}
			>
				<div class="ctop val">{lv ? fmtNM(lv.distNM) : ''}</div>
				<div class="cbot dim">{lv ? fmtNM(lv.remNM) : ''}</div>
			</div>
			<div
				class="lcell noedge"
				class:alt={k % 2 === 0}
				class:passed={livePassed}
				class:current={liveCur}
				style:grid-column="4"
				style:grid-row={band}
			>
				<div class="ctop">{lv ? fmtEte(lv.eteMin) : ''}</div>
				<!-- Wind provenance hover on the wind-corrected ETE/W only (the ETE above
				     it is windless), so the tip explains the number it belongs to. -->
				<div class="cbot val" title={lv?.windTip ?? undefined}>
					{lv?.eteWMin != null ? fmtEte(lv.eteWMin) : ''}
				</div>
			</div>
			{#if liveCur && live?.currentLegFrac != null}
				<!-- Along-leg progress bar (the SkyDemon live-plog convention): an
				     overlay grid item over the four leg cells, sitting just above
				     the leg seam. It states its value rather than only drawing
				     it, the bar being the one live figure on the sheet carried
				     by width alone. -->
				<div
					class="leg-progress"
					role="progressbar"
					aria-label={t.navigation.legProgress}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(live.currentLegFrac * 100)}
					style:grid-column="1 / span 4"
					style:grid-row={band}
					style:width={`${(live.currentLegFrac * 100).toFixed(1)}%`}
				></div>
			{/if}
		{/snippet}
		{#each cardLegs as lv, k (k)}
			{@render legRow(lv, k)}
		{/each}
		{#each { length: padCount }, i}
			{@render legRow(null, cardLegs.length + i)}
		{/each}

		<!-- waypoint bands (offset half a band); wp = null renders a blank padding band -->
		{#snippet waypointRow(wp: Waypoint | null, j: number)}
			{@const band = `${2 + 2 * j} / span 2`}
			{@const seamRow = 3 + 2 * j}
			{@const curTop = live != null && j > 0 && sliceFrom + j - 1 === live.currentLegIdx}
			{@const curBot = live != null && j < totalLegs && sliceFrom + j === live.currentLegIdx}
			{@const nTop = shade(j % 2 === 1, curTop)}
			{@const nBot = shade(j < totalLegs && j % 2 === 0, curBot)}
			{@const wpRadios =
				wp?.kind === 'airport' && wp.ident
					? (airportRadioByIdent.get(wp.ident.toUpperCase()) ?? [])
					: []}
			<!-- enrouteByLeg is indexed by ABSOLUTE from-waypoint; j is card-local -->
			{@const enr = wp ? (enrouteByLeg[sliceFrom + j] ?? []) : []}
			<!-- The contact ink belongs to the leg being flown: the same airspace is
			     listed on every leg its span covers, so an unscoped match would bold
			     legs already flown and legs still to come. -->
			{@const liveBand = live != null && live.currentLegIdx === sliceFrom + j}
			{@const autoFreqText = freqSeedText(
				wpRadios.map((f) => `${f.label}: ${f.freq}`),
				enr.filter((f) => !f.closed).map((f) => `${f.label}: ${f.freq}`),
			)}
			{@const lw = wp && live ? (live.wpts[sliceFrom + j] ?? null) : null}
			<!-- fill the chevron notch with the adjacent leg shading so the leg
			     data runs into the chevron (the notch straddles two legs) -->
			<div
				class="notch-fill"
				style:grid-column="5 / span 3"
				style:grid-row={band}
				style:background={`linear-gradient(to bottom, ${nTop} 50%, ${nBot} 50%)`}
			></div>
			<div
				class="report"
				class:alt={j % 2 === 1}
				class:first={j === 0 && sliceFrom === 0}
				class:passed={lw?.passed ?? false}
				class:target={lw?.target ?? false}
				style:grid-column="5 / span 3"
				style:grid-row={band}
			>
				<span class="rep-slot" class:filled={lw != null}>
					{#if lw?.eto}
						<span class="slot-val" title={lw.passed ? undefined : t.navlog.etoLiveTip}
							>{lw.eto}</span
						>
					{/if}
				</span>
				<span class="rep-slot" class:filled={lw != null}>
					{#if lw?.ato}<span class="slot-val ato">{lw.ato}</span>{/if}
				</span>
				<span class="rep-label">
					{#if wp}
						{#if interactive && onIdent}
							<span
								class="ident-link"
								role="button"
								tabindex="0"
								title={t.navlog.showOnMap(waypointLabel(wp))}
								onclick={() => onIdent(wp)}
								onkeydown={(e) => onIdentKey(e, wp)}
								onmouseenter={() => hover.set(wp)}
								onmouseleave={() => hover.set(null)}
								onfocus={() => hover.set(wp)}
								onblur={() => hover.set(null)}>{waypointLabel(wp)}</span>
						{:else}
							<span class="rep-name">{waypointLabel(wp)}</span>
						{/if}
						{#if interactive && freqEdit?.id === wp.id}
							<!-- Manual-frequencies editor: leaving commits (blank text or
							     the automatic lines hand the cell back to auto), Escape
							     cancels, the button resets to the automatic list. -->
							<NavLogFreqCell
								initial={freqEdit.seed}
								onCommit={commitFreqEdit}
								onCancel={cancelFreqEdit}
								onReset={resetFreqEdit}
							/>
						{:else if wp.freqsManual != null}
							<span class="rep-freqs" title={t.navlog.freqManualTip}>
								{#each freqDisplayLines(wp.freqsManual) as l, idx (idx)}
									<span class="rep-freq" class:sep={l.sep}>{l.text}</span>
								{/each}
							</span>
						{:else if wpRadios.length > 0 || enr.length > 0}
							<span class="rep-freqs">
								<!-- The aerodrome's own frequencies name this waypoint, so they
								     flash its pin exactly as its ident cell does. The map flash is
								     a POINTER-ONLY convenience over text that also prints on the
								     kneeboard card, so these lines take no role and no tab stop:
								     nothing is lost without a pointer. -->
								{#each wpRadios as f (f.label + '|' + f.freq)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<span
										class="rep-freq"
										onmouseenter={() => hover.set(wp)}
										onmouseleave={() => hover.set(null)}>{f.label}: {f.freq}</span
									>
								{/each}
								<!-- An enroute line flashes EVERY airspace it merges: co-frequency
								     sectors coalesce into one line ("SIV SEINE 1 / 2 / 3"). -->
								{#each enr as f, idx (f.label + '|' + f.freq)}
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<span
										class="rep-freq"
										class:sep={idx === 0 && wpRadios.length > 0}
										class:rep-closed={f.closed}
										title={f.closed ? t.navlog.freqClosedTip(f.closedBy ?? '') : undefined}
										class:contact={liveBand &&
											live?.contactKey != null &&
											f.keys.includes(live.contactKey)}
										class:next-contact={liveBand &&
											live?.nextContactKey != null &&
											f.keys.includes(live.nextContactKey)}
										onmouseenter={() => enrouteHover.set(f)}
										onmouseleave={() => enrouteHover.set(null)}>{f.label}: {f.freq}</span
									>
								{/each}
							</span>
						{/if}
					{/if}
				</span>
				{#if wp && interactive && freqEdit?.id !== wp.id}
					<!-- Pencil opening the manual-frequencies editor; outside the
					     lines' length gate so an empty cell can receive text too. -->
					<button
						class="freq-edit no-print"
						class:manual={wp.freqsManual != null}
						title={(wp.freqsManual != null ? t.navlog.freqManualTip + '\n' : '') +
							t.navlog.freqEditTip}
						aria-label={t.navlog.freqEditAria}
						onclick={() => openFreqEdit(wp, autoFreqText)}
					>
						<Icon name="edit-2" size={11} />
					</button>
				{/if}
			</div>
			<!-- the "<" chevron stroke: an un-clipped overlay grid item painted on
			     top of the banner (see .rep-bevel) -->
			<svg
				class="rep-bevel"
				style:grid-column="5 / span 3"
				style:grid-row={band}
				viewBox="0 0 12 100"
				preserveAspectRatio="none"
				aria-hidden="true"
			>
				<path d="M12 0 L0 50 L12 100" />
			</svg>
			<!-- band-bottom rules, one box per weight, anchored to the shared grid
			     line (see the .notch-bridge / .wp-seam comment) -->
			<div class="notch-bridge" style:grid-column="5" style:grid-row={seamRow}></div>
			<div
				class="wp-seam"
				class:last={j === totalWps - 1}
				style:grid-column="5 / -1"
				style:grid-row={seamRow}
			></div>
			<div class="wcell notes" class:alt={j % 2 === 1} style:grid-column="8" style:grid-row={band}>
				{#if wp && classACeilByWp.has(wp.id)}
					<div class="class-a-ceil" title={t.navlog.classATip}>
						{classACeilingLabel(classACeilByWp.get(wp.id)!)}
					</div>
				{/if}
				{#if wp && radialByWp.has(wp.id)}
					<div class="radial-note" title={t.navlog.radialTip}>
						<!-- The station flashes on the map; hoverFeature's pin rule turns
						     it back into a pin when the VOR IS this waypoint, while an
						     on-field VOR (a separate point up to 3 NM off) keeps its own
						     symbol. -->
						{#each radialByWp.get(wp.id)! as e, idx (idx)}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div
								class="radial-entry"
								onmouseenter={() => radialHover.set(e.navaidId)}
								onmouseleave={() => radialHover.set(null)}
							>
								<span class="radial-station">{e.stationLine}</span>
								<span class="radial-bearings">{e.bearingLine}</span>
							</div>
						{/each}
					</div>
				{/if}
				{#if wp && interactive}
					<textarea
						class="notes-input"
							autocapitalize="sentences"
						aria-label={t.navlog.waypointNotesAria}
						value={wp.notes ?? ''}
						oninput={(e) => setWaypointNotes(wp.id, inputValue(e))}
					></textarea>
				{:else}
					<div class="notes-static">{wp?.notes ?? ''}</div>
				{/if}
			</div>
		{/snippet}
		{#each cardWps as wp, j (wp.id)}
			{@render waypointRow(wp, j)}
		{/each}
		{#each { length: padCount }, i}
			{@render waypointRow(null, cardWps.length + i)}
		{/each}

		{#if lastPart}
			<!-- totals (full-route values; on a split log, the last card only) -->
			<div class="tcell tlabel" style:grid-column="1 / span 2" style:grid-row={totalsRow}>
				{t.navlog.total}
			</div>
			<div class="tcell" style:grid-column="3" style:grid-row={totalsRow}>
				{fmtNM(navlog.totalNM)}
			</div>
			<div class="tcell noedge twoline" style:grid-column="4" style:grid-row={totalsRow}>
				<!-- Wind-corrected total is the bold primary (like the per-leg ETE/W
				     .val); the still-air total above it mutes to secondary only while a
				     wind total sits below, else it stands alone as the bold total. -->
				<span class:dim={totalEteWMin != null}>{fmtEte(navlog.totalEteMin)}</span>
				{#if totalEteWMin != null}<span>{fmtEte(totalEteWMin)}</span>{/if}
			</div>
		{:else}
			<!-- Continuation part: the totals row's slot under the Alt / MC /
			     Dist / ETE columns would otherwise be a void (no background, no
			     closing border) beside the final banner's lower half; this cap
			     paints it and closes the frame the way the totals band does. -->
			<div class="cut-cap" style:grid-column="1 / span 4" style:grid-row={totalsRow}></div>
		{/if}
	</div>
</div>

{#if radialByWp.size > 0}
	<p class="radial-foot no-print">{t.navlog.radialFoot}</p>
{/if}

</div>

<style>

	/* The kneeboard-scope wrapper is layout-inert: no box, children
	   participate in the parent layout exactly as before. It also carries
	   the live-plog ink: the nav-mode identity orange (map/navLayer
	   TRACE_COLOR family; an app-identity colour, deliberately not in
	   palette.ts). */
	.sheet {
		--nav-live: var(--nav-orange);

		display: contents;
	}

	.title-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px 14px;
		margin-bottom: 12px;
		font-size: 13px;
		color: var(--text-muted);
	}

	.title-line strong {
		font-size: 14px;
		color: var(--text);
	}

	.title-line .gen {
		margin-left: auto;
	}

	/* Wind provenance: prints with the sheet, so the paper says which model,
	   run and validity its MH / ETE-W numbers came from. */
	.title-line .windline {
		font-size: 11px;
	}

	/* Why the forecast is NOT behind those numbers (out of the model's reach,
	   out of the endpoint's range, or a failed fetch). Prints for the same
	   reason the provenance line does: it is a statement about the very
	   figures on that sheet. The sheet's advisory ink, the below-MSA red
	   staying the one alarm. */
	.title-line .windwarn {
		color: var(--workbook-orange);
		font-size: 11px;
	}

	.scroll {
		overflow-x: auto;
	}

	/* ---- flight-record grid: waypoint pentagon rows alternating with leg rows ---- */
	.navlog {
		display: grid;
		grid-template-columns:
			64px 56px 56px 52px 56px 56px
			minmax(180px, 1fr) minmax(180px, 1fr);

		/* Rows grow with their content, on screen and on paper alike: a
		   truncated name or frequency is unrecoverable on paper and hidden in
		   the modal, so long lines wrap and the bands grow past the 56px
		   minimum instead of ellipsising. A growing banner spans 2 rows whose
		   growth limits are both capped at the row minimum (by the subgridded
		   ctop / cbot in every leg row), so the extra height is distributed
		   beyond the limits equally over both rows and the chevron tip (50% of
		   the band) stays on the leg seam. */
		grid-auto-rows: minmax(56px, auto);
		min-width: 760px;
		font-size: 11px;

		/* Outer frame: a clean 2px grey perimeter (the right / bottom edges come
		   from the edge cells, bumped to match). */
		border-top: 2px solid var(--border-strong);
		border-left: 2px solid var(--border-strong);
	}

	.hcell {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2px 4px;
		font-weight: 600;
		text-align: center;
		color: var(--text-muted);
		background: var(--surface-2);
		border-right: 1px solid var(--border-strong);

		/* Heavy header underline (the form's title rule). */
		border-bottom: 2px solid var(--border-strong);
	}

	/* The header band's own right edge is the grid frame, like .wcell's below
	   it, so it takes the frame's 2px rather than the 1px inter-column rule:
	   the title row used to end in a hairline while every row under it closed
	   heavy. */
	.hcell.edge {
		border-right-width: 2px;
	}

	/* Two stacked labels in one header cell; weight is inherited from .hcell. */
	.hcell.split .htop,
	.hcell.split .hbot {
		line-height: 1.25;
	}

	.lcell {
		/* Subgrid, NOT a flex column: ctop / cbot land in the two real grid rows,
		   so the faint divider between them (ctop's border-bottom) ends exactly on
		   the shared grid line, like the .notch-bridge continuing it across the
		   notch. A flex split anchors that divider off the flex arithmetic instead,
		   and at fractional device-pixel scales it snaps to a different device row
		   than the bridge (a visible step right at the chevron). */
		display: grid;
		grid-template-rows: subgrid;
		min-width: 0;
		background: var(--surface);
		border-right: 1px solid var(--border-strong);

		/* Leg seam (Family A): heavy 2px, so each leg band is clearly bounded; the
		   chevron tip to its right meets this line (half-band offset). */
		border-bottom: 2px solid var(--border-strong);
	}

	/* The grown-band equal split (see .navlog's grid-auto-rows) needs the FIRST
	   banner's upper row (the row-2 header closers) capped like every other
	   band row, but an empty subgrid registers no cap. As plain blocks (they
	   are empty; the background and borders paint the same) they cap row 2 at
	   the row minimum, so the first band grows symmetrically too. */
	.lcell.headclose {
		display: block;
	}

	.lcell.alt {
		background: var(--surface-2);
	}

	/* Planned altitude (Alt) is below the leg's minimum safe altitude (MSA): flag
	   the cell so an unsafe leg stands out (prints legibly too). */
	.lcell.below .ctop {
		color: var(--danger);
		font-weight: 700;
	}

	/* Planned level off the semicircular table for the leg's magnetic track
	   (the below-MSA red keeps priority when both apply). */
	.lcell.levelwarn .ctop {
		color: var(--workbook-orange);
		font-weight: 700;
	}

	/* The two split values sit together, centred in the tall leg band so the
	   block reads as one between its waypoint names; each fills and is centred
	   (both axes) in its half (a subgrid row). The faint divider is the "~"
	   line; the strong cell borders are the "|" / "_" lines. */
	.lcell .ctop,
	.lcell .cbot {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		min-height: 0;
		padding: 0 6px;
		line-height: 1.3;
		font-variant-numeric: tabular-nums;
		color: var(--text);
	}

	/* Two-row split: a faint divider between the top and bottom value, shown for
	   every cell (Alt/MSA, MC/MH, Dist/Rem, ETE still-air / ETE wind-corrected).
	   On ctop's BOTTOM edge (the grid line), not cbot's top, so it snaps to the
	   same device row as the .notch-bridge at every zoom / display scale. */
	.lcell .ctop {
		border-bottom: 1px solid var(--border);
	}

	.lcell .val {
		font-weight: 700;
	}

	.lcell .dim {
		color: var(--text-muted);
	}

	/* Minimum safe altitude (MSA): the leg's hard floor, in bold red. */
	.lcell .msa {
		color: var(--danger);
		font-weight: 700;
	}

	.lcell .arrow {
		font-size: 13px;
		color: var(--accent);
	}

	.wcell {
		background: var(--surface);

		/* Right edge of the grid frame: col 8 is exclusively .wcell, so this is the
		   perimeter; 2px to match the frame. The waypoint seam below the cell comes
		   from the .wp-seam overlay (cols 5-8), not an own border-bottom. */
		border-right: 2px solid var(--border-strong);
	}

	.wcell.alt {
		background: var(--surface-2);
	}

	.wcell.notes {
		display: flex;
		flex-direction: column;
		padding: 0;
	}

	/* First line of the notes cell: the upper Class A floor (VFR ceiling). Fixed
	 * red so white stays readable in both themes; centred; printed too. */
	.class-a-ceil {
		flex: 0 0 auto;
		padding: 2px 6px;
		font-size: 11px;
		font-weight: 700;
		text-align: center;
		color: #fff;
		background: #dc3545;
		overflow: hidden;
		overflow-wrap: anywhere;

		/* keep the colour fill when printing the nav log */
		print-color-adjust: exact;
	}

	/* VOR tuning + magnetic radial banner in the notes cell, above the editable
	   note. Reference info (not a warning), so theme colours, not red; prints.
	   One entry per VOR referenced (QDR leaving a VOR, QDM to the next VOR). */
	.radial-note {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 3px 6px;
		font-size: 11px;
		line-height: 1.3;
		color: var(--text);
		border-bottom: 1px solid var(--border);
	}

	.radial-entry {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.radial-station {
		font-variant-numeric: tabular-nums;
	}

	.radial-bearings {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	/* Magnetic-basis caveat under the nav-log grid. */
	.radial-foot {
		margin: 8px 0 0;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Spreadsheet-style copy: one click selects a whole value, so it is easy to
	   grab a frequency, course, distance or radial and paste it elsewhere. The
	   editable note and the click-to-navigate ident keep their normal behaviour. */
	.lcell .ctop,
	.lcell .cbot,
	.tcell,
	.rep-freq,
	.radial-station,
	.radial-bearings {
		user-select: all;
	}

	/* Editable per-waypoint note; fills the rest of the (6-line) cell. */
	.notes-input {
		width: 100%;
		flex: 1;
		min-height: 0;
		padding: 4px 6px;
		font: inherit;
		font-size: 11px;
		color: var(--text);
		background: transparent;
		border: none;
		resize: none;
	}

	.notes-input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -2px;
	}

	/* Static counterpart of .notes-input for the (non-interactive) printout: an
	   empty box to write in on the kneeboard, or the pre-typed note, wrapping. */
	.notes-static {
		flex: 1;
		min-height: 0;
		padding: 4px 6px;
		font-size: 11px;
		color: var(--text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* Totals row: value cells centred; the "Total" label cell overrides to the
	   left below. */
	.tcell {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0 6px;
		font-weight: 700;
		font-variant-numeric: tabular-nums;

		/* No own top rule: the last leg's 2px bottom seam already draws the line above
		   the Total row, so a border-top here would double it to ~4px. The border-bottom
		   is the grid's bottom frame edge; column dividers (border-right) stay 1px. */
		border-right: 1px solid var(--border-strong);
		border-bottom: 2px solid var(--border-strong);
	}

	/* The continuation cap: fills the totals row's slot under the Alt / MC /
	   Dist / ETE columns on a cut card (background + a closing line) so the
	   frame doesn't end in a void. The line stays at the ordinary 1px seam
	   weight: the card is a CUT, not the route's end, and a 2px frame edge
	   reads too bold there. */
	.cut-cap {
		background: var(--surface);
		border-bottom: 1px solid var(--border-strong);
	}

	.tcell.tlabel {
		justify-content: flex-start;
		font-weight: 600;
		color: var(--text-muted);
	}

	/* Total ETE over total ETE/W, stacked like the per-leg ETE / ETE/W cell:
	   the still-air total sits on top, the bold wind-corrected total below. */
	.tcell.twoline {
		flex-direction: column;
		gap: 4px;
		line-height: 1.15;
	}

	/* Still-air total, de-emphasised while the wind-corrected total is present
	   (no explicit font-size, so it tracks the grid's screen 11px / kneeboard
	   8px instead of pinning 11px onto the compacted card). */
	.tcell.twoline .dim {
		font-weight: 400;
		color: var(--text-muted);
	}

	/* Leg-data column adjacent to the waypoint banner: no right border, so the
	   chevron is the only line at that boundary (no straight divider beside it). */
	.noedge {
		border-right: none;
	}

	/* The band-bottom line (the mid-leg junction) is NOT drawn by the band cells'
	   borders: at fractional device-pixel scales (OS scaling, browser zoom) each
	   box snaps to the pixel grid on its own, so a line assembled from several
	   borders (the lcell divider + the notch-fill's bottom + the report's clipped
	   bottom) lands on different device rows per piece, or vanishes under the
	   next band's snapped background / the report's clip-path raster. Instead one
	   overlay box per weight, both bottom-anchored to the SAME grid row line (so
	   they snap together), z-lifted above both bands' backgrounds and free of any
	   clip-path; the chevron svg crowns them at z-index 2. */
	.notch-bridge,
	.wp-seam {
		position: relative;
		z-index: 1;
		pointer-events: none;
	}

	/* Faint bridge across the chevron notch, continuing the mid-leg divider at
	   the leg side's weight up to the chevron base (x = 12px), NOT the heavy
	   waypoint seam: that would poke a heavy stub left of the "<" into the notch. */
	.notch-bridge {
		width: 12px;
		border-bottom: 1px solid var(--border);
	}

	/* Waypoint seam (Family B): heavy 2px bounding the waypoint group across the
	   banner and the Notes column; starts at the chevron base. The chevron tip
	   meets the equally-heavy leg seam to its left (half-band offset). */
	.wp-seam {
		margin-left: 12px;
		border-bottom: 2px solid var(--border-strong);
	}

	/* The last band's bottom is the grid's bottom frame edge: run the heavy rule
	   across the notch too, level with the totals row's 2px border. */
	.wp-seam.last {
		margin-left: 0;
	}

	/* The waypoint banner: a left-pointing pentagon spanning the ETO + ATO + name
	   columns; the chevron point sits at the leg-time (ETE) edge (the leg data).
	   The clip tip is at calc(50% - 1px), matching the stroke's translateY(-1px)
	   (see .rep-bevel), so the background bevel stays under the "<" stroke.
	   No own border-bottom: the waypoint seam is the .wp-seam overlay, outside
	   this clip-path (whose raster eats a border sitting on the clip's bottom
	   edge at some fractional device-pixel scales). */
	.report {
		position: relative;
		display: flex;
		align-items: stretch;
		font-size: 12px;
		color: var(--text);
		background: var(--surface);
		clip-path: polygon(12px 0, 100% 0, 100% 100%, 12px 100%, 0 calc(50% - 1px));
		border-right: 1px solid var(--border-strong);
	}

	.report.alt {
		background: var(--surface-2);
	}

	/* The report's clip-path drops its border on the bevelled (left) edge, so draw the
	   "<" as a non-scaling stroke. It is a SEPARATE grid item, NOT a child of .report:
	   inside the clip the tip is cut short of the leg seam (Firefox kept the gap even
	   with the tip on the clip point), so as an un-clipped overlay its tip reaches x=0,
	   the column boundary where the leg seam ends. The point is a sharp (~22deg) angle,
	   so miter it (limit 12) or the join flattens to a bevel. The pentagon's straight
	   edges use right borders and the seam overlays only, so stacked pentagons never
	   double. z-index 2 keeps the stroke above the .notch-bridge / .wp-seam ink, so
	   the "<" stays crisp where its base vertex meets them.

	   The path's vertices land ON the grid lines, but every rule's ink hugs the
	   pixels ABOVE its line (border-bottom inside the box), its centre half a
	   thickness up. translateY(-1px) centres the tip and the base vertices on the
	   2px seams' ink, so the "<" pierces the line instead of hanging a beak below
	   it; all chevrons shift together, so consecutive arms still meet exactly.
	   Keep the default overflow (hidden): the tip's miter wedge is ~7px tall near
	   the apex, so letting it overflow paints a visible bulge over the seam's end;
	   clipped at x=0 it fuses flush with the seam. */
	.rep-bevel {
		position: relative;
		z-index: 2;
		width: 12px;
		height: 100%;
		justify-self: start;
		fill: none;
		stroke: var(--border-strong);
		stroke-linejoin: miter;
		stroke-miterlimit: 12;

		/* Slightly heavier so the "<" doesn't look thin beside the 2px seams. */
		stroke-width: 1.5;
		transform: translateY(-1px);
		pointer-events: none;

		/* Width-fixed with a 12:100 viewBox, so the intrinsic ratio reads as a
		   100px max-content height, which would silently inflate the growable
		   rows (the 40px kneeboard ones first). It is a stretched overlay,
		   never a size driver. */
		contain: size;
	}

	.rep-bevel path {
		vector-effect: non-scaling-stroke;
	}

	/* ETO / ATO write-in slots inside the banner, 56px each so they line up
	   with the ETO / ATO header columns. */
	.report .rep-slot {
		flex: 0 0 56px;
		border-right: 1px solid var(--border-strong);
	}

	.report .rep-slot:first-child {
		padding-left: 14px;
	}

	/* The departure has no estimated time over (the first leg starts here), so grey
	   only its ETO slot; the ATO slot stays writable for the actual takeoff time.
	   Only the route's ABSOLUTE first waypoint qualifies: a continuation card's
	   boundary row repeats a mid-route waypoint, whose ETO is real. */
	.report.first .rep-slot:first-child {
		background: var(--surface-3);
	}

	.rep-label {
		display: flex;
		flex: 1;
		flex-direction: column;
		justify-content: flex-start;
		gap: 1px;
		min-width: 0;

		/* Bottom cushion: a grown band is sized exactly to its content, so
		   without it the waypoint seam would kiss the last line's descenders. */
		padding: 5px 8px 4px;
		overflow: hidden;
		text-align: center;
	}

	/* Waypoint name line, wrapping when long (the band grows). Rendered as the
	   clickable .ident-link when the waypoint has a feature, else as a plain
	   .rep-name. */
	.rep-name,
	.ident-link {
		overflow: hidden;
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	/* The OACI / navaid identifier is the one interactive element of the (now
	   static, text-selectable) report banner: clicking it opens the feature's
	   detail panel and centres the map. A plain span, selectable like the rest
	   of the table, styled as a link; the report cell itself no longer reacts. */
	.ident-link {
		display: block;
		max-width: 100%;
		color: inherit;
		cursor: pointer;
	}

	.ident-link:hover {
		text-decoration: underline;
	}

	.ident-link:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	/* Coalesced airport frequencies under the waypoint name, smaller and
	   muted, one line per distinct frequency (e.g. "TWR / A/A: 121.100"). */
	.rep-freqs {
		display: flex;
		flex-direction: column;
		min-width: 0;
		font-size: 10px;
		font-weight: 400;
		line-height: 1.3;
		color: var(--text-muted);
	}

	.rep-freq {
		overflow: hidden;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}

	/* First enroute (per-leg airspace) frequency line: a dotted rule sets the enroute
	   block off from the airport radios listed above it. */
	.rep-freq.sep {
		margin-top: 3px;
		padding-top: 3px;
		border-top: 1px dotted var(--border);
	}

	/* Pencil opening the manual-frequencies editor (interactive only): faint
	   until the banner is hovered or it is focused (never invisible, so it
	   stays reachable on touch); orange = the cell holds manual text. */
	.freq-edit {
		position: absolute;
		top: 2px;
		right: 2px;
		z-index: 3;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		padding: 0;
		color: var(--text-muted);
		cursor: pointer;
		background: none;
		border: none;
		opacity: 0.25;
	}

	.report:hover .freq-edit,
	.freq-edit:focus-visible,
	.freq-edit.manual {
		opacity: 1;
	}

	.freq-edit.manual {
		color: var(--workbook-orange);
	}

	/* ---- live plog overlay (navigation mode; the `live` prop) ----
	   Passed rows dim their planned values but keep the stamped slots
	   readable (the ATO is the record); the current leg carries the tint,
	   the left edge bar and the along-leg progress bar (the SkyDemon
	   live-plog convention); the target waypoint's banner shares the tint.
	   Absent the prop, none of these classes render: print output is
	   unchanged. The --nav-live ink sits on .sheet above. */
	.lcell.passed .ctop,
	.lcell.passed .cbot,
	.report.passed .rep-label {
		opacity: 0.55;
	}

	.lcell.current {
		background: color-mix(in srgb, var(--nav-live) 10%, var(--surface));
	}

	.lcell.current.alt {
		background: color-mix(in srgb, var(--nav-live) 10%, var(--surface-2));
	}

	.lcell.curbar {
		box-shadow: inset 3px 0 0 var(--nav-live);
	}

	.leg-progress {
		align-self: end;
		justify-self: start;
		height: 3px;
		margin-bottom: 2px;
		background: var(--nav-live);
		pointer-events: none;
	}

	.report.target {
		background: color-mix(in srgb, var(--nav-live) 10%, var(--surface));
	}

	.report.target.alt {
		background: color-mix(in srgb, var(--nav-live) 10%, var(--surface-2));
	}

	/* Passed checkmark as generated content on the name itself, so it rides
	   the same line whether the ident renders as a link or a plain name. */
	.report.passed .rep-name::before,
	.report.passed .ident-link::before {
		content: '✓ ';
		color: var(--nav-live);
		font-weight: 700;
	}

	/* The enroute line of the airspace currently being talked to (and the
	   next one), matched by the contact keys the nav-live selector injects,
	   on the band of the leg being flown only (see liveBand). */
	.rep-freq.contact {
		font-weight: 700;
		color: var(--nav-live);
	}

	.rep-freq.next-contact {
		color: var(--nav-live);
	}

	/* A line whose frequency a service-closure NOTAM withdrew: kept (the
	   published record, and the tooltip names the NOTAM) but struck and
	   muted, the working substitute reading normally beside it. Inline
	   text styling only, so the measured card packing never moves. Wins
	   over the contact tints by order, though a closed line's span is
	   dropped from the resolution and never carries them. */
	.rep-freq.rep-closed {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	/* A filled slot centres its single live time; well under the band's row
	   minimum, so live fills never grow the grid. */
	.report .rep-slot.filled {
		display: flex;
		align-items: center;
		justify-content: center;
		font-variant-numeric: tabular-nums;
	}

	/* The estimate in regular weight, the stamped actual bold: the filled
	   pair reads like a hand-kept HE / HR column. */
	.rep-slot .slot-val.ato {
		font-weight: 700;
	}

	/* ---- kneeboard compaction (two A5 cards per landscape A4) ----
	   Shrink the grid so the full 8-column record fits one A5 card. Scoped by
	   the kneeboard PROP (the root wrapper's class), not html.navlog-kneeboard,
	   and OUTSIDE @media print: media-independent, so navlogMeasure's
	   print-prep measuring mount renders the exact card geometry on screen.
	   The prop only ever comes true for the print card mounts (hidden or
	   parked off-viewport on screen) and that measuring host. Numeric columns
	   tighten; the banner's write-in slots follow the ETO/ATO columns; Notes
	   keeps the slack. */
	.kneeboard .scroll {
		overflow: visible;
	}

	.kneeboard .navlog {
		min-width: 0;
		grid-template-columns:
			40px 38px 38px 36px 40px 40px
			minmax(72px, 1fr) minmax(72px, 1fr);
		grid-auto-rows: minmax(40px, auto);
		font-size: 8px;
		border-top-width: 1.5px;
		border-left-width: 1.5px;
	}

	/* The 40px Alt column leaves 28px of content at the screen padding, and
	   an arrowed four-digit altitude runs ~29px at the 8px font: tighten the
	   value cells so the number stays inside its border. */
	.kneeboard .lcell .ctop,
	.kneeboard .lcell .cbot {
		padding: 0 2px;
		gap: 2px;
	}

	/* Keep the heavier seams / frame proportionate on the compacted A5 card: the
	   2px screen rules read clumsy at the 40px track / 8px font, so trim them to
	   1.5px (still heavier than the old 1px). Covers the NavLogModal kneeboard
	   and the FlightPrep dossier cards, which pass the prop. */
	.kneeboard .hcell,
	.kneeboard .lcell,
	.kneeboard .wp-seam,
	.kneeboard .tcell {
		border-bottom-width: 1.5px;
	}

	.kneeboard .wcell,
	.kneeboard .hcell.edge {
		border-right-width: 1.5px;
	}

	.kneeboard .report,
	.kneeboard .rep-freqs {
		font-size: 8px;
	}

	.kneeboard .report .rep-slot {
		flex-basis: 40px;
	}

	.kneeboard .report .rep-slot:first-child {
		padding-left: 8px;
	}

	.kneeboard .rep-label {
		padding: 3px 4px;
	}

	.kneeboard .class-a-ceil,
	.kneeboard .radial-note,
	.kneeboard .notes-static {
		font-size: 8px;
	}

	.kneeboard .title-line {
		margin-bottom: 6px;
		font-size: 9px;
	}

	.kneeboard .title-line strong {
		font-size: 10px;
	}

	/* ---- phone compaction (the `compact` prop) ----------------------------
	   The same sheet at phone-tuned tracks and fonts, the kneeboard block's
	   pattern; nothing else changes, chevrons and live cues included. The
	   whole block is wrapped in @media screen because .sheet.compact
	   selectors out-specify the print block's bare ones and the class stays
	   mounted during the phone's plain modal print: unwrapped, a phone would
	   print a compacted sheet. (The kneeboard block above exploits the same
	   specificity to SURVIVE into print; this block must do the opposite.)
	   The measuring mount is protected by the class gate alone (compactMode,
	   above), never by media: its host lays out on screen. */
	@media screen {
		/* The visible pane ends exactly on the Waypoint column's right
		   border, whatever the device width: 2px frame + 44+40+40+38+42+42
		   + 128 = 376. Only the Notes column pans. Keep in lockstep with the
		   compact tracks below. On a body under 376px (a 360px phone)
		   max-width shrinks the pane into the Waypoint column instead;
		   accepted. */
		.sheet.compact .scroll {
			width: 376px;
			max-width: 100%;
		}

		.sheet.compact .navlog {
			/* max-content, NOT 0: the 2px frame borders sit on .navlog, and
			   with fixed tracks overflowing a live scroller a zero min-width
			   would leave the top frame painted only across the pane's
			   stretch width, so panning into Notes showed a frameless
			   header. */
			min-width: max-content;
			grid-template-columns: 44px 40px 40px 38px 42px 42px 128px 150px;

			/* Half-band rows: 42px minimum bands (wide 112, kneeboard 80).
			   Borders keep their full screen weight on purpose; the
			   kneeboard's 1.5px thinning is a paper economy. */
			grid-auto-rows: minmax(21px, auto);
			font-size: 9px;
		}

		.sheet.compact .lcell .ctop,
		.sheet.compact .lcell .cbot {
			padding: 0 3px;
		}

		.sheet.compact .report {
			font-size: 10px;
		}

		/* Keep the write-in slots on the compact ETO / ATO tracks. */
		.sheet.compact .report .rep-slot {
			flex-basis: 42px;
		}

		/* Clear the 12px clip notch exactly. */
		.sheet.compact .report .rep-slot:first-child {
			padding-left: 12px;
		}

		.sheet.compact .rep-label {
			padding: 3px 4px;
		}

		.sheet.compact .rep-freqs {
			font-size: 8px;
		}

		.sheet.compact .class-a-ceil,
		.sheet.compact .radial-note,
		.sheet.compact .notes-input,
		.sheet.compact .radial-foot {
			font-size: 8px;
		}

		/* Hover does not exist on the device this mode serves: the pencil
		   shows always, and an invisible slop ring takes its 18px box to the
		   44px floor (18 + 2x13; the banner's clip trims the ring's
		   top/right ~2px, accepted). The app.css touch doctrine: the tables
		   must not reflow, so hit areas grow by pseudo-element, never by
		   layout. The pencil is already absolutely positioned, so its
		   ::after needs no positioning context of its own. */
		.sheet.compact .freq-edit {
			opacity: 1;
		}

		.sheet.compact .freq-edit::after {
			position: absolute;
			inset: -13px;
			content: '';
		}
	}

	@media print {
		/* The magnetic-basis caveat is on-screen only. */
		.no-print {
			display: none !important;
		}

		/* On paper there is no scrolling to fall back on: the page width is
		   fixed, so the grid has to FIT it. The 760px floor is a screen-only
		   device (the modal scrolls rather than crushing the columns), and the
		   scroll box kept clipping what stuck out - A4 portrait less the 12mm
		   body padding is 703px, so 57px of the last column, Notes, was cut
		   off the right edge. The kneeboard already dropped both for the same
		   reason; this is the portrait sheet catching up.

		   340px of that goes to the six fixed columns, leaving the two
		   flexible ones ~181px each at A4. Their floor drops to 150px so a
		   narrower printable area (a printer with deeper unprintable edges)
		   compresses them instead of overflowing again; at A4 the 1fr share is
		   what applies, so nothing moves. */
		.scroll {
			overflow: visible;
		}

		.navlog {
			min-width: 0;
			grid-template-columns:
				64px 56px 56px 52px 56px 56px
				minmax(150px, 1fr) minmax(150px, 1fr);
		}

		/* Keep each leg band, waypoint banner and notes cell whole across a page
		   (portrait) or A5-card (kneeboard) break. */
		.lcell,
		.wcell,
		.report {
			break-inside: avoid;
		}

		/* Keep the totals band with the last leg band: Chromium can otherwise
		   orphan it alone on the next page / card. .tcell is exclusively the
		   totals band (the header cells are .hcell), so the bare selector
		   already scopes to it. break-inside, NOT break-before: avoid, which
		   Chromium's grid fragmentation honours by pushing the totals to a
		   fresh page even with room to spare (measured via printToPDF). */
		.tcell {
			break-inside: avoid;
		}
	}
</style>
