/* The conflict resolution folds (docs/accounts-sync.md, "Conflict
 * rules"), pure and pinned by tests/syncConflict.spec.ts. The engine
 * calls resolveConflict when a push answers `conflict`; the same
 * idempotency clause is ALSO implemented server-side (a rev mismatch
 * whose content already equals the pushed intent answers ok with no
 * write), this client fold being the defense-in-depth half.
 *
 * No resolution ever asks the pilot a question: every outcome is
 * automatic and non-destructive, and the extra row a `copy` can produce
 * is visible, explicable and one Delete away. */

import type { ConflictPolicy } from './model';

/** One side of a conflict, reduced to what the rules read. `hash` is the
 *  content hash (payload + blob refs); `declaredNonEmpty` is the outing
 *  rows' pilot-declared-cells override and is simply omitted by every
 *  other collection. */
export interface ConflictSide {
	hash: string;
	deleted: boolean;
	updatedAt: number;
	declaredNonEmpty?: boolean;
}

export type ConflictOutcome =
	/** The server already holds the pushed intent (equal content, or both
	 *  deleted): adopt its rev silently, nothing changed. The retried-push
	 *  idempotency clause. */
	| { kind: 'already-applied' }
	/** The server side stands; apply it locally. */
	| { kind: 'adopt-server' }
	/** The local side stands; push again with baseRev rebased to the
	 *  server rev. */
	| { kind: 'rebase-push' }
	/** copy policy: the server side stands ON THIS doc id, and the local
	 *  content re-files as a NEW doc (conflict copy), dirty. */
	| { kind: 'adopt-server-refile-local' }
	/** copy policy, local-delete vs server-edit: the delete stands (push
	 *  the tombstone again, rebased), and the SERVER content re-files as
	 *  a new doc so nobody's work vanishes silently. */
	| { kind: 'rebase-push-refile-server' };

/** The conflict table. `copy` (plans, aircraft) keeps both sides; `lww`
 *  (outings, acstate, pilot) resolves by updatedAt, minute-coarse trust,
 *  ties to the server (it already holds that state), with one override:
 *  on outings a non-empty `declared` beats an empty one whatever the
 *  clocks say, since those cells must round-trip verbatim
 *  (docs/logbook.md). */
export function resolveConflict(
	policy: ConflictPolicy,
	local: ConflictSide,
	server: ConflictSide,
): ConflictOutcome {
	// Idempotency first: the server already holds the pushed intent.
	if (local.deleted && server.deleted) {
		return { kind: 'already-applied' };
	}
	if (local.hash === server.hash && local.deleted === server.deleted) {
		return { kind: 'already-applied' };
	}
	if (policy === 'copy') {
		if (local.deleted && !server.deleted) {
			return { kind: 'rebase-push-refile-server' };
		}
		// Concurrent edits, and the server-deleted-local-edited case, share
		// one shape: the server state (content or tombstone) stands on the
		// doc id and the local content survives as a copy.
		return { kind: 'adopt-server-refile-local' };
	}
	// lww: the declared override outranks the clocks.
	const localDeclared = local.declaredNonEmpty === true;
	const serverDeclared = server.declaredNonEmpty === true;
	if (localDeclared !== serverDeclared) {
		return localDeclared ? { kind: 'rebase-push' } : { kind: 'adopt-server' };
	}
	return local.updatedAt > server.updatedAt ? { kind: 'rebase-push' } : { kind: 'adopt-server' };
}
