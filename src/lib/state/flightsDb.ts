/* IndexedDB store for the flights library (docs/flights-library.md): the
 * archived outings' META rows (small, listed on surface open) and their
 * full point arrays (loaded on demand: replay, GPX export, re-derivation),
 * both keyed by the outing id. The passiveStore house style: one memoised
 * connection, defensive upgrades, reads degrade to empty while ARCHIVE
 * writes propagate to the caller (silently losing a flight is the one
 * failure this store must not eat). Not native-gated: the library serves
 * the web and the Android shell alike. */

import { deflateRaw, inflateRaw } from '$lib/files/deflate';
import type { AltDatum } from '$lib/nav/altitudeDatum';
import type { FlightSummary } from '$lib/nav/logbook';
import type { TrackPoint } from '$lib/nav/trace';
import type { TraceFormat } from '$lib/nav/traceExport';

const DB_NAME = 'loxodrome-flights';
const DB_VERSION = 5;
const META = 'outings';
const POINTS = 'points';
const PLANS = 'plans';
const LINKS = 'links';
const SOURCES = 'sources';

/** What an inflated source may grow to. A trace file is text; the cap is a
 *  guard on a corrupted record, not a budget. */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

/** One remembered route plan, the batch importer's plan catalog: traces
 *  imported LATER (another pick, another session) still match against
 *  it. Keyed by an OPAQUE id: the identity the UI shows is the plan's
 *  ROUTE, never a file name (the Garmin catalog posture; the imported
 *  file's name is deliberately not kept - recorded decision). The
 *  v2->v3 migration reuses the old name key as the id, so persisted
 *  provenance pointers keep matching. */
export interface StoredPlan {
	id: string;
	yaml: string;
	savedAtMs: number;
}

/** Mint a catalog id for a store-created entry. */
export function newPlanId(): string {
	return `p${Date.now().toString(36)}${Math.floor(Math.random() * 1679616)
		.toString(36)
		.padStart(4, '0')}`;
}

export interface OutingMeta {
	/** points[0].timeMs: stable across Continue-extends, so the archive is
	 *  an idempotent upsert (the crash copy's downsample keeps the first
	 *  point; only the MAX_POINTS drop-oldest would shift it, far above any
	 *  real flight). */
	id: number;
	savedAtMs: number;
	/** The datum the stored altitudes are on, RESOLVED at archive time so
	 *  re-derivation, replay and GPX export need no live answer. */
	datum: AltDatum;
	/** The selected aircraft at archive time; null when none was. A frozen
	 *  context: it is not in the trace and would be mis-guessed later. */
	aircraftKey: string | null;
	/* The trace->plan LINK is deliberately NOT here: it is purely dynamic
	 * (state/flightLinks.svelte.ts), recomputed against the CURRENT
	 * catalog and cached only behind a catalog-content hash, so no stored
	 * meta can ever assert a historic link (recorded decision: a frozen
	 * copy resurrected old plans; a stored id drifted). Rows written
	 * before this carried planYaml / planId / routeLabels; the normalize
	 * strips them. */
	/** The imported logbook row's own remark string (SOURCE data, not a
	 *  link): '' on trace rows, whose route display is the dynamic link's.
	 *  Old logbook rows stored it as routeLabels; normalized across. */
	remarks: string;
	/** Where the row came from: 'trace' rows are derived from stored
	 *  points; 'logbook' rows were imported from an AMC-shaped CSV and
	 *  hold NO points (no replay, no GPX, no re-derivation; a later trace
	 *  of the same flight supersedes them). Absent on old rows,
	 *  normalized to 'trace'. */
	source: 'trace' | 'logbook';
	/** A 'logbook' row's pilot-DECLARED cells, exactly as its CSV stated
	 *  them (nav/logbook.ts DECLARED_COLUMNS: crew and engine
	 *  configuration, the function times, IFR, FSTD, and the PIC name).
	 *  Never derived, never interpreted, re-emitted verbatim by the CSV
	 *  export: this application cannot attest a legal role, so dropping
	 *  what the source declared would corrupt the very record the export
	 *  feeds. Absent on trace rows and on rows written before this. */
	declared?: Readonly<Record<string, string>> | undefined;
	/** The derivation version flights[] was built with; 0 = built without
	 *  the airports dataset (places empty), the staleness sentinel the lazy
	 *  re-derivation refreshes. */
	derivedV: number;
	flights: FlightSummary[];
}

