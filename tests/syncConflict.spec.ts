/* Pins the conflict table (docs/accounts-sync.md, "Conflict rules"):
 * copy keeps both sides, lww resolves by updatedAt with the declared
 * override, and the idempotency clause turns a retried push into a
 * no-op instead of a fabricated conflict copy. */
import { describe, expect, it } from 'vitest';
import { resolveConflict, type ConflictSide } from '$lib/sync/conflict';

function side(over: Partial<ConflictSide> = {}): ConflictSide {
	return { hash: 'h', deleted: false, updatedAt: 100, ...over };
}

describe('the idempotency clause', () => {
	it('reads an equal-content rev mismatch as already applied', () => {
		expect(resolveConflict('copy', side(), side({ updatedAt: 999 }))).toEqual({
			kind: 'already-applied',
		});
		expect(resolveConflict('lww', side(), side())).toEqual({ kind: 'already-applied' });
	});

	it('reads two tombstones as already applied whatever their hashes', () => {
		expect(
			resolveConflict('copy', side({ deleted: true, hash: 'a' }), side({ deleted: true, hash: 'b' })),
		).toEqual({ kind: 'already-applied' });
	});
});

describe('copy (plans, aircraft)', () => {
	it('keeps both sides on a concurrent edit: server stands, local re-files', () => {
		expect(resolveConflict('copy', side({ hash: 'a' }), side({ hash: 'b' }))).toEqual({
			kind: 'adopt-server-refile-local',
		});
	});

	it('keeps the delete and re-files the edit, whichever side deleted', () => {
		// Server deleted, local edited: the tombstone stands as the doc, the
		// local content survives as a copy.
		expect(
			resolveConflict('copy', side({ hash: 'a' }), side({ hash: 'b', deleted: true })),
		).toEqual({ kind: 'adopt-server-refile-local' });
		// Local deleted, server edited: the tombstone pushes on, rebased, and
		// the server content survives as a copy.
		expect(
			resolveConflict('copy', side({ hash: 'a', deleted: true }), side({ hash: 'b' })),
		).toEqual({ kind: 'rebase-push-refile-server' });
	});
});

describe('lww (outings, acstate, pilot)', () => {
	it('resolves by updatedAt, ties to the server', () => {
		expect(
			resolveConflict('lww', side({ hash: 'a', updatedAt: 200 }), side({ hash: 'b', updatedAt: 100 })),
		).toEqual({ kind: 'rebase-push' });
		expect(
			resolveConflict('lww', side({ hash: 'a', updatedAt: 100 }), side({ hash: 'b', updatedAt: 200 })),
		).toEqual({ kind: 'adopt-server' });
		expect(
			resolveConflict('lww', side({ hash: 'a' }), side({ hash: 'b' })),
		).toEqual({ kind: 'adopt-server' });
	});

	it('resolves edit-versus-delete by the later action', () => {
		expect(
			resolveConflict(
				'lww',
				side({ hash: 'a', updatedAt: 300 }),
				side({ hash: 'b', deleted: true, updatedAt: 200 }),
			),
		).toEqual({ kind: 'rebase-push' });
		expect(
			resolveConflict(
				'lww',
				side({ hash: 'a', deleted: true, updatedAt: 100 }),
				side({ hash: 'b', updatedAt: 200 }),
			),
		).toEqual({ kind: 'adopt-server' });
	});

	it('lets a non-empty declared beat the clocks in both directions', () => {
		expect(
			resolveConflict(
				'lww',
				side({ hash: 'a', updatedAt: 100, declaredNonEmpty: true }),
				side({ hash: 'b', updatedAt: 999, declaredNonEmpty: false }),
			),
		).toEqual({ kind: 'rebase-push' });
		expect(
			resolveConflict(
				'lww',
				side({ hash: 'a', updatedAt: 999, declaredNonEmpty: false }),
				side({ hash: 'b', updatedAt: 100, declaredNonEmpty: true }),
			),
		).toEqual({ kind: 'adopt-server' });
	});

	it('falls back to the clocks when both or neither side declares', () => {
		expect(
			resolveConflict(
				'lww',
				side({ hash: 'a', updatedAt: 300, declaredNonEmpty: true }),
				side({ hash: 'b', updatedAt: 100, declaredNonEmpty: true }),
			),
		).toEqual({ kind: 'rebase-push' });
	});
});
