/* The store side of the replicator (docs/accounts-sync.md): enumerate
 * the five collections through the existing chokepoints, apply wire
 * docs through the LIBRARY-OWNED appliers (never raw store writes), and
 * codec the outing blobs. Downstream of every state module by design,
 * which is what keeps the import graph a DAG (the plans applier cannot
 * live in activePlan: activePlan -> flightLinks -> flightLibrary ->
 * activePlan would cycle).
 *
 * Payload rules are model.ts's; the one subtlety here is that plan and
 * aircraft payloads are the stored TEXT verbatim while outings carry
 * canonical JSON, and that a trace row's blobs load LAZILY, only when
 * the doc actually pushes. */

import { deflateRaw, inflateRaw } from '$lib/files/deflate';
import {
	deleteStoredPlan,
	getMetasStrict,
	getPoints,
	getStoredPlansStrict,
	getTraceSource,
	putStoredPlan,
	type TraceSource,
} from '$lib/state/flightsDb';
import {
	applyOutingBlobs,
	applyRemoteOuting,
	applyRemoteOutingDelete,
	type RemoteOutingAuthored,
} from '$lib/state/flightLibrary.svelte';
import { acquirePlanStoring, detachFromPlan } from '$lib/state/activePlan.svelte';
import {
	applyRemoteAircraft,
	applyRemoteAircraftDelete,
	applyRemoteTankedFuel,
	tankedFuelSnapshot,
	userPlaneYamls,
} from '$lib/state/aircraft.svelte';
import { applyRemotePilot, pilotSnapshot } from '$lib/state/flightPrep.svelte';
import { parseAircraftYaml, stringifyAircraftYaml, aircraftKey } from '$lib/aircraft/schema';
import { readPlanName, withPlanName } from '$lib/route/yaml';
import { t } from '$lib/state/i18n.svelte';
import type { TrackPoint } from '$lib/nav/trace';
import { sha256Hex, sha256HexOfText, utf8Bytes } from './fingerprint';
import {
	acstatePayload,
	outingPayload,
	pilotPayload,
	pointsPayload,
	unwrapBlobBytes,
	wrapBlobBytes,
	type BlobRef,
	type SyncCollection,
} from './model';
import type { ReplicaApply, ReplicaBlobs, ReplicaDoc } from './replicate';
import { docKey, type RegistryDocEntry } from '$lib/state/syncRegistry';

/** Inflated blob ceiling, the getTraceSource posture. */
const BLOB_INFLATED_MAX = 64 * 1024 * 1024;

// Whether a pass touched the plan catalog: the engine runs the listing
// refresh + link invalidation ONCE per pass rather than per doc.
let plansTouched = false;

export function takePlansTouched(): boolean {
	const out = plansTouched;
	plansTouched = false;
	return out;
}

// --- enumerate -------------------------------------------------------------

function isDefaultPilot(p: { name: string; sepValidUntil: string | null; medicalValidUntil: string | null }): boolean {
	return p.name === '' && p.sepValidUntil === null && p.medicalValidUntil === null;
}

/** Every local doc of the five collections. `entryOf` answers the
 *  registry's entry per doc key: its known blob refs let a meta-only edit
 *  on a row whose points were never fetched hold its push until they
 *  are, and its mere presence keeps a TRACKED singleton (the pilot
 *  block, the tanked-fuel map) in the listing once it is cleared back to
 *  defaults, so the clearing pushes as an edit instead of the doc
 *  reading as evicted and the server's copy coming back over it.
 *  THROWS when a store cannot be read (the strict variants): the pass
 *  must abort rather than mistake a blocked tab for an empty library. */
