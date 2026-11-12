/* What the aircraft editor shows, and who may change it
 * (state/aircraftEditor.svelte.ts). The editor follows the plane picked in
 * the Aircraft tab, and every change of subject goes through the modal's
 * leave guard, which holds it behind the discard confirm while the draft has
 * unsaved edits. Before the guard existed, asking for another plane or another
 * page reseeded the draft silently. A page-only request turns the page and
 * never reseeds; a click on the selected row changes nothing, so it never
 * abandons a new sheet; a generic library sheet is shown, never edited; and
 * a refused open leaves no trace of the request. The fake guards stand for
 * the modal: one proceeds (a clean draft), one holds the continuation (a
 * dirty one, the confirm up). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseAircraftYaml } from '$lib/aircraft/schema';
import { SURFACE_IDS } from '$lib/surfaces';
import {
	closeSurface,
	isOpen,
	openSurface,
	placementOf,
	registerSurfaceClose,
	setPlacement,
	setStageSize,
} from '$lib/state/workspace.svelte';
import { aircraftState, saveEditedAircraft } from '$lib/state/aircraft.svelte';
import { t } from '$lib/state/i18n.svelte';
import {
	aircraftEditor,
	editorSaved,
	editorShows,
	openAircraftCreate,
	openAircraftDuplicate,
	openAircraftEditor,
	pickAircraft,
	registerEditorLeaveGuard,
} from '$lib/state/aircraftEditor.svelte';

const A = parseAircraftYaml('version: 1\naircraft: { registration: F-AAAA, type: DR400/120 }\n');
const B = parseAircraftYaml('version: 1\naircraft: { registration: F-BBBB, type: DR400/120 }\n');
const G = parseAircraftYaml(
	"version: 1\naircraft: { type: C172S, name: 'Cessna 172S, s/n 172S8001 and on', generic: c172s }\n",
);

const releases: (() => void)[] = [];

/** A guard standing for the modal: 'clean' runs the change at once, 'dirty'
 *  holds it (the confirm up) until the test calls it. Returns the
 *  continuations it was handed. */
function guard(draft: 'clean' | 'dirty'): (() => void)[] {
	const handed: (() => void)[] = [];
	releases.push(
		registerEditorLeaveGuard((proceed) => {
			handed.push(proceed);
			if (draft === 'clean') {
				proceed();
			}
		}),
	);
	return handed;
}

function target(): [string, string | null, string] {
	return [aircraftEditor.mode, aircraftEditor.key, aircraftEditor.page];
}

beforeEach(() => {
	aircraftState.library = [A, B, G];
	aircraftState.libraryLoaded = true;
	aircraftState.user = {};
	aircraftState.selectedKey = null;
	setStageSize(1600, 900);
});

afterEach(() => {
	while (releases.length > 0) {
		releases.pop()!();
	}
	for (const id of SURFACE_IDS) {
		closeSurface(id);
	}
	aircraftEditor.page = 'general';
	try {
		localStorage.clear();
	} catch {
		/* no storage under the node environment; readItem degrades to null */
	}
});

describe('the editor follows the plane picked in the Aircraft tab', () => {
	it('a pick with the editor closed only selects', () => {
		const handed = guard('dirty');
		const seq = aircraftEditor.requestSeq;
		pickAircraft('F-AAAA');
		expect(aircraftState.selectedKey).toBe('F-AAAA');
		expect(handed).toHaveLength(0);
		expect(aircraftEditor.requestSeq).toBe(seq);
		expect(isOpen('aircraftEditor')).toBe(false);
	});

	it('a pick moves the open editor to that plane, on the page it shows', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftEditor('F-AAAA', 'mb');
		const handed = guard('clean');
		const seq = aircraftEditor.requestSeq;
		pickAircraft('F-BBBB');
		expect(handed).toHaveLength(1);
		expect(aircraftState.selectedKey).toBe('F-BBBB');
		expect(target()).toEqual(['edit', 'F-BBBB', 'mb']);
		expect(aircraftEditor.requestSeq).toBe(seq + 1);
	});

	it('over unsaved edits nothing moves until the discard is confirmed, and both move then', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftEditor('F-AAAA', 'general');
		const handed = guard('dirty');
		pickAircraft('F-BBBB');
		expect(handed).toHaveLength(1);
		expect(aircraftState.selectedKey).toBe('F-AAAA');
		expect(target()).toEqual(['edit', 'F-AAAA', 'general']);
		handed[0]();
		expect(aircraftState.selectedKey).toBe('F-BBBB');
		expect(target()).toEqual(['edit', 'F-BBBB', 'general']);
	});

	it('a click on the selected row changes nothing, never abandoning a new sheet', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftCreate();
		const handed = guard('dirty');
		const seq = aircraftEditor.requestSeq;
		pickAircraft('F-AAAA');
		expect(handed).toHaveLength(0);
		expect(target()).toEqual(['create', null, 'general']);
		expect(aircraftEditor.requestSeq).toBe(seq);
	});

	it('a click on the selected row brings an editor showing another plane to it', () => {
		// An import selects the plane it brings in and leaves the editor on its
		// sheet: the list then highlights one plane, the editor shows another.
		openAircraftEditor('F-AAAA', 'mb');
		aircraftState.selectedKey = 'F-BBBB';
		const handed = guard('clean');
		pickAircraft('F-BBBB');
		expect(handed).toHaveLength(1);
		expect(target()).toEqual(['edit', 'F-BBBB', 'mb']);
		expect(aircraftState.selectedKey).toBe('F-BBBB');
	});

	it('a pick from a new sheet edits the plane picked', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftCreate();
		guard('clean');
		pickAircraft('F-BBBB');
		expect(target()).toEqual(['edit', 'F-BBBB', 'general']);
	});

	it('runs at once while no guard is registered (the modal still loading)', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftEditor('F-AAAA');
		pickAircraft('F-BBBB');
		expect(target()[1]).toBe('F-BBBB');
	});

	it('shows a generic library sheet read-only, never in edit mode', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftEditor('F-AAAA');
		guard('clean');
		pickAircraft('generic:c172s');
		expect(target().slice(0, 2)).toEqual(['view', 'generic:c172s']);
		expect(editorShows('generic:c172s')).toBe(true);
	});

	it('keeps the placement the pilot chose while it changes plane', () => {
		aircraftState.selectedKey = 'F-AAAA';
		openAircraftEditor('F-AAAA');
		expect(setPlacement('aircraftEditor', 'full')).toBe(true);
		guard('clean');
		pickAircraft('F-BBBB');
		expect(placementOf('aircraftEditor')).toBe('full');
	});
});

