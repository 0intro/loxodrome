<script lang="ts">
	/* The flights library surface: the recorded outings as a carnet-shaped
	 * table, one row per FLIGHT. A logbook LOOK, deliberately not a logbook
	 * (docs/flights-library.md): the pilot-declared columns are absent and
	 * the footer sums are check-sums of exactly the rows on screen, named
	 * with the period in force. Rows come straight off the stored
	 * derivations; the actions load an outing into the existing replay,
	 * export its trace, or delete it. */
	import SurfaceShell from './SurfaceShell.svelte';
	import PageTabs from './PageTabs.svelte';
	import PlansView from './flights/PlansView.svelte';
	import Icon from './Icon.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { t } from '$lib/state/i18n.svelte';
	import { flightsModal, closeFlights, type FlightsPage } from '$lib/state/flightsModal.svelte';
	import {
		archiveCurrentOuting,
		clearArchiveError,
		DERIVED_V,
		flightLibrary,
		outingPoints,
		refreshList,
		removeOuting,
		summaryDeps,
		type OutingMeta,
	} from '$lib/state/flightLibrary.svelte';
	import {
		flightYear,
		routeCellTokens,
		totalsOfFlights,
	} from '$lib/state/flightRows';
	import {
		hm,
		isoDateUtc,
		summarizeFlights,
		type FlightSummary,
	} from '$lib/nav/logbook';
	import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
	import { fmtClockUtc } from '$lib/route/format';
	import { clearTrace, nav, restoreOuting, traceAltDatum } from '$lib/state/navRecording.svelte';
	import { signedIn } from '$lib/state/account.svelte';
	import { fetchOutingOnDemand } from '$lib/state/sync.svelte';
	import { loadRoutesFromYaml, routeLoad } from '$lib/state/routeLoad.svelte';
	import { fitRoute } from './tabs/route/fitRoute';
	import {
		clearImportNotices,
		flightImport,
		runImport,
		expandPick,
		runImportTexts,
		type ImportNotice,
		type NamedText,
	} from '$lib/state/flightImport.svelte';
	import { isNativeApp } from '$lib/native/platform';
	import { bytesOfIncoming, pickIncomingFiles } from '$lib/native/openFile';
	import { ensureLinks, flightLinks } from '$lib/state/flightLinks.svelte';
	import {
		activePlan,
		activePlanDirty,
		hasStorableWorkspace,
		setActivePlanSource,
		storePlanAs,
	} from '$lib/state/activePlan.svelte';
	import { clearAllRoutes } from '$lib/state/route.svelte';
	import { pickerAccept } from '$lib/ui/filePicker';
	import { refreshPlans } from '$lib/state/planCatalog.svelte';
	import { getStoredPlans } from '$lib/state/flightsDb';
	import { buildZipDeflated } from '$lib/files/zip';
	import { TRACE_FORMAT_LABEL } from '$lib/nav/traceExport';
	import { APP_SUBJECT, fileName, fileStampUtc } from '$lib/files/fileName';
	import { appPrintStem } from '$lib/state/printName';
	import {
		buildFlightBundle,
		buildLibraryCsv,
		buildPlanEntries,
		buildTraceEntries,
		bundleFileName,
	} from '$lib/state/flightExport';
	import { traceFileFor } from '$lib/state/traceFile';
	import { getTraceSource } from '$lib/state/flightsDb';
	import { display } from '$lib/state/display.svelte';
	import { downloadBlob } from '$lib/ui/dom';
	import HeadOverlay from './HeadOverlay.svelte';
	import { printSurface } from '$lib/ui/surfacePrint.svelte';
	import { aircraftState } from '$lib/state/aircraft.svelte';
	import { useTracePreview } from './mapPreview.svelte';

	const open = $derived(flightsModal.open);

	/* The surface's two views: the flights table and the plan catalog. The
	 * view lives in the state module since the route-actions menu deep-links
	 * to Plans (openFlights('plans')); this component only renders it. */
	const PAGES: { id: FlightsPage; icon: string }[] = [
		{ id: 'flights', icon: 'list' },
		{ id: 'plans', icon: 'route' },
	];

	function pageLabel(id: FlightsPage): string {
		return id === 'flights' ? t.flights.viewFlights : t.flights.viewPlans;
	}

	// Hovering a flight row ghosts its trace on the map (mapPreview
	// doctrine: desktop, dock-right only). The liveness thunk reads the
	// view so switching to Plans under a resting pointer clears it.
	const tracePreview = useTracePreview(() => open && flightsModal.view === 'flights');

	$effect(() => {
		if (open) {
			void refreshList();
			// The dynamic links: serve the cached ones, recompute the stale
			// (a catalog change since last time invalidates them wholesale).
			void ensureLinks();
		}
	});

	// Isolate the surface for printing, the NavLogModal idiom: while open,
	// tag <html> so the print stylesheet drops the app behind the portaled
	// box. Without it the sidebar, the toolbar and the map printed ahead of
	// the table, and #app keeps height:100dvh even hidden, which is a blank
	// leading sheet. Scoped under the class, so a normal Ctrl+P with the
	// surface closed still prints the app.
	$effect(() => {
		const el = document.documentElement;
		if (open) {
			el.classList.add('flights-print');
		} else {
			el.classList.remove('flights-print');
		}
		return () => el.classList.remove('flights-print');
	});

	// Re-lists when the view opens AND after an import lands new plans
	// (reading flightImport.running is deliberate); the plain-let guard
	// inside refreshPlans prevents the listing loop.
	$effect(() => {
		if (open && flightsModal.view === 'plans' && !flightImport.running) {
			void refreshPlans();
		}
	});

	interface FlightRow {
		meta: OutingMeta;
		f: FlightSummary;
		head: boolean;
		grouped: boolean;
		/** The LIVE outing's transient rows (a recording underway):
		 *  'recording' before any committed takeoff (the desk / taxi-out
		 *  state, where there is no flight to summarize yet), 'flight'
		 *  once airborne. */
		live?: 'recording' | 'flight';
	}

	/** The row's display labels: a logbook row's own frozen remark, a
	 *  trace row's DYNAMIC link (state/flightLinks; empty until the
	 *  background pass lands). */
	function labelsOf(meta: OutingMeta): string[] {
		if (meta.source === 'logbook') {
			return meta.remarks !== '' ? [meta.remarks] : [];
		}
		return flightLinks.byOuting[meta.id]?.labels ?? [];
	}

	/** The trace row's dynamically linked catalog plan, null while
	 *  unlinked or uncomputed. */
	function linkedPlanId(meta: OutingMeta): string | null {
		return meta.source === 'trace' ? (flightLinks.byOuting[meta.id]?.planId ?? null) : null;
	}

	/* The period scope: '' = every flight, else a UTC year. Session-only
	 * (the routePersist doctrine for view state), and the ONE thing that
	 * makes the footer sums mean something: a carnet is totalled per page,
	 * per year, never over a whole life. The options are the years the
	 * library actually holds, newest first. */
	let scope = $state('');
	const years = $derived.by(() => {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index
		const seen = new Set<string>();
		for (const meta of flightLibrary.rows) {
			for (const f of meta.flights) {
				seen.add(flightYear(f));
			}
		}
		return [...seen].sort().reverse();
	});
	/* A year that has just lost its last flight (a delete) must not leave
	 * the table empty behind a scope nothing can reach. */
	const scopeInForce = $derived(scope !== '' && years.includes(scope) ? scope : '');

	// One flat row per flight (the AMC line unit): outings newest first, each
	// outing's flights in their own order, narrowed to the period in force.
	// A multi-flight outing's rows are GROUPED: the trace-level actions sit
	// on the head row only, and the continuation rows dim their repeated
	// date. head / grouped are computed over the SURVIVING flights, so a
	// scope that cuts a trace still leaves its rows one usable group.
	const rows = $derived.by(() => {
		const out: FlightRow[] = [];
		for (const meta of flightLibrary.rows) {
			const kept = meta.flights.filter(
				(f) => scopeInForce === '' || flightYear(f) === scopeInForce,
			);
			kept.forEach((f, i) => {
				out.push({ meta, f, head: i === 0, grouped: kept.length > 1 });
			});
		}
		return out;
	});

	// The LIVE outing while a recording runs: the flight files itself when
	// the recording completes (the stop hook), and meanwhile the table
	// shows it derived from the live points exactly as the archive will,
	// its open flight wearing the "in flight" chip. Before any committed
	// takeoff (the desk test, the taxi out) there is no flight to
	// summarize, so ONE placeholder row stands in with the "recording"
	// chip: the recording must be visible the moment it runs. Gated on
	// the surface being open, so the per-fix recompute never runs in the
	// background.
	const liveRows = $derived.by((): FlightRow[] => {
		if (!open || !nav.recording || nav.points.length === 0) {
			return [];
		}
		const pts = $state.snapshot(nav.points);
		const motion = extendMotion(newMotionFold(), pts);
		const datum = traceAltDatum();
		const deps = summaryDeps(datum);
		const flights =
			motion.takeoffMs != null ? summarizeFlights(pts, motion, deps) : [];
		if (flights.length === 0) {
			const startMs = motion.firstMoveMs ?? pts[0].timeMs;
			flights.push({
				blockOffMs: startMs,
				takeoffMs: startMs,
				landingMs: null,
				blockOnMs: null,
				distanceNM: 0,
				depPlace: deps.placeIdentAt(pts[0].lat, pts[0].lon),
				arrPlace: '',
				landingsDay: null,
				landingsNight: null,
				nightMin: null,
				touchPlaces: [],
			});
		}
		const meta: OutingMeta = {
			id: pts[0].timeMs,
			savedAtMs: 0,
			datum,
			aircraftKey: aircraftState.selectedKey,
			remarks: '',
			source: 'trace',
			derivedV: DERIVED_V,
			flights,
		};
		const airborne = motion.takeoffMs != null;
		return flights.map((f, i) => ({
			meta,
			f,
			head: i === 0,
			grouped: flights.length > 1,
			live: airborne ? ('flight' as const) : ('recording' as const),
		}));
	});
	const allRows = $derived([...liveRows, ...rows]);

	/* Trace rows applied meta-only by sync (no flights derived because no
	 * points landed): invisible in the table until their blob is fetched.
	 * A REAL local trace never files without a flight, so zero flights on
	 * a trace row is precisely the sync stub. */
	const traceStubs = $derived(
		flightLibrary.rows.filter((r) => r.source === 'trace' && r.flights.length === 0),
	);
	let fetchingStubs = $state(false);
	async function fetchStubs(): Promise<void> {
		fetchingStubs = true;
		try {
			// Newest first; each landing re-derives and surfaces its rows.
			for (const stub of [...traceStubs].sort((a, b) => b.id - a.id)) {
				await fetchOutingOnDemand(stub.id);
			}
		} finally {
			fetchingStubs = false;
		}
	}
	// Over the STORED rows the table lists, never the live ones: nothing is
	// recorded yet while a recording runs, and a sum that moved every second
	// would not be a check-sum.
	const totals = $derived(totalsOfFlights(rows.map((r) => r.f)));
	const totalsScope = $derived(scopeInForce === '' ? t.flights.scopeAllShort : scopeInForce);

	// Whether the LOADED trace is worth adding by hand (the imports path; a
	// recording adds itself). Reads nav.recording first, so the per-fix
	// point appends never invalidate this while one runs.
	const canFile = $derived.by(() => {
		if (nav.recording || nav.points.length === 0) {
			return false;
		}
		return extendMotion(newMotionFold(), $state.snapshot(nav.points)).takeoffMs != null;
	});

	/* What the manual add did, worded at render (the RouteTab sendNotice
	 * idiom): a store that says nothing reads as a store that failed, and
	 * this one is idempotent, so even a success is invisible in the table
	 * when the trace was already there. */
	let addNotice = $state<'done' | 'noFlight' | null>(null);

	async function onAddTrace(): Promise<void> {
		addNotice = null;
		const out = await archiveCurrentOuting();
		// A write failure has its own banner (flightLibrary.archiveError),
		// which says more than this line could.
		addNotice = out.kind === 'archived' ? 'done' : out.kind === 'failed' ? null : 'noFlight';
	}

	/* The cockpit-confirm object (the NavigationTab ask idiom). */
	let confirm = $state<{ message: string; label: string; run: () => void } | null>(null);

	function ask(message: string, label: string, run: () => void): void {
		confirm = { message, label, run };
	}

	/* The plan-restore failure, raw upstream detail (worded at render). */
	let planError = $state<string | null>(null);

	// The catalog header's "Store as new flight plan": the discoverable
	// twin of the route-actions menu entry (the reported gap: modify,
	// then choose store-back OR a new entry). Success shows itself (the
	// new row appears with the active highlight); failures reuse the
	// plan-error line.
	let storingAs = $state(false);
	let storeAsError = $state<string | null>(null);
	const hasStorableRoute = $derived(hasStorableWorkspace());

	async function onStoreAsNew(): Promise<void> {
		storingAs = true;
		storeAsError = null;
		try {
			const out = await storePlanAs();
			if (out.kind === 'failed') {
				storeAsError = out.detail;
			} else if (out.kind === 'stored') {
				void ensureLinks();
			}
		} finally {
			storingAs = false;
		}
	}

	/* A row whose points are gone (a partial wipe, an evicted store): the
	 * three actions that need them say so instead of doing nothing. */
	let pointsError = $state(false);

	async function loadIntoReplay(meta: OutingMeta): Promise<void> {
		const points = await outingPoints(meta.id);
		if (!points) {
			pointsError = true;
			return;
		}
		pointsError = false;
		// Its own file too, when it has one: the Navigation tab exports the
		// loaded trace, and it must write the same document this row does.
		// A store that will not answer is not worth failing a replay over.
		restoreOuting(points, meta.datum, await getTraceSource(meta.id).catch(() => null) ?? undefined);
	}

	/** Restore the outing WITH its dynamically linked plan: the CURRENT
	 *  catalog version, always (there is no stored copy to resurrect; the
	 *  link is the matcher's own answer against today's catalog). The
	 *  points load first and bail on null (never replace the workspace
	 *  for a trace that cannot load); a failed or vanished plan still
	 *  restores the trace, the primary object. */
	async function loadWithPlan(meta: OutingMeta): Promise<void> {
		const points = await outingPoints(meta.id);
		if (!points) {
			pointsError = true;
			return;
		}
		pointsError = false;
		const planId = linkedPlanId(meta);
		const entry =
			planId != null ? (await getStoredPlans()).find((pl) => pl.id === planId) : undefined;
		const ok =
			entry != null &&
			(await loadRoutesFromYaml(entry.yaml, { id: entry.id, savedAtMs: entry.savedAtMs }));
		// Its own file too, when it has one: the Navigation tab exports the
		// loaded trace, and it must write the same document this row does.
		// A store that will not answer is not worth failing a replay over.
		restoreOuting(points, meta.datum, await getTraceSource(meta.id).catch(() => null) ?? undefined);
		if (ok) {
			planError = null;
			fitRoute();
		} else if (entry != null) {
			planError = routeLoad.error;
		}
	}

	/** Shared guard of both load actions: never under a recording, and a
	 *  loaded trace the library does not hold (no committed takeoff, so it
	 *  never filed) is lost by replacing it: ask first. A filed one
	 *  replaces silently. */
	function guardedLoad(run: () => void): void {
		if (nav.recording) {
			return;
		}
		if (nav.points.length > 0 && !canFile) {
			ask(t.navigation.replaceConfirm, t.navigation.replaceConfirmAction, run);
			return;
		}
		run();
	}

	// The outing currently loaded in the navigation workspace: its row's
	// replay button wears the pressed look and TOGGLES the trace back out
	// (the catalog Activate idiom; the stored row stays, one click reloads).
	const loadedOutingId = $derived(
		!nav.recording && nav.points.length > 0 ? nav.points[0].timeMs : null,
	);

	function onLoad(meta: OutingMeta): void {
		if (meta.id === loadedOutingId) {
			clearTrace();
			return;
		}
		guardedLoad(() => void loadIntoReplay(meta));
	}

	/** Whether this row's trace AND its linked plan are what the
	 *  navigation workspace currently holds: the open-with-plan button's
	 *  pressed state, and its toggle-off condition. */
	function rowFullyOpen(meta: OutingMeta): boolean {
		const pid = linkedPlanId(meta);
		return meta.id === loadedOutingId && pid != null && activePlan.source?.id === pid;
	}

	function onLoadWithPlan(meta: OutingMeta): void {
		if (rowFullyOpen(meta)) {
			// The toggle face (the catalog Activate idiom): clear the trace
			// AND the plan back out; unstored plan edits ask first.
			const clearBoth = (): void => {
				clearTrace();
				clearAllRoutes();
				setActivePlanSource(null);
			};
			if (activePlanDirty()) {
				ask(t.flights.deactivateDirtyConfirm, t.flights.deactivateAction, clearBoth);
				return;
			}
			clearBoth();
			return;
		}
		guardedLoad(() => void loadWithPlan(meta));
	}

	/* The row and header export labels no longer NAME a format, and cannot:
	 * an imported trace goes back out as the file it arrived as, so a library
	 * holding one GPX import and one recording exports both at once in
	 * different formats (docs/trace-files.md). The format in force is stated
	 * where it is chosen and where it is true, the Settings tab, and each
	 * downloaded file states its own in its name. While the convert
	 * preference is ON there IS one answer again, so the labels say it. */
	const exportFormat = $derived(
		display.convertImportedTraces ? TRACE_FORMAT_LABEL[display.traceExportFormat] : null,
	);

	async function onExportTrace(meta: OutingMeta): Promise<void> {
		const file = await traceFileFor(meta);
		if (!file) {
			pointsError = true;
			return;
		}
		pointsError = false;
		downloadBlob(
			typeof file.data === 'string'
				? file.data
				: new Blob([file.data as BlobPart], { type: file.mime }),
			file.filename,
			file.mime,
		);
	}

	/** Every filed trace as its own file in one ZIP, each in ITS OWN format
	 *  (state/traceFile.ts): an imported file rides back out byte for byte,
	 *  a recording is synthesised, so one archive mixes GPX, IGC and KML. */
	async function onExportTracesZip(): Promise<void> {
		const entries = await buildTraceEntries();
		if (entries.length === 0) {
			exportEmpty = true;
			return;
		}
		exportEmpty = false;
		downloadBlob(
			new Blob([await buildZipDeflated(entries)], { type: 'application/zip' }),
			fileName([APP_SUBJECT, 'traces', fileStampUtc(Date.now())], 'zip'),
			'application/zip',
		);
	}

	/** The whole library in one file: the traces, the logbook CSV, the
	 *  remembered plans and the user's own aircraft sheets. The one gesture
	 *  that moves a flight library between a desktop and a phone
	 *  (docs/flights-library.md). */
	async function onExportBundle(): Promise<void> {
		const entries = await buildFlightBundle();
		if (entries.length === 0) {
			exportEmpty = true;
			return;
		}
		exportEmpty = false;
		const at = Date.now();
		downloadBlob(
			new Blob([await buildZipDeflated(entries)], { type: 'application/zip' }),
			bundleFileName(at),
			'application/zip',
		);
	}

	/** Every remembered plan in one ZIP. File names are GENERATED from
	 *  each plan's route (its identity), deduped inside the archive with
	 *  the nextPlanName suffix. */
	async function onExportPlansZip(): Promise<void> {
		const entries = await buildPlanEntries();
		if (entries.length === 0) {
			exportEmpty = true;
			return;
		}
		exportEmpty = false;
		downloadBlob(
			new Blob([await buildZipDeflated(entries)], { type: 'application/zip' }),
			fileName([APP_SUBJECT, 'plans', fileStampUtc(Date.now())], 'zip'),
			'application/zip',
		);
	}

	/* An export that produced no file says so: the counts a button can
	 * cheaply test (rows exist) and what an export actually yields (rows
	 * with POINTS, in this view) are not the same thing, and a download
	 * that silently does not happen reads as a broken button. */
	let exportEmpty = $state(false);

	/* And an export that THREW says so too. Emptiness was reported and
	 * failure was not, so a store that would not answer, or a bundle too
	 * large to assemble in one buffer on a phone, closed the menu and did
	 * nothing at all: exactly the dead-button symptom this surface fixed on
	 * the way in. Every export goes through here. */
	let exportError = $state<string | null>(null);

	async function runExport(job: () => Promise<void>): Promise<void> {
		exportError = null;
		try {
			await job();
		} catch (err) {
			exportError = err instanceof Error ? err.message : String(err);
		}
	}

	function onDelete(meta: OutingMeta): void {
		ask(t.flights.deleteConfirm, t.flights.deleteConfirmAction, () => void removeOuting(meta.id));
	}

	let importInput: HTMLInputElement | undefined;

	/* The WebView's own chooser is not usable on every Android: on a device
	 * whose chooser is not the AOSP one it hands back nothing, or never opens
	 * at all, and the button looks broken (measured on a MIUI phone, where
	 * "Open with" works and this input did nothing). Every other picker in the
	 * app already asks the plugin instead; this one is the batch importer, so
	 * it asks for SEVERAL files and feeds them straight to the run - a route
	 * file here is a remembered plan, which is not what the dispatcher would
	 * do with it. docs/android.md. */
	async function onImportClick(): Promise<void> {
		if (!isNativeApp()) {
			importInput?.click();
			return;
		}
		const picked = await pickIncomingFiles();
		const items: NamedText[] = [];
		const unreadable: { name: string; detail: string }[] = [];
		for (const f of picked) {
			// Each file is guarded on its own: one unreadable archive in a
			// batch used to reject the whole handler, and a picker that
			// silently does nothing is how the WebView chooser failed before
			// this path existed at all (docs/android.md).
			try {
				const bytes = await bytesOfIncoming(f);
				// A binary file (a KMZ, a bundle) rides as bytes; a bundle
				// expands into the files it carries.
				items.push(...(bytes ? await expandPick(f.name, bytes) : [{ name: f.name, text: f.text }]));
			} catch (err) {
				unreadable.push({ name: f.name, detail: err instanceof Error ? err.message : String(err) });
			}
		}
		if (items.length + unreadable.length > 0) {
			await runImportTexts(items, unreadable);
		}
	}

	async function onImportPick(e: Event): Promise<void> {
		const input = e.target as HTMLInputElement;
		const files = input.files ? [...input.files] : [];
		if (files.length === 0) {
			return;
		}
		await runImport(files);
		// Cleared only once every file has been read, so the same batch can
		// be re-picked without the clearing racing a read still in flight.
		input.value = '';
	}

	function noticeText(n: ImportNotice): string {
		switch (n.code) {
			case 'noTakeoff':
				return t.flights.importNoTakeoff(n.name);
			case 'noClock':
				return t.flights.importNoClock(n.name);
			case 'invalid':
				return t.flights.importInvalid(n.name, n.params[0] ?? '');
			case 'storeFailed':
				return t.flights.importStoreFailed(n.name, n.params[0] ?? '');
			case 'unsupported':
				return t.flights.importUnsupported(n.name);
			case 'datumDeclined':
				return t.flights.importDatumDeclined(n.name);
			case 'plansSaved':
				return t.flights.importPlansSaved(n.params[0] ?? '0');
			case 'aircraftAdded':
				return t.flights.importAircraftAdded(n.params[0] ?? '0', n.params[1] ?? '0');
			case 'aircraftKept':
				return t.flights.importAircraftKept(n.params[0] ?? '0');
			case 'aircraftNotSaved':
				return t.flights.importAircraftNotSaved(n.params[0] ?? '0');
			case 'planUnusable':
				return t.flights.importPlanUnusable(n.name);
			case 'logbook':
				return t.flights.importLogbook(n.name, n.params[0] ?? '', n.params[1] ?? '');
		}
	}

	/** The AMC CSV over every flight in the library, decorated at export
	 *  time (the library stores no record semantics: make / registration /
	 *  pilot are resolved now, docs/logbook.md). Deliberately NOT narrowed
	 *  by the period scope: that is a reading of the table, and the button
	 *  says "all". */
	async function onExportCsv(): Promise<void> {
		const csv = await buildLibraryCsv();
		if (csv == null) {
			exportEmpty = true;
			return;
		}
		exportEmpty = false;
		downloadBlob(
			csv.text,
			fileName([APP_SUBJECT, 'logbook', fileStampUtc(csv.atMs)], 'csv'),
			'text/csv',
		);
	}

	/* The header's export / print menu (the route-actions menu idiom):
	 * four actions that were four unlabelled icons, which on a touch
	 * screen is four unlabelled icons with no tooltip to explain them.
	 * HeadOverlay gives the anchored popup on a pointer, the bottom sheet
	 * on a phone, Escape and the system Back, and its .item rows carry the
	 * 44 px touch floor from app.css. */
	let menuOpen = $state(false);
	let menuAnchor = $state({ x: 0, y: 0 });

	function openMenu(e: MouseEvent): void {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		menuAnchor = { x: r.left, y: r.bottom + 4 };
		menuOpen = true;
	}

	function fromMenu(run: () => void): void {
		menuOpen = false;
		run();
	}
