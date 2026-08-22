<script lang="ts">
	import { onDestroy } from 'svelte';
	import HeadOverlay from '../HeadOverlay.svelte';
	import ConfirmDialog from '../ConfirmDialog.svelte';
	import Icon from '../Icon.svelte';
	import Segmented from '../Segmented.svelte';
	import RouteStrip from './route/RouteStrip.svelte';
	import RouteTextField from './route/RouteTextField.svelte';
	import WaypointRow from './route/WaypointRow.svelte';
	import { useWaypointHover } from '../featureHover.svelte';
	import type { LegView, LegWarn } from './route/legView';
	import { fitRoute } from './route/fitRoute';
	import { inputValue, inputChecked, downloadBlob } from '$lib/ui/dom';
	import { pickerAccept } from '$lib/ui/filePicker';
	import {
		cancelTerrainPins,
		downloadTerrainPins,
		ensureTerrainPinStats,
		offlineTerrain,
		pinRadiusNM,
		planRoutePoints,
		removeTerrainPins,
	} from '$lib/state/offlineTerrain.svelte';
	import { corridorTerrainTiles, estimateBytes, isoDay } from '$lib/offline/terrainPin';
	import { formatPackBytes } from '$lib/offline/packStore';
	import {
		activeRoute,
		routes,
		routeSettings,
		setRouteVfr,
		reorderWaypoint,
		setWaypointAltitude,
		setEditMode,
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
	import { planFileSubject } from '$lib/route/routeLabel';
	import { fileName } from '$lib/files/fileName';
	import { buildSendFplPlan, buildSendFplRoute } from '$lib/route/sendfpl';
	import { sendFplHandoff, sendRouteToSendFpl } from '$lib/native/sendfpl';
	import { isNativeApp } from '$lib/native/platform';
	import { pickFileNatively } from '$lib/state/openFile.svelte';
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
	import { ensureLinks } from '$lib/state/flightLinks.svelte';
	import {
		clearRouteLoadOutcome,
		loadRoutesFromFile,
		routeLoad,
	} from '$lib/state/routeLoad.svelte';
	import { retryRestoreRoutes } from '$lib/state/routePersist';
	import { nav } from '$lib/state/navRecording.svelte';
	import { ensureAirports, ensureNavaids, ensureAirspaces, getAirspaces } from '$lib/state/data.svelte';
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
	import { adviseLevels, type LevelSuggestion } from '$lib/route/levelAdvisor';
	import { display } from '$lib/state/display.svelte';
	import { openFlights } from '$lib/state/flightsModal.svelte';
	import {
		aircraftState,
		aircraftByKey,
		effectiveCruiseSpeedKt,
		updateAircraft,
	} from '$lib/state/aircraft.svelte';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import { orderedTrips } from '$lib/aircraft/trips';
	import { fmtAlt, fmtLevel, fmtNM, fmtDurationMin, fmtTrack, isFlightLevelAt } from '$lib/route/format';
	import {
		effectiveRouteWinds,
		globalWindIsFallback,
		routeLegForecasts,
		routeLegWindTips,
		routeWindColumns,
		routeWindEteMin,
	} from '$lib/state/routeWind.svelte';
	import { windSummaryNote } from '$lib/route/legWind';
	import { windAloft } from '$lib/state/windAloft.svelte';
	import { computeNavLog } from '$lib/route/navlog';
	import { legMagneticTrackDeg, decimalYearFromDate } from '$lib/route/magnetic';

	// Load the datasets the route feature needs: airports + navaids for the
	// search / snapping, airspaces for the nav-log schedule. All idempotent.
	// The ensure* loaders rethrow after recording the failure, so swallow the
	// rejections here; the errors surface via dataState.*Error.
	$effect(() => {
		void ensureAirports().catch(() => {});
		void ensureNavaids().catch(() => {});
		void ensureAirspaces().catch(() => {});
	});

	const enough = $derived(activeRoute().waypoints.length >= 2);
	const totalNM = $derived(totalDistanceNM());
	// The terrain-pin row's live tile count (a few ms over a whole plan);
	// tracks every waypoint and both corridor knobs through the two readers.
	const plannedTileCount = $derived(
		corridorTerrainTiles(planRoutePoints(), pinRadiusNM()).length,
	);
	// The status line is store-derived; reconcile once per mount.
	void ensureTerrainPinStats();
	// Effective cruise speed: the field's value when set, else the selected
	// aircraft's data-sheet speed (shown as the field's placeholder).
	const effCruise = $derived(effectiveCruiseSpeedKt());
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
	// cruising levels when on, the same computation MapView applies). A leg is
	// "manual" exactly when its planned altitude differs from this, which drives
	// the reset cue (below) and the edit lock: the cue then means "off the auto
	// altitude", never merely "ever edited", so it can't linger on a leg sitting
	// at its computed altitude nor go missing on a leg nudged off it. Independent
	// of wp.alt, so editing a leg doesn't recompute.
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
		return isFlightLevelAt(ft, effTa) ? fmtLevel(ft, effTa) : `${fmtAlt(ft)} ft`;
	}

	// The semicircular warning for one leg, or null: a non-compliant level
	// (click-to-fix, never auto-rewritten) wins over the transition-layer
	// advisory. Shares violatesSemicircular with NavLogSheet so the list badge
	// and the printed sheet never disagree.
	function legWarn(wp: Waypoint, i: number): LegWarn | null {
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

	// Effective per-leg winds + provenance for the W/V chips (the shared
	// resolver, so the chip, the nav log and the exports agree).
	const legWinds = $derived(effectiveRouteWinds(activeRoute()));
	const legWindTips = $derived(routeLegWindTips(activeRoute()));

	// Summary wind effect: total delta + average effective component, from
	// the same wind total the profile title shows. Null (nothing appended)
	// while no leg resolves a wind or the effect rounds away.
	const windNote = $derived(
		legWinds.some((w) => w != null)
			? windSummaryNote(eteMin, routeWindEteMin(activeRoute()), totalNM, effCruise, t.navlog)
			: null,
	);

	// The forecast demotes a typed global wind to per-leg fallback
	// (effectiveRouteWinds: override -> forecast -> global); flag the Wind
	// field visibly while that is the case, and only while it is: once the
	// forecast is known not to serve (past the model's reach, past the
	// endpoint's range, refused), the typed wind is what flies every leg and
	// the word would be a lie.
	const windIsFallback = $derived(globalWindIsFallback(activeRoute()));

	// Cruise-level advisor: the fastest usable level per leg from the
	// already-fetched forecast ladder (route/levelAdvisor.ts; cruise time
	// only, thresholded). Active only while the per-leg forecast winds are
	// in effect; the scan is pure math over the cached columns, zero
	// network. Terrain floors read the shared cache directly (not the
	// semicircular-gated derived) so they apply with the rule off too.
	const advisorActive = $derived(
		display.liveWeather && windAloft.useForecastForLegs && effCruise != null,
	);
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
	const sendFplRoute = $derived(buildSendFplRoute(activeRoute().waypoints));
	const sendFplPlan = $derived(buildSendFplPlan(routes.list));
	// Outcome stored as data and worded at render, so a locale switch re-words a
	// standing notice (docs/i18n.md rule 7). Nothing is said when the route left
	// for SendFPL: what came to the front, the app itself or the sheet holding
	// it, is the receipt.
	let sendNotice = $state<'copied' | 'failed' | null>(null);

	/* The stored workspace is held, not lost, when a restore could not run;
	 * this is the manual way back in beside the automatic dataset retry. It
	 * declines by itself if nothing is held or the workspace is no longer
	 * pristine, so the button can never overwrite live planning. */
	async function onRetryRestore(): Promise<void> {
		await retryRestoreRoutes();
	}

	async function sendToSendFpl(route: string): Promise<void> {
		menuOpen = false;
		sendNotice = null;
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
			notes.push(t.route.skippedUnresolved(loaded.dropped.join(', ')));
		}
		if (loaded.unknownAircraft) {
			notes.push(t.route.unknownAircraft(loaded.unknownAircraft));
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

	async function onLoadFile(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			return;
		}
		sendNotice = null;
		const loaded = await loadRoutesFromFile(file);
		// Cleared only once the file has been read, so the same one can be picked
		// again without the clearing racing a read still in flight.
		input.value = '';
		if (loaded) {
			fitRoute();
		}
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

	function onCruiseInput(e: Event): void {
		const s = inputValue(e).trim();
		if (s === '') {
			routeSettings.cruiseSpeedKt = null;
			return;
		}
		const v = parseFloat(s);
		routeSettings.cruiseSpeedKt = Number.isFinite(v) && v > 0 ? v : null;
	}

	// The cruise speed is one shared value with the selected aircraft: commit
	// the edit into its data sheet (updateAircraft re-syncs routeSettings to
	// the same number). On change, not per keystroke, so half-typed values
	// don't shadow the plane.
	function onCruiseChange(e: Event): void {
		const v = parseFloat(inputValue(e).trim());
		if (!Number.isFinite(v) || v <= 0) {
			return;
		}
		const key = aircraftState.selectedKey;
		if (key && aircraftByKey(key)) {
			updateAircraft(key, (a) => {
				a.cruise = { speedKt: v };
			});
		}
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

<div class="tab-panel">

	<RouteStrip onMenu={openMenu} {menuOpen} {unstored} />

	<input
		bind:this={fileInput}
		class="file-input"
		type="file"
		accept={pickerAccept('.yaml,.yml,text/yaml')}
		aria-hidden="true"
		tabindex="-1"
		onchange={onLoadFile}
	/>
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

	<!-- The one action band left above the list: the map-editing mode, with the
	     workspace history beside it. Both are about editing the route, and the
	     history has to stay one click away (the Ctrl-Z binding is the desktop
	     path, these buttons the touch one), where the file and clear commands
	     went one click deep into the strip's menu. -->
	<div class="edit-row">
		<label class="edit-toggle">
			<input
				type="checkbox"
				checked={routeSettings.editMode}
				onchange={(e) => setEditMode(inputChecked(e))}
			/>
			<span>{t.route.editOnMap}</span>
		</label>
		<div class="hist-actions">
			<button
				class="route-hist"
				title={t.route.undoTip}
				aria-label={t.route.undo}
				disabled={!routeHistory.canUndo}
				onclick={() => undoRoute()}
			>
				<Icon name="rotate-ccw" size={15} />
			</button>
			<button
				class="route-hist"
				title={t.route.redoTip}
				aria-label={t.route.redo}
				disabled={!routeHistory.canRedo}
				onclick={() => redoRoute()}
			>
				<Icon name="rotate-cw" size={15} />
			</button>
		</div>
	</div>
	{#if routes.list.findIndex((r) => r.id === routes.activeId) > 0}
		<label class="edit-toggle" title={t.route.alternateRouteTip}>
			<input
				type="checkbox"
				checked={activeRoute().alternate ?? false}
				onchange={(e) => setRouteAlternate(routes.activeId, inputChecked(e))}
			/>
			<span>{t.route.alternateRoute}</span>
		</label>
	{/if}
	<!-- The hint speaks only where it teaches something: the map gestures while
	     the mode that uses them is on (clicking the LINE to insert is not
	     discoverable), and the how-to-start line only over an empty route.
	     editMode is session-only, so the second one otherwise greeted every
	     returning session above a full waypoint list. -->
	{#if routeSettings.editMode}
		<p class="muted hint">{t.route.hintEditOn}</p>
	{:else if activeRoute().waypoints.length === 0}
		<p class="muted hint">{t.route.hintEditOff}</p>
	{/if}

	{#if activeRoute().waypoints.length > 0}
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
					? `, ${t.route.summaryCruise({ dur: fmtDurationMin(eteMin), kt: effCruise ?? 0 })}`
					: ''}{windNote ? `, ${windNote}` : ''}.
			</p>
			{#if suggestionTotalMin >= 1}
				<p class="muted summary">
					{t.route.fasterLevels(Math.round(suggestionTotalMin))}
					<button class="btn" onclick={applyAllSuggestions}>{t.route.applyAll}</button>
				</p>
			{/if}
		{/if}
	{:else}
		<p class="muted">{t.route.noWaypoints}</p>
	{/if}

	<RouteTextField />

	<!-- No launcher row here: the nav log, the vertical profile and the
	     flight preparation live in the toolbar (the cluster / the Flight
	     disclosure / the phone More menu), ONE home instead of a copy per
	     panel. Their disabled state still explains itself where the fix is
	     made: the empty-route hints above teach adding waypoints. -->

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
		<label class="range-label" title={t.route.cruiseTip}>
			<span>{t.route.cruise}</span>
			<input
				type="number"
				min="1"
				step="1"
				value={routeSettings.cruiseSpeedKt ?? ''}
				oninput={onCruiseInput}
				onchange={onCruiseChange}
				placeholder={String(effCruise ?? '')}
			/>
			<span class="unit">kt</span>
		</label>
		<label class="vfr-toggle" title={t.route.tempTasTip}>
			<input type="checkbox" bind:checked={windAloft.tempTas} disabled={!display.liveWeather} />
			<span>{t.route.tempTas}</span>
		</label>
		<label class="vfr-toggle" title={t.route.forecastWindsTip}>
			<input
				type="checkbox"
				bind:checked={windAloft.useForecastForLegs}
				disabled={!display.liveWeather}
			/>
			<span>{t.route.forecastWinds}</span>
		</label>
		<label
			class="range-label"
			title={display.liveWeather && windAloft.useForecastForLegs
				? t.route.windTipFallback
				: t.route.windTip}
		>
			<span>{t.route.wind}{#if windIsFallback}<span class="state">{t.route.fallback}</span>{/if}</span>
			<input
				type="number"
				min="0"
				max="360"
				step="5"
				value={routeSettings.windDirDeg ?? ''}
				oninput={onWindDirInput}
				aria-label={t.route.windDirGlobalAria}
			/>
			<span class="unit">°</span>
			<input
				type="number"
				min="0"
				step="5"
				value={routeSettings.windSpeedKt ?? ''}
				oninput={onWindSpeedInput}
				aria-label={t.route.windSpeedGlobalAria}
			/>
			<span class="unit">kt</span>
		</label>
		<label class="range-label">
			<span>{t.route.defaultAlt}</span>
			<input
				type="number"
				min="0"
				max={MAX_LEG_ALT_FT}
				step="500"
				value={routeSettings.defaultAltitudeFt}
				oninput={onDefaultAltInput}
			/>
			<span class="unit">ft</span>
		</label>
		<label class="range-label" title={taTitle}>
			<span>{t.route.transition}</span>
			<input
				type="number"
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
		{#if !display.liveWeather}
			<p class="muted small">{t.route.liveWeatherOffNote}</p>
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend>{t.route.planningOptions}</legend>
		<label class="range-label" title={t.route.corridorTip}>
			<span>{t.route.corridor}</span>
			<input
				type="number"
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
				checked={routeSettings.notamsOnRouteOnly}
				onchange={(e) => (routeSettings.notamsOnRouteOnly = inputChecked(e))}
			/>
			<span>{t.route.notamsOnRouteOnly}</span>
		</label>
		<label class="vfr-toggle" title={t.route.airspacesOnRouteOnlyTip}>
			<input
				type="checkbox"
				checked={routeSettings.airspacesOnRouteOnly}
				onchange={(e) => (routeSettings.airspacesOnRouteOnly = inputChecked(e))}
			/>
			<span>{t.route.airspacesOnRouteOnly}</span>
		</label>
		<label class="range-label" title={t.route.minAltTip}>
			<span>{t.route.minAlt}</span>
			<input
				type="number"
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
				onchange={(e) => (routeSettings.minAltDangerOn = inputChecked(e))}
			/>
			<span>{t.route.minAltDanger}</span>
		</label>
		<div class="terrain-pin" title={t.route.terrainTip}>
			{#if offlineTerrain.status === 'downloading'}
				<span class="terrain-note">
					{t.route.terrainDownloading}
					{Math.round(offlineTerrain.progress * 100)}%</span
				>
				<button class="btn" onclick={cancelTerrainPins}>{t.common.cancel}</button>
			{:else if offlineTerrain.count > 0}
				<span class="terrain-note">
					{t.route.terrainPinned(
						offlineTerrain.count,
						formatPackBytes(offlineTerrain.bytes),
						isoDay(offlineTerrain.newestTs),
					)}
				</span>
				<button
					class="btn"
					disabled={plannedTileCount === 0}
					onclick={() => void downloadTerrainPins()}
				>
					{t.route.terrainRedownload}
				</button>
				<button class="btn" onclick={() => void removeTerrainPins()}>
					{t.route.terrainRemove}
				</button>
			{:else}
				<button
					class="btn"
					disabled={plannedTileCount === 0}
					onclick={() => void downloadTerrainPins()}
				>
					{t.route.terrainDownload}{plannedTileCount
						? ` (~${formatPackBytes(estimateBytes(plannedTileCount))})`
						: ''}
				</button>
			{/if}
			{#if offlineTerrain.status === 'error' && offlineTerrain.error}
				<span class="terrain-fail" role="alert">{t.route.terrainErrors[offlineTerrain.error]}</span>
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
	title={t.route.actionsMenu}
	minWidthPx={200}
	onClose={() => (menuOpen = false)}
>
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
</HeadOverlay>

{#if confirmClearAll}
	<ConfirmDialog
		message={t.route.clearAllRoutesConfirm}
		confirmLabel={t.route.clearAllRoutesAction}
		danger
		onConfirm={() => {
			confirmClearAll = false;
			clearAllRoutes();
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

	@media (pointer: coarse) {
		.item {
			min-height: 44px;
			padding: 8px 10px;
		}
	}

	/* The one action band above the list: the map-editing toggle, with the
	 * workspace history right-aligned beside it. The buttons are the label's
	 * siblings, never its children, or a click on undo would toggle the
	 * checkbox. */
	.edit-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.hist-actions {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		gap: 2px;
		margin-left: auto;
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

	/* Undo / redo in the edit row: a 28px icon-button footprint; greyed and
	 * hoverless while its stack is empty. */
	.route-hist {
		display: flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
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

	.edit-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	.edit-toggle input {
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
	@media (pointer: coarse) {
		.edit-toggle,
		.vfr-toggle {
			min-height: 44px;
		}

		.edit-toggle input[type='checkbox'],
		.vfr-toggle input[type='checkbox'] {
			width: 18px;
			height: 18px;
		}
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

	.summary {
		margin: 0 0 10px;
		font-size: 12px;
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

	.range-label input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -1px;
	}

	.unit {
		flex: 0 0 auto;
		font-size: 11px;
		color: var(--text-muted);
	}

	/* Small state word under a field's label (the Wind "fallback" flag while
	   the per-leg forecast supersedes the typed value). */
	.range-label .state {
		display: block;
		font-size: 11px;
		line-height: 1.1;
		color: var(--text-muted);
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