interface PointsRow {
	id: number;
	points: TrackPoint[];
}

/** The PRISTINE file an imported trace arrived as (docs/trace-files.md).
 *
 *  Points are a derivation of it and a lossy one: the app models neither an
 *  IGC's security record, pressure altitude and ENL, nor a GPX's extensions,
 *  so re-synthesising a third-party file on export would hand back a
 *  different document under the same claim. The bytes are the one thing in
 *  this library that cannot be regenerated, so they are the one thing stored
 *  verbatim. A RECORDED trace has no source and is synthesised at export in
 *  the format the Settings tab names.
 *
 *  Its own store, not a field on the meta: `getMetas` reads every meta row on
 *  each surface open, which is exactly why `points` has its own store too.
 *  Deflated on the way in (a trace text is about a tenth of its size
 *  compressed, against points that are already the bulk of an evictable
 *  library). */
export interface TraceSource {
	/** The name the file arrived under, kept verbatim: unlike a plan, whose
	 *  identity is its route, a trace's name is the user's own
	 *  ("2026-05-12_LFPL_LFQB.gpx") and nothing else can restate it. '' when
	 *  the provider published none. Reduced to a BASE name on the way in: it
	 *  reaches ZIP entry names and Filesystem.writeFile paths, and an archive
	 *  member called `files/doc.kml` or `../../x.gpx` must not steer either. */
	name: string;
	format: TraceFormat;
	/** The file's BYTES, never a decoded string. A string round trip is lossy
	 *  and silently so: a BOM vanishes through TextDecoder/TextEncoder and any
	 *  byte that is not valid UTF-8 becomes U+FFFD, which an ISO-8859-1 IGC
	 *  header really does carry - and an IGC whose bytes moved is an IGC whose
	 *  G security record no longer validates. Storing bytes is the whole
	 *  point; storing text would have made the promise false. */
	bytes: Uint8Array;
}

interface SourceRow {
	id: number;
	name: string;
	format: TraceFormat;
	deflated: Uint8Array;
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Forget the memoised connection so the next call opens a fresh one. A
 *  dead handle is worse than no handle: every transaction on it throws,
 *  and the reads below turn that into an EMPTY library rather than an
 *  error, so a closed connection would read as "you have no flights". */
function forget(p: Promise<IDBDatabase>): void {
	if (dbPromise === p) {
		dbPromise = null;
	}
}

function db(): Promise<IDBDatabase> {
	if (dbPromise) {
		return dbPromise;
	}
	// A blocked open is REPORTED without being abandoned: the request stays
	// live and still succeeds if the other tab goes away, so the connection
	// it then hands over has to be closed rather than left open with nobody
	// holding it (it would block the next upgrade in turn).
	let gaveUp = false;
	const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			reject(new Error('indexedDB unavailable'));
			return;
		}
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		// Another TAB holding an older version blocks the upgrade. This ships
		// as a PWA, so two tabs are ordinary, and an unsettled promise here
		// would hang the surface on "Loading" for good and every archive await
		// with it: fail instead, so the caller can say so and a later call can
		// retry.
		req.onblocked = () => {
			gaveUp = true;
			// i18n-ignore: wire diagnostic, stays EN
			reject(new Error('flights db blocked by another tab'));
		};
		req.onupgradeneeded = (ev) => {
			const d = req.result;
			if (!d.objectStoreNames.contains(META)) {
				d.createObjectStore(META, { keyPath: 'id' });
			}
			if (!d.objectStoreNames.contains(POINTS)) {
				d.createObjectStore(POINTS, { keyPath: 'id' });
			}
			if (!d.objectStoreNames.contains(LINKS)) {
				d.createObjectStore(LINKS, { keyPath: 'id' });
			}
			// v5. Rows filed before it simply have no source and synthesise on
			// export exactly as they did, so there is nothing to migrate.
			if (!d.objectStoreNames.contains(SOURCES)) {
				d.createObjectStore(SOURCES, { keyPath: 'id' });
			}
			if (!d.objectStoreNames.contains(PLANS)) {
				d.createObjectStore(PLANS, { keyPath: 'id' });
			} else if (ev.oldVersion < 3) {
				// v2 keyed plans by the imported file's name. Re-key inside the
				// versionchange transaction: collect, drop, recreate, re-put
				// with the old name as the id (persisted provenance pointers
				// keep matching); the name itself is not kept.
				const tx = req.transaction;
				if (tx) {
					const rekey = (rows: { name?: unknown; yaml?: unknown; savedAtMs?: unknown }[]) => {
						d.deleteObjectStore(PLANS);
						const fresh = d.createObjectStore(PLANS, { keyPath: 'id' });
						for (const r of rows) {
							if (typeof r.name !== 'string' || typeof r.yaml !== 'string') {
								continue;
							}
							fresh.put({
								id: r.name,
								yaml: r.yaml,
								savedAtMs: typeof r.savedAtMs === 'number' ? r.savedAtMs : 0,
							} satisfies StoredPlan);
						}
					};
					const getReq = tx.objectStore(PLANS).getAll();
					getReq.onsuccess = () => {
						rekey(
							getReq.result as { name?: unknown; yaml?: unknown; savedAtMs?: unknown }[],
						);
					};
					// The read failing must still re-key the STORE: left on its v2
					// keyPath at version 4, every putStoredPlan would reject for
					// ever and the catalog would be permanently unwritable. A lost
					// catalog is one re-import away; an unwritable one is not.
					getReq.onerror = () => {
						rekey([]);
					};
				}
			}
		};
		req.onsuccess = () => {
			const d = req.result;
			if (gaveUp) {
				d.close(); // the caller gave up; do not leave it open
				return;
			}
			// Another tab asking for a newer version: step aside rather than
			// block it, and forget the handle so the next call reopens.
			d.onversionchange = () => {
				d.close();
				forget(opening);
			};
			// The browser can close a connection under storage pressure; a
			// memoised dead handle throws on every transaction after that.
			d.onclose = () => {
				forget(opening);
			};
			resolve(d);
		};
		// i18n-ignore: wire diagnostic, stays EN
		req.onerror = () => reject(new Error('flights db open failed'));
	});
	// A rejected open is not memoised: a blocked upgrade clears when the
	// other tab goes away, and the next call should find that out.
	dbPromise = opening;
	opening.catch(() => {
		forget(opening);
	});
	return opening;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		// i18n-ignore: wire diagnostic, stays EN
		req.onerror = () => reject(new Error('flights db request failed'));
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		// i18n-ignore: wire diagnostic, stays EN
		tx.onerror = () => reject(new Error('flights db transaction failed'));
		// i18n-ignore: wire diagnostic, stays EN
		tx.onabort = () => reject(new Error('flights db transaction aborted'));
	});
}