export async function listLocalDocs(
	entryOf: (col: SyncCollection, id: string) => RegistryDocEntry | undefined,
): Promise<ReplicaDoc[]> {
	const out: ReplicaDoc[] = [];
	for (const p of await getStoredPlansStrict()) {
		out.push({
			col: 'plans',
			id: p.id,
			payloadText: p.yaml,
			meta: { savedAtMs: p.savedAtMs },
		});
	}
	for (const meta of await getMetasStrict()) {
		const id = String(meta.id);
		const declared = meta.declared !== undefined && Object.keys(meta.declared).length > 0;
		out.push({
			col: 'outings',
			id,
			payloadText: outingPayload(meta),
			meta: {},
			declaredNonEmpty: declared,
			...(meta.source === 'trace'
				? { blobs: outingBlobsLoader(meta.id, entryOf('outings', id)?.blobs) }
				: {}),
		});
	}
	for (const [key, yaml] of Object.entries(userPlaneYamls())) {
		out.push({ col: 'aircraft', id: key, payloadText: yaml, meta: {} });
	}
	const tanked = tankedFuelSnapshot();
	if (Object.keys(tanked).length > 0 || entryOf('acstate', 'tanked-fuel') !== undefined) {
		out.push({
			col: 'acstate',
			id: 'tanked-fuel',
			payloadText: acstatePayload(tanked),
			meta: {},
		});
	}
	const pilot = pilotSnapshot();
	if (!isDefaultPilot(pilot) || entryOf('pilot', 'pilot') !== undefined) {
		out.push({ col: 'pilot', id: 'pilot', payloadText: pilotPayload(pilot), meta: {} });
	}
	return out;
}

function outingBlobsLoader(
	id: number,
	known: BlobRef[] | undefined,
): () => Promise<ReplicaBlobs | null> {
	return async () => {
		const points = await getPoints(id);
		if (!points || points.length === 0) {
			// Meta-only row (the blob never fetched here): a meta edit waits
			// for the trickle rather than pushing refs it cannot restate.
			return known && known.length > 0 ? null : { refs: [], bytes: new Map() };
		}
		let source: TraceSource | null;
		try {
			source = await getTraceSource(id);
		} catch {
			return null; // unreadable this pass (a blocked tab); retried later
		}
		const text = pointsPayload(points);
		const ptsHash = await sha256HexOfText(text);
		const ptsBytes = wrapBlobBytes(await deflateRaw(utf8Bytes(text)));
		const refs: BlobRef[] = [{ h: ptsHash, n: ptsBytes.length }];
		const bytes = new Map<string, Uint8Array>([[ptsHash, ptsBytes]]);
		const meta: Record<string, unknown> = { pts: ptsHash };
		if (source) {
			const srcHash = await sha256Hex(source.bytes);
			const srcBytes = wrapBlobBytes(await deflateRaw(source.bytes));
			refs.push({ h: srcHash, n: srcBytes.length });
			bytes.set(srcHash, srcBytes);
			meta.src = { h: srcHash, name: source.name, format: source.format };
		}
		return { refs, bytes, meta };
	};
}

// --- apply -----------------------------------------------------------------

const DATUMS: readonly string[] = ['msl', 'ellipsoid'];

function parseOutingAuthored(text: string): RemoteOutingAuthored | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const o = raw as Partial<RemoteOutingAuthored> | null;
	if (
		!o ||
		typeof o !== 'object' ||
		typeof o.id !== 'number' ||
		typeof o.savedAtMs !== 'number' ||
		typeof o.datum !== 'string' ||
		!DATUMS.includes(o.datum) ||
		typeof o.remarks !== 'string' ||
		(o.source !== 'trace' && o.source !== 'logbook') ||
		(o.aircraftKey !== null && typeof o.aircraftKey !== 'string')
	) {
		return null;
	}
	return {
		id: o.id,
		savedAtMs: o.savedAtMs,
		datum: o.datum,
		aircraftKey: o.aircraftKey,
		remarks: o.remarks,
		source: o.source,
		...(o.declared !== undefined ? { declared: o.declared } : {}),
		...(Array.isArray(o.flights) ? { flights: o.flights } : {}),
	};
}

