/* The flights library: outings filed automatically when a RECORDING
 * settles (the navRecording outing-settled hook) and manually for imports;
 * a logbook-LOOK aid, never a logbook (docs/flights-library.md). Rows are
 * pure derivations of the stored traces (nav/logbook summarizeFlights),
 * re-derived lazily when DERIVED_V bumps; the context snapshot (aircraft
 * key, route chain, datum) is the only frozen part.
 *
 * Reactivity contract: `flightLibrary` is the reactive listing; the
 * archive and refresh functions run from event handlers and hooks, never
 * from an $effect on nav.recording (the flightAction doctrine). Every
 * fold over a snapshot or stored points uses a LOCAL motion fold: the
 * single-slot traceMotion memo belongs to the live trace. */

import {
	summarizeFlights,
	type FlightSummary,
	type LogbookCsvRow,
	type SummaryDeps,
} from '$lib/nav/logbook';
import { extendMotion, newMotionFold } from '$lib/nav/navlogLive';
import { mslAltFt, type AltDatum } from '$lib/nav/altitudeDatum';
import { hasAbsoluteTime, type TrackPoint } from '$lib/nav/trace';
import type { Airport } from '$lib/data/airports';
import { equirectangularDistanceM } from '$lib/notam/geometry';
import { NM_TO_METERS } from '$lib/notam/units';
import { dataState, ensureAirports, getAirports } from './data.svelte';
import { aircraftState } from './aircraft.svelte';
import { outingSpan, spansOverlap, supersededLogbookIds } from './flightRows';
import { recordSyncTombstone } from './syncRegistry';
import { sharedDeviceFlag } from '$lib/sync/keys';
import { storeFlownPlan } from './activePlan.svelte';
import {
	adoptPendingTrace,
	currentTraceSource,
	dropPendingTrace,
	nav,
	pendingRestoredTrace,
	setOutingSettledHook,
	traceAltDatum,
	type OutingSettleReason,
} from './navRecording.svelte';
import { whenRoutesRestored } from './routePersist';
import {
	clearAllOutings,
	deleteOuting,
	getMeta,
	getMetas,
	getPoints,
	putMeta,
	putOuting,
	type OutingMeta,
	type TraceSource,
} from './flightsDb';

export type { OutingMeta };

/** Bump when the derivation improves (the motion fold, the touch-and-go
 *  detector, the night rule, the place resolution): stale rows re-derive
 *  lazily on the next listing, the aid getting better retroactively.
 *  0 is reserved as the "derived without the airports dataset" sentinel.
 *  2: FlightSummary.touchPlaces (the Route cell's touchdown highlight).
 *  3: touchPlaces chronological with repeats (the flown-chain cell).
 *  4: two-signal touch-and-goes (midpoint crossing estimate, the low
 *  slow pass, the TOUCH_CYCLE_MS approach collapse).
 *  5: the ground-roll takeoff gate (an aborted roll files no flight), the
 *  trailing-flight closure (a recording ending slow on a field lands),
 *  and its landing reaching the touch detector. Local only: derivedV and
 *  flights[] never sync (docs/accounts-sync.md), so this bump dirties no
 *  other device. */
export const DERIVED_V = 5;

export const flightLibrary = $state<{
	/** The listed metas, outing id (= start instant) descending. */
	rows: OutingMeta[];
	loaded: boolean;
	loading: boolean;
	/** The upstream detail of the last archive that FAILED to write, until
	 *  the user dismisses it. A stopped recording archives itself with
	 *  nobody awaiting the result, so a full quota or an evicted store
	 *  would otherwise lose the flight in silence, which is the one
	 *  failure this library must never eat. */
	archiveError: string | null;
}>({ rows: [], loaded: false, loading: false, archiveError: null });

export function clearArchiveError(): void {
	flightLibrary.archiveError = null;
}

/** Place radius for the logbook's departure / arrival designators and the
 *  touch-and-go elevation reference: the aerodrome the wheels are on,
 *  never a guess beyond it. */
export const PLACE_RADIUS_NM = 3;