</script>

<SurfaceShell
	id="flights"
	onClose={closeFlights}
	label={t.flights.title}
	boxClass="flights-box print-palette"
	pageCss={() => '@media print { @page { size: A4 landscape; margin: 10mm; } }'}
	printName={() => appPrintStem('flights', Date.now())}
>
	{#snippet header()}
		<h2>{t.flights.title}</h2>
		<PageTabs
			pages={PAGES}
			current={flightsModal.view}
			onSelect={(id: FlightsPage) => {
				flightsModal.view = id;
				tracePreview.set(null);
			}}
			ariaLabel={t.flights.viewsAria}
			labelFor={pageLabel}
		/>
		{#if flightsModal.view === 'flights'}
			<button
				class="modal-close no-print"
				title={t.flights.addTraceTip}
				aria-label={t.flights.addTrace}
				disabled={!canFile}
				onclick={() => void onAddTrace()}
			>
				<Icon name="plus" />
			</button>
		{/if}
		<button
			class="modal-close no-print"
			title={t.flights.importAllTip}
			aria-label={t.flights.importAll}
			disabled={flightImport.running}
			onclick={() => void onImportClick()}
		>
			<Icon name="download" />
		</button>
		{#if flightsModal.view === 'plans'}
			<button
				class="modal-close no-print"
				title={t.route.storePlanAsTip}
				aria-label={t.route.storePlanAs}
				disabled={!hasStorableRoute || storingAs}
				onclick={() => void onStoreAsNew()}
			>
				<Icon name="save" />
			</button>
		{/if}
		<!-- Disclosure, not a menu (the rule Toolbar.svelte states): the popup
		     is a plain stack of buttons with no menu keyboard model, and
		     claiming one had a screen reader promise arrow-key navigation
		     that does nothing. -->
		<button
			class="modal-close no-print"
			title={t.flights.exportMenu}
			aria-label={t.flights.exportMenu}
			aria-expanded={menuOpen}
			onclick={openMenu}
		>
			<Icon name="upload" />
		</button>
	{/snippet}

	<div class="body">
		<input
			bind:this={importInput}
			class="file-input"
			type="file"
			multiple
			accept={pickerAccept(
				'.gpx,.igc,.kml,.kmz,.zip,.yaml,.yml,.csv,application/gpx+xml,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip,text/yaml,text/csv',
			)}
			aria-hidden="true"
			tabindex="-1"
			onchange={(e) => void onImportPick(e)}
		/>
		<!-- Progress, outcomes and failures announce themselves: they appear
		     under a pointer that is somewhere else entirely, and the import is
		     the one action here that takes long enough to look away from. -->
		{#if flightImport.running}
			<p class="muted no-print" role="status">
				{t.flights.importProgress(String(flightImport.done), String(flightImport.total))}
			</p>
		{/if}
		{#if flightImport.notices.length > 0}
			<div class="import-notices no-print" role="status">
				<ul>
					{#each flightImport.notices as n, i (i)}
						<li>{noticeText(n)}</li>
					{/each}
				</ul>
				{#if !flightImport.running}
					<button class="icon-btn" aria-label={t.common.close} onclick={clearImportNotices}>
						<Icon name="x" size={12} />
					</button>
				{/if}
			</div>
		{/if}
		<!-- The one failure nobody may swallow: a real flight the store would
		     not take. It stands until dismissed, because the recording that
		     produced it is still loaded and can still be saved. -->
		{#if traceStubs.length > 0 && signedIn()}
			<!-- Synced rows whose trace blob was never fetched here (the
			     shared-mode lazy posture, docs/accounts-sync.md): the rows
			     appear as each trace lands and re-derives. -->
			<p class="muted no-print" role="status">
				{t.account.tracesToFetch(traceStubs.length)}
				<button class="btn no-print" disabled={fetchingStubs} onclick={() => void fetchStubs()}>
					{t.account.fetchTrace}
				</button>
			</p>
		{/if}
		{#if flightLibrary.archiveError != null}
			<p class="plan-error no-print" role="alert">
				{t.flights.archiveFailed(flightLibrary.archiveError)}
				<button class="icon-btn" aria-label={t.common.close} onclick={clearArchiveError}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if addNotice != null}
			<p class="muted no-print" role="status">
				{addNotice === 'done' ? t.flights.addTraceDone : t.flights.addTraceNoFlight}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (addNotice = null)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if pointsError}
			<p class="plan-error no-print" role="alert">
				{t.flights.pointsMissing}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (pointsError = false)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if exportError}
			<p class="pp-error no-print" role="alert">
				{t.flights.exportFailed(exportError)}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (exportError = null)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if exportEmpty}
			<p class="muted no-print" role="status">
				{t.flights.exportNothing}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (exportEmpty = false)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if planError != null}
			<p class="plan-error no-print" role="alert">
				{t.flights.openWithPlanFailed(planError)}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (planError = null)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if storeAsError != null}
			<p class="plan-error no-print" role="alert">
				{t.flights.storeFailed(storeAsError)}
				<button class="icon-btn" aria-label={t.common.close} onclick={() => (storeAsError = null)}>
					<Icon name="x" size={12} />
				</button>
			</p>
		{/if}
		{#if flightsModal.view === 'plans'}
			<PlansView {ask} />
		{:else if allRows.length === 0}
			<p class="muted">{flightLibrary.loading ? t.flights.loading : t.flights.empty}</p>
		{:else}
			<!-- The period the table (and its check-sums, and the printed
			     sheet) covers. Two options are no choice, so the control
			     appears only once the library spans several years. -->
			{#if years.length > 1}
				<div class="scope no-print">
					<label for="flights-scope">{t.flights.scopeLabel}</label>
					<select id="flights-scope" bind:value={scope}>
						<option value="">{t.flights.scopeAll}</option>
						{#each years as y (y)}
							<option value={y}>{y}</option>
						{/each}
					</select>
				</div>
			{/if}
			<div class="table-wrap">
				<table>
					<!-- PAPER only: the sheet has to state its own scope, since
					     the period control does not print and a one-year page
					     would otherwise read as the whole library. On screen the
					     control and the footer already say it twice. -->
					<caption>{t.flights.totalsLabel(totalsScope)}</caption>
					<thead>
						<tr>
							<th scope="col">{t.flights.colDate}</th>
							<th scope="col">{t.flights.colDeparture}</th>
							<th scope="col">{t.flights.colArrival}</th>
							<th scope="col" class="num" title={t.flights.colTotalTip}>{t.flights.colTotal}</th>
							<th scope="col" class="num" title={t.flights.colLandingsTip}
								>{t.flights.colLandings}</th
							>
							<th scope="col" class="num">{t.flights.colNight}</th>
							<th scope="col">{t.flights.colRoute}</th>
							<th class="no-print"></th>
						</tr>
					</thead>
					<tbody>
						{#each allRows as r (`${r.meta.id}:${r.f.takeoffMs}`)}
							{@const nightLdg = r.f.landingsNight ?? 0}
							{@const loaded =
								!r.live && r.meta.source !== 'logbook' && r.meta.id === loadedOutingId}
							{@const labels = labelsOf(r.meta)}
							<tr
								aria-current={loaded ? 'true' : undefined}
								class:grp={r.grouped}
								class:cont={!r.head}
								class:live={r.live}
								class:loaded
								data-outing-id={r.meta.id}
								onmouseenter={() =>
									tracePreview.set(
										r.live || r.meta.source === 'logbook'
											? null
											: { id: r.meta.id, savedAtMs: r.meta.savedAtMs },
									)}
								onmouseleave={() => tracePreview.set(null)}
							>
								<td
									class="date"
									class:dim={!r.head}
									title={r.head ? undefined : t.flights.sameOuting}>{isoDateUtc(r.f.blockOffMs)}</td
								>
								<td>
									{r.f.depPlace}
									<span class="clock">{fmtClockUtc(r.f.blockOffMs)}Z</span>
								</td>
								<td>
									{#if r.f.blockOnMs != null}
										{r.f.arrPlace}
										<span class="clock">{fmtClockUtc(r.f.blockOnMs)}Z</span>
									{:else if r.live}
										<span
											class="live-chip"
											title={r.live === 'flight' ? t.flights.inFlightTip : t.flights.recordingChipTip}
											>{r.live === 'flight' ? t.flights.inFlight : t.flights.recordingChip}</span
										>
									{:else}
										<span class="muted">—</span>
									{/if}
								</td>
								<td class="num"
									>{hm(
										r.f.blockOnMs != null ? (r.f.blockOnMs - r.f.blockOffMs) / 60_000 : null,
									)}</td
								>
								<td class="num">
									<!-- The space is explicit: Svelte trims the newline
									     opening an {#if}, and "3(1 night)" ran together
									     on screen and on the sheet alike. -->
									{(r.f.landingsDay ?? 0) + nightLdg}{#if nightLdg > 0}&nbsp;({t.navigation.landingsNight(
											String(nightLdg),
										)}){/if}
								</td>
								<td class="num">{(r.f.nightMin ?? 0) > 0 ? hm(r.f.nightMin) : ''}</td>
								<td
									class="route"
									title={labels.length > 0 ? labels.join(' / ') : undefined}
									>{#each routeCellTokens(labels, r.meta, r.f) as tok, i (i)}{#if tok.touched}<span
												class="td-touch"
												title={t.flights.touchedTip}>{tok.text}</span
											>{:else}{tok.text}{/if}{/each}</td
								>
								<td class="actions no-print">
									{#if !r.live && r.meta.source !== 'logbook' && r.head}
										<button
											class="icon-btn"
											class:on={loaded}
											title={nav.recording
												? t.flights.loadBusy
												: loaded
													? t.flights.unloadTrace
													: t.flights.load}
											aria-label={loaded ? t.flights.unloadTrace : t.flights.load}
											aria-pressed={loaded}
											disabled={nav.recording}
											onclick={() => onLoad(r.meta)}
										>
											<Icon name="play" size={13} />
										</button>
										{#if linkedPlanId(r.meta) != null}
											{@const fullyOpen = rowFullyOpen(r.meta)}
											<button
												class="icon-btn"
												class:on={fullyOpen}
												title={nav.recording
													? t.flights.loadBusy
													: fullyOpen
														? t.flights.unloadTraceWithPlan
														: t.flights.openWithPlan}
												aria-label={fullyOpen
													? t.flights.unloadTraceWithPlan
													: t.flights.openWithPlan}
												aria-pressed={fullyOpen}
												disabled={nav.recording}
												onclick={() => onLoadWithPlan(r.meta)}
											>
												<Icon name="route" size={13} />
											</button>
										{/if}
										<button
											class="icon-btn"
											title={exportFormat
												? t.navigation.exportTrace(exportFormat)
												: t.navigation.exportTraceOwn}
											aria-label={exportFormat
												? t.navigation.exportTrace(exportFormat)
												: t.navigation.exportTraceOwn}
											onclick={() => void onExportTrace(r.meta)}
										>
											<Icon name="upload" size={13} />
										</button>
									{/if}
									{#if !r.live && r.head}
										<button
											class="icon-btn"
											title={t.flights.deleteRow}
											aria-label={t.flights.deleteRow}
											onclick={() => onDelete(r.meta)}
										>
											<Icon name="trash" size={13} />
										</button>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
					<tfoot>
						<tr>
							<td colspan="3">{t.flights.totalsLabel(totalsScope)}</td>
							<td class="num">{hm(totals.totalMin)}</td>
							<td class="num">
								{totals.landings}{#if totals.nightLandings > 0}&nbsp;({t.navigation.landingsNight(
										String(totals.nightLandings),
									)}){/if}
							</td>
							<td class="num">{totals.nightMin > 0 ? hm(totals.nightMin) : ''}</td>
							<td></td>
							<td class="no-print"></td>
						</tr>
					</tfoot>
				</table>
			</div>
		{/if}
	</div>
</SurfaceShell>

<!-- The export / print menu: one labelled row per action, so a touch
     screen (where no tooltip ever appears) reads them all. The rows the
     view cannot serve are simply absent, which is why nothing here is
     disabled: an export button whose count and whose real output differ
     was how the enabled-but-silent exports happened. -->
<HeadOverlay
	open={menuOpen}
	x={menuAnchor.x}
	y={menuAnchor.y}
	title={t.flights.exportMenu}
	minWidthPx={240}
	surface="flights"
	onClose={() => (menuOpen = false)}
>
	<!-- Above the view split, like the import button facing it: the bundle is
	     the WHOLE library, the plans included, so which view happens to be up
	     does not change what it writes. Everything below it IS the view's own
	     artefact. -->
	<button
		class="item"
		title={t.flights.exportBundleTip}
		onclick={() => fromMenu(() => void runExport(onExportBundle))}
	>
		<Icon name="archive" size={14} />
		{t.flights.exportBundle}
	</button>
	{#if flightsModal.view === 'flights'}
		<button
			class="item"
			title={t.flights.exportCsvAllTip}
			onclick={() => fromMenu(() => void runExport(onExportCsv))}
		>
			<Icon name="file-text" size={14} />
			{t.flights.exportCsvAll}
		</button>
		<button
			class="item"
			title={exportFormat
				? t.flights.exportTracesZipTip(exportFormat)
				: t.flights.exportTracesZipTipOwn}
			onclick={() => fromMenu(() => void runExport(onExportTracesZip))}
		>
			<Icon name="upload" size={14} />
			{exportFormat ? t.flights.exportTracesZip(exportFormat) : t.flights.exportTracesZipOwn}
		</button>
		<button class="item" onclick={() => fromMenu(() => void printSurface('flights'))}>
			<Icon name="printer" size={14} />
			{t.route.print}
		</button>
	{:else}
		<button
			class="item"
			title={t.flights.exportPlansZipTip}
			onclick={() => fromMenu(() => void runExport(onExportPlansZip))}
		>
			<Icon name="upload" size={14} />
			{t.flights.exportPlansZip}
		</button>
	{/if}
</HeadOverlay>

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
	:global(.flights-box) {
		--modal-width: min(1100px, 96vw);
	}

	h2 {
		margin: 0;
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
	}

	.modal-close:disabled {
		opacity: 0.5;
		cursor: default;
	}

	/* The in-flight touch floor applies to the HEADER too: these are the
	   surface's own actions, and 32 px is not a target with gloves on. */
	:global(:root.touch-ui) .modal-close {
		width: 44px;
		height: 44px;
	}

	.scope {
		display: flex;
		gap: 6px;
		align-items: center;
		margin: 0 0 8px;
		font-size: 12px;
		color: var(--text-muted);
	}

	caption {
		display: none;
	}

	.body {
		flex: 1;
		padding: 16px;
		overflow: auto;
	}

	.plan-error {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0 0 10px;
		font-size: 12px;
		color: var(--danger);
	}

	/* The RouteTab picker idiom: present for the chooser, visually gone. */
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

	.import-notices {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: 0 0 10px;
	}

	.import-notices ul {
		flex: 1;
		margin: 0;
		padding: 0 0 0 18px;
		font-size: 12px;
		color: var(--text-muted);
	}

	.muted {
		font-size: 13px;
		color: var(--text-muted);
	}

	/* Below the surface's minWidthPx the BODY scrolls (the surface doctrine);
	   the table itself never reflows under its column floor. */
	.table-wrap {
		overflow-x: auto;
	}

	table {
		width: 100%;
		min-width: 640px;
		border-collapse: collapse;
		font-size: 12px;
	}

	th {
		padding: 4px 8px;
		font-size: 11px;
		font-weight: 600;
		color: var(--text-muted);
		text-align: left;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		border-bottom: 1px solid var(--border);
		white-space: nowrap;
	}

	td {
		padding: 5px 8px;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
		white-space: nowrap;
	}

	/* The row under the pointer highlights (the AirportsTab row idiom),
	   pairing with the map's hover-preview line. */
	tbody tr:hover {
		background: var(--surface-2);
	}

	/* The LOADED outing's rows: the permanent selected-row highlight (the
	   plan catalog's active-row idiom); its trace is the one in the
	   navigation workspace. The bar wins over the same-trace bracket. */
	tbody tr.loaded {
		background: var(--surface-2);
	}

	tbody tr.loaded td:first-child {
		box-shadow: inset 3px 0 0 var(--accent);
	}

	th.num,
	td.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	/* The leading date column reads from the LEFT edge, the one its header,
	   the totals label spanning it and the group bracket all share: an ISO
	   date is fixed-width, so right-aligning it bought nothing and left the
	   dates under the Departure column with DATE stranded a column away. */
	td.date {
		font-variant-numeric: tabular-nums;
	}

	/* Same-trace grouping: a multi-flight outing's rows carry a left
	   bracket, the separator INSIDE the group dashes, and a continuation
	   row dims its repeated date. */
	tr.grp td:first-child {
		box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 55%, transparent);
	}

	tr:has(+ tr.cont) td {
		border-bottom-style: dashed;
	}

	td.dim {
		color: var(--text-muted);
	}

	/* The live outing's transient rows: the recording underway, filed for
	   real when it completes. */
	.live-chip {
		font-size: var(--fs-2xs);
		font-weight: 700;
		color: var(--nav-orange);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.clock {
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}

	td.route {
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* An aerodrome of the route string the wheels actually touched. */
	.td-touch {
		color: var(--nav-orange);
		font-weight: 600;
	}

	tfoot td {
		font-weight: 600;
		border-top: 2px solid var(--border);
		border-bottom: none;
	}

	.actions {
		display: flex;
		gap: 2px;
		justify-content: flex-end;
	}

	/* The row's own actions stay put while the table pans. Measured on a
	   phone: the table is 640px against a 392px screen, so the delete button
	   sat at x=604, off the screen on every one of 90 rows, and a table you
	   must pan sideways to act on is a table you cannot act on. Screen only,
	   and the cell is no-print besides. The background is the row's, so the
	   panned columns cannot show through it. */
	@media screen {
		thead th:last-child,
		td.actions {
			position: sticky;
			right: 0;
			z-index: 1;
			background: var(--surface);
		}

		tbody tr:hover td.actions,
		tbody tr.loaded td.actions {
			background: var(--surface-2);
		}
	}

	:global(:root.touch-ui) .actions .icon-btn {
		width: 44px;
		height: 44px;
	}

	/* On paper the Route cell WRAPS instead of clipping: the screen's
	   ellipsis is recoverable by hovering the cell's tooltip, and a sheet
	   is not. The table drops its own min-width for the same reason, so
	   the columns share the landscape page rather than overflowing it. */
	@media print {
		/* The app behind the portaled box, and the backdrop with it: #app
		   keeps height:100dvh even hidden, which would print a blank
		   leading page (the NavLogModal note). */
		:global(html.flights-print #app),
		:global(html.flights-print .modal-backdrop) {
			display: none !important;
		}

		caption {
			display: table-caption;
			padding: 0 0 6px;
			font-size: 11px;
			font-weight: 600;
			text-align: left;
			text-transform: uppercase;
			letter-spacing: 0.03em;
		}

		table {
			min-width: 0;
		}

		td.route {
			max-width: none;
			overflow: visible;
			white-space: normal;
		}
	}
</style>
