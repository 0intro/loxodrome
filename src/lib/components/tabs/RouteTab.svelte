<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import HeadOverlay from '../HeadOverlay.svelte';
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import Icon from '../Icon.svelte';
	import Segmented from '../Segmented.svelte';
	import RouteStrip from './route/RouteStrip.svelte';
	import RouteTextField from './route/RouteTextField.svelte';
	import WaypointRow from './route/WaypointRow.svelte';
	import { useWaypointHover } from '../featureHover.svelte';
	import type { LegView, LegWarn } from './route/legView';
	import { inputValue, inputChecked, downloadBlob, openFileWith } from '$lib/ui/dom';
	import { pickerAccept } from '$lib/ui/filePicker';
	import {
		cancelTerrainPins,
		downloadTerrainPins,
		ensureTerrainPinStats,
		offlineTerrain,
		pinRadiusNM,
		planRoutePoints,
		removeTerrainPins,
		pinLevels,
		terrainPinQueued,
		terrainPinRunning,
	} from '$lib/state/offlineTerrain.svelte';
	import { openOffline } from '$lib/state/offlineModal.svelte';
	import { corridorTerrainTiles, estimateBytes, isoDay } from '$lib/offline/terrainPin';
	import { formatPackBytes } from '$lib/offline/packStore';
	import {
		activeRoute,
		routes,
		routeSettings,
		setRouteVfr,
		setAirspacesOnRouteOnly,
		setFlightParamsOpen,
		setMinAltDangerOn,
		reorderWaypoint,
		setWaypointAltitude,
		setRouteAlternate,
		clearRoute,
		clearAllRoutes,
		undoRoute,
		redoRoute,
		routeHistory,
		totalDistanceNM,
		estimatedTimeMin,
		legDistancesNM,
		MAX_ROUTES,
		MAX_LEG_ALT_FT,
		type Waypoint,
	} from '$lib/state/route.svelte';
	import { planFileSubject, routesFileBaseName } from '$lib/route/routeLabel';
	import {
		ROUTE_FORMATS,
		buildRouteExport,
		type RouteFormat,
	} from '$lib/route/routeExport';
	import { MIN_POINTS, planExportPoints, routeExportPoints } from '$lib/route/routePoints';
	import { fileName } from '$lib/files/fileName';
	import { buildSendFplPlan, buildSendFplRoute } from '$lib/route/sendfpl';
	import { sendFplHandoff, sendRouteToSendFpl } from '$lib/native/sendfpl';
	import { isNativeApp } from '$lib/native/platform';
	import { openIncomingBytes, pickFileNatively } from '$lib/state/openFile.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import {
		activePlan,
		activePlanDirty,
		buildWorkspaceFileYaml,
		canStorePlan,
		hasStorableWorkspace,
		setActivePlanSource,
		storePlan,
		storePlanAs,
	} from '$lib/state/activePlan.svelte';
	import { signedIn } from '$lib/state/account.svelte';
	import { ensureLinks } from '$lib/state/flightLinks.svelte';
	import {
		clearRouteLoadOutcome,
		routeLoad,
		unknownAircraftShown,
	} from '$lib/state/routeLoad.svelte';
	import { restoreHeldNow } from '$lib/state/routePersist';
	import { nav } from '$lib/state/navRecording.svelte';
	import {
		airportByIdent,
		dataState,
		ensureAirports,
		ensureAirspaces,
		getAirspaces,
	} from '$lib/state/data.svelte';
	import {
		applicabilityFloorFt,
		computeCruiseAltitudes,
		inTransitionLayer,
		snapToLevel,
		transitionLevelFt,
		violatesSemicircular,
	} from '$lib/route/cruisingLevels';
	import { classAFloorsForLegs, transitionAltitudesInForce } from '$lib/route/airspaces';
	import { autoTransitionAlt, effectiveTransitionAltFt } from '$lib/state/transitionAlt.svelte';
	import { cruisingRegime } from '$lib/state/cruisingRegime.svelte';
	import { legMinGroundElevFt } from '$lib/state/routeTerrain.svelte';
	import { ensureRouteMsa, routeMsaLegs } from '$lib/state/routeMsa.svelte';
	import { oeiCheckable, oeiLegText, oeiRouteCheck } from '../flightprep/oeiRoute';
	import { adviseLevels, type LevelSuggestion } from '$lib/route/levelAdvisor';
	import { display } from '$lib/state/display.svelte';
	import { filter, setNotamsOnRouteOnly } from '$lib/state/filter.svelte';
	import { openFlights } from '$lib/state/flightsModal.svelte';
	import {
		automaticConsumptionLph,
		automaticCruiseFrom,
		automaticCruiseSpeedKt,
		cruiseSettingLost,
		cruiseSettings,
		effectiveConsumptionLph,
		effectiveCruiseSpeedKt,
		planCruiseSetting,
		type PlanCruiseSetting,
	} from '$lib/state/aircraft.svelte';
	import { clearOnBoard, clearStopovers, flightPrep } from '$lib/state/flightPrep.svelte';
	import { orderedTrips } from '$lib/aircraft/trips';
	import { fmtAlt, fmtLevel, fmtLevelUnit, fmtNM, fmtDurationMin, fmtTrack, fmtWind } from '$lib/route/format';
	import {
		effectiveRouteWinds,
		routeForecastMissedLegs,
		routeLegForecasts,
		routeLegWindTips,
		routeWindBrief,
		routeWindColumns,
		routeWindEteMin,
		routeWindWarning,
	} from '$lib/state/routeWind.svelte';
	import { paramsSummary, partStandsOut, type ParamPart } from './route/paramsSummary';
	import { routeTabFocus } from '$lib/state/routeTabFocus.svelte';
	import { windSummaryNote } from '$lib/route/legWind';
	import { windAloft } from '$lib/state/windAloft.svelte';
	import { computeNavLog } from '$lib/route/navlog';
	import { legMagneticTrackDeg, decimalYearFromDate } from '$lib/route/magnetic';

	// Load the datasets the route feature needs, WHEN it needs them. Route is
	// the tab the app opens on, so loading all three at mount meant a first
	// boot fetched airports, then navaids and airspaces for every country the
	// coverage gate allows, before the pilot had touched anything, for layers
	// that are off by default: 101 dataset requests and 7 MB.
	//
	// Airports carry the tab's own display (a waypoint row names its
	// aerodrome), so they load with it. Navaids are the route field's
	// autocomplete and its snapping, so RouteTextField asks on focus.
	// Airspaces answer the Class A cap, the transition altitude and the
	// nav-log schedule, none of which exist under two waypoints.
	//
	// All idempotent; the ensure* loaders rethrow after recording the failure,
	// so swallow the rejections here and let dataState.*Error surface them.
	$effect(() => {
		void ensureAirports().catch(() => {});
	});

	$effect(() => {
		if (activeRoute().waypoints.length >= 2) {
			void ensureAirspaces().catch(() => {});
		}
	});

	const enough = $derived(activeRoute().waypoints.length >= 2);
	const totalNM = $derived(totalDistanceNM());
	// The terrain-pin row's live tile count (a few ms over a whole plan);
	// tracks every waypoint and both corridor knobs through the two readers.
	const plannedTileCount = $derived(
		corridorTerrainTiles(planRoutePoints(), pinRadiusNM(), pinLevels()).length,
	);
	// The status line is store-derived; reconcile once per mount.
	void ensureTerrainPinStats();
	/** The picker's value for the plan's own figures (no setting is named so:
	 *  a sheet's names never start with a NUL). */
	const CUSTOM_PICK = '\u0000custom';

	// Effective cruise speed: the flight plan's own when the Cruise box holds
	// one, else the automatic speed, the selected aircraft's (the box's grey
	// placeholder, 100 kt without a plane).
	const effCruise = $derived(effectiveCruiseSpeedKt());
	const autoCruise = $derived(automaticCruiseSpeedKt());
	// The fuel flow beside it: the plan's own, else its setting's (the grey
	// value), so a different speed comes with its own burn.
	const autoLph = $derived(automaticConsumptionLph());
	// The plane's cruise settings (the sheet's default first), the one the
	// plan flies, a name the sheet does not hold, and whether the plan states
	// its own speed or fuel flow (the picker then reads Custom).
	const settingsList = $derived(cruiseSettings());
	const planSetting = $derived(planCruiseSetting());
	const settingLost = $derived(cruiseSettingLost());
	const cruiseCustom = $derived(routeSettings.cruiseSpeedKt !== null || routeSettings.cruiseConsumptionLph !== null);
	const cruisePick = $derived(
		cruiseCustom ? CUSTOM_PICK : planSetting && !planSetting.isDefault ? (planSetting.name ?? '') : '',
	);
	const eteMin = $derived(estimatedTimeMin(effCruise));
	// Per-leg distances (length n-1); leg i is shown on the connector under
	// waypoint i, where its altitude (wp[i].alt) is edited.
	const legDist = $derived(legDistancesNM());

	// Declination changes negligibly over a session; evaluate once.
	const year = decimalYearFromDate(new Date());

	// Per-leg magnetic track (length n-1), leg i shown under waypoint i. Same recipe
	// as NavLogSheet.svelte / navlogExport.ts (WMM magnetic at the leg midpoint,
	// today), so the list and the nav log never disagree. Unrounded; fmtTrack
	// rounds for display, the semicircular badge tests the raw value.
	const legTracks = $derived.by(() => {
		const wps = activeRoute().waypoints;
		return computeNavLog(wps, null).legs.map((leg, i) =>
			legMagneticTrackDeg(leg.trackTrueDeg, wps[i], wps[i + 1], year),
		);
	});

	// Per-leg minimum ground elevation for the semicircular applicability floor
	// (all-null until the samples land; sea-level fallback is conservative). A
	// tracked read of the shared route terrain (MapView keeps it warm).
	const legMinElev = $derived(
		routeSettings.semicircular
			? legMinGroundElevFt(activeRoute().id, activeRoute().waypoints)
			: [],
	);

	// Per-leg auto target altitude (the VFR Class A rule + the semicircular
	// cruising levels when on, the same computation MapView applies): the
	// automatic altitude a pilot's leg box shows in grey and hands back when
	// emptied, and the target the level fixes and the advisor pass, so a click
	// landing on it returns the leg to automatic. Whether a leg IS automatic
	// is its own altAuto flag (WaypointRow). Independent of wp.alt, so editing
	// a leg doesn't recompute.
	const autoAltTargets = $derived(
		computeCruiseAltitudes(activeRoute().waypoints, {
			vfr: routeSettings.vfr,
			defaultFt: routeSettings.defaultAltitudeFt,
			classA: getAirspaces(),
			semicircular: routeSettings.semicircular,
			legMinElevFt: legMinElev,
			timeYears: year,
			regime: cruisingRegime(),
		}),
	);

	// National cruising-level regime (VFR ceiling + UTA parity floor): US for a
	// route inside a K-prefix FIR, else Europe (state/cruisingRegime.svelte.ts).
	const regime = $derived(cruisingRegime());

	// Effective transition altitude: the manual override when set, else the
	// AIP-derived automatic value (state/transitionAlt.svelte.ts).
	const effTa = $derived(effectiveTransitionAltFt());

	// Provenance for the Transition field's tooltip: which tier supplies the
	// automatic value, or that a manual override is active.
	const taTitle = $derived.by(() => {
		const base = t.route.taTipBase;
		if (routeSettings.transitionAltitudeFt !== null) {
			return `${base} ${t.route.taTipManual}`;
		}
		const auto = autoTransitionAlt();
		if (auto.source.kind === 'aip') {
			return `${base} ${t.route.taTipAip(auto.source.ident)}`;
		}
		if (auto.source.kind === 'blanket') {
			return `${base} ${t.route.taTipBlanket(auto.source.region)}`;
		}
		return `${base} ${t.route.taTipDefault}`;
	});

	// Transition level for the transition-layer advisory: from the dossier QNH
	// when set, else the standard band (TA + 1000 ft, ENR 1.7.2.3).
	const transitionLvl = $derived(transitionLevelFt(effTa, flightPrep.dossier.qnhHpa));

	// Where a transition altitude may actually be in force per leg: France
	// publishes TAs per TMA only, so inside the French FIRs and clear of every
	// controlled volume the advisory is suppressed (no TA, no layer, en
	// route); everywhere else, and on every unknown, it stays. Tracks wp.alt
	// (the volume test is level-dependent), so altitude edits re-evaluate.
	const legTaInForce = $derived(
		routeSettings.semicircular
			? transitionAltitudesInForce(activeRoute().waypoints, getAirspaces())
			: [],
	);

	// A cruising level for prose (titles): "FL 065" above the TA, "4500 ft" at
	// or below.
	function levelLabel(ft: number): string {
		return fmtLevelUnit(ft, effTa);
	}

	// The semicircular warning for one leg, or null: a non-compliant level
	// (click-to-fix, never auto-rewritten) wins over the transition-layer
	// advisory. Shares violatesSemicircular with NavLogSheet so the list badge
	// and the printed sheet never disagree.
	function semicircularWarn(wp: Waypoint, i: number): LegWarn | null {
		if (!routeSettings.semicircular) {
			return null;
		}
		const track = (legDist[i] ?? 0) > 1e-6 ? (legTracks[i] ?? null) : null;
		const floorFt = applicabilityFloorFt(legMinElev[i] ?? null, routeSettings.vfr);
		if (track != null && violatesSemicircular(wp.alt, track, routeSettings.vfr, floorFt, regime)) {
			const fixFt = snapToLevel(wp.alt, track, routeSettings.vfr, { floorFt }, regime);
			return {
				kind: 'level',
				fixFt,
				title:
					fixFt != null
						? t.route.warnNotSemicircular({ track: fmtTrack(track), fix: levelLabel(fixFt) })
						: t.route.warnNoLevelFits,
			};
		}
		if ((legTaInForce[i] ?? true) && inTransitionLayer(wp.alt, effTa, transitionLvl)) {
			return {
				kind: 'layer',
				title: t.route.warnTransitionLayer({
					ta: fmtAlt(effTa),
					tl: fmtLevel(transitionLvl, effTa),
				}),
			};
		}
		return null;
	}

	// A twin's en-route one-engine check (CAT.POL.A.315 as the model,
	// flightprep/oeiRoute.ts): each leg's MSA against the net ceiling at the
	// trip's take-off mass in the forecast's air. The MSAs come from the
	// shared memo the nav log reads, asked here only for such a sheet; a
	// single computes nothing.
	const msaOpts = $derived({
		halfWidthNM: routeSettings.minAltCorridorRadiusNM,
		vfr: routeSettings.vfr,
	});
	const oeiOn = $derived(oeiCheckable() !== null);
	$effect(() => {
		const r = activeRoute();
		if (oeiOn && r.waypoints.length >= 2) {
			ensureRouteMsa(r.id, r.waypoints, msaOpts);
		}
	});
	const oeiCheck = $derived.by(() => {
		if (!oeiOn) {
			return null;
		}
		const r = activeRoute();
		return oeiRouteCheck(r, routeMsaLegs(r.id, r.waypoints, msaOpts) ?? []);
	});

	// The leg's one warning slot (legView.ts): the level first, then the
	// one-engine ceiling, then the transition layer. The title carries the
	// one-engine sentence whatever holds the slot, so a level to fix never
	// hides it.
	function legWarn(wp: Waypoint, i: number): LegWarn | null {
		const semi = semicircularWarn(wp, i);
		const leg = oeiCheck?.legs[i] ?? null;
		const oei = oeiCheck && leg?.below ? oeiLegText(leg, oeiCheck.mass) : null;
		if (oei === null) {
			return semi;
		}
		if (semi?.kind === 'level') {
			return { ...semi, title: `${semi.title}\n${oei}` };
		}
		const title = `${oei} ${t.route.oeiOpenProfile}`;
		return { kind: 'oei', title: semi ? `${title}\n${semi.title}` : title };
	}

	// Effective per-leg winds + provenance for the W/V chips (the shared
	// resolver, so the chip, the nav log and the exports agree).
	const legWinds = $derived(effectiveRouteWinds(activeRoute()));
	const legWindTips = $derived(routeLegWindTips(activeRoute()));
	// The same resolver with the overrides skipped: what each leg's W/V
	// editor shows in grey and what clearing its override hands back.
	const legAutoWinds = $derived(effectiveRouteWinds(activeRoute(), { overrides: false }));

	// Summary wind effect: total delta + average effective component, from
	// the same wind total the profile title shows. Null (nothing appended)
	// while no leg resolves a wind or the effect rounds away.
	const windNote = $derived(
		legWinds.some((w) => w != null)
			? windSummaryNote(eteMin, routeWindEteMin(activeRoute()), totalNM, effCruise, t.navlog)
			: null,
	);

	// The plan's wind source in force: Forecast needs live weather (its
	// option is offered disabled without it, and Manual shows), whatever the
	// stored choice, which a file carries as settings.wind_forecast.
	const windSource = $derived<'forecast' | 'manual'>(
		display.liveWeather && windAloft.useForecastForLegs ? 'forecast' : 'manual',
	);
	// The plan's manual wind, only ever a pair (one box typed alone flies
	// nothing): every leg's under Manual, the missed legs' under Forecast.
	const planWind = $derived(
		routeSettings.windDirDeg != null && routeSettings.windSpeedKt != null
			? { dirDeg: routeSettings.windDirDeg, speedKt: routeSettings.windSpeedKt }
			: null,
	);
	const planWindTyped = $derived(routeSettings.windDirDeg != null || routeSettings.windSpeedKt != null);
	// Under Forecast: where it comes from, what keeps it from serving the
	// plan (the nav log's own note), and the legs it misses, which fly the
	// manual wind typed for them.
	const windBrief = $derived(routeWindBrief(activeRoute()));
	const windWarning = $derived(routeWindWarning(activeRoute()));
	const missedLegs = $derived(routeForecastMissedLegs(activeRoute()));
	// Under Manual: what the Forecast source would give, the forecast being
	// fetched whatever the source while live weather is on. Null while no
	// leg would fly a forecast wind.
	const forecastInstead = $derived.by((): string | null => {
		if (windSource !== 'manual' || !display.liveWeather) {
			return null;
		}
		const route = activeRoute();
		if (!effectiveRouteWinds(route, { source: 'forecast' }).some((w) => w?.source === 'forecast')) {
			return null;
		}
		const ete = routeWindEteMin(route, { source: 'forecast' });
		if (ete === null) {
			return null;
		}
		return t.route.forecastInstead({
			dur: fmtDurationMin(ete),
			note: windSummaryNote(eteMin, ete, totalNM, effCruise, t.navlog),
		});
	});

	// The folded Flight parameters' one line: what the plan flies with, every
	// value the pilot set named (route/paramsSummary.ts, worded below).
	const paramParts = $derived(
		paramsSummary({
			cruiseKt: effCruise,
			cruiseLph: effectiveConsumptionLph(),
			cruiseManual: cruiseCustom,
			cruisePlane: automaticCruiseFrom(),
			cruiseSetting: planSetting && !planSetting.isDefault ? planSetting.name : null,
			cruiseLost: settingLost,
			windSource,
			wind: planWind,
			missedLegs,
			legOverrides: legWinds.filter((w) => w?.source === 'override').length,
			taFt: effTa,
			taManual: routeSettings.transitionAltitudeFt !== null,
			semicircular: routeSettings.semicircular,
			tempTas: windAloft.tempTas && display.liveWeather,
		}),
	);

	function paramText(p: ParamPart): string {
		switch (p.kind) {
			case 'cruise':
				return p.source === 'plan'
					? t.route.paramCruiseManual({ kt: Math.round(p.kt), lph: p.lph !== null ? fmtLph(p.lph) : null })
					: p.setting !== null && p.plane !== null
						? t.route.paramCruiseSetting({ setting: p.setting, kt: Math.round(p.kt), from: p.plane })
						: p.plane !== null
							? t.route.paramCruise({ kt: Math.round(p.kt), from: p.plane })
							: t.route.paramCruiseDefault(Math.round(p.kt));
			case 'cruise-lost':
				return t.route.paramCruiseLost(p.name);
			case 'wind-forecast':
				return t.route.paramWindForecast;
			case 'wind-manual':
				return t.route.paramWindManual(fmtWind(p.wind.dirDeg, p.wind.speedKt));
			case 'wind-none':
				return t.route.paramWindNone;
			case 'wind-missed':
				return t.route.paramWindMissed(p.legs);
			case 'leg-winds':
				return t.route.paramLegWinds(p.count);
			case 'ta':
				return p.manual ? t.route.paramTaManual(fmtAlt(p.ft)) : t.route.paramTa(fmtAlt(p.ft));
			case 'semicircular':
				return p.on ? t.route.paramSemicircularOn : t.route.paramSemicircularOff;
			case 'temp-tas':
				return t.route.paramTempTas;
		}
	}

	// Cruise-level advisor: the fastest usable level per leg from the
	// already-fetched forecast ladder (route/levelAdvisor.ts; cruise time
	// only, thresholded). Active only while the per-leg forecast winds are
	// in effect; the scan is pure math over the cached columns, zero
	// network. Terrain floors read the shared cache directly (not the
	// semicircular-gated derived) so they apply with the rule off too.
	const advisorActive = $derived(display.liveWeather && windAloft.useForecastForLegs);
	const levelSuggestions = $derived.by((): (LevelSuggestion | null)[] => {
		const route = activeRoute();
		const legs = Math.max(0, route.waypoints.length - 1);
		if (!advisorActive) {
			return new Array<LevelSuggestion | null>(legs).fill(null);
		}
		return adviseLevels({
			waypoints: route.waypoints,
			columns: routeWindColumns(route),
			forecasts: routeLegForecasts(route),
			legMinElevFt: legMinGroundElevFt(route.id, route.waypoints),
			classAFloors: classAFloorsForLegs(route.waypoints, routeSettings.vfr, getAirspaces()),
			vfr: routeSettings.vfr,
			semicircular: routeSettings.semicircular,
			cruiseKt: effCruise,
			tempTas: windAloft.tempTas,
			timeYears: year,
			regime,
		});
	});
	const suggestionTotalMin = $derived(
		levelSuggestions.reduce((sum, s) => sum + (s?.gainMin ?? 0), 0),
	);

	function suggestionTitle(s: LevelSuggestion, wp: Waypoint): string {
		return t.route.suggestionTip({
			bestEte: Math.round(s.bestEteMin),
			bestLevel: levelLabel(s.bestFt),
			curEte: Math.round(s.currentEteMin),
			curLevel: levelLabel(wp.alt),
		});
	}

	function applyAllSuggestions(): void {
		const wps = activeRoute().waypoints;
		levelSuggestions.forEach((s, i) => {
			if (s) {
				setWaypointAltitude(wps[i].id, s.bestFt, autoAltTargets[i]);
			}
		});
	}

	/** The connector-row view under waypoint i (null on the last row): the
	 *  whole-route deriveds folded into one per-leg bundle for WaypointRow.
	 *  Called from the template, so the t.* reads stay tracked. */
	function legView(wp: Waypoint, i: number): LegView | null {
		if (i >= activeRoute().waypoints.length - 1) {
			return null;
		}
		const sug = levelSuggestions[i] ?? null;
		return {
			distNM: legDist[i] ?? 0,
			trackDeg: legTracks[i] ?? 0,
			autoAltFt: autoAltTargets[i] ?? null,
			warn: legWarn(wp, i),
			suggestion: sug
				? {
						bestFt: sug.bestFt,
						title: suggestionTitle(sug, wp),
						aria: t.route.suggestionApplyAria({
							level: levelLabel(sug.bestFt),
							min: Math.round(sug.gainMin),
						}),
					}
				: null,
			wind: legWinds[i] ?? null,
			windTip: legWindTips[i] ?? null,
			autoWind: legAutoWinds[i] ?? null,
		};
	}

	// --- drag & drop to reorder the waypoint list. The number disc is the drag
	// handle (so the free-waypoint name input stays editable); the up/down buttons
	// remain the touch / keyboard path. Dropping is resolved at the list level (see
	// wpListDnd) so the taller leg rows between waypoints are never dead zones.
	// The drag state lives HERE, in one place; WaypointRow only wears the flags
	// and reports its disc's dragstart / dragend. ---
	let draggingWpId = $state<string | null>(null);
	// Insertion gap the drop would land in: 0..n (n = after the last waypoint), or
	// -1 for none. Drives the drop-before / drop-after cue.
	let dropIndex = $state(-1);

	/* Pointing at a row flashes that waypoint's pin on the map, the rule the
	   feature lists and the nav log's ident cells follow; focus counts as
	   pointing, since the row holds keyboard controls. List-level state like
	   the drag above, so it lives here and the rows only report. */
	const wpHover = useWaypointHover(() => activeRoute().waypoints);

	function onWpDragStart(wp: Waypoint, e: DragEvent): void {
		if (!e.dataTransfer) {
			return;
		}
		draggingWpId = wp.id;
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', wp.id); // Firefox requires data to drag
	}

	function clearWpDrag(): void {
		draggingWpId = null;
		dropIndex = -1;
	}

	// dragover / drop on the whole <ul>: resolve the insertion gap from the pointer
	// Y against every waypoint row (so a drop anywhere in the list lands, the leg
	// rows included), then reorder. Wired imperatively because an ondragover
	// attribute on the static <ul> trips the a11y lint (this is behaviour, not a
	// control).
	function wpListDnd(node: HTMLElement): { destroy(): void } {
		const over = (e: DragEvent): void => {
			if (!draggingWpId) {
				return;
			}
			e.preventDefault(); // allow drop
			if (e.dataTransfer) {
				e.dataTransfer.dropEffect = 'move';
			}
			const rows = [...node.querySelectorAll<HTMLElement>('li.wp')];
			const last = rows.length - 1;
			let idx = rows.length;
			for (let k = 0; k < rows.length; k++) {
				const r = rows[k].getBoundingClientRect();
				// The whole first row is the "insert before first" zone and the whole
				// last row the "insert after last" zone (their half-row corners were too
				// small to hit, and overshooting past the list edge stops dragover
				// firing); interior rows split at their centre.
				const split = k === 0 ? r.bottom : k === last ? r.top : r.top + r.height / 2;
				if (e.clientY < split) {
					idx = k;
					break;
				}
			}
			dropIndex = idx;
		};
		const drop = (e: DragEvent): void => {
			if (!draggingWpId || dropIndex < 0) {
				return;
			}
			e.preventDefault();
			const from = activeRoute().waypoints.findIndex((w) => w.id === draggingWpId);
			let to = dropIndex;
			if (from >= 0) {
				if (from < to) {
					to -= 1; // removing the dragged item shifts later indices left
				}
				reorderWaypoint(from, to);
			}
			clearWpDrag();
		};
		node.addEventListener('dragover', over);
		node.addEventListener('drop', drop);
		return {
			destroy(): void {
				node.removeEventListener('dragover', over);
				node.removeEventListener('drop', drop);
			},
		};
	}

	// --- the route-actions menu hanging off the strip's ... button (the
	// NOTAMs-tab head idiom: an anchored popup on desktop, a bottom sheet on
	// phones, both HeadOverlay's) ---
	let menuOpen = $state(false);
	let anchor = $state({ x: 0, y: 0 });

	function openMenu(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		anchor = { x: r.left, y: r.bottom + 4 };
		menuView = 'actions';
		menuOpen = true;
	}

	// The menu stays up while the save runs (the rich build awaits the wind
	// warm-up), so the row keeps showing its "Saving…" state; it closes once
	// the file is out.
	async function saveFromMenu(): Promise<void> {
		await onSave();
		menuOpen = false;
	}

	// Close first, then open the picker in the same turn: the click has to stay
	// inside the user activation that opened the menu.
	//
	// Natively the picker is the Android one (state/openFile.svelte.ts): the
	// WebView's own chooser hands the page a file it cannot always read back,
	// and the file then opens as whatever KIND it holds, the app's one
	// dispatcher deciding (docs/android.md).
	function loadFromMenu(): void {
		menuOpen = false;
		if (isNativeApp()) {
			void pickFileNatively();
			return;
		}
		fileInput?.click();
	}

	function clearFromMenu(): void {
		menuOpen = false;
		clearRoute();
	}

	// Wiping the workspace is the one route command a single click cannot take
	// back on its own terms: undo does restore it (the history snapshots all of
	// `routes`), but nothing else here discards several routes at once, so it
	// asks first. The menu closes either way, answered or refused.
	function clearAllFromMenu(): void {
		menuOpen = false;
		confirmClearAll = true;
	}

	/** Answered through the app's own ConfirmDialog, which carries the
	 *  theme, the touch floor and the app's button order. */
	let confirmClearAll = $state(false);

	// --- hand the route to SendFPL (docs/sendfpl.md) ---
	// The active route and the whole plan as SendFPL's parser reads them. Both
	// are '' when there is nothing to send, which is what disables their row.
	// An end goes out bare only when the navigator's database can be expected
	// to resolve it: a field the dataset marks CLOSED carries its position
	// instead (a bare identifier the database lacks loads the plan short of
	// its arrival). An identifier the dataset does not know at all is trusted
	// as it is, the dataset being no census of every navigator's database.
	const sendFplOptions = $derived({
		knownAerodrome: (ident: string) => {
			void dataState.revision.airports;
			return airportByIdent(ident)?.type !== 'closed';
		},
	});
	const sendFplRoute = $derived(buildSendFplRoute(activeRoute().waypoints, sendFplOptions));
	const sendFplPlan = $derived(buildSendFplPlan(routes.list, sendFplOptions));
	// Outcome stored as data and worded at render, so a locale switch re-words a
	// standing notice (docs/i18n.md rule 7). Nothing is said when the route left
	// for SendFPL: what came to the front, the app itself or the sheet holding
	// it, is the receipt.
	/** How many names a load notice lists before it counts the rest. */
	const SKIPPED_NAMES_SHOWN = 12;

	let sendNotice = $state<'copied' | 'failed' | null>(null);
	// What that notice is about: the route text that went out. Once neither
	// the route nor the plan reads that way any more, "copied" would describe
	// a clipboard the plan has left behind (an altitude or a wind edit is not
	// in the text, so it leaves the notice up).
	let sentText = '';

	/* The stored workspace is held, not lost, when a restore could not run;
	 * this is the manual way back in beside the automatic dataset retry,
	 * asking the pending dataset reads at once (restoreHeldNow). It declines
	 * by itself if nothing is held or the workspace is no longer pristine,
	 * so the button can never overwrite live planning. */
	async function onRetryRestore(): Promise<void> {
		await restoreHeldNow();
	}

	// --- export the route, or the whole plan, as an interchange file
	// (docs/route-files.md) ---
	// The points are resolved once, through the same knownAerodrome the
	// SendFPL rows use: a file may call a field an AERODROME only where a
	// reader's own database can be expected to resolve the identifier.
	const exportRoutePoints = $derived(routeExportPoints(activeRoute().waypoints, sendFplOptions));
	const exportPlanPoints = $derived(planExportPoints(routes.list, sendFplOptions));
	/* Which view the actions disclosure is showing: its own rows, or the
	 * formats one of the two export rows opened. ONE HeadOverlay that changes
	 * what it holds, never a second one at the same anchor: each open overlay
	 * pushes a history entry and releases it with an ASYNC history.back(), so
	 * closing one while opening another in the same tick leaves the count
	 * adrift and a release walks the tab out of the app (ui/backClose.ts, and
	 * the same trap the workspace surfaces' back entry carries). It is
	 * also what a phone wants: the sheet stays put and its contents change. */
	let menuView = $state<'actions' | 'route' | 'plan'>('actions');

	// Worded at render (docs/i18n.md rule 7); the format CODES are invariant
	// and live in routeExport.ts, not in a catalog.
	const formatRows = $derived({
		fpl: { label: t.route.exportFpl, tip: t.route.exportFplTip },
		gpx: { label: t.route.exportGpx, tip: t.route.exportGpxTip },
		kml: { label: t.route.exportKml, tip: t.route.exportKmlTip },
		pln: { label: t.route.exportPln, tip: t.route.exportPlnTip },
	});

	function openExport(scope: 'route' | 'plan'): void {
		menuView = scope;
	}

	function closeMenu(): void {
		menuOpen = false;
		menuView = 'actions';
	}

	/** Write one file and hand it over: to another app on the phone where one
	 *  opens the type (SDVFR takes an ACTION_VIEW and no share), and to the
	 *  browser's own download, or the share sheet, everywhere else. */
	async function exportAs(format: RouteFormat): Promise<void> {
		const plan = menuView === 'plan';
		closeMenu();
		clearRouteLoadOutcome();
		sendNotice = null;
		try {
			const file = buildRouteExport(plan ? exportPlanPoints : exportRoutePoints, {
				format,
				subject: plan
					? planFileSubject(routes.planName, routes.list)
					: routesFileBaseName([activeRoute()]),
				// The plan's own caption, whichever scope is written: the SUBJECT
				// names the file (the chain for one route, the whole plan for the
				// rest) while the title is what a reader shows, and a plan the
				// pilot named must come back from a round trip still named
				// (docs/route-files.md).
				title: routes.planName ?? undefined,
				vfr: routeSettings.vfr,
			});
			if (!file) {
				return;
			}
			if (!(await openFileWith(file.text, file.filename, file.mime))) {
				downloadBlob(file.text, file.filename, file.mime);
			}
		} catch (e) {
			routeLoad.error = e instanceof Error ? e.message : String(e);
		}
	}

	async function sendToSendFpl(route: string): Promise<void> {
		menuOpen = false;
		sendNotice = null;
		sentText = route;
		const outcome = await sendRouteToSendFpl(route);
		sendNotice = outcome === 'sent' ? null : outcome;
	}

	// --- save / load all routes to a local YAML file ---
	let saving = $state(false);
	// The load outcome lives in state/routeLoad.svelte.ts, because a file opened
	// from the system (an Android intent, ?file=) takes the same recipe and
	// reports here. Stored as data and worded at render, so the standing notice
	// follows a locale switch.
	const fileNotice = $derived.by(() => {
		const loaded = routeLoad.notice;
		if (!loaded) {
			return '';
		}
		const notes: string[] = [];
		if (loaded.truncated) {
			notes.push(t.route.loadedFirstN(MAX_ROUTES));
		}
		if (loaded.reconstructed.length > 0) {
			notes.push(t.route.placedApprox(loaded.reconstructed.join(', ')));
		}
		if (loaded.dropped.length > 0) {
			// Named, but not all of them: an interchange file may state three
			// hundred points the reader could not take, and a line listing every
			// one is a wall of text where the count is the information.
			const shown = loaded.dropped.slice(0, SKIPPED_NAMES_SHOWN);
			const rest = loaded.dropped.length - shown.length;
			notes.push(
				t.route.skippedUnresolved(
					(rest > 0 ? [...shown, t.route.skippedMore(rest)] : shown).join(', '),
				),
			);
		}
		// Read against the fleet now: the plane a late library or an import
		// brings in takes the line down.
		const unknownAircraft = unknownAircraftShown();
		if (unknownAircraft) {
			notes.push(t.route.unknownAircraft(unknownAircraft));
		}
		if (loaded.pastFlightDate) {
			notes.push(t.route.pastFlightDateDropped(loaded.pastFlightDate));
		}
		if (loaded.onBoardDropped) {
			notes.push(t.route.onBoardDropped(loaded.onBoardDropped));
		}
		if (loaded.weatherDropped) {
			notes.push(t.route.weatherDropped);
		}
		return notes.join(' ');
	});
	let fileInput: HTMLInputElement | undefined;
	async function onSave(): Promise<void> {
		if (saving) {
			return;
		}
		saving = true;
		clearRouteLoadOutcome();
		sendNotice = null;
		try {
			// Named after the plan: its own descriptive name when it carries one,
			// else every trip's aerodrome chain, alternates excluded (LFPL-LFPU +
			// LFPU-LFGO + LFGO-LFPL -> LFPL-LFPU-LFGO-LFPL). Plus the kind token
			// that tells a plan from an aircraft sheet; a plan carries no stamp
			// (docs/file-names.md).
			downloadBlob(
				await buildWorkspaceFileYaml(),
				fileName([planFileSubject(routes.planName, routes.list), 'plan'], 'yaml'),
				'text/yaml',
			);
		} catch (e) {
			routeLoad.error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	// --- store the active flight plan into the Flight Plan Catalog ---
	// (the Garmin model, docs/flights-library.md: Store writes the workspace
	// back over the entry it was activated from; Store-as-new is the GNS
	// 'Copy Flight Plan?' to an open location). The confirms are the app's
	// ConfirmDialog, the clear-all idiom; failures reuse the routeLoad error
	// line the menu's Save already writes.
	let storingUi = $state(false);
	let confirmStoreLossy = $state(false);
	let confirmStoreConflict = $state(false);
	// The store outcome, worded at render (the sendNotice idiom): a silent
	// success reads as a failure, since the catalog row's chain and Saved
	// date rarely change visibly.
	let storeNotice = $state<'stored' | 'storedAs' | null>(null);
	const hasStorableRoute = $derived(hasStorableWorkspace());
	// Store-back is offered only while it would change the entry (canStorePlan);
	// the strip's own marker says so before the menu is even opened, and answers
	// the narrower question, whether the pilot has UNSTORED EDITS.
	const canStore = $derived(canStorePlan());
	const unstored = $derived(activePlanDirty());

	/* The receipts go once the plan has moved on: "stored" once there are
	 * unstored edits (the strip's marker says so then, and the two must not
	 * disagree), "copied" once the route text differs from what went out.
	 * Never while a field in the panel holds the focus: the notices sit above
	 * the list and the settings, and a receipt vanishing on the first
	 * keystroke would move the very field being typed in. They go when the
	 * focus leaves the fields, and stay gone after an undo. */
	let fieldFocus = $state(false);
	function isField(el: EventTarget | null): boolean {
		return el instanceof HTMLElement && el.matches('input, select, textarea');
	}
	$effect(() => {
		if (fieldFocus) {
			return;
		}
		if (storeNotice && unstored) {
			storeNotice = null;
		}
		if (sendNotice && sentText !== sendFplRoute && sentText !== sendFplPlan) {
			sendNotice = null;
		}
	});

	function storeFromMenu(): void {
		menuOpen = false;
		storeNotice = null;
		if (activePlan.source?.lossy) {
			// This copy lost waypoints when it was activated: storing would
			// overwrite the fuller original, so it asks first.
			confirmStoreLossy = true;
			return;
		}
		void runStore(false);
	}

	async function runStore(force: boolean): Promise<void> {
		storingUi = true;
		try {
			const out = await storePlan({ force });
			if (out.kind === 'conflict') {
				confirmStoreConflict = true;
			} else if (out.kind === 'failed') {
				routeLoad.error = out.detail;
			} else if (out.kind === 'stored') {
				storeNotice = 'stored';
				// The catalog changed: every trace's dynamic link recomputes.
				void ensureLinks();
			}
		} finally {
			storingUi = false;
		}
	}

	async function storeAsFromMenu(): Promise<void> {
		menuOpen = false;
		storeNotice = null;
		storingUi = true;
		try {
			const out = await storePlanAs();
			if (out.kind === 'failed') {
				routeLoad.error = out.detail;
			} else if (out.kind === 'stored') {
				storeNotice = 'storedAs';
				void ensureLinks();
			}
		} finally {
			storingUi = false;
		}
	}

	/* The row takes any plan the app reads: its own workspace YAML, or one of
	 * the four interchange formats (docs/route-files.md). It goes through the
	 * ONE dispatcher every other inbound file takes (state/openFile), which is
	 * also what the native picker on this row already did, so the two
	 * platforms stop diverging. The accepted consequence is the one
	 * docs/android.md records: a recorded TRACE picked here imports as a trace
	 * and raises the Navigation tab, the file's content deciding rather than
	 * the button that opened it. */
	async function onLoadFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			return;
		}
		sendNotice = null;
		// A new file answers for itself: without this the read error below
		// would stack under the PREVIOUS file's skipped-waypoint list, which
		// belongs to a plan that is still loaded and still correct.
		clearRouteLoadOutcome();
		// The READ is guarded as well as the load, because on Android it is the
		// step that fails: the chooser hands back a content URI and a provider
		// can refuse it or serve nothing, and an unguarded read rejects into
		// nowhere, which looks exactly like the app ignoring the file.
		try {
			await openIncomingBytes(file.name, new Uint8Array(await file.arrayBuffer()));
		} catch (err) {
			routeLoad.error = err instanceof Error ? err.message : String(err);
		}
		// Cleared only once the file has been read, so the same one can be picked
		// again without the clearing racing a read still in flight.
		input.value = '';
	}

	function onTransitionAltInput(e: Event): void {
		const v = parseFloat(inputValue(e));
		// Empty or invalid = automatic (the AIP-derived value); mirrors the
		// nullable wind and cruise inputs.
		routeSettings.transitionAltitudeFt = Number.isFinite(v) && v >= 0 ? v : null;
	}

	function onMinAltInput(e: Event): void {
		const v = parseFloat(inputValue(e));
		if (Number.isFinite(v) && v >= 1) {
			routeSettings.minAltCorridorRadiusNM = Math.min(15, v);
		}
	}

	function onRadiusInput(e: Event): void {
		const v = parseFloat(inputValue(e));
		if (Number.isFinite(v) && v > 0) {
			routeSettings.corridorRadiusNM = v;
		}
	}

	// The corridor preview is keyed to the corridor field's focus; clear it on
	// unmount in case the tab is torn down while the field is still focused (a
	// programmatic removal may not fire blur), so the band can't linger.
	onDestroy(() => {
		routeSettings.corridorPreview = false;
	});

	function onDefaultAltInput(e: Event): void {
		const v = parseFloat(inputValue(e));
		if (Number.isFinite(v) && v >= 0) {
			// Same ceiling as the leg mutator: auto targets derive from this.
			routeSettings.defaultAltitudeFt = Math.min(v, MAX_LEG_ALT_FT);
		}
	}

	/** A fuel flow as the boxes and the picker show it, to the tenth. */
	function fmtLph(lph: number): string {
		return String(Math.round(lph * 10) / 10);
	}

	/** A setting as the picker lists it: its name (the sheet's default named
	 *  so when it has none), its speed and its fuel flow. */
	function settingLabel(s: PlanCruiseSetting): string {
		return t.route.cruiseSettingOption({
			name: s.name ?? t.route.cruiseSheetDefault,
			kt: Math.round(s.speedKt),
			lph: s.consumptionLph !== null ? fmtLph(s.consumptionLph) : null,
		});
	}

	// Picking a setting flies its speed and fuel flow, dropping the plan's own
	// figures; Custom is only ever what the boxes say.
	function onCruisePick(e: Event): void {
		const v = (e.currentTarget as HTMLSelectElement).value;
		if (v === CUSTOM_PICK) {
			return;
		}
		routeSettings.cruiseSetting = v === '' ? null : v;
		routeSettings.cruiseSpeedKt = null;
		routeSettings.cruiseConsumptionLph = null;
	}

	// The fuel-flow box: the speed box's placeholder rule (empty hands it back,
	// the grey value typed changes nothing, on change).
	function onLphInput(e: Event): void {
		if ((e.currentTarget as HTMLInputElement).validity.badInput) {
			return;
		}
		const s = inputValue(e).trim();
		if (s === '') {
			routeSettings.cruiseConsumptionLph = null;
			return;
		}
		const v = parseFloat(s);
		routeSettings.cruiseConsumptionLph = Number.isFinite(v) && v > 0 ? v : null;
	}

	function onLphChange(): void {
		const typed = routeSettings.cruiseConsumptionLph;
		if (typed !== null && autoLph !== null && Math.round(typed * 10) === Math.round(autoLph * 10)) {
			routeSettings.cruiseConsumptionLph = null;
		}
	}

	// The Cruise box follows the placeholder rule: empty, the plan flies the
	// automatic speed shown in grey (the selected aircraft's); a typed speed
	// is the plan's own, and emptying the box hands it back. The plane's data
	// sheet is never written from here, only from the Aircraft tab.
	function onCruiseInput(e: Event): void {
		// A half-typed number reads as '' with badInput set: not an emptied box.
		if ((e.currentTarget as HTMLInputElement).validity.badInput) {
			return;
		}
		const s = inputValue(e).trim();
		if (s === '') {
			routeSettings.cruiseSpeedKt = null;
			return;
		}
		const v = parseFloat(s);
		routeSettings.cruiseSpeedKt = Number.isFinite(v) && v > 0 ? v : null;
	}

	// Typing the grey speed changes nothing: on change (not per keystroke, so
	// the digits being typed are never wiped), a speed equal to the automatic
	// one hands the plan back to it, and the box shows it in grey again.
	function onCruiseChange(): void {
		if (routeSettings.cruiseSpeedKt !== null && routeSettings.cruiseSpeedKt === autoCruise) {
			routeSettings.cruiseSpeedKt = null;
		}
	}

	// The wind switch asked for from elsewhere (the Overview's Change): once
	// the unfolded row is laid out, it scrolls into view and takes the focus,
	// the request consumed so a later mount steals nothing.
	let windSwitchEl: HTMLDivElement | undefined = $state();
	$effect(() => {
		const el = windSwitchEl;
		if (!routeTabFocus.wind || !el) {
			return;
		}
		untrack(() => (routeTabFocus.wind = false));
		void tick().then(() => {
			el.scrollIntoView({ block: 'center' });
			el.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus();
		});
	});

	function onWindSource(v: string): void {
		windAloft.useForecastForLegs = v === 'forecast';
	}

	function onWindDirInput(e: Event): void {
		const s = inputValue(e).trim();
		if (s === '') {
			routeSettings.windDirDeg = null;
			return;
		}
		const v = parseFloat(s);
		routeSettings.windDirDeg = Number.isFinite(v) && v >= 0 && v <= 360 ? v : null;
	}

	function onWindSpeedInput(e: Event): void {
		const s = inputValue(e).trim();
		if (s === '') {
			routeSettings.windSpeedKt = null;
			return;
		}
		const v = parseFloat(s);
		routeSettings.windSpeedKt = Number.isFinite(v) && v >= 0 ? v : null;
	}