/** Nearest airport within PLACE_RADIUS_NM of (lat, lon), or null when
 *  none is that close or the dataset has not loaded. Reads reactive
 *  state. */
export function nearestAirportTo(lat: number, lon: number): Airport | null {
	const airports = dataState.airportsLoaded ? getAirports() : null;
	if (!airports) {
		return null;
	}
	const latBand = PLACE_RADIUS_NM / 60;
	let best: Airport | null = null;
	let bestM = PLACE_RADIUS_NM * NM_TO_METERS;
	for (const a of airports) {
		if (Math.abs(a.lat - lat) > latBand) {
			continue;
		}
		const d = equirectangularDistanceM(lat, lon, a.lat, a.lon);
		if (d <= bestM) {
			bestM = d;
			best = a;
		}
	}
	return best;
}

/** The summary fold's lookups for a trace on `datum` (stored outings carry
 *  their own; the live archive resolves it at capture). Exported for the
 *  importer's touch-evidence extraction (traceTouchEvidence), so matcher
 *  and summary read the SAME touches. */
export function summaryDeps(datum: AltDatum): SummaryDeps {
	return {
		altMslFt: (p) => mslAltFt(p.altFt, p.lat, p.lon, datum),
		fieldElevFt: (lat, lon) => nearestAirportTo(lat, lon)?.elevFt ?? null,
		placeIdentAt: (lat, lon) => nearestAirportTo(lat, lon)?.ident ?? '',
	};
}

/* The flown plan is NOT captured: the trace->plan link is purely
 * dynamic (state/flightLinks.svelte.ts), computed against the current
 * catalog whenever consulted, so the archive freezes only what a
 * recomputation cannot recover (datum, the selected aircraft). */

function upsertRow(meta: OutingMeta): void {
	const i = flightLibrary.rows.findIndex((r) => r.id === meta.id);
	if (i >= 0) {
		flightLibrary.rows[i] = meta;
	} else {
		flightLibrary.rows.push(meta);
		flightLibrary.rows.sort((a, b) => b.id - a.id);
	}
}

let persistAsked = false;

/** The context an outing archives with: everything the trace itself does
 *  not carry, frozen at filing (re-derivation never touches it). */
export interface ArchiveContext {
	datum: AltDatum;
	aircraftKey: string | null;
	/** The PRISTINE file this outing came from, so an export can hand back
	 *  exactly what was imported (docs/trace-files.md). Three-state, see
	 *  flightsDb.putOuting: a source, `null` for "the points are knowingly
	 *  no longer a file's own", `undefined` for "no opinion, leave any
	 *  stored source alone". Absent on every recording path. */
	source?: TraceSource | null | undefined;
}

/** Why an archive did not file, or that it did. The REASONS are separate
 *  because they mean opposite things to a caller: three of them say the
 *  trace is not a flight record (which the importer reports per file, each
 *  in its own words), while 'failed' says the flight was real and the
 *  store would not take it, which nobody may swallow. */
export type ArchiveResult =
	| { kind: 'archived' }
	/** No IndexedDB at all (a headless or locked-down browser). */
	| { kind: 'unavailable' }
	/** No wall clock: a drawn line, not a recording. */
	| { kind: 'noClock' }
	/** Never left the ground, or too short a fragment to say. */
	| { kind: 'noTakeoff' }
	| { kind: 'failed'; detail: string };

/** The archive core shared by the live capture and the batch importer: an
 *  idempotent UPSERT keyed on the outing id (points[0].timeMs, stable
 *  across Continue-extends). Gates on a committed takeoff (a taxi-only
 *  trace or a fragment is not a flight); the fold is LOCAL on purpose,
 *  never the live trace's single-slot traceMotion memo. */
