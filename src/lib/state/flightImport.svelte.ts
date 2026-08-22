/* The flights library's batch importer (docs/flights-library.md): one
 * multi-file pick of traces (GPX / IGC / KML / KMZ) + routes YAML, every
 * file sniffed by CONTENT (files/detect; Android's chooser needs the accept
 * list opened, so the name proves nothing), candidate plans parsed
 * STANDALONE through nav/planMatch (never the live route registry), each
 * trace matched to its plan automatically and filed through the shared
 * archive core. The live trace (nav.points / importTrace) is never touched.
 *
 * An IGC file that does not state what its altitudes are measured from is
 * asked about ONCE per run, before the archive loop: per file it would be a
 * dialog per file, and mid-loop it would suspend the progress line. The
 * answer is frozen into every outing it files (OutingMeta.datum), so
 * declining files nothing rather than guessing.
 *
 * Notices are {name, code, param} rows worded at render (docs/i18n.md
 * rule 7; `param` carries only file / plan names and upstream EN parser
 * lines). The re-entrancy guard is a plain module let, deliberately not
 * the reactive `running` field (the listing-loop lesson: a guard READ in
 * an $effect's synchronous phase subscribes it). */

import { detectFileKind } from '$lib/files/detect';
import { itemsOf, readIncoming, type IncomingItem } from '$lib/files/archive';
import type { AltDatum } from '$lib/nav/altitudeDatum';
import { isTraceFormat } from '$lib/nav/traceExport';
import { parseTraceFile } from '$lib/nav/traceImport';
import { parseLogbookCsv } from '$lib/nav/logbook';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import {
	buildCandidatePlan,
	matchTraceToPlans,
	traceTouchEvidence,
	type CandidatePlan,
} from '$lib/nav/planMatch';
import type { TrackPoint } from '$lib/nav/trace';
import { parseRoutesDoc } from '$lib/route/yaml';
import { ensureAirports, ensureNavaids } from './data.svelte';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import type { Aircraft } from '$lib/aircraft/schema';
import { addUserAircraftMany } from './aircraft.svelte';
import { getStoredPlans, newPlanId, putStoredPlan, type TraceSource } from './flightsDb';
import {
	archiveLogbookFlights,
	archiveOuting,
	summaryDeps,
} from './flightLibrary.svelte';
import { ensureLinks, primeLink } from './flightLinks.svelte';
import { askTraceDatum } from './openFile.svelte';
import { flownRouteLabelsFor } from './flightRows';
import { resolveWaypointToken } from './waypointSearch.svelte';

export type ImportNoticeCode =
	| 'noTakeoff'
	/** Times enough to place the fixes in the day: a drawn line, not a
	 *  recording. Its own code because "not a flight record" and "the
	 *  store refused a real flight" are opposite answers. */
	| 'noClock'
	| 'invalid'
	| 'storeFailed'
	| 'unsupported'
	| 'plansSaved'
	| 'planUnusable'
	| 'datumDeclined'
	| 'logbook'
	| 'aircraftAdded'
	| 'aircraftKept'
	| 'aircraftNotSaved';

export interface ImportNotice {
	/** The picked file's name. */
	name: string;
	code: ImportNoticeCode;
	/** Code-specific values, worded at render: invalid / storeFailed =
	 *  [the upstream line (raw detail, EN by the routeLoad decision)];
	 *  logbook = [added, total]. */
	params: string[];
}

export const flightImport = $state<{
	running: boolean;
	/** Files fully dispositioned / files picked, the progress line. */
	done: number;
	total: number;
	notices: ImportNotice[];
	/** How many files of this run the pending datum question covers; 0 when
	 *  none is standing (the dialog's batch note reads it). */
	datumFiles: number;
}>({ running: false, done: 0, total: 0, notices: [], datumFiles: 0 });

/** Non-reactive in-flight guard (plain let on purpose, see header). */
let importing = false;

export function clearImportNotices(): void {
	flightImport.notices = [];
}

