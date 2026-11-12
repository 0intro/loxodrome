/* A trip's fuel minutes and the ground time after it follow its route when an
 * action changes the trips (state/route.svelte.ts onTripsChange, the
 * realigning listener in state/flightPrep.svelte.ts): a reorder, a remove, the
 * alternate tick, Clear all, and their undo and redo. The file keeps them in
 * trip order. */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	applyLoadedFlightPrep,
	buildFlightPrepForSave,
	dossierStopMin,
	setDossierStop,
	setTripFuel,
	tripFuel,
} from '../src/lib/state/flightPrep.svelte';
import {
	addRoute,
	clearAllRoutes,
	moveRoute,
	redoRoute,
	removeRoute,
	routes,
	setRouteAlternate,
	undoRoute,
} from '../src/lib/state/route.svelte';

/** Three trips a, b, c, nothing typed; their route ids. */
function threeTrips(): { a: string; b: string; c: string } {
	clearAllRoutes();
	addRoute();
	addRoute();
	applyLoadedFlightPrep(undefined, []);
	const [a, b, c] = routes.list.map((r) => r.id);
	return { a, b, c };
}

const contingencies = (): (number | null)[] => [0, 1, 2].map((i) => tripFuel(i).contingencyMin);
const stops = (): (number | null)[] => [0, 1].map((i) => dossierStopMin(i));

describe('a trip keeps its minutes when the trips change', () => {
	let ids: { a: string; b: string; c: string };

	beforeEach(() => {
		ids = threeTrips();
		// 10 min of contingency on trip b, 45 min on the ground after trip a.
		setTripFuel(1, { contingencyMin: 10 });
		setDossierStop(0, 45);
	});

	it('a reorder carries them, and undo and redo follow', () => {
		moveRoute(ids.b, -1);
		expect(routes.list.map((r) => r.id)).toEqual([ids.b, ids.a, ids.c]);
		expect(contingencies()).toEqual([10, null, null]);
		expect(stops()).toEqual([null, 45]);
		undoRoute();
		expect(contingencies()).toEqual([null, 10, null]);
		expect(stops()).toEqual([45, null]);
		redoRoute();
		expect(contingencies()).toEqual([10, null, null]);
		expect(stops()).toEqual([null, 45]);
	});

	it('a removed trip takes its own away, and the undo brings them back', () => {
		removeRoute(ids.a);
		expect(contingencies()).toEqual([10, null, null]);
		expect(stops()).toEqual([null, null]);
		undoRoute();
		expect(contingencies()).toEqual([null, 10, null]);
		expect(stops()).toEqual([45, null]);
	});

	it('the alternate tick takes a trip out of the trips and back', () => {
		setRouteAlternate(ids.b, true);
		expect(contingencies()).toEqual([null, null, null]);
		expect(stops()).toEqual([45, null]);
		setRouteAlternate(ids.b, false);
		expect(contingencies()).toEqual([null, 10, null]);
		expect(stops()).toEqual([45, null]);
	});

	it('Clear all starts from nothing, and the undo restores the plan with them', () => {
		clearAllRoutes();
		expect(tripFuel(0).contingencyMin).toBe(null);
		expect(dossierStopMin(0)).toBe(null);
		undoRoute();
		expect(contingencies()).toEqual([null, 10, null]);
		expect(stops()).toEqual([45, null]);
	});

	it('the file states them in the moved order', () => {
		moveRoute(ids.b, -1);
		const doc = buildFlightPrepForSave(3, [], []);
		expect(doc?.fuelTrips?.map((t) => t.contingencyMin)).toEqual([10]);
		expect(doc?.dossier?.stopsMin).toEqual([null, 45]);
	});
});