export async function archiveOuting(
	points: TrackPoint[],
	ctx: ArchiveContext,
): Promise<ArchiveResult> {
	if (typeof indexedDB === 'undefined') {
		return { kind: 'unavailable' };
	}
	if (points.length === 0) {
		return { kind: 'noTakeoff' };
	}
	// A file with no wall clock is not a flight record: a drawn Google Earth
	// line carries no times, so the synthesised 1 Hz clock puts its points
	// kilometres apart and the takeoff gate below would commit on a "ground
	// speed" of several hundred knots, filing an outing dated 1970.
	if (!hasAbsoluteTime(points)) {
		return { kind: 'noClock' };
	}
	const motion = extendMotion(newMotionFold(), points);
	if (motion.takeoffMs == null) {
		return { kind: 'noTakeoff' };
	}
	try {
		await ensureAirports();
	} catch {
		/* places stay empty; derivedV 0 re-derives them later */
	}
	const flights = summarizeFlights(points, motion, summaryDeps(ctx.datum));
	const meta: OutingMeta = {
		id: points[0].timeMs,
		// The fresh stamp is ALSO what marks a Continue-extended outing
		// dirty for sync (the authored payload changes); keep the bump.
		savedAtMs: Date.now(),
		datum: ctx.datum,
		aircraftKey: ctx.aircraftKey,
		remarks: '',
		source: 'trace',
		derivedV: dataState.airportsLoaded ? DERIVED_V : 0,
		flights,
	};
	try {
		await putOuting(meta, points, ctx.source);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		// The one failure that must reach a human: the flight was real and
		// the store refused it. Every caller may ignore the return; none may
		// ignore this.
		flightLibrary.archiveError = detail;
		return { kind: 'failed', detail };
	}
	flightLibrary.archiveError = null;
	upsertRow(meta);
	await supersedeLogbookRows(meta);
	if (!persistAsked && !sharedDeviceFlag()) {
		persistAsked = true;
		try {
			// Best-effort durability, the offlineCharts idiom; denied in the
			// Android WebView, harmless everywhere. Never on a SHARED club
			// machine (docs/accounts-sync.md): its store is swept, not kept.
			void navigator.storage?.persist?.();
		} catch {
			/* best-effort */
		}
	}
	return { kind: 'archived' };
}

/** A trace of a flight is strictly better than the logbook-CSV row that
 *  described it: when a real outing files, the imported 'logbook' rows
 *  its flights overlap are deleted (the mirror of the import's own
 *  overlap skip, so trace-then-logbook and logbook-then-trace converge).
 *  The CSV row still knows what the trace cannot: a superseded row's
 *  aircraft key is adopted when the outing has none. Best-effort: a
 *  failure leaves a duplicate row, one Delete away. */
async function supersedeLogbookRows(meta: OutingMeta): Promise<void> {
	const span = outingSpan(meta);
	if (!span) {
		return;
	}
	const metas = await getMetas();
	let enriched = meta;
	for (const id of supersededLogbookIds(metas, span.fromMs, span.toMs)) {
		if (id === meta.id) {
			continue;
		}
		const old = metas.find((m) => m.id === id);
		if (enriched.aircraftKey == null && old?.aircraftKey != null) {
			enriched = { ...enriched, aircraftKey: old.aircraftKey };
		}
		try {
			await deleteOuting(id);
		} catch {
			continue;
		}
		// A supersede is a real deletion of the synced logbook doc: the
		// tombstone is what keeps two devices convergent whichever of them
		// filed the trace (docs/accounts-sync.md).
		void recordSyncTombstone('outings', String(id));
		flightLibrary.rows = flightLibrary.rows.filter((r) => r.id !== id);
	}
	if (enriched !== meta) {
		try {
			await putMeta(enriched);
			upsertRow(enriched);
		} catch {
			/* the un-enriched row stands */
		}
	}
}

/** File imported logbook-CSV flights as meta-only rows (source
 *  'logbook': no points, so no replay / GPX / re-derivation; the row IS
 *  its stored summary). One outing per CSV flight, id = block-off. A row
 *  whose span overlaps an outing already filed is skipped: the library
 *  already holds that flight, as a trace or an earlier import. The id
 *  guard is the second half of that: ids are block-off instants, so a row
 *  describing a filed flight COLLIDES with it, and writing would replace
 *  a recorded trace (points and all) with a bare CSV line. */