/** Archive or refresh one outing (meta + points + the pristine source, one
 *  transaction). Propagates failures to the caller.
 *
 *  `source` is deliberately THREE-state, because the archive is an idempotent
 *  upsert that re-runs on paths which know nothing about the file:
 *
 *  - a `TraceSource`: this outing IS that file; store it.
 *  - `null`: the points are knowingly no longer the file's own (a
 *    Continue-extend, the MAX_POINTS splice), so a stored source must GO
 *    rather than be exported as this outing's.
 *  - `undefined`: no opinion; leave whatever is stored alone. The crash-copy
 *    restore is why this state exists: it re-files a DOWNSAMPLED trace under
 *    the same id, and a two-state API would silently delete the pristine
 *    bytes of an import that survived a reload. */
export async function putOuting(
	meta: OutingMeta,
	points: TrackPoint[],
	source?: TraceSource | null,
): Promise<void> {
	// Compressed before the transaction opens: an IndexedDB transaction goes
	// inactive the moment control returns to the event loop, so awaiting a
	// stream inside one aborts it.
	//
	// A failure here costs the SOURCE and never the flight. CompressionStream
	// could be missing, or the deflate could run out of memory on a large
	// trace; filing no meta and no points for a perfectly good GPX, under a
	// banner telling the pilot to free space, would be much the worse answer.
	// Degrading to `undefined` also leaves any stored source alone.
	let row: SourceRow | null = null;
	let keep = source === undefined;
	if (source) {
		try {
			row = await sourceRow(meta.id, source);
		} catch {
			keep = true; // no opinion: the flight files, the bytes do not
		}
	}
	const d = await db();
	const stores = keep ? [META, POINTS] : [META, POINTS, SOURCES];
	const tx = d.transaction(stores, 'readwrite');
	tx.objectStore(META).put(meta);
	tx.objectStore(POINTS).put({ id: meta.id, points } satisfies PointsRow);
	if (row) {
		tx.objectStore(SOURCES).put(row);
	} else if (!keep) {
		tx.objectStore(SOURCES).delete(meta.id);
	}
	await txDone(tx);
}

