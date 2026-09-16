/* Undo / redo for route edits: every discrete action is one undo step, field
 * edits coalesce per session, redo re-applies and is cleared by a fresh action,
 * and the history is capped. Drives the real route.svelte mutators. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	routes,
	activeRoute,
	addWaypoint,
	insertWaypointAfter,
	moveWaypoint,
	removeWaypoint,
	clearRoute,
	clearAllRoutes,
	setWaypointName,
	setWaypointFreqs,
	addRoute,
	removeRoute,
	loadRoutes,
	undoRoute,
	redoRoute,
	setPlanName,
	UNDO_CAP,
	type WaypointAnchor,
} from '$lib/state/route.svelte';

// Drain any history from a prior test, then reset to one empty route. Assigning
// routes directly (not via a mutator) does not record an undo entry.
function reset(): void {
	while (undoRoute()) {
		/* pop everything onto redo */
	}
	routes.list = [{ id: 'route-1', name: null, waypoints: [], selectedWaypointId: null }];
	routes.activeId = 'route-1';
	routes.planName = null;
}
beforeEach(reset);

const wps = () => activeRoute().waypoints;
const count = () => wps().length;

describe('discrete actions undo one step', () => {
	it('add -> undo restores empty', () => {
		addWaypoint(48, 2);
		expect(count()).toBe(1);
		expect(undoRoute()).toBe(true);
		expect(count()).toBe(0);
		expect(undoRoute()).toBe(false);
	});

	it('move -> undo restores the prior position', () => {
		const wp = addWaypoint(48, 2);
		moveWaypoint(wp.id, 49, 3);
		expect(wps()[0].lat).toBe(49);
		undoRoute();
		expect(wps()[0].lat).toBe(48);
		undoRoute();
		expect(count()).toBe(0);
	});

	it('delete and insert each undo cleanly', () => {
		const a = addWaypoint(48, 2);
		addWaypoint(49, 3);
		removeWaypoint(a.id);
		expect(count()).toBe(1);
		undoRoute();
		expect(count()).toBe(2);
		insertWaypointAfter(0, { lat: 48.5, lon: 2.5, kind: 'free' });
		expect(count()).toBe(3);
		undoRoute();
		expect(count()).toBe(2);
	});

	it('Clear -> undo restores the waypoints', () => {
		addWaypoint(48, 2);
		addWaypoint(49, 3);
		clearRoute();
		expect(count()).toBe(0);
		undoRoute();
		expect(count()).toBe(2);
	});

	it('Clear all -> one fresh empty route, and undo restores the workspace', () => {
		addWaypoint(48, 2);
		addRoute();
		addWaypoint(49, 3);
		const ids = routes.list.map((r) => r.id);
		expect(routes.list).toHaveLength(2);
		clearAllRoutes();
		expect(routes.list).toHaveLength(1);
		expect(count()).toBe(0);
		expect(ids).not.toContain(routes.activeId); // a fresh id, not a reused one
		expect(routes.activeId).toBe(routes.list[0].id);
		undoRoute();
		expect(routes.list.map((r) => r.id)).toEqual(ids);
		expect(count()).toBe(1);
	});

	it('add / remove route undo', () => {
		addRoute();
		expect(routes.list).toHaveLength(2);
		undoRoute();
		expect(routes.list).toHaveLength(1);
		addRoute();
		addRoute();
		removeRoute(routes.list[2].id);
		expect(routes.list).toHaveLength(2);
		undoRoute();
		expect(routes.list).toHaveLength(3);
	});
});

describe('load', () => {
	const resolve = (t: string): WaypointAnchor | null =>
		t.toUpperCase() === 'LFPL'
			? { lat: 48.8, lon: 2.6, kind: 'airport', refId: 'LFPL', ident: 'LFPL' }
			: null;

	it('undo restores the workspace before a load', () => {
		addWaypoint(48, 2);
		loadRoutes({ routes: [{ name: 'X', waypoints: [{ ident: 'LFPL' }, { ident: 'LFPL' }] }] }, resolve);
		expect(activeRoute().name).toBe('X');
		expect(count()).toBe(2);
		undoRoute();
		expect(activeRoute().name).toBeNull();
		expect(count()).toBe(1);
		expect(wps()[0].lat).toBe(48);
	});
});

