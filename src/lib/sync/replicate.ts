/* The replication pass (docs/accounts-sync.md, "The protocol"): pure of
 * every store and of the network, driven through injected dependencies,
 * which is what lets the simulation harness fold N virtual devices
 * against an in-memory server in one spec while the app wires the real
 * adapters and the wire client under the same contract.
 *
 * One pass = PULL (apply the server's delta, conflicts resolved by the
 * conflict table), then TOMBSTONES (recorded deletions push with the
 * rev they were recorded at), then PUSH (dirty tracked docs and the
 * adoptable local-only ones). Dirtiness is content-hash against the
 * registry, never timestamps or hooks; a doc key in the registry's
 * `preexisting` list never pushes (the provenance rule); an UNREADABLE
 * local listing skips the pass rather than reading as empty (the
 * blocked-tab guard); deletion is never inferred, only the recorded
 * tombstones delete anything, EXCEPT the reset reconciliation: after a
 * server `reset`, a TRACKED doc absent from the full listing is one
 * whose tombstone aged out while this device was away, and the deletion
 * applies (a local-only doc is untouched, not being the account's).
 *
 * A held-back doc COLLIDING with a server doc (same id, different
 * content) reads by the device mode: in `shared` mode it is a leftover
 * and the server version applies over it (the accepted shared residual);
 * in `personal` mode it is the pilot's own data pending the merge
 * confirm, and nothing of it may vanish: `copy` collections re-file it
 * as a conflict copy that is ITSELF held back, `lww` ones leave it
 * alone, untracked and unapplied, and the adoption's push resolves the
 * collision through the ordinary conflict fold.
 *
 * The caller holds the WRITER lock for the whole pass and hands the
 * registry in as plain read/write (syncRegistry's own locking wrappers
 * would deadlock on the non-reentrant lock). */

import { resolveConflict } from './conflict';
import {
	COLLECTION_POLICY,
	INLINE_MAX_BYTES,
	PUSH_MAX_DOCS,
	contentHashInput,
	unwrapInline,
	wrapInline,
	type BlobRef,
	type ChangesResponse,
	type PushDoc,
	type PushResult,
	type SyncCollection,
	type WireDoc,
} from './model';
import { sha256HexOfText } from './fingerprint';
import { docKey, type RegistryDocEntry, type SyncRegistry } from '$lib/state/syncRegistry';

/** One local doc as the adapters enumerate it. */
export interface ReplicaDoc {
	col: SyncCollection;
	id: string;
	payloadText: string;
	meta: Record<string, unknown>;
	declaredNonEmpty?: boolean;
	/** Lazy blob loader (outing rows): called only when the doc actually
	 *  pushes. null = this doc's blobs were unreadable this pass (skip). */
	blobs?: () => Promise<ReplicaBlobs | null>;
}

/** The blobs a doc pushes: refs, ready-to-PUT stored bytes, and the
 *  meta patch naming which ref is which (merged into the push meta). */
export interface ReplicaBlobs {
	refs: BlobRef[];
	bytes: Map<string, Uint8Array>;
	meta?: Record<string, unknown>;
}

export interface ReplicaApply {
	doc: WireDoc;
	payloadText: string | null;
	/** The doc keys held back from adoption at this point of the pass:
	 *  local data that is NOT (yet) the account's. An applier deciding
	 *  that local data supersedes the arriving doc must not count these,
	 *  or a leftover trace on a club PC would tombstone the pilot's own
	 *  logbook row. */
	heldBack?: ReadonlySet<string>;
}

export interface ReplicaStore {
	/** Every local doc, or null when a backing store was UNREADABLE
	 *  (never conflate with empty). */
	list(): Promise<ReplicaDoc[] | null>;
	/** Upsert (or, doc.deleted, remove) through the library chokepoints.
	 *  'superseded' = the store refused to KEEP the doc because local
	 *  data already covers it (a logbook row a local trace supersedes):
	 *  the pass answers with a tombstone at the doc's own rev. */
	apply(a: ReplicaApply): Promise<void | 'applied' | 'superseded'>;
	/** Re-file content as a NEW doc (the conflict copy); it becomes
	 *  local-dirty and pushes on a later pass. `origin` names the doc and
	 *  rev the conflict happened at, so a pass retried after an abort
	 *  lands on the SAME copy instead of minting another (the store keys
	 *  the copy deterministically on it). Answers the copy's doc id, or
	 *  null when nothing was filed (the content already present, or
	 *  unusable), so a copy made of held-back content can be held back
	 *  too. */
	refile(
		col: SyncCollection,
		payloadText: string,
		meta: Record<string, unknown>,
		origin: { id: string; rev: number },
	): Promise<string | null>;
}

