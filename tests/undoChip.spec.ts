/* The map's undo chip (state/undoChip.svelte.ts): an edit made on the map
 * offers itself back for a few seconds, and the chip undoes ITS edit or
 * nothing. Driven through the real route mutators and history. */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	activeRoute,
	addWaypoint,
	insertWaypointAfter,
	moveWaypoint,
	redoRoute,
	removeWaypoint,
	routeHistory,
	routes,
	setWaypointFreqs,
	undoRoute,
} from '$lib/state/route.svelte';
import {
	UNDO_CHIP_MS,
	dismissUndo,
	holdUndoChip,
	offerUndoFor,
	resetUndoChipForTest,
	takeUndo,
	undoChip,
	undoChipShown,
} from '$lib/state/undoChip.svelte';

function reset(): void {
	while (undoRoute()) {
		/* drain */
	}
	routes.list = [{ id: 'route-1', name: null, waypoints: [], selectedWaypointId: null }];
	routes.activeId = 'route-1';
	resetUndoChipForTest();
}

const count = (): number => activeRoute().waypoints.length;

beforeEach(() => {
	vi.useFakeTimers();
	reset();
});
afterEach(() => {
	resetUndoChipForTest();
	vi.useRealTimers();
});

describe('an edit made on the map', () => {
	it('raises the chip naming it, and hands the edit its result back', () => {
		const wp = offerUndoFor('added', () => addWaypoint(48, 2));
		expect(wp.id).toBe(activeRoute().waypoints[0].id);
		expect(undoChip.kind).toBe('added');
		expect(undoChipShown()).toBe(true);
	});

	it('goes after its countdown', () => {
		offerUndoFor('added', () => addWaypoint(48, 2));
		vi.advanceTimersByTime(UNDO_CHIP_MS - 1);
		expect(undoChipShown()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(undoChipShown()).toBe(false);
		expect(undoChip.kind).toBeNull();
	});

	it('restarts the countdown for the next edit', () => {
		const wp = offerUndoFor('added', () => addWaypoint(48, 2));
		vi.advanceTimersByTime(UNDO_CHIP_MS - 1000);
		offerUndoFor('moved', () => moveWaypoint(wp.id, 49, 3));
		vi.advanceTimersByTime(UNDO_CHIP_MS - 1);
		expect(undoChip.kind).toBe('moved');
		expect(undoChipShown()).toBe(true);
	});

	it('raises nothing when the edit recorded no step, and leaves a standing chip alone', () => {
		offerUndoFor('removed', () => removeWaypoint('wp-none'));
		expect(undoChipShown()).toBe(false);
		offerUndoFor('added', () => addWaypoint(48, 2));
		offerUndoFor('moved', () => moveWaypoint('wp-none', 49, 3));
		expect(undoChip.kind).toBe('added');
		expect(undoChipShown()).toBe(true);
		vi.advanceTimersByTime(UNDO_CHIP_MS);
		expect(undoChipShown()).toBe(false);
	});
});

describe('the chip stands only while its edit is the history\'s top', () => {
	it('goes at a later edit made anywhere', () => {
		const wp = offerUndoFor('added', () => addWaypoint(48, 2));
		setWaypointFreqs(wp.id, '123.500');
		expect(undoChipShown()).toBe(false);
	});

	it('goes at an undo or a redo made elsewhere', () => {
		offerUndoFor('added', () => addWaypoint(48, 2));
		undoRoute();
		expect(undoChipShown()).toBe(false);
		redoRoute();
		expect(undoChipShown()).toBe(false);
	});

	it('undoes its edit, and goes', () => {
		addWaypoint(48, 2);
		const wp = offerUndoFor('inserted', () => insertWaypointAfter(0, { lat: 48.5, lon: 2.5, kind: 'free' }));
		expect(count()).toBe(2);
		takeUndo();
		expect(count()).toBe(1);
		expect(activeRoute().waypoints.some((w) => w.id === wp.id)).toBe(false);
		expect(undoChipShown()).toBe(false);
		expect(routeHistory.canRedo).toBe(true);
	});

	it('undoes nothing once another edit has come after it', () => {
		const wp = offerUndoFor('added', () => addWaypoint(48, 2));
		moveWaypoint(wp.id, 49, 3);
		takeUndo();
		expect(activeRoute().waypoints[0].lat).toBe(49);
		expect(count()).toBe(1);
	});

	it('undoes nothing once dismissed', () => {
		offerUndoFor('added', () => addWaypoint(48, 2));
		dismissUndo();
		takeUndo();
		expect(count()).toBe(1);
	});
});

describe('a hold on the chip', () => {
	it('stops the countdown, and the release starts it again whole', () => {
		offerUndoFor('added', () => addWaypoint(48, 2));
		vi.advanceTimersByTime(UNDO_CHIP_MS - 100);
		holdUndoChip(true);
		vi.advanceTimersByTime(UNDO_CHIP_MS * 3);
		expect(undoChipShown()).toBe(true);
		holdUndoChip(false);
		vi.advanceTimersByTime(UNDO_CHIP_MS - 1);
		expect(undoChipShown()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(undoChipShown()).toBe(false);
	});

	it('is forgotten by a fresh offer, whose chip the DOM may never have hovered', () => {
		const wp = offerUndoFor('added', () => addWaypoint(48, 2));
		holdUndoChip(true);
		offerUndoFor('moved', () => moveWaypoint(wp.id, 49, 3));
		vi.advanceTimersByTime(UNDO_CHIP_MS);
		expect(undoChipShown()).toBe(false);
	});

	it('is forgotten by the offer after a dismiss made under it', () => {
		offerUndoFor('added', () => addWaypoint(48, 2));
		holdUndoChip(true);
		dismissUndo();
		offerUndoFor('added', () => addWaypoint(49, 3));
		vi.advanceTimersByTime(UNDO_CHIP_MS);
		expect(undoChipShown()).toBe(false);
	});
});

describe('the edits made on the map raise it', () => {
	const menu = readFileSync('src/lib/components/ContextMenu.svelte', 'utf8');
	const mapView = readFileSync('src/lib/components/MapView.svelte', 'utf8');
	const routeLayer = readFileSync('src/lib/map/routeLayer.ts', 'utf8');

	/** The body of a component function, up to the next one. */
	function fn(src: string, name: string): string {
		const at = src.indexOf(`function ${name}(`);
		expect(at, name).toBeGreaterThan(0);
		const next = src.indexOf('\n\tfunction ', at + 1);
		return src.slice(at, next > 0 ? next : undefined);
	}

	it('the menu\'s add, insert and remove rows', () => {
		expect(fn(menu, 'onAddWaypoint')).toContain("offerUndoFor('added',");
		expect(fn(menu, 'onInsertWaypoint')).toContain("offerUndoFor('inserted',");
		expect(fn(menu, 'onRemoveWaypoint')).toContain("offerUndoFor('removed', () => removeWaypoint(id))");
	});

	it('the Delete key', () => {
		expect(fn(mapView, 'onKeydown')).toContain("offerUndoFor('removed', () => removeWaypoint(selectedId))");
	});

	it('a pin dropped (the drop itself is driven in routeDragSnap.spec.ts)', () => {
		expect(routeLayer).toContain("offerUndoFor('moved', () => {");
	});

	it('and the map draws it', () => {
		expect(mapView).toContain('<UndoChip />');
	});
});