export async function archiveLogbookFlights(
	rows: readonly LogbookCsvRow[],
): Promise<{ added: number; skipped: number }> {
	if (typeof indexedDB === 'undefined') {
		return { added: 0, skipped: rows.length };
	}
	const metas = await getMetas();
	let added = 0;
	let skipped = 0;
	for (const row of rows) {
		const f = row.flight;
		const toMs = f.blockOnMs ?? f.landingMs ?? f.blockOffMs;
		const over = metas.filter((m) => {
			const s = outingSpan(m);
			return s != null && spansOverlap(s, f.blockOffMs, toMs);
		});
		// Same instant, same flight: never write over what is already filed.
		const collides = metas.filter((m) => m.id === f.blockOffMs);
		if (over.length > 0 || collides.length > 0) {
			skipped++;
			// The trace knows the flight better; the CSV row knows the tail
			// number. Adopt it onto an overlapped outing that has none.
			if (row.registration != null) {
				for (const m of over.length > 0 ? over : collides) {
					if (m.aircraftKey != null) {
						continue;
					}
					const next: OutingMeta = { ...m, aircraftKey: row.registration };
					try {
						await putMeta(next);
					} catch {
						continue;
					}
					metas[metas.indexOf(m)] = next;
					upsertRow(next);
				}
			}
			continue;
		}
		const meta: OutingMeta = {
			id: f.blockOffMs,
			savedAtMs: Date.now(),
			datum: 'msl',
			aircraftKey: row.registration,
			remarks: row.remarks,
			source: 'logbook',
			// The pilot's own declarations ride along untouched: this app
			// cannot attest a function time, so it may not invent one and it
			// may not drop one either (docs/logbook.md).
			...(Object.keys(row.declared).length > 0 ? { declared: row.declared } : {}),
			derivedV: DERIVED_V,
			flights: [f],
		};
		try {
			await putMeta(meta);
		} catch {
			skipped++;
			continue;
		}
		metas.push(meta);
		upsertRow(meta);
		added++;
	}
	return { added, skipped };
}

/** Archive the LIVE outing. The capture runs SYNCHRONOUSLY to the first
 *  await (importTrace replaces nav.points right after its inline stop, so
 *  the settle hook must not read nav later): points snapshot, datum,
 *  aircraft key. Nothing about the plan is captured ON THE OUTING: the
 *  trace->plan link is the matcher's to compute against the current
 *  catalog (state/flightLinks), and the background pass picks the outing
 *  up as uncached. What DOES happen, for a recording only, is that the
 *  flown plan is put INTO that catalog if it is not there yet, so the
 *  matcher has something to find; see storeFlownPlan.
 *
 *  `reason` says which settle instant this is (navRecording's hook). An
 *  IMPORT is excluded from the plan store on purpose: a trace that
 *  arrived as a file says nothing about what is planned on screen. */
export async function archiveCurrentOuting(
	reason: OutingSettleReason = 'stop',
): Promise<ArchiveResult> {
	if (typeof indexedDB === 'undefined') {
		return { kind: 'unavailable' };
	}
	const points = $state.snapshot(nav.points);
	if (points.length === 0) {
		return { kind: 'noTakeoff' };
	}
	const datum = traceAltDatum();
	const aircraftKey = aircraftState.selectedKey;
	// Read synchronously with the points and the datum: the source is part of
	// the same snapshot, and an await between them could file a trace with
	// another one's file.
	const source = currentTraceSource();
	const result = await archiveOuting(points, { datum, aircraftKey, source });
	// Only once the flight itself is safely filed, and never for an import
	// or a boot REFILE of an already-filed flight: neither says anything
	// about the plan on screen. Fire-and-forget like the archive that
	// called us: storeFlownPlan refuses by itself when there is nothing to
	// add, and a catalog that will not take the plan must not cost the
	// flight its row.
	if (result.kind === 'archived' && reason !== 'import' && reason !== 'refile') {
		void storeFlownPlan();
	}
	return result;
}