export interface ReplicaTransport {
	/** `full`: this is a continuation page of a full listing (a page
	 *  after a `reset`), which the server must not clamp again. */
	changes(since: number, full: boolean): Promise<ChangesResponse>;
	push(docs: PushDoc[]): Promise<PushResult[]>;
	putBlob(hash: string, bytes: Uint8Array): Promise<void>;
}

export interface SyncPassInput {
	deviceId: string;
	/** The device mode (docs/accounts-sync.md, Device modes): what a
	 *  held-back doc colliding with a server doc means, a leftover to
	 *  apply over (shared) or the pilot's own pending data to preserve
	 *  (personal). */
	mode: 'personal' | 'shared';
	now(): number;
	registry: SyncRegistry;
	store: ReplicaStore;
	transport: ReplicaTransport;
	/** Upload progress over the DIRTY docs (each may carry blob uploads,
	 *  the slow part of a first adoption): called with (0, total) before
	 *  the first and (done, total) after each, skips included, so a
	 *  minutes-long library upload never reads as stuck. */
	progress?: ((done: number, total: number) => void) | undefined;
}

export interface SyncPassOutcome {
	pulled: number;
	pushed: number;
	refiled: number;
	/** Local-only docs held back by `preexisting` (the merge counts). */
	unadopted: number;
	/** Docs skipped for exceeding the inline cap (surfaced once). */
	oversized: number;
	/** A typed server refusal that stopped the PUSH half; the pulls and
	 *  the registry stand (aborting the pass would lose them). */
	pushRefused: string | null;
	reset: boolean;
	/** Blob hashes the pulled docs reference and the device may lack,
	 *  with the doc meta that names which ref is which; the engine
	 *  fetches them per the device mode's policy. */
	wantBlobs: {
		col: SyncCollection;
		id: string;
		refs: BlobRef[];
		meta: Record<string, unknown>;
	}[];
	/** The registry to persist (the caller writes it under its lock). */
	registry: SyncRegistry;
}

async function localHash(doc: ReplicaDoc, blobs: BlobRef[] | undefined): Promise<string> {
	return sha256HexOfText(contentHashInput(doc.payloadText, blobs));
}

/** The declared-cells flag of an OUTINGS payload: the lww override needs
 *  BOTH sides, and the server side exists only as its payload text. */
function declaredOf(col: SyncCollection, payloadText: string | null | undefined): boolean {
	if (col !== 'outings' || !payloadText) {
		return false;
	}
	try {
		const parsed = JSON.parse(payloadText) as { declared?: Record<string, string> };
		return parsed.declared !== undefined && Object.keys(parsed.declared).length > 0;
	} catch {
		return false;
	}
}

/** Record the server side of a resolved conflict as this device's
 *  synced state. A server TOMBSTONE leaves no entry: the local doc is
 *  gone with it, and a tracked-but-absent key would read as an eviction
 *  on the next pass and widen it to a full listing for nothing. */
function trackServer(reg: SyncRegistry, key: string, server: WireDoc): void {
	if (server.deleted) {
		delete reg.docs[key];
		return;
	}
	reg.docs[key] = {
		rev: server.rev,
		hash: server.hash,
		...(server.blobs ? { blobs: server.blobs, meta: server.meta } : {}),
	};
}

/** Chunk by count AND bytes: the worker refuses a body past 4 MB whole,
 *  and a wedged chunk would starve every doc in it. */
function pushChunks(docs: PushDoc[]): PushDoc[][] {
	const budget = 3_500_000;
	const out: PushDoc[][] = [];
	let chunk: PushDoc[] = [];
	let bytes = 0;
	for (const d of docs) {
		const size = (d.payload ? d.payload.data.length : 0) + 2_048;
		if (chunk.length > 0 && (chunk.length >= PUSH_MAX_DOCS || bytes + size > budget)) {
			out.push(chunk);
			chunk = [];
			bytes = 0;
		}
		chunk.push(d);
		bytes += size;
	}
	if (chunk.length > 0) {
		out.push(chunk);
	}
	return out;
}