async function sourceRow(id: number, source: TraceSource): Promise<SourceRow> {
	return {
		id,
		name: baseName(source.name),
		format: source.format,
		deflated: await deflateRaw(source.bytes),
	};
}

/** A file name with no path in it. What arrives here is caller-supplied text
 *  from an archive member or a content provider, and it is written back out
 *  as a ZIP entry name and as a Filesystem path; `OpenFilePlugin.safeName`
 *  guards the inbound side for the same reason. */
function baseName(name: string): string {
	const last = name.replace(/\\/g, '/').split('/').pop() ?? '';
	return last === '.' || last === '..' ? '' : last;
}

/** The pristine file an outing was imported from; null when it has none (a
 *  recording, or a row filed before v5). THROWS when the store could not be
 *  read, which is deliberately not the same answer. */
export async function getTraceSource(id: number): Promise<TraceSource | null> {
	// Deliberately NOT wrapped: a read that FAILED is not "this outing has no
	// source". The database can be blocked by another tab, which is ordinary
	// in a PWA, and answering null there makes an export hand back a
	// re-synthesis under a label promising the original. Only a missing ROW is
	// null; anything else is the caller's to report.
	{
		const d = await db();
		const row = (await reqDone(d.transaction(SOURCES).objectStore(SOURCES).get(id))) as
			| SourceRow
			| undefined;
		if (!row) {
			return null; // this outing has none: a recording, or a pre-v5 row
		}
		return {
			name: baseName(row.name),
			format: row.format,
			bytes: await inflateRaw(row.deflated, MAX_SOURCE_BYTES),
		};
	}
}

/** Refresh one outing's meta alone (the re-derivation upsert). */
export async function putMeta(meta: OutingMeta): Promise<void> {
	const d = await db();
	const tx = d.transaction(META, 'readwrite');
	tx.objectStore(META).put(meta);
	await txDone(tx);
}

/** Rows written before a later optional-context field existed lack it;
 *  normalize at the read chokepoints so consumers never see undefined.
 *  Returns whether anything CHANGED, so a caller can write the normalized
 *  row back: the strip below is otherwise in-memory only and a legacy
 *  planYaml blob would sit in the store for ever. */
function normalizeMeta(m: OutingMeta): { meta: OutingMeta; changed: boolean } {
	const raw = m as unknown as Record<string, unknown>;
	let changed = false;
	// `source` first: the remarks fallback below asks what kind of row this
	// is, and a pre-`source` row answers undefined until it is stamped.
	if (m.source !== 'logbook') {
		changed ||= m.source !== 'trace';
		m.source = 'trace';
	}
	// The link fields of the frozen-copy era die at the read chokepoint;
	// a logbook row's old routeLabels WAS its CSV remark, carried across.
	if (typeof m.remarks !== 'string') {
		m.remarks =
			m.source === 'logbook' && Array.isArray(raw.routeLabels)
				? (raw.routeLabels as unknown[]).filter((x) => typeof x === 'string').join(' / ')
				: '';
		changed = true;
	}
	for (const dead of ['planYaml', 'planId', 'routeLabels']) {
		if (dead in raw) {
			delete raw[dead];
			changed = true;
		}
	}
	return { meta: m, changed };
}

/** Every meta row; empty on any failure (a listing degrades, never throws).
 *  Rows the normalize actually changed are written back, best-effort and
 *  once ever: the frozen-copy era's planYaml blobs are the biggest thing
 *  in this store and nothing else would ever reclaim them. */
export async function getMetas(): Promise<OutingMeta[]> {
	try {
		return await getMetasStrict();
	} catch {
		return [];
	}
}

/** getMetas that THROWS on an unreadable store instead of degrading to
 *  empty: the sync layer must tell "no outings" from "cannot read"
 *  (pushing or counting over a degraded empty would misreport a whole
 *  library as absent). UI listings keep the tolerant form. */
export async function getMetasStrict(): Promise<OutingMeta[]> {
	{
		const d = await db();
		const rows = (await reqDone(
			d.transaction(META).objectStore(META).getAll(),
		)) as OutingMeta[];
		const out: OutingMeta[] = [];
		const rewrite: OutingMeta[] = [];
		for (const row of rows) {
			const { meta, changed } = normalizeMeta(row);
			out.push(meta);
			if (changed) {
				rewrite.push(meta);
			}
		}
		if (rewrite.length > 0) {
			const tx = d.transaction(META, 'readwrite');
			for (const meta of rewrite) {
				tx.objectStore(META).put(meta);
			}
			// The listing does not wait on the reclaim, and does not fail with it.
			txDone(tx).catch(() => {
				/* the rows read fine; the next listing retries */
			});
		}
		return out;
	}
}