describe('every request goes through the guard, a page turn never reseeds', () => {
	it('a page-only request turns the page without the guard or a reseed', () => {
		openAircraftEditor('F-AAAA', 'general');
		const handed = guard('dirty');
		const seq = aircraftEditor.requestSeq;
		openAircraftEditor('F-AAAA', 'perf');
		expect(handed).toHaveLength(0);
		expect(target()).toEqual(['edit', 'F-AAAA', 'perf']);
		expect(aircraftEditor.requestSeq).toBe(seq);
	});

	it('New and Duplicate over unsaved edits ask first', () => {
		openAircraftEditor('F-AAAA', 'mb');
		const handed = guard('dirty');
		openAircraftDuplicate('F-AAAA');
		expect(target()).toEqual(['edit', 'F-AAAA', 'mb']);
		handed[0]();
		expect(target()).toEqual(['create', 'F-AAAA', 'general']);
		openAircraftCreate();
		expect(handed).toHaveLength(2);
		handed[1]();
		expect(target()).toEqual(['create', null, 'general']);
	});

	it('is never consulted while the editor is closed', () => {
		const handed = guard('dirty');
		openAircraftEditor('F-BBBB');
		expect(handed).toHaveLength(0);
		expect(isOpen('aircraftEditor')).toBe(true);
	});

	it('only the newest guard answers, whichever unregisters first', () => {
		const older: (() => void)[] = [];
		const newer: (() => void)[] = [];
		const releaseOlder = registerEditorLeaveGuard((p) => older.push(p));
		releases.push(registerEditorLeaveGuard((p) => newer.push(p)));
		releaseOlder();
		openAircraftEditor('F-AAAA');
		pickAircraft('F-BBBB');
		expect(older).toHaveLength(0);
		expect(newer).toHaveLength(1);
	});
});

describe('the entry point is a toggle, and a refused open leaves no trace', () => {
	it('asking for the plane shown, on any page, closes through the surface’s own close', () => {
		openAircraftEditor('F-AAAA', 'mb');
		let asked = 0;
		releases.push(
			registerSurfaceClose('aircraftEditor', () => {
				asked++;
				closeSurface('aircraftEditor');
			}),
		);
		expect(editorShows('F-AAAA')).toBe(true);
		openAircraftEditor('F-AAAA');
		expect(asked).toBe(1);
		expect(isOpen('aircraftEditor')).toBe(false);
	});

	it('a close the editor refuses (unsaved edits kept) leaves it up', () => {
		openAircraftEditor('F-AAAA');
		releases.push(registerSurfaceClose('aircraftEditor', () => {}));
		openAircraftEditor('F-AAAA');
		expect(isOpen('aircraftEditor')).toBe(true);
	});

	it('a duplicate in progress is not the plane shown', () => {
		openAircraftDuplicate('F-AAAA');
		expect(editorShows('F-AAAA')).toBe(false);
	});

	it('an open the overlay’s holder refuses restores the target', () => {
		openAircraftEditor('F-AAAA', 'mb');
		closeSurface('aircraftEditor');
		const before = target();
		// The flights library holds the overlay as a page and declines to go
		// (a closer that does nothing: the unsaved-edits confirm's shape).
		openSurface('flights');
		releases.push(registerSurfaceClose('flights', () => {}));
		openAircraftEditor('F-BBBB', 'perf');
		expect(isOpen('aircraftEditor')).toBe(false);
		expect(target()).toEqual(before);
	});
});

describe('a save lands in place', () => {
	it('editorSaved edits the saved key without reseeding', () => {
		openAircraftCreate();
		const seq = aircraftEditor.requestSeq;
		editorSaved('F-CCCC');
		expect(target().slice(0, 2)).toEqual(['edit', 'F-CCCC']);
		expect(aircraftEditor.requestSeq).toBe(seq);
	});

	it('saveEditedAircraft refuses a generic sheet, while a copy of one saves as the pilot’s plane', () => {
		// Its own refusal: dropping the flag would otherwise re-key it into the
		// library-key error, a message about another rule.
		const refusal = saveEditedAircraft('generic:c172s', G);
		expect(refusal?.()).toBe(t.aircraft.errGenericSheet);
		expect(aircraftState.user).toEqual({});
		expect(saveEditedAircraft(null, G)).toBeNull();
		expect(aircraftState.user['C172S'].identity.generic).toBeUndefined();
	});
});
