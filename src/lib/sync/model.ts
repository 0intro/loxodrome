/* The sync document model (docs/accounts-sync.md): the collections and
 * their conflict policies, the CANONICAL payload serializers, the
 * content-hash recipe, the encryption envelope and the wire types. Pure:
 * no storage, no network, no Svelte.
 *
 * Canonical form: every JSON payload serializes with RECURSIVELY SORTED
 * object keys. Convergence, push idempotency and the content reconcile
 * all key on the content hash, and JSON.stringify's insertion order
 * would let two code paths (or two app versions) hash identical data
 * differently: spurious conflicts and phantom dirtiness. Plans and
 * aircraft are exempt by construction, their payloads being the stored
 * TEXT verbatim (the server never parses a payload, so the same bytes
 * the file exports produce are the wire form). */

import type { OutingMeta } from '$lib/state/flightsDb';
import type { TrackPoint } from '$lib/nav/trace';

/** The synced collections; everything else is deliberately device-local
 *  (the contract's "What syncs" table). */
export type SyncCollection = 'plans' | 'outings' | 'aircraft' | 'acstate' | 'pilot';

export const SYNC_COLLECTIONS: readonly SyncCollection[] = [
	'plans',
	'outings',
	'aircraft',
	'acstate',
	'pilot',
];

/** Per-collection conflict policy. `copy` keeps both sides (the loser
 *  re-files as a new doc); `lww` resolves by updatedAt. Blobs are
 *  content-addressed and never conflict. */
export type ConflictPolicy = 'copy' | 'lww';

export const COLLECTION_POLICY: Record<SyncCollection, ConflictPolicy> = {
	plans: 'copy',
	outings: 'lww',
	aircraft: 'copy',
	acstate: 'lww',
	pilot: 'lww',
};

/** One content-addressed blob reference: sha256 of the INFLATED bytes,
 *  and the STORED (deflated) size the quota counts. */
export interface BlobRef {
	h: string;
	n: number;
}

// --- canonical JSON --------------------------------------------------------

/** Deterministic JSON: recursively sorted object keys, undefined-valued
 *  properties omitted, nulls kept, finite numbers only (ES fully
 *  specifies Number::toString, so the digits are engine-invariant). */