/** Apply one wire doc through the library chokepoints. Throws when the
 *  plans store is briefly busy (the pass aborts and retries at the next
 *  trigger, its registry unwritten, so nothing is lost). */
export async function applyWireDoc(a: ReplicaApply): Promise<'applied' | 'superseded' | void> {
	const { doc, payloadText, heldBack } = a;
	switch (doc.col) {
		case 'plans': {
			if (doc.deleted) {
				detachFromPlan(doc.id);
				await deleteStoredPlan(doc.id);
				plansTouched = true;
				return;
			}
			if (payloadText === null) {
				return;
			}
			const release = acquirePlanStoring();
			if (!release) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('sync: plan store busy');
			}
			try {
				const savedAtMs =
					typeof doc.meta.savedAtMs === 'number' ? doc.meta.savedAtMs : doc.updatedAt;
				await putStoredPlan({ id: doc.id, yaml: payloadText, savedAtMs });
			} finally {
				release();
			}
			plansTouched = true;
			return;
		}
		case 'outings': {
			const id = Number(doc.id);
			if (!Number.isFinite(id)) {
				return;
			}
			if (doc.deleted) {
				await applyRemoteOutingDelete(id);
				return;
			}
			if (payloadText === null) {
				return;
			}
			const authored = parseOutingAuthored(payloadText);
			if (!authored || authored.id !== id) {
				return; // unusable content is skipped, tracked, never fatal
			}
			// Only a trace the account holds (or is adopting) may supersede
			// an arriving logbook row: a held-back leftover is not the
			// account's evidence of that flight.
			return applyRemoteOuting(
				authored,
				heldBack ? (traceId) => !heldBack.has(docKey('outings', String(traceId))) : undefined,
			);
		}
		case 'aircraft': {
			if (doc.deleted) {
				applyRemoteAircraftDelete(doc.id);
				return;
			}
			if (payloadText !== null) {
				applyRemoteAircraft(payloadText);
			}
			return;
		}
		case 'acstate': {
			if (doc.deleted || payloadText === null) {
				applyRemoteTankedFuel({});
				return;
			}
			try {
				const parsed = JSON.parse(payloadText) as { types?: Record<string, string> };
				applyRemoteTankedFuel(parsed.types ?? {});
			} catch {
				/* unusable content: skip */
			}
			return;
		}
		case 'pilot': {
			if (doc.deleted || payloadText === null) {
				return;
			}
			try {
				const p = JSON.parse(payloadText) as {
					name?: unknown;
					sepValidUntil?: unknown;
					medicalValidUntil?: unknown;
				};
				applyRemotePilot({
					name: typeof p.name === 'string' ? p.name : '',
					sepValidUntil: typeof p.sepValidUntil === 'string' ? p.sepValidUntil : null,
					medicalValidUntil:
						typeof p.medicalValidUntil === 'string' ? p.medicalValidUntil : null,
				});
			} catch {
				/* unusable content: skip */
			}
			return;
		}
	}
}

// --- conflict copies -------------------------------------------------------

function isoDay(): string {
	return new Date().toISOString().slice(0, 10);
}

/** Re-file conflicted content as a NEW local doc (docs/accounts-sync.md:
 *  copies are CLIENT-made, the server never edits a payload). Plans fork
 *  under an id DERIVED from the losing side (origin doc + rev), so a
 *  pass retried after the refile upserts the same copy instead of
 *  manufacturing another; an aircraft sheet re-keys its registration so
 *  the fleet can hold both, visibly. Only the two `copy` collections
 *  ever reach here. Answers the copy's doc id (the replicator holds a
 *  copy of held-back content back with it), null when nothing was
 *  filed. */