/** Non-reactive in-flight guard, deliberately NOT the reactive `loading`
 *  field: the surface calls refreshList from an $effect, and a guard that
 *  READS reactive state in the synchronous phase subscribes that effect
 *  to it, looping the listing forever (each loading flip re-ran the
 *  effect; with an empty library the note sat on "Loading" for good).
 *  `loading` stays for display alone. */
let listing = false;
/** A listing asked for while one runs is REMEMBERED and runs once more
 *  (the refreshPlans / ensureLinks shape). Without it, the assignment
 *  below is a wholesale replacement that can drop an outing archived
 *  while the read was in flight: at boot the surface's open effect and
 *  the crash-recovery archive race exactly that way, and the row would
 *  stay missing until something else re-listed. */
let relist = false;

/** List the library (the surface's open effect). One lazy re-derivation
 *  pass per session follows the first successful listing. */
export async function refreshList(): Promise<void> {
	if (listing) {
		relist = true;
		return;
	}
	listing = true;
	flightLibrary.loading = true;
	try {
		do {
			relist = false;
			const metas = await getMetas();
			metas.sort((a, b) => b.id - a.id);
			flightLibrary.rows = metas;
			flightLibrary.loaded = true;
		} while (relist);
	} finally {
		flightLibrary.loading = false;
		listing = false;
	}
	void rederiveStale();
}

let rederivedOnce = false;

/** Refresh rows whose summary predates DERIVED_V (or was derived without
 *  the airports dataset), serially in the background: load points,
 *  rebuild, RE-GET the meta (a delete racing this pass must not be
 *  resurrected by the upsert), store, update the listing in place. Rows
 *  whose points are missing keep their stored summary and stay stale.
 *  TRACE rows only: a logbook row IS its stored summary and has no points
 *  by construction, so it can never satisfy DERIVED_V and would cost one
 *  fruitless store read per session, for ever. */
async function rederiveStale(): Promise<void> {
	if (rederivedOnce) {
		return;
	}
	rederivedOnce = true;
	const stale = flightLibrary.rows.filter(
		(r) => r.source === 'trace' && r.derivedV < DERIVED_V,
	);
	if (stale.length === 0) {
		return;
	}
	try {
		await ensureAirports();
	} catch {
		return; // stored summaries stand; natural retry next session
	}
	if (!dataState.airportsLoaded) {
		return;
	}
	for (const row of stale) {
		const points = await getPoints(row.id);
		if (!points) {
			continue;
		}
		const motion = extendMotion(newMotionFold(), points);
		const flights = summarizeFlights(points, motion, summaryDeps(row.datum));
		const current = await getMeta(row.id);
		if (!current) {
			continue; // deleted while this pass ran
		}
		const next: OutingMeta = { ...current, flights, derivedV: DERIVED_V };
		try {
			await putMeta(next);
		} catch {
			continue;
		}
		upsertRow(next);
	}
}

/** The stored points of one outing (replay load, GPX export); null when
 *  missing. */
export async function outingPoints(id: number): Promise<TrackPoint[] | null> {
	return getPoints(id);
}

/** Delete one recorded outing (meta + points). Failures degrade silently:
 *  the row stays listed and the next attempt retries. */
export async function removeOuting(id: number): Promise<void> {
	try {
		await deleteOuting(id);
	} catch {
		return;
	}
	// User-intent deletion: record the sync tombstone (a no-op while the
	// doc was never adopted into an account); the device-wipe paths call
	// flightsDb directly and bypass it on purpose.
	void recordSyncTombstone('outings', String(id));
	flightLibrary.rows = flightLibrary.rows.filter((r) => r.id !== id);
	// deleteOuting drops the CACHED link row; the reactive twin is pruned
	// by the next link pass, which is the only place that knows both sides
	// (state/flightLinks.svelte.ts, and importing it here would cycle).
}

