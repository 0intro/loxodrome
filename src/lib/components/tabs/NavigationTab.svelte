<script lang="ts">
	import { t } from '$lib/state/i18n.svelte';
	import Icon from '../Icon.svelte';
	import Segmented from '../Segmented.svelte';
	import { inputValue, downloadBlob } from '$lib/ui/dom';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { isNativeApp } from '$lib/native/platform';
	import { openIncomingBytes, pickFileNatively } from '$lib/state/openFile.svelte';
	import { equirectangularDistanceM } from '$lib/notam/geometry';
	import { NM_TO_METERS } from '$lib/notam/units';
	import { traceStartMs, traceEndMs, hasAbsoluteTime, positionAt } from '$lib/nav/trace';
	import { thinTrace } from '$lib/nav/traceProfile';
	import { traceMotion } from '$lib/state/navMotion';
	import { isAeroNightUtc } from '$lib/route/sun';
	import {
		buildLogbookCsv,
		detectTouchAndGoes,
		nightMinutes,
		summarizeFlights,
		type LogbookRow,
	} from '$lib/nav/logbook';
	import { loadedTraceSubject, traceSubjectOf } from '$lib/state/traceFile';
	import { fileName, fileStampUtc } from '$lib/files/fileName';
	import { flightLibrary, nearestAirportTo, refreshList } from '$lib/state/flightLibrary.svelte';
	import { ensureFaaDesignators, searchDesignators } from '$lib/state/referenceData.svelte';
	import { aircraftState, selectedAircraft } from '$lib/state/aircraft.svelte';
	import { flightPrep } from '$lib/state/flightPrep.svelte';
	import {
		buildTraceExport,
		resolveTraceFormat,
		traceFileSpec,
		TRACE_FORMAT_LABEL,
	} from '$lib/nav/traceExport';
	import { display } from '$lib/state/display.svelte';
	import { navProfileModal, toggleNavProfile } from '$lib/state/navProfileModal.svelte';
	import {
		nav,
		currentPose,
		currentTraceSource,
		stopRecording,
		clearTrace,
		setPlayhead,
		togglePlay,
		setIconKind,
		setShowTrace,
		setFollow,
		setVector,
		setContactMap,
		setPlaybackSpeed,
		positionQuality,
		poseAltMslFt,
		traceAltDatum,
		type IconKind,
	} from '$lib/state/navRecording.svelte';
	import { navStrip, setStripHidden, setStripOverflight } from '$lib/state/navStrip.svelte';
	import {
		goFlying,
		battery,
		refreshBattery,
		openBatterySettings,
	} from '$lib/state/flightAction.svelte';
	import {
		LOOKAHEAD_CHOICES,
		VERTICAL_BUFFER_CHOICES,
		alertInputGaps,
		alertPrefs,
		alertSuspension,
		setAlertBuffer,
		setAlertCautionAudio,
		setAlertLookahead,
		setAlertAudio,
		setAlertTier,
		setAlertsEnabled,
	} from '$lib/state/airspaceAlert.svelte';
	import { armAlertAudio, disarmAlertAudio, playTest } from '$lib/nav/alertSounds';
	import { OVERFLIGHT_RADIUS_NM } from '$lib/nav/overflight';
	import { AUTO_STOP_GRACE_MS } from '$lib/nav/autoStop';
	import { autoStop, keepRecording, setAutoStopEnabled } from '$lib/state/autoStop.svelte';
	import { adjacentReplayEvent, navLiveNow, replayEvents } from '$lib/state/navLive.svelte';
	import {
		navRoute,
		navRouteId,
		navSegments,
		setNavLegPin,
		setNavRoutePin,
		undoNavLegPin,
	} from '$lib/state/navRoute.svelte';
	import { activeRoute, routes } from '$lib/state/route.svelte';
	import { waypointLabel } from '$lib/route/navlog';
	import { routeColorMap } from '$lib/route/routeColors';
	import { routeEndpointLabel } from '$lib/route/routeLabel';
	import { dataState } from '$lib/state/data.svelte';
	import { fmtAlt, fmtClockUtc, fmtClockUtcSec, fmtDurationMin, fmtDurationMs } from '$lib/route/format';
	import { formatZulu } from '$lib/format/datetime';
	import ConfirmDialog from '../ConfirmDialog.svelte';

	/** Selectable playback speeds; the loop itself lives in navRecording, so
	 *  replay keeps running when the sidebar unmounts this tab. */
	const SPEEDS = [1, 2, 4, 8, 16];

	// Unique id for the alert-settings body, the master switch's
	// aria-controls target.
	const uid = $props.id();

	let fileInput = $state<HTMLInputElement | null>(null);
	let importError = $state<string | null>(null);

	const hasTrace = $derived(nav.points.length > 0);

	/* The most recent filed flight, for the line under Start when the boot
	 * released a finished trace. Listing the library is what fills
	 * flightLibrary.rows; the surface does it on open, so ask once here for
	 * the case where the tab is the first thing the user reaches. */
	$effect(() => {
		if (!hasTrace && !flightLibrary.loaded && !flightLibrary.loading) {
			void refreshList();
		}
	});
	const lastFiled = $derived(
		flightLibrary.rows.length > 0 ? formatZulu(new Date(flightLibrary.rows[0].id)) : null,
	);
	const startMs = $derived(traceStartMs(nav.points));
	const endMs = $derived(traceEndMs(nav.points));
	const spanMs = $derived(startMs != null && endMs != null ? endMs - startMs : 0);
	const canReplay = $derived(hasTrace && !nav.recording && spanMs > 0);
	// Time-of-day gates on real wall clock: a time-less GPX runs on a
	// synthesised clock from epoch 0, where a "00:00:07Z" would be noise.
	const hasClock = $derived(hasAbsoluteTime(nav.points));
	// The debrief jump targets: every stamped instant of the trace, RAW, so
	// the events derived is stable across playback ticks and only the
	// adjacency scan below reads the playhead. Lazy: nothing here evaluates
	// until the replay transport renders.
	const events = $derived(replayEvents());
	const prevEvent = $derived(adjacentReplayEvent(events, nav.playheadMs, -1));
	const nextEvent = $derived(adjacentReplayEvent(events, nav.playheadMs, 1));
	const errorText = $derived(nav.error ? t.navigation.errors[nav.error] : null);
	const inputGaps = $derived(alertInputGaps());
	const suspension = $derived(alertSuspension());
	// The current point: live tip while recording, else the replay / pinned
	// playhead point. Keeps the readout populated on scrub / playback.
	const pose = $derived(currentPose());

	// The merged live-navigation state (route-referenced; state/navLive).
	const routeLoaded = $derived(activeRoute().waypoints.length >= 2);
	const liveInfo = $derived(navLiveNow());

	// The plan's routes and how far the flight got through them. The picker
	// shows only when there is a choice to make; one route is not a plan of
	// consecutive routes.
	const flownId = $derived(navRouteId());
	const planRoutes = $derived.by(() => {
		const segs = navSegments();
		const hues = routeColorMap(routes.list);
		return routes.list
			.filter((r) => r.waypoints.length >= 2)
			.map((r) => {
				const seg = segs.findLast((s) => s.routeId === r.id) ?? null;
				return {
					id: r.id,
					label: routeEndpointLabel(r, t.route.newRoute),
					hue: hues.get(r.id) ?? '',
					alternate: r.alternate === true,
					flying: r.id === flownId,
					arrivedMs: seg?.arrivalMs ?? null,
					fromMs: seg?.fromMs ?? null,
					pinned: navRoute.pin === r.id,
				};
			});
	});
	const showRoutes = $derived(planRoutes.length > 1);

	// The segments of the route being flown, and which of them the projection
	// reads. Pressing one is a RECALAGE, not a standing override: the fold
	// re-anchors there and sequences on by its own rules (state/navRoute).
	// Only with a trace to re-anchor, and only where there is a choice to make.
	const flownRoute = $derived(routes.list.find((r) => r.id === flownId) ?? activeRoute());
	const legRows = $derived.by(() => {
		const wps = flownRoute.waypoints;
		if (!hasTrace || wps.length < 3) {
			return [];
		}
		const st = liveInfo?.log.state ?? null;
		const cur = st?.currentLegIdx ?? null;
		// The hand-set marker rides the live state's own answer, which drops it
		// once the flight sequences past the segment: from there on the log is
		// reading what it worked out itself again.
		const byHand = liveInfo?.log.pinnedLegIdx ?? null;
		return wps.slice(0, -1).map((w, i) => ({
			idx: i,
			label: `${waypointLabel(w)} → ${waypointLabel(wps[i + 1])}`,
			flying: cur === i,
			byHand: byHand === i,
			atoMs: st?.wpts[i + 1]?.atoMs ?? null,
		}));
	});
	const showLegs = $derived(legRows.length > 1);

	// How much the pose can be trusted. Every figure below reads one fix, and a
	// frozen one renders like a fresh one unless the state says otherwise.
	const quality = $derived(positionQuality());

	// The outing's record, read RAW off the shared motion fold: routeless
	// (unlike the live selector's route gate) and deliberately not
	// playhead-filtered, since the summary card is the flight's own record.
	const motion = $derived(traceMotion(nav.points));
	// Touch-and-goes, detected once the recording ends: the walk needs the
	// airports dataset and the whole trace, so during a recording the count
	// is the committed landings only and the touches join when the flight
	// is over (nav/logbook.ts detectTouchAndGoes; advisory by construction).
	const touchAndGoes = $derived.by(() => {
		if (nav.recording || motion.takeoffMs == null) {
			return [];
		}
		return detectTouchAndGoes(
			nav.points,
			motion,
			poseAltMslFt,
			(lat, lon) => nearestAirportTo(lat, lon)?.elevFt ?? null,
		);
	});
	const landingsTotal = $derived(motion.landingsMs.length + touchAndGoes.length);
	// Night landings per the aeronautical-night rule (route/sun.ts), each
	// judged at its own instant and position; a handful at most.
	const landingsNight = $derived.by(() => {
		let n = 0;
		for (const ms of motion.landingsMs) {
			const p = positionAt(nav.points, ms);
			if (p && isAeroNightUtc(p.lat, p.lon, ms)) {
				n++;
			}
		}
		for (const tg of touchAndGoes) {
			if (isAeroNightUtc(tg.lat, tg.lon, tg.ms)) {
				n++;
			}
		}
		return n;
	});
	// Night minutes of the block span (the shared logbook integration). The
	// recording gate runs FIRST so the O(minutes) walk stays untracked per
	// fix; on the ground after the flight it runs once per trace change.
	const nightTimeMin = $derived.by(() => {
		if (nav.recording || motion.firstMoveMs == null || motion.lastMoveMs == null) {
			return null;
		}
		return nightMinutes(nav.points, motion.firstMoveMs, motion.lastMoveMs);
	});
	// Max altitude flown (MSL), over the same thinned trace the profile chart
	// draws, so the two figures agree by construction; recording-gated like
	// the night walk (the O(n) thinning must not run per fix).
	const maxAltFt = $derived.by(() => {
		if (nav.recording || nav.points.length === 0) {
			return null;
		}
		let max: number | null = null;
		for (const p of thinTrace(nav.points, 600, poseAltMslFt)) {
			if (p.altFt != null && (max == null || p.altFt > max)) {
				max = p.altFt;
			}
		}
		return max;
	});

	const totalDistNM = $derived.by(() => {
		const p = nav.points;
		let m = 0;
		for (let i = 1; i < p.length; i++) {
			m += equirectangularDistanceM(p[i - 1].lat, p[i - 1].lon, p[i].lat, p[i].lon);
		}
		return m / NM_TO_METERS;
	});

	/* These three confirms fire in the cockpit, so they go through the
	 * app's own ConfirmDialog: themed (a night session stays night), sized
	 * to the 44px in-flight floor, with the safe action first and initial
	 * focus on it. `ask` holds the question until it is answered. */
	let confirm = $state<{ message: string; label: string; run: () => void } | null>(null);

	function ask(message: string, label: string, run: () => void): void {
		confirm = { message, label, run };
	}

	/* Start / Continue ride the shared flight flow (state/flightAction:
	 * recording + strip up + panel collapsed + follow re-armed + the
	 * battery offer), so the tab's own buttons end on the map exactly like
	 * the toolbar flight button. Restart keeps its tab-local confirm and
	 * calls goFlying(true) directly: an explicit restart must BYPASS the
	 * flow's same-outing continue rule. */
	function onRestart(): void {
		ask(t.navigation.replaceConfirm, t.navigation.replaceConfirmAction, () => goFlying(true));
	}

	// A per-visit re-read, so an exemption granted in the system settings
	// is noticed without a flight start (the hint row below reads it).
	if (isNativeApp()) {
		void refreshBattery();
	}

	// What the export will actually write: the stored preference, downgraded
	// when the trace carries no UTC clock (IGC states one date, so it cannot
	// be written for a GPX imported without <time>). The button names the
	// resolved answer, the resolveAltDatum idiom - EXCEPT for a trace that was
	// imported, which goes back out as the file it arrived as whatever the
	// preference says, so there is no format to promise (docs/trace-files.md).
	const exportFormat = $derived(resolveTraceFormat(display.traceExportFormat, nav.points));
	const exportsOwnFile = $derived(!display.convertImportedTraces && nav.traceHasSource);

	function onExport(): void {
		if (!hasTrace) {
			return;
		}
		// The loaded trace's own file, when it has one: the same rule the
		// flights library applies to a filed outing (state/traceFile.ts).
		const own = display.convertImportedTraces ? null : currentTraceSource();
		if (own) {
			const spec = traceFileSpec(own.format);
			downloadBlob(
				new Blob([own.bytes as BlobPart], { type: spec.mime }),
				own.name ||
					fileName([loadedTraceSubject(), fileStampUtc(startMs ?? Date.now())], spec.ext),
				spec.mime,
			);
			return;
		}
		const plane = selectedAircraft();
		// The datum is stated rather than left as the device's raw reference:
		// GPX and KML get MSL, IGC the ellipsoidal height its GNSS column is
		// defined on (nav/traceExport.ts, docs/trace-files.md).
		const file = buildTraceExport($state.snapshot(nav.points), {
			format: display.traceExportFormat,
			datum: traceAltDatum(),
			atMs: startMs ?? Date.now(),
			subject: loadedTraceSubject(),
			pilot: flightPrep.dossier.pilot.name,
			aircraftType: plane?.identity.type,
			aircraftId: plane?.identity.registration,
			softwareVersion: __APP_VERSION__,
		});
		downloadBlob(file.text, file.filename, file.mime);
	}

	/* Natively the Android picker, not the WebView's own chooser, which hands
	 * the page a file it cannot always read back; the dispatcher applies the
	 * trace and asks the same replace question (docs/android.md). */
	function openPicker(): void {
		if (isNativeApp()) {
			void pickFileNatively();
			return;
		}
		fileInput?.click();
	}

	function onImport(e: Event): void {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		importError = null;
		if (!file) {
			return;
		}
		// The file is captured here: the picker's input is already cleared,
		// and the confirm now returns through a callback rather than blocking.
		if (hasTrace) {
			ask(t.navigation.replaceConfirm, t.navigation.replaceConfirmAction, () => {
				void readTrace(file);
			});
			return;
		}
		void readTrace(file);
	}

	/* The picked file goes through the SAME dispatcher an Android intent or a
	 * ?file= parameter uses (state/openFile): it sniffs the format, unwraps a
	 * KMZ, parses, asks the altitude reference when the file states none, and
	 * fits the map. Keeping a second copy of that sequence here is what let
	 * the tab drift from the intent path in the first place; the replace
	 * question stays this tab's own, since the confirm is already up when the
	 * user picks. */
	async function readTrace(file: File): Promise<void> {
		importError = null;
		try {
			await openIncomingBytes(file.name, new Uint8Array(await file.arrayBuffer()));
		} catch {
			importError = t.navigation.importFailed;
		}
	}

	function onClear(): void {
		ask(t.navigation.clearConfirm, t.navigation.clearConfirmAction, clearTrace);
	}

	/** The EASA logbook export (docs/logbook.md): one AMC1 FCL.050-shaped
	 *  row per flight of the outing, pre-filled with what the trace and the
	 *  selected aircraft attest, empty cells for what stays the pilot's.
	 *  The derivation is the shared pure fold (nav/logbook summarizeFlights);
	 *  this handler adds only the LIVE decorations: the plan-endpoint place
	 *  fallback, the aircraft make / registration, the pilot name. */
	async function onExportLogbook(): Promise<void> {
		const summaries = summarizeFlights(nav.points, motion, {
			altMslFt: poseAltMslFt,
			fieldElevFt: (lat, lon) => nearestAirportTo(lat, lon)?.elevFt ?? null,
			placeIdentAt: (lat, lon) => nearestAirportTo(lat, lon)?.ident ?? '',
		});
		if (summaries.length === 0) {
			return;
		}
		// The make rides the FAA designator catalog via the sheet's icaoType;
		// a failed load just leaves the cell for the pilot.
		try {
			await ensureFaaDesignators();
		} catch {
			/* make stays blank */
		}
		const plane = selectedAircraft();
		const icaoType = plane?.identity.icaoType?.toUpperCase();
		const makeRow = icaoType
			? searchDesignators(icaoType, 12).find((r) => r.code === icaoType)
			: undefined;
		// The generic designators carry "(any manufacturer)", which is not a
		// make; a registration-less sheet falls back to the selection key,
		// which is then the TYPE (aircraftKey), accepted for v1.
		const aircraftMake = makeRow && !makeRow.manufacturer.startsWith('(') ? makeRow.manufacturer : '';
		const registration = plane?.identity.registration ?? aircraftState.selectedKey ?? '';
		const aircraftModel = plane?.identity.type ?? '';
		const picName = flightPrep.dossier.pilot.name.trim() || 'SELF';
		// Remarks: the flown plan's route chain, first-flown order.
		const segs = navSegments();
		const flownIds: string[] = [];
		for (const s of segs) {
			if (!flownIds.includes(s.routeId)) {
				flownIds.push(s.routeId);
			}
		}
		const flownRoutes = flownIds
			.map((id) => routes.list.find((r) => r.id === id))
			.filter((r) => r != null && r.waypoints.length >= 2);
		const remarks = flownRoutes.map((r) => routeEndpointLabel(r!, t.route.newRoute)).join(' / ');
		// Endpoint fallback for the outing's ends when no airport sits within
		// the place radius (or the dataset is missing): the flown plan's own
		// aerodromes.
		const firstWp = flownRoutes[0]?.waypoints[0];
		const lastRoute = flownRoutes[flownRoutes.length - 1];
		const lastWp = lastRoute?.waypoints[lastRoute.waypoints.length - 1];
		const rows: LogbookRow[] = summaries.map((s, i) => {
			let departurePlace = s.depPlace;
			if (departurePlace === '' && i === 0 && firstWp?.kind === 'airport' && firstWp.ident) {
				departurePlace = firstWp.ident;
			}
			let arrivalPlace = s.arrPlace;
			if (
				arrivalPlace === '' &&
				i === summaries.length - 1 &&
				s.landingMs != null &&
				lastWp?.kind === 'airport' &&
				lastWp.ident
			) {
				arrivalPlace = lastWp.ident;
			}
			return {
				slice: {
					blockOffMs: s.blockOffMs,
					takeoffMs: s.takeoffMs,
					landingMs: s.landingMs,
					blockOnMs: s.blockOnMs,
					distanceNM: s.distanceNM,
				},
				departurePlace,
				arrivalPlace,
				aircraftMake,
				aircraftModel,
				registration,
				picName,
				landingsDay: s.landingsDay,
				landingsNight: s.landingsNight,
				nightMin: s.nightMin,
				remarks,
			};
		});
		downloadBlob(
			buildLogbookCsv(rows),
			fileName([traceSubjectOf(summaries), 'logbook', fileStampUtc(summaries[0].blockOffMs)], 'csv'),
			'text/csv',
		);
	}

	/** Arming IS the browser audio unlock (it runs in this click), and it
	 *  plays the chime once so the pilot hears what armed means. */
	function onAlertAudio(e: Event): void {
		const on = (e.target as HTMLInputElement).checked;
		if (on && !armAlertAudio()) {
			setAlertAudio(false);
			return;
		}
		setAlertAudio(on);
		if (on) {
			playTest();
		} else {
			disarmAlertAudio();
		}
	}

	const ICONS: { kind: IconKind; label: () => string; glyph: string }[] = [
		{ kind: 'plane', label: () => t.navigation.plane, glyph: 'plane' },
		{ kind: 'helicopter', label: () => t.navigation.helicopter, glyph: 'helicopter' },
		{ kind: 'glider', label: () => t.navigation.glider, glyph: 'glider' },
	];