export function canonicalJson(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	switch (typeof value) {
		case 'string':
		case 'boolean':
			return JSON.stringify(value);
		case 'number':
			if (!Number.isFinite(value)) {
				// i18n-ignore: wire diagnostic, stays EN (docs/i18n.md rule 7)
				throw new Error('canonicalJson: non-finite number');
			}
			return JSON.stringify(value);
		case 'object':
			break;
		default:
			// i18n-ignore: wire diagnostic, stays EN
			throw new Error(`canonicalJson: unsupported ${typeof value}`);
	}
	if (Array.isArray(value)) {
		return `[${value.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
	}
	const o = value as Record<string, unknown>;
	const keys = Object.keys(o)
		.filter((k) => o[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// --- payload serializers ---------------------------------------------------

/** An outing doc's payload: the AUTHORED fields only. `flights[]` and
 *  `derivedV` stay local for trace rows (bumping DERIVED_V must not dirty
 *  every outing on every device; the receiving side re-derives from the
 *  points blob), EXCEPT logbook rows, whose summary IS source data (built
 *  once from the CSV line, no points to rebuild it from) and rides the
 *  payload with the pilot-declared cells. */
export function outingPayload(meta: OutingMeta): string {
	const authored: Record<string, unknown> = {
		aircraftKey: meta.aircraftKey,
		datum: meta.datum,
		id: meta.id,
		remarks: meta.remarks,
		savedAtMs: meta.savedAtMs,
		source: meta.source,
	};
	if (meta.source === 'logbook') {
		authored.flights = meta.flights;
		if (meta.declared !== undefined) {
			authored.declared = meta.declared;
		}
	}
	return canonicalJson(authored);
}

/** The points blob's plaintext: one normalized object per fix. The
 *  required fields always present (`altFt` keeps its meaningful null);
 *  the optional fields (speedKt, trackDeg, accuracyM) are omitted when
 *  null OR absent, since both spell "unknown" and the wire must not hash
 *  them apart. */
export function pointsPayload(points: readonly TrackPoint[]): string {
	const rows = points.map((p) => {
		const row: Record<string, unknown> = {
			altFt: p.altFt,
			lat: p.lat,
			lon: p.lon,
			timeMs: p.timeMs,
		};
		if (p.speedKt != null) {
			row.speedKt = p.speedKt;
		}
		if (p.trackDeg != null) {
			row.trackDeg = p.trackDeg;
		}
		if (p.accuracyM != null) {
			row.accuracyM = p.accuracyM;
		}
		return row;
	});
	return canonicalJson(rows);
}

/** The tanked-fuel singleton doc (`acstate/tanked-fuel`). */
export function acstatePayload(types: Readonly<Record<string, string>>): string {
	return canonicalJson({ types, v: 1 });
}

/** The pilot-identity singleton doc (`pilot/pilot`). */
export function pilotPayload(pilot: {
	name: string;
	sepValidUntil: string | null;
	medicalValidUntil: string | null;
}): string {
	return canonicalJson({
		medicalValidUntil: pilot.medicalValidUntil,
		name: pilot.name,
		sepValidUntil: pilot.sepValidUntil,
	});
}

// --- the content hash ------------------------------------------------------

/** What the content hash is computed OVER: the payload text plus the
 *  blob references, sorted by hash, so a Continue-extend (same authored
 *  meta, new points ref) still reads as a change and a retried push whose
 *  refs already applied still reads as applied. Hash this string with
 *  sha256HexOfText (fingerprint.ts). */
export function contentHashInput(payloadText: string, blobs?: readonly BlobRef[]): string {
	if (!blobs || blobs.length === 0) {
		return canonicalJson({ payload: payloadText });
	}
	const sorted = [...blobs].sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
	return canonicalJson({ blobs: sorted, payload: payloadText });
}

// --- the encryption envelope -----------------------------------------------

/* Shipped from day one so end-to-end encryption stays a later decision
 * instead of a later migration (the contract's Privacy section). v1 only
 * ever writes alg 'none'; unwrap refuses anything else rather than
 * guessing. Inline payloads carry the JSON form; blobs carry a 3-byte
 * binary frame ahead of the deflated bytes ('L', version, alg). */

export interface InlineEnvelope {
	alg: 'none' | 'aes-gcm';
	iv?: string;
	data: string;
}

export function wrapInline(text: string): InlineEnvelope {
	return { alg: 'none', data: text };
}

/** The payload text out of an inline envelope; throws on an algorithm
 *  this build cannot open (never silently returns ciphertext). */
export function unwrapInline(env: InlineEnvelope): string {
	if (env.alg !== 'none') {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error(`envelope: unsupported alg ${env.alg}`);
	}
	return env.data;
}

const BLOB_MAGIC = 0x4c; // 'L'
const BLOB_VERSION = 1;
const BLOB_ALG_NONE = 0;

export function wrapBlobBytes(deflated: Uint8Array): Uint8Array {
	const out = new Uint8Array(3 + deflated.length);
	out[0] = BLOB_MAGIC;
	out[1] = BLOB_VERSION;
	out[2] = BLOB_ALG_NONE;
	out.set(deflated, 3);
	return out;
}

/** The deflated bytes out of a framed blob; throws on a frame this build
 *  cannot open. */
export function unwrapBlobBytes(framed: Uint8Array): Uint8Array {
	if (framed.length < 3 || framed[0] !== BLOB_MAGIC || framed[1] !== BLOB_VERSION) {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error('envelope: not a loxodrome blob frame');
	}
	if (framed[2] !== BLOB_ALG_NONE) {
		// i18n-ignore: wire diagnostic, stays EN
		throw new Error(`envelope: unsupported blob alg ${framed[2]}`);
	}
	return framed.subarray(3);
}

// --- wire types ------------------------------------------------------------

/* The /v1 protocol shapes, pinned across the client and the worker by
 * the golden wire fixture (docs/accounts-sync.md, Testing): neither side
 * changes them unilaterally. The worker keeps its own copy by design
 * (it is self-contained, the notam-proxy posture); the fixture is what
 * holds the two in step. */

/** A document as the server serves it. */
export interface WireDoc {
	col: SyncCollection;
	id: string;
	rev: number;
	seq: number;
	deleted: boolean;
	updatedAt: number;
	device: string;
	hash: string;
	meta: Record<string, unknown>;
	payload?: InlineEnvelope;
	blobs?: BlobRef[];
}

/** A document as a device pushes it. baseRev 0 = create. */
export interface PushDoc {
	col: SyncCollection;
	id: string;
	baseRev: number;
	deleted: boolean;
	updatedAt: number;
	device: string;
	hash: string;
	meta: Record<string, unknown>;
	payload?: InlineEnvelope;
	blobs?: BlobRef[];
}

export type PushResult =
	| { ok: true; rev: number; seq: number }
	| { ok: false; conflict: true; server: WireDoc };

export interface ChangesResponse {
	seq: number;
	more: boolean;
	reset?: boolean;
	docs: WireDoc[];
}

// --- limits (client-side pre-checks; the worker owns enforcement) ----------

export const INLINE_MAX_BYTES = 256 * 1024;
export const BLOB_MAX_STORED_BYTES = 25 * 1024 * 1024;
export const PUSH_MAX_DOCS = 100;
export const CHANGES_PAGE_DOCS = 200;