export async function syncPass(input: SyncPassInput): Promise<SyncPassOutcome> {
	const reg = input.registry;
	const outcome: SyncPassOutcome = {
		pulled: 0,
		pushed: 0,
		refiled: 0,
		unadopted: 0,
		oversized: 0,
		pushRefused: null,
		reset: false,
		wantBlobs: [],
		registry: reg,
	};
	const local = await input.store.list();
	if (local === null) {
		return outcome;
	}
	const localByKey = new Map<string, ReplicaDoc>();
	for (const d of local) {
		localByKey.set(docKey(d.col, d.id), d);
	}
	const preexisting = new Set(reg.preexisting ?? []);
	// Held-back copies this pass files during the pull: absent from the
	// listing snapshot, so the push half cannot count them, yet the merge
	// confirm reading `unadopted` after the first pass must name them.
	let heldCopies = 0;

	// --- PULL ---------------------------------------------------------------
	// A TRACKED doc absent locally is an evicted (or blob-pending) store:
	// re-pull from zero so the full listing can re-apply it. This is the
	// eviction-restore promise; absence STILL deletes nothing (recorded
	// tombstones only), it merely widens the pull.
	const remoteSeen = new Set<string>();
	let evicted = false;
	for (const key of Object.keys(reg.docs)) {
		if (!localByKey.has(key)) {
			evicted = true;
			break;
		}
	}
	let since = evicted ? 0 : reg.lastSeq;
	// Once a page came back `reset`, every following page is a continuation
	// of that full listing and says so: its cursor lies below the purge
	// horizon by construction, and a server re-clamping it would serve
	// page one for ever.
	let full = false;
	for (;;) {
		const page = await input.transport.changes(since, full);
		if (page.reset) {
			outcome.reset = true;
			full = true;
		}
		for (const doc of page.docs) {
			const key = docKey(doc.col, doc.id);
			remoteSeen.add(key);
			const entry = reg.docs[key];
			if (entry && entry.rev === doc.rev && localByKey.has(key)) {
				continue; // our own echo, and the doc really is here
			}
			const mine = localByKey.get(key);
			const policy = COLLECTION_POLICY[doc.col];
			if (doc.deleted) {
				// A tombstone reaches only TRACKED docs; an anonymous local
				// doc under the same id is not the account's to delete.
				if (entry) {
					if (mine) {
						const dirty = (await localHash(mine, entry.blobs)) !== entry.hash;
						if (dirty) {
							const out = resolveConflict(
								policy,
								{
									hash: await localHash(mine, entry.blobs),
									deleted: false,
									updatedAt: input.now(),
									...(mine.declaredNonEmpty !== undefined
										? { declaredNonEmpty: mine.declaredNonEmpty }
										: {}),
								},
								{ hash: doc.hash, deleted: true, updatedAt: doc.updatedAt },
							);
							if (out.kind === 'rebase-push') {
								// The local edit outlives the delete: rebase and let
								// the push below resurrect it.
								reg.docs[key] = {
									rev: doc.rev,
									hash: entry.hash,
									...(entry.blobs ? { blobs: entry.blobs, meta: entry.meta } : {}),
								};
								continue;
							}
							if (out.kind === 'adopt-server-refile-local') {
								await input.store.refile(doc.col, mine.payloadText, mine.meta, {
									id: doc.id,
									rev: doc.rev,
								});
								outcome.refiled++;
							}
						}
					}
					await input.store.apply({ doc, payloadText: null });
					delete reg.docs[key];
					localByKey.delete(key);
					outcome.pulled++;
				}
				continue;
			}
			const payloadText = doc.payload ? unwrapInline(doc.payload) : null;
			if (!entry && mine) {
				// The content reconcile: an untracked local doc against the
				// server's. Equal content adopts silently (it IS the same
				// data); differing content keeps both under `copy` (re-file
				// the local as its own doc) and applies the server under
				// `lww` (the accepted leftover residual).
				const asServer = await localHash(mine, doc.blobs);
				if (asServer === doc.hash) {
					reg.docs[key] = {
						rev: doc.rev,
						hash: doc.hash,
						...(doc.blobs ? { blobs: doc.blobs } : {}),
					};
					preexisting.delete(key);
					localByKey.delete(key);
					continue;
				}
				if (preexisting.has(key)) {
					// A held-back doc colliding with the account's (the header
					// rule). Shared: a leftover, the server applies over it.
					// Personal: the pilot's own, pending the merge confirm, so
					// nothing of it may vanish: a `copy` re-files it as a copy
					// held back like its origin, and an `lww` doc is left as
					// it is, untracked (a later local delete then records no
					// tombstone against a doc that was never adopted); the
					// adoption's push meets the server doc through the
					// ordinary conflict fold.
					if (input.mode === 'personal') {
						if (policy === 'copy') {
							const copyId = await input.store.refile(doc.col, mine.payloadText, mine.meta, {
								id: doc.id,
								rev: doc.rev,
							});
							if (copyId !== null) {
								const copyKey = docKey(doc.col, copyId);
								if (!preexisting.has(copyKey) && !localByKey.has(copyKey)) {
									heldCopies++;
								}
								preexisting.add(copyKey);
							}
							outcome.refiled++;
						} else {
							continue;
						}
					}
				} else {
					// An adoptable one keeps both under `copy`, and under `lww`
					// runs the SAME conflict fold as a tracked doc: a fresh edit
					// typed after sign-in (the first pilot edit on this device
					// racing another device's) is no leftover, and the newer
					// write must win.
					if (policy === 'copy') {
						await input.store.refile(doc.col, mine.payloadText, mine.meta, {
							id: doc.id,
							rev: doc.rev,
						});
						outcome.refiled++;
					} else if (policy === 'lww') {
						const out = resolveConflict(
							'lww',
							{
								hash: asServer,
								deleted: false,
								updatedAt: input.now(),
								...(mine.declaredNonEmpty !== undefined
									? { declaredNonEmpty: mine.declaredNonEmpty }
									: {}),
							},
							{
								hash: doc.hash,
								deleted: false,
								updatedAt: doc.updatedAt,
								declaredNonEmpty: declaredOf(doc.col, payloadText),
							},
						);
						if (out.kind === 'rebase-push') {
							// Track at the server rev with a hash nothing can
							// equal: the doc STAYS in localByKey, so the push
							// half sees it dirty and sends the local content
							// at this baseRev.
							reg.docs[key] = { rev: doc.rev, hash: '' };
							continue;
						}
					}
				}
			}
			if (entry && mine) {
				const mineHash = await localHash(mine, entry.blobs);
				if (mineHash !== entry.hash) {
					// Local dirty vs a newer server rev: the conflict table.
					const out = resolveConflict(
						policy,
						{
							hash: mineHash,
							deleted: false,
							updatedAt: input.now(),
							...(mine.declaredNonEmpty !== undefined
								? { declaredNonEmpty: mine.declaredNonEmpty }
								: {}),
						},
						{
							hash: doc.hash,
							deleted: false,
							updatedAt: doc.updatedAt,
							declaredNonEmpty: declaredOf(doc.col, payloadText),
						},
					);
					if (out.kind === 'rebase-push') {
						reg.docs[key] = {
							rev: doc.rev,
							hash: entry.hash,
							...(entry.blobs ? { blobs: entry.blobs, meta: entry.meta } : {}),
						};
						continue; // still dirty; the push below carries it
					}
					if (out.kind === 'adopt-server-refile-local') {
						await input.store.refile(doc.col, mine.payloadText, mine.meta, {
							id: doc.id,
							rev: doc.rev,
						});
						outcome.refiled++;
					}
					// adopt-server / already-applied fall through to apply.
				}
			}
			const verdict = await input.store.apply({ doc, payloadText, heldBack: preexisting });
			if (verdict === 'superseded') {
				if (!reg.tombstones.some((t) => t.col === doc.col && t.id === doc.id)) {
					reg.tombstones.push({
						col: doc.col,
						id: doc.id,
						updatedAt: input.now(),
						rev: doc.rev,
					});
				}
				delete reg.docs[key];
				preexisting.delete(key);
				localByKey.delete(key);
				continue;
			}
			reg.docs[key] = {
				rev: doc.rev,
				hash: doc.hash,
				...(doc.blobs ? { blobs: doc.blobs, meta: doc.meta } : {}),
			};
			preexisting.delete(key);
			localByKey.delete(key);
			outcome.pulled++;
			if (doc.blobs && doc.blobs.length > 0) {
				outcome.wantBlobs.push({ col: doc.col, id: doc.id, refs: doc.blobs, meta: doc.meta });
			}
		}
		since = page.seq;
		reg.lastSeq = Math.max(reg.lastSeq, page.seq);
		if (!page.more) {
			break;
		}
	}

	// --- the reset reconciliation -------------------------------------------
	if (outcome.reset) {
		for (const key of Object.keys(reg.docs)) {
			if (!remoteSeen.has(key)) {
				const [col, ...rest] = key.split('/');
				const id = rest.join('/');
				// A tracked doc the full listing lacks was deleted while this
				// device was away, its tombstone aged out. The deletion applies
				// to a CLEAN local copy; a DIRTY one is the pilot's later edit
				// and stays, untracked, to push as a new doc (the edit-versus-
				// delete rule: nobody's work vanishes silently, the later
				// action wins).
				const mine = localByKey.get(key);
				const entry = reg.docs[key];
				if (mine && (await localHash(mine, entry.blobs)) !== entry.hash) {
					delete reg.docs[key];
					continue;
				}
				await input.store.apply({
					doc: {
						col: col as SyncCollection,
						id,
						rev: 0,
						seq: 0,
						deleted: true,
						updatedAt: input.now(),
						device: '',
						hash: '',
						meta: {},
					},
					payloadText: null,
				});
				delete reg.docs[key];
				localByKey.delete(key);
				outcome.pulled++;
			}
		}
	}

	// --- TOMBSTONES ---------------------------------------------------------
	const tombstonePushes: PushDoc[] = reg.tombstones.map((t) => ({
		col: t.col,
		id: t.id,
		baseRev: t.rev,
		deleted: true,
		updatedAt: t.updatedAt,
		device: input.deviceId,
		hash: '',
		meta: {},
	}));

	// --- PUSH ---------------------------------------------------------------
	interface Outgoing {
		doc: PushDoc;
		key: string;
		blobs?: BlobRef[];
		declaredNonEmpty?: boolean;
	}
	const outgoing: Outgoing[] = [];
	// Detection first (hash-only, cheap: no blob loader runs), so the
	// build loop below has a TOTAL to report progress against.
	const dirty: [string, ReplicaDoc, RegistryDocEntry | undefined][] = [];
	for (const [key, mine] of localByKey) {
		const entry = reg.docs[key];
		if (!entry) {
			if (preexisting.has(key)) {
				outcome.unadopted++;
				continue;
			}
		} else if ((await localHash(mine, entry.blobs)) === entry.hash) {
			continue; // clean
		}
		dirty.push([key, mine, entry]);
	}
	let progressDone = 0;
	input.progress?.(0, dirty.length);
	for (const [key, mine, entry] of dirty) {
		let refs: BlobRef[] | undefined;
		let meta = mine.meta;
		if (mine.blobs) {
			const loaded = await mine.blobs();
			if (loaded === null) {
				input.progress?.(++progressDone, dirty.length);
				continue; // unreadable this pass; retried next time
			}
			refs = loaded.refs;
			if (loaded.meta) {
				meta = { ...meta, ...loaded.meta };
			}
			for (const [hash, bytes] of loaded.bytes) {
				const already = entry?.blobs?.some((b) => b.h === hash) ?? false;
				if (!already) {
					await input.transport.putBlob(hash, bytes);
				}
			}
		}
		if (new TextEncoder().encode(mine.payloadText).length > INLINE_MAX_BYTES) {
			// One oversized doc must not starve its chunk: skipped, counted,
			// surfaced once by the engine; the rest of the pass proceeds.
			outcome.oversized++;
			input.progress?.(++progressDone, dirty.length);
			continue;
		}
		const hash = await localHash(mine, refs);
		outgoing.push({
			key,
			doc: {
				col: mine.col,
				id: mine.id,
				baseRev: entry?.rev ?? 0,
				deleted: false,
				updatedAt: input.now(),
				device: input.deviceId,
				hash,
				meta,
				payload: wrapInline(mine.payloadText),
				...(refs ? { blobs: refs } : {}),
			},
			...(refs ? { blobs: refs } : {}),
			...(mine.declaredNonEmpty !== undefined
				? { declaredNonEmpty: mine.declaredNonEmpty }
				: {}),
		});
		input.progress?.(++progressDone, dirty.length);
	}

	const all: {
		doc: PushDoc;
		key: string | null;
		blobs?: BlobRef[];
		declaredNonEmpty?: boolean;
	}[] = [...tombstonePushes.map((doc) => ({ doc, key: null })), ...outgoing];
	for (const chunk of pushChunks(all.map((o) => o.doc))) {
		const offset = all.findIndex((o) => o.doc === chunk[0]);
		let results: PushResult[];
		try {
			results = await input.transport.push(chunk);
		} catch (err) {
			// A TYPED refusal (quota, size) stops the push half but must not
			// abort the pass: the pulls and the registry stand, and the
			// engine words the code once. Anything else (network, 5xx)
			// still aborts for the ordinary retry.
			const code = (err as { code?: unknown; status?: unknown }) ?? {};
			if (typeof code.code === 'string' && code.status === 413) {
				outcome.pushRefused = code.code;
				break;
			}
			throw err;
		}
		for (let i = 0; i < results.length; i++) {
			const res = results[i];
			const item = all[offset + i];
			const d = item.doc;
			const key = docKey(d.col, d.id);
			if (res.ok) {
				if (d.deleted) {
					reg.tombstones = reg.tombstones.filter((t) => !(t.col === d.col && t.id === d.id));
				} else {
					reg.docs[key] = {
						rev: res.rev,
						hash: d.hash,
						...(item.blobs ? { blobs: item.blobs, meta: d.meta } : {}),
					};
					preexisting.delete(key);
					outcome.pushed++;
				}
				continue;
			}
			const server = res.server;
			if (!server) {
				continue; // vanished mid-flight; the next pass retries
			}
			const out = resolveConflict(
				COLLECTION_POLICY[d.col],
				{
					hash: d.hash,
					deleted: d.deleted,
					updatedAt: d.updatedAt,
					...(item.declaredNonEmpty !== undefined
						? { declaredNonEmpty: item.declaredNonEmpty }
						: {}),
				},
				{
					hash: server.hash,
					deleted: server.deleted,
					updatedAt: server.updatedAt,
					declaredNonEmpty: declaredOf(
						d.col,
						server.payload ? unwrapInline(server.payload) : null,
					),
				},
			);
			switch (out.kind) {
				case 'already-applied':
					if (d.deleted) {
						reg.tombstones = reg.tombstones.filter(
							(t) => !(t.col === d.col && t.id === d.id),
						);
					} else {
						reg.docs[key] = {
							rev: server.rev,
							hash: server.hash,
							...(server.blobs ? { blobs: server.blobs, meta: server.meta } : {}),
						};
					}
					break;
				case 'adopt-server': {
					await input.store.apply({
						doc: server,
						payloadText: server.payload ? unwrapInline(server.payload) : null,
						heldBack: preexisting,
					});
					trackServer(reg, key, server);
					if (d.deleted) {
						reg.tombstones = reg.tombstones.filter(
							(t) => !(t.col === d.col && t.id === d.id),
						);
					}
					outcome.pulled++;
					break;
				}
				case 'rebase-push': {
					const retry = await input.transport.push([{ ...d, baseRev: server.rev }]);
					const r = retry[0];
					if (r.ok) {
						if (d.deleted) {
							reg.tombstones = reg.tombstones.filter(
								(t) => !(t.col === d.col && t.id === d.id),
							);
						} else {
							reg.docs[key] = {
								rev: r.rev,
								hash: d.hash,
								...(item.blobs ? { blobs: item.blobs, meta: d.meta } : {}),
							};
							outcome.pushed++;
						}
					}
					break; // a second conflict waits for the next pass
				}
				case 'adopt-server-refile-local': {
					if (!d.deleted && d.payload) {
						await input.store.refile(d.col, unwrapInline(d.payload), d.meta, {
							id: d.id,
							rev: server.rev,
						});
						outcome.refiled++;
					}
					await input.store.apply({
						doc: server,
						payloadText: server.payload ? unwrapInline(server.payload) : null,
					});
					trackServer(reg, key, server);
					outcome.pulled++;
					break;
				}
				case 'rebase-push-refile-server': {
					const retry = await input.transport.push([{ ...d, baseRev: server.rev }]);
					if (retry[0].ok) {
						if (d.deleted) {
							reg.tombstones = reg.tombstones.filter(
								(t) => !(t.col === d.col && t.id === d.id),
							);
						}
						// Refile only once the delete stands: an aborted retry
						// must not mint a copy per pass.
						if (server.payload) {
							await input.store.refile(d.col, unwrapInline(server.payload), server.meta, {
								id: d.id,
								rev: server.rev,
							});
							outcome.refiled++;
						}
					}
					break;
				}
			}
		}
	}
	outcome.unadopted += heldCopies;
	reg.preexisting = [...preexisting];
	if (reg.preexisting.length === 0) {
		delete reg.preexisting;
	}
	return outcome;
}