// --- sync appliers ---------------------------------------------------------
// The remote side of docs/accounts-sync.md: applied docs come through
// HERE, never through raw store writes, so the supersede convergence and
// the listing stay exactly what a local archive produces. None of these
// record tombstones themselves (a remote apply is not a user-intent
// delete); the one deletion they CAUSE, the arriving logbook row a local
// trace supersedes, is answered to the caller as 'superseded' so the
// replicator pushes the tombstone under the doc's own rev.

/** The authored half of a remote outing doc (the payload's parse). */
export interface RemoteOutingAuthored {
	id: number;
	savedAtMs: number;
	datum: AltDatum;
	aircraftKey: string | null;
	remarks: string;
	source: 'trace' | 'logbook';
	declared?: Readonly<Record<string, string>> | undefined;
	flights?: FlightSummary[] | undefined;
}

/** Upsert a remote outing's AUTHORED fields. A trace row keeps whatever
 *  this device already derived (flights[] and derivedV are local, the
 *  points blob re-derives them); a logbook row's summary IS its source
 *  data and lands verbatim. Answers 'superseded' when a local TRACE
 *  already covers an arriving logbook row's span: the row is not kept,
 *  and the caller pushes the deletion (the supersede convergence,
 *  whichever device the trace and the CSV row reach first). `covers`
 *  narrows WHICH local traces count: the sync layer excludes the ones
 *  held back from adoption, since a leftover on a shared machine is no
 *  evidence against the account's own logbook row. */
export async function applyRemoteOuting(
	a: RemoteOutingAuthored,
	covers: (traceId: number) => boolean = () => true,
): Promise<'applied' | 'superseded'> {
	const current = await getMeta(a.id);
	const meta: OutingMeta = {
		id: a.id,
		savedAtMs: a.savedAtMs,
		datum: a.datum,
		aircraftKey: a.aircraftKey,
		remarks: a.remarks,
		source: a.source,
		...(a.source === 'logbook' && a.declared !== undefined ? { declared: a.declared } : {}),
		derivedV: a.source === 'logbook' ? DERIVED_V : (current?.derivedV ?? 0),
		flights: a.source === 'logbook' ? (a.flights ?? []) : (current?.flights ?? []),
	};
	if (a.source === 'logbook') {
		const span = outingSpan(meta);
		if (span) {
			const metas = await getMetas();
			const covered = metas.some((m) => {
				if (m.source !== 'trace' || m.id === meta.id || !covers(m.id)) {
					return false;
				}
				const s = outingSpan(m);
				return s != null && spansOverlap(s, span.fromMs, span.toMs);
			});
			if (covered) {
				return 'superseded';
			}
		}
	}
	await putMeta(meta);
	upsertRow(meta);
	return 'applied';
}

/** Remove a remotely-deleted outing (meta, points, source, link row).
 *  Never records a tombstone: this IS a tombstone landing. */
export async function applyRemoteOutingDelete(id: number): Promise<void> {
	// No catch: a failed delete must throw so the pass aborts with
	// lastSeq unadvanced; swallowing it would consume the tombstone.
	await deleteOuting(id);
	flightLibrary.rows = flightLibrary.rows.filter((r) => r.id !== id);
}

/** Land a pulled points (and source) blob under an applied outing, then
 *  derive: outingSpan is null while flights is empty, so the supersede
 *  convergence for TRACE rows can only run once the points are here,
 *  and the once-per-session rederiveStale has usually already run. */
export async function applyOutingBlobs(
	id: number,
	points: TrackPoint[],
	source?: TraceSource,
): Promise<void> {
	const current = await getMeta(id);
	if (!current) {
		return; // deleted while the blob travelled
	}
	await putOuting(current, points, source);
	await rederiveOuting(id);
}

/** Re-derive ONE outing from its stored points (the blob-arrival nudge
 *  beside the once-per-session rederiveStale), supersede included. */