describe('redo', () => {
	it('re-applies an undone action, and a fresh action clears redo', () => {
		addWaypoint(48, 2);
		undoRoute();
		expect(count()).toBe(0);
		expect(redoRoute()).toBe(true);
		expect(count()).toBe(1);
		undoRoute();
		addWaypoint(50, 5); // a new action discards the redo branch
		expect(redoRoute()).toBe(false);
	});
});

describe('field-edit coalescing', () => {
	it('collapses consecutive same-field edits to one undo step', () => {
		const wp = addWaypoint(48, 2);
		setWaypointName(wp.id, 'A');
		setWaypointName(wp.id, 'AB');
		setWaypointName(wp.id, 'ABC');
		expect(wps()[0].label).toBe('ABC');
		expect(undoRoute()).toBe(true);
		expect(wps()[0].label).toBeUndefined(); // back to before the naming session
		expect(undoRoute()).toBe(true);
		expect(count()).toBe(0); // back to before the add
	});

	it('a discrete action between edits breaks the session', () => {
		const wp = addWaypoint(48, 2);
		setWaypointName(wp.id, 'A');
		addWaypoint(49, 3); // discrete -> closes the naming session
		setWaypointName(wp.id, 'B'); // a new session
		expect(wps()[0].label).toBe('B');
		undoRoute();
		expect(wps()[0].label).toBe('A'); // B session undone separately
		undoRoute();
		expect(count()).toBe(1); // second add undone
		undoRoute();
		expect(wps()[0].label).toBeUndefined(); // A session undone
	});
});

// The frequencies editor commits once on blur, so each commit is a discrete
// step (no coalescing) and an unchanged commit records nothing.
describe('frequency-edit commits', () => {
	it('one step per changed commit, none when nothing changed', () => {
		const wp = addWaypoint(48, 2);
		setWaypointFreqs(wp.id, 'TWR: 118.605', '');
		setWaypointFreqs(wp.id, 'TWR: 118.605', ''); // unchanged commit: no entry
		setWaypointFreqs(wp.id, 'TWR: 121.500', '');
		expect(wps()[0].freqsManual).toBe('TWR: 121.500');
		undoRoute();
		expect(wps()[0].freqsManual).toBe('TWR: 118.605'); // second commit undone
		undoRoute();
		expect(wps()[0].freqsManual).toBeUndefined(); // first commit undone
		undoRoute();
		expect(count()).toBe(0); // back before the add: no step for the no-op
		expect(undoRoute()).toBe(false);
	});
});

describe('the plan name stays out of the history', () => {
	/* Naming a plan writes the CATALOG ROW and the workspace in one action
	 * (state/activePlan.renamePlan), so a snapshot of the name could only ever
	 * put the two halves out of step: undo would revert the workspace while the
	 * stored file kept the new name, and the next Store would write the old one
	 * back. The routes declaration states the rule; this pins it. */
	it('renaming records no step, and an undo of a real edit keeps the name', () => {
		setPlanName('Nav examen');
		expect(undoRoute()).toBe(false);
		addWaypoint(48, 2);
		setPlanName('Nav examen 2');
		expect(undoRoute()).toBe(true);
		expect(count()).toBe(0);
		expect(routes.planName).toBe('Nav examen 2');
		redoRoute();
		expect(routes.planName).toBe('Nav examen 2');
	});

	it('a load applies the file\'s name, and clear-all forgets it', () => {
		loadRoutes({ routes: [], planName: 'Sortie plage' }, () => null);
		expect(routes.planName).toBe('Sortie plage');
		// An unnamed file must clear it: the workspace is replaced whole.
		loadRoutes({ routes: [] }, () => null);
		expect(routes.planName).toBeNull();
		setPlanName('Sortie plage');
		clearAllRoutes();
		expect(routes.planName).toBeNull();
	});
});

describe('history cap', () => {
	it(`keeps at most UNDO_CAP (${UNDO_CAP}) steps`, () => {
		for (let i = 0; i < UNDO_CAP + 10; i++) {
			addWaypoint(48 + i * 0.001, 2);
		}
		let n = 0;
		while (undoRoute()) {
			n++;
		}
		expect(n).toBe(UNDO_CAP);
	});
});
