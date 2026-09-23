/* The in-memory account-api model the simulation harness folds devices
 * against (docs/accounts-sync.md, Testing): the same rev/seq/idempotency
 * semantics the worker implements, small enough to read side by side.
 * The golden wire fixture (account-api/test/fixtures/wire.json) is what
 * pins the two together: tests/syncWire.spec.ts replays it here and the
 * worker suite replays it against the real handler, and neither side may
 * change it unilaterally. */

import type { ChangesResponse, PushDoc, PushResult, WireDoc } from '$lib/sync/model';

const PAGE = 200;

export class SimServer {
	private docs = new Map<string, WireDoc>();
	private changeSeq = 0;
	private horizonSeq = 0;
	readonly blobs = new Map<string, Uint8Array>();

	push(docs: PushDoc[]): PushResult[] {
		return docs.map((d) => this.pushOne(d));
	}

	private pushOne(d: PushDoc): PushResult {
		const key = `${d.col}/${d.id}`;
		const cur = this.docs.get(key);
		// The worker burns one seq per pushed doc whatever the outcome (the
		// bump statement commits even when the precondition refuses the
		// upsert); gaps are harmless and the fixture pins the parity.
		this.changeSeq++;
		if (cur && cur.rev !== d.baseRev) {
			// The idempotency short-circuit: a retried push whose intent
			// already stands answers ok with no write.
			if (
				(d.deleted && cur.deleted) ||
				(!d.deleted && !cur.deleted && cur.hash === d.hash)
			) {
				return { ok: true, rev: cur.rev, seq: cur.seq };
			}
			return { ok: false, conflict: true, server: cur };
		}
		const doc: WireDoc = {
			col: d.col,
			id: d.id,
			rev: (cur?.rev ?? 0) + 1,
			seq: this.changeSeq,
			deleted: d.deleted,
			updatedAt: d.updatedAt,
			device: d.device,
			// A tombstone clears its payload, refs and hash (the worker's
			// GC convention).
			hash: d.deleted ? '' : d.hash,
			meta: d.meta,
			...(d.deleted || !d.payload ? {} : { payload: d.payload }),
			...(d.deleted || !d.blobs ? {} : { blobs: d.blobs }),
		};
		this.docs.set(key, doc);
		return { ok: true, rev: doc.rev, seq: doc.seq };
	}

	changes(since: number, full = false): ChangesResponse {
		// Reset when the client fell behind the tombstone-retention horizon
		// OR claims a seq the account never reached (the worker's D1
		// Time-Travel clamp; parity pinned by the wire fixture). A
		// continuation page of a full listing (`full`) is never re-tested
		// against the horizon: its cursor sits below it by construction.
		const reset = (!full && since < this.horizonSeq) || since > this.changeSeq;
		const from = reset ? 0 : since;
		const all = [...this.docs.values()].filter((x) => x.seq > from).sort((a, b) => a.seq - b.seq);
		const page = all.slice(0, PAGE);
		return {
			seq: page.length > 0 ? page[page.length - 1].seq : from,
			more: all.length > PAGE,
			docs: page,
			...(reset ? { reset: true } : {}),
		};
	}

	/** The tombstone-retention sweep: rows go, the horizon moves, and a
	 *  client behind it gets `reset`. */
	putBlob(hash: string, bytes: Uint8Array): void {
		this.blobs.set(hash, bytes);
	}

	purgeTombstones(): void {
		for (const [key, doc] of this.docs) {
			if (doc.deleted) {
				this.horizonSeq = Math.max(this.horizonSeq, doc.seq);
				this.docs.delete(key);
			}
		}
	}

	doc(key: string): WireDoc | undefined {
		return this.docs.get(key);
	}

	count(): number {
		return this.docs.size;
	}

	live(): WireDoc[] {
		return [...this.docs.values()].filter((d) => !d.deleted);
	}
}