export async function rederiveOuting(id: number): Promise<void> {
	const points = await getPoints(id);
	if (!points || points.length === 0) {
		return;
	}
	try {
		await ensureAirports();
	} catch {
		/* places stay empty; derivedV 0 re-derives them later */
	}
	const current = await getMeta(id);
	if (!current) {
		return;
	}
	const motion = extendMotion(newMotionFold(), points);
	const flights = summarizeFlights(points, motion, summaryDeps(current.datum));
	const next: OutingMeta = {
		...current,
		flights,
		derivedV: dataState.airportsLoaded ? DERIVED_V : 0,
	};
	try {
		await putMeta(next);
	} catch {
		return;
	}
	upsertRow(next);
	await supersedeLogbookRows(next);
}

/** The Reset group's wipe (store clear, never deleteDatabase). */
export async function wipeFlights(): Promise<void> {
	try {
		await clearAllOutings();
	} catch {
		/* reset proceeds; an unreachable db has nothing worth keeping */
	}
	flightLibrary.rows = [];
}

// --- Module init -----------------------------------------------------------
// The hook registration (this module is in the BOOT graph: navRecording,
// SyncHost, NavigationTab, reset and traceFile import it statically, while
// FlightsModal, once its eager importer, is now a lazy chunk; so it still
// precedes any runtime stop) and the
// pure-crash archive: a restored trace whose stop never fired (the web
// crash case; the async Android boot reconcile loses this race safely and
// re-adds at its own settle).
//
// The boot archive waits for the route-workspace restore. Its original
// reason is GONE: an outing used to snapshot the flown plan, so filing
// before the restore froze an empty one, and nothing about the plan is
// stored any more (the link is dynamic). What the await still buys is the
// recording flag it re-checks on the other side: the Android boot
// reconcile can flip nav.recording asynchronously, and a recording that
// began during the restore must settle itself later rather than be
// archived mid-flight from here. Guarded off node / test environments,
// where PersistHost never mounts and the promise never settles.
if (typeof indexedDB !== 'undefined') {
	setOutingSettledHook((reason) => {
		void archiveCurrentOuting(reason);
	});
	void whenRoutesRestored().then(async () => {
		// A trace the boot decided is HISTORY rather than the flight you are
		// on was parked instead of drawn (navRecording's restore). File it
		// from there, and only once the row is really written let it go: the
		// flights row is then the way back to it (its replay loads the points
		// through restoreOuting). Any other outcome adopts it, because this
		// side would otherwise hold the only copy and drop it. This branch
		// runs AHEAD of the recording gate below: the parked trace is a
		// finished flight, not the live slot, so a recording begun during the
		// restore must not strand it unfiled (its crash copy is the one
		// startRecording's clearTrace just removed).
		const parked = pendingRestoredTrace();
		if (parked) {
			// Whether this flight is NEW to the library, asked BEFORE the
			// upsert makes it look filed either way. A crash copy can outlive
			// the flight it belongs to by days, its row long since written at
			// a proper stop; re-filing it is free, but attributing today's
			// workspace to it is not, so the plan store below is for the
			// genuinely unfiled case only.
			const first = (await getMeta(parked.points[0].timeMs)) === null;
			const result = await archiveOuting(parked.points, {
				datum: parked.datum,
				aircraftKey: aircraftState.selectedKey,
			});
			if (result.kind === 'archived') {
				dropPendingTrace();
				if (first) {
					// The same tail archiveCurrentOuting runs: this flight was
					// cut short of its own stop (a crash, a force-stop), so the
					// plan it was flown with never reached the catalog either.
					// The workspace restore has settled by now, so it holds it.
					void storeFlownPlan();
				}
			} else {
				adoptPendingTrace();
			}
			return;
		}
		if (nav.recording) {
			return;
		}
		// The ADOPTED trace gets the same first-check the parked branch has,
		// for the same reason: a boot inside the outing window re-archives an
		// ALREADY-FILED flight (the upsert is free and still answers
		// 'archived'), and running the plan store on that would mint whatever
		// scratch workspace happens to be on screen into the catalog. 'refile'
		// is 'boot' minus the plan store.
		const pts = nav.points;
		const first = pts.length > 0 && (await getMeta(pts[0].timeMs)) === null;
		void archiveCurrentOuting(first ? 'boot' : 'refile');
	});
}