</script>

<div class="tab-panel">
	<h2>{t.tabs.navigation}</h2>
	<p class="muted small">{t.navigation.intro}</p>

	{#snippet speedControl()}
		<div class="speed-row">
			<span class="sym-label">{t.navigation.speed}</span>
			<!-- i18n-ignore: the multiplier suffix is locale-invariant -->
			<Segmented
				options={SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }))}
				value={String(nav.playbackSpeed)}
				onSelect={(v) => setPlaybackSpeed(Number(v))}
				ariaLabel={t.navigation.speed}
			/>
		</div>
	{/snippet}

	<fieldset class="group">
		<legend>{t.navigation.position}</legend>

		<div class="btn-row">
			{#if nav.recording}
				<button class="btn stop" onclick={stopRecording}>
					<Icon name="stop" size={14} />
					{t.navigation.stop}
				</button>
				<span class="rec">
					<span class="rec-dot" aria-hidden="true"></span>
					{t.navigation.recording}
					{#if spanMs > 0}<span class="rec-elapsed">{fmtDurationMs(spanMs)}</span>{/if}
				</span>
			{:else if hasTrace}
				<button class="btn rec-btn" onclick={() => goFlying(false)} title={t.navigation.continueTip}>
					<Icon name="record" size={14} />
					{t.navigation.continue}
				</button>
				<button class="btn" onclick={onRestart} title={t.navigation.restartTip}>
					<Icon name="rotate-ccw" size={14} />
					{t.navigation.restart}
				</button>
			{:else}
				<button class="btn rec-btn" onclick={() => goFlying(true)}>
					<Icon name="record" size={14} />
					{t.navigation.start}
				</button>
			{/if}
		</div>

		<!-- A finished flight is not redrawn at startup: it is a row in the
		     flights library, and an orange track on the map reads as something
		     live. Say where it went instead. -->
		{#if !hasTrace && !nav.recording && lastFiled}
			<!-- Text only: the toolbar's Flights launcher is the way in. -->
			<p class="muted small">{t.navigation.lastFlightFiled(lastFiled)}</p>
		{/if}

		{#if errorText}
			<p class="error small" role="alert">{errorText}</p>
		{/if}

		<!-- What the platform does with the position while recording. The
		     native shell keeps it through a foreground service; the web keeps
		     it only while the page is, which is the one degradation a pilot
		     cannot see happening (the trace simply gains a gap). -->
		{#if nav.recording}
			<p class="muted small">
				{isNativeApp() ? t.navigation.bgNote : t.navigation.fgNote}
			</p>
		{/if}

		<!-- The strip's countdown, mirrored where the Stop button lives. -->
		{#if autoStop.pending}
			{@const remainMs = Math.max(0, autoStop.pending.stopAtMs - nav.nowMs)}
			<p class="stop-soon" role="timer" aria-label={t.navigation.autoStopLabel}>
				<Icon name="stop" size={13} />
				{t.navigation.autoStopCountdown(fmtDurationMs(remainMs))}
				<button class="btn keep" title={t.navigation.autoStopKeepTip} onclick={keepRecording}
					>{t.navigation.autoStopKeep}</button
				>
			</p>
		{:else if autoStop.firedAtMs != null}
			<p class="muted small" role="status">{t.navigation.autoStopNote(fmtClockUtc(autoStop.firedAtMs))}</p>
		{/if}

		<!-- The live figures are NOT here: they are on the in-flight strip over
		     the map (NavStrip), which survives every tab selection, where this
		     panel is unmounted the moment another tab is picked. What stays is
		     what a pilot sets up or reads afterwards. -->
		{#if quality !== 'good' && nav.lastFix}
			<p
				class="gps-chip"
				class:lost={quality === 'lost'}
				role="status"
				title={quality === 'lost' ? t.navigation.gpsLostTip : t.navigation.gpsDegradedTip}
			>
				<Icon name="alert-triangle" size={13} />
				{quality === 'lost' ? t.navigation.gpsLost : t.navigation.gpsDegraded}
			</p>
		{/if}

		{#if nav.recording && !nav.lastFix}
			<p class="muted small">{t.navigation.waitingFix}</p>
		{:else if pose && nav.recording && nav.lastFix?.accuracyM != null}
			<p class="muted small">{t.navigation.accuracy} ±{Math.round(nav.lastFix.accuracyM)} m</p>
		{/if}

		<label class="check" title={t.navigation.autoStopTip(String(AUTO_STOP_GRACE_MS / 60_000))}>
			<input
				type="checkbox"
				checked={autoStop.enabled}
				onchange={(e) => setAutoStopEnabled((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.autoStopEnable}
		</label>

		{#if battery.ignoring === false}
			<p class="bg-battery muted small">
				{t.navigation.bgBatteryHint}
				<button class="btn" onclick={() => void openBatterySettings()}>{t.navigation.bgBatteryFix}</button>
			</p>
		{/if}

		<!-- The outing's record: the flight's own figures off the RAW motion
		     fold, routeless and deliberately not playhead-filtered (the card
		     is the debrief record; the strip carries what changes per fix).
		     It stays up while recording too: these times live nowhere else,
		     and the post-landing grace window is exactly when they are read.
		     The night and max-altitude walks join once the recording ends. -->
		{#if hasTrace && motion.takeoffMs != null}
			<dl class="readout stats">
				{#if motion.firstMoveMs != null}
					<dt title={t.navigation.blockOffTip}>{t.navigation.blockOff}</dt>
					<dd>{fmtClockUtc(motion.firstMoveMs)}Z</dd>
				{/if}
				<dt>{t.navigation.navlogTakeoff}</dt>
				<dd>{fmtClockUtc(motion.takeoffMs)}Z</dd>
				{#if motion.landingMs != null}
					<dt>{t.navigation.navlogLanding}</dt>
					<dd>{fmtClockUtc(motion.landingMs)}Z</dd>
					{#if motion.lastMoveMs != null}
						<dt title={t.navigation.blockOnTip}>{t.navigation.blockOn}</dt>
						<dd>{fmtClockUtc(motion.lastMoveMs)}Z</dd>
					{/if}
					<dt title={t.navigation.navlogAirborneTip}>{t.navigation.navlogAirborne}</dt>
					<dd>{fmtDurationMs(motion.landingMs - motion.takeoffMs)}</dd>
					<!-- The logged figure: FCL.010 flight time is block to block, NOT
					     the airborne time above it. -->
					{#if motion.firstMoveMs != null && motion.lastMoveMs != null}
						<dt title={t.navigation.navlogFlightTimeTip}>{t.navigation.navlogFlightTime}</dt>
						<dd>{fmtDurationMs(motion.lastMoveMs - motion.firstMoveMs)}</dd>
					{/if}
				{/if}
				{#if landingsTotal > 0}
					<dt title={t.navigation.landingsCountTip}>{t.navigation.landingsCount}</dt>
					<dd>
						{landingsTotal}{#if landingsNight > 0}
							({t.navigation.landingsNight(String(landingsNight))}){/if}
					</dd>
				{/if}
				{#if nightTimeMin != null && nightTimeMin > 0}
					<dt title={t.navigation.nightTimeTip}>{t.navigation.nightTime}</dt>
					<dd>{fmtDurationMin(nightTimeMin)}</dd>
				{/if}
				{#if maxAltFt != null}
					<dt title={t.navigation.maxAltitudeTip}>{t.navigation.maxAltitude}</dt>
					<!-- i18n-ignore: ft is an ICAO Annex 5 unit, locale-invariant -->
					<dd>{fmtAlt(maxAltFt)} ft</dd>
				{/if}
			</dl>
			{#if !nav.recording}
				<!-- One AMC1 FCL.050-shaped row per flight (docs/logbook.md);
				     what the trace cannot attest stays an empty cell to fill. -->
				<div class="btn-row">
					<button class="btn wide" onclick={() => void onExportLogbook()} title={t.navigation.exportCsvTip}>
						<Icon name="upload" size={14} />
						{t.navigation.exportCsv}
					</button>
				</div>
			{/if}
		{/if}

	</fieldset>

	<!-- The band over the map, named as it names itself: what it carries, and
	     the way back to it once it has been hidden. -->
	<fieldset class="group">
		<legend>{t.navigation.stripLabel}</legend>

		{#if navStrip.hidden}
			<div class="btn-row">
				<button class="btn wide" onclick={() => setStripHidden(false)}>
					<Icon name="gauge" size={14} />
					{t.navigation.stripShow}
				</button>
			</div>
		{/if}

		<!-- The band's one position-resolved cell: it answers from the pose
		     alone, route or no route. -->
		<label class="check" title={t.navigation.overflightFreqTip(String(OVERFLIGHT_RADIUS_NM))}>
			<input
				type="checkbox"
				checked={navStrip.overflight}
				onchange={(e) => setStripOverflight((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.overflightFreq}
		</label>
	</fieldset>

	<fieldset class="group">
		<legend title={t.navigation.navlogTip}>{t.navigation.navlog}</legend>

		<!-- No launcher here: the log opens from the toolbar (its one home)
		     and, in flight, from the strip's own button one tap from the
		     figures. This group holds what the tab reads and sets. -->
		{#if !routeLoaded}
			<p class="muted small">{t.route.twoWaypointsHint}</p>
		{/if}

		{#if showRoutes}
			<!-- Which route of a chained plan is being flown. Detected from the
			     track and handed over on arrival; a pin overrides it, which is
			     the recovery when the projection reads the wrong identity. -->
			<p class="plan-label" title={t.navigation.flownRouteTip}>{t.navigation.flownRoute}</p>
			<ul class="plan">
				{#each planRoutes as r (r.id)}
					<li>
						<button
							type="button"
							class="leg"
							class:alt={r.alternate}
							class:flying={r.flying}
							class:pinned={r.pinned}
							aria-pressed={r.pinned}
							title={r.pinned ? t.navigation.routeRelease : t.navigation.routePin}
							onclick={() => setNavRoutePin(r.pinned ? null : r.id)}
						>
							<span class="dot" style="background:{r.hue}"></span>
							<span class="name">{r.label}</span>
							<span class="state">
								{#if r.pinned}
									{t.navigation.routePinned}
								{:else if r.flying}
									{t.navigation.routeFlying}
								{:else if r.arrivedMs != null}
									{fmtClockUtc(r.arrivedMs)}Z
								{:else if r.fromMs == null}
									{t.navigation.routeNotFlown}
								{:else}
									{t.navigation.routeFlown}
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if showLegs}
			<!-- Which segment of that route the projection is reading. Pressing
			     one re-anchors the fold there from the displayed instant on: the
			     recovery when a turn-back, or a corridor the route shares with
			     itself, leaves the log on the wrong segment. -->
			<p class="plan-label" title={t.navigation.flownLegTip}>{t.navigation.flownLeg}</p>
			<ul class="plan">
				{#each legRows as l (l.idx)}
					<li>
						<button
							type="button"
							class="leg"
							class:flying={l.flying}
							class:pinned={l.byHand}
							aria-pressed={l.byHand}
							title={l.byHand ? t.navigation.legRelease : t.navigation.legPin}
							onclick={() =>
								l.byHand ? undoNavLegPin(flownRoute.id) : setNavLegPin(flownRoute.id, l.idx)}
						>
							<span class="name">{l.label}</span>
							<span class="state">
								{#if l.byHand}
									{t.navigation.legByHand}
								{:else if l.flying}
									{t.navigation.routeFlying}
								{:else if l.atoMs != null}
									{fmtClockUtc(l.atoMs)}Z
								{/if}
							</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}

		{#if routeLoaded && liveInfo}
			{@const contact = liveInfo.contact}
			{@const noEnroute =
				contact != null && !contact.current && !contact.next && contact.toBoundaryNM == null}
			<label class="check">
				<input
					type="checkbox"
					checked={nav.contactMap}
					onchange={(e) => setContactMap((e.target as HTMLInputElement).checked)}
				/>
				{t.navigation.contactMap}
			</label>
			{#if !pose}
				<p class="muted small">{t.navigation.contactNoFix}</p>
			{/if}
			{#if !dataState.airspacesLoaded}
				<p class="muted small">
					{dataState.airspacesError != null
						? t.navlog.airspacesUnavailable
						: t.navlog.loadingAirspaces}
				</p>
			{:else if pose && noEnroute}
				<p class="muted small">{t.navigation.contactNone}</p>
			{/if}
		{/if}
	</fieldset>

	<fieldset class="group">
		<legend title={t.navigation.alertsTip}>{t.navigation.alertsSection}</legend>

		<!-- The master switch is the group's one decision; the tier / buffer /
		     audio controls show exactly while it is armed. -->
		<label class="check">
			<input
				type="checkbox"
				checked={alertPrefs.enabled}
				aria-expanded={alertPrefs.enabled}
				aria-controls="{uid}-alert-settings"
				onchange={(e) => setAlertsEnabled((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.alertsEnable}
		</label>

		{#if alertPrefs.enabled}
		<div id="{uid}-alert-settings">
			<!-- A suspended evaluation, stated where the channel is armed:
			     the strip's banner region says the same in flight, and the
			     surface must never be silently blank while a recording
			     runs (docs/nav-alerts.md "Degradation ladder"). -->
			{#if suspension}
				<p
					class="alert-gap"
					title={suspension === 'lost'
						? t.navigation.alertSuspendedLostTip
						: t.navigation.alertSuspendedNoFixTip}
				>
					{suspension === 'lost'
						? t.navigation.alertSuspendedLost
						: t.navigation.alertSuspendedNoFix}
				</p>
			{/if}
			<!-- What the evaluator is missing, stated where it is armed. The
			     strip says the same thing in flight; this is the desk half,
			     reachable with no route loaded (which the airspace-failure
			     line beside the live figures below is not). -->
			{#if inputGaps}
				<p
					class="alert-gap"
					title={inputGaps.airspaces
						? t.navigation.alertNoAirspacesTip
						: t.navigation.alertNoBriefingTip}
				>
					{inputGaps.airspaces
						? t.navigation.alertNoAirspaces
						: t.navigation.alertNoBriefing}
				</p>
			{/if}
			<label class="check sub">
				<input
					type="checkbox"
					checked={alertPrefs.tiers.avoid}
					onchange={(e) => setAlertTier('avoid', (e.target as HTMLInputElement).checked)}
				/>
				{t.navigation.alertTierAvoid}
			</label>
			<label class="check sub">
				<input
					type="checkbox"
					checked={alertPrefs.tiers.clearance}
					onchange={(e) => setAlertTier('clearance', (e.target as HTMLInputElement).checked)}
				/>
				{t.navigation.alertTierClearance}
			</label>
			<label class="check sub">
				<input
					type="checkbox"
					checked={alertPrefs.tiers.equipment}
					onchange={(e) => setAlertTier('equipment', (e.target as HTMLInputElement).checked)}
				/>
				{t.navigation.alertTierEquipment}
			</label>
			<label class="check sub">
				<input
					type="checkbox"
					checked={alertPrefs.tiers.caution}
					onchange={(e) => setAlertTier('caution', (e.target as HTMLInputElement).checked)}
				/>
				{t.navigation.alertTierCaution}
			</label>

			<label class="check spread" title={t.navigation.alertBufferTip}>
				<span>{t.navigation.alertBuffer}</span>
				<select
					value={String(alertPrefs.bufferFt)}
					onchange={(e) => setAlertBuffer(Number((e.target as HTMLSelectElement).value))}
				>
					{#each VERTICAL_BUFFER_CHOICES as ft (ft)}
						<!-- i18n-ignore: ft is an ICAO Annex 5 unit, locale-invariant -->
						<option value={String(ft)}>{ft} ft</option>
					{/each}
				</select>
			</label>
			<label class="check spread">
				<span>{t.navigation.alertLookahead}</span>
				<select
					value={String(alertPrefs.lookaheadMin)}
					onchange={(e) => setAlertLookahead(Number((e.target as HTMLSelectElement).value))}
				>
					{#each LOOKAHEAD_CHOICES as m (m)}
						<!-- i18n-ignore: min is an ICAO Doc 8400 abbreviation, locale-invariant -->
						<option value={String(m)}>{m} min</option>
					{/each}
				</select>
			</label>

			<label class="check" title={t.navigation.alertAudioTip}>
				<input type="checkbox" checked={alertPrefs.audio} onchange={onAlertAudio} />
				{t.navigation.alertAudio}
			</label>
			{#if alertPrefs.audio}
				<label class="check sub">
					<input
						type="checkbox"
						checked={alertPrefs.audioCaution}
						onchange={(e) => setAlertCautionAudio((e.target as HTMLInputElement).checked)}
					/>
					{t.navigation.alertAudioCaution}
				</label>
				<div class="btn-row">
					<button
						class="btn"
						onclick={() => {
							armAlertAudio();
							playTest();
						}}>{t.navigation.alertTest}</button
					>
				</div>
			{/if}

			<p class="muted small">{t.navigation.alertAdvisory}</p>
		</div>
		{/if}
	</fieldset>

	<!-- How the LIVE position draws: which symbol the aircraft wears, whether
	     the map follows it, whether it trails its dead-reckoning vector. That
	     is the seam with the group below: none of the three says anything
	     about the recorded trace, and they sat under its legend only because
	     both happen to be map display. -->
	<fieldset class="group">
		<legend>{t.navigation.aircraft}</legend>

		<div class="sym-row">
			<span class="sym-label">{t.navigation.aircraftSymbol}</span>
			<Segmented
				options={ICONS.map((ic) => ({
					value: ic.kind,
					label: ic.label(),
					title: ic.label(),
					icon: ic.glyph,
				}))}
				value={nav.iconKind}
				onSelect={(v) => setIconKind(v as IconKind)}
				ariaLabel={t.navigation.aircraftSymbol}
			/>
		</div>

		<label class="check" title={t.navigation.followTip}>
			<input
				type="checkbox"
				checked={nav.follow}
				onchange={(e) => setFollow((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.follow}
		</label>

		<label class="check" title={t.navigation.vectorTip}>
			<input
				type="checkbox"
				checked={nav.vector}
				onchange={(e) => setVector((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.vector}
		</label>
	</fieldset>

	<!-- The recording itself, in one reading order: whether it is drawn, what
	     it is, where its file comes from and goes, and its profile. -->
	<fieldset class="group">
		<legend>{t.navigation.trace}</legend>

		<label class="check">
			<input
				type="checkbox"
				checked={nav.showTrace}
				onchange={(e) => setShowTrace((e.target as HTMLInputElement).checked)}
			/>
			{t.navigation.showTrace}
		</label>

		{#if hasTrace}
			<dl class="readout stats">
				<!-- The trace's own date: it persists across sessions, and the live log
				     stamps whatever is loaded, so an old flight must be recognisable
				     as one rather than as today's plan. -->
				<dt>{t.navigation.traceStart}</dt>
				<dd>{formatZulu(startMs != null ? new Date(startMs) : null)}</dd>
				<dt>{t.navigation.points}</dt>
				<dd>{nav.points.length}</dd>
				<dt>{t.navigation.duration}</dt>
				<dd>{fmtDurationMs(spanMs)}</dd>
				<dt>{t.navigation.distance}</dt>
				<dd>{totalDistNM.toFixed(1)} NM</dd>
			</dl>
		{/if}

		<div class="btn-row thirds">
			<button class="btn" onclick={onExport} disabled={!hasTrace}>
				<Icon name="upload" size={14} />
				{exportsOwnFile
			? t.navigation.exportTraceOwn
			: t.navigation.exportTrace(TRACE_FORMAT_LABEL[exportFormat])}
			</button>
			<button class="btn" onclick={openPicker} title={t.navigation.importTraceTip}>
				<Icon name="download" size={14} />
				{t.navigation.importTrace}
			</button>
			<button class="btn" onclick={onClear} disabled={!hasTrace}>
				<Icon name="trash" size={14} />
				{t.navigation.clear}
			</button>
		</div>
		<!-- The format lives in the Settings tab, so the one case where it
		     cannot be honoured says so where the export is. -->
		{#if display.traceExportFormat === 'igc' && exportFormat !== 'igc' && hasTrace}
			<p class="muted small">{t.navigation.exportIgcNoTime}</p>
		{/if}
		{#if importError}
			<p class="error small" role="alert">{importError}</p>
		{/if}

		<div class="btn-row">
			<!-- Named exactly like the surface it opens (and the detail panel's
			     back arrow): one wording for one thing. The Flights launcher
			     lives in the Flight group above: the library files outings,
			     not traces. -->
			<button
				class="btn wide"
				class:on={navProfileModal.open}
				aria-pressed={navProfileModal.open}
				onclick={toggleNavProfile}
				disabled={!hasTrace}
			>
				<Icon name="profile" size={14} />
				{t.navigation.profileTitle}
			</button>
		</div>

		<input
			bind:this={fileInput}
			type="file"
			accept={pickerAccept(
				'.gpx,.igc,.kml,.kmz,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz',
			)}
			class="file-hidden"
			aria-hidden="true"
			tabindex="-1"
			onchange={onImport}
		/>
	</fieldset>

	{#if canReplay}
		<fieldset class="group">
			<legend>{t.navigation.replay}</legend>
			<div class="replay">
				<!-- Jump to either end: an import opens at 00:00 to be flown through,
				     and the completed log stays one tap away. -->
				<button
					class="btn play"
					onclick={() => setPlayhead(startMs ?? 0)}
					aria-label={t.navigation.toStart}
					title={t.navigation.toStart}
				>
					<Icon name="skip-back" size={14} />
				</button>
				<!-- The event jumps, between the end jumps and play: takeoff,
				     landing, waypoint ATOs and airspace crossings are all
				     already stamped, and stepping between them is what makes
				     the replay a debriefing tool rather than a scrub bar. -->
				<button
					class="btn play"
					onclick={() => prevEvent && setPlayhead(prevEvent.ms)}
					disabled={prevEvent == null}
					aria-label={t.navigation.prevEvent}
					title={t.navigation.eventJumpTip}
				>
					<Icon name="chevron-left" size={14} />
				</button>
				<button
					class="btn play"
					onclick={togglePlay}
					aria-label={nav.playing ? t.navigation.pause : t.navigation.play}
				>
					<Icon name={nav.playing ? 'pause' : 'play'} size={14} />
				</button>
				<button
					class="btn play"
					onclick={() => nextEvent && setPlayhead(nextEvent.ms)}
					disabled={nextEvent == null}
					aria-label={t.navigation.nextEvent}
					title={t.navigation.eventJumpTip}
				>
					<Icon name="chevron-right" size={14} />
				</button>
				<button
					class="btn play"
					onclick={() => setPlayhead(endMs ?? 0)}
					aria-label={t.navigation.toEnd}
					title={t.navigation.toEnd}
				>
					<Icon name="skip-forward" size={14} />
				</button>
				<input
					type="range"
					min={startMs ?? 0}
					max={endMs ?? 0}
					step="1000"
					value={nav.playheadMs}
					aria-label={t.navigation.replaySlider}
					oninput={(e) => setPlayhead(Number(inputValue(e)))}
				/>
			</div>
			<p class="slider-time muted small">
				{#if hasClock}<span title={t.navigation.timeOfDay}>{fmtClockUtcSec(nav.playheadMs)}Z</span>
					·
				{/if}{fmtDurationMs((nav.playheadMs - (startMs ?? 0)))} / {fmtDurationMs(spanMs)}
			</p>
			{@render speedControl()}
		</fieldset>
	{:else if !hasTrace}
		<p class="muted small">{t.navigation.noTrace}</p>
	{/if}
</div>

{#if confirm}
	<ConfirmDialog
		message={confirm.message}
		confirmLabel={confirm.label}
		danger
		onConfirm={() => {
			const run = confirm?.run;
			confirm = null;
			run?.();
		}}
		onCancel={() => (confirm = null)}
	/>
{/if}

<style>
	.small {
		font-size: 11px;
	}

	.btn-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 6px;
	}

	/* An open surface's launcher reads as pressed, marked the way the sidebar
	 * rail marks the open tab (RouteTab carries the same rule). */

	/* Export / Import / Clear: one row spanning the full width, so it lines up
	   with the Vertical profile button below.
	   The basis is the LABEL, not zero. With `flex: 1 1 0; min-width: 0` every
	   button was content at any width, so `flex-wrap` could never fire and the
	   labels painted outside their own borders instead: at the 280px sidebar
	   floor a 67px box held a label needing 119px in English and 132px in
	   French, and French spilled at the 400px default too (three of them want
	   367px of row, and the default leaves 334px). Sized from the label, the
	   row stays on one line while the three fit and wraps when they genuinely
	   do not, each line still growing to fill the width. */
	.btn-row.thirds .btn {
		flex: 1 1 auto;
		justify-content: center;
		white-space: nowrap;
	}

	.btn.rec-btn,
	.btn.stop {
		color: var(--danger);
	}

	.rec {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		color: var(--danger);
	}

	.rec-elapsed {
		font-variant-numeric: tabular-nums;
	}

	.rec-dot {
		width: 9px;
		height: 9px;
		background: var(--danger);
		border-radius: 50%;
		animation: pulse 1.4s ease-in-out infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.25;
		}
	}

	.sym-row,
	.speed-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
	}

	.sym-label {
		color: var(--text-muted);
		font-size: 12px;
	}

	.sym-row :global(.seg),
	.speed-row :global(.seg) {
		margin-left: auto;
	}

	/* The per-tier and per-channel options indent under the switch that
	   gates them. */
	.check.sub {
		margin-left: 22px;
	}

	.check.spread select {
		margin-left: auto;
	}

	/* The position-quality chip, in the alert inks rather than the nav orange:
	   this is a warning about the position, not a nav-mode identity mark. */
	.gps-chip {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 8px 0 0;
		padding: 4px 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--nav-orange);
		background: color-mix(in srgb, var(--nav-orange) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--nav-orange) 40%, transparent);
		border-radius: var(--radius);
	}

	.gps-chip.lost {
		color: var(--danger);
		background: color-mix(in srgb, var(--danger) 10%, transparent);
		border-color: color-mix(in srgb, var(--danger) 45%, transparent);
	}

	/* What the alert evaluator is missing: the same alert family, one step
	   calmer than the gps chip (it qualifies the evaluation rather than the
	   position), sitting at the head of the settings it governs. */
	.alert-gap {
		margin: 0 0 8px;
		padding: 4px 8px;
		font-size: 12px;
		color: var(--nav-orange);
		background: color-mix(in srgb, var(--nav-orange) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--nav-orange) 40%, transparent);
		border-radius: var(--radius);
	}

	/* The auto-stop countdown, the strip banner's tab mirror: the alert
	   family's stepped-back dashed form, the time in tabular figures so the
	   per-second tick moves nothing around it. */
	.stop-soon {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 8px 0 0;
		padding: 4px 8px;
		font-size: 12px;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		color: var(--nav-orange);
		background: color-mix(in srgb, var(--nav-orange) 10%, transparent);
		border: 1px dashed color-mix(in srgb, var(--nav-orange) 40%, transparent);
		border-radius: var(--radius);
	}

	.stop-soon .btn.keep {
		margin-left: auto;
	}

	.bg-battery {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
	}

	.bg-battery .btn {
		margin-left: auto;
	}

	/* The plan's routes. One line each so the list stays readable at the
	   panel's narrowest, the name taking whatever the state leaves. */
	.plan-label {
		margin: 0 0 4px;
		color: var(--text-muted);
		font-size: 12px;
	}

	.plan {
		list-style: none;
		margin: 0 0 8px;
		padding: 0;
	}

	.leg {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 5px 6px;
		border: 1px solid transparent;
		border-radius: 4px;
		background: none;
		color: inherit;
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}

	.leg:hover {
		background: var(--surface-hover);
	}

	.leg.flying {
		border-color: var(--nav-accent);
	}

	.leg.pinned {
		background: color-mix(in srgb, var(--nav-accent) 14%, transparent);
		border-color: var(--nav-accent);
	}

	/* An alternate steps in under the trip it belongs to, so the interleave
	   the plan is saved in reads as the structure it is. */
	.leg.alt {
		padding-left: 18px;
	}

	.leg .dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.leg .name {
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.leg .state {
		flex: none;
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	.leg.flying .state,
	.leg.pinned .state {
		color: var(--nav-accent);
	}

	:global(:root.touch-ui) .leg {
		min-height: 44px;
	}

	.readout {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 8px 0 0;
		font-size: 12px;
	}

	.readout dt {
		color: var(--text-muted);
	}

	.readout dd {
		margin: 0;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.check:has(input:disabled) {
		cursor: default;
		color: var(--text-muted);
	}

	.replay {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
	}

	.replay input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: var(--accent);
	}

	.play {
		flex: 0 0 auto;
		justify-content: center;
	}

	.slider-time {
		margin: 4px 0 0;
		font-variant-numeric: tabular-nums;
	}

	.file-hidden {
		display: none;
	}
</style>