export async function getMeta(id: number): Promise<OutingMeta | null> {
	try {
		const d = await db();
		const row = (await reqDone(d.transaction(META).objectStore(META).get(id))) as
			| OutingMeta
			| undefined;
		return row ? normalizeMeta(row).meta : null;
	} catch {
		return null;
	}
}

export async function getPoints(id: number): Promise<TrackPoint[] | null> {
	try {
		const d = await db();
		return (
			((await reqDone(d.transaction(POINTS).objectStore(POINTS).get(id))) as
				| PointsRow
				| undefined)?.points ?? null
		);
	} catch {
		return null;
	}
}

export async function deleteOuting(id: number): Promise<void> {
	const d = await db();
	const tx = d.transaction([META, POINTS, LINKS, SOURCES], 'readwrite');
	tx.objectStore(META).delete(id);
	tx.objectStore(POINTS).delete(id);
	tx.objectStore(LINKS).delete(id);
	tx.objectStore(SOURCES).delete(id);
	await txDone(tx);
}

/** Remember (or replace, same id) one catalog plan. */
export async function putStoredPlan(plan: StoredPlan): Promise<void> {
	const d = await db();
	const tx = d.transaction(PLANS, 'readwrite');
	tx.objectStore(PLANS).put(plan);
	await txDone(tx);
}

/** Forget one remembered plan (the catalog's delete). Deletion never
 *  touches outings: their traces stay stored, and the flights linked to
 *  this entry DETACH on the next link pass, since the link is purely
 *  dynamic and no outing holds a copy of anything. */
export async function deleteStoredPlan(id: string): Promise<void> {
	const d = await db();
	const tx = d.transaction(PLANS, 'readwrite');
	tx.objectStore(PLANS).delete(id);
	await txDone(tx);
}

/** The remembered plan catalog; empty on any failure. */
export async function getStoredPlans(): Promise<StoredPlan[]> {
	try {
		return await getStoredPlansStrict();
	} catch {
		return [];
	}
}

/** The throwing form, for the sync layer (see getMetasStrict). */
export async function getStoredPlansStrict(): Promise<StoredPlan[]> {
	const d = await db();
	return (await reqDone(d.transaction(PLANS).objectStore(PLANS).getAll())) as StoredPlan[];
}

/** One CACHED link computation: which catalog plan the outing's trace
 *  matches, valid only while the catalog still hashes to `catalogHash`
 *  (state/flightLinks.svelte.ts recomputes on any mismatch). planId null
 *  = computed and matched nothing (ambiguous included): a cached
 *  no-link, so unmatched traces are not re-folded every session. */
export interface StoredLink {
	/** The outing id. */
	id: number;
	catalogHash: string;
	planId: string | null;
	labels: string[];
}

export async function putStoredLink(link: StoredLink): Promise<void> {
	const d = await db();
	const tx = d.transaction(LINKS, 'readwrite');
	tx.objectStore(LINKS).put(link);
	await txDone(tx);
}

export async function getStoredLinks(): Promise<StoredLink[]> {
	try {
		const d = await db();
		return (await reqDone(d.transaction(LINKS).objectStore(LINKS).getAll())) as StoredLink[];
	} catch {
		return [];
	}
}

export async function deleteStoredLink(id: number): Promise<void> {
	const d = await db();
	const tx = d.transaction(LINKS, 'readwrite');
	tx.objectStore(LINKS).delete(id);
	await txDone(tx);
}

/** Empty every store (the Reset group's wipe), the plan catalog
 *  included. clear(), never
 *  deleteDatabase: deleteDatabase BLOCKS while the memoised connection
 *  (or another tab) holds the database open, and an awaited hang before
 *  reset's reload is worse than a clear with the same observable result. */
export async function clearAllOutings(): Promise<void> {
	const d = await db();
	const tx = d.transaction([META, POINTS, PLANS, LINKS, SOURCES], 'readwrite');
	tx.objectStore(META).clear();
	tx.objectStore(POINTS).clear();
	tx.objectStore(PLANS).clear();
	tx.objectStore(LINKS).clear();
	tx.objectStore(SOURCES).clear();
	await txDone(tx);
}
