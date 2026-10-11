/* The trace-download queue (docs/accounts-sync.md, "the trickle"): what
 * the personal-mode blob fetch still owes, held as data so the run
 * itself can be a plain worker pool the sign-in never waits on.
 *
 * Pure and store-free. Every pass folds its wants into ONE queue, which
 * is what stops the once-per-session registry re-scan from stacking the
 * same outing behind itself while a run is already draining it. */

import type { BlobRef, SyncCollection } from './model';

/** One doc's blobs as the pass reported them (`SyncPassOutcome.wantBlobs`). */
export interface TraceWant {
	col: SyncCollection;
	id: string;
	refs: BlobRef[];
	meta: Record<string, unknown>;
}

/** An outing id is its first fix's timeMs, so the id IS the order; a doc
 *  whose id is not a number (no collection has one today) sorts last
 *  rather than turning the comparison into NaN. */
function order(w: TraceWant): number {
	const n = Number(w.id);
	return Number.isFinite(n) ? n : -Infinity;
}

/** `pending` folded with `incoming`: one entry per doc key, the LATEST
 *  refs winning (a re-pull restates them), newest first, since the
 *  flight the pilot looks for is the recent one. */
export function mergeWants(
	pending: readonly TraceWant[],
	incoming: readonly TraceWant[],
): TraceWant[] {
	const byKey = new Map<string, TraceWant>();
	for (const w of pending) {
		byKey.set(`${w.col}/${w.id}`, w);
	}
	for (const w of incoming) {
		byKey.set(`${w.col}/${w.id}`, w);
	}
	return [...byKey.values()].sort((x, y) => order(y) - order(x));
}
