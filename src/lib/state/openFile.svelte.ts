/* Opening a file the app did not pick itself.
 *
 * One dispatcher for every way a file can arrive from outside: an Android
 * VIEW intent ("Open with"), an Android SEND intent ("Share to"), the ?file=
 * boot parameter, and (since the trace formats multiplied) the Navigation
 * tab's own picker, which hands its file here rather than keeping a second
 * copy of the sniff / confirm / apply sequence. Every kind the app hands out
 * it takes back, so the kind is SNIFFED from the content (files/detect.ts) and
 * applied through the same entry point the matching tab uses, then that tab
 * is brought up: the result on screen is the receipt, exactly as it is when
 * the user picks the file inside the app.
 *
 * Reporting follows the same rule. A route file's outcome (dropped waypoints,
 * an unreadable document) is the Route tab's own notice, state/routeLoad;
 * everything else is pass/fail and reports in `openFile.failure`, which
 * FileOpenHost words and shows. Stored as data / codes, never rendered text
 * (docs/i18n.md rule 7), with the upstream parser message as the detail line.
 *
 * Nothing here has to be sequenced against the boot restore: restoreRoutes
 * bails on a workspace that is no longer pristine, both before and after its
 * dataset await, so an incoming file that lands first wins and one that lands
 * second replaces what was restored. Either way loadRoutes records an undo
 * step, so the workspace it replaced is one click away.
 */

import { parseAircraftYaml } from '$lib/aircraft/schema';
import { detectFileKind, type FileKind } from '$lib/files/detect';
import { itemsOf, readIncoming } from '$lib/files/archive';
import type { AltDatum } from '$lib/nav/altitudeDatum';
import { traceBounds, type TrackPoint } from '$lib/nav/trace';
import { parseTraceFile } from '$lib/nav/traceImport';
import { isTraceFormat } from '$lib/nav/traceExport';
import { fitRoute } from '$lib/components/tabs/route/fitRoute';
import { pickIncomingFile } from '$lib/native/openFile';
import { importUserAircraft } from '$lib/state/aircraft.svelte';
import { runImportTexts } from '$lib/state/flightImport.svelte';
import { openFlights } from '$lib/state/flightsModal.svelte';
import { mapState } from '$lib/state/map.svelte';
import type { TraceSource } from '$lib/state/flightsDb';
import { importTrace, nav } from '$lib/state/navRecording.svelte';
import { notamState, parseInput } from '$lib/state/notam.svelte';
import { loadPlanFile, loadRoutesFromYaml } from '$lib/state/routeLoad.svelte';
import { showTab } from '$lib/state/ui.svelte';

/** Why a file did not open. `unsupported` = nothing we can read; `failed` =
 *  the right kind, but the parser refused it (detail carries its message). */
export type OpenFailure = {
	name: string;
	reason: 'unsupported' | 'failed';
	detail: string;
};

export const openFile = $state<{
	failure: OpenFailure | null;
	/** A PARSED trace waiting on the replace-a-recording confirm. Parsed
	 *  first on purpose: a file that cannot be read must fail before the
	 *  question, not after it. Carries the pristine source through the
	 *  question with it: the confirm is what applies the file, so dropping
	 *  it here would file the outing without the bytes it came from. */
	pendingTrace: { points: TrackPoint[]; datum: AltDatum | null; source: TraceSource } | null;
	/** True while a file's altitude reference is being asked about. */
	askingDatum: boolean;
}>({ failure: null, pendingTrace: null, askingDatum: false });

/** The datum question's resolver. A plain module let, not reactive state:
 *  the listing-loop lesson (a guard read in an effect's synchronous phase
 *  subscribes it). */
let datumResolve: ((datum: AltDatum | null) => void) | null = null;

/** Ask which reference a file's altitudes are on, once. Resolves null when
 *  the user cancels, or when the host that renders the dialog goes away, so
 *  no caller can hang on an unanswered question. */
export function askTraceDatum(): Promise<AltDatum | null> {
	answerTraceDatum(null); // a second question supersedes the first
	openFile.askingDatum = true;
	return new Promise((resolve) => {
		datumResolve = resolve;
	});
}

export function answerTraceDatum(datum: AltDatum | null): void {
	const resolve = datumResolve;
	datumResolve = null;
	openFile.askingDatum = false;
	resolve?.(datum);
}

export function dismissOpenFailure(): void {
	openFile.failure = null;
}

/**
 * The native file picker (Android only; see OpenFilePlugin.pick). The file
 * lands through the same `open` event an intent uses, so there is nothing to
 * await here but the failure: a picker dismissed resolves with nothing, a file
 * that could not be read reports like any other unreadable one.
 */
export async function pickFileNatively(): Promise<void> {
	openFile.failure = null;
	try {
		await pickIncomingFile();
	} catch (err) {
		openFile.failure = { name: '', reason: 'failed', detail: message(err) };
	}
}

export function dismissPendingTrace(): void {
	openFile.pendingTrace = null;
}

export function applyPendingTrace(): void {
	const pending = openFile.pendingTrace;
	openFile.pendingTrace = null;
	if (pending) {
		void applyTrace(pending);
	}
}