function note(name: string, code: ImportNoticeCode, ...params: string[]): void {
	flightImport.notices.push({ name, code, params });
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Import a picked batch. Serial per trace (the archive is I/O-bound and
 *  order keeps the notices readable); re-entry while one runs is a no-op.
 *  The reads are guarded up front: on Android they are the step that
 *  fails (the routeLoad lesson). */
export async function runImport(files: readonly File[]): Promise<void> {
	if (importing || files.length === 0) {
		return;
	}
	const items: NamedText[] = [];
	const unreadable: { name: string; detail: string }[] = [];
	for (const f of files) {
		try {
			// Bytes, not text: a KMZ is a ZIP container, and File.text() would
			// decode it to replacement characters beyond recovery. A BUNDLE is
			// one too, and expands here into the files it carries, which are
			// the files this importer already reads (files/archive.ts).
			items.push(...(await expandPick(f.name, new Uint8Array(await f.arrayBuffer()))));
		} catch (err) {
			unreadable.push({ name: f.name, detail: errText(err) });
		}
	}
	await runImportTexts(items, unreadable);
}

/** One picked file as the items the run works on: a bundle's members, or
 *  the file itself. An archive holding nothing readable stays ONE item under
 *  its own name, so the run reports it as unsupported rather than silently
 *  importing nothing. */
export async function expandPick(name: string, bytes: Uint8Array): Promise<NamedText[]> {
	return itemsOf(name, await readIncoming(name, bytes));
}

/** What the run works on. The container layer owns the shape, since it is
 *  what builds these (files/archive.ts itemsOf). */
export type NamedText = IncomingItem;

/** The already-read entry (the openFile dispatcher hands text, not
 *  Files). Same run, same notices. */
export async function runImportTexts(
	items: readonly NamedText[],
	unreadable: readonly { name: string; detail: string }[] = [],
): Promise<void> {
	if (importing || items.length + unreadable.length === 0) {
		return;
	}
	importing = true;
	flightImport.running = true;
	flightImport.done = 0;
	flightImport.total = items.length + unreadable.length;
	flightImport.notices = [];
	try {
		for (const u of unreadable) {
			note(u.name, 'invalid', u.detail);
			flightImport.done++;
		}
		await runImportInner(items);
	} finally {
		flightImport.running = false;
		importing = false;
	}
}

interface ReadFile {
	name: string;
	kind: ReturnType<typeof detectFileKind>;
	text: string;
	/** The file's own bytes when the caller had them; a trace is FILED from
	 *  these, never from a re-encoding of `text` (docs/trace-files.md). */
	bytes?: Uint8Array | undefined;
	/** A bundle member's stored timestamp, which is a plan's savedAtMs. */
	mtimeMs?: number | undefined;
}

async function runImportInner(items: readonly NamedText[]): Promise<void> {
	// Sniff everything first: matching wants every candidate up front
	// regardless of pick order.
	const read: ReadFile[] = items.map((f) => ({
		name: f.name,
		kind: detectFileKind(f.name, f.text),
		text: f.text,
		bytes: f.bytes,
		mtimeMs: f.mtimeMs,
	}));
	try {
		await Promise.all([ensureAirports(), ensureNavaids()]);
	} catch {
		/* candidates resolve what they can; an offline import still files
		   the traces, unmatched */
	}
	// Candidate plans, byte-equal texts deduped silently (first wins; the
	// matcher dedupes again, so a duplicate can never manufacture a tie).
	const candidates: CandidatePlan[] = [];
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupers
	const seenText = new Set<string>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local dedupers
	const usedYaml = new Set<string>();
	// name -> built plan (null = no usable route), for the end-of-run notices.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index
	const planByFile = new Map<string, CandidatePlan | null>();
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local index
	const invalidNames = new Set<string>();
	// The stored catalog, read once up front: a picked file whose bytes
	// equal a stored entry reuses that entry (no twin, no churn); file
	// names are never kept, so an EVOLVED re-import files as a NEW entry
	// beside the old one (recorded decision: editing lives in the
	// workspace Store loop, not in re-imports).
	const stored = await getStoredPlans();
	for (const rf of read) {
		if (rf.kind !== 'routes' || seenText.has(rf.text)) {
			continue;
		}
		seenText.add(rf.text);
		try {
			const plan = buildCandidatePlan(rf.name, rf.text, parseRoutesDoc(rf.text), resolveWaypointToken);
			planByFile.set(rf.name, plan);
			if (plan) {
				candidates.push(plan);
				// Remember the file: traces imported in a LATER pick, or a
				// later session, still match against it. Byte-identical to a
				// stored entry = that entry, untouched (a re-put would churn
				// the Saved column and the links hash for nothing).
				try {
					const twin = stored.find((sp) => sp.yaml === rf.text);
					if (twin) {
						plan.catalogId = twin.id;
					} else {
						const id = newPlanId();
						// A bundle writes each plan's savedAtMs as its member
						// timestamp, so a catalog that moves between devices keeps
						// the date it was stored on. A loose file carries none and
						// is stored now, as it always was.
						await putStoredPlan({ id, yaml: rf.text, savedAtMs: rf.mtimeMs ?? Date.now() });
						plan.catalogId = id;
					}
				} catch {
					/* not remembered; this run still matches it */
				}
			}
		} catch (err) {
			note(rf.name, 'invalid', errText(err));
			invalidNames.add(rf.name);
		}
	}
	// The remembered catalog joins the candidate pool (byte-twins of a
	// batch file already ride that candidate); a stored plan that no
	// longer parses (or resolves no route) is silently skipped.
	for (const sp of stored) {
		if (seenText.has(sp.yaml)) {
			continue;
		}
		seenText.add(sp.yaml);
		const plan = candidateFromText(sp.id, sp.yaml);
		if (plan) {
			plan.catalogId = sp.id;
			candidates.push(plan);
		}
	}
	// Every trace parsed up front, so the one datum question below can be
	// asked before anything is added rather than in the middle of the run.
	const traces: {
		rf: ReadFile;
		points: TrackPoint[];
		datum: AltDatum | null;
		/** The file exactly as picked, filed beside the points so an export
		 *  hands back THIS document (docs/trace-files.md). The format is
		 *  carried rather than re-read off rf.kind, which is the wider
		 *  FileKind and would need narrowing again at the archive. */
		source: TraceSource;
	}[] = [];
	for (const rf of read) {
		if (!isTraceFormat(rf.kind)) {
			continue;
		}
		try {
			const parsed = parseTraceFile(rf.kind, rf.text);
			// The outing id is points[0].timeMs; the parsers emit a strictly
			// increasing clock, the sort is the belt to that suspender.
			traces.push({
				rf,
				points: [...parsed.points].sort((a, b) => a.timeMs - b.timeMs),
				datum: parsed.datum,
				source: {
					name: rf.name,
					format: rf.kind,
					// The file's own bytes; encoding `text` is the fallback for a
					// caller that had none, and is lossy (files/archive.ts).
					bytes: rf.bytes ?? new TextEncoder().encode(rf.text),
				},
			});
		} catch (err) {
			note(rf.name, 'invalid', errText(err));
			flightImport.done++;
		}
	}
	// ONE question for the whole run: an IGC file that does not state what
	// its altitudes are measured from cannot be guessed at (~45 m over
	// France, frozen into the outing at filing).
	const unstated = traces.filter((tr) => tr.datum == null);
	let answered: AltDatum | null = null;
	if (unstated.length > 0) {
		flightImport.datumFiles = unstated.length;
		answered = await askTraceDatum();
		flightImport.datumFiles = 0;
	}
	// The traces, each matched and filed.
	for (const tr of traces) {
		const rf = tr.rf;
		const points = tr.points;
		const datum = tr.datum ?? answered;
		if (datum == null) {
			// Declined: file nothing rather than assert a reference.
			note(rf.name, 'datumDeclined');
			flightImport.done++;
			continue;
		}
		const motion = extendMotion(newMotionFold(), points);
		if (motion.takeoffMs == null) {
			note(rf.name, 'noTakeoff');
			flightImport.done++;
			continue;
		}
		// The touch evidence rides the summary fold's own lookups, on the
		// same datum the archive ctx below freezes.
		const deps = summaryDeps(datum);
		const touches = traceTouchEvidence(points, motion, deps.altMslFt, deps.fieldElevFt);
		const m = matchTraceToPlans(points, motion, candidates, touches);
		const filed = await archiveOuting(points, {
			datum,
			aircraftKey: m.kind === 'match' ? m.plan.aircraftKey : null,
			source: tr.source,
		});
		if (filed.kind === 'archived') {
			// Prime the dynamic link with the match just computed: the
			// candidate set equals the post-import catalog, so this IS the
			// answer the background pass would fold again.
			await primeLink(points[0].timeMs, {
				planId: m.kind === 'match' ? (m.plan.catalogId ?? null) : null,
				labels:
					m.kind === 'match' ? flownRouteLabelsFor(m.plan.routes, m.segments) : [],
			});
		}
		// Each refusal in its own words. A clockless file is the reachable
		// one the takeoff gate above cannot see: parseGpx synthesises a 1 Hz
		// clock for a GPX with no <time>, which reads as several hundred
		// knots and commits a takeoff, so only archiveOuting can tell.
		if (filed.kind === 'noClock') {
			note(rf.name, 'noClock');
		} else if (filed.kind === 'noTakeoff') {
			note(rf.name, 'noTakeoff');
		} else if (filed.kind === 'unavailable') {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			note(rf.name, 'storeFailed', 'indexedDB unavailable');
		} else if (filed.kind === 'failed') {
			note(rf.name, 'storeFailed', filed.detail);
		} else if (m.kind === 'match') {
			// No per-file outcome notices at all: the table rows say it (a
			// matched row wears its labels, an unmatched one an empty Route).
			usedYaml.add(m.plan.yaml);
		} else if (m.kind === 'ambiguous') {
			// A tied plan is not unused: it fit a flight, just not alone.
			for (const c of m.candidates) {
				usedYaml.add(c.yaml);
			}
		}
		flightImport.done++;
	}
	// The catalog may have changed (stored plans): every pre-existing
	// outing's dynamic link recomputes in the background (the primed
	// fresh imports serve from their cache).
	void ensureLinks();
	// The non-trace files' dispositions, now that every match is known. The
	// logbook CSVs run here too, AFTER the traces: a batch holding a flight
	// both ways then skips the CSV row against the trace already filed
	// (the same convergence the archive's supersede gives the other order).
	let savedUnused = 0;
	const sheets: Aircraft[] = [];
	for (const rf of read) {
		if (isTraceFormat(rf.kind)) {
			continue;
		}
		if (rf.kind === 'routes') {
			// A byte-equal duplicate resolves silently with its twin; a file
			// that failed to parse already carries its invalid notice; one
			// with no usable route says so per file; the usable plans that
			// matched nothing THIS run aggregate into ONE remembered line,
			// since the Plans view now lists them individually.
			const plan = planByFile.get(rf.name);
			if (plan === null && !invalidNames.has(rf.name)) {
				note(rf.name, 'planUnusable');
			} else if (plan != null && !usedYaml.has(plan.yaml)) {
				savedUnused++;
			}
		} else if (rf.kind === 'aircraft') {
			// A bundle carries the user's own data sheets, and a restored
			// library's rows need them to resolve their aircraft at all.
			// Collected here and applied ONCE below: added without selecting,
			// and never over a sheet already yours.
			try {
				sheets.push(parseAircraftYaml(rf.text));
			} catch (err) {
				note(rf.name, 'invalid', errText(err));
			}
		} else if (rf.kind === 'logbook') {
			try {
				const parsed = parseLogbookCsv(rf.text);
				const { added, skipped } = await archiveLogbookFlights(parsed.rows);
				note(
					rf.name,
					'logbook',
					String(added),
					String(added + skipped + parsed.skipped),
				);
			} catch (err) {
				note(rf.name, 'invalid', errText(err));
			}
		} else {
			note(rf.name, 'unsupported');
		}
		flightImport.done++;
	}
	if (savedUnused > 0) {
		note('', 'plansSaved', String(savedUnused));
	}
	// Aggregated like the plans line, and for the same reason: a bundle
	// carries a whole fleet, and one line per sheet would drown the notices
	// that report a real failure.
	if (sheets.length > 0) {
		const { added, kept, persisted } = addUserAircraftMany(sheets);
		if (!persisted) {
			// The one outcome that must not read as success: the sheets are in
			// memory and will be gone on the next reload.
			note('', 'aircraftNotSaved', String(added));
		} else if (added > 0) {
			note('', 'aircraftAdded', String(added), String(kept));
		} else if (kept > 0) {
			note('', 'aircraftKept', String(kept));
		}
	}
}

/** One remembered text as a candidate; null when it does not parse or
 *  resolves no usable route (the importer's silent-skip posture). */
function candidateFromText(name: string, text: string): CandidatePlan | null {
	try {
		return buildCandidatePlan(name, text, parseRoutesDoc(text), resolveWaypointToken);
	} catch {
		return null;
	}
}