</script>

<div
	class="tab-panel"
	onfocusin={(e) => (fieldFocus = isField(e.target))}
	onfocusout={(e) =>
		(fieldFocus = isField(e.relatedTarget) && e.currentTarget.contains(e.relatedTarget as Node))}
>

	<RouteStrip onMenu={openMenu} {menuOpen} {unstored} />

	<input
		bind:this={fileInput}
		class="file-input"
		type="file"
		accept={pickerAccept(
			'.yaml,.yml,.fpl,.pln,.gpx,.kml,.kmz,text/yaml,application/vnd.garmin.flightplan,application/gpx+xml,application/vnd.google-earth.kml+xml,application/xml',
		)}
		aria-hidden="true"
		tabindex="-1"
		onchange={onLoadFile}
	/>
	{#if routes.list.findIndex((r) => r.id === routes.activeId) > 0}
		<label class="alternate-toggle" title={t.route.alternateRouteTip}>
			<input
				type="checkbox"
				checked={activeRoute().alternate ?? false}
				onchange={(e) => setRouteAlternate(routes.activeId, inputChecked(e))}
			/>
			<span>{t.route.alternateRoute}</span>
		</label>
	{/if}

	<!-- The route field heads the tab, the workspace history beside it: a
	     waypoint resolving as it is typed grows the list below the field and
	     never moves it. Undo / redo stay one click away (the Ctrl-Z binding
	     is the desktop path, these buttons the touch one, and the map's undo
	     chip the path right after an edit made there), and they take the
	     focus when clicked, so the field gives its text up to the route they
	     bring back. -->
	<RouteTextField>
		{#snippet trailing()}
			<button
				class="route-hist"
				title={t.route.undoTip}
				aria-label={t.route.undo}
				disabled={!routeHistory.canUndo}
				onclick={() => undoRoute()}
			>
				<Icon name="undo" size={15} />
			</button>
			<button
				class="route-hist"
				title={t.route.redoTip}
				aria-label={t.route.redo}
				disabled={!routeHistory.canRedo}
				onclick={() => redoRoute()}
			>
				<Icon name="redo" size={15} />
			</button>
		{/snippet}
	</RouteTextField>

	<!-- The notices sit under the field, so one appearing or clearing never
	     moves it. -->
	{#if routeLoad.error}
		<p class="muted build-error" role="alert">{routeLoad.error}</p>
	{/if}
	<!-- The boot restore's own report: a stored flight plan is waiting, and
	     what became of it. `superseded` is the quiet one, since the workspace
	     on screen is the user's own doing; it only speaks once the rescue has
	     put the displaced plan somewhere they can find it. -->
	{#if routeLoad.restore && (routeLoad.restore.stage === 'rescued' || routeLoad.restore.reason !== 'superseded')}
		<div class="restore-note" role="status">
			<p class="muted small">
				{#if routeLoad.restore.stage === 'rescued'}
					{t.route.restoreRescued}
				{:else if routeLoad.restore.stage === 'sheltered'}
					{t.route.restoreSheltered}
				{:else if routeLoad.restore.reason === 'parse'}
					{t.route.restoreParse}
				{:else if routeLoad.restore.reason === 'lossy'}
					{t.route.restoreLossy}
				{:else}
					{t.route.restoreFailed}
				{/if}
			</p>
			<!-- Only while genuinely HELD: past the shelter there is nothing a
			     retry could restore (the hold is released), and the sentence
			     above already says where the plan stands. Hidden while
			     recording too: retryRestoreRoutes declines then anyway (the
			     in-flight doctrine at its chokepoint), and a button that does
			     nothing is worse than none. -->
			{#if routeLoad.restore.stage === 'held' && routeLoad.restore.reason !== 'parse' && !nav.recording}
				<button class="btn" onclick={onRetryRestore} title={t.route.restoreRetryTip}>
					{t.route.restoreRetry}
				</button>
			{/if}
		</div>
	{/if}
	{#if fileNotice}
		<p class="muted small">{fileNotice}</p>
	{/if}
	{#if sendNotice}
		<p class="muted small">
			{sendNotice === 'copied' ? t.route.sendFplCopied : t.route.sendFplFailed}
		</p>
	{/if}
	{#if storeNotice}
		<p class="muted small">
			{storeNotice === 'stored' ? t.route.storedNotice : t.route.storedAsNotice}
		</p>
	{/if}

	<!-- The hint speaks only over an empty route, where it teaches how to
	     start and the map gestures nothing on the map announces; above a full
	     waypoint list it would greet every returning session. -->
	{#if activeRoute().waypoints.length === 0}
		<p class="muted hint">{t.route.hintStart}</p>
	{:else}
		<ul class="wp-list" use:wpListDnd>
			{#each activeRoute().waypoints as wp, i (wp.id)}
				<WaypointRow
					{wp}
					{i}
					dragging={draggingWpId === wp.id}
					dropBefore={dropIndex === i}
					dropAfter={dropIndex === activeRoute().waypoints.length &&
						i === activeRoute().waypoints.length - 1}
					onDragStart={(e: DragEvent) => onWpDragStart(wp, e)}
					onDragEnd={clearWpDrag}
					onHover={wpHover.set}
					leg={legView(wp, i)}
				/>
			{/each}
		</ul>
		{#if enough}
			<p class="muted summary">
				{t.route.summaryTotal(fmtNM(totalNM))}{eteMin !== null
					? `, ${t.route.summaryCruise({ dur: fmtDurationMin(eteMin), kt: effCruise })}`
					: ''}{windNote ? `, ${windNote}` : ''}.
			</p>
			{#if suggestionTotalMin >= 1}
				<p class="muted summary">
					{t.route.fasterLevels(Math.round(suggestionTotalMin))}
					<button class="btn" onclick={applyAllSuggestions}>{t.route.applyAll}</button>
				</p>
			{/if}
		{/if}
	{/if}

	<!-- No launcher row here: the nav log, the vertical profile and the
	     flight preparation live in the toolbar (the cluster / the Flight
	     disclosure / the phone More menu), ONE home instead of a copy per
	     panel. Their disabled state still explains itself where the fix is
	     made: the empty-route hints above teach adding waypoints. -->

	<!-- The plan's manual wind, two boxes wherever it is typed: every leg's
	     under a Manual source, the missed legs' under a Forecast one. The
	     direction is true, as a WINTEM or a METAR gives it. -->
	{#snippet windBoxes(dirAria: string, speedAria: string)}
		<input
			class="wind-box"
			type="number"
			lang="en"
			min="0"
			max="360"
			step="5"
			value={routeSettings.windDirDeg ?? ''}
			oninput={onWindDirInput}
			aria-label={dirAria}
		/>
		<span class="unit">{t.route.windDegTrue}</span>
		<input
			class="wind-box"
			type="number"
			lang="en"
			min="0"
			step="5"
			value={routeSettings.windSpeedKt ?? ''}
			oninput={onWindSpeedInput}
			aria-label={speedAria}
		/>
		<span class="unit">kt</span>
	{/snippet}

	<!-- The route above (its field, its waypoints, its totals) is no section
	     and draws no hairline of its own: this rule at the panel's level sets
	     it apart from the first section, as the sections' set them apart. -->
	<hr class="head-rule" />

	<fieldset class="group">
		<legend>{t.route.flightParams}</legend>
		<div class="range-label">
			<span>{t.route.flightRules}</span>
			<Segmented
				options={[
					{ value: 'vfr', label: 'VFR' },
					{ value: 'ifr', label: 'IFR' },
				]}
				value={routeSettings.vfr ? 'vfr' : 'ifr'}
				onSelect={(v) => setRouteVfr(v === 'vfr')}
				ariaLabel={t.route.flightRules}
				title={t.route.vfrTip}
			/>
		</div>
		<label class="range-label">
			<span>{t.route.defaultAlt}</span>
			<input
				type="number"
				lang="en"
				min="0"
				max={MAX_LEG_ALT_FT}
				step="500"
				value={routeSettings.defaultAltitudeFt}
				oninput={onDefaultAltInput}
			/>
			<span class="unit">ft</span>
		</label>
		<!-- What else the plan flies with, on one line: the automatic values
		     plain, every value the pilot set (and what the plan should not fly
		     unnoticed: legs without a forecast, no wind at all) in the manual
		     ink, so the fold never hides one. Their rows unfold under it, the
		     choice remembered. -->
		<button
			type="button"
			class="params-fold"
			aria-expanded={routeSettings.flightParamsOpen}
			aria-controls="flight-params-body"
			title={t.route.paramsFoldTip}
			onclick={() => setFlightParamsOpen(!routeSettings.flightParamsOpen)}
		>
			<span class="chev"
				><Icon name={routeSettings.flightParamsOpen ? 'chevron-down' : 'chevron-right'} size={14} /></span
			>
			<span class="params-line"
				>{#each paramParts as part, i (i)}{i > 0 ? ', ' : ''}<span class:stands-out={partStandsOut(part)}
						>{paramText(part)}</span
					>{/each}</span
			>
		</button>
		{#if routeSettings.flightParamsOpen}
			<div class="params-body" id="flight-params-body">
				<!-- The cruise: the aircraft's setting the plan flies (picked when its
				     sheet holds several), then its speed and fuel flow, empty over the
				     setting's in grey, a typed figure the plan's own (Custom). -->
				<div class="range-label">
					<span>{t.route.cruise}</span>
					{#if settingsList.length > 1}
						<select
							class="cruise-pick"
							value={cruisePick}
							onchange={onCruisePick}
							aria-label={t.route.cruiseSettingAria}
							title={t.route.cruiseSettingTip}
						>
							{#each settingsList as s (s.name ?? '')}
								<option value={s.isDefault ? '' : (s.name ?? '')}>{settingLabel(s)}</option>
							{/each}
							{#if cruiseCustom}
								<option value={CUSTOM_PICK}>{t.route.cruiseCustom}</option>
							{/if}
						</select>
					{:else}
						<p class="param-note">
							{automaticCruiseFrom() !== null
								? t.route.cruiseFromSheet(automaticCruiseFrom() ?? '')
								: t.route.cruiseNoAircraft}
						</p>
					{/if}
				</div>
				<div class="range-label sub-row" title={t.route.cruiseTip}>
					<span aria-hidden="true"></span>
					<input
						type="number"
						lang="en"
						min="1"
						step="1"
						value={routeSettings.cruiseSpeedKt ?? ''}
						oninput={onCruiseInput}
						onchange={onCruiseChange}
						placeholder={String(autoCruise)}
						aria-label={t.route.cruiseSpeedAria}
					/>
					<span class="unit">kt</span>
					<input
						type="number"
						lang="en"
						min="0.1"
						step="0.1"
						value={routeSettings.cruiseConsumptionLph ?? ''}
						oninput={onLphInput}
						onchange={onLphChange}
						placeholder={autoLph !== null ? fmtLph(autoLph) : ''}
						aria-label={t.route.cruiseLphAria}
					/>
					<span class="unit">L/h</span>
				</div>
				{#if settingLost}
					<div class="range-label param-sub">
						<span aria-hidden="true"></span>
						<p class="param-note warn">{t.route.cruiseSettingLost(settingLost)}</p>
					</div>
				{/if}
				<div class="range-label" bind:this={windSwitchEl}>
					<span>{t.route.wind}</span>
					<Segmented
						options={[
							{
								value: 'forecast',
								label: t.route.windSourceForecast,
								title: t.route.windSourceForecastTip,
								disabled: !display.liveWeather,
							},
							{ value: 'manual', label: t.route.windSourceManual, title: t.route.windSourceManualTip },
						]}
						value={windSource}
						onSelect={onWindSource}
						ariaLabel={t.route.windSource}
					/>
				</div>
				{#if windSource === 'forecast'}
					{#if windBrief}
						<div class="range-label param-sub">
							<span aria-hidden="true"></span>
							<p class="param-note">{windBrief}</p>
						</div>
					{/if}
					{#if windWarning}
						<div class="range-label param-sub">
							<span aria-hidden="true"></span>
							<p class="param-note warn">{windWarning}</p>
						</div>
					{/if}
					<!-- The legs the forecast misses fly the manual wind: its boxes
					     come up only then, or while one is typed, saying so when
					     no leg needs it. -->
					{#if missedLegs.length > 0 || planWindTyped}
						<div class="range-label param-sub">
							<span aria-hidden="true"></span>
							<p class="param-note" class:warn={missedLegs.length > 0}>
								{missedLegs.length > 0 ? t.route.windMissedNote(missedLegs) : t.route.windUnusedNote}
							</p>
						</div>
						<div class="range-label sub-row" title={t.route.windMissedTip}>
							<span aria-hidden="true"></span>
							{@render windBoxes(t.route.windMissedDirAria, t.route.windMissedSpeedAria)}
						</div>
					{/if}
				{:else}
					<div class="range-label sub-row">
						<span aria-hidden="true"></span>
						{@render windBoxes(t.route.windDirGlobalAria, t.route.windSpeedGlobalAria)}
					</div>
					{#if !planWind || forecastInstead}
						<div class="range-label param-sub">
							<span aria-hidden="true"></span>
							<p class="param-note">{planWind ? forecastInstead : t.route.windManualNone}</p>
						</div>
					{/if}
				{/if}
			<label class="range-label" title={taTitle}>
				<span>{t.route.transition}</span>
				<input
					type="number"
					lang="en"
					min="0"
					step="500"
					value={routeSettings.transitionAltitudeFt ?? ''}
					placeholder={String(effTa)}
					oninput={onTransitionAltInput}
				/>
				<span class="unit">ft</span>
			</label>
			<label class="vfr-toggle" title={t.route.semicircularTip}>
				<input
					type="checkbox"
					checked={routeSettings.semicircular}
					onchange={(e) => (routeSettings.semicircular = inputChecked(e))}
				/>
				<span>{t.route.semicircular}</span>
			</label>
			<label class="vfr-toggle" title={t.route.tempTasTip}>
				<input type="checkbox" bind:checked={windAloft.tempTas} disabled={!display.liveWeather} />
				<span>{t.route.tempTas}</span>
			</label>
				{#if !display.liveWeather}
					<p class="muted small">{t.route.liveWeatherOffNote}</p>
				{/if}
			</div>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.route.planningOptions}</legend>
		<label class="range-label" title={t.route.corridorTip}>
			<span>{t.route.corridor}</span>
			<input
				type="number"
				lang="en"
				min="1"
				step="1"
				value={routeSettings.corridorRadiusNM}
				oninput={onRadiusInput}
				onfocus={() => (routeSettings.corridorPreview = true)}
				onblur={() => (routeSettings.corridorPreview = false)}
			/>
			<span class="unit">NM</span>
		</label>
		<label class="vfr-toggle" title={t.route.notamsOnRouteOnlyTip}>
			<input
				type="checkbox"
				checked={filter.notamsOnRouteOnly}
				onchange={(e) => setNotamsOnRouteOnly(inputChecked(e))}
			/>
			<span>{t.route.notamsOnRouteOnly}</span>
		</label>
		<label class="vfr-toggle" title={t.route.airspacesOnRouteOnlyTip}>
			<input
				type="checkbox"
				checked={routeSettings.airspacesOnRouteOnly}
				onchange={(e) => setAirspacesOnRouteOnly(inputChecked(e))}
			/>
			<span>{t.route.airspacesOnRouteOnly}</span>
		</label>
		<label class="range-label" title={t.route.minAltTip}>
			<span>{t.route.minAlt}</span>
			<input
				type="number"
				lang="en"
				min="1"
				max="15"
				step="1"
				value={routeSettings.minAltCorridorRadiusNM}
				oninput={onMinAltInput}
				onfocus={() => (routeSettings.minAltCorridorPreview = true)}
				onblur={() => (routeSettings.minAltCorridorPreview = false)}
				aria-label={t.route.minAltAria}
			/>
			<span class="unit">NM</span>
		</label>
		<label class="vfr-toggle" title={t.route.minAltDangerTip}>
			<input
				type="checkbox"
				checked={routeSettings.minAltDangerOn}
				onchange={(e) => setMinAltDangerOn(inputChecked(e))}
			/>
			<span>{t.route.minAltDanger}</span>
		</label>
		<!-- Plan-scoped, so it stays HERE rather than moving to the offline
		     manager: it acts on the plan being edited, beside the two corridor
		     widths three rows above that decide what it pins. What changed is
		     that it ENQUEUES: it no longer runs six tile fetches alongside a
		     gigabyte archive stream. -->
		<div class="terrain-pin" title={t.offline.terrainTip}>
			{#if terrainPinRunning()}
				<div
					class="progress"
					role="progressbar"
					aria-label={t.offline.progressAria(t.offline.terrainSubject)}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={Math.round(offlineTerrain.progress * 100)}
				>
					<div class="progress-fill" style:width="{offlineTerrain.progress * 100}%"></div>
				</div>
				<span class="terrain-note">
					{t.offline.downloading}
					{Math.round(offlineTerrain.progress * 100)} %</span
				>
				<button class="btn" onclick={cancelTerrainPins}>{t.common.cancel}</button>
			{:else if terrainPinQueued()}
				<span class="terrain-note">{t.offline.queued}</span>
				<button class="btn" onclick={cancelTerrainPins}>
					{t.offline.removeFromQueue}
				</button>
			{:else if offlineTerrain.count > 0}
				<span class="terrain-note">
					{t.offline.terrainPinnedLine({
						tiles: offlineTerrain.count,
						size: formatPackBytes(offlineTerrain.bytes),
						date: isoDay(offlineTerrain.newestTs),
					})}
				</span>
				<button
					class="btn"
					disabled={plannedTileCount === 0}
					onclick={() => downloadTerrainPins()}
				>
					{t.offline.update}
				</button>
				<button class="btn" onclick={() => void removeTerrainPins()}>
					{t.offline.delete}
				</button>
				<button class="btn" onclick={() => openOffline('terrain')}>
					{t.offline.manage}
				</button>
			{:else}
				<button
					class="btn"
					disabled={plannedTileCount === 0}
					onclick={() => downloadTerrainPins()}
				>
					{t.offline.terrainDownload}{plannedTileCount
						? ` (~${formatPackBytes(estimateBytes(plannedTileCount))})`
						: ''}
				</button>
			{/if}
			{#if offlineTerrain.status === 'error' && offlineTerrain.error}
				<span class="terrain-fail" role="alert">{t.offline.errors[offlineTerrain.error]}</span>
			{/if}
		</div>
	</fieldset>

</div>

<!-- The strip's ... menu, in three groups: the file rows act on the whole
     workspace, the SendFPL rows hand a route to the navigator, and the clear
     rows act on the active route or all of them. Clearing records an undo step,
     which is what lets it sit a click deep. -->
<HeadOverlay
	open={menuOpen}
	x={anchor.x}
	y={anchor.y}
	title={menuView === 'actions'
		? t.route.actionsMenu
		: menuView === 'plan'
			? t.route.exportPlanTitle
			: t.route.exportRouteTitle}
	minWidthPx={200}
	onClose={closeMenu}
>
	{#if menuView === 'actions'}
	<button class="item" onclick={saveFromMenu} disabled={saving} title={t.route.saveTip}>
		<Icon name="upload" size={14} />
		{saving ? t.route.saving : t.route.saveRoutes}
	</button>
	<button class="item" onclick={loadFromMenu} title={t.route.loadTip}>
		<Icon name="download" size={14} />
		{t.route.loadRoutes}
	</button>
	<button
		class="item group-top"
		onclick={storeFromMenu}
		disabled={!canStore || storingUi}
		title={t.route.storePlanTip}
	>
		<Icon name="save" size={14} />
		{t.route.storePlan}
	</button>
	<button
		class="item"
		onclick={() => void storeAsFromMenu()}
		disabled={!hasStorableRoute || storingUi}
		title={t.route.storePlanAsTip}
	>
		<Icon name="save" size={14} />
		{t.route.storePlanAs}
	</button>
	{#if unstored && signedIn()}
		<!-- Signed in, the stakes of an unstored plan grow: the catalog is
		     what follows the pilot to other devices (docs/accounts-sync.md,
		     the phase-1 hint the contract names). -->
		<p class="menu-note">{t.account.unstoredPlanHint}</p>
	{/if}
	<!-- The catalog those two rows write into, one row away: a menu row
	     OPENS (never toggles), straight onto the Plans view. -->
	<button
		class="item"
		onclick={() => {
			menuOpen = false;
			openFlights('plans');
		}}
	>
		<Icon name="logbook" size={14} />
		{t.route.openPlans}
	</button>
	<!-- The route as a file another application reads (docs/route-files.md).
	     One row per scope, each opening the format sheet below: four formats
	     times two scopes is a menu nobody can read, and the format is the
	     pilot's choice of recipient, not a setting. -->
	<button
		class="item group-top"
		onclick={() => openExport('route')}
		disabled={exportRoutePoints.length < MIN_POINTS}
		title={t.route.exportRouteTip}
	>
		<Icon name="upload" size={14} />
		{t.route.exportRoute}
	</button>
	{#if orderedTrips(routes.list).length > 1}
		<button
			class="item"
			onclick={() => openExport('plan')}
			disabled={exportPlanPoints.length < MIN_POINTS}
			title={t.route.exportPlanTip}
		>
			<Icon name="upload" size={14} />
			{t.route.exportPlan}
		</button>
	{/if}
	<!-- Both rows word themselves from the hand-off the click will take
	     (native/sendfpl.ts): where nothing can be opened, the row says it
	     copies, before the click and not after it in the notice. On a phone the
	     menu is a sheet with no hover, so the label carries this and the
	     tooltip is read on the desktop, which is the copying platform. -->
	<button
		class="item group-top"
		onclick={() => sendToSendFpl(sendFplRoute)}
		disabled={sendFplRoute === ''}
		title={sendFplHandoff() === 'clipboard' ? t.route.sendFplCopyTip : t.route.sendFplTip}
	>
		<Icon name="send" size={14} />
		{sendFplHandoff() === 'clipboard' ? t.route.sendFplCopy : t.route.sendFpl}
	</button>
	{#if orderedTrips(routes.list).length > 1}
		<button
			class="item"
			onclick={() => sendToSendFpl(sendFplPlan)}
			disabled={sendFplPlan === ''}
			title={sendFplHandoff() === 'clipboard'
				? t.route.sendFplPlanCopyTip
				: t.route.sendFplPlanTip}
		>
			<Icon name="send" size={14} />
			{sendFplHandoff() === 'clipboard' ? t.route.sendFplPlanCopy : t.route.sendFplPlan}
		</button>
	{/if}
	<button
		class="item danger group-top"
		onclick={clearFromMenu}
		disabled={activeRoute().waypoints.length === 0}
		title={t.route.clearRouteTip}
	>
		<Icon name="trash" size={14} />
		{t.route.clearRoute}
	</button>
	<button
		class="item danger"
		onclick={clearAllFromMenu}
		disabled={routes.list.length === 1 && activeRoute().waypoints.length === 0}
		title={t.route.clearAllRoutesTip}
	>
		<Icon name="trash" size={14} />
		{t.route.clearAllRoutes}
	</button>
	{:else}
		<!-- The formats one row of the actions view opened: the same disclosure,
		     showing what the route can be written as (docs/route-files.md). -->
		{#each ROUTE_FORMATS as format (format)}
			<button class="item" onclick={() => void exportAs(format)} title={formatRows[format].tip}>
				<Icon name="file-text" size={14} />
				{formatRows[format].label}
			</button>
		{/each}
	{/if}
</HeadOverlay>

{#if confirmClearAll}
	<ConfirmDialog
		message={t.route.clearAllRoutesConfirm}
		confirmLabel={t.route.clearAllRoutesAction}
		danger
		onConfirm={() => {
			confirmClearAll = false;
			clearAllRoutes();
			clearStopovers();
			clearOnBoard();
			setActivePlanSource(null);
		}}
		onCancel={() => (confirmClearAll = false)}
	/>
{/if}

{#if confirmStoreLossy}
	<ConfirmDialog
		message={t.route.storeLossyConfirm}
		confirmLabel={t.route.storeLossyAction}
		danger
		onConfirm={() => {
			confirmStoreLossy = false;
			void runStore(false);
		}}
		onCancel={() => (confirmStoreLossy = false)}
	/>
{/if}

{#if confirmStoreConflict}
	<ConfirmDialog
		message={t.route.storeConflictConfirm}
		confirmLabel={t.route.storeConflictAction}
		danger
		onConfirm={() => {
			confirmStoreConflict = false;
			void runStore(true);
		}}
		onCancel={() => (confirmStoreConflict = false)}
	/>
{/if}

<style>
	/* Offline terrain pins: one compact row closing the Planning options
	 * (docs/offline-maps.md). */
	.terrain-pin {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 8px;
		margin-top: 6px;
		font-size: var(--fs-xs);
	}

	.terrain-note {
		color: var(--text-muted);
	}

	.terrain-fail {
		color: var(--danger);
	}

	/* The row that opens a group carries the rule; its square top corners keep
	 * the hover fill from rounding away from the line. */
	.item.group-top {
		margin-top: 4px;
		padding-top: 9px;
		border-top: 1px solid var(--border);
		border-radius: 0 0 5px 5px;
	}

	/* The signed-in hint under the Store rows. The rows' own touch floor is
	 * app.css's (:root.touch-ui .menu-panel .item). */
	.menu-note {
		margin: 2px 10px 6px;
		font-size: var(--fs-2xs);
		color: var(--workbook-orange);
		max-width: 240px;
	}

	.file-input {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip-path: inset(50%);
		border: 0;
	}

	/* Undo / redo beside the route field: 28 px wide and as tall as the field
	 * (stretched in its row); greyed and hoverless while its stack is empty. */
	.route-hist {
		display: flex;
		flex: 0 0 auto;
		align-self: stretch;
		align-items: center;
		justify-content: center;
		width: 28px;
		padding: 0;
		color: var(--text-muted);
		background: transparent;
		border: none;
		border-radius: var(--radius);
		cursor: pointer;
	}

	.route-hist:hover:not(:disabled) {
		color: var(--text);
		background: var(--surface-3);
	}

	.route-hist:disabled {
		opacity: 0.35;
		cursor: default;
	}

	/* A finger's reach, the WaypointRow idiom: invisible slop to about 44 px
	 * tall, and only 2 px sideways, so it stays inside the row's 4 px gaps and
	 * never takes the field's own edge. */
	:global(:root.touch-ui) .route-hist {
		position: relative;
	}

	:global(:root.touch-ui) .route-hist::after {
		content: '';
		position: absolute;
		inset: -6px -2px;
	}

	.alternate-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	.alternate-toggle input {
		accent-color: var(--accent);
	}

	.vfr-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 2px;
		font-size: 12px;
		cursor: pointer;
	}

	.vfr-toggle input {
		accent-color: var(--accent);
	}

	/* Touch: 44px flight-parameter toggle rows with a larger box (the
	   app.css pattern). The leg / waypoint rows are NOT grown (they must
	   never reflow); their icon controls get invisible hit-slop in
	   WaypointRow. */
	:global(:root.touch-ui) .alternate-toggle,
	:global(:root.touch-ui) .vfr-toggle {
		min-height: 44px;
	}

	:global(:root.touch-ui) .alternate-toggle input[type='checkbox'],
	:global(:root.touch-ui) .vfr-toggle input[type='checkbox'] {
		width: 18px;
		height: 18px;
	}

	/* A toggle whose checkbox is disabled (the forecast-wind and temperature
	 * toggles while Live weather is off) dims its whole row so it reads inactive;
	 * the liveWeatherOffNote below the fieldset says why. */
	.vfr-toggle:has(input:disabled) {
		cursor: default;
		opacity: 0.55;
	}

	.hint {
		margin: 4px 0 10px;
		line-height: 1.4;
	}

	.wp-list {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 0 0 6px;
		padding: 0;
		list-style: none;
	}

	/* The leg rows' query container: they tighten below 340 px of list, which
	   a sidebar narrower than about 384 px makes (WaypointRow). Screen only,
	   so no containment reaches a bare Ctrl+P. */
	@media screen {
		.wp-list {
			container: wp-list / inline-size;
		}
	}

	.summary {
		margin: 0 0 10px;
		font-size: 12px;
	}

	/* The rule under the route, above the first section: at the panel's
	   level, edge to edge like the flat sections' hairlines (app.css, "A
	   section is FLAT"), the route's last block giving up its own bottom
	   margin so the rule sits 12 px under it and 12 px over the legend, the
	   panel's gap each side, as a section's hairline does. Screen only like
	   those: on paper the sections keep their cards, whose frame does it. */
	.head-rule {
		display: none;
	}

	@media screen {
		.head-rule {
			display: block;
			margin: 0 calc(-1 * var(--flat-bleed, 0px));
			border: 0;
			border-top: 1px solid var(--border);
		}

		.hint:has(+ .head-rule),
		.wp-list:has(+ .head-rule),
		.summary:has(+ .head-rule) {
			margin-bottom: 0;
		}
	}

	.range-label {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 0;
	}

	/* The label column is em-sized so it scales with the user's font: a wide
	 * system font (or text-only zoom) otherwise overflows the longest label,
	 * "Default alt", pushing or wrapping its field out of line with the rows
	 * above. 6.5em leaves it ~16% headroom over the widest common fonts. */
	.range-label > span:first-child {
		flex: 0 0 6.5em;
		font-size: 13px;
	}

	.range-label input {
		flex: 1;
		min-width: 0;
		padding: 5px 7px;
		font: inherit;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.range-label select.cruise-pick {
		flex: 1;
		min-width: 0;
		padding: 4px 6px;
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.range-label input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	/* An empty box's placeholder is the value in force (the aircraft's cruise
	 * speed, the AIP transition altitude): muted like the workbook's and the
	 * leg boxes' rather than the browser's washed-out grey, so a value reads
	 * as a value. */
	.range-label input::placeholder {
		color: var(--text-muted);
		opacity: 1;
	}

	/* The wind's two boxes share their row, and at the 280 px floor Firefox's
	 * always-drawn spinner left the direction box 25 px for the 27 of "360"
	 * (19 in French, whose wider rail narrows the panel): "250" read "25".
	 * Like the leg's W/V editor they hide it, the arrow keys still stepping
	 * (from the grey value too). */
	.range-label input.wind-box {
		appearance: textfield;
	}

	.range-label input.wind-box::-webkit-inner-spin-button,
	.range-label input.wind-box::-webkit-outer-spin-button {
		margin: 0;
		appearance: none;
	}

	.unit {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* The folded Flight parameters' line: a text button the width of the
	 * panel, its parts plain while automatic and in the manual ink (a leg's
	 * manual W/V chip's) where the pilot set one or the plan should not fly
	 * it unnoticed. */
	.params-fold {
		display: flex;
		align-items: flex-start;
		gap: 4px;
		width: 100%;
		margin: 2px 0 0;
		padding: 4px 0;
		font: inherit;
		font-size: 12px;
		line-height: 1.35;
		text-align: left;
		color: var(--text-muted);
		background: transparent;
		border: 0;
		cursor: pointer;
	}

	.params-fold:hover {
		color: var(--text);
	}

	.params-fold:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.params-fold .chev {
		display: inline-flex;
		flex: 0 0 auto;
		padding-top: 1px;
	}

	.params-line .stands-out {
		color: var(--workbook-orange);
	}

	:global(:root.touch-ui) .params-fold {
		align-items: center;
		min-height: 44px;
	}

	/* A note under a row's control (the forecast's source and mean, its
	 * warning, the Manual wind's comparison) and the manual wind's boxes,
	 * aligned on the controls by the row's empty label cell. Below 250 px of
	 * panel (a sidebar near its 280 px floor) they give that cell up: "360"
	 * beside "°T" and its speed box no longer fits behind it (Firefox,
	 * French "° vrai" the widest). */
	.range-label.param-sub {
		padding-top: 0;
	}

	@media screen {
		.params-body {
			container: params / inline-size;
		}

		@container params (width < 250px) {
			.param-sub > span:first-child,
			.sub-row > span:first-child {
				display: none;
			}
		}
	}

	.param-note {
		margin: 0;
		font-size: 11px;
		line-height: 1.35;
		color: var(--text-muted);
	}

	.param-note.warn {
		color: var(--workbook-orange);
	}


	/* An open surface's launcher reads as pressed, marked the way the sidebar
	 * rail marks the open tab: the accent on the edge and the label. A fill
	 * would say nothing here, the resting button already carries surface-3. */

	/* NOTAM-source picker (SOFIA / autorouter) and its per-source hint line. */

	/* The shared .tab-panel h2 style carries the face; only the spacing
	   before the source picker is local. */

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	.small {
		margin-top: 6px;
		font-size: 11px;
		line-height: 1.5;
	}

	/* The boot restore's report: the sentence, then its action under it, so
	   an inline button cannot stretch the line spacing of a wrapped line. */
	.restore-note {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		margin-top: 6px;
	}

	.restore-note p {
		margin: 0;
	}

	.build-error {
		margin-top: 6px;
		color: var(--danger);
	}
</style>