/**
 * Apply a file that arrived from outside. `fallback` names the kind to assume
 * when the sniff is inconclusive; the ?file= parameter passes 'notams', which
 * is what it has always meant.
 */
export async function openIncomingFile(
	name: string,
	text: string,
	opts: { fallback?: FileKind; bytes?: Uint8Array } = {},
): Promise<void> {
	const bytes = opts.bytes;
	openFile.failure = null;
	const kind = detectFileKind(name, text) ?? opts.fallback ?? null;
	if (kind === null) {
		openFile.failure = { name, reason: 'unsupported', detail: '' };
		return;
	}
	switch (kind) {
		case 'routes':
			// Errors and the dropped/truncated notice belong to the Route tab,
			// which renders them for its own picker already.
			if (await loadRoutesFromYaml(text)) {
				fitRoute();
			}
			showTab('route');
			return;
		case 'plan':
			// A plan in someone else's format (FPL / GPX / KML / PLN,
			// docs/route-files.md). The same door as the workspace YAML above,
			// reporting through the same Route-tab lines.
			if (await loadPlanFile(text)) {
				fitRoute();
			}
			showTab('route');
			return;
		case 'aircraft':
			try {
				importUserAircraft(parseAircraftYaml(text));
				showTab('aircraft');
			} catch (err) {
				openFile.failure = { name, reason: 'failed', detail: message(err) };
			}
			return;
		case 'gpx':
		case 'igc':
		case 'kml':
			await openTrace(name, kind, text, bytes ?? new TextEncoder().encode(text));
			return;
		case 'notams':
			notamState.rawText = text;
			parseInput();
			showTab('notams');
			return;
		case 'logbook':
			// The flights batch importer's single-file path: the CSV files
			// its rows and the open surface shows the outcome notices.
			openFlights();
			void runImportTexts([{ name, text }]);
			return;
		default: {
			// Exhaustive: a kind added without a case here would otherwise
			// open nothing at all, silently.
			const never: never = kind;
			openFile.failure = { name, reason: 'unsupported', detail: String(never) };
			return;
		}
	}
}

/** The trace flow, one for all three formats: parse (a bad file fails here,
 *  before any question), then the replace confirm if a trace is loaded, then
 *  the altitude reference when the file did not state it. */
async function openTrace(
	name: string,
	format: FileKind,
	text: string,
	bytes: Uint8Array,
): Promise<void> {
	if (!isTraceFormat(format)) {
		return;
	}
	let parsed;
	try {
		parsed = parseTraceFile(format, text);
	} catch (err) {
		openFile.failure = { name, reason: 'failed', detail: message(err) };
		return;
	}
	// The file exactly as it arrived - its BYTES, since a decoded string does
	// not survive a BOM or a non-UTF-8 header - kept so an export hands back
	// THIS document rather than a re-synthesis of the points read out of it
	// (docs/trace-files.md).
	const incoming = { ...parsed, source: { name, format, bytes } };
	// A recorded trace is not undoable, so replacing one asks first.
	if (nav.points.length > 0) {
		openFile.pendingTrace = incoming;
		showTab('navigation');
		return;
	}
	await applyTrace(incoming);
}

/** Land a parsed trace: the datum question when the file stated none, then
 *  the import and the map fit. */
async function applyTrace(parsed: {
	points: TrackPoint[];
	datum: AltDatum | null;
	source: TraceSource;
}): Promise<void> {
	const datum = parsed.datum ?? (await askTraceDatum());
	if (datum == null) {
		return; // cancelled: nothing is replaced
	}
	importTrace(parsed.points, datum, parsed.source);
	const b = traceBounds(nav.points);
	if (b && mapState.map) {
		mapState.map.fitBounds(
			[
				[b.south, b.west],
				[b.north, b.east],
			],
			{ padding: [40, 40] },
		);
	}
	showTab('navigation');
}

/** Sniff and open one incoming file given its BYTES (the pickers and the
 *  Android bridge both have bytes; only ?file= and the plugin's text path do
 *  not).
 *
 *  A ZIP is either packaging around ONE document (a KMZ) or a whole flights
 *  BUNDLE, and files/archive.ts decides which by how many members this
 *  application recognises. A bundle is not a file this dispatcher can apply
 *  to a tab: it is a library, so it goes to the flights importer, which is
 *  where each of its members would have gone anyway. */
export async function openIncomingBytes(
	name: string,
	bytes: Uint8Array,
	opts: { fallback?: FileKind } = {},
): Promise<void> {
	let incoming;
	try {
		incoming = await readIncoming(name, bytes);
	} catch (err) {
		openFile.failure = { name, reason: 'failed', detail: message(err) };
		return;
	}
	if (incoming.kind === 'empty') {
		openFile.failure = { name, reason: 'unsupported', detail: '' };
		return;
	}
	if (incoming.kind === 'bundle') {
		openFile.failure = null;
		openFlights();
		// Through the shared mapper, so the members arrive carrying their own
		// BYTES: filing a trace from a re-encoding of its text is exactly the
		// corruption the pristine source exists to prevent.
		await runImportTexts(itemsOf(name, incoming));
		return;
	}
	await openIncomingFile(incoming.name, incoming.text, { ...opts, bytes: incoming.bytes });
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