export async function refileDoc(
	col: SyncCollection,
	payloadText: string,
	_meta: Record<string, unknown>,
	origin: { id: string; rev: number },
): Promise<string | null> {
	if (col === 'plans') {
		const base = readPlanName(payloadText);
		const marker = t.account.conflictCopy(isoDay());
		const caption = base === null ? marker : `${base} ${marker}`;
		const release = acquirePlanStoring();
		if (!release) {
			// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
			throw new Error('sync: plan store busy');
		}
		const id = `pc-${origin.id}-r${origin.rev}`;
		try {
			await putStoredPlan({
				id,
				yaml: withPlanName(payloadText, caption),
				savedAtMs: Date.now(),
			});
		} finally {
			release();
		}
		plansTouched = true;
		return id;
	}
	if (col === 'aircraft') {
		const planes = userPlaneYamls();
		if (Object.values(planes).includes(payloadText)) {
			return null; // the fleet already holds this exact sheet: nothing to save
		}
		let a;
		try {
			a = parseAircraftYaml(payloadText);
		} catch {
			return null; // an unparsable loser has nothing to preserve
		}
		const existing = new Set(Object.keys(planes));
		const reg = a.identity.registration ?? a.identity.type;
		for (let i = 2; i < 10; i++) {
			const candidate = `${reg} (${i})`;
			if (!existing.has(candidate)) {
				a.identity.registration = candidate;
				break;
			}
		}
		if (aircraftKey(a) === reg) {
			return null; // nine copies deep: stop manufacturing planes
		}
		return applyRemoteAircraft(stringifyAircraftYaml(a));
	}
	return null;
}

// --- blob download ---------------------------------------------------------

/** Unframe, inflate and VERIFY a fetched blob against its address; null
 *  on any mismatch (the caller counts the retry and never applies). */
export async function decodeBlob(stored: Uint8Array, expectHash: string): Promise<Uint8Array | null> {
	try {
		const inflated = await inflateRaw(unwrapBlobBytes(stored), BLOB_INFLATED_MAX);
		return (await sha256Hex(inflated)) === expectHash ? inflated : null;
	} catch {
		return null;
	}
}

function validPoints(raw: unknown): TrackPoint[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	for (const p of raw as Partial<TrackPoint>[]) {
		if (
			!p ||
			typeof p.lat !== 'number' ||
			typeof p.lon !== 'number' ||
			typeof p.timeMs !== 'number' ||
			(p.altFt !== null && typeof p.altFt !== 'number')
		) {
			return null;
		}
	}
	return raw as TrackPoint[];
}

/** Land a fetched outing blob pair: decode the points (and the pristine
 *  source when the doc names one) and apply through the library. The
 *  fetches themselves are the engine's (it owns the token and the retry
 *  budget); this is the pure landing. */
export async function landOutingBlobs(
	id: number,
	docMeta: Record<string, unknown>,
	fetched: Map<string, Uint8Array>,
): Promise<boolean> {
	const ptsHash = typeof docMeta.pts === 'string' ? docMeta.pts : null;
	if (!ptsHash) {
		return false;
	}
	const ptsStored = fetched.get(ptsHash);
	if (!ptsStored) {
		return false;
	}
	const ptsInflated = await decodeBlob(ptsStored, ptsHash);
	if (!ptsInflated) {
		return false;
	}
	let points: TrackPoint[] | null;
	try {
		points = validPoints(JSON.parse(new TextDecoder().decode(ptsInflated)));
	} catch {
		return false;
	}
	if (!points) {
		return false;
	}
	let source: TraceSource | undefined;
	const src = docMeta.src as { h?: unknown; name?: unknown; format?: unknown } | undefined;
	if (src && typeof src.h === 'string') {
		const stored = fetched.get(src.h);
		if (stored) {
			const bytes = await decodeBlob(stored, src.h);
			if (bytes) {
				source = {
					name: typeof src.name === 'string' ? src.name : '',
					format: (typeof src.format === 'string' ? src.format : 'gpx') as TraceSource['format'],
					bytes,
				};
			}
		}
	}
	await applyOutingBlobs(id, points, source);
	return true;
}
